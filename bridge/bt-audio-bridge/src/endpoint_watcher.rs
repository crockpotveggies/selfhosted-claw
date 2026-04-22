// Event-driven endpoint watcher.
//
// Bluetooth HFP endpoints on Windows don't exist as ACTIVE WASAPI endpoints
// until an SCO link is up (i.e. until the phone is in a call). Before that,
// the endpoint is typically in DEVICE_STATE_NOTPRESENT, which EnumAudioEndpoints
// filters out for any "openable" state mask. After SCO drops at call end,
// the endpoint transitions back out of ACTIVE and any IAudioClient we held
// for it becomes invalidated.
//
// This module wraps IMMDeviceEnumerator's endpoint-notification callback so
// capture and render threads can block-wait for a matching endpoint to enter
// ACTIVE, stream while it stays ACTIVE, and rewait when it goes away — all
// without polling MMDevice on a tight loop.
//
// The callback (running on a COM pool thread) does nothing except pulse a
// condvar; the waiter does all the re-enumeration. This keeps the callback
// implementation trivial and avoids re-entering COM from inside a COM
// notification (a pattern MS docs explicitly warn against).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tracing::{debug, info};
use windows::core::{implement, Interface, PCWSTR};
use windows::Win32::Media::Audio::{
    eCapture, eRender, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator, IMMNotificationClient,
    IMMNotificationClient_Impl, DEVICE_STATE, DEVICE_STATE_ACTIVE, DEVICE_STATE_DISABLED,
    DEVICE_STATE_NOTPRESENT, DEVICE_STATE_UNPLUGGED,
};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

use crate::endpoints::{self, Flow};

/// Condvar wake signal used by the COM callback to notify the waiter of a
/// state-change event. We don't carry any payload — the waiter re-enumerates
/// the endpoint collection on every wake to find the current matching device.
struct Signal {
    lock: Mutex<u64>, // generation counter; callbacks bump it
    cv: Condvar,
}

impl Signal {
    fn new() -> Self {
        Self {
            lock: Mutex::new(0),
            cv: Condvar::new(),
        }
    }
    fn poke(&self) {
        if let Ok(mut g) = self.lock.lock() {
            *g = g.wrapping_add(1);
            self.cv.notify_all();
        }
    }
}

/// MMDevice endpoint-notification callback. Any device-level event pokes the
/// signal; OnPropertyValueChanged is noisy (every format renegotiate) so we
/// ignore it.
#[implement(IMMNotificationClient)]
struct Callback {
    signal: Arc<Signal>,
}

#[allow(non_snake_case)]
impl IMMNotificationClient_Impl for Callback_Impl {
    fn OnDeviceStateChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        _dwnewstate: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        self.signal.poke();
        Ok(())
    }
    fn OnDeviceAdded(&self, _pwstrdeviceid: &PCWSTR) -> windows::core::Result<()> {
        self.signal.poke();
        Ok(())
    }
    fn OnDeviceRemoved(&self, _pwstrdeviceid: &PCWSTR) -> windows::core::Result<()> {
        self.signal.poke();
        Ok(())
    }
    fn OnDefaultDeviceChanged(
        &self,
        _flow: EDataFlow,
        _role: ERole,
        _pwstrdefaultdeviceid: &PCWSTR,
    ) -> windows::core::Result<()> {
        self.signal.poke();
        Ok(())
    }
    fn OnPropertyValueChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        // Intentionally silent — fires on every volume tweak, format change, etc.
        Ok(())
    }
}

/// Registered endpoint watcher. Holds the enumerator and callback registration
/// for its lifetime; Drop unregisters cleanly.
pub struct EndpointWatcher {
    enumerator: IMMDeviceEnumerator,
    client: IMMNotificationClient,
    signal: Arc<Signal>,
    flow: Flow,
    substring_lc: String,
}

impl EndpointWatcher {
    /// Register an endpoint-notification callback and return the watcher.
    /// Must be called from an MTA-initialised thread so callbacks don't
    /// deadlock on the single-threaded STA pump.
    pub fn new(flow: Flow, substring: impl Into<String>) -> Result<Self> {
        let enumerator: IMMDeviceEnumerator =
            endpoints::create_enumerator().context("create IMMDeviceEnumerator")?;
        let signal = Arc::new(Signal::new());
        let cb = Callback {
            signal: signal.clone(),
        };
        // #[implement] provides this From impl — the concrete Callback_Impl is
        // wrapped and cast to the public interface type.
        let client: IMMNotificationClient = cb.into();
        unsafe {
            enumerator
                .RegisterEndpointNotificationCallback(&client)
                .context("RegisterEndpointNotificationCallback")?;
        }
        Ok(Self {
            enumerator,
            client,
            signal,
            flow,
            substring_lc: substring.into().to_lowercase(),
        })
    }

