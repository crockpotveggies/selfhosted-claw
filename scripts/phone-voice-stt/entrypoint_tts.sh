#!/usr/bin/env bash
set -euo pipefail

mkdir -p /models /models/hf-cache

exec python /app/server_tts.py
