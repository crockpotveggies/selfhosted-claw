#!/usr/bin/env bash
set -euo pipefail

export STREAM_STT_PORT="${STREAM_STT_PORT:-8794}"
export STT_MODEL_ID="${STT_MODEL_ID:-openai/whisper-small.en}"
export STT_TARGET_DEVICE="${STT_TARGET_DEVICE:-AUTO:GPU,CPU}"
export STT_QUANTIZATION="${STT_QUANTIZATION:-int8}"
export STT_MODEL_DIR="${STT_MODEL_DIR:-/models/exported}"
export HF_HOME="${HF_HOME:-/models/hf-cache}"

export STREAM_PARTIAL_STEP_MS="${STREAM_PARTIAL_STEP_MS:-400}"
export STREAM_WINDOW_MS="${STREAM_WINDOW_MS:-5000}"
export STREAM_ENDPOINT_SILENCE_MS="${STREAM_ENDPOINT_SILENCE_MS:-500}"
export STREAM_SILENCE_RMS_THRESHOLD="${STREAM_SILENCE_RMS_THRESHOLD:-250}"

mkdir -p "${STT_MODEL_DIR}" "${HF_HOME}"

python /app/server_stream_stt.py
