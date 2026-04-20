import type { VoiceCallMetadata, VoiceCaller } from './protocol.js';
import {
  MANAGED_OPENVINO_STT_BASE_URL,
  MANAGED_OPENVINO_STT_WARM_URL,
} from './local-stt.js';

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
  sttProvider: 'mock' | 'openai' | 'managed_openvino';
  sttModel: string;
  sttBaseUrl: string;
  sttApiKey: string;
  ttsProvider: 'mock' | 'openai';
  ttsModel: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  defaultVoice: string;
  audioInputContentType: string;
  audioInputSampleRateHz: number;
  audioInputChannels: number;
  ttsResponseFormat: 'wav' | 'pcm' | 'mp3';
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
}

export interface VoiceTtsResult {
  audio: Buffer;
  contentType: string;
}

export interface VoiceSttProvider {
  readonly name: string;
  warm(): Promise<void>;
  transcribe(input: VoiceSttInput): Promise<VoiceSttResult>;
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
    return {
      audio: Buffer.from(input.text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    };
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
          Authorization: `Bearer ${this.settings.ttsApiKey}`,
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
    return {
      audio: Buffer.from(arrayBuffer),
      contentType,
    };
  }
}

export function buildVoiceSttProvider(
  settings: VoiceMediaProviderSettings,
): VoiceSttProvider {
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
  const wantsOpenAi =
    settings.ttsProvider === 'openai' &&
    settings.ttsApiKey.trim() &&
    settings.ttsBaseUrl.trim() &&
    settings.ttsModel.trim();
  return wantsOpenAi
    ? new OpenAiVoiceTtsProvider(settings)
    : new MockVoiceTtsProvider();
}
