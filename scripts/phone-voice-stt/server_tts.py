#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import soundfile as sf
import torch
import torchaudio
from aiohttp import web
from aiohttp.client_exceptions import ClientConnectionResetError
from cached_path import cached_path
from hydra.utils import get_class
from omegaconf import OmegaConf
from f5_tts.model.modules import AttnProcessor, MelSpec, apply_rotary_pos_emb

from f5_tts.infer.utils_infer import (
    chunk_text,
    infer_batch_process,
    load_model,
    load_vocoder,
    preprocess_ref_audio_text,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("phone-voice-f5-tts")

_ORIGINAL_MEL_FORWARD = MelSpec.forward
_ORIGINAL_ATTN_CALL = AttnProcessor.__call__


def _env(name: str, default: str) -> str:
    return os.getenv(name, default).strip() or default


TTS_PORT = int(_env("TTS_PORT", "8792"))
TTS_MODEL_ID = _env("TTS_MODEL_ID", "F5TTS_v1_Base")
TTS_MODEL_NAME = _env("TTS_MODEL_NAME", "phone-voice-f5-tts")
TTS_DEFAULT_VOICE = _env("TTS_DEFAULT_VOICE", "basic_ref_en")
TTS_DEVICE_TARGET = _env("TTS_DEVICE_TARGET", "xpu").lower()
TTS_CHUNK_SIZE = int(_env("TTS_CHUNK_SIZE", "2048"))
TTS_NFE_STEP = int(_env("TTS_NFE_STEP", "16"))
TTS_SPEED = float(_env("TTS_SPEED", "1.0"))
TTS_CFG_STRENGTH = float(_env("TTS_CFG_STRENGTH", "2.0"))


def patched_mel_forward(self: MelSpec, wav: torch.Tensor) -> torch.Tensor:
    if wav.device.type != "xpu":
        return _ORIGINAL_MEL_FORWARD(self, wav)

    wav_cpu = wav.to("cpu")
    if self.dummy.device != wav_cpu.device:
        self.to(wav_cpu.device)

    mel = self.extractor(
        waveform=wav_cpu,
        n_fft=self.n_fft,
        n_mel_channels=self.n_mel_channels,
        target_sample_rate=self.target_sample_rate,
        hop_length=self.hop_length,
        win_length=self.win_length,
    )
    return mel.to(wav.device)


def patched_attn_call(
    self: AttnProcessor,
    attn: Any,
    x: torch.Tensor,
    mask: torch.Tensor | None = None,
    rope=None,
) -> torch.Tensor:
    if self.attn_backend != "torch" or x.device.type != "xpu":
        return _ORIGINAL_ATTN_CALL(self, attn, x, mask=mask, rope=rope)

    batch_size = x.shape[0]
    query = attn.to_q(x)
    key = attn.to_k(x)
    value = attn.to_v(x)

    inner_dim = key.shape[-1]
    head_dim = inner_dim // attn.heads
    query = query.view(batch_size, -1, attn.heads, head_dim).transpose(1, 2)
    key = key.view(batch_size, -1, attn.heads, head_dim).transpose(1, 2)
    value = value.view(batch_size, -1, attn.heads, head_dim).transpose(1, 2)

    if attn.q_norm is not None:
        query = attn.q_norm(query)
    if attn.k_norm is not None:
        key = attn.k_norm(key)

    if rope is not None:
        freqs, xpos_scale = rope
        q_xpos_scale, k_xpos_scale = (xpos_scale, xpos_scale**-1.0) if xpos_scale is not None else (1.0, 1.0)

        if self.pe_attn_head is not None:
            pn = self.pe_attn_head
            query[:, :pn, :, :] = apply_rotary_pos_emb(query[:, :pn, :, :], freqs, q_xpos_scale)
            key[:, :pn, :, :] = apply_rotary_pos_emb(key[:, :pn, :, :], freqs, k_xpos_scale)
        else:
            query = apply_rotary_pos_emb(query, freqs, q_xpos_scale)
            key = apply_rotary_pos_emb(key, freqs, k_xpos_scale)

    scores = torch.matmul(query, key.transpose(-2, -1)) / math.sqrt(head_dim)
    if self.attn_mask_enabled and mask is not None:
        attn_mask = mask.unsqueeze(1).unsqueeze(1)
        attn_mask = attn_mask.expand(batch_size, attn.heads, query.shape[-2], key.shape[-2])
        scores = scores.masked_fill(~attn_mask, torch.finfo(scores.dtype).min)

    probs = torch.softmax(scores, dim=-1)
    x = torch.matmul(probs, value)
    x = x.transpose(1, 2).reshape(batch_size, -1, attn.heads * head_dim)
    x = x.to(query.dtype)

    x = attn.to_out[0](x)
    x = attn.to_out[1](x)

    if mask is not None:
        mask = mask.unsqueeze(-1)
        x = x.masked_fill(~mask, 0.0)

    return x


MelSpec.forward = patched_mel_forward
AttnProcessor.__call__ = patched_attn_call


@dataclass(frozen=True)
class VoiceProfile:
    key: str
    ref_audio: str
    ref_text: str
    max_seconds: float | None = None


DEFAULT_REF_TEXT = "Some call me nature, others call me mother nature."
DEFAULT_REF_AUDIO = str(
    files("f5_tts").joinpath("infer/examples/basic/basic_ref_en.wav")
)
TOWN_REF_TEXT = (
    "My poor dear friend, you live here no better than the ants! "
    "Now, you should just see how I fare! "
    "My larder is a regular horn of plenty. "
    "You must come and stay with me, and I promise you "
    "you shall live on the fat of the land."
)
TOWN_REF_AUDIO = str(files("f5_tts").joinpath("infer/examples/multi/town.flac"))
COUNTRY_REF_TEXT = "Goodbye, I'm off. "
COUNTRY_REF_AUDIO = str(
    files("f5_tts").joinpath("infer/examples/multi/country.flac")
)
# main.flac is the only shipped F5-TTS reference that's actually female
# (measured f0 ~216 Hz vs ~126-140 Hz for the others). Ref_text hardcoded
# (transcribed via Whisper) to avoid F5-TTS calling its internal ASR path,
# which pulls in torchcodec → requires a specific libav version we don't ship.
MAIN_REF_AUDIO = str(files("f5_tts").joinpath("infer/examples/multi/main.flac"))
MAIN_REF_TEXT = (
    "Six boons of fresh snow peas, five thick slabs of blue cheese and "
    "maybe a snack for her brother Bob."
)

VOICE_PROFILES: dict[str, VoiceProfile] = {
    "basic_ref_en": VoiceProfile(
        key="basic_ref_en",
        ref_audio=DEFAULT_REF_AUDIO,
        ref_text=DEFAULT_REF_TEXT,
    ),
    "town": VoiceProfile(
        key="town",
        ref_audio=TOWN_REF_AUDIO,
        ref_text=TOWN_REF_TEXT,
    ),
    "country": VoiceProfile(
        key="country",
        ref_audio=COUNTRY_REF_AUDIO,
        ref_text=COUNTRY_REF_TEXT,
    ),
    # main.flac is the only shipped F5-TTS reference that's measurably female
    # (f0 ~216 Hz). basic_ref_en, town, and country are all male (f0 120-140 Hz).
    "female_default": VoiceProfile(
        key="female_default",
        ref_audio=MAIN_REF_AUDIO,
        ref_text=MAIN_REF_TEXT,
    ),
    "default": VoiceProfile(
        key="default",
        ref_audio=MAIN_REF_AUDIO,
        ref_text=MAIN_REF_TEXT,
    ),
}

# Optional user-supplied reference clip. Drop a WAV/FLAC into the
# phone-voice-tts-models volume (or any path inside the container) and set
# TTS_CUSTOM_REF_AUDIO + TTS_CUSTOM_REF_TEXT to register a "custom" voice.
_CUSTOM_REF_AUDIO = os.environ.get("TTS_CUSTOM_REF_AUDIO", "").strip()
_CUSTOM_REF_TEXT = os.environ.get("TTS_CUSTOM_REF_TEXT", "").strip()
if _CUSTOM_REF_AUDIO and _CUSTOM_REF_TEXT and os.path.exists(_CUSTOM_REF_AUDIO):
    VOICE_PROFILES["custom"] = VoiceProfile(
        key="custom",
        ref_audio=_CUSTOM_REF_AUDIO,
        ref_text=_CUSTOM_REF_TEXT,
    )


def resolve_device(target: str) -> str:
    target = (target or "xpu").strip().lower()
    xpu_available = hasattr(torch, "xpu") and torch.xpu.is_available()
    if target == "xpu":
        if not xpu_available:
            raise RuntimeError("XPU was requested, but torch.xpu is unavailable")
        return "xpu"
    if target == "cpu":
        return "cpu"
    if target == "auto":
        return "xpu" if xpu_available else "cpu"
    if target == "auto:xpu,cpu":
        return "xpu" if xpu_available else "cpu"
    return "xpu" if xpu_available else "cpu"


def wav_bytes_from_chunk(chunk: np.ndarray, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, chunk, sample_rate, format="WAV")
    return buffer.getvalue()


class F5StreamingService:
    def __init__(self) -> None:
        self.device = resolve_device(TTS_DEVICE_TARGET)
        self.model = None
        self.vocoder = None
        self.audio = None
        self.sr = None
        self.ref_text = ""
        self.max_chars = 135
        self.few_chars = 80
        self.min_chars = 40
        self.target_sample_rate = 24000
        self.mel_spec_type = "vocos"
        self._ready = False
        self._warmed_at: str | None = None
        self._last_error: str | None = None
        self._profile_key = ""
        self._lock = threading.Lock()

    @property
    def model_name(self) -> str:
        return TTS_MODEL_NAME

    def _load_model_locked(self) -> None:
        if self.model is not None and self.vocoder is not None:
            return

        model_cfg = OmegaConf.load(
            str(files("f5_tts").joinpath(f"configs/{TTS_MODEL_ID}.yaml"))
        )
        model_cls = get_class(f"f5_tts.model.{model_cfg.model.backbone}")
        model_arc = model_cfg.model.arch

        self.mel_spec_type = model_cfg.model.mel_spec.mel_spec_type
        self.target_sample_rate = model_cfg.model.mel_spec.target_sample_rate

        ckpt_file = str(
            cached_path(
                f"hf://SWivid/F5-TTS/{TTS_MODEL_ID}/model_1250000.safetensors",
                cache_dir=os.getenv("HF_HOME"),
            )
        )
        vocab_file = str(files("f5_tts").joinpath("infer/examples/vocab.txt"))

        logger.info("Loading F5-TTS model on %s", self.device)
        vocoder_device = "cpu" if self.device == "xpu" else self.device
        self.vocoder = load_vocoder(
            self.mel_spec_type,
            is_local=False,
            local_path=None,
            device=vocoder_device,
            hf_cache_dir=os.getenv("HF_HOME"),
        )
        if self.device == "xpu":
            original_decode = self.vocoder.decode

            def decode_on_cpu(features: torch.Tensor, **kwargs: Any) -> torch.Tensor:
                return original_decode(features.to("cpu"), **kwargs)

            self.vocoder.decode = decode_on_cpu
        self.model = load_model(
            model_cls,
            model_arc,
            ckpt_path=ckpt_file,
            mel_spec_type=self.mel_spec_type,
            vocab_file=vocab_file,
            ode_method="euler",
            use_ema=True,
            device=self.device,
        ).to(self.device, dtype=torch.float32)

    def _apply_profile_locked(self, profile_key: str) -> None:
        profile = VOICE_PROFILES.get(profile_key) or VOICE_PROFILES[TTS_DEFAULT_VOICE] or VOICE_PROFILES["basic_ref_en"]
        if self._profile_key == profile.key and self.audio is not None:
            return

        ref_audio, ref_text = preprocess_ref_audio_text(
            profile.ref_audio,
            profile.ref_text,
        )
        # torchaudio.load routes through torchcodec in recent versions, which
        # requires libav libraries we don't ship. Use soundfile directly; it
        # handles WAV/FLAC/OGG and gives us the same (channels, samples)
        # tensor shape torchaudio would have.
        try:
            data, sr = sf.read(ref_audio, dtype="float32", always_2d=True)
            audio = torch.from_numpy(data.T).contiguous()
        except Exception:
            audio, sr = torchaudio.load(ref_audio)
        if profile.max_seconds is not None and profile.max_seconds > 0:
            max_frames = max(1, int(sr * profile.max_seconds))
            audio = audio[:, :max_frames]
        self.audio = audio
        self.sr = sr
        self.ref_text = ref_text
        self._profile_key = profile.key

        ref_audio_duration = self.audio.shape[-1] / self.sr
        ref_text_byte_len = len(self.ref_text.encode("utf-8"))
        budget = max(25 - ref_audio_duration, 3)
        ratio = ref_text_byte_len / max(ref_audio_duration, 0.1)
        self.max_chars = max(int(ratio * budget), 60)
        self.few_chars = max(int(self.max_chars / 2), 35)
        self.min_chars = max(int(self.max_chars / 4), 20)

    def _iter_chunks_locked(
        self,
        text: str,
        profile_key: str,
    ) -> Iterator[np.ndarray]:
        self._load_model_locked()
        self._apply_profile_locked(profile_key)

        text_batches = chunk_text(text, max_chars=self.max_chars)
        if text_batches:
          text_batches = (
              chunk_text(text_batches[0], max_chars=self.few_chars)
              + text_batches[1:]
          )
        if text_batches:
          text_batches = (
              chunk_text(text_batches[0], max_chars=self.min_chars)
              + text_batches[1:]
          )

        audio_stream = infer_batch_process(
            (self.audio, self.sr),
            self.ref_text,
            text_batches,
            self.model,
            self.vocoder,
            progress=None,
            device=self.device,
            streaming=True,
            chunk_size=TTS_CHUNK_SIZE,
            nfe_step=TTS_NFE_STEP,
            speed=TTS_SPEED,
            cfg_strength=TTS_CFG_STRENGTH,
        )
        for audio_chunk, _ in audio_stream:
            if len(audio_chunk) > 0:
                yield np.asarray(audio_chunk, dtype=np.float32)

    def warm(self) -> dict[str, Any]:
        with self._lock:
            try:
                self._load_model_locked()
                self._apply_profile_locked(TTS_DEFAULT_VOICE)
                for _ in self._iter_chunks_locked("Warm up the voice path.", TTS_DEFAULT_VOICE):
                    break
                self._ready = True
                self._warmed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                self._last_error = None
            except Exception as exc:  # noqa: BLE001
                self._ready = False
                self._last_error = str(exc)
                logger.exception("F5-TTS warmup failed")
                raise
        return self.health_payload(include_models=True)

    def health_payload(self, include_models: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": self._last_error is None,
            "ready": self._ready,
            "model": TTS_MODEL_ID,
            "model_name": TTS_MODEL_NAME,
            "configured_device": TTS_DEVICE_TARGET,
            "actual_device": self.device,
            "default_voice": TTS_DEFAULT_VOICE,
            "voices": sorted(VOICE_PROFILES),
            "warmed_at": self._warmed_at,
            "last_error": self._last_error,
            "xpu_available": bool(hasattr(torch, "xpu") and torch.xpu.is_available()),
        }
        if include_models:
            payload["data"] = [{"id": TTS_MODEL_NAME, "object": "model"}]
        return payload

    def synthesize_full(self, text: str, profile_key: str) -> bytes:
        chunks: list[np.ndarray] = []
        with self._lock:
            for chunk in self._iter_chunks_locked(text, profile_key):
                chunks.append(chunk)
        if not chunks:
            return wav_bytes_from_chunk(np.zeros(1, dtype=np.float32), self.target_sample_rate)
        return wav_bytes_from_chunk(np.concatenate(chunks), self.target_sample_rate)

    def stream_speech_events(self, text: str, profile_key: str) -> Iterator[bytes]:
        with self._lock:
            for index, chunk in enumerate(self._iter_chunks_locked(text, profile_key)):
                payload = {
                    "index": index,
                    "audio_base64": base64.b64encode(
                        wav_bytes_from_chunk(chunk, self.target_sample_rate)
                    ).decode("ascii"),
                    "content_type": "audio/wav",
                    "voice": profile_key,
                }
                yield f"data: {json.dumps(payload)}\n\n".encode("utf-8")
        yield b"data: {\"done\": true}\n\n"


SERVICE = F5StreamingService()


def resolve_voice(requested: str | None) -> str:
    voice = (requested or TTS_DEFAULT_VOICE or "basic_ref_en").strip().lower()
    return voice if voice in VOICE_PROFILES else TTS_DEFAULT_VOICE


async def healthz(_request: web.Request) -> web.Response:
    return web.json_response(SERVICE.health_payload())


async def models(_request: web.Request) -> web.Response:
    payload = {
        "object": "list",
        "data": [{"id": SERVICE.model_name, "object": "model"}],
    }
    return web.json_response(payload)


async def warm(_request: web.Request) -> web.Response:
    payload = await asyncio.to_thread(SERVICE.warm)
    return web.json_response(payload)


async def audio_speech(request: web.Request) -> web.StreamResponse:
    body = await request.json()
    model = str(body.get("model") or "").strip()
    if model and model != SERVICE.model_name:
        raise web.HTTPBadRequest(text=f"Model '{model}' is not loaded")

    text = str(body.get("input") or "").strip()
    if not text:
        raise web.HTTPBadRequest(text="input is required")

    voice = resolve_voice(body.get("voice"))
    stream = bool(body.get("stream", True))

    if stream:
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
        await response.prepare(request)
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes | BaseException | None] = asyncio.Queue()

        def worker() -> None:
            try:
                for event in SERVICE.stream_speech_events(text, voice):
                    loop.call_soon_threadsafe(queue.put_nowait, event)
            except BaseException as exc:  # noqa: BLE001
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        threading.Thread(target=worker, daemon=True).start()

        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, BaseException):
                raise item
            try:
                await response.write(item)
            except ClientConnectionResetError:
                logger.debug("TTS stream client disconnected before completion")
                break
        try:
            await response.write_eof()
        except ClientConnectionResetError:
            logger.debug("TTS stream closed before EOF")
        return response

    wav_bytes = await asyncio.to_thread(SERVICE.synthesize_full, text, voice)
    return web.Response(
        body=wav_bytes,
        headers={"Content-Type": "audio/wav"},
    )


