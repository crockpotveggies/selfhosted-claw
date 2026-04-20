#!/usr/bin/env bash
set -euo pipefail

export STT_PORT="${STT_PORT:-8791}"
export STT_MODEL_ID="${STT_MODEL_ID:-openai/whisper-base.en}"
export STT_TARGET_DEVICE="${STT_TARGET_DEVICE:-AUTO:GPU,CPU}"
export STT_QUANTIZATION="${STT_QUANTIZATION:-int8}"
export STT_MODEL_DIR="${STT_MODEL_DIR:-/models/exported}"
export HF_HOME="${HF_HOME:-/models/hf-cache}"

mkdir -p "${STT_MODEL_DIR}" "${HF_HOME}"

python /app/server.py
