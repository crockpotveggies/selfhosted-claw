// WebSocket client: attaches to the phone-voice browser streaming endpoint
// and fans out frames both directions.
//
// Outbound:  capture PCM frames (20 ms at 16 kHz / 16-bit mono) as binary.
// Inbound:   JSON text frames. `assistant_audio` carries a base64-encoded WAV
//            (server_tts.py sets Content-Type audio/wav). We strip the RIFF
//            header, resample to 16 kHz mono, and forward to the render queue.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

const RENDER_TARGET_RATE: u32 = 16_000;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ServerEvent {
    #[serde(rename = "assistant_audio")]
    AssistantAudio {
        #[serde(rename = "dataBase64")]
        data_base64: Option<String>,
        #[serde(rename = "contentType")]
        content_type: Option<String>,
    },
    #[serde(rename = "caller_turn")]
    CallerTurn { text: Option<String> },
    #[serde(rename = "assistant_turn")]
    AssistantTurn { text: Option<String> },
    #[serde(rename = "handoff")]
    Handoff {},
    #[serde(rename = "action")]
    Action {},
    #[serde(rename = "error")]
    Error { message: Option<String> },
    #[serde(other)]
    Other,
}

pub struct WsRunConfig {
    pub url: String,
    pub token: Option<String>,
    pub sample_rate_hz: u32,
}

/// Run the WebSocket session. Returns when the socket closes (either side).
pub async fn run_session(
    cfg: WsRunConfig,
    mut capture_rx: mpsc::Receiver<Bytes>,
    render_tx: mpsc::Sender<Bytes>,
) -> Result<()> {
    // tokio-tungstenite 0.24 doesn't expose an easy header builder here, but
    // the backend accepts the admin token as a query parameter, so we rely on
    // the caller to have baked `?token=...` into the URL. We still support a
    // header for callers that can set it.
    let mut request = cfg
        .url
        .as_str()
        .into_client_request()
        .context("parse WS URL")?;
    if let Some(ref token) = cfg.token {
        if let Ok(value) = format!("Bearer {token}").parse() {
            request.headers_mut().insert("Authorization", value);
        }
        if let Ok(value) = token.parse() {
            request.headers_mut().insert("X-Admin-Token", value);
        }
    }

    info!(url = %cfg.url, "connecting to phone-voice WebSocket");
    let (ws_stream, resp) = connect_async(request)
        .await
        .context("WebSocket connect failed")?;
    info!(status = %resp.status(), "WebSocket connected; sending start frame");
    let (mut sink, mut stream) = ws_stream.split();

    let start_msg = serde_json::json!({
        "type": "start",
        "sampleRateHz": cfg.sample_rate_hz,
    });
    sink.send(Message::Text(start_msg.to_string().into()))
        .await
        .context("send start frame")?;
    info!("WebSocket start frame sent; entering bidirectional pump");

    let mut ping_interval = tokio::time::interval(Duration::from_secs(15));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            biased;

            // Outbound capture frames — binary WebSocket messages.
            maybe_frame = capture_rx.recv() => {
                match maybe_frame {
                    Some(frame) => {
                        if let Err(err) = sink.send(Message::Binary(frame.to_vec().into())).await {
                            warn!(error = %err, "WebSocket send failed; closing");
                            break;
                        }
                    }
                    None => {
                        info!("capture channel closed; sending end frame");
                        let _ = sink
                            .send(Message::Text("{\"type\":\"end\"}".to_string().into()))
                            .await;
                        let _ = sink.close().await;
                        break;
                    }
                }
            }

            // Inbound from server.
            maybe_msg = stream.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(txt))) => {
                        if let Err(err) = dispatch_text(&txt, &render_tx).await {
                            debug!(error = %err, "ignoring server event");
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        // The current server protocol doesn't send binary frames
                        // in this direction, but ignore them defensively.
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        // Echo the payload back unchanged — tungstenite owns the buffer type.
                        let _ = sink.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        info!(?frame, "server closed WebSocket");
                        break;
                    }
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(err)) => {
                        warn!(error = %err, "WebSocket read error");
                        break;
                    }
                    None => {
                        info!("WebSocket stream ended");
                        break;
                    }
                }
            }

            _ = ping_interval.tick() => {
                if let Err(err) = sink.send(Message::Ping(Vec::<u8>::new().into())).await {
                    warn!(error = %err, "ping failed");
                    break;
                }
            }
        }
    }

    Ok(())
}