def create_app() -> web.Application:
    app = web.Application(client_max_size=16 * 1024 * 1024)
    app.router.add_get("/healthz", healthz)
    app.router.add_post("/warm", warm)
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/audio/speech", audio_speech)
    return app


def _startup_warmup() -> None:
    """Run a real synthesis on startup so GPU kernels are compiled
    before the first production request lands."""
    try:
        logger.info("Running startup TTS warmup (default voice=%s)", TTS_DEFAULT_VOICE)
        start = time.time()
        # Run a full (non-truncated) short synthesis so every kernel in the
        # streaming path — transformer, vocoder decode, mel extraction — is
        # exercised and its SYCL/XPU binaries are cached.
        SERVICE.synthesize_full("Ready.", TTS_DEFAULT_VOICE)
        # Mark service as warmed; mirrors /warm bookkeeping.
        SERVICE._ready = True
        SERVICE._warmed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        SERVICE._last_error = None
        logger.info("Startup TTS warmup complete in %.2fs", time.time() - start)
    except Exception as exc:  # noqa: BLE001
        # Don't crash the server if warmup fails — the /warm endpoint can
        # still be retried, and health will surface the error.
        SERVICE._last_error = str(exc)
        logger.exception("Startup TTS warmup failed; continuing to serve")


if __name__ == "__main__":
    _startup_warmup()
    web.run_app(create_app(), host="0.0.0.0", port=TTS_PORT)
