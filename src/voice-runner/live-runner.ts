import {
  ASSISTANT_NAME,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
} from '../config.js';
import { createChildLogger } from '../logger.js';

import {
  buildVoiceSttProvider,
  buildVoiceStreamingSttProvider,
  buildVoiceTtsProvider,
  extractPcm16LE,
  type VoiceMediaProviderSettings,
  type VoiceSttProvider,
  type VoiceStreamingSttProvider,
  type VoiceStreamingSttSession,
  type VoiceTtsProvider,
} from './media-providers.js';
import {
  MANAGED_OPENVINO_STT_BASE_URL,
  MANAGED_OPENVINO_STT_MODEL,
  MANAGED_STREAM_STT_BASE_URL,
} from './local-stt.js';
import {
  MANAGED_F5_TTS_BASE_URL,
  MANAGED_F5_TTS_DEFAULT_VOICE,
  MANAGED_F5_TTS_MODEL,
} from './local-tts.js';
import {
  MANAGED_OPENARC_LLM_API_KEY,
  MANAGED_OPENARC_LLM_BASE_URL,
  MANAGED_OPENARC_LLM_MODEL,
  usesManagedOpenArcLlm,
} from './local-llm.js';
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
// Summary now covers older turns, so more recent turns verbatim is affordable.
const HISTORY_LIMIT = 6;
// Keep older turns around so the background digest can reference them. The
// LLM message builder still only sends HISTORY_LIMIT recent verbatim turns.
const HISTORY_RETENTION_LIMIT = 60;
const SUMMARY_THRESHOLD_TURNS = 6;
const SUMMARY_RECENT_TAIL = 4;
const DIGEST_TIMEOUT_MS = 10_000;
const DIGEST_MAX_TOKENS = 300;
const TEXT_CHUNK_SIZE = 240;
const FILLER_DELAY_MS = 150;
const DEFAULT_LLM_SYSTEM_PROMPT =
  'You are a low-latency phone-call assistant. Keep replies short, spoken, and interruption-friendly. Never claim to browse files or use broad tools. If a request needs deep work, briefly acknowledge it and keep the call moving.';
const DEFAULT_LLM_INSTRUCTIONS = [
  'Sound natural and concise. Prefer one short sentence unless the caller clearly asks for detail. Ask at most one brief clarification question when needed.',
  'If the transcript is a single short word, garbled, or clearly an STT artifact ("you", "thank you", filler), ask for clarification in one short sentence instead of guessing.',
  'What you can do on this call: schedule follow-ups for after the call, hand off a summary to the main system for deep work, take a message, end the call. What you cannot do mid-call: browse the web, read files, run code, or look things up in real time.',
  'Output plain spoken prose. No markdown, no bullets, no URLs, no code blocks. Spell out numbers when ambiguous.',
].join(' ');
const DIGEST_SYSTEM_PROMPT =
  'You are a note-taker. In 1–2 sentences, summarize what the caller and assistant have already discussed. Focus on decisions, promises, and unresolved questions. Plain text, no bullets.';
const DIGEST_STATE_SYSTEM_PROMPT =
  'You are a note-taker for a live phone call. Return a single JSON object with keys: summary (string, 1-2 sentences), intent (string, <=8 words), promisedActions (string[]), openQuestions (string[]), mood (string, 1-3 words). No prose outside the JSON. No markdown fences.';
const LLM_INSTRUCTION_LIMIT = 2_000;
const LLM_FILLERS_LIMIT = 8;
const LLM_FILLER_LIMIT = 80;

interface VoiceRunnerSettings extends VoiceMediaProviderSettings {
  llmSystemPrompt: string;
  llmInstructions: string;
  llmFillersEnabled: boolean;
  llmFillers: string[];
}

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
  // Tail of the ordered playback chain; callers chain onto this so audio from
  // chunk N+1 only dispatches after chunk N's audio has been delivered, even
  // though synthesis for N+1 is kicked off eagerly while N is still playing.
  playbackTail: Promise<void>;
}

interface PrefillState {
  controller: AbortController | null;
  lastText: string;
  lastFiredAt: number;
}

interface CallState {
  intent: string;
  promisedActions: string[];
  openQuestions: string[];
  mood: string;
}

interface InterruptionMarker {
  spokenSoFar: string;
  timestamp: string;
}

interface BargeInCandidate {
  text: string;
  at: number;
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
  streamingStt: VoiceStreamingSttSession | null;
  streamingSttFailed: boolean;
  streamingFinalHandled: boolean;
  prefill: PrefillState;
  callerProfile: string;
  callSummary: string;
  callState: CallState;
  lastInterruption: InterruptionMarker | null;
  summaryInFlight: boolean;
  bargeInCandidate: BargeInCandidate | null;
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

interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface VoiceRunnerBackend {
  readonly name: string;
  warm(): Promise<void>;
  generateTurn(input: BackendGenerateInput): Promise<BackendGenerateResult>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function splitIntoSpeakableUnits(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const { phrases, remaining } = splitReadyVoicePhrases(trimmed, true);
  if (remaining.trim()) phrases.push(remaining.trim());
  return phrases.length ? phrases : [trimmed];
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

async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let splitAt = buffer.indexOf('\n\n');
    while (splitAt >= 0) {
      const rawEvent = buffer.slice(0, splitAt).trim();
      buffer = buffer.slice(splitAt + 2);
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
      }
      splitAt = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.trim().split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        yield line.slice(5).trim();
      }
    }
  }
}

