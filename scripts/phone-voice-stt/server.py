import io
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np
import openvino_genai as ov_genai
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

try:
    import soundfile as sf  # type: ignore
except Exception:  # pragma: no cover - optional at runtime, but in requirements
    sf = None  # type: ignore

try:
    from scipy.signal import resample_poly  # type: ignore
except Exception:  # pragma: no cover - optional at runtime, but in requirements
    resample_poly = None  # type: ignore


STT_PORT = int(os.getenv("STT_PORT", "8791"))
STT_MODEL_ID = os.getenv("STT_MODEL_ID", "openai/whisper-small.en").strip()
STT_TARGET_DEVICE = os.getenv("STT_TARGET_DEVICE", "AUTO:GPU,CPU").strip()
STT_QUANTIZATION = os.getenv("STT_QUANTIZATION", "int8").strip().lower()
STT_MODEL_DIR = Path(os.getenv("STT_MODEL_DIR", "/models/exported")).resolve()
# Comma-separated durations (in seconds) used for proactive warmup. Covers the
# typical utterance shapes seen from the phone-voice pipeline so OpenVINO's
# kernel cache is populated for realistic request sizes, not just 1 s silence.
STT_WARMUP_DURATIONS = os.getenv("STT_WARMUP_DURATIONS", "1,3,5").strip()
STT_AUTO_WARMUP = os.getenv("STT_AUTO_WARMUP", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "",
)

SAMPLE_RATE = 16000

app = FastAPI(title="phone-voice-stt", version="1.0.0")


class WhisperState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pipeline = None
        self.ready = False
        self.last_error = None

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
            except Exception as exc:  # pragma: no cover - container startup path
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
                # Run inference across several realistic clip lengths so the
                # OpenVINO kernel / shape cache is populated for the shapes we
                # actually see in production. The old behaviour was a single
                # 1 s silence buffer, which did not cover the 3-5 s utterances
                # that dominate phone-voice traffic.
                for seconds in self._parse_warmup_durations():
                    samples = max(1, int(round(seconds * SAMPLE_RATE)))
                    silence = np.zeros(samples, dtype=np.float32).tolist()
                    self.pipeline.generate(silence)
                self.ready = True
            except Exception as exc:  # pragma: no cover - container startup path
                self.last_error = str(exc)
                raise

    def transcribe(self, audio_bytes: bytes, suffix: str) -> str:
        self.warm()
        raw_speech = decode_audio(audio_bytes, suffix)
        try:
            result = self.pipeline.generate(raw_speech)
        except Exception as exc:
            self.last_error = str(exc)
            raise

        texts = getattr(result, "texts", None)
        if texts:
            return str(texts[0]).strip()

        chunks = getattr(result, "chunks", None)
        if chunks:
            text = " ".join(
                str(getattr(chunk, "text", "")).strip()
                for chunk in chunks
                if str(getattr(chunk, "text", "")).strip()
            )
            if text:
                return text

        return str(result).strip()


state = WhisperState()


def _to_mono_float32(data: np.ndarray) -> np.ndarray:
    arr = np.asarray(data)
    if arr.ndim > 1:
        # soundfile returns (frames, channels); average down to mono.
        arr = arr.mean(axis=1)
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32, copy=False)
    return arr