    /// Find an endpoint matching our substring + flow across all device states.
    /// Returns (device, is_active) when one is found. Callers should only open
    /// the device via IAudioClient.Activate when `is_active` is true.
    fn find_match(&self) -> Option<(IMMDevice, DEVICE_STATE, String)> {
        let all_states = DEVICE_STATE(
            DEVICE_STATE_ACTIVE.0
                | DEVICE_STATE_DISABLED.0
                | DEVICE_STATE_NOTPRESENT.0
                | DEVICE_STATE_UNPLUGGED.0,
        );
        let data_flow: EDataFlow = match self.flow {
            Flow::Capture => eCapture,
            Flow::Render => eRender,
        };
        let coll =
            unsafe { self.enumerator.EnumAudioEndpoints(data_flow, all_states).ok()? };
        let count = unsafe { coll.GetCount().ok()? };
        for i in 0..count {
            let dev: IMMDevice = unsafe { coll.Item(i).ok()? };
            let info = match endpoints::describe_endpoint(&dev, self.flow) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if info.friendly_name.to_lowercase().contains(&self.substring_lc) {
                return Some((dev, info.state, info.friendly_name));
            }
        }
        None
    }

    /// Block until an endpoint matching our substring+flow is in ACTIVE state,
    /// then return it. Returns None if the `stop` flag is set while waiting.
    ///
    /// We wake on every callback-driven event (device add/remove/state-change
    /// anywhere in the system) AND every `poll_interval` as a safety net.
    /// Safety-net polling covers the case where the match transitions ACTIVE
    /// via some path that doesn't fire a state-change for *our* device — in
    /// practice this hasn't been observed, but BT stack drivers are varied
    /// and cheap polling keeps this bulletproof.
    pub fn wait_for_active(
        &self,
        stop: &AtomicBool,
        poll_interval: Duration,
    ) -> Option<IMMDevice> {
        let mut last_status: Option<(Option<String>, DEVICE_STATE)> = None;
        let mut last_log: Option<Instant> = None;
        loop {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            let snapshot = self.find_match();
            let current_status = match &snapshot {
                Some((_, state, name)) => (Some(name.clone()), *state),
                None => (None, DEVICE_STATE(0)),
            };

            let status_changed = last_status.as_ref() != Some(&current_status);
            let time_due = last_log
                .map(|t| t.elapsed() > Duration::from_secs(10))
                .unwrap_or(true);
            match &snapshot {
                Some((_, state, name)) if *state == DEVICE_STATE_ACTIVE => {
                    info!(friendly_name = %name, "endpoint ACTIVE — attaching");
                    return Some(snapshot.unwrap().0);
                }
                Some((_, state, name)) => {
                    if status_changed || time_due {
                        info!(
                            friendly_name = %name,
                            state = state_label(*state),
                            substring = %self.substring_lc,
                            flow = ?self.flow,
                            "endpoint matched but not ACTIVE yet; waiting for HFP SCO"
                        );
                        last_log = Some(Instant::now());
                    }
                }
                None => {
                    if status_changed || time_due {
                        info!(
                            substring = %self.substring_lc,
                            flow = ?self.flow,
                            "no matching endpoint yet; waiting for phone to advertise HFP audio"
                        );
                        last_log = Some(Instant::now());
                    }
                }
            }
            last_status = Some(current_status);
            debug!(snapshot_name = ?snapshot.as_ref().map(|s| &s.2), "watcher tick");

            // Wait on the signal condvar up to poll_interval. Any COM callback
            // wakes us early; otherwise we re-check on the poll cadence.
            let guard = match self.signal.lock.lock() {
                Ok(g) => g,
                Err(_) => return None,
            };
            let _ = self.signal.cv.wait_timeout(guard, poll_interval);
        }
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

impl Drop for EndpointWatcher {
    fn drop(&mut self) {
        // Unregister before the callback memory is released. Ignore failure —
        // the enumerator itself is about to drop anyway.
        unsafe {
            let _ = self
                .enumerator
                .UnregisterEndpointNotificationCallback(&self.client);
        }
    }
}