async fn dispatch_text(raw: &str, render_tx: &mpsc::Sender<Bytes>) -> Result<()> {
    let event: ServerEvent = serde_json::from_str(raw)
        .with_context(|| format!("parse server event: {raw}"))?;
    match event {
        ServerEvent::AssistantAudio { data_base64, content_type } => {
            let Some(b64) = data_base64 else {
                return Ok(());
            };
            if b64.is_empty() {
                return Ok(());
            }
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(b64.as_bytes())
                .context("decode base64 audio")?;
            let ct = content_type.unwrap_or_default();
            let pcm16k = decode_to_pcm16k(&decoded, &ct)?;
            if pcm16k.is_empty() {
                return Ok(());
            }
            // Chunk to ~20 ms frames to keep queue latency bounded.
            let chunk = 640usize;
            for window in pcm16k.chunks(chunk) {
                let bytes = Bytes::copy_from_slice(window);
                match render_tx.try_send(bytes) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(frame)) => {
                        // Queue full — block briefly; this is not an audio thread.
                        let _ = render_tx.send(frame).await;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => return Ok(()),
                }
            }
        }
        ServerEvent::CallerTurn { text } => {
            debug!(text = ?text, "caller_turn");
        }
        ServerEvent::AssistantTurn { text } => {
            debug!(text = ?text, "assistant_turn");
        }
        ServerEvent::Error { message } => {
            warn!(message = ?message, "server error");
        }
        ServerEvent::Handoff {} | ServerEvent::Action {} | ServerEvent::Other => {}
    }
    Ok(())
}

/// Decode server audio to little-endian int16 PCM at 16 kHz mono.
/// Supports RIFF WAVE (PCM) and a raw audio/l16 fallback for forward-compat.
fn decode_to_pcm16k(bytes: &[u8], content_type: &str) -> Result<Vec<u8>> {
    let ct = content_type.to_ascii_lowercase();

    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return decode_wav_to_pcm16k(bytes);
    }

    if ct.starts_with("audio/l16") || ct.starts_with("audio/pcm") {
        // Try to pull sample rate from the content-type parameter if present.
        let rate = parse_l16_rate(&ct).unwrap_or(RENDER_TARGET_RATE);
        return Ok(resample_linear_i16(bytes, rate, 1, RENDER_TARGET_RATE));
    }

    // Last-ditch: treat as a headerless 24 kHz mono stream (F5-TTS default).
    Ok(resample_linear_i16(bytes, 24_000, 1, RENDER_TARGET_RATE))
}