def _resample(pcm: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate:
        return pcm
    if resample_poly is not None:
        from math import gcd

        g = gcd(int(src_rate), int(dst_rate))
        up = int(dst_rate // g)
        down = int(src_rate // g)
        resampled = resample_poly(pcm, up, down).astype(np.float32, copy=False)
        return resampled
    # Fallback: linear interpolation. Lower quality but avoids a subprocess.
    duration = pcm.shape[0] / float(src_rate)
    target_len = max(1, int(round(duration * dst_rate)))
    x_old = np.linspace(0.0, duration, num=pcm.shape[0], endpoint=False, dtype=np.float64)
    x_new = np.linspace(0.0, duration, num=target_len, endpoint=False, dtype=np.float64)
    return np.interp(x_new, x_old, pcm).astype(np.float32, copy=False)


def _decode_with_soundfile(audio_bytes: bytes) -> np.ndarray | None:
    """Decode WAV/FLAC/OGG in-process. Returns None if soundfile can't handle it."""
    if sf is None:
        return None
    try:
        with sf.SoundFile(io.BytesIO(audio_bytes)) as handle:
            src_rate = int(handle.samplerate)
            data = handle.read(dtype="float32", always_2d=False)
    except Exception:
        return None
    pcm = _to_mono_float32(data)
    if pcm.size == 0:
        return pcm
    return _resample(pcm, src_rate, SAMPLE_RATE)


def _decode_with_ffmpeg(audio_bytes: bytes, suffix: str) -> np.ndarray:
    with tempfile.NamedTemporaryFile(suffix=suffix or ".wav", delete=False) as input_file:
        input_file.write(audio_bytes)
        input_path = Path(input_file.name)

    output_path = input_path.with_suffix(".f32")
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(input_path),
                "-f",
                "f32le",
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                str(output_path),
            ],
            check=True,
        )
        return np.fromfile(output_path, dtype=np.float32)
    finally:
        input_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)


def decode_audio(audio_bytes: bytes, suffix: str) -> list[float]:
    """Decode uploaded audio to 16 kHz mono float32 PCM.

    Fast path: libsndfile (WAV/FLAC/OGG) in-process, no subprocess. The
    TypeScript caller wraps audio in a WAV header before upload, so this is
    the hot path for the phone-voice pipeline.

    Fallback: ffmpeg subprocess for anything soundfile can't open (mp3, webm,
    opus-in-container, etc.), preserving prior behaviour.
    """
    suffix_lower = (suffix or "").lower()
    # soundfile handles wav / flac / ogg-vorbis natively via libsndfile.
    if sf is not None and suffix_lower in ("", ".wav", ".wave", ".flac", ".ogg", ".oga"):
        pcm = _decode_with_soundfile(audio_bytes)
        if pcm is not None:
            return pcm.tolist()
    elif sf is not None:
        # Unknown suffix: give soundfile a chance before paying the ffmpeg
        # process-spawn tax.
        pcm = _decode_with_soundfile(audio_bytes)
        if pcm is not None:
            return pcm.tolist()

    pcm = _decode_with_ffmpeg(audio_bytes, suffix)
    return pcm.tolist()


@app.on_event("startup")
async def _startup_warmup() -> None:
    """Proactively load + warm the pipeline so the first real request is fast.

    Runs off the event loop (model load + multi-shape inference is CPU/GPU
    bound). Failures are logged to ``state.last_error`` but do not crash the
    server — /warm and /healthz still reflect the state.
    """
    if not STT_AUTO_WARMUP:
        return
    try:
        await run_in_threadpool(state.warm)
    except Exception:  # pragma: no cover - startup best-effort
        # state.last_error is set by warm(); leave the server up so /healthz
        # can report the failure and /warm can retry.
        pass


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "ready": state.ready,
        "model": STT_MODEL_ID,
        "device": STT_TARGET_DEVICE,
        "quantization": STT_QUANTIZATION,
        "last_error": state.last_error,
    }


@app.post("/warm")
async def warm() -> dict:
    try:
        await run_in_threadpool(state.warm)
    except Exception as exc:  # pragma: no cover - runtime path
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "ok": True,
        "ready": True,
        "model": STT_MODEL_ID,
        "device": STT_TARGET_DEVICE,
        "quantization": STT_QUANTIZATION,
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(default=STT_MODEL_ID),
) -> dict:
    if model and model.strip() and model.strip() != STT_MODEL_ID:
        raise HTTPException(
            status_code=400,
            detail=f"Managed STT container is serving {STT_MODEL_ID}, not {model.strip()}",
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    try:
        text = await run_in_threadpool(state.transcribe, audio_bytes, suffix)
    except Exception as exc:  # pragma: no cover - runtime path
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "text": text,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=STT_PORT)
