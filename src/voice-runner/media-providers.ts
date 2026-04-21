import type { VoiceCallMetadata, VoiceCaller } from './protocol.js';
import {
  MANAGED_OPENVINO_STT_BASE_URL,
  MANAGED_OPENVINO_STT_WARM_URL,
  MANAGED_STREAM_STT_BASE_URL,
  getStreamSttHealthUrl,
  getStreamSttWsUrl,
} from './local-stt.js';
import {
  MANAGED_F5_TTS_BASE_URL,
  MANAGED_F5_TTS_DEFAULT_VOICE,
  MANAGED_F5_TTS_HEALTH_URL,
  MANAGED_F5_TTS_MODEL_NAME,
  MANAGED_F5_TTS_WARM_URL,
} from './local-tts.js';

export interface VoiceAudioInputBuffer {
  bytes: Buffer;
  contentType: string;
  sampleRateHz?: number;
  channels?: number;
}

export interface VoiceMediaProviderSettings {
  llmProvider: 'heuristic' | 'openai';
  llmModel: string;
  llmBaseUrl: string;
  llmApiKey: string;
  sttProvider: 'mock' | 'openai' | 'managed_openvino' | 'managed_stream';
  sttModel: string;
  sttBaseUrl: string;
  sttApiKey: string;
  sttStreamBaseUrl?: string;
  sttStreamSampleRateHz?: number;
  sttStreamEndpointSilenceMs?: number;
  ttsProvider: 'mock' | 'openai' | 'managed_f5_tts';
  ttsModel: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  defaultVoice: string;
  audioInputContentType: string;
  audioInputSampleRateHz: number;
  audioInputChannels: number;
  ttsResponseFormat: 'wav' | 'pcm' | 'mp3';
  ttsStreaming: boolean;
}

export interface VoiceSttInput {
  audio: VoiceAudioInputBuffer;
  caller: VoiceCaller;
  metadata: VoiceCallMetadata;
  signal: AbortSignal;
}

export interface VoiceSttResult {
  text: string;
  confidence?: number;
}

export interface VoiceTtsInput {
  text: string;
  voice: string;
  signal: AbortSignal;
  stream?: boolean;
  onAudioChunk?: (chunk: VoiceTtsChunk) => Promise<void> | void;
}

export interface VoiceTtsResult {
  audio: Buffer;
  contentType: string;
}

export interface VoiceTtsChunk {
  audio: Buffer;
  contentType: string;
  text?: string;
}

export interface VoiceSttProvider {
  readonly name: string;
  warm(): Promise<void>;
  transcribe(input: VoiceSttInput): Promise<VoiceSttResult>;
}