fn decode_wav_to_pcm16k(bytes: &[u8]) -> Result<Vec<u8>> {
    // Minimal RIFF parser: fmt + data. Accepts PCM (1) and IEEE float (3).
    if bytes.len() < 44 {
        return Err(anyhow!("WAV too short"));
    }
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (format, channels, rate, bits)
    let mut data_slice: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = body_start + size;
        if body_end > bytes.len() {
            break;
        }
        match id {
            b"fmt " => {
                if size >= 16 {
                    let format = u16::from_le_bytes([bytes[body_start], bytes[body_start + 1]]);
                    let channels = u16::from_le_bytes([bytes[body_start + 2], bytes[body_start + 3]]);
                    let rate = u32::from_le_bytes([
                        bytes[body_start + 4],
                        bytes[body_start + 5],
                        bytes[body_start + 6],
                        bytes[body_start + 7],
                    ]);
                    let bits = u16::from_le_bytes([bytes[body_start + 14], bytes[body_start + 15]]);
                    fmt = Some((format, channels, rate, bits));
                }
            }
            b"data" => {
                data_slice = Some(&bytes[body_start..body_end]);
            }
            _ => {}
        }
        // Chunks are word-aligned.
        pos = body_end + (size & 1);
    }

    let (format, channels, rate, bits) = fmt.ok_or_else(|| anyhow!("WAV missing fmt chunk"))?;
    let data = data_slice.ok_or_else(|| anyhow!("WAV missing data chunk"))?;

    let samples_i16: Vec<i16> = match (format, bits) {
        (1, 16) => data
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect(),
        (1, 8) => data.iter().map(|&b| ((b as i32 - 128) * 256) as i16).collect(),
        (3, 32) => data
            .chunks_exact(4)
            .map(|c| {
                let f = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                let clamped = f.max(-1.0).min(1.0);
                (clamped * i16::MAX as f32) as i16
            })
            .collect(),
        _ => return Err(anyhow!("unsupported WAV format {format} / {bits}-bit")),
    };

    let mono_i16 = if channels > 1 {
        let ch = channels as usize;
        samples_i16
            .chunks(ch)
            .map(|frame| {
                let sum: i32 = frame.iter().map(|&s| s as i32).sum();
                (sum / ch as i32) as i16
            })
            .collect::<Vec<i16>>()
    } else {
        samples_i16
    };

    let mono_bytes: Vec<u8> = mono_i16
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .collect();

    if rate == RENDER_TARGET_RATE {
        Ok(mono_bytes)
    } else {
        Ok(resample_linear_i16(&mono_bytes, rate, 1, RENDER_TARGET_RATE))
    }
}

fn parse_l16_rate(ct: &str) -> Option<u32> {
    for part in ct.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("rate=") {
            return rest.trim().parse().ok();
        }
    }
    None
}

/// Linear resampler for int16 LE mono PCM. Voice-grade only — polyphase would
/// be better but the tradeoff isn't worth the code weight for a bridge.
fn resample_linear_i16(bytes: &[u8], src_rate: u32, src_channels: u16, dst_rate: u32) -> Vec<u8> {
    let ch = src_channels.max(1) as usize;
    let frame_bytes = 2 * ch;
    if bytes.len() < frame_bytes {
        return Vec::new();
    }
    // Flatten to mono i16 first if needed.
    let mono_in: Vec<i16> = if ch == 1 {
        bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect()
    } else {
        bytes
            .chunks_exact(frame_bytes)
            .map(|frame| {
                let sum: i32 = (0..ch)
                    .map(|i| i16::from_le_bytes([frame[i * 2], frame[i * 2 + 1]]) as i32)
                    .sum();
                (sum / ch as i32) as i16
            })
            .collect()
    };

    if src_rate == dst_rate || mono_in.is_empty() {
        return mono_in.iter().flat_map(|s| s.to_le_bytes()).collect();
    }

    // Integer decimation fast-path (e.g. 32k -> 16k, 48k -> 16k).
    if src_rate > dst_rate && src_rate % dst_rate == 0 {
        let step = (src_rate / dst_rate) as usize;
        let out: Vec<i16> = mono_in.iter().step_by(step).copied().collect();
        return out.iter().flat_map(|s| s.to_le_bytes()).collect();
    }

    // Linear interpolation. Sufficient for telephony-band voice.
    let ratio = src_rate as f64 / dst_rate as f64;
    let dst_len = ((mono_in.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(dst_len);
    for i in 0..dst_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos.floor() as usize;
        let frac = src_pos - idx as f64;
        let a = mono_in[idx] as f64;
        let b = *mono_in.get(idx + 1).unwrap_or(&mono_in[idx]) as f64;
        let sample = a + (b - a) * frac;
        out.push(sample.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
    }
    out.iter().flat_map(|s| s.to_le_bytes()).collect()
}
