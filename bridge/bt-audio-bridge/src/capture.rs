// WASAPI capture loop. Runs on a dedicated OS thread (CoInitialize must be
// called there) and pushes 20 ms frames of 16 kHz / 16-bit / mono PCM onto an
// mpsc::Sender<Bytes>. Uses AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM +
// AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY so Windows resamples the native HFP
// format to the target regardless of the device's reported mix format.

use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use anyhow::{Context, Result};
use bytes::Bytes;
use tokio::sync::mpsc;
use tracing::{info, warn};
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Media::Audio::{
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, WAVEFORMATEX,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVE_FORMAT_PCM,
};

// AUDCLNT_BUFFERFLAGS_SILENT = 0x1. We compare raw bits to avoid the
// newtype-vs-u32 conversion dance in windows-rs 0.58.
const AUDCLNT_BUFFERFLAGS_SILENT_BIT: u32 = 0x1;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::endpoints::{self, Flow};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;
pub const TARGET_CHANNELS: u16 = 1;
pub const TARGET_BITS: u16 = 16;
// 20 ms frame at 16 kHz / 16-bit mono = 320 samples * 2 bytes = 640 bytes.
pub const FRAME_SAMPLES: usize = 320;
pub const FRAME_BYTES: usize = FRAME_SAMPLES * (TARGET_BITS as usize / 8);

pub struct CaptureHandle {
    pub stop: Arc<AtomicBool>,
    pub thread: Option<thread::JoinHandle<()>>,
}

impl CaptureHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub fn spawn_capture(
    substring: String,
    tx: mpsc::Sender<Bytes>,
) -> Result<CaptureHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    let handle = thread::Builder::new()
        .name("wasapi-capture".into())
        .spawn(move || {
            // Capture thread has its own COM apartment (MTA matches WASAPI best
            // practice for streaming threads; WASAPI does not require STA).
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            if let Err(err) = run_capture(&substring, tx, stop_thread) {
                warn!(error = %err, "capture loop exited with error");
            }
            unsafe {
                CoUninitialize();
            }
        })
        .context("spawn capture thread")?;

    Ok(CaptureHandle { stop, thread: Some(handle) })
}

fn run_capture(
    substring: &str,
    tx: mpsc::Sender<Bytes>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let enumerator: IMMDeviceEnumerator = endpoints::create_enumerator()
        .context("create IMMDeviceEnumerator")?;
    let selected = endpoints::select_endpoint_by_name(&enumerator, Flow::Capture, substring)?;
    info!(
        friendly_name = %selected.info.friendly_name,
        id = %selected.info.id,
        "capture endpoint selected"
    );
    // Communications-role preference is handled inside select_endpoint_by_name.

    let device = selected.device;
    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };

    // Request 16 kHz / 16-bit / mono. Shared mode + AUTOCONVERTPCM lets the
    // WASAPI engine resample whatever the HFP endpoint natively provides.
    let mut wf = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: TARGET_CHANNELS,
        nSamplesPerSec: TARGET_SAMPLE_RATE,
        nAvgBytesPerSec: TARGET_SAMPLE_RATE * (TARGET_CHANNELS as u32) * (TARGET_BITS as u32 / 8),
        nBlockAlign: TARGET_CHANNELS * (TARGET_BITS / 8),
        wBitsPerSample: TARGET_BITS,
        cbSize: 0,
    };

    // 200 ms engine buffer — generous; WASAPI picks a multiple internally.
    let hns_buffer_duration: i64 = 200 * 10_000;

    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            hns_buffer_duration,
            0,
            &wf as *const _,
            None,
        )?;
    }

    // Event-driven: WASAPI signals us when a new packet is ready.
    // CreateEventW in windows-rs 0.58 takes BOOL args via IntoParam — bool works.
    let event = unsafe { CreateEventW(None, false, false, windows::core::PCWSTR::null())? };
    unsafe { client.SetEventHandle(event)? };

    let capture_client: IAudioCaptureClient = unsafe { client.GetService()? };
    unsafe { client.Start()? };

    // Accumulator for re-framing into exactly FRAME_BYTES chunks. WASAPI may
    // hand us packets of any size; our downstream protocol wants consistent
    // 20 ms frames to feed Whisper's VAD gate predictably.
    let mut accum: Vec<u8> = Vec::with_capacity(FRAME_BYTES * 4);
    let bytes_per_sample = (TARGET_BITS as usize / 8) * (TARGET_CHANNELS as usize);

    while !stop.load(Ordering::SeqCst) {
        // 50 ms wait — keeps the thread responsive to `stop` without burning CPU.
        let wait = unsafe { WaitForSingleObject(event, 50) };
        if wait != WAIT_OBJECT_0 {
            continue;
        }

        loop {
            let packet_size = unsafe { capture_client.GetNextPacketSize()? };
            if packet_size == 0 {
                break;
            }
            let mut data_ptr: *mut u8 = ptr::null_mut();
            let mut num_frames: u32 = 0;
            let mut flags: u32 = 0;
            unsafe {
                capture_client.GetBuffer(
                    &mut data_ptr,
                    &mut num_frames,
                    &mut flags,
                    None,
                    None,
                )?;
            }
            let num_bytes = num_frames as usize * bytes_per_sample;
            if num_bytes > 0 {
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT_BIT) != 0 {
                    // Silent flag: content pointer is invalid, emit zeros.
                    accum.extend(std::iter::repeat(0u8).take(num_bytes));
                } else {
                    let slice = unsafe { std::slice::from_raw_parts(data_ptr, num_bytes) };
                    accum.extend_from_slice(slice);
                }
            }
            unsafe { capture_client.ReleaseBuffer(num_frames)? };

            while accum.len() >= FRAME_BYTES {
                let frame: Vec<u8> = accum.drain(..FRAME_BYTES).collect();
                let bytes = Bytes::from(frame);
                // try_send so a full downstream queue drops the frame instead of
                // blocking the audio thread (real-time constraint).
                match tx.try_send(bytes) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        // Backpressure — drop silently; the next frame is 20 ms away.
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        info!("capture sender closed; exiting");
                        unsafe { client.Stop().ok() };
                        return Ok(());
                    }
                }
            }
        }

    }

    unsafe { client.Stop().ok() };
    Ok(())
}