export interface VoiceStreamingSttHandlers {
  onReady?: () => void;
  onPartial?: (text: string, timestamp: string) => void;
  onFinal?: (text: string, timestamp: string, isEndpoint: boolean) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface VoiceStreamingSttSession {
  sendAudio(pcm: Buffer): void;
  flush(): void;
  end(): Promise<void>;
  readonly closed: boolean;
}

export interface VoiceStreamingSttProvider {
  readonly name: string;
  warm(): Promise<void>;
  start(handlers: VoiceStreamingSttHandlers): Promise<VoiceStreamingSttSession>;
}

export interface VoiceTtsProvider {
  readonly name: string;
  warm(): Promise<void>;
  synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult>;
}

function withNoTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function getWarmEndpoint(baseUrl: string): string {
  const trimmed = withNoTrailingSlash(baseUrl);
  return trimmed.endsWith('/v1')
    ? `${trimmed.slice(0, -3)}/warm`
    : `${trimmed}/warm`;
}

function getManagedTtsBaseUrl(baseUrl: string): string {
  const trimmed = withNoTrailingSlash(baseUrl.trim());
  if (!trimmed) return MANAGED_F5_TTS_BASE_URL;
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function getManagedTtsServerUrl(baseUrl: string): string {
  const trimmed = withNoTrailingSlash(baseUrl.trim());
  if (!trimmed) return MANAGED_F5_TTS_BASE_URL.replace(/\/v1$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

function guessFilename(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('wav')) return 'audio.wav';
  if (normalized.includes('webm')) return 'audio.webm';
  if (normalized.includes('mp4') || normalized.includes('m4a'))
    return 'audio.m4a';
  if (normalized.includes('mpeg') || normalized.includes('mp3'))
    return 'audio.mp3';
  return 'audio.bin';
}

function isSupportedSttUpload(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes('wav') ||
    normalized.includes('webm') ||
    normalized.includes('mpeg') ||
    normalized.includes('mp3') ||
    normalized.includes('mp4') ||
    normalized.includes('m4a')
  );
}

function encodeWavHeader(
  dataLength: number,
  sampleRateHz: number,
  channels: number,
): Buffer {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRateHz * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function toSupportedAudioUpload(
  input: VoiceAudioInputBuffer,
  defaults: VoiceMediaProviderSettings,
): { bytes: Buffer; contentType: string; filename: string } {
  if (isSupportedSttUpload(input.contentType)) {
    return {
      bytes: input.bytes,
      contentType: input.contentType,
      filename: guessFilename(input.contentType),
    };
  }

  const sampleRateHz = input.sampleRateHz || defaults.audioInputSampleRateHz;
  const channels = input.channels || defaults.audioInputChannels;
  const header = encodeWavHeader(input.bytes.length, sampleRateHz, channels);
  return {
    bytes: Buffer.concat([header, input.bytes]),
    contentType: 'audio/wav',
    filename: 'audio.wav',
  };
}

export class MockVoiceSttProvider implements VoiceSttProvider {
  readonly name = 'mock';

  async warm(): Promise<void> {
    return;
  }

  async transcribe(input: VoiceSttInput): Promise<VoiceSttResult> {
    const text = input.audio.bytes.toString('utf8').trim();
    return { text };
  }
}

export class OpenAiVoiceSttProvider implements VoiceSttProvider {
  readonly name = 'openai';

  constructor(private readonly settings: VoiceMediaProviderSettings) {}

  async warm(): Promise<void> {
    if (this.settings.sttProvider !== 'managed_openvino') {
      return;
    }

    const warmUrl = this.settings.sttBaseUrl.trim()
      ? getWarmEndpoint(this.settings.sttBaseUrl)
      : MANAGED_OPENVINO_STT_WARM_URL;
    const response = await fetch(warmUrl, {
      method: 'POST',
      headers: buildAuthHeaders(this.settings.sttApiKey),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`managed voice STT warmup failed (${response.status})`);
    }
  }

  async transcribe(input: VoiceSttInput): Promise<VoiceSttResult> {
    const upload = toSupportedAudioUpload(input.audio, this.settings);
    const body = new FormData();
    body.append('model', this.settings.sttModel);
    body.append(
      'file',
      new Blob([upload.bytes], { type: upload.contentType }),
      upload.filename,
    );

    const response = await fetch(
      `${withNoTrailingSlash(this.settings.sttBaseUrl)}/audio/transcriptions`,
      {
        method: 'POST',
        headers: buildAuthHeaders(this.settings.sttApiKey),
        body,
        signal: input.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`voice STT failed (${response.status})`);
    }

    const payload = (await response.json()) as
      | { text?: string; confidence?: number }
      | string;
    if (typeof payload === 'string') {
      return { text: payload.trim() };
    }
    return {
      text: String(payload.text || '').trim(),
      confidence:
        typeof payload.confidence === 'number' ? payload.confidence : undefined,
    };
  }
}

export class MockVoiceTtsProvider implements VoiceTtsProvider {
  readonly name = 'mock';

  async warm(): Promise<void> {
    return;
  }

  async synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    const result = {
      audio: Buffer.from(input.text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    };
    await input.onAudioChunk?.(result);
    return result;
  }
}

export class OpenAiVoiceTtsProvider implements VoiceTtsProvider {
  readonly name = 'openai';

  constructor(private readonly settings: VoiceMediaProviderSettings) {}

  async warm(): Promise<void> {
    return;
  }

  async synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    const response = await fetch(
      `${withNoTrailingSlash(this.settings.ttsBaseUrl)}/audio/speech`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(this.settings.ttsApiKey),
        },
        body: JSON.stringify({
          model: this.settings.ttsModel,
          voice: input.voice || this.settings.defaultVoice,
          input: input.text,
          response_format: this.settings.ttsResponseFormat,
        }),
        signal: input.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`voice TTS failed (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType =
      response.headers.get('content-type') ||
      (this.settings.ttsResponseFormat === 'pcm'
        ? 'audio/pcm'
        : this.settings.ttsResponseFormat === 'mp3'
          ? 'audio/mpeg'
          : 'audio/wav');
    const result = {
      audio: Buffer.from(arrayBuffer),
      contentType,
    };
    await input.onAudioChunk?.(result);
    return result;
  }
}

function encodeSseEvent(payload: string): string {
  return payload
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join('\n');
}

async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim();
        if (!data) continue;
        yield JSON.parse(data) as Record<string, unknown>;
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      const data = trailing
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (data) {
        yield JSON.parse(data) as Record<string, unknown>;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class ManagedF5VoiceTtsProvider implements VoiceTtsProvider {
  readonly name = 'managed_f5_tts';

  constructor(private readonly settings: VoiceMediaProviderSettings) {}

  async warm(): Promise<void> {
    const serverUrl = getManagedTtsServerUrl(this.settings.ttsBaseUrl);
    const response = await fetch(`${serverUrl}/warm`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`managed F5-TTS warmup failed (${response.status})`);
    }
  }

  async synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    const endpoint = `${getManagedTtsBaseUrl(this.settings.ttsBaseUrl)}/audio/speech`;
    const voice = (
      input.voice ||
      this.settings.defaultVoice ||
      MANAGED_F5_TTS_DEFAULT_VOICE
    ).trim();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MANAGED_F5_TTS_MODEL_NAME,
        input: input.text,
        voice,
        response_format: this.settings.ttsResponseFormat,
        stream: input.stream !== false,
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      throw new Error(`managed F5-TTS failed (${response.status})`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (
      contentType.includes('text/event-stream') &&
      response.body &&
      input.onAudioChunk
    ) {
      let firstChunk: VoiceTtsResult | null = null;
      for await (const event of readSseEvents(response.body)) {
        if (event.done === true) {
          break;
        }
        const dataBase64 =
          typeof event.audio_base64 === 'string' ? event.audio_base64 : '';
        if (!dataBase64) continue;
        const chunk: VoiceTtsResult = {
          audio: Buffer.from(dataBase64, 'base64'),
          contentType:
            typeof event.content_type === 'string'
              ? event.content_type
              : 'audio/wav',
        };
        firstChunk ||= chunk;
        await input.onAudioChunk({
          ...chunk,
          text: typeof event.text === 'string' ? event.text : undefined,
        });
      }
      return (
        firstChunk || {
          audio: Buffer.alloc(0),
          contentType: 'audio/wav',
        }
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: contentType || 'audio/wav',
    };
  }
}

// Strip a WAV RIFF header if present, returning raw PCM16LE bytes. If the
// buffer is already raw PCM (audio/l16, audio/pcm), passes through.
export function extractPcm16LE(
  bytes: Buffer,
  contentType?: string,
): Buffer | null {
  if (!bytes || bytes.length === 0) return Buffer.alloc(0);
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('pcm') || ct.includes('l16') || ct.includes('raw')) {
    return bytes;
  }
  if (ct.includes('wav') || (bytes.length >= 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF')) {
    // Seek to the "data" chunk. WAV header length varies with fmt extensions.
    if (bytes.length < 44) return null;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkId = bytes.slice(offset, offset + 4).toString('ascii');
      const chunkSize = bytes.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        const start = offset + 8;
        const end = Math.min(bytes.length, start + chunkSize);
        return bytes.slice(start, end);
      }
      offset += 8 + chunkSize;
    }
    return null;
  }
  // Encoded containers (WebM/Opus/Ogg/MP3/etc.) cannot be fed to a streaming
  // PCM socket. Return null so the caller knows to fall back to batch STT.
  if (
    ct.includes('webm') ||
    ct.includes('opus') ||
    ct.includes('ogg') ||
    ct.includes('mp3') ||
    ct.includes('mpeg') ||
    ct.includes('mp4') ||
    ct.includes('aac')
  ) {
    return null;
  }
  // Unknown container — pass through; caller can decide.
  return bytes;
}

export class ManagedStreamVoiceSttProvider
  implements VoiceStreamingSttProvider, VoiceSttProvider
{
  readonly name = 'managed_stream';

  constructor(private readonly settings: VoiceMediaProviderSettings) {}

  private getBaseUrl(): string {
    const base = (this.settings.sttStreamBaseUrl || '').trim();
    return base || MANAGED_STREAM_STT_BASE_URL;
  }

  async warm(): Promise<void> {
    const healthUrl = getStreamSttHealthUrl(this.getBaseUrl());
    const deadline = Date.now() + 60_000;
    let lastStatus: number | string = 'unreachable';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            ready?: boolean;
          };
          if (payload.ready !== false) return;
          lastStatus = 'not_ready';
        } else {
          lastStatus = res.status;
        }
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`streaming STT warmup failed (${lastStatus})`);
  }

  async transcribe(input: VoiceSttInput): Promise<VoiceSttResult> {
    // Non-streaming fallback path: open a WS, send the full buffer, flush,
    // wait for final. Used if the call site bypasses the streaming API.
    const pcm = extractPcm16LE(input.audio.bytes, input.audio.contentType);
    if (!pcm) return { text: '' };
    return await new Promise<VoiceSttResult>((resolve, reject) => {
      let settled = false;
      const safeResolve = (v: VoiceSttResult) => {
        if (settled) return;
        settled = true;
        try { session.end(); } catch { /* ignore */ }
        resolve(v);
      };
      const safeReject = (e: Error) => {
        if (settled) return;
        settled = true;
        try { session.end(); } catch { /* ignore */ }
        reject(e);
      };
      const onAbort = () => safeReject(new Error('aborted'));
      input.signal.addEventListener('abort', onAbort, { once: true });
      let session: VoiceStreamingSttSession;
      this.start({
        onReady: () => {
          session.sendAudio(pcm);
          session.flush();
        },
        onFinal: (text) => safeResolve({ text }),
        onError: (err) => safeReject(err),
        onClose: () => {
          if (!settled) safeResolve({ text: '' });
        },
      })
        .then((s) => {
          session = s;
        })
        .catch((err) => safeReject(err as Error));
    });
  }

  async start(
    handlers: VoiceStreamingSttHandlers,
  ): Promise<VoiceStreamingSttSession> {
    const wsUrl = getStreamSttWsUrl(this.getBaseUrl());
    const sampleRateHz = this.settings.sttStreamSampleRateHz || 16_000;
    const endpointSilenceMs = this.settings.sttStreamEndpointSilenceMs || 500;

    const socket = new WebSocket(wsUrl);
    let opened = false;
    let closed = false;

    const waitOpen = new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        opened = true;
        try {
          socket.send(
            JSON.stringify({
              type: 'start',
              sampleRateHz,
              endpointSilenceMs,
            }),
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve();
      };
      const onErr = () => {
        reject(new Error(`streaming STT websocket failed (${wsUrl})`));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onErr, { once: true });
    });

    socket.addEventListener('message', (event: { data: unknown }) => {
      const raw = event.data;
      if (typeof raw !== 'string') return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(payload.type || '');
      const ts =
        typeof payload.timestamp === 'string'
          ? payload.timestamp
          : new Date().toISOString();
      if (type === 'ready') {
        handlers.onReady?.();
      } else if (type === 'partial') {
        handlers.onPartial?.(String(payload.text || ''), ts);
      } else if (type === 'final') {
        handlers.onFinal?.(
          String(payload.text || ''),
          ts,
          Boolean(payload.isEndpoint),
        );
      } else if (type === 'error') {
        handlers.onError?.(
          new Error(String(payload.message || 'streaming STT error')),
        );
      }
    });

    socket.addEventListener('close', () => {
      closed = true;
      handlers.onClose?.();
    });
    socket.addEventListener('error', () => {
      if (!opened) return;
      handlers.onError?.(new Error('streaming STT websocket error'));
    });

    await waitOpen;

    return {
      get closed() {
        return closed || socket.readyState >= 2;
      },
      sendAudio: (pcm: Buffer) => {
        if (closed || socket.readyState !== 1 || !pcm || pcm.length === 0) {
          return;
        }
        // Use ArrayBuffer view so binary type is preserved by ws impls.
        const view = new Uint8Array(
          pcm.buffer,
          pcm.byteOffset,
          pcm.byteLength,
        );
        socket.send(view);
      },
      flush: () => {
        if (closed || socket.readyState !== 1) return;
        socket.send(JSON.stringify({ type: 'flush' }));
      },
      end: async () => {
        if (closed) return;
        try {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'end' }));
          }
        } catch {
          /* ignore */
        }
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        closed = true;
      },
    };
  }
}

export function buildVoiceStreamingSttProvider(
  settings: VoiceMediaProviderSettings,
): VoiceStreamingSttProvider | null {
  if (settings.sttProvider !== 'managed_stream') return null;
  return new ManagedStreamVoiceSttProvider(settings);
}

export function buildVoiceSttProvider(
  settings: VoiceMediaProviderSettings,
): VoiceSttProvider {
  if (settings.sttProvider === 'managed_stream') {
    return new ManagedStreamVoiceSttProvider(settings);
  }
  const wantsOpenAi =
    (settings.sttProvider === 'openai' ||
      settings.sttProvider === 'managed_openvino') &&
    settings.sttBaseUrl.trim() &&
    settings.sttModel.trim();
  if (!wantsOpenAi) {
    return new MockVoiceSttProvider();
  }

  const effectiveSettings =
    settings.sttProvider === 'managed_openvino'
      ? {
          ...settings,
          sttBaseUrl:
            settings.sttBaseUrl.trim() || MANAGED_OPENVINO_STT_BASE_URL,
        }
      : settings;
  return new OpenAiVoiceSttProvider(effectiveSettings);
}

export function buildVoiceTtsProvider(
  settings: VoiceMediaProviderSettings,
): VoiceTtsProvider {
  if (settings.ttsProvider === 'managed_f5_tts') {
    return new ManagedF5VoiceTtsProvider({
      ...settings,
      ttsBaseUrl:
        settings.ttsBaseUrl.trim() || MANAGED_F5_TTS_BASE_URL,
    });
  }
  const wantsOpenAi =
    settings.ttsProvider === 'openai' &&
    settings.ttsBaseUrl.trim() &&
    settings.ttsModel.trim();
  return wantsOpenAi
    ? new OpenAiVoiceTtsProvider(settings)
    : new MockVoiceTtsProvider();
}