function splitReadyVoicePhrases(
  buffer: string,
  force = false,
): { phrases: string[]; remaining: string } {
  let remaining = buffer.replace(/\s+/g, ' ');
  const phrases: string[] = [];

  while (remaining.trim()) {
    const punct = remaining.search(/[.!?]\s+/);
    if (punct >= 0) {
      const phrase = remaining.slice(0, punct + 1).trim();
      if (phrase) phrases.push(phrase);
      remaining = remaining.slice(punct + 1).trimStart();
      continue;
    }

    if (remaining.length >= 90) {
      const splitAt = Math.max(
        remaining.lastIndexOf(',', 90),
        remaining.lastIndexOf(';', 90),
        remaining.lastIndexOf(':', 90),
        remaining.lastIndexOf(' ', 90),
      );
      if (splitAt > 24) {
        const phrase = remaining.slice(0, splitAt + 1).trim();
        if (phrase) phrases.push(phrase);
        remaining = remaining.slice(splitAt + 1).trimStart();
        continue;
      }
    }

    if (force) {
      const phrase = remaining.trim();
      if (phrase) phrases.push(phrase);
      remaining = '';
    }
    break;
  }

  return { phrases, remaining };
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
    const speakable = result.text.trim();
    if (speakable) {
      input.signal.throwIfAborted();
      await input.emitTextDelta(speakable);
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
    const requestBody: Record<string, unknown> = {
      model: this.settings.llmModel,
      temperature: 0.2,
      max_tokens: 160,
      stream: true,
      messages: buildLlmMessages(input.session, input.userText, this.settings),
    };
    if (shouldDisableThinking(this.settings.llmModel)) {
      requestBody.chat_template_kwargs = { enable_thinking: false };
    }
    const response = await fetch(
      `${this.settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.settings.llmApiKey.trim()
            ? { Authorization: `Bearer ${this.settings.llmApiKey}` }
            : {}),
        },
        body: JSON.stringify(requestBody),
        signal: input.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`voice runner backend failed (${response.status})`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (response.body && contentType.includes('text/event-stream')) {
      let text = '';
      let rawText = '';
      let pendingPhrase = '';
      let firstEmitted = false;
      const tail: string[] = [];
      const thinkFilter = shouldDisableThinking(this.settings.llmModel)
        ? createThinkFilter()
        : null;
      const filterDelta = (d: string): string =>
        thinkFilter ? thinkFilter.push(d) : d;
      const flushFilter = (): string =>
        thinkFilter ? thinkFilter.flush() : '';
      const enqueue = async (phrase: string): Promise<void> => {
        if (!firstEmitted) {
          firstEmitted = true;
          await input.emitTextDelta(phrase);
        } else {
          tail.push(phrase);
        }
      };
      for await (const data of readSseData(response.body)) {
        input.signal.throwIfAborted();
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const rawDelta = event.choices?.[0]?.delta?.content || '';
        if (!rawDelta) continue;
        rawText += rawDelta;
        const delta = filterDelta(rawDelta);
        if (!delta) continue;
        text += delta;
        pendingPhrase += delta;
        const split = splitReadyVoicePhrases(pendingPhrase);
        pendingPhrase = split.remaining;
        for (const phrase of split.phrases) {
          input.signal.throwIfAborted();
          await enqueue(phrase);
        }
      }
      const tailFlush = flushFilter();
      if (tailFlush) {
        text += tailFlush;
        pendingPhrase += tailFlush;
      }
      const finalSplit = splitReadyVoicePhrases(pendingPhrase, true);
      for (const phrase of finalSplit.phrases) {
        input.signal.throwIfAborted();
        await enqueue(phrase);
      }
      if (tail.length > 0) {
        input.signal.throwIfAborted();
        await input.emitTextDelta(tail.join(' '));
      }
      log.info(
        {
          sessionId: input.session.start.sessionId,
          rawLen: rawText.length,
          emittedLen: text.length,
          rawTail: rawText.slice(-80),
        },
        'LLM stream ended',
      );
      const sideEffects = inferHeuristicResponse(input.userText);
      return {
        text: text.trim(),
        actions: sideEffects.actions,
        handoffs: sideEffects.handoffs,
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = payload.choices?.[0]?.message?.content?.trim() || '';
    const text = shouldDisableThinking(this.settings.llmModel)
      ? rawText.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()
      : rawText;
    if (text) {
      input.signal.throwIfAborted();
      await input.emitTextDelta(text);
    }
    const sideEffects = inferHeuristicResponse(input.userText);
    return {
      text,
      actions: sideEffects.actions,
      handoffs: sideEffects.handoffs,
    };
  }
}

function shouldDisableThinking(model: string): boolean {
  return /\bqwen/i.test(model);
}

// Whisper is trained on data where narrators say "you", "thank you",
// "thanks for watching" etc. at the end of clips. On silence or low-SNR
// audio it emits these as confident transcripts. We drop them to prevent
// bogus LLM turns.
const WHISPER_HALLUCINATIONS = new Set([
  'you',
  'you.',
  'thank you',
  'thank you.',
  'thanks',
  'thanks.',
  'thanks for watching',
  'thanks for watching.',
  'thanks for watching!',
  'bye',
  'bye.',
  'bye!',
  'mm',
  'mm.',
  'mm-hmm',
  'mm-hmm.',
  'uh',
  'um',
  '.',
  '...',
  'okay',
  'okay.',
  'ok',
  'ok.',
]);

function isLikelyWhisperHallucination(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 40) return false;
  return WHISPER_HALLUCINATIONS.has(normalized);
}

// Streaming filter that removes <think>...</think> blocks from an LLM token
// stream. Tokens inside thinking blocks are dropped entirely; partial tags at
// chunk boundaries are held back until the next chunk resolves them. Returns
// a function to feed each delta; the returned string is the filtered output.
interface ThinkFilter {
  push(delta: string): string;
  flush(): string;
}

function createThinkFilter(): ThinkFilter {
  let buffer = '';
  let inThink = false;
  const OPEN = '<think>';
  const CLOSE = '</think>';
  // Only hold back a tail when it could legitimately be the start of OPEN.
  // Otherwise emit it — preserves final words of the LLM stream even when the
  // caller never invokes flush().
  const safeEmittable = (s: string): { emit: string; keep: string } => {
    for (let keep = Math.min(s.length, OPEN.length - 1); keep > 0; keep -= 1) {
      if (OPEN.startsWith(s.slice(s.length - keep))) {
        return { emit: s.slice(0, s.length - keep), keep: s.slice(-keep) };
      }
    }
    return { emit: s, keep: '' };
  };
  return {
    push(delta: string): string {
      buffer += delta;
      let output = '';
      while (true) {
        if (inThink) {
          const end = buffer.indexOf(CLOSE);
          if (end === -1) {
            if (buffer.length > CLOSE.length - 1) {
              buffer = buffer.slice(-(CLOSE.length - 1));
            }
            return output;
          }
          buffer = buffer.slice(end + CLOSE.length);
          inThink = false;
        } else {
          const start = buffer.indexOf(OPEN);
          if (start === -1) {
            const { emit, keep } = safeEmittable(buffer);
            output += emit;
            buffer = keep;
            return output;
          }
          output += buffer.slice(0, start);
          buffer = buffer.slice(start + OPEN.length);
          inThink = true;
        }
      }
    },
    flush(): string {
      // End of stream: emit anything we were holding back. If we were inside
      // a think block, drop the held buffer (it was never going to be spoken).
      if (inThink) {
        buffer = '';
        return '';
      }
      const out = buffer;
      buffer = '';
      return out;
    },
  };
}

function capLlmInstruction(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = String(value || '').trim();
  const resolved = trimmed || fallback;
  return resolved.length > LLM_INSTRUCTION_LIMIT
    ? `${resolved.slice(0, LLM_INSTRUCTION_LIMIT - 3)}...`
    : resolved;
}

function parseLlmFillers(value: unknown): string[] {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_FILLERS;
  const parsed = raw
    .split(/[\r\n]+/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, LLM_FILLERS_LIMIT)
    .map((line) =>
      line.length > LLM_FILLER_LIMIT
        ? `${line.slice(0, LLM_FILLER_LIMIT - 3)}...`
        : line,
    );
  return parsed.length > 0 ? parsed : DEFAULT_FILLERS;
}

function formatCallStateBlock(state: CallState): string {
  const lines: string[] = [];
  if (state.intent.trim()) lines.push(`- Intent: ${state.intent.trim()}`);
  if (state.promisedActions.length > 0) {
    lines.push(`- Promised: ${state.promisedActions.join('; ')}`);
  }
  if (state.openQuestions.length > 0) {
    lines.push(`- Open questions: ${state.openQuestions.join('; ')}`);
  }
  if (state.mood.trim()) lines.push(`- Mood: ${state.mood.trim()}`);
  if (lines.length === 0) return '';
  return ['Current call state:', ...lines].join('\n');
}

function buildLlmMessages(
  session: LiveSession,
  userText: string,
  settings: VoiceRunnerSettings,
): LlmChatMessage[] {
  // Order: persona > caller identity > call history > state > current input.
  const systemParts: string[] = [
    settings.llmSystemPrompt,
    settings.llmInstructions,
  ];
  if (shouldDisableThinking(settings.llmModel)) {
    // Qwen3's documented soft switch to disable reasoning.
    systemParts.push('/no_think');
  }
  if (session.callerProfile.trim()) {
    systemParts.push(session.callerProfile.trim());
  }
  if (session.callSummary.trim()) {
    systemParts.push(`Call so far: ${session.callSummary.trim()}`);
  }
  const stateBlock = formatCallStateBlock(session.callState);
  if (stateBlock) systemParts.push(stateBlock);
  if (session.lastInterruption) {
    const spoken = session.lastInterruption.spokenSoFar.trim();
    if (spoken) {
      systemParts.push(
        `Your previous reply was interrupted by the caller after you said: "${spoken}". Do not repeat it; acknowledge the interruption and respond to what they just said.`,
      );
    }
    // Fire-once: clear after injection so subsequent turns don't re-surface it.
    session.lastInterruption = null;
  }
  if (
    session.metadata.direction === 'outgoing' &&
    session.caller.expectedRecipient?.trim()
  ) {
    systemParts.push(
      `This is an outbound call you initiated. When the recipient first speaks, introduce yourself with "Hi, it's ${ASSISTANT_NAME}, is this ${session.caller.expectedRecipient.trim()}?" and then briefly state your reason for calling before waiting for a response.`,
    );
  }
  const systemContent = systemParts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  const priorHistory =
    session.history.at(-1)?.role === 'user' &&
    session.history.at(-1)?.text === userText
      ? session.history.slice(0, -1)
      : session.history;
  return [
    {
      role: 'system',
      content: systemContent,
    },
    ...priorHistory.slice(-HISTORY_LIMIT).map((turn) => ({
      role: turn.role,
      content: turn.text,
    })),
    {
      role: 'user' as const,
      content: userText,
    },
  ];
}

function buildCallerProfile(
  caller: VoiceCaller,
  metadata: VoiceCallMetadata,
): string {
  const lines: string[] = [];
  const name = caller.displayName?.trim() || 'unknown';
  const phone = caller.phoneNumber?.trim() || 'unknown';
  lines.push(`Caller: ${name}`);
  lines.push(`Phone: ${phone}`);
  if (metadata.startedAt?.trim()) {
    lines.push(`Call started: ${metadata.startedAt.trim()}`);
  }
  const direction = metadata.direction?.trim() || 'unknown';
  lines.push(`Direction: ${direction}`);
  if (caller.relationshipHint?.trim()) {
    lines.push(`Relationship: ${caller.relationshipHint.trim()}`);
  }
  if (caller.profileSummary?.trim()) {
    lines.push(`Notes: ${caller.profileSummary.trim()}`);
  }
  if (caller.reasonForCall?.trim()) {
    lines.push(`Reason for calling: ${caller.reasonForCall.trim()}`);
  }
  if (caller.expectedRecipient?.trim()) {
    lines.push(`Expected recipient: ${caller.expectedRecipient.trim()}`);
  }
  // TODO: enrich with memory lookup from src/memory/ when that path is cheap.
  return lines.join('\n');
}

function buildBackend(settings: VoiceRunnerSettings): VoiceRunnerBackend {
  const wantsOpenAi =
    settings.llmProvider === 'openai' &&
    settings.llmBaseUrl.trim() &&
    settings.llmModel.trim();
  return wantsOpenAi
    ? new OpenAiVoiceBackend(settings)
    : new HeuristicVoiceBackend();
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
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

  const llmProvider =
    sharedProvider === 'openai' || sharedProvider === 'managed_openarc'
      ? 'openai'
      : 'heuristic';
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
    llmModel:
      sharedModel ||
      (usesManagedOpenArcLlm(settings)
        ? MANAGED_OPENARC_LLM_MODEL
        : OPENAI_MODEL),
    llmBaseUrl: usesManagedOpenArcLlm(settings)
      ? MANAGED_OPENARC_LLM_BASE_URL
      : sharedBaseUrl || OPENAI_BASE_URL,
    llmApiKey: usesManagedOpenArcLlm(settings)
      ? MANAGED_OPENARC_LLM_API_KEY
      : sharedApiKey,
    llmSystemPrompt: capLlmInstruction(
      String(settings?.voiceRunnerSystemPrompt || ''),
      DEFAULT_LLM_SYSTEM_PROMPT,
    ),
    llmInstructions: capLlmInstruction(
      String(settings?.voiceRunnerInstructions || ''),
      DEFAULT_LLM_INSTRUCTIONS,
    ),
    llmFillersEnabled: parseBoolean(settings?.voiceRunnerFillersEnabled, false),
    llmFillers: parseLlmFillers(settings?.voiceRunnerFillers),
    sttProvider:
      sttProviderRaw === 'managed_openvino'
        ? 'managed_openvino'
        : sttProviderRaw === 'managed_stream'
          ? 'managed_stream'
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
    sttStreamBaseUrl: String(
      settings?.voiceStreamSttBaseUrl || MANAGED_STREAM_STT_BASE_URL,
    ).trim(),
    sttStreamSampleRateHz: parsePositiveInteger(
      settings?.voiceStreamSttSampleRateHz,
      16_000,
    ),
    sttStreamEndpointSilenceMs: parsePositiveInteger(
      settings?.voiceStreamSttEndpointSilenceMs,
      500,
    ),
    ttsProvider:
      ttsProviderRaw === 'managed_f5_tts' ||
      ttsProviderRaw === 'managed_openvino_tts' ||
      ttsProviderRaw === 'kyutai_tts' ||
      ttsProviderRaw === 'pocket_tts'
        ? 'managed_f5_tts'
        : ttsProviderRaw === 'openai'
          ? 'openai'
          : 'mock',
    ttsModel: String(
      settings?.voiceTtsModel ||
        (ttsProviderRaw === 'managed_f5_tts' ||
        ttsProviderRaw === 'managed_openvino_tts' ||
        ttsProviderRaw === 'kyutai_tts' ||
        ttsProviderRaw === 'pocket_tts'
          ? MANAGED_F5_TTS_MODEL
          : 'gpt-4o-mini-tts'),
    ).trim(),
    ttsBaseUrl: String(
      ttsProviderRaw === 'managed_f5_tts' ||
        ttsProviderRaw === 'managed_openvino_tts' ||
        ttsProviderRaw === 'kyutai_tts' ||
        ttsProviderRaw === 'pocket_tts'
        ? settings?.voiceTtsBaseUrl || MANAGED_F5_TTS_BASE_URL
        : settings?.voiceTtsBaseUrl || sharedBaseUrl || OPENAI_BASE_URL,
    ).trim(),
    ttsApiKey: String(
      settings?.voiceTtsApiKey || sharedApiKey || OPENAI_API_KEY || '',
    ).trim(),
    defaultVoice:
      String(settings?.defaultVoice || MANAGED_F5_TTS_DEFAULT_VOICE).trim() ||
      MANAGED_F5_TTS_DEFAULT_VOICE,
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
    ttsStreaming: parseBoolean(settings?.voiceTtsStreaming, true),
  };
}

const PREFILL_ENABLED = false;
const PREFILL_MIN_WORDS = 3;
const PREFILL_RATE_LIMIT_MS = 400;
const STREAM_FINAL_TIMEOUT_MS = 2000;
const BARGE_IN_MIN_WORDS = 4;
const BARGE_IN_WINDOW_MS = 1500;

export class VoiceRunnerService {
  private settings: VoiceRunnerSettings;
  private backend: VoiceRunnerBackend;
  private sttProvider: VoiceSttProvider;
  private streamingSttProvider: VoiceStreamingSttProvider | null;
  private ttsProvider: VoiceTtsProvider;
  private warmedAt?: string;
  private warmingPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, LiveSession>();

  constructor(initialSettings?: Record<string, unknown>) {
    this.settings = settingsFromRecord(initialSettings);
    this.backend = buildBackend(this.settings);
    this.sttProvider = buildVoiceSttProvider(this.settings);
    this.streamingSttProvider = buildVoiceStreamingSttProvider(this.settings);
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
      this.streamingSttProvider = buildVoiceStreamingSttProvider(next);
      this.ttsProvider = buildVoiceTtsProvider(next);
      this.warmedAt = undefined;
      this.warmingPromise = null;
    }
  }

  async warm(): Promise<void> {
    if (this.warmedAt) return;
    if (this.warmingPromise) {
      await this.warmingPromise;
      return;
    }
    this.warmingPromise = (async () => {
      await Promise.all([
        this.backend.warm(),
        this.sttProvider.warm(),
        // Streaming STT warm is best-effort; if it fails we fall back to batch.
        this.streamingSttProvider
          ? this.streamingSttProvider
              .warm()
              .catch((err) => log.warn({ err }, 'Streaming STT warmup failed'))
          : Promise.resolve(),
        this.ttsProvider.warm(),
      ]);
      this.warmedAt = nowIso();
    })().finally(() => {
      this.warmingPromise = null;
    });
    await this.warmingPromise;
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
      streamingStt: null,
      streamingSttFailed: false,
      streamingFinalHandled: false,
      prefill: { controller: null, lastText: '', lastFiredAt: 0 },
      callerProfile: buildCallerProfile(input.caller, input.metadata),
      callSummary: '',
      callState: {
        intent: '',
        promisedActions: [],
        openQuestions: [],
        mood: '',
      },
      lastInterruption: null,
      summaryInFlight: false,
      bargeInCandidate: null,
    };
    this.sessions.set(input.sessionId, session);
    // Fire-and-forget streaming STT open; a failure downgrades the session to
    // the batch path transparently (handled in handleAudioInput).
    if (this.streamingSttProvider) {
      void this.openStreamingStt(session).catch((err) => {
        session.streamingSttFailed = true;
        log.warn(
          { err, sessionId: input.sessionId },
          'Streaming STT session failed to open; falling back to batch',
        );
      });
    }
    if (input.greeting?.trim()) {
      void this.emitFixedResponse(input.sessionId, input.greeting).catch(
        (err) => {
          log.warn(
            { err, sessionId: input.sessionId },
            'Voice runner greeting playback failed',
          );
        },
      );
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
    if (input.metadata || input.caller) {
      session.callerProfile = buildCallerProfile(
        session.caller,
        session.metadata,
      );
    }
  }

  async handleAudioInput(event: VoiceAudioInputChunk): Promise<void> {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    const chunk = Buffer.from(event.dataBase64 || '', 'base64');
    // Do NOT barge-in here: with continuous PCM streaming (browser
    // AudioWorklet or always-on phone mic), every audio frame would abort
    // the in-flight response. Barge-in is now triggered on the first
    // non-empty STT partial (inside openStreamingStt's onPartial handler),
    // which fires only when actual words are detected.
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

    const streamingActive =
      !!session.streamingStt &&
      !session.streamingStt.closed &&
      !session.streamingSttFailed;
    if (streamingActive && chunk.length > 0) {
      const pcm = extractPcm16LE(chunk, session.audioInput.contentType);
      if (pcm === null) {
        // Encoded container (WebM/Opus/MP3 from a browser MediaRecorder, etc.)
        // can't be fed to the PCM-only streaming socket. Downgrade this
        // session to batch STT for the rest of the call.
        session.streamingSttFailed = true;
        log.info(
          {
            sessionId: event.sessionId,
            contentType: session.audioInput.contentType,
          },
          'Audio content-type not PCM-compatible; falling back to batch STT',
        );
      } else if (pcm.length > 0) {
        try {
          session.streamingStt!.sendAudio(pcm);
        } catch (err) {
          session.streamingSttFailed = true;
          log.warn(
            { err, sessionId: event.sessionId },
            'Streaming STT send failed; falling back to batch',
          );
        }
      }
    }

    // Always keep the buffered copy so we can fall back to batch STT if the
    // streaming path failed before end-of-turn. Skipping here would leave us
    // with nothing to transcribe.
    if (chunk.length > 0) {
      session.audioInput.chunks.push(chunk);
    }

    if (event.endOfTurn) {
      // Re-evaluate: the audio-chunk block above may have just marked
      // streaming as failed (e.g. non-PCM content-type detected).
      const streamingStillActive =
        !!session.streamingStt &&
        !session.streamingStt.closed &&
        !session.streamingSttFailed;
      if (streamingStillActive) {
        // Flush the STT so it runs one final inference on the complete
        // buffer. The authoritative transcript comes from onFinal, which
        // includes audio up to endOfTurn — not from the most recent partial,
        // which may be seconds behind if inferences backed up.
        try {
          session.streamingStt!.flush();
        } catch (err) {
          log.debug(
            { err, sessionId: event.sessionId },
            'Streaming STT flush failed',
          );
        }
        session.audioInput = { chunks: [] };
        // Safety net: if the STT doesn't emit final within the timeout
        // (server stall, network hiccup), fall back to the last partial so
        // the call doesn't hang.
        const sessionId = event.sessionId;
        setTimeout(() => {
          if (this.sessions.get(sessionId) !== session) return;
          if (session.streamingFinalHandled) return;
          const lastPartial = session.partialText.trim();
          if (!lastPartial) return;
          session.streamingFinalHandled = true;
          log.warn(
            { sessionId, fallbackText: lastPartial },
            'Streaming STT final timed out; falling back to last partial',
          );
          void this.processTranscriptFinal(session, {
            sessionId,
            text: lastPartial,
            timestamp: nowIso(),
            source: 'stt',
          }).catch((err) => {
            log.warn(
              { err, sessionId },
              'processTranscriptFinal fallback failed',
            );
          });
        }, STREAM_FINAL_TIMEOUT_MS);
        return;
      }
      await this.flushAudioInput(session, event.timestamp);
    }
  }

  private async openStreamingStt(session: LiveSession): Promise<void> {
    if (!this.streamingSttProvider) return;
    const sessionId = session.start.sessionId;
    const streaming = await this.streamingSttProvider.start({
      onPartial: (text, timestamp) => {
        if (this.sessions.get(sessionId) !== session) return;
        session.partialText = text;
        this.maybeTriggerBargeIn(session, text, timestamp);
        session.callbacks.onTranscriptPartial?.({
          sessionId,
          text,
          timestamp,
        });
        // Speculative LLM prefill disabled: OpenArc does not implement
        // prefix caching, so each prefill is wasted compute that contends
        // with the real turn's request on the same XPU. Re-enable once the
        // LLM backend supports KV-cache reuse across requests.
        if (PREFILL_ENABLED) {
          void this.prefillLlm(session, text).catch(() => undefined);
        }
      },
      onFinal: (text, timestamp) => {
        if (this.sessions.get(sessionId) !== session) return;
        // First final wins — skip if gateway finalizer already claimed the
        // turn. processTranscriptFinal's finally clears the flag for the
        // next turn.
        if (session.streamingFinalHandled) return;
        session.streamingFinalHandled = true;
        void this.processTranscriptFinal(session, {
          sessionId,
          text,
          timestamp,
          source: 'stt',
        }).catch((err) => {
          log.warn(
            { err, sessionId },
            'processTranscriptFinal from streaming STT failed',
          );
        });
      },
      onError: (err) => {
        if (session.streamingSttFailed) return;
        session.streamingSttFailed = true;
        log.warn(
          { err, sessionId },
          'Streaming STT emitted error; falling back to batch',
        );
      },
      onClose: () => {
        if (session.streamingStt === streaming) {
          session.streamingStt = null;
        }
      },
    });
    if (this.sessions.get(sessionId) !== session) {
      // Session ended before the WS completed handshake.
      await streaming.end();
      return;
    }
    session.streamingStt = streaming;
  }

  // Speculative prefill: best-effort LLM request with max_tokens=1 to warm
  // the server KV cache on the current partial transcript. Errors are
  // swallowed. Deduped against lastText, rate-limited to
  // PREFILL_RATE_LIMIT_MS, and skipped while a response is generating.
  private async prefillLlm(
    session: LiveSession,
    partialText: string,
  ): Promise<void> {
    if (session.activeResponse) return;
    if (this.settings.llmProvider !== 'openai') return;
    const text = partialText.trim();
    if (!text) return;
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < PREFILL_MIN_WORDS) return;
    if (text === session.prefill.lastText) return;
    const now = Date.now();
    if (now - session.prefill.lastFiredAt < PREFILL_RATE_LIMIT_MS) return;
    session.prefill.lastText = text;
    session.prefill.lastFiredAt = now;

    session.prefill.controller?.abort();
    const controller = new AbortController();
    session.prefill.controller = controller;

    const body: Record<string, unknown> = {
      model: this.settings.llmModel,
      temperature: 0.2,
      max_tokens: 1,
      stream: false,
      messages: buildLlmMessages(session, text, this.settings),
    };
    if (shouldDisableThinking(this.settings.llmModel)) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    try {
      await fetch(
        `${this.settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.settings.llmApiKey.trim()
              ? { Authorization: `Bearer ${this.settings.llmApiKey}` }
              : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      log.debug(
        { err, sessionId: session.start.sessionId },
        'LLM prefill request failed',
      );
    } finally {
      if (session.prefill.controller === controller) {
        session.prefill.controller = null;
      }
    }
  }

  handleTranscriptPartial(event: VoiceTranscriptPartial): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    session.partialText = event.text;
    this.maybeTriggerBargeIn(session, event.text, event.timestamp);
    session.callbacks.onTranscriptPartial?.(event);
  }

  // Shared barge-in policy used by both streaming STT onPartial and the
  // external handleTranscriptPartial path. Requires sustained speech (same
  // or growing partial seen twice within BARGE_IN_WINDOW_MS) and at least
  // BARGE_IN_MIN_WORDS words, and rejects known hallucinations.
  private maybeTriggerBargeIn(
    session: LiveSession,
    text: string,
    timestamp: string,
  ): void {
    const clean = text.trim();
    const lower = clean.toLowerCase();
    const wordCount = clean ? clean.split(/\s+/).length : 0;
    const isCandidate =
      wordCount >= BARGE_IN_MIN_WORDS && !isLikelyWhisperHallucination(clean);
    if (!isCandidate || !session.activeResponse) {
      session.bargeInCandidate = null;
      return;
    }
    const now = Date.now();
    const prior = session.bargeInCandidate;
    const sustained =
      prior !== null &&
      now - prior.at <= BARGE_IN_WINDOW_MS &&
      (lower === prior.text ||
        lower.startsWith(prior.text) ||
        prior.text.startsWith(lower));
    if (sustained) {
      log.info(
        { sessionId: session.start.sessionId, text: clean, wordCount },
        'Barge-in triggered by sustained partial',
      );
      session.bargeInCandidate = null;
      this.cancelActiveResponse(session, 'barge_in', timestamp);
    } else {
      session.bargeInCandidate = { text: lower, at: now };
    }
  }

  async handleTranscriptFinal(event: VoiceTranscriptFinal): Promise<void> {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    // First final wins: the streaming onFinal and the gateway endOfTurn race,
    // so whichever arrives first claims the turn and the other becomes a
    // no-op. processTranscriptFinal clears the flag in its finally block
    // so the next turn starts fresh.
    if (session.streamingFinalHandled) return;
    session.streamingFinalHandled = true;
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
      playbackTail: Promise.resolve(),
    };
    session.activeResponse = active;
    await this.emitResponseText(session, active, safeText);
    await active.playbackTail;
    session.history.push({ role: 'assistant', text: safeText, timestamp });
    session.history = session.history.slice(-HISTORY_RETENTION_LIMIT);
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
    session.prefill.controller?.abort();
    session.prefill.controller = null;
    if (session.streamingStt) {
      try {
        await session.streamingStt.end();
      } catch {
        /* ignore */
      }
      session.streamingStt = null;
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
    const text = event.text.trim();
    session.partialText = '';
    if (!text) return;

    // Whisper hallucinates short stock phrases on silence / background noise.
    // Drop those before they trigger an LLM turn (which would otherwise keep
    // the conversation in a loop on the same bogus input).
    if (isLikelyWhisperHallucination(text)) {
      log.debug(
        { sessionId: event.sessionId, text },
        'Dropping likely Whisper hallucination',
      );
      return;
    }

    // Exact-repeat guard: if the last user turn was the same text, a stuck
    // endpoint loop is almost certainly producing it. Drop to break the loop.
    const lastUser = [...session.history]
      .reverse()
      .find((t) => t.role === 'user');
    if (lastUser && lastUser.text.trim() === text) {
      log.debug(
        { sessionId: event.sessionId, text },
        'Dropping exact-repeat transcript',
      );
      return;
    }

    if (session.activeResponse) {
      log.info(
        {
          sessionId: event.sessionId,
          newTranscript: text,
          cutOffAfter: session.activeResponse.textChunks.join(' '),
        },
        'New final arrived mid-response; restarting',
      );
      this.cancelActiveResponse(session, 'restart', event.timestamp);
    }

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
    session.history = session.history.slice(-HISTORY_RETENTION_LIMIT);

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
      playbackTail: Promise.resolve(),
    };
    session.activeResponse = active;
    if (this.settings.llmFillersEnabled) {
      active.fillerTimer = setTimeout(() => {
        if (session.activeResponse?.sequence !== active.sequence) return;
        if (active.firstTextEmitted) return;
        const fillers =
          this.settings.llmFillers.length > 0
            ? this.settings.llmFillers
            : DEFAULT_FILLERS;
        const filler = fillers[active.sequence % fillers.length] || fillers[0];
        this.emitResponseText(session, active, filler).catch((err) =>
          log.debug(
            { err, sessionId: session.start.sessionId },
            'Filler failed',
          ),
        );
      }, FILLER_DELAY_MS);
    }

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

      await active.playbackTail.catch(() => undefined);
      if (session.activeResponse?.sequence !== active.sequence) return;

      const finalizedText =
        active.textChunks.join(' ').trim() || result.text.trim();
      if (finalizedText) {
        const completedAt = nowIso();
        session.history.push({
          role: 'assistant',
          text: finalizedText,
          timestamp: completedAt,
        });
        session.history = session.history.slice(-HISTORY_RETENTION_LIMIT);
        active.latency.responseCompletedAt = completedAt;
        session.callbacks.onLatencySample?.(active.latency);
        if (session.callbacks.onFinalizedAgentTurn) {
          await session.callbacks.onFinalizedAgentTurn({
            sessionId: session.start.sessionId,
            text: finalizedText,
            timestamp: completedAt,
          });
        }
        // Fire-and-forget: the response path must never wait on summarization.
        this.kickoffCallDigest(session);
      }
    } catch (err) {
      // AbortError surfaces as both Error (on cancel) and DOMException (from
      // undici fetch on network abort); check both shapes.
      const e = err as { name?: string; message?: string } | null;
      const name = e?.name || '';
      const message = e?.message || '';
      if (name === 'AbortError' || /abort/i.test(message)) {
        return;
      }
      log.error(
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
      // Allow a fresh streaming/gateway final for the next turn.
      session.streamingFinalHandled = false;
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

    // Kick off synthesis eagerly so chunk N+1's TTS can overlap chunk N's
    // playback. Playback order is preserved by chaining onto `playbackTail`.
    const bufferedChunks: VoiceResponseAudioDelta[] = [];
    const previousTail = active.playbackTail;
    const synthesisPromise = this.ttsProvider.synthesize({
      text: clean,
      voice: this.settings.defaultVoice,
      signal: active.controller.signal,
      stream: this.settings.ttsStreaming,
      onAudioChunk: async (audioChunk) => {
        // Wait for prior chunks' audio to finish dispatching before
        // emitting this chunk's streamed audio, so ordering is preserved.
        await previousTail;
        if (active.controller.signal.aborted) return;
        const audioEvent: VoiceResponseAudioDelta = {
          sessionId: session.start.sessionId,
          dataBase64: audioChunk.audio.toString('base64'),
          contentType: audioChunk.contentType,
          text: audioChunk.text || clean,
          timestamp: nowIso(),
        };
        if (!active.firstAudioEmitted) {
          active.firstAudioEmitted = true;
          active.latency.firstAudioOutAt = nowIso();
        }
        session.callbacks.onResponseAudioDelta?.(audioEvent);
        bufferedChunks.push(audioEvent);
      },
    });

    active.playbackTail = (async () => {
      let synthesized;
      try {
        synthesized = await synthesisPromise;
      } catch (err) {
        await previousTail.catch(() => undefined);
        throw err;
      }
      await previousTail;
      if (active.controller.signal.aborted) return;
      if (bufferedChunks.length === 0) {
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
    })();
    // Surface synthesis errors without swallowing them, while keeping the
    // tail chain unbroken for subsequent chunks.
    active.playbackTail.catch((err) => {
      log.debug(
        { err, sessionId: session.start.sessionId },
        'TTS synthesis failed for pipelined chunk',
      );
    });
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
    // Preserve what was already spoken so the next turn can acknowledge the
    // interruption instead of repeating itself.
    if (reason === 'barge_in') {
      const spokenSoFar = active.textChunks.join(' ').trim();
      if (spokenSoFar) {
        session.lastInterruption = { spokenSoFar, timestamp };
      }
    }
    session.callbacks.onLatencySample?.(active.latency);
    session.callbacks.onResponseCancel?.({
      sessionId: session.start.sessionId,
      reason,
      timestamp,
    });
    session.activeResponse = null;
  }

  // Background digest — must not block response path. Fire-and-forget.
  private kickoffCallDigest(session: LiveSession): void {
    if (session.summaryInFlight) return;
    if (session.history.length <= SUMMARY_THRESHOLD_TURNS) return;
    if (this.settings.llmProvider !== 'openai') return;
    if (!this.settings.llmBaseUrl.trim() || !this.settings.llmModel.trim()) {
      return;
    }
    session.summaryInFlight = true;
    const sessionId = session.start.sessionId;
    void (async () => {
      try {
        const older = session.history.slice(0, -SUMMARY_RECENT_TAIL);
        if (older.length === 0) return;
        const transcript = older
          .map(
            (t) =>
              `${t.role === 'user' ? 'Caller' : 'Assistant'}: ${t.text.trim()}`,
          )
          .join('\n');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DIGEST_TIMEOUT_MS);
        let result;
        try {
          const body: Record<string, unknown> = {
            model: this.settings.llmModel,
            temperature: 0.1,
            max_tokens: DIGEST_MAX_TOKENS,
            stream: false,
            messages: [
              { role: 'system', content: DIGEST_STATE_SYSTEM_PROMPT },
              { role: 'user', content: transcript },
            ],
          };
          if (shouldDisableThinking(this.settings.llmModel)) {
            body.chat_template_kwargs = { enable_thinking: false };
          }
          const response = await fetch(
            `${this.settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(this.settings.llmApiKey.trim()
                  ? { Authorization: `Bearer ${this.settings.llmApiKey}` }
                  : {}),
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            log.debug(
              { sessionId, status: response.status },
              'Call digest request failed',
            );
            return;
          }
          result = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
        } finally {
          clearTimeout(timeout);
        }
        if (!this.sessions.has(sessionId)) return;
        const raw = result.choices?.[0]?.message?.content?.trim() || '';
        const cleaned = shouldDisableThinking(this.settings.llmModel)
          ? raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()
          : raw;
        const jsonText = extractJsonObject(cleaned);
        if (!jsonText) {
          log.debug(
            { sessionId, sample: cleaned.slice(0, 120) },
            'Call digest produced no parseable JSON',
          );
          return;
        }
        const parsed = safeParseDigest(jsonText);
        if (!parsed) {
          log.debug({ sessionId }, 'Call digest JSON parse failed');
          return;
        }
        if (parsed.summary) session.callSummary = parsed.summary;
        session.callState = {
          intent: parsed.intent || session.callState.intent,
          promisedActions:
            parsed.promisedActions ?? session.callState.promisedActions,
          openQuestions:
            parsed.openQuestions ?? session.callState.openQuestions,
          mood: parsed.mood || session.callState.mood,
        };
      } catch (err) {
        log.debug({ err, sessionId }, 'Call digest task failed');
      } finally {
        session.summaryInFlight = false;
      }
    })();
  }
}

function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

interface ParsedDigest {
  summary: string;
  intent: string;
  promisedActions: string[];
  openQuestions: string[];
  mood: string;
}

function safeParseDigest(jsonText: string): ParsedDigest | null {
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const toStringArray = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 10);
    };
    return {
      summary: String(parsed.summary || '').trim(),
      intent: String(parsed.intent || '').trim(),
      promisedActions: toStringArray(parsed.promisedActions),
      openQuestions: toStringArray(parsed.openQuestions),
      mood: String(parsed.mood || '').trim(),
    };
  } catch {
    return null;
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
