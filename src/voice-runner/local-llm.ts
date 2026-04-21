export const MANAGED_OPENARC_LLM_PORT = 8793;
export const MANAGED_OPENARC_LLM_SERVER_URL = `http://127.0.0.1:${MANAGED_OPENARC_LLM_PORT}`;
export const MANAGED_OPENARC_LLM_BASE_URL = `${MANAGED_OPENARC_LLM_SERVER_URL}/v1`;
export const MANAGED_OPENARC_LLM_MODELS_URL = `${MANAGED_OPENARC_LLM_BASE_URL}/models`;
export const MANAGED_OPENARC_LLM_MODEL = 'phone-voice-qwen3-4b';
export const MANAGED_OPENARC_LLM_MODEL_REPO = 'OpenVINO/Qwen3-4B-int4-ov';
export const MANAGED_OPENARC_LLM_DEVICE_TARGET = 'GPU.0';
export const MANAGED_OPENARC_LLM_API_KEY = 'phone-voice-local-openarc';

export function usesManagedOpenArcLlm(
  settings?: Record<string, unknown>,
): boolean {
  return (
    String(settings?.voiceRunnerProvider || '').trim() === 'managed_openarc'
  );
}
