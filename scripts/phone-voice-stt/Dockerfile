FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scripts/phone-voice-stt/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY scripts/phone-voice-stt/server.py /app/server.py
COPY scripts/phone-voice-stt/entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

ENV STT_PORT=8791 \
    STT_MODEL_ID=openai/whisper-base.en \
    STT_TARGET_DEVICE=AUTO:GPU,CPU \
    STT_QUANTIZATION=int8 \
    STT_MODEL_DIR=/models/exported \
    HF_HOME=/models/hf-cache

ENTRYPOINT ["/app/entrypoint.sh"]
