// WASAPI endpoint enumeration + selection helpers.
//
// Phase 1 kept this strictly diagnostic (print and exit). Phase 2/3 need to
// *open* endpoints by friendly-name substring, so this module now also exposes
// `select_endpoint_by_name` which returns the raw IMMDevice for downstream
// IAudioClient activation. The narrow `unsafe` blocks still carry WHY comments
// — windows-rs auto-binds the raw Win32 ABI, there are no safe wrappers.

use std::slice;

use windows::core::{Result, PCWSTR, PWSTR};
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eRender, EDataFlow, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, IMMEndpoint, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::Audio::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, STGM_READ};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

/// Direction of audio flow for an endpoint.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Flow {
    Render,
    Capture,
}

impl Flow {
    pub fn label(self) -> &'static str {
        match self {
            Flow::Render => "Render ",
            Flow::Capture => "Capture",
        }
    }

    fn data_flow(self) -> EDataFlow {
        match self {
            Flow::Render => eRender,
            Flow::Capture => eCapture,
        }
    }
}

/// A single enumerated endpoint, ready to print or select.
pub struct Endpoint {
    pub flow: Flow,
    pub state: DEVICE_STATE,
    pub friendly_name: String,
    pub id: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub is_float: bool,
    pub is_hfp_guess: bool,
}

pub fn create_enumerator() -> Result<IMMDeviceEnumerator> {
    // CoCreateInstance is the canonical way to obtain the MMDevice enumerator singleton.
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

/// Phase 1 entry point: enumerate active endpoints and pretty-print them.
pub fn enumerate_and_print() -> Result<()> {
    let enumerator = create_enumerator()?;
    let endpoints = collect_active(&enumerator)?;
    print_report(&endpoints);
    Ok(())
}

pub fn collect_active(enumerator: &IMMDeviceEnumerator) -> Result<Vec<Endpoint>> {
    let mut endpoints: Vec<Endpoint> = Vec::new();
    for flow in [Flow::Render, Flow::Capture] {
        // EnumAudioEndpoints filters to ACTIVE only — disconnected BT headsets
        // show up as NOT_PRESENT and would clutter selection.
        let collection = unsafe {
            enumerator.EnumAudioEndpoints(flow.data_flow(), DEVICE_STATE_ACTIVE.0)?
        };
        let count = unsafe { collection.GetCount()? };
        for i in 0..count {
            let device: IMMDevice = unsafe { collection.Item(i)? };
            match describe_endpoint(&device, flow) {
                Ok(ep) => endpoints.push(ep),
                Err(err) => {
                    eprintln!(
                        "bt-audio-bridge: skipping endpoint #{i} ({}): {err}",
                        flow.label().trim()
                    );
                }
            }
        }
    }
    // HFP-looking devices float to the top for easier diagnostic reading.
    endpoints.sort_by_key(|e| (!e.is_hfp_guess, e.flow != Flow::Capture));
    Ok(endpoints)
}

/// Selection result: the IMMDevice plus the metadata we printed in Phase 1.
pub struct SelectedEndpoint {
    pub device: IMMDevice,
    pub info: Endpoint,
}

/// Pick a single endpoint matching `substring` (case-insensitive) with the
/// requested flow. Errors with a helpful listing when 0 or >1 match.
///
/// If the substring-matched device also happens to be the current
/// `eCommunications` default endpoint, we return that one — this matches the
/// role the WASAPI engine uses for HFP voice streams.
pub fn select_endpoint_by_name(
    enumerator: &IMMDeviceEnumerator,
    flow: Flow,
    substring: &str,
) -> anyhow::Result<SelectedEndpoint> {
    let lower_sub = substring.to_lowercase();
    let collection = unsafe {
        enumerator.EnumAudioEndpoints(flow.data_flow(), DEVICE_STATE_ACTIVE.0)?
    };
    let count = unsafe { collection.GetCount()? };

    let comms_default_id: Option<String> = unsafe {
        match enumerator.GetDefaultAudioEndpoint(flow.data_flow(), eCommunications) {
            Ok(dev) => match dev.GetId() {
                Ok(pwstr) => {
                    let s = pwstr_to_string(pwstr);
                    windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0 as *const _));
                    Some(s)
                }
                Err(_) => None,
            },
            Err(_) => None,
        }
    };

    let mut matches: Vec<SelectedEndpoint> = Vec::new();
    for i in 0..count {
        let device: IMMDevice = unsafe { collection.Item(i)? };
        let info = match describe_endpoint(&device, flow) {
            Ok(ep) => ep,
            Err(_) => continue,
        };
        if info.friendly_name.to_lowercase().contains(&lower_sub) {
            matches.push(SelectedEndpoint { device, info });
        }
    }

    if matches.is_empty() {
        let available: Vec<String> = {
            let all = collect_active(enumerator).unwrap_or_default();
            all.into_iter()
                .filter(|e| e.flow == flow)
                .map(|e| format!("  - {}", e.friendly_name))
                .collect()
        };
        anyhow::bail!(
            "No {} endpoint matched '{}'. Available:\n{}",
            flow.label().trim(),
            substring,
            available.join("\n")
        );
    }

    if matches.len() > 1 {
        // Prefer the Communications-role default if it's one of the matches:
        // this is exactly the endpoint Windows routes HFP voice through.
        if let Some(ref default_id) = comms_default_id {
            if let Some(pos) = matches.iter().position(|m| &m.info.id == default_id) {
                return Ok(matches.remove(pos));
            }
        }
        let listing: Vec<String> =
            matches.iter().map(|m| format!("  - {}", m.info.friendly_name)).collect();
        anyhow::bail!(
            "Multiple {} endpoints matched '{}'; narrow the filter:\n{}",
            flow.label().trim(),
            substring,
            listing.join("\n")
        );
    }

    Ok(matches.pop().unwrap())
}

