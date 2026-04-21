// WASAPI render loop. Pulls 16 kHz / 16-bit / mono PCM frames off an
// mpsc::Receiver<Bytes> and writes them to the HFP render endpoint. Uses the
// event-driven WASAPI model so we block exactly as long as the engine needs.
//
// Incoming server audio is decoded to 16 kHz mono before it reaches this
// queue (see ws.rs). We rely on AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM to paper
// over any small format mismatch the HFP endpoint might exhibit.

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
    IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, WAVEFORMATEX,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::endpoints::{self, Flow};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const TARGET_CHANNELS: u16 = 1;
const TARGET_BITS: u16 = 16;

pub struct RenderHandle {
    pub stop: Arc<AtomicBool>,
    pub thread: Option<thread::JoinHandle<()>>,
}

impl RenderHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub fn spawn_render(
    substring: String,
    rx: mpsc::Receiver<Bytes>,
) -> Result<RenderHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    let handle = thread::Builder::new()
        .name("wasapi-render".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            if let Err(err) = run_render(&substring, rx, stop_thread) {
                warn!(error = %err, "render loop exited with error");
            }
            unsafe {
                CoUninitialize();
            }
        })
        .context("spawn render thread")?;

    Ok(RenderHandle { stop, thread: Some(handle) })
}

fn run_render(
    substring: &str,
    mut rx: mpsc::Receiver<Bytes>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let enumerator: IMMDeviceEnumerator = endpoints::create_enumerator()?;
    let selected = endpoints::select_endpoint_by_name(&enumerator, Flow::Render, substring)?;
    info!(
        friendly_name = %selected.info.friendly_name,
        id = %selected.info.id,
        "render endpoint selected"
    );

    let device = selected.device;
    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };

    let wf = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: TARGET_CHANNELS,
        nSamplesPerSec: TARGET_SAMPLE_RATE,
        nAvgBytesPerSec: TARGET_SAMPLE_RATE * (TARGET_CHANNELS as u32) * (TARGET_BITS as u32 / 8),
        nBlockAlign: TARGET_CHANNELS * (TARGET_BITS / 8),
        wBitsPerSample: TARGET_BITS,
        cbSize: 0,
    };

    // 200 ms engine buffer covers network jitter; WASAPI rounds internally.
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

    let event = unsafe { CreateEventW(None, false, false, windows::core::PCWSTR::null())? };
    unsafe { client.SetEventHandle(event)? };

    let render_client: IAudioRenderClient = unsafe { client.GetService()? };
    let buffer_frame_count = unsafe { client.GetBufferSize()? };
    let bytes_per_frame = TARGET_CHANNELS as u32 * (TARGET_BITS as u32 / 8);

    unsafe { client.Start()? };

    // Rolling leftover buffer: server TTS chunks don't align to WASAPI's frame
    // boundaries, so we keep a byte-level queue and splice into whatever the
    // render client's available frames happen to be.
    let mut pending: Vec<u8> = Vec::with_capacity(buffer_frame_count as usize * bytes_per_frame as usize);

    while !stop.load(Ordering::SeqCst) {
        // Pull from the network queue non-blockingly first — drain whatever's there.
        while let Ok(frame) = rx.try_recv() {
            pending.extend_from_slice(&frame);
        }

        // If we have no audio at all, keep the stream alive with silence so the
        // HFP sink does not stall. Otherwise wait on the WASAPI event.
        let wait = unsafe { WaitForSingleObject(event, 20) };
        if wait != WAIT_OBJECT_0 {
            // Best-effort recv with a small timeout to avoid a busy spin.
            continue;
        }

        let padding = unsafe { client.GetCurrentPadding()? };
        let available_frames = buffer_frame_count.saturating_sub(padding);
        if available_frames == 0 {
            continue;
        }
        let available_bytes = available_frames as usize * bytes_per_frame as usize;

        // Pull any fresh frames that arrived while we were waiting.
        while pending.len() < available_bytes {
            match rx.try_recv() {
                Ok(frame) => pending.extend_from_slice(&frame),
                Err(_) => break,
            }
        }

        let write_bytes = available_bytes.min(pending.len());
        if write_bytes == 0 {
            // Write silence so the clock keeps ticking.
            let silence_frames = available_frames;
            unsafe {
                let buf_ptr: *mut u8 = render_client.GetBuffer(silence_frames)?;
                ptr::write_bytes(buf_ptr, 0, silence_frames as usize * bytes_per_frame as usize);
                render_client.ReleaseBuffer(silence_frames, 0)?;
            }
            continue;
        }

        let write_frames = (write_bytes / bytes_per_frame as usize) as u32;
        unsafe {
            let buf_ptr: *mut u8 = render_client.GetBuffer(write_frames)?;
            let slice = std::slice::from_raw_parts_mut(buf_ptr, write_frames as usize * bytes_per_frame as usize);
            let copy_len = slice.len();
            slice.copy_from_slice(&pending[..copy_len]);
            pending.drain(..copy_len);
            render_client.ReleaseBuffer(write_frames, 0)?;
        }

        // Queue cap: if more than 2 s of audio has piled up (server talking
        // faster than HFP can drain), drop the oldest to stay real-time.
        const MAX_PENDING_BYTES: usize =
            (TARGET_SAMPLE_RATE as usize) * 2 * (TARGET_BITS as usize / 8);
        if pending.len() > MAX_PENDING_BYTES {
            let drop = pending.len() - MAX_PENDING_BYTES;
            pending.drain(..drop);
        }
    }

    unsafe { client.Stop().ok() };
    Ok(())
}
