import {
  ASSISTANT_NAME,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
} from '../config.js';
import { createChildLogger } from '../logger.js';

import {
  buildVoiceSttProvider,
  buildVoiceTtsProvider,
  type VoiceMediaProviderSettings,
  type VoiceSttProvider,
  type VoiceTtsProvider,
} from './media-providers.js';
import {
  MANAGED_OPENVINO_STT_BASE_URL,
  MANAGED_OPENVINO_STT_MODEL,
} from './local-stt.js';
import type {
  VoiceActionRequest,
  VoiceAudioInputChunk,
  VoiceCallMetadata,
  VoiceCaller,
  VoiceHandoffRequest,
  VoiceLatencySample,
  VoiceResponseAudioDelta,
  VoiceResponseCancel,
  VoiceResponseTextDelta,
  VoiceRunnerCallbacks,
  VoiceRunnerHealth,
  VoiceRunnerSessionStart,
  VoiceRunnerSessionUpdate,
  VoiceTranscriptFinal,
  VoiceTranscriptPartial,
} from './protocol.js';

const log = createChildLogger({ subsystem: 'voice-runner' });
const DEFAULT_FILLERS = [
  'One moment while I line that up.',
  'Give me a second.',
  'I am on it.',
];
const MICRO_CONTEXT_LIMIT = 480;
const HISTORY_LIMIT = 6;
const TEXT_CHUNK_SIZE = 48;
const FILLER_DELAY_MS = 350;

interface VoiceRunnerSettings extends VoiceMediaProviderSettings {}

interface SessionHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

interface AudioInputState {
  chunks: Buffer[];
  contentType?: string;
  sampleRateHz?: number;
  channels?: number;
  speechDetectedAt?: string;
}

interface ActiveTranscription {
  controller: AbortController;
  speechDetectedAt?: string;
}

interface ActiveResponse {
  controller: AbortController;
  sequence: number;
  firstTextEmitted: boolean;
  firstAudioEmitted: boolean;
  textChunks: string[];
  fillerTimer: ReturnType<typeof setTimeout> | null;
  latency: VoiceLatencySample;
}

interface LiveSession {
  start: VoiceRunnerSessionStart;
  callbacks: VoiceRunnerCallbacks;
  caller: VoiceCaller;
  metadata: VoiceCallMetadata;
  history: SessionHistoryTurn[];
  activeResponse: ActiveResponse | null;
  activeTranscription: ActiveTranscription | null;
  partialText: string;
  sequence: number;
  audioInput: AudioInputState;
}

interface BackendGenerateInput {
  session: LiveSession;
  userText: string;
  signal: AbortSignal;
  emitTextDelta: (chunk: string) => Promise<void>;
}

interface BackendGenerateResult {
  text: string;
  actions?: Array<{
    action: VoiceActionRequest['action'];
    args?: Record<string, unknown>;
    reason?: string;
  }>;
  handoffs?: Array<{
    kind: VoiceHandoffRequest['kind'];
    summary: string;
    requestedAction?: string;
    priority?: VoiceHandoffRequest['priority'];
    contextSnippet?: string;
  }>;
}

