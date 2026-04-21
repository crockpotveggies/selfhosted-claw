"""Streaming STT server for the phone-voice pipeline.

Accepts WebSocket connections carrying PCM16LE mono audio and emits partial +
final JSON transcripts.  Reuses the same OpenVINO Whisper model + export logic
as the batch ``server.py`` so we share the ``phone-voice-stt-models`` volume
and don't add new hardware risk.

Strategy: sliding-window Whisper.  We keep a rolling float32 PCM buffer and,
every ``STREAM_PARTIAL_STEP_MS`` of new audio, run ``WhisperPipeline.generate``
over the last ``STREAM_WINDOW_MS`` (default 5 s).  Partials are deduped against
the previous emitted text.  Endpointing is RMS-based on a 300 ms trailing
window; explicit ``{"type":"flush"}`` forces a final.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import shutil
import subprocess
import threading
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("stream-stt")
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
from aiohttp import WSMsgType, web

import openvino_genai as ov_genai

try:
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover - optional at runtime
    resample_poly = None  # type: ignore


# ---- Env / config ----------------------------------------------------------

STREAM_STT_PORT = int(os.getenv("STREAM_STT_PORT", "8794"))
STT_MODEL_ID = os.getenv("STT_MODEL_ID", "openai/whisper-small.en").strip()
STT_TARGET_DEVICE = os.getenv("STT_TARGET_DEVICE", "AUTO:GPU,CPU").strip()
STT_QUANTIZATION = os.getenv("STT_QUANTIZATION", "int8").strip().lower()
STT_MODEL_DIR = Path(os.getenv("STT_MODEL_DIR", "/models/exported")).resolve()
STT_WARMUP_DURATIONS = os.getenv("STT_WARMUP_DURATIONS", "1,3,5").strip()

STREAM_PARTIAL_STEP_MS = int(os.getenv("STREAM_PARTIAL_STEP_MS", "400"))
STREAM_WINDOW_MS = int(os.getenv("STREAM_WINDOW_MS", "5000"))
STREAM_ENDPOINT_SILENCE_MS_DEFAULT = int(os.getenv("STREAM_ENDPOINT_SILENCE_MS", "500"))
STREAM_SILENCE_RMS_THRESHOLD = float(os.getenv("STREAM_SILENCE_RMS_THRESHOLD", "80"))

SAMPLE_RATE = 16000
TRAIL_RMS_MS = 300  # window used for endpoint silence detection


# ---- Whisper loader / warmup (mirrors server.py) ---------------------------


class WhisperState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pipeline: Optional[ov_genai.WhisperPipeline] = None
        # Per-pipeline inference lock.  WhisperPipeline is not safe for
        # concurrent ``generate`` calls, and we may have multiple sessions in
        # flight; serialise on this lock from the worker thread.
        self.generate_lock = threading.Lock()
        self.ready = False
        self.last_error: Optional[str] = None
        self.warmed_at: Optional[str] = None

    def ensure_exported(self) -> None:
        if any(STT_MODEL_DIR.glob("*.xml")):
            return

        if STT_MODEL_DIR.exists():
            shutil.rmtree(STT_MODEL_DIR, ignore_errors=True)
        STT_MODEL_DIR.mkdir(parents=True, exist_ok=True)

        command = [
            "optimum-cli",
            "export",
            "openvino",
            "--trust-remote-code",
            "--model",
            STT_MODEL_ID,
        ]
        if STT_QUANTIZATION == "int8":
            command.extend(["--weight-format", "int8"])
        command.append(str(STT_MODEL_DIR))

        subprocess.run(command, check=True)

    def ensure_loaded(self) -> None:
        with self.lock:
            if self.pipeline is not None:
                return
            try:
                self.ensure_exported()
                self.pipeline = ov_genai.WhisperPipeline(
                    str(STT_MODEL_DIR),
                    STT_TARGET_DEVICE,
                )
            except Exception as exc:
                self.last_error = str(exc)
                raise

    def _parse_warmup_durations(self) -> list[float]:
        out: list[float] = []
        for token in STT_WARMUP_DURATIONS.split(","):
            token = token.strip()
            if not token:
                continue
            try:
                value = float(token)
            except ValueError:
                continue
            if value > 0:
                out.append(value)
        if not out:
            out = [1.0, 3.0, 5.0]
        return out

    def warm(self) -> None:
        self.ensure_loaded()
        with self.lock:
            if self.ready:
                return
            try:
                assert self.pipeline is not None
                for seconds in self._parse_warmup_durations():
                    samples = max(1, int(round(seconds * SAMPLE_RATE)))
                    silence = np.zeros(samples, dtype=np.float32).tolist()
                    with self.generate_lock:
                        self.pipeline.generate(silence)
                self.ready = True
                self.warmed_at = datetime.now(timezone.utc).isoformat()
            except Exception as exc:
                self.last_error = str(exc)
                raise

    def generate_text(self, pcm_f32: np.ndarray) -> str:
        if self.pipeline is None:
            self.ensure_loaded()
        assert self.pipeline is not None
        with self.generate_lock:
            result = self.pipeline.generate(pcm_f32.tolist())

        texts = getattr(result, "texts", None)
        if texts:
            return str(texts[0]).strip()
        chunks = getattr(result, "chunks", None)
        if chunks:
            joined = " ".join(
                str(getattr(chunk, "text", "")).strip()
                for chunk in chunks
                if str(getattr(chunk, "text", "")).strip()
            )
            if joined:
                return joined
        return str(result).strip()


state = WhisperState()


# ---- Audio helpers ---------------------------------------------------------


def pcm16_bytes_to_float32(buf: bytes) -> np.ndarray:
    if not buf:
        return np.zeros(0, dtype=np.float32)
    # Tolerate odd-length buffers — the gateway sometimes sends chunks that
    # don't align to int16 sample boundaries. Drop the trailing half-sample.
    if len(buf) & 1:
        buf = buf[:-1]
    if not buf:
        return np.zeros(0, dtype=np.float32)
    pcm = np.frombuffer(buf, dtype=np.int16)
    return (pcm.astype(np.float32) / 32768.0).copy()


def resample_to_16k(pcm_f32: np.ndarray, src_rate: int) -> np.ndarray:
    if src_rate == SAMPLE_RATE or pcm_f32.size == 0:
        return pcm_f32
    if resample_poly is not None:
        g = math.gcd(int(src_rate), SAMPLE_RATE)
        up = SAMPLE_RATE // g
        down = src_rate // g
        return resample_poly(pcm_f32, up, down).astype(np.float32, copy=False)
    # Fallback linear interp.
    duration = pcm_f32.shape[0] / float(src_rate)
    target_len = max(1, int(round(duration * SAMPLE_RATE)))
    x_old = np.linspace(0.0, duration, num=pcm_f32.shape[0], endpoint=False)
    x_new = np.linspace(0.0, duration, num=target_len, endpoint=False)
    return np.interp(x_new, x_old, pcm_f32).astype(np.float32, copy=False)


def rms_int16_scale(pcm_f32: np.ndarray) -> float:
    """RMS on the 16-bit PCM scale to match STREAM_SILENCE_RMS_THRESHOLD semantics."""
    if pcm_f32.size == 0:
        return 0.0
    return float(np.sqrt(np.mean((pcm_f32 * 32768.0) ** 2)))


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- Session state ---------------------------------------------------------


class StreamSession:
    """Per-connection rolling buffer + partial/final emission logic."""

    def __init__(self, sample_rate_in: int, endpoint_silence_ms: int) -> None:
        self.sample_rate_in = sample_rate_in
        self.endpoint_silence_ms = endpoint_silence_ms

        # Rolling buffer of 16 kHz float32 samples for the current utterance.
        self.buffer = np.zeros(0, dtype=np.float32)
        # Samples added since the last partial emission.
        self.samples_since_partial = 0
        # Trailing silence samples accumulated since last voiced input.
        self.trailing_silent_samples = 0
        # Whether we've seen any voiced audio in the current utterance.
        self.has_voice = False
        # Last emitted partial text (for dedupe).
        self.last_partial_text: str = ""
        # If True, we just emitted a final and are awaiting fresh voiced audio
        # before starting a new utterance.
        self.awaiting_next_utterance = False
        # One-time-log flag for the first audio frame of a session.
        self.logged_first_audio = False

    @property
    def partial_step_samples(self) -> int:
        return int(round(STREAM_PARTIAL_STEP_MS * SAMPLE_RATE / 1000))

    @property
    def window_samples(self) -> int:
        return int(round(STREAM_WINDOW_MS * SAMPLE_RATE / 1000))

    @property
    def endpoint_silence_samples(self) -> int:
        return int(round(self.endpoint_silence_ms * SAMPLE_RATE / 1000))

    def append_pcm(self, pcm_f32_16k: np.ndarray) -> None:
        if pcm_f32_16k.size == 0:
            return
        self.buffer = np.concatenate((self.buffer, pcm_f32_16k))
        # Cap buffer at 2x window so we don't grow unboundedly during long
        # speech; Whisper only sees the last window_samples anyway, but we
        # keep a small margin for endpoint detection.
        max_len = max(self.window_samples * 2, SAMPLE_RATE * 12)
        if self.buffer.shape[0] > max_len:
            self.buffer = self.buffer[-max_len:]
        self.samples_since_partial += pcm_f32_16k.shape[0]

    def update_voice_activity(self, pcm_f32_16k: np.ndarray) -> None:
        """Track trailing silence for endpoint detection."""
        if pcm_f32_16k.size == 0:
            return
        # Split the new audio into ~20 ms hops and walk forward so a mid-chunk
        # voice->silence transition resets the counter correctly.
        hop = max(1, int(round(0.02 * SAMPLE_RATE)))
        i = 0
        n = pcm_f32_16k.shape[0]
        while i < n:
            j = min(n, i + hop)
            seg = pcm_f32_16k[i:j]
            if rms_int16_scale(seg) >= STREAM_SILENCE_RMS_THRESHOLD:
                self.has_voice = True
                self.trailing_silent_samples = 0
                if self.awaiting_next_utterance:
                    # Starting a new utterance after a previous final.
                    self.awaiting_next_utterance = False
            else:
                self.trailing_silent_samples += seg.shape[0]
            i = j

    def window_slice(self) -> np.ndarray:
        if self.buffer.shape[0] <= self.window_samples:
            return self.buffer
        return self.buffer[-self.window_samples :]

    def should_emit_partial(self) -> bool:
        return (
            self.has_voice
            and not self.awaiting_next_utterance
            and self.samples_since_partial >= self.partial_step_samples
            and self.buffer.shape[0] > 0
        )

    def mark_partial_emitted(self) -> None:
        self.samples_since_partial = 0

    def endpoint_reached(self) -> bool:
        if not self.has_voice or self.awaiting_next_utterance:
            return False
        return self.trailing_silent_samples >= self.endpoint_silence_samples

    def reset_after_final(self) -> None:
        self.buffer = np.zeros(0, dtype=np.float32)
        self.samples_since_partial = 0
        self.trailing_silent_samples = 0
        self.has_voice = False
        self.last_partial_text = ""
        self.awaiting_next_utterance = True


# ---- WebSocket handler -----------------------------------------------------


async def _generate_async(pcm: np.ndarray) -> str:
    # Dispatch the blocking WhisperPipeline.generate() to a worker thread.
    return await asyncio.to_thread(state.generate_text, pcm)


async def _emit(ws: web.WebSocketResponse, payload: dict) -> None:
    if ws.closed:
        return
    try:
        await ws.send_str(json.dumps(payload))
    except ConnectionResetError:
        pass


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=8 * 1024 * 1024)
    await ws.prepare(request)

    if not state.ready:
        await _emit(
            ws,
            {
                "type": "error",
                "message": "model not ready",
            },
        )
        await ws.close()
        return ws

    session: Optional[StreamSession] = None
    # Serialise inference per-session so partials don't overtake each other.
    infer_lock = asyncio.Lock()
    # Only one partial task in flight per session. If a partial fires while
    # another is still running, skip it rather than queueing — queued partials
    # block subsequent final (flush/endpoint) emissions, which is the whole
    # latency-critical path.
    partial_in_flight = {"value": False}

    async def emit_partial_if_changed() -> None:
        assert session is not None
        if partial_in_flight["value"]:
            return
        partial_in_flight["value"] = True
        try:
            window = session.window_slice()
            if window.size == 0:
                return
            window_copy = window.copy()
            async with infer_lock:
                try:
                    text = await _generate_async(window_copy)
                except Exception as exc:
                    await _emit(ws, {"type": "error", "message": f"generate failed: {exc}"})
                    return
            if not text or text == session.last_partial_text:
                return
            session.last_partial_text = text
            logger.info("partial: %s", text[:200])
            await _emit(
                ws,
                {"type": "partial", "text": text, "timestamp": iso_now()},
            )
        finally:
            partial_in_flight["value"] = False

    async def emit_final(is_endpoint: bool) -> None:
        assert session is not None
        # If no voice was ever detected in this utterance, emitting a final
        # invites Whisper to hallucinate "you" / "Thank you" etc. from the
        # residual silence. Just reset and wait for the next utterance.
        if not session.has_voice:
            session.reset_after_final()
            return
        window = session.window_slice()
        if window.size == 0:
            session.reset_after_final()
            return
        window_copy = window.copy()
        async with infer_lock:
            try:
                text = await _generate_async(window_copy)
            except Exception as exc:
                await _emit(ws, {"type": "error", "message": f"generate failed: {exc}"})
                session.reset_after_final()
                return
        logger.info(
            "final (endpoint=%s, has_voice=%s, buffer=%d samples): %s",
            is_endpoint,
            session.has_voice,
            session.buffer.shape[0],
            text[:200],
        )
        await _emit(
            ws,
            {
                "type": "final",
                "text": text,
                "timestamp": iso_now(),
                "isEndpoint": bool(is_endpoint),
            },
        )
        session.reset_after_final()

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                except Exception:
                    await _emit(ws, {"type": "error", "message": "invalid json frame"})
                    continue
                mtype = payload.get("type")
                if mtype == "start":
                    sample_rate_in = int(payload.get("sampleRateHz") or SAMPLE_RATE)
                    endpoint_ms = int(
                        payload.get("endpointSilenceMs")
                        or STREAM_ENDPOINT_SILENCE_MS_DEFAULT
                    )
                    if sample_rate_in <= 0:
                        await _emit(
                            ws,
                            {"type": "error", "message": "sampleRateHz must be positive"},
                        )
                        continue
                    session = StreamSession(sample_rate_in, endpoint_ms)
                    await _emit(ws, {"type": "ready"})
                elif mtype == "flush":
                    if session is None:
                        await _emit(ws, {"type": "error", "message": "flush before start"})
                        continue
                    await emit_final(is_endpoint=False)
                elif mtype == "end":
                    if session is not None:
                        # Best-effort final on any residual voiced audio.
                        if session.has_voice and not session.awaiting_next_utterance:
                            await emit_final(is_endpoint=False)
                    break
                else:
                    await _emit(
                        ws,
                        {"type": "error", "message": f"unknown message type: {mtype}"},
                    )
            elif msg.type == WSMsgType.BINARY:
                if session is None:
                    await _emit(ws, {"type": "error", "message": "binary frame before start"})
                    continue
                if not session.logged_first_audio:
                    session.logged_first_audio = True
                    logger.info(
                        "stream session first audio: %d bytes @ %d Hz (odd=%s)",
                        len(msg.data),
                        session.sample_rate_in,
                        bool(len(msg.data) & 1),
                    )
                pcm_f32 = pcm16_bytes_to_float32(msg.data)
                pcm_16k = resample_to_16k(pcm_f32, session.sample_rate_in)
                session.update_voice_activity(pcm_16k)
                session.append_pcm(pcm_16k)

                if session.endpoint_reached():
                    await emit_final(is_endpoint=True)
                elif session.should_emit_partial():
                    session.mark_partial_emitted()
                    # Fire and don't block the recv loop.  We still hold
                    # infer_lock inside to serialise generate() calls per
                    # session.
                    asyncio.create_task(emit_partial_if_changed())
            elif msg.type == WSMsgType.ERROR:
                break
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                break
    finally:
        if not ws.closed:
            await ws.close()

    return ws


# ---- HTTP routes -----------------------------------------------------------


async def healthz(_request: web.Request) -> web.Response:
    body = {
        "ok": True,
        "ready": state.ready,
        "model": STT_MODEL_ID,
        "device": STT_TARGET_DEVICE,
        "quantization": STT_QUANTIZATION,
        "warmedAt": state.warmed_at,
        "last_error": state.last_error,
        "config": {
            "partialStepMs": STREAM_PARTIAL_STEP_MS,
            "windowMs": STREAM_WINDOW_MS,
            "endpointSilenceMsDefault": STREAM_ENDPOINT_SILENCE_MS_DEFAULT,
            "silenceRmsThreshold": STREAM_SILENCE_RMS_THRESHOLD,
            "wsPath": "/v1/stt/stream",
        },
    }
    return web.json_response(body)


async def _background_warmup(_app: web.Application) -> None:
    def _do() -> None:
        try:
            state.warm()
        except Exception:
            # state.last_error is set inside warm(); /healthz reflects it.
            pass

    await asyncio.to_thread(_do)


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/v1/stt/stream", ws_handler)

    async def _on_startup(app: web.Application) -> None:
        # Kick off warmup without blocking the event loop start.  /healthz
        # reports ready=false until it finishes.
        asyncio.create_task(_background_warmup(app))

    app.on_startup.append(_on_startup)
    return app


def main() -> None:
    app = build_app()
    web.run_app(app, host="0.0.0.0", port=STREAM_STT_PORT, print=None)


if __name__ == "__main__":
    main()