pub fn describe_endpoint(device: &IMMDevice, flow_hint: Flow) -> Result<Endpoint> {
    // GetId returns a heap LPWSTR owned by the caller; copy then free with CoTaskMemFree.
    let id = unsafe {
        let pwstr: PWSTR = device.GetId()?;
        let copied = pwstr_to_string(pwstr);
        windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0 as *const _));
        copied
    };

    let state: DEVICE_STATE = unsafe { device.GetState()? };

    let endpoint_iface: IMMEndpoint = device.cast()?;
    let data_flow = unsafe { endpoint_iface.GetDataFlow()? };
    let flow = if data_flow == eCapture {
        Flow::Capture
    } else if data_flow == eRender {
        Flow::Render
    } else {
        flow_hint
    };

    let friendly_name =
        read_friendly_name(device).unwrap_or_else(|_| "<unknown>".to_string());

    let (sample_rate, channels, bits_per_sample, is_float) = match read_mix_format(device) {
        Ok(tuple) => tuple,
        Err(_) => (0, 0, 0, false),
    };

    let is_hfp_guess = looks_like_hfp(&friendly_name);

    Ok(Endpoint {
        flow,
        state,
        friendly_name,
        id,
        sample_rate,
        channels,
        bits_per_sample,
        is_float,
        is_hfp_guess,
    })
}

fn read_friendly_name(device: &IMMDevice) -> Result<String> {
    let store = unsafe { device.OpenPropertyStore(STGM_READ)? };
    let key: PROPERTYKEY = PKEY_Device_FriendlyName;
    let mut variant = unsafe { store.GetValue(&key)? };

    // windows-rs 0.58: PROPVARIANT's active field is three unions deep.
    let name = unsafe {
        let inner = &variant.Anonymous.Anonymous;
        let pwstr: PWSTR = inner.Anonymous.pwszVal;
        pwstr_to_string(pwstr)
    };

    unsafe {
        let _ = PropVariantClear(&mut variant as *mut _);
    }

    Ok(name)
}

fn read_mix_format(device: &IMMDevice) -> Result<(u32, u16, u16, bool)> {
    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };
    let fmt_ptr = unsafe { client.GetMixFormat()? };
    if fmt_ptr.is_null() {
        return Ok((0, 0, 0, false));
    }

    let result = unsafe {
        let wf: &WAVEFORMATEX = &*fmt_ptr;
        let sample_rate = wf.nSamplesPerSec;
        let channels = wf.nChannels;
        let bits = wf.wBitsPerSample;
        let is_float = if wf.wFormatTag as u32 == WAVE_FORMAT_EXTENSIBLE {
            let wfx: &WAVEFORMATEXTENSIBLE = &*(fmt_ptr as *const WAVEFORMATEXTENSIBLE);
            wfx.SubFormat == windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        } else {
            wf.wFormatTag as u32 == WAVE_FORMAT_IEEE_FLOAT
        };
        (sample_rate, channels, bits, is_float)
    };

    unsafe {
        windows::Win32::System::Com::CoTaskMemFree(Some(fmt_ptr as *const _));
    }

    Ok(result)
}

/// Heuristic: does this endpoint look like a Bluetooth HFP / Hands-Free endpoint?
pub fn looks_like_hfp(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("hands-free")
        || lower.contains("hands free")
        || lower.contains(" hf ")
        || lower.ends_with(" hf")
        || lower.contains("hf audio")
        || lower.contains("headset")
}

pub fn pwstr_to_string(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let pc = PCWSTR(p.0);
    unsafe {
        let mut len = 0usize;
        while *pc.0.add(len) != 0 {
            len += 1;
        }
        let slice = slice::from_raw_parts(pc.0, len);
        String::from_utf16_lossy(slice)
    }
}

fn state_label(s: DEVICE_STATE) -> &'static str {
    match s.0 {
        0x1 => "ACTIVE",
        0x2 => "DISABLED",
        0x4 => "NOTPRESENT",
        0x8 => "UNPLUGGED",
        _ => "UNKNOWN",
    }
}

fn print_report(endpoints: &[Endpoint]) {
    println!("=== Active audio endpoints ===\n");
    if endpoints.is_empty() {
        println!("(no active endpoints found)");
        return;
    }
    for ep in endpoints {
        let tag = if ep.is_hfp_guess { "[HFP?] " } else { "       " };
        println!("{tag}{}  {}", ep.flow.label(), ep.friendly_name);
        println!("       State:   {}", state_label(ep.state));
        let fmt_kind = if ep.is_float { "float" } else { "PCM" };
        if ep.sample_rate == 0 {
            println!("       Format:  (unavailable)");
        } else {
            println!(
                "       Format:  {} Hz, {} ch, {}-bit {}",
                ep.sample_rate, ep.channels, ep.bits_per_sample, fmt_kind
            );
        }
        println!("       ID:      {}", ep.id);
        println!();
    }
}