interface VoiceRunnerBackend {
  readonly name: string;
  warm(): Promise<void>;
  generateTurn(input: BackendGenerateInput): Promise<BackendGenerateResult>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function chunkText(text: string, size: number = TEXT_CHUNK_SIZE): string[] {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > size) {
    let splitAt = remaining.lastIndexOf(' ', size);
    if (splitAt <= 0) splitAt = size;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capMicroContext(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MICRO_CONTEXT_LIMIT
    ? `${trimmed.slice(0, MICRO_CONTEXT_LIMIT - 3)}...`
    : trimmed;
}

function inferHeuristicResponse(
  userText: string,
): Omit<BackendGenerateResult, 'text'> & { text: string } {
  const compact = userText.trim().replace(/\s+/g, ' ');
  if (!compact) {
    return { text: 'I did not catch that. Could you say it one more time?' };
  }

  const dtmfMatch =
    compact.match(/(?:send tones?|dtmf)\s*([0-9#*]+)/i) ??
    compact.match(/\btones?\s+([0-9#*]+)/i);
  if (dtmfMatch?.[1]) {
    return {
      text: `Sending those tones now: ${dtmfMatch[1]}.`,
      actions: [
        {
          action: 'send_dtmf',
          args: { digits: dtmfMatch[1] },
          reason: 'Caller requested DTMF tones during the call',
        },
      ],
    };
  }

  if (/\b(mute me|mute the line|go mute)\b/i.test(compact)) {
    return {
      text: 'Muting the line now.',
      actions: [
        {
          action: 'set_mute',
          args: { muted: true },
          reason: 'Caller requested the line be muted',
        },
      ],
    };
  }

  if (/\b(unmute me|take me off mute)\b/i.test(compact)) {
    return {
      text: 'Unmuting now.',
      actions: [
        {
          action: 'set_mute',
          args: { muted: false },
          reason: 'Caller requested unmute',
        },
      ],
    };
  }

  if (/\b(hang up|end the call|goodbye now)\b/i.test(compact)) {
    return {
      text: 'Okay, ending the call now.',
      actions: [
        {
          action: 'end_call',
          reason: 'Caller asked to end the call',
        },
      ],
    };
  }

  if (
    /\b(follow up|email me later|text me later|send me details later|remind me)\b/i.test(
      compact,
    )
  ) {
    return {
      text: 'I will handle that right after we finish here.',
      handoffs: [
        {
          kind: 'followup_summary',
          summary: compact,
          requestedAction: 'Create a post-call follow-up for the caller',
          priority: 'normal',
          contextSnippet: compact,
        },
      ],
    };
  }

  if (compact.length > 220) {
    return {
      text: 'I have the gist. I will keep this call moving and hand the deeper follow-up to the main system right after.',
      handoffs: [
        {
          kind: 'task_request',
          summary: compact,
          requestedAction: 'Review the caller request in depth after the call',
          priority: 'high',
          contextSnippet: compact.slice(0, MICRO_CONTEXT_LIMIT),
        },
      ],
    };
  }

  return {
    text: `I heard you say: ${compact}. What is the next thing you want me to handle?`,
  };
}

class HeuristicVoiceBackend implements VoiceRunnerBackend {
  readonly name = 'heuristic';

  async warm(): Promise<void> {
    return;
  }

  async generateTurn(
    input: BackendGenerateInput,
  ): Promise<BackendGenerateResult> {
    const result = inferHeuristicResponse(input.userText);
    for (const chunk of chunkText(result.text)) {
      input.signal.throwIfAborted();
      await input.emitTextDelta(chunk);
      await wait(5);
    }
    return result;
  }
}

class OpenAiVoiceBackend implements VoiceRunnerBackend {
  readonly name = 'openai';

  constructor(private readonly settings: VoiceRunnerSettings) {}

  async warm(): Promise<void> {
    return;
  }

  async generateTurn(
    input: BackendGenerateInput,
  ): Promise<BackendGenerateResult> {
    const prompt = buildMicroPrompt(input.session, input.userText);
    const response = await fetch(
      `${this.settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.llmApiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.llmModel,
          temperature: 0.2,
          max_tokens: 160,
          messages: [
            {
              role: 'system',
              content:
                'You are a low-latency phone-call assistant. Keep replies short, spoken, and interruption-friendly. Never claim to browse files or use broad tools. If a request needs deep work, briefly acknowledge it and keep the call moving.',
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: input.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`voice runner backend failed (${response.status})`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text =
      payload.choices?.[0]?.message?.content?.trim() ||
      inferHeuristicResponse(input.userText).text;
    for (const chunk of chunkText(text)) {
      input.signal.throwIfAborted();
      await input.emitTextDelta(chunk);
      await wait(5);
    }
    const heuristic = inferHeuristicResponse(input.userText);
    return {
      text,
      actions: heuristic.actions,
      handoffs: heuristic.handoffs,
    };
  }
}

function buildMicroPrompt(session: LiveSession, userText: string): string {
  return [
    `Assistant: ${ASSISTANT_NAME}`,
    `Caller: ${session.caller.displayName} (${session.caller.phoneNumber})`,
    session.caller.profileSummary
      ? `Profile: ${capMicroContext(session.caller.profileSummary)}`
      : '',
    session.caller.relationshipHint
      ? `Hint: ${capMicroContext(session.caller.relationshipHint)}`
      : '',
    `Call state: ${session.metadata.state || 'active'}`,
    'Recent turns:',
    ...session.history
      .slice(-HISTORY_LIMIT)
      .map(
        (turn) =>
          `${turn.role === 'user' ? 'Caller' : ASSISTANT_NAME}: ${turn.text}`,
      ),
    `Caller now: ${userText}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildBackend(settings: VoiceRunnerSettings): VoiceRunnerBackend {
  const wantsOpenAi =
    settings.llmProvider === 'openai' &&
    settings.llmBaseUrl.trim() &&
    settings.llmModel.trim() &&
    settings.llmApiKey.trim();
  return wantsOpenAi
    ? new OpenAiVoiceBackend(settings)
    : new HeuristicVoiceBackend();
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function settingsFromRecord(
  settings?: Record<string, unknown>,
): VoiceRunnerSettings {
  const sharedProvider = String(settings?.voiceRunnerProvider || '').trim();
  const sharedApiKey = String(
    settings?.voiceRunnerApiKey || OPENAI_API_KEY || '',
  ).trim();
  const sharedBaseUrl = String(
    settings?.voiceRunnerBaseUrl || OPENAI_BASE_URL || '',
  ).trim();
  const sharedModel = String(
    settings?.voiceRunnerModel || OPENAI_MODEL || '',
  ).trim();

  const llmProvider = sharedProvider === 'openai' ? 'openai' : 'heuristic';
  const defaultMediaProvider = llmProvider === 'openai' ? 'openai' : 'mock';
  const sttProviderRaw = String(
    settings?.voiceSttProvider || defaultMediaProvider,
  ).trim();
  const ttsProviderRaw = String(
    settings?.voiceTtsProvider || defaultMediaProvider,
  ).trim();
  const ttsFormatRaw = String(settings?.voiceTtsResponseFormat || 'wav').trim();

  return {
    llmProvider,
    llmModel: sharedModel || OPENAI_MODEL,
    llmBaseUrl: sharedBaseUrl || OPENAI_BASE_URL,
    llmApiKey: sharedApiKey,
    sttProvider:
      sttProviderRaw === 'managed_openvino'
        ? 'managed_openvino'
        : sttProviderRaw === 'openai'
          ? 'openai'
          : 'mock',
    sttModel: String(
      settings?.voiceSttModel || MANAGED_OPENVINO_STT_MODEL,
    ).trim(),
    sttBaseUrl: String(
      sttProviderRaw === 'managed_openvino'
        ? MANAGED_OPENVINO_STT_BASE_URL
        : settings?.voiceSttBaseUrl || sharedBaseUrl || OPENAI_BASE_URL,
    ).trim(),
    sttApiKey: String(
      settings?.voiceSttApiKey || sharedApiKey || OPENAI_API_KEY || '',
    ).trim(),
    ttsProvider: ttsProviderRaw === 'openai' ? 'openai' : 'mock',
    ttsModel: String(settings?.voiceTtsModel || 'gpt-4o-mini-tts').trim(),
    ttsBaseUrl: String(
      settings?.voiceTtsBaseUrl || sharedBaseUrl || OPENAI_BASE_URL,
    ).trim(),
    ttsApiKey: String(
      settings?.voiceTtsApiKey || sharedApiKey || OPENAI_API_KEY || '',
    ).trim(),
    defaultVoice: String(settings?.defaultVoice || 'alloy').trim() || 'alloy',
    audioInputContentType:
      String(settings?.voiceAudioInputContentType || 'audio/wav').trim() ||
      'audio/wav',
    audioInputSampleRateHz: parsePositiveInteger(
      settings?.voiceAudioSampleRateHz,
      16_000,
    ),
    audioInputChannels: parsePositiveInteger(settings?.voiceAudioChannels, 1),
    ttsResponseFormat:
      ttsFormatRaw === 'pcm' || ttsFormatRaw === 'mp3' ? ttsFormatRaw : 'wav',
  };
}

export class VoiceRunnerService {
  private settings: VoiceRunnerSettings;
  private backend: VoiceRunnerBackend;
  private sttProvider: VoiceSttProvider;
  private ttsProvider: VoiceTtsProvider;
  private warmedAt?: string;
  private readonly sessions = new Map<string, LiveSession>();

  constructor(initialSettings?: Record<string, unknown>) {
    this.settings = settingsFromRecord(initialSettings);
    this.backend = buildBackend(this.settings);
    this.sttProvider = buildVoiceSttProvider(this.settings);
    this.ttsProvider = buildVoiceTtsProvider(this.settings);
  }

  configure(settings: Record<string, unknown>): void {
    const next = settingsFromRecord(settings);
    const providersChanged =
      JSON.stringify(next) !== JSON.stringify(this.settings);
    this.settings = next;
    if (providersChanged) {
      this.backend = buildBackend(next);
      this.sttProvider = buildVoiceSttProvider(next);
      this.ttsProvider = buildVoiceTtsProvider(next);
      this.warmedAt = undefined;
    }
  }

  async warm(): Promise<void> {
    if (this.warmedAt) return;
    await Promise.all([
      this.backend.warm(),
      this.sttProvider.warm(),
      this.ttsProvider.warm(),
    ]);
    this.warmedAt = nowIso();
  }

  getHealth(): VoiceRunnerHealth {
    return {
      ready: Boolean(this.warmedAt),
      sessions: this.sessions.size,
      backend: `${this.backend.name};stt:${this.sttProvider.name};tts:${this.ttsProvider.name}`,
      warmedAt: this.warmedAt,
    };
  }

  async startSession(
    input: VoiceRunnerSessionStart,
    callbacks: VoiceRunnerCallbacks = {},
  ): Promise<void> {
    await this.warm();
    await this.endSession(input.sessionId);
    const session: LiveSession = {
      start: input,
      callbacks,
      caller: { ...input.caller },
      metadata: { ...input.metadata },
      history: [],
      activeResponse: null,
      activeTranscription: null,
      partialText: '',
      sequence: 0,
      audioInput: { chunks: [] },
    };
    this.sessions.set(input.sessionId, session);
    if (input.greeting?.trim()) {
      await this.emitFixedResponse(input.sessionId, input.greeting);
    }
  }

  async updateSession(input: VoiceRunnerSessionUpdate): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    if (input.metadata) {
      session.metadata = { ...session.metadata, ...input.metadata };
    }
    if (input.caller) {
      session.caller = { ...session.caller, ...input.caller };
    }
  }

  async handleAudioInput(event: VoiceAudioInputChunk): Promise<void> {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    const chunk = Buffer.from(event.dataBase64 || '', 'base64');
    if (session.activeResponse) {
      this.cancelActiveResponse(session, 'barge_in', event.timestamp);
    }
    if (!session.audioInput.speechDetectedAt) {
      session.audioInput.speechDetectedAt = event.timestamp;
    }
    session.audioInput.contentType =
      event.contentType ||
      session.audioInput.contentType ||
      this.settings.audioInputContentType;
    session.audioInput.sampleRateHz =
      event.sampleRateHz ||
      session.audioInput.sampleRateHz ||
      this.settings.audioInputSampleRateHz;
    session.audioInput.channels =
      event.channels ||
      session.audioInput.channels ||
      this.settings.audioInputChannels;
    if (chunk.length > 0) {
      session.audioInput.chunks.push(chunk);
    }
    if (event.endOfTurn) {
      await this.flushAudioInput(session, event.timestamp);
    }
  }

  handleTranscriptPartial(event: VoiceTranscriptPartial): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    session.partialText = event.text;
    if (session.activeResponse) {
      this.cancelActiveResponse(session, 'barge_in', event.timestamp);
    }
    session.callbacks.onTranscriptPartial?.(event);
  }

  async handleTranscriptFinal(event: VoiceTranscriptFinal): Promise<void> {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    await this.processTranscriptFinal(session, {
      ...event,
      source: event.source || 'gateway',
    });
  }

  async emitFixedResponse(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const timestamp = nowIso();
    const safeText = text.trim();
    if (!safeText) return;
    const active: ActiveResponse = {
      controller: new AbortController(),
      sequence: ++session.sequence,
      firstTextEmitted: false,
      firstAudioEmitted: false,
      textChunks: [],
      fillerTimer: null,
      latency: {
        sessionId,
        firstModelTextAt: timestamp,
      },
    };
    session.activeResponse = active;
    for (const chunk of chunkText(safeText)) {
      await this.emitResponseText(session, active, chunk);
    }
    session.history.push({ role: 'assistant', text: safeText, timestamp });
    session.history = session.history.slice(-HISTORY_LIMIT);
    active.latency.responseCompletedAt = timestamp;
    session.callbacks.onLatencySample?.(active.latency);
    if (session.callbacks.onFinalizedAgentTurn) {
      await session.callbacks.onFinalizedAgentTurn({
        sessionId,
        text: safeText,
        timestamp,
      });
    }
    session.activeResponse = null;
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeResponse) {
      this.cancelActiveResponse(session, 'session_end', nowIso());
    }
    if (session.activeTranscription) {
      session.activeTranscription.controller.abort();
      session.activeTranscription = null;
    }
    this.sessions.delete(sessionId);
  }

  async waitForIdle(sessionId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const session = this.sessions.get(sessionId);
      if (!session?.activeResponse && !session?.activeTranscription) return;
      await wait(10);
    }
  }

  private async flushAudioInput(
    session: LiveSession,
    timestamp: string,
  ): Promise<void> {
    const bytes = Buffer.concat(session.audioInput.chunks);
    const contentType =
      session.audioInput.contentType || this.settings.audioInputContentType;
    const sampleRateHz =
      session.audioInput.sampleRateHz || this.settings.audioInputSampleRateHz;
    const channels =
      session.audioInput.channels || this.settings.audioInputChannels;
    const speechDetectedAt = session.audioInput.speechDetectedAt;
    session.audioInput = { chunks: [] };
    if (!bytes.length) return;

    if (session.activeTranscription) {
      session.activeTranscription.controller.abort();
    }
    const activeTranscription: ActiveTranscription = {
      controller: new AbortController(),
      speechDetectedAt,
    };
    session.activeTranscription = activeTranscription;

    try {
      const transcript = await this.sttProvider.transcribe({
        audio: {
          bytes,
          contentType,
          sampleRateHz,
          channels,
        },
        caller: session.caller,
        metadata: session.metadata,
        signal: activeTranscription.controller.signal,
      });
      if (session.activeTranscription !== activeTranscription) return;
      await this.processTranscriptFinal(
        session,
        {
          sessionId: session.start.sessionId,
          text: transcript.text,
          timestamp,
          confidence: transcript.confidence,
          source: 'stt',
        },
        speechDetectedAt,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || /abort/i.test(err.message))
      ) {
        return;
      }
      log.warn(
        { err, sessionId: session.start.sessionId },
        'Voice STT degraded during transcription',
      );
      await this.emitFixedResponse(
        session.start.sessionId,
        'I hit an audio hiccup on my side. Could you say that again?',
      );
    } finally {
      if (session.activeTranscription === activeTranscription) {
        session.activeTranscription = null;
      }
    }
  }

  private async processTranscriptFinal(
    session: LiveSession,
    event: VoiceTranscriptFinal,
    speechDetectedAt?: string,
  ): Promise<void> {
    if (session.activeResponse) {
      this.cancelActiveResponse(session, 'restart', event.timestamp);
    }

    const text = event.text.trim();
    session.partialText = '';
    if (!text) return;

    const finalEvent: VoiceTranscriptFinal = {
      ...event,
      text,
      source: event.source || 'gateway',
    };
    if (session.callbacks.onTranscriptFinal) {
      await session.callbacks.onTranscriptFinal(finalEvent);
    }

    session.history.push({
      role: 'user',
      text,
      timestamp: event.timestamp,
    });
    session.history = session.history.slice(-HISTORY_LIMIT);

    if (typeof event.confidence === 'number' && event.confidence < 0.45) {
      await this.emitFixedResponse(
        session.start.sessionId,
        'I did not quite catch that. Could you say it one more time?',
      );
      return;
    }

    const active: ActiveResponse = {
      controller: new AbortController(),
      sequence: ++session.sequence,
      firstTextEmitted: false,
      firstAudioEmitted: false,
      textChunks: [],
      fillerTimer: null,
      latency: {
        sessionId: session.start.sessionId,
        speechDetectedAt,
        userSpeechFinalAt: event.timestamp,
      },
    };
    session.activeResponse = active;
    active.fillerTimer = setTimeout(() => {
      if (session.activeResponse?.sequence !== active.sequence) return;
      if (active.firstTextEmitted) return;
      const filler =
        DEFAULT_FILLERS[active.sequence % DEFAULT_FILLERS.length] ||
        DEFAULT_FILLERS[0];
      this.emitResponseText(session, active, filler).catch((err) =>
        log.debug({ err, sessionId: session.start.sessionId }, 'Filler failed'),
      );
    }, FILLER_DELAY_MS);

    const emitTextDelta = async (chunk: string): Promise<void> => {
      await this.emitResponseText(session, active, chunk);
    };

    try {
      const result = await this.backend.generateTurn({
        session,
        userText: text,
        signal: active.controller.signal,
        emitTextDelta,
      });
      if (session.activeResponse?.sequence !== active.sequence) return;

      for (const request of result.actions || []) {
        if (session.callbacks.onActionRequest) {
          await session.callbacks.onActionRequest({
            sessionId: session.start.sessionId,
            action: request.action,
            args: request.args,
            reason: request.reason,
            timestamp: nowIso(),
          });
        }
      }
      for (const handoff of result.handoffs || []) {
        if (session.callbacks.onHandoffEnqueue) {
          await session.callbacks.onHandoffEnqueue({
            id: crypto.randomUUID(),
            kind: handoff.kind,
            caller: { ...session.caller },
            sessionId: session.start.sessionId,
            summary: handoff.summary,
            requestedAction: handoff.requestedAction,
            priority: handoff.priority || 'normal',
            contextSnippet: handoff.contextSnippet,
            createdAt: nowIso(),
          });
        }
      }

      const finalizedText =
        active.textChunks.join(' ').trim() || result.text.trim();
      if (finalizedText) {
        const completedAt = nowIso();
        session.history.push({
          role: 'assistant',
          text: finalizedText,
          timestamp: completedAt,
        });
        session.history = session.history.slice(-HISTORY_LIMIT);
        active.latency.responseCompletedAt = completedAt;
        session.callbacks.onLatencySample?.(active.latency);
        if (session.callbacks.onFinalizedAgentTurn) {
          await session.callbacks.onFinalizedAgentTurn({
            sessionId: session.start.sessionId,
            text: finalizedText,
            timestamp: completedAt,
          });
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || /abort/i.test(err.message))
      ) {
        return;
      }
      log.warn(
        { err, sessionId: session.start.sessionId },
        'Voice runner degraded during response generation',
      );
      await this.emitFixedResponse(
        session.start.sessionId,
        'I hit a delay on my side. I can keep the call moving, and I will follow up after this if needed.',
      );
    } finally {
      if (active.fillerTimer) clearTimeout(active.fillerTimer);
      if (session.activeResponse?.sequence === active.sequence) {
        session.activeResponse = null;
      }
    }
  }

  private async emitResponseText(
    session: LiveSession,
    active: ActiveResponse,
    chunk: string,
  ): Promise<void> {
    const clean = chunk.trim();
    if (!clean) return;
    const timestamp = nowIso();
    active.textChunks.push(clean);
    if (!active.firstTextEmitted) {
      active.firstTextEmitted = true;
      active.latency.firstModelTextAt = timestamp;
    }
    const textEvent: VoiceResponseTextDelta = {
      sessionId: session.start.sessionId,
      text: clean,
      timestamp,
    };
    session.callbacks.onResponseTextDelta?.(textEvent);

    const synthesized = await this.ttsProvider.synthesize({
      text: clean,
      voice: this.settings.defaultVoice,
      signal: active.controller.signal,
    });
    const audioEvent: VoiceResponseAudioDelta = {
      sessionId: session.start.sessionId,
      dataBase64: synthesized.audio.toString('base64'),
      contentType: synthesized.contentType,
      text: clean,
      timestamp,
    };
    if (!active.firstAudioEmitted) {
      active.firstAudioEmitted = true;
      active.latency.firstAudioOutAt = nowIso();
    }
    session.callbacks.onResponseAudioDelta?.(audioEvent);
  }

  private cancelActiveResponse(
    session: LiveSession,
    reason: VoiceResponseCancel['reason'],
    timestamp: string,
  ): void {
    const active = session.activeResponse;
    if (!active) return;
    if (active.fillerTimer) clearTimeout(active.fillerTimer);
    active.controller.abort();
    active.latency.responseCancelledAt = timestamp;
    session.callbacks.onLatencySample?.(active.latency);
    session.callbacks.onResponseCancel?.({
      sessionId: session.start.sessionId,
      reason,
      timestamp,
    });
    session.activeResponse = null;
  }
}

let singleton: VoiceRunnerService | null = null;

export function getVoiceRunnerService(
  settings?: Record<string, unknown>,
): VoiceRunnerService {
  if (!singleton) {
    singleton = new VoiceRunnerService(settings);
  } else if (settings) {
    singleton.configure(settings);
  }
  return singleton;
}
