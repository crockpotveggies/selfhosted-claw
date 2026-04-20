export const MANAGED_OPENVINO_STT_PORT = 8791;
export const MANAGED_OPENVINO_STT_BASE_URL = `http://127.0.0.1:${MANAGED_OPENVINO_STT_PORT}/v1`;
export const MANAGED_OPENVINO_STT_HEALTH_URL = `http://127.0.0.1:${MANAGED_OPENVINO_STT_PORT}/healthz`;
export const MANAGED_OPENVINO_STT_WARM_URL = `http://127.0.0.1:${MANAGED_OPENVINO_STT_PORT}/warm`;
export const MANAGED_OPENVINO_STT_MODEL = 'openai/whisper-base.en';

export function usesManagedOpenVinoStt(
  settings?: Record<string, unknown>,
): boolean {
  return String(settings?.voiceSttProvider || '').trim() === 'managed_openvino';
}
