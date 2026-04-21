#!/usr/bin/env bash
set -euo pipefail

MODEL_NAME="${LLM_MODEL_NAME:-phone-voice-qwen3-4b}"
MODEL_REPO="${LLM_MODEL_REPO:-OpenVINO/Qwen3-4B-int4-ov}"
MODEL_DIR="/models/${MODEL_NAME}"
DEVICE_TARGET="${LLM_DEVICE_TARGET:-GPU.0}"
PORT="${LLM_PORT:-8793}"
WEIGHT_FORMAT="${LLM_WEIGHT_FORMAT:-int4}"
GROUP_SIZE="${LLM_GROUP_SIZE:-128}"

python - <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

model_name = os.environ.get("LLM_MODEL_NAME", "phone-voice-qwen3-4b")
model_repo = os.environ.get("LLM_MODEL_REPO", "OpenVINO/Qwen3-4B-int4-ov")
weight_format = os.environ.get("LLM_WEIGHT_FORMAT", "int4")
group_size = os.environ.get("LLM_GROUP_SIZE", "128")
model_dir = Path("/models") / model_name
export_dir = Path("/models") / f"{model_name}-exported"
token = (
    os.environ.get("HF_TOKEN")
    or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    or None
)


def has_openvino_ir(path: Path) -> bool:
    if not path.exists():
        return False
    return bool(list(path.glob("*_model.xml"))) and bool(list(path.glob("*_model.bin")))


# If the export directory already has IR, use it directly and skip download.
if has_openvino_ir(export_dir):
    print(f"[entrypoint] Using cached OpenVINO IR at {export_dir}", flush=True)
    serving_dir = export_dir
else:
    model_dir.mkdir(parents=True, exist_ok=True)
    if not has_openvino_ir(model_dir):
        print(f"[entrypoint] Downloading {model_repo} to {model_dir}", flush=True)
        snapshot_download(
            repo_id=model_repo,
            local_dir=str(model_dir),
            token=token,
        )
    if has_openvino_ir(model_dir):
        print(f"[entrypoint] Repo ships OpenVINO IR; using {model_dir} as-is", flush=True)
        serving_dir = model_dir
    else:
        # Raw/safetensors repo — export to OpenVINO IR with int4 quantization.
        export_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            "optimum-cli",
            "export",
            "openvino",
            "--model",
            str(model_dir),
            "--task",
            "text-generation-with-past",
            "--weight-format",
            weight_format,
            "--group-size",
            group_size,
            "--sym",
            "--ratio",
            "1.0",
            "--trust-remote-code",
            str(export_dir),
        ]
        print(
            f"[entrypoint] Converting to OpenVINO IR ({weight_format}, "
            f"group={group_size}, sym): {' '.join(cmd)}",
            flush=True,
        )
        result = subprocess.run(cmd, check=False)
        if result.returncode != 0 or not has_openvino_ir(export_dir):
            print(
                "[entrypoint] optimum-cli export failed; aborting so the "
                "container restarts rather than starting with no model.",
                file=sys.stderr,
                flush=True,
            )
            sys.exit(1)
        print(f"[entrypoint] OpenVINO IR written to {export_dir}", flush=True)
        serving_dir = export_dir

tokenizer_config = serving_dir / "tokenizer_config.json"
if tokenizer_config.exists():
    data = json.loads(tokenizer_config.read_text())
    # Qwen3.5 OpenVINO community exports may identify the tokenizer as the
    # internal OpenVINO "TokenizersBackend", which Transformers cannot import.
    # The vocab format is Qwen-compatible, and Qwen2TokenizerFast loads it.
    if data.get("tokenizer_class") == "TokenizersBackend":
        data["tokenizer_class"] = "Qwen2TokenizerFast"
        data.pop("processor_class", None)
        tokenizer_config.write_text(json.dumps(data, indent=2))

model_config = serving_dir / "config.json"
if model_config.exists() and (serving_dir / "openvino_text_embeddings_model.xml").exists():
    data = json.loads(model_config.read_text())
    if data.get("text_config") and data.get("model_type") != "qwen3_5":
        data["model_type"] = "qwen3_5"
        model_config.write_text(json.dumps(data, indent=2))

config = {
    "models": {
        model_name: {
            "model_name": model_name,
            "model_path": str(serving_dir),
            "model_type": "llm",
            "engine": "ovgenai",
            "device": os.environ.get("LLM_DEVICE_TARGET", "GPU.0"),
            "runtime_config": {},
            "vlm_type": None,
        }
    }
}
Path("/app/openarc_config.json").write_text(json.dumps(config, indent=2))
PY

echo "Starting OpenArc with ${MODEL_NAME} from ${MODEL_REPO} on ${DEVICE_TARGET}"
exec openarc serve start --host 0.0.0.0 --port "${PORT}" --load-models "${MODEL_NAME}"
