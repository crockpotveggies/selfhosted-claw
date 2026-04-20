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


STT_PORT = int(os.getenv("STT_PORT", "8791"))
STT_MODEL_ID = os.getenv("STT_MODEL_ID", "openai/whisper-base.en").strip()
STT_TARGET_DEVICE = os.getenv("STT_TARGET_DEVICE", "AUTO:GPU,CPU").strip()
STT_QUANTIZATION = os.getenv("STT_QUANTIZATION", "int8").strip().lower()
STT_MODEL_DIR = Path(os.getenv("STT_MODEL_DIR", "/models/exported")).resolve()

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

    def warm(self) -> None:
        self.ensure_loaded()
        with self.lock:
            if self.ready:
                return
            silence = np.zeros(16000, dtype=np.float32).tolist()
            try:
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


def decode_audio(audio_bytes: bytes, suffix: str) -> list[float]:
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
                "16000",
                str(output_path),
            ],
            check=True,
        )
        pcm = np.fromfile(output_path, dtype=np.float32)
        return pcm.tolist()
    finally:
        input_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)


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
