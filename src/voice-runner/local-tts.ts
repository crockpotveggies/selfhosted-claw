export const MANAGED_F5_TTS_PORT = 8792;
export const MANAGED_F5_TTS_SERVER_URL = `http://127.0.0.1:${MANAGED_F5_TTS_PORT}`;
export const MANAGED_F5_TTS_BASE_URL = `${MANAGED_F5_TTS_SERVER_URL}/v1`;
export const MANAGED_F5_TTS_HEALTH_URL = `${MANAGED_F5_TTS_SERVER_URL}/healthz`;
export const MANAGED_F5_TTS_WARM_URL = `${MANAGED_F5_TTS_SERVER_URL}/warm`;
export const MANAGED_F5_TTS_MODELS_URL = `${MANAGED_F5_TTS_BASE_URL}/models`;
export const MANAGED_F5_TTS_SYNTHESIZE_URL = `${MANAGED_F5_TTS_BASE_URL}/audio/speech`;
export const MANAGED_F5_TTS_MODEL = 'F5TTS_v1_Base';
export const MANAGED_F5_TTS_MODEL_NAME = 'phone-voice-f5-tts';
export const MANAGED_F5_TTS_DEFAULT_VOICE = 'female_default';
export const MANAGED_F5_TTS_DEVICE_TARGET = 'xpu';

export function usesManagedF5Tts(settings?: Record<string, unknown>): boolean {
  const provider = String(settings?.voiceTtsProvider || '').trim();
  return (
    provider === 'managed_f5_tts' ||
    provider === 'managed_openvino_tts' ||
    provider === 'csm_tts' ||
    provider === 'kyutai_tts' ||
    provider === 'pocket_tts'
  );
}
