from __future__ import annotations

from pathlib import Path


LLM_PATH = Path("/app/src/engine/ov_genai/llm.py")

source = LLM_PATH.read_text()

if "_Qwen35SplitPipeline" not in source:
    source = source.replace(
        "import asyncio\nimport gc\nimport logging\n",
        "import asyncio\nimport gc\nimport logging\nimport time\nfrom pathlib import Path\n\nimport numpy as np\n",
    )

    source = source.replace(
        "\n\nclass OVGenAI_LLM:\n",
        r'''

class _MeanValue:
    def __init__(self, mean: float):
        self.mean = mean


class _Qwen35PerfMetrics:
    def __init__(
        self,
        *,
        input_tokens: int,
        new_tokens: int,
        load_time_ms: float,
        ttft_ms: float,
        tpot_ms: float,
        generate_ms: float,
    ):
        self._input_tokens = input_tokens
        self._new_tokens = new_tokens
        self._load_time_ms = load_time_ms
        self._ttft_ms = ttft_ms
        self._tpot_ms = tpot_ms
        self._generate_ms = generate_ms

    def get_load_time(self) -> float:
        return self._load_time_ms

    def get_ttft(self) -> _MeanValue:
        return _MeanValue(self._ttft_ms)

    def get_tpot(self) -> _MeanValue:
        return _MeanValue(self._tpot_ms)

    def get_throughput(self) -> _MeanValue:
        seconds = max(self._generate_ms / 1000.0, 1e-6)
        return _MeanValue(self._new_tokens / seconds)

    def get_generate_duration(self) -> _MeanValue:
        return _MeanValue(self._generate_ms)

    def get_num_input_tokens(self) -> int:
        return self._input_tokens

    def get_num_generated_tokens(self) -> int:
        return self._new_tokens


class _Qwen35Result:
    def __init__(self, text: str, tokens: list[int], perf_metrics: _Qwen35PerfMetrics):
        self.texts = [text]
        self.tokens = tokens
        self.perf_metrics = perf_metrics


class _Qwen35SplitPipeline:
    """Minimal Qwen3.5 OpenVINO runner for exports split into embeddings + LM.

    OpenVINO GenAI's generic LLMPipeline currently tries to feed `input_ids` into
    these Qwen3.5 exports, but the exported language graph expects
    `inputs_embeds`. The tiny phone-voice LLM only needs short streaming text, so
    we drive the two OpenVINO graphs directly and keep the OpenArc API surface.
    """

    is_qwen35_split = True

    def __init__(self, model_path: str, device: str):
        started = time.perf_counter()
        self.model_path = Path(model_path)
        self.device = device
        self.core = ov.Core()
        self.embedding_model = self.core.compile_model(
            str(self.model_path / "openvino_text_embeddings_model.xml"),
            device,
        )
        self.language_model = self.core.compile_model(
            str(self.model_path / "openvino_language_model.xml"),
            device,
        )
        self.tokenizer = AutoTokenizer.from_pretrained(str(self.model_path))
        self.load_time_ms = (time.perf_counter() - started) * 1000

    def get_tokenizer(self):
        return self.tokenizer

    def _embed(self, token_ids: np.ndarray) -> np.ndarray:
        return self.embedding_model({"input": token_ids})[self.embedding_model.output(0)]

    def _next_token(self, logits: np.ndarray, config: GenerationConfig) -> int:
        temperature = float(getattr(config, "temperature", 0.0) or 0.0)
        if temperature <= 0.2:
            return int(np.argmax(logits))

        scores = logits.astype(np.float64) / max(temperature, 1e-5)
        top_k = int(getattr(config, "top_k", 0) or 0)
        if top_k > 0 and top_k < scores.shape[-1]:
            keep = np.argpartition(scores, -top_k)[-top_k:]
            filtered = np.full_like(scores, -np.inf)
            filtered[keep] = scores[keep]
            scores = filtered

        scores -= np.nanmax(scores)
        probs = np.exp(scores)
        probs /= np.sum(probs)
        return int(np.random.choice(np.arange(probs.shape[-1]), p=probs))

    def generate(self, inputs, generation_config: GenerationConfig, streamer=None):
        started = time.perf_counter()
        request = self.language_model.create_infer_request()
        try:
            request.reset_state()
        except Exception:
            pass

        if hasattr(inputs, "data"):
            token_ids = np.asarray(inputs.data, dtype=np.int64)
        else:
            token_ids = np.asarray(inputs, dtype=np.int64)
        if token_ids.ndim == 1:
            token_ids = token_ids.reshape(1, -1)

        prompt_len = int(token_ids.shape[1])
        max_new_tokens = int(getattr(generation_config, "max_new_tokens", 64) or 64)
        eos_token_id = self.tokenizer.eos_token_id
        beam_idx = np.array([0], dtype=np.int32)

        embeds = self._embed(token_ids)
        attention_mask = np.ones((1, prompt_len), dtype=np.int64)
        result = request.infer(
            {
                "inputs_embeds": embeds,
                "attention_mask": attention_mask,
                "beam_idx": beam_idx,
            }
        )
        logits = result[self.language_model.output("logits")]

        output_tokens: list[int] = []
        first_token_at: float | None = None
        next_token = self._next_token(logits[0, -1], generation_config)

        for _ in range(max_new_tokens):
            if first_token_at is None:
                first_token_at = time.perf_counter()

            if next_token == eos_token_id:
                break

            output_tokens.append(next_token)
            if streamer is not None:
                status = streamer.write(next_token)
                if str(status).endswith("CANCEL"):
                    break

            one_token = np.array([[next_token]], dtype=np.int64)
            embeds = self._embed(one_token)
            attention_mask = np.ones((1, prompt_len + len(output_tokens)), dtype=np.int64)
            result = request.infer(
                {
                    "inputs_embeds": embeds,
                    "attention_mask": attention_mask,
                    "beam_idx": beam_idx,
                }
            )
            logits = result[self.language_model.output("logits")]
            next_token = self._next_token(logits[0, -1], generation_config)

        if streamer is not None and hasattr(streamer, "end"):
            streamer.end()

        finished = time.perf_counter()
        text = self.tokenizer.decode(output_tokens, skip_special_tokens=True)
        generated_ms = (finished - started) * 1000
        ttft_ms = ((first_token_at or finished) - started) * 1000
        token_count = max(len(output_tokens), 1)
        tpot_ms = max((generated_ms - ttft_ms) / token_count, 0.0)
        metrics = _Qwen35PerfMetrics(
            input_tokens=prompt_len,
            new_tokens=len(output_tokens),
            load_time_ms=self.load_time_ms,
            ttft_ms=ttft_ms,
            tpot_ms=tpot_ms,
            generate_ms=generated_ms,
        )
        return _Qwen35Result(text, output_tokens, metrics)


class OVGenAI_LLM:
''',
    )

    source = source.replace(
        "        self.model = LLMPipeline(\n            loader.model_path,\n            loader.device,\n            **pipeline_kwargs\n        )\n\n        self.encoder_tokenizer = AutoTokenizer.from_pretrained(loader.model_path)\n        logging.info(f\"{loader.model_name} loaded successfully\")\n",
        "        model_path = Path(loader.model_path)\n        if (model_path / \"openvino_text_embeddings_model.xml\").exists() and (model_path / \"openvino_language_model.xml\").exists():\n            self.model = _Qwen35SplitPipeline(loader.model_path, loader.device)\n        else:\n            self.model = LLMPipeline(\n                loader.model_path,\n                loader.device,\n                **pipeline_kwargs\n            )\n\n        self.encoder_tokenizer = AutoTokenizer.from_pretrained(loader.model_path)\n        logging.info(f\"{loader.model_name} loaded successfully\")\n",
    )

    source = source.replace(
        "        text = decoder_tokenizer.decode(result.tokens)[0] if getattr(result, \"tokens\", None) else \"\"\n",
        "        if getattr(self.model, \"is_qwen35_split\", False):\n            text = result.texts[0] if getattr(result, \"texts\", None) else \"\"\n        else:\n            text = decoder_tokenizer.decode(result.tokens)[0] if getattr(result, \"tokens\", None) else \"\"\n",
    )

    LLM_PATH.write_text(source)
