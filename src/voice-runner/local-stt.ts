export const MANAGED_OPENVINO_STT_PORT = 8791;
export const MANAGED_OPENVINO_STT_BASE_URL = `http://127.0.0.1:${MANAGED_OPENVINO_STT_PORT}/v1`;
export const MANAGED_OPENVINO_STT_HEALTH_URL = `http://127.0.0.1:${MANAGED_OPENVINO_STT_PORT}/healthz`;
export const MANAGED_OPENVINO_STT_WARM_URL = `http://127.0.0.1:${MANAGED_OPENVINO_STT_PORT}/warm`;
export const MANAGED_OPENVINO_STT_MODEL = 'openai/whisper-small.en';

export const MANAGED_STREAM_STT_PORT = 8794;
export const MANAGED_STREAM_STT_BASE_URL = `http://127.0.0.1:${MANAGED_STREAM_STT_PORT}`;
export const MANAGED_STREAM_STT_HEALTH_URL = `http://127.0.0.1:${MANAGED_STREAM_STT_PORT}/healthz`;
export const MANAGED_STREAM_STT_WS_URL = `ws://127.0.0.1:${MANAGED_STREAM_STT_PORT}/v1/stt/stream`;

export function usesManagedOpenVinoStt(
  settings?: Record<string, unknown>,
): boolean {
  return String(settings?.voiceSttProvider || '').trim() === 'managed_openvino';
}

export function usesManagedStreamStt(
  settings?: Record<string, unknown>,
): boolean {
  return String(settings?.voiceSttProvider || '').trim() === 'managed_stream';
}

// Build the WebSocket URL for the streaming STT service from an HTTP base URL.
// Accepts the base URL with or without trailing slash; maps http->ws, https->wss.
export function getStreamSttWsUrl(httpBaseUrl: string): string {
  const trimmed = (httpBaseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return MANAGED_STREAM_STT_WS_URL;
  let wsBase = trimmed;
  if (wsBase.startsWith('https://')) wsBase = 'wss://' + wsBase.slice(8);
  else if (wsBase.startsWith('http://')) wsBase = 'ws://' + wsBase.slice(7);
  return `${wsBase}/v1/stt/stream`;
}

export function getStreamSttHealthUrl(httpBaseUrl: string): string {
  const trimmed = (httpBaseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return MANAGED_STREAM_STT_HEALTH_URL;
  return `${trimmed}/healthz`;
}
