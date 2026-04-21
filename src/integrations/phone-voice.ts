import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ensureAgentMemoryFile } from '../agent-memory.js';
import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  OPENAI_BASE_URL,
} from '../config.js';
import { normalizePhone } from '../contact-resolution.js';
import {
  setRegisteredGroup,
  storeChatMetadata,
  storeMessageIfNew,
  updateChatName,
} from '../db.js';
import { readEnvFile } from '../env.js';
import {
  deriveUniqueGroupFolder,
  resolveGroupFolderPath,
} from '../group-folder.js';
import { createChildLogger } from '../logger.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import {
  createVoiceRunnerController,
  type VoiceRunnerController,
} from '../voice-runner/controller.js';
import { VoiceHandoffStore } from '../voice-runner/handoff-store.js';
import type {
  VoiceActionRequest,
  VoiceCallMetadata,
  VoiceCaller,
  VoiceHandoffRequest,
  VoiceRunnerHealth,
} from '../voice-runner/protocol.js';

import { registerIntegration } from './registry.js';
import {
  getIntegrationSettings,
  isIntegrationEnabled,
  saveIntegrationSettings,
  setIntegrationEnabled,
} from './settings-store.js';
import {
  getServiceStatus,
  startService,
  stopService,
} from './service-manager.js';
import type {
  ChannelOpts,
  CredentialInputStep,
  IntegrationDefinition,
  IntegrationNotification,
} from './types.js';
import {
  MANAGED_OPENVINO_STT_BASE_URL,
  MANAGED_OPENVINO_STT_HEALTH_URL,
  MANAGED_OPENVINO_STT_MODEL,
  MANAGED_OPENVINO_STT_PORT,
  MANAGED_OPENVINO_STT_WARM_URL,
  MANAGED_STREAM_STT_BASE_URL,
  getStreamSttHealthUrl,
  usesManagedOpenVinoStt,
  usesManagedStreamStt,
} from '../voice-runner/local-stt.js';
import {
  MANAGED_F5_TTS_BASE_URL,
  MANAGED_F5_TTS_DEFAULT_VOICE,
  MANAGED_F5_TTS_DEVICE_TARGET,
  MANAGED_F5_TTS_HEALTH_URL,
  MANAGED_F5_TTS_MODEL,
  MANAGED_F5_TTS_MODEL_NAME,
  MANAGED_F5_TTS_MODELS_URL,
  MANAGED_F5_TTS_PORT,
  MANAGED_F5_TTS_WARM_URL,
  usesManagedF5Tts,
} from '../voice-runner/local-tts.js';
import {
  MANAGED_OPENARC_LLM_API_KEY,
  MANAGED_OPENARC_LLM_BASE_URL,
  MANAGED_OPENARC_LLM_DEVICE_TARGET,
  MANAGED_OPENARC_LLM_MODEL,
  MANAGED_OPENARC_LLM_MODEL_REPO,
  MANAGED_OPENARC_LLM_MODELS_URL,
  MANAGED_OPENARC_LLM_PORT,
  usesManagedOpenArcLlm,
} from '../voice-runner/local-llm.js';

const INTEGRATION_NAME = 'phone-voice';
const API_KEY_SETTING = 'PHONE_VOICE_API_KEY';
const MANAGED_SPEECH_PROJECT_NAME = 'phone-voice-stack';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8787/';
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;
const VOICE_RUNTIME_DIR = path.join(DATA_DIR, 'voice-runner');
const MANAGED_SPEECH_ENABLE_TIMEOUT_MS = 180_000;
const MANAGED_SPEECH_POLL_INTERVAL_MS = 2_000;
const DEFAULT_VOICE_RUNNER_FILLERS = [
  'One moment.',
  'Give me a second.',
  'Hmmm.',
].join('\n');
const NOOP_CHANNEL_OPTS: ChannelOpts = {
  onMessage: () => undefined,
  onChatMetadata: () => undefined,
  registeredGroups: () => ({}),
};

const log = createChildLogger({ integration: INTEGRATION_NAME });

interface PhoneVoiceEnvelope {
  id?: string;
  type?: string;
  requestId?: string;
  ok?: boolean;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type WebSocketWithOptionsCtor = new (
  url: string | URL,
  options?: Record<string, unknown>,
) => WebSocket;

interface CallSession {
  callId: string;
  sessionId: string;
  chatJid: string;
  caller: VoiceCaller;
  metadata: VoiceCallMetadata;
  deferredHandoffs: VoiceHandoffRequest[];
  runnerReady: Promise<void> | null;
}

export interface BrowserVoiceSessionEvent {
  type:
    | 'caller_turn'
    | 'assistant_turn'
    | 'assistant_audio'
    | 'handoff'
    | 'action';
  text?: string;
  contentType?: string;
  dataBase64?: string;
  timestamp: string;
  action?: string;
  summary?: string;
}

type BrowserVoiceEventListener = (event: BrowserVoiceSessionEvent) => void;

interface BrowserVoiceSession {
  sessionId: string;
  caller: VoiceCaller;
  metadata: VoiceCallMetadata;
  events: BrowserVoiceSessionEvent[];
  listeners: Set<BrowserVoiceEventListener>;
}

function getApiKey(settings?: Record<string, unknown>): string {
  const env = readEnvFile([API_KEY_SETTING]);
  return (
    env[API_KEY_SETTING] ||
    process.env[API_KEY_SETTING] ||
    String(settings?.[API_KEY_SETTING] || '')
  ).trim();
}

function openGatewaySocket(url: string | URL, apiKey: string): WebSocket {
  const WebSocketCtor = WebSocket as unknown as WebSocketWithOptionsCtor;
  return new WebSocketCtor(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

function getGatewayUrl(settings?: Record<string, unknown>): string {
  return String(settings?.gatewayUrl || DEFAULT_GATEWAY_URL).trim();
}

function parseAllowedNumbers(settings?: Record<string, unknown>): Set<string> {
  const raw = String(settings?.allowedNumbers || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\r\n,]+/)
      .map((value) => normalizePhone(value))
      .filter(Boolean),
  );
}

function allowsUnknownCallers(settings?: Record<string, unknown>): boolean {
  return settings?.allowUnknownCallers !== false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function managedSpeechComposeFile(): string {
  return path.resolve('scripts/phone-voice-stt/docker-compose.yml');
}

function managedSpeechEnvFile(): string {
  return path.resolve('scripts/phone-voice-stt/.env');
}

function buildManagedSpeechEnv(
  settings: Record<string, unknown>,
): Record<string, string> {
  if (!usesManagedSpeechServices(settings)) {
    return {
      STT_PORT: '',
      STT_MODEL_ID: '',
      STT_TARGET_DEVICE: '',
      STT_QUANTIZATION: '',
      TTS_PORT: '',
      TTS_MODEL_ID: '',
      TTS_MODEL_NAME: '',
      TTS_DEFAULT_VOICE: '',
      TTS_DEVICE_TARGET: '',
      LLM_PORT: '',
      LLM_MODEL_NAME: '',
      LLM_MODEL_REPO: '',
      LLM_DEVICE_TARGET: '',
      OPENARC_API_KEY_REQUIRED: '',
      OPENARC_API_KEY: '',
      HF_TOKEN: '',
      HUGGING_FACE_HUB_TOKEN: '',
    };
  }

  const envSecrets = readEnvFile(['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN']);
  const huggingFaceToken = String(
    process.env.HF_TOKEN ||
      process.env.HUGGING_FACE_HUB_TOKEN ||
      envSecrets.HF_TOKEN ||
      envSecrets.HUGGING_FACE_HUB_TOKEN ||
      '',
  ).trim();

  return {
    STT_PORT: String(MANAGED_OPENVINO_STT_PORT),
    STT_MODEL_ID:
      String(settings.voiceSttModel || MANAGED_OPENVINO_STT_MODEL).trim() ||
      MANAGED_OPENVINO_STT_MODEL,
    STT_TARGET_DEVICE: getManagedSttDevice(settings),
    STT_QUANTIZATION: getManagedSttQuantization(settings),
    TTS_PORT: String(MANAGED_F5_TTS_PORT),
    TTS_MODEL_ID:
      String(settings.voiceTtsModel || MANAGED_F5_TTS_MODEL).trim() ||
      MANAGED_F5_TTS_MODEL,
    TTS_MODEL_NAME: MANAGED_F5_TTS_MODEL_NAME,
    TTS_DEFAULT_VOICE:
      String(settings.defaultVoice || MANAGED_F5_TTS_DEFAULT_VOICE).trim() ||
      MANAGED_F5_TTS_DEFAULT_VOICE,
    TTS_DEVICE_TARGET: getManagedF5TtsDevice(settings),
    LLM_PORT: String(MANAGED_OPENARC_LLM_PORT),
    LLM_MODEL_NAME:
      String(settings.voiceRunnerModel || MANAGED_OPENARC_LLM_MODEL).trim() ||
      MANAGED_OPENARC_LLM_MODEL,
    LLM_MODEL_REPO: MANAGED_OPENARC_LLM_MODEL_REPO,
    LLM_DEVICE_TARGET: MANAGED_OPENARC_LLM_DEVICE_TARGET,
    OPENARC_API_KEY_REQUIRED: 'true',
    OPENARC_API_KEY: MANAGED_OPENARC_LLM_API_KEY,
    HF_TOKEN: huggingFaceToken,
    HUGGING_FACE_HUB_TOKEN: huggingFaceToken,
  };
}

function writeManagedSpeechEnvFile(values: Record<string, string>): void {
  const envFile = managedSpeechEnvFile();
  fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
  fs.writeFileSync(envFile, `${content}\n`, { mode: 0o600 });
}

function composeBaseArgs(
  composeBin: string,
  composeFile: string,
  envFile: string,
): string[] {
  const head = [
    '-p',
    MANAGED_SPEECH_PROJECT_NAME,
    '-f',
    composeFile,
    '--env-file',
    envFile,
  ];
  return composeBin === 'docker-compose' ? head : ['compose', ...head];
}

function isComposeNetworkRecreateError(text: string): boolean {
  return /needs to be recreated/i.test(text);
}

async function runCompose(
  command: string,
  args: string[],
  composeDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: composeDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const cap = (buf: string, chunk: Buffer): string => {
      const next = buf + chunk.toString('utf8');
      return next.length > 4096 ? next.slice(-4096) : next;
    };
    child.stdout?.on('data', (c: Buffer) => {
      stdout = cap(stdout, c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = cap(stderr, c);
    });
    child.on('error', (err) => {
      resolve({ code: 1, stdout, stderr: stderr + String(err) });
    });
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function launchManagedSpeechServiceStart(
  settings: Record<string, unknown>,
): void {
  const envValues = buildManagedSpeechEnv(settings);
  writeManagedSpeechEnvFile(envValues);

  const composeFile = managedSpeechComposeFile();
  const envFile = managedSpeechEnvFile();
  const composeDir = path.dirname(composeFile);
  const composeBin = process.env.SELF_HOSTED_CLAW_COMPOSE_BIN || 'docker';
  const command =
    composeBin === 'docker-compose' ? 'docker-compose' : composeBin;
  const baseArgs = composeBaseArgs(composeBin, composeFile, envFile);
  const upArgs = [...baseArgs, 'up', '-d'];
  const downArgs = [...baseArgs, 'down'];

  void (async () => {
    let result = await runCompose(command, upArgs, composeDir);
    if (
      result.code !== 0 &&
      isComposeNetworkRecreateError(result.stderr || result.stdout)
    ) {
      log.info(
        'Managed speech compose network needs recreation; tearing down and retrying',
      );
      await runCompose(command, downArgs, composeDir);
      result = await runCompose(command, upArgs, composeDir);
    }
    if (result.code && result.code !== 0) {
      log.warn(
        {
          code: result.code,
          stdoutTail: result.stdout,
          stderrTail: result.stderr,
        },
        'Managed speech compose exited with a non-zero status',
      );
    }
  })();
}

async function waitForManagedSttReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'managed_stt_unreachable';

  while (Date.now() < deadline) {
    try {
      const healthResponse = await fetch(MANAGED_OPENVINO_STT_HEALTH_URL, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!healthResponse.ok) {
        lastError = `managed_stt_health_${healthResponse.status}`;
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }

      const warmResponse = await fetch(MANAGED_OPENVINO_STT_WARM_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
      });
      if (!warmResponse.ok) {
        lastError = `managed_stt_warm_${warmResponse.status}`;
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }

      const payload = (await warmResponse.json().catch(() => ({}))) as {
        ready?: boolean;
      };
      if (payload.ready === false) {
        lastError = 'managed_stt_not_ready';
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`Managed STT service did not become ready: ${lastError}`);
}

async function waitForManagedF5TtsReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'managed_tts_unreachable';

  while (Date.now() < deadline) {
    try {
      const warmResponse = await fetch(MANAGED_F5_TTS_WARM_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
      });
      if (!warmResponse.ok) {
        lastError = `managed_tts_warm_${warmResponse.status}`;
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }

      const payload = (await warmResponse.json().catch(() => ({}))) as {
        ready?: boolean;
        data?: Array<{ id?: string }>;
      };
      if (payload.ready === false) {
        lastError = 'managed_tts_not_ready';
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }
      const modelLoaded = Array.isArray(payload.data)
        ? payload.data.some((entry) => entry?.id === MANAGED_F5_TTS_MODEL_NAME)
        : false;
      if (!modelLoaded) {
        lastError = 'managed_tts_model_not_loaded';
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`Managed F5-TTS service did not become ready: ${lastError}`);
}

function usesManagedSpeechServices(
  settings?: Record<string, unknown>,
): boolean {
  return (
    usesManagedOpenVinoStt(settings) ||
    usesManagedStreamStt(settings) ||
    usesManagedF5Tts(settings) ||
    usesManagedOpenArcLlm(settings)
  );
}

async function waitForManagedStreamSttReady(
  timeoutMs: number,
  settings: Record<string, unknown>,
): Promise<void> {
  const base = String(
    settings.voiceStreamSttBaseUrl || MANAGED_STREAM_STT_BASE_URL,
  ).trim();
  const healthUrl = getStreamSttHealthUrl(base);
  const deadline = Date.now() + timeoutMs;
  let lastError = 'managed_stream_stt_unreachable';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        lastError = `managed_stream_stt_health_${response.status}`;
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        ready?: boolean;
      };
      if (payload.ready === false) {
        lastError = 'managed_stream_stt_not_ready';
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `Managed streaming STT service did not become ready: ${lastError}`,
  );
}

async function ensureManagedSpeechServices(
  settings: Record<string, unknown>,
): Promise<void> {
  if (!usesManagedSpeechServices(settings)) {
    return;
  }

  launchManagedSpeechServiceStart(settings);
  const waiters: Array<Promise<void>> = [];
  if (usesManagedOpenVinoStt(settings)) {
    waiters.push(waitForManagedSttReady(MANAGED_SPEECH_ENABLE_TIMEOUT_MS));
  }
  if (usesManagedStreamStt(settings)) {
    waiters.push(
      waitForManagedStreamSttReady(MANAGED_SPEECH_ENABLE_TIMEOUT_MS, settings),
    );
  }
  if (usesManagedF5Tts(settings)) {
    waiters.push(waitForManagedF5TtsReady(MANAGED_SPEECH_ENABLE_TIMEOUT_MS));
  }
  if (usesManagedOpenArcLlm(settings)) {
    waiters.push(
      waitForManagedOpenArcLlmReady(MANAGED_SPEECH_ENABLE_TIMEOUT_MS, settings),
    );
  }
  await Promise.all(waiters);
}

async function waitForManagedOpenArcLlmReady(
  timeoutMs: number,
  settings: Record<string, unknown>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'managed_llm_unreachable';
  const expectedModel =
    String(settings.voiceRunnerModel || MANAGED_OPENARC_LLM_MODEL).trim() ||
    MANAGED_OPENARC_LLM_MODEL;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(MANAGED_OPENARC_LLM_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${MANAGED_OPENARC_LLM_API_KEY}`,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        lastError = `managed_llm_models_${response.status}`;
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        data?: Array<{ id?: string }>;
      };
      const modelLoaded = Array.isArray(payload.data)
        ? payload.data.some((entry) => entry?.id === expectedModel)
        : false;
      if (!modelLoaded) {
        lastError = 'managed_llm_model_not_loaded';
        await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
        continue;
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(MANAGED_SPEECH_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `Managed OpenArc LLM service did not become ready: ${lastError}`,
  );
}

function shouldRestartManagedLlm(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const keys = ['voiceRunnerProvider', 'voiceRunnerModel'];
  return keys.some(
    (key) => String(prev[key] || '') !== String(next[key] || ''),
  );
}

function shouldRestartManagedStt(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const keys = [
    'voiceSttProvider',
    'voiceSttModel',
    'voiceSttTargetDevice',
    'voiceSttQuantization',
    'voiceStreamSttBaseUrl',
  ];
  return keys.some(
    (key) => String(prev[key] || '') !== String(next[key] || ''),
  );
}

function shouldRestartManagedTts(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const keys = [
    'voiceTtsProvider',
    'voiceTtsModel',
    'voiceTtsDeviceTarget',
    'defaultVoice',
  ];
  return keys.some(
    (key) => String(prev[key] || '') !== String(next[key] || ''),
  );
}

function getManagedF5TtsDevice(settings?: Record<string, unknown>): string {
  const raw = String(
    settings?.voiceTtsDeviceTarget || MANAGED_F5_TTS_DEVICE_TARGET,
  )
    .trim()
    .toLowerCase();
  if (!raw || raw === 'auto') return 'xpu';
  if (raw === 'xpu') return 'xpu';
  if (raw === 'CPU') return 'CPU';
  return 'xpu';
}

function getManagedSttDevice(settings?: Record<string, unknown>): string {
  const raw = String(settings?.voiceSttTargetDevice || 'AUTO:GPU,CPU').trim();
  return raw || 'AUTO:GPU,CPU';
}

function getManagedSttQuantization(settings?: Record<string, unknown>): string {
  const raw = String(settings?.voiceSttQuantization || 'int8')
    .trim()
    .toLowerCase();
  return raw === 'fp16' ? 'fp16' : 'int8';
}

function nowIso(): string {
  return new Date().toISOString();
}

async function isHealthEndpointReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json().catch(() => ({}))) as {
      ready?: boolean;
    };
    return payload.ready !== false;
  } catch {
    return false;
  }
}

async function isManagedF5TtsReady(): Promise<boolean> {
  try {
    const response = await fetch(MANAGED_F5_TTS_HEALTH_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => ({}))) as {
      ready?: boolean;
      model_name?: string;
    };
    return (
      Boolean(payload.ready) && payload.model_name === MANAGED_F5_TTS_MODEL_NAME
    );
  } catch {
    return false;
  }
}

async function isManagedOpenArcLlmReady(
  settings?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch(MANAGED_OPENARC_LLM_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${MANAGED_OPENARC_LLM_API_KEY}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ id?: string }>;
    };
    const expectedModel =
      String(settings?.voiceRunnerModel || MANAGED_OPENARC_LLM_MODEL).trim() ||
      MANAGED_OPENARC_LLM_MODEL;
    return Array.isArray(payload.data)
      ? payload.data.some((entry) => entry?.id === expectedModel)
      : false;
  } catch {
    return false;
  }
}

export function makeVoiceJid(value: string): string {
  const phone = normalizePhone(value);
  if (!phone || phone.replace(/[^\d]/g, '').length < 7) {
    throw new Error(`Invalid voice phone number: ${value}`);
  }
  return `voice:${phone}`;
}

function makeMessageId(prefix: string, sessionId: string): string {
  return `${INTEGRATION_NAME}:${prefix}:${sessionId}:${crypto.randomUUID()}`;
}

function getPayloadString(
  payload: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function getCallerFromPayload(
  payload: Record<string, unknown>,
): VoiceCaller | null {
  const phone = normalizePhone(
    getPayloadString(payload, ['phoneNumber', 'number', 'address', 'from']),
  );
  if (!phone) return null;
  const displayName =
    getPayloadString(payload, ['displayName', 'name', 'callerName']) || phone;
  return {
    phoneNumber: phone,
    displayName,
    profileSummary: getPayloadString(payload, ['profileSummary']),
    relationshipHint: getPayloadString(payload, ['relationshipHint']),
  };
}

function getCallMetadata(
  payload: Record<string, unknown>,
): VoiceCallMetadata | null {
  const callId = getPayloadString(payload, ['callId', 'id']);
  if (!callId) return null;
  const directionRaw = getPayloadString(payload, ['direction']);
  const direction =
    directionRaw === 'incoming' ||
    directionRaw === 'outgoing' ||
    directionRaw === 'unknown'
      ? directionRaw
      : directionRaw === 'inbound'
        ? 'incoming'
        : directionRaw === 'outbound'
          ? 'outgoing'
          : undefined;
  return {
    callId,
    direction,
    state: getPayloadString(payload, ['state']) || undefined,
    startedAt: getPayloadString(payload, ['startedAt']) || nowIso(),
  };
}

function stringifyHandoff(
  handoff: VoiceHandoffRequest,
  session: CallSession,
): string {
  return [
    '[Phone voice follow-up]',
    `Caller: ${session.caller.displayName} (${session.caller.phoneNumber})`,
    `Session: ${session.sessionId}`,
    `Kind: ${handoff.kind}`,
    `Summary: ${handoff.summary}`,
    handoff.requestedAction
      ? `Requested action: ${handoff.requestedAction}`
      : '',
    handoff.contextSnippet ? `Context: ${handoff.contextSnippet}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export class PhoneVoiceChannel implements Channel {
  name = INTEGRATION_NAME;

  private connected = false;
  private connecting = false;
  private stopped = false;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private settings: Record<string, unknown>;
  private readonly runner: VoiceRunnerController;
  private readonly handoffStore: VoiceHandoffStore;
  private readonly sessionsByCallId = new Map<string, CallSession>();
  private readonly sessionsBySessionId = new Map<string, CallSession>();
  private readonly activeCallByJid = new Map<string, string>();
  private readonly browserSessions = new Map<string, BrowserVoiceSession>();
  private lastGatewaySnapshot: Record<string, unknown> | null = null;
  private lastLatencySampleAt?: string;
  private lastRuntimeHealth: VoiceRunnerHealth;
  private warmRuntimePromise: Promise<VoiceRunnerHealth> | null = null;

  constructor(
    private readonly opts: ChannelOpts,
    initialSettings: Record<string, unknown>,
  ) {
    this.settings = { ...initialSettings };
    this.runner = createVoiceRunnerController(initialSettings);
    this.handoffStore = new VoiceHandoffStore();
    fs.mkdirSync(VOICE_RUNTIME_DIR, { recursive: true });
    this.lastRuntimeHealth = this.runner.getHealthSnapshot();
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.refreshSettings(getIntegrationSettings(INTEGRATION_NAME));
    this.connecting = true;
    void this.ensureConnected().catch((err) => {
      this.connecting = false;
      log.warn({ err }, 'Phone voice background startup failed');
    });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Phone voice gateway disconnected'));
    }
    this.pendingRequests.clear();
    this.socket?.close();
    this.socket = null;
    for (const session of this.sessionsBySessionId.values()) {
      await this.runner.endSession(session.sessionId);
    }
    for (const session of this.browserSessions.values()) {
      await this.runner.endSession(session.sessionId);
    }
    this.sessionsByCallId.clear();
    this.sessionsBySessionId.clear();
    this.activeCallByJid.clear();
    this.browserSessions.clear();
  }

  isConnected(): boolean {
    return this.connected || this.connecting;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('voice:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const callId = this.activeCallByJid.get(jid);
    if (!callId) {
      throw new Error(`No active phone voice call for ${jid}`);
    }
    const session = this.sessionsByCallId.get(callId);
    if (!session) throw new Error(`Unknown phone voice session for ${jid}`);
    const spokenText = text.trim();
    if (!spokenText) return;
    await this.sendRequest('assistant.speak', {
      callId: session.callId,
      sessionId: session.sessionId,
      text: spokenText,
      voice: String(this.settings.defaultVoice || 'alloy'),
    });
    await this.persistAgentTurn(session, spokenText, nowIso());
  }

  refreshSettings(settings: Record<string, unknown>): void {
    this.settings = { ...settings };
    this.runner.configure(settings);
  }

  async warmRuntime(): Promise<VoiceRunnerHealth> {
    if (this.lastRuntimeHealth.ready) {
      return this.lastRuntimeHealth;
    }
    if (this.warmRuntimePromise) {
      return this.warmRuntimePromise;
    }
    this.warmRuntimePromise = (async () => {
      await ensureManagedSpeechServices(this.settings);
      await this.runner.warm();
      try {
        this.lastRuntimeHealth = await this.runner.refreshHealth();
      } catch (err) {
        this.lastRuntimeHealth = {
          ...this.runner.getHealthSnapshot(),
          ready: true,
          lastError: err instanceof Error ? err.message : String(err),
        };
        log.warn(
          { err },
          'Phone voice runtime warmed, but the follow-up health check timed out',
        );
      }
      return this.lastRuntimeHealth;
    })().finally(() => {
      this.warmRuntimePromise = null;
    });
    return this.warmRuntimePromise;
  }

  async prepareBrowserVoiceRuntime(): Promise<VoiceRunnerHealth> {
    return this.warmRuntime();
  }

  getRuntimeHealth(): VoiceRunnerHealth {
    return this.lastRuntimeHealth;
  }

  async refreshRuntimeHealth(): Promise<VoiceRunnerHealth> {
    try {
      this.lastRuntimeHealth = await this.runner.refreshHealth();
    } catch (err) {
      this.lastRuntimeHealth = {
        ...this.runner.getHealthSnapshot(),
        lastError: err instanceof Error ? err.message : String(err),
      };
      log.warn({ err }, 'Phone voice runtime health refresh failed');
    }
    return this.lastRuntimeHealth;
  }

  getGatewaySnapshot(): Record<string, unknown> | null {
    return this.lastGatewaySnapshot;
  }

  getActiveCallCount(): number {
    return this.sessionsByCallId.size;
  }

  getActiveCallId(chatJid: string): string | null {
    return this.activeCallByJid.get(chatJid) || null;
  }

  getLastLatencySampleAt(): string | undefined {
    return this.lastLatencySampleAt;
  }

  getPendingHandoffCount(): number {
    return this.handoffStore.getPendingCount();
  }

  async startBrowserVoiceSession(displayName?: string): Promise<{
    sessionId: string;
    events: BrowserVoiceSessionEvent[];
  }> {
    await this.warmRuntime();
    const sessionId = `browser:${crypto.randomUUID()}`;
    const caller: VoiceCaller = {
      phoneNumber: '+19990000000',
      displayName: displayName?.trim() || 'Browser Tester',
      relationshipHint: 'Local browser voice test session',
    };
    const metadata: VoiceCallMetadata = {
      callId: `browser-call:${crypto.randomUUID()}`,
      direction: 'incoming',
      state: 'active',
      startedAt: nowIso(),
    };
    const session: BrowserVoiceSession = {
      sessionId,
      caller,
      metadata,
      events: [],
      listeners: new Set(),
    };
    this.browserSessions.set(sessionId, session);

    const emit = (event: BrowserVoiceSessionEvent): void => {
      session.events.push(event);
      for (const listener of session.listeners) {
        try {
          listener(event);
        } catch (err) {
          log.warn({ err }, 'Browser voice listener threw');
        }
      }
    };

    await this.runner.startSession(
      {
        sessionId,
        chatJid: `voice-browser:${sessionId}`,
        caller,
        metadata,
        greeting: `Hi, this is ${ASSISTANT_NAME}. Browser voice test is ready.`,
      },
      {
        onTranscriptFinal: async (event) => {
          emit({
            type: 'caller_turn',
            text: event.text,
            timestamp: event.timestamp,
          });
        },
        onResponseAudioDelta: (event) => {
          emit({
            type: 'assistant_audio',
            text: event.text,
            contentType: event.contentType,
            dataBase64: event.dataBase64,
            timestamp: event.timestamp,
          });
        },
        onFinalizedAgentTurn: async (event) => {
          emit({
            type: 'assistant_turn',
            text: event.text,
            timestamp: event.timestamp,
          });
        },
        onHandoffEnqueue: async (handoff) => {
          emit({
            type: 'handoff',
            summary: handoff.summary,
            text: handoff.requestedAction,
            timestamp: handoff.createdAt,
          });
        },
        onActionRequest: async (event) => {
          emit({
            type: 'action',
            action: event.action,
            text: event.reason,
            timestamp: event.timestamp,
          });
        },
      },
    );

    return {
      sessionId,
      events: this.drainBrowserSessionEvents(session),
    };
  }

  async sendBrowserVoiceAudio(input: {
    sessionId: string;
    dataBase64: string;
    contentType: string;
    sampleRateHz?: number;
    channels?: number;
    endOfTurn?: boolean;
    awaitIdle?: boolean;
  }): Promise<{ events: BrowserVoiceSessionEvent[] }> {
    const session = this.browserSessions.get(input.sessionId);
    if (!session) {
      throw new Error('Browser voice session not found');
    }
    await this.runner.handleAudioInput({
      sessionId: session.sessionId,
      dataBase64: input.dataBase64,
      contentType: input.contentType,
      sampleRateHz: input.sampleRateHz,
      channels: input.channels,
      endOfTurn: input.endOfTurn !== false,
      timestamp: nowIso(),
    });
    if (input.awaitIdle !== false && input.endOfTurn !== false) {
      await this.runner.waitForIdle(session.sessionId);
    }
    return {
      events: this.drainBrowserSessionEvents(session),
    };
  }

  getBrowserVoiceEvents(sessionId: string): {
    events: BrowserVoiceSessionEvent[];
  } {
    const session = this.browserSessions.get(sessionId);
    if (!session) {
      throw new Error('Browser voice session not found');
    }
    return {
      events: this.drainBrowserSessionEvents(session),
    };
  }

  async endBrowserVoiceSession(sessionId: string): Promise<void> {
    const session = this.browserSessions.get(sessionId);
    if (!session) return;
    await this.runner.endSession(sessionId);
    this.browserSessions.delete(sessionId);
  }

  ownsBrowserVoiceSession(sessionId: string): boolean {
    return this.browserSessions.has(sessionId);
  }

  subscribeBrowserVoiceEvents(
    sessionId: string,
    listener: BrowserVoiceEventListener,
  ): () => void {
    const session = this.browserSessions.get(sessionId);
    if (!session) {
      throw new Error('Browser voice session not found');
    }
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
    await this.runner.shutdown();
  }

  async endCallByJid(jid: string): Promise<void> {
    const callId = this.activeCallByJid.get(jid);
    if (!callId) throw new Error(`No active call for ${jid}`);
    await this.endCallById(callId);
  }

  async endCallById(callId: string): Promise<void> {
    await this.sendRequest('endCall', { callId });
  }

  async setMute(callId: string, muted: boolean): Promise<void> {
    await this.sendRequest('setMuted', { callId, muted });
  }

  async sendDtmf(callId: string, digits: string): Promise<void> {
    await this.sendRequest('sendDtmf', { callId, digits });
  }

  async placeCall(to: string): Promise<string> {
    const destination = normalizePhone(to);
    if (!destination) throw new Error('Invalid phone number');
    const payload = await this.sendRequest('placeCall', {
      number: destination,
    });
    return JSON.stringify(payload);
  }

  async markFollowupForChat(
    chatJid: string,
    summary: string,
    requestedAction?: string,
  ): Promise<void> {
    const callId = this.activeCallByJid.get(chatJid);
    if (!callId) throw new Error(`No active call for ${chatJid}`);
    const session = this.sessionsByCallId.get(callId);
    if (!session) throw new Error(`Unknown phone voice session for ${chatJid}`);
    const handoff: VoiceHandoffRequest = {
      id: crypto.randomUUID(),
      kind: 'followup_summary',
      caller: { ...session.caller },
      sessionId: session.sessionId,
      summary: summary.trim(),
      requestedAction,
      priority: 'normal',
      createdAt: nowIso(),
    };
    session.deferredHandoffs.push(handoff);
    this.persistHandoff(handoff);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    const gatewayUrl = getGatewayUrl(this.settings);
    const apiKey = getApiKey(this.settings);
    if (!apiKey) {
      throw new Error('Phone voice API key is not configured');
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = openGatewaySocket(gatewayUrl, apiKey);
      let opened = false;

      socket.onopen = async () => {
        try {
          this.socket = socket;
          this.connected = true;
          this.connecting = true;
          await this.warmRuntime();
          const [gatewayState, dialerState] = await Promise.all([
            this.sendRequest('getGatewayState', {}),
            this.sendRequest('getDialerState', {}),
          ]);
          this.lastGatewaySnapshot = {
            gatewayState,
            dialerState,
          };
          opened = true;
          this.connecting = false;
          resolve();
        } catch (err) {
          this.connected = false;
          this.connecting = false;
          socket.close();
          reject(err);
        }
      };

      socket.onmessage = (event) => {
        try {
          this.handleSocketMessage(String(event.data || ''));
        } catch (err) {
          log.error({ err }, 'Phone voice websocket message handling failed');
        }
      };

      socket.onerror = () => {
        if (!opened) {
          this.connecting = false;
          reject(new Error('Phone voice websocket failed'));
        }
      };

      socket.onclose = () => {
        this.connected = false;
        this.connecting = false;
        this.socket = null;
        if (this.stopped) return;
        this.scheduleReconnect();
      };
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connecting = true;
      this.ensureConnected().catch((err) =>
        log.warn({ err }, 'Phone voice reconnect attempt failed'),
      );
    }, RECONNECT_DELAY_MS);
  }

  private async sendRequest(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    if (!this.socket)
      throw new Error('Phone voice gateway socket not connected');
    const requestId = `pv-${++this.requestCounter}`;
    const envelope = { type, requestId, payload };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Phone voice request timed out: ${type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.socket!.send(JSON.stringify(envelope));
    });
  }

  private handleSocketMessage(raw: string): void {
    const envelope = JSON.parse(raw) as PhoneVoiceEnvelope;
    if (envelope.requestId) {
      const pending = this.pendingRequests.get(envelope.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(envelope.requestId);
        if (envelope.ok === false) {
          pending.reject(
            new Error(
              String(
                envelope.payload?.error || envelope.type || 'request_failed',
              ),
            ),
          );
        } else {
          pending.resolve(envelope.payload || {});
        }
      }
      return;
    }

    const payload = envelope.payload || {};
    switch (envelope.type) {
      case 'gateway.state':
        this.lastGatewaySnapshot = {
          ...(this.lastGatewaySnapshot || {}),
          gatewayState: payload,
        };
        return;
      case 'dialer.state':
        this.lastGatewaySnapshot = {
          ...(this.lastGatewaySnapshot || {}),
          dialerState: payload,
        };
        return;
      case 'call.added':
        void this.handleCallAdded(payload);
        return;
      case 'call.updated':
        void this.handleCallUpdated(payload);
        return;
      case 'call.removed':
        void this.handleCallRemoved(payload);
        return;
      case 'audio.input':
        void this.handleAudioInput(payload);
        return;
      case 'transcript.partial':
        void this.handleTranscriptPartial(payload);
        return;
      case 'transcript.final':
        void this.handleTranscriptFinal(payload);
        return;
      default:
        return;
    }
  }

  private async handleCallAdded(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const caller = getCallerFromPayload(payload);
    const metadata = getCallMetadata(payload);
    if (!caller || !metadata) return;

    const allowed = parseAllowedNumbers(this.settings);
    const callerAllowed =
      allowsUnknownCallers(this.settings) ||
      allowed.size === 0 ||
      allowed.has(caller.phoneNumber);
    if (!callerAllowed) {
      log.info(
        { phoneNumber: caller.phoneNumber },
        'Rejecting inbound phone voice call from non-allowlisted caller',
      );
      if (metadata.direction !== 'outgoing') {
        await this.sendRequest('rejectCall', { callId: metadata.callId }).catch(
          () => undefined,
        );
      }
      return;
    }

    const chatJid = makeVoiceJid(caller.phoneNumber);
    this.ensureRegisteredVoiceChat(chatJid, caller.displayName);
    this.opts.onChatMetadata(
      chatJid,
      metadata.startedAt,
      caller.displayName,
      INTEGRATION_NAME,
      false,
    );
    storeChatMetadata(
      chatJid,
      metadata.startedAt,
      caller.displayName,
      INTEGRATION_NAME,
      false,
    );
    updateChatName(chatJid, caller.displayName);

    const sessionId =
      getPayloadString(payload, ['sessionId']) ||
      `${metadata.callId}:${Date.now().toString(36)}`;
    const session: CallSession = {
      callId: metadata.callId,
      sessionId,
      chatJid,
      caller,
      metadata,
      deferredHandoffs: [],
      runnerReady: null,
    };
    this.sessionsByCallId.set(metadata.callId, session);
    this.sessionsBySessionId.set(sessionId, session);
    this.activeCallByJid.set(chatJid, metadata.callId);

    session.runnerReady = this.runner.startSession(
      {
        sessionId,
        chatJid,
        caller,
        metadata,
        greeting:
          metadata.state === 'active'
            ? `Hi, this is ${ASSISTANT_NAME}. How can I help?`
            : undefined,
      },
      {
        onTranscriptFinal: async (event) => {
          await this.persistCallerTurn(session, event.text, event.timestamp);
        },
        onResponseTextDelta: () => undefined,
        onResponseAudioDelta: (event) => {
          const fallbackText =
            event.text ||
            (event.contentType.startsWith('text/')
              ? Buffer.from(event.dataBase64, 'base64').toString('utf8')
              : '');
          const requestType =
            event.contentType.startsWith('audio/') ||
            event.contentType === 'audio/pcm'
              ? 'assistant.audio'
              : 'assistant.speak';
          const payload =
            requestType === 'assistant.audio'
              ? {
                  callId: session.callId,
                  sessionId: session.sessionId,
                  dataBase64: event.dataBase64,
                  contentType: event.contentType,
                  text: fallbackText || undefined,
                }
              : {
                  callId: session.callId,
                  sessionId: session.sessionId,
                  text: fallbackText,
                  voice: String(this.settings.defaultVoice || 'alloy'),
                };
          void this.sendRequest(requestType, payload).catch((err) =>
            log.warn(
              { err, sessionId: session.sessionId },
              'Voice audio send failed',
            ),
          );
        },
        onResponseCancel: (event) => {
          void this.sendRequest('assistant.cancel', {
            callId: session.callId,
            sessionId: session.sessionId,
            reason: event.reason,
          }).catch(() => undefined);
        },
        onActionRequest: (event) => this.handleRunnerAction(session, event),
        onHandoffEnqueue: (handoff) => {
          session.deferredHandoffs.push(handoff);
          this.persistHandoff(handoff);
        },
        onFinalizedAgentTurn: async (event) => {
          await this.persistAgentTurn(session, event.text, event.timestamp);
        },
        onLatencySample: (sample) => {
          this.lastLatencySampleAt =
            sample.responseCompletedAt ||
            sample.responseCancelledAt ||
            sample.firstAudioOutAt ||
            sample.firstModelTextAt ||
            sample.userSpeechFinalAt ||
            nowIso();
          this.lastRuntimeHealth = {
            ...this.lastRuntimeHealth,
            ready: true,
          };
        },
      },
    );
    await session.runnerReady;
    session.runnerReady = null;
  }

  private async handleCallUpdated(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const metadata = getCallMetadata(payload);
    if (!metadata) return;
    const session = this.sessionsByCallId.get(metadata.callId);
    if (!session) return;
    await session.runnerReady;
    session.metadata = { ...session.metadata, ...metadata };
    await this.runner.updateSession({
      sessionId: session.sessionId,
      metadata,
    });
  }

  private async handleCallRemoved(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const callId = getPayloadString(payload, ['callId', 'id']);
    if (!callId) return;
    const session = this.sessionsByCallId.get(callId);
    if (!session) return;
    await session.runnerReady;
    await this.runner.endSession(session.sessionId);
    this.sessionsByCallId.delete(callId);
    this.sessionsBySessionId.delete(session.sessionId);
    if (this.activeCallByJid.get(session.chatJid) === callId) {
      this.activeCallByJid.delete(session.chatJid);
    }
    this.flushDeferredHandoffs(session);
  }

  private async handleTranscriptPartial(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = getPayloadString(payload, ['sessionId']);
    const session = this.sessionsBySessionId.get(sessionId);
    if (!session) return;
    await session.runnerReady;
    const text = getPayloadString(payload, ['text', 'partial']);
    if (!text) return;
    await this.runner.handleTranscriptPartial({
      sessionId,
      text,
      timestamp: getPayloadString(payload, ['timestamp']) || nowIso(),
    });
  }

  private async handleAudioInput(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = getPayloadString(payload, ['sessionId']);
    const session = this.sessionsBySessionId.get(sessionId);
    if (!session) return;
    await session.runnerReady;
    const dataBase64 = getPayloadString(payload, ['dataBase64', 'audioBase64']);
    if (!dataBase64) return;
    await this.runner.handleAudioInput({
      sessionId,
      dataBase64,
      contentType:
        getPayloadString(payload, ['contentType']) ||
        'application/octet-stream',
      timestamp: getPayloadString(payload, ['timestamp']) || nowIso(),
      sampleRateHz:
        typeof payload.sampleRateHz === 'number'
          ? payload.sampleRateHz
          : undefined,
      channels:
        typeof payload.channels === 'number' ? payload.channels : undefined,
      endOfTurn: payload.endOfTurn === true,
    });
  }

  private async handleTranscriptFinal(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = getPayloadString(payload, ['sessionId']);
    const session = this.sessionsBySessionId.get(sessionId);
    if (!session) return;
    await session.runnerReady;
    const text = getPayloadString(payload, ['text', 'final']);
    if (!text) return;
    const timestamp = getPayloadString(payload, ['timestamp']) || nowIso();
    await this.runner.handleTranscriptFinal({
      sessionId,
      text,
      timestamp,
      confidence:
        typeof payload.confidence === 'number' ? payload.confidence : undefined,
    });
  }

  private async handleRunnerAction(
    session: CallSession,
    event: VoiceActionRequest,
  ): Promise<void> {
    switch (event.action) {
      case 'end_call':
        await this.endCallById(session.callId);
        return;
      case 'set_mute':
        await this.setMute(session.callId, Boolean(event.args?.muted));
        return;
      case 'send_dtmf':
        await this.sendDtmf(
          session.callId,
          String(event.args?.digits || '').trim(),
        );
        return;
      case 'mark_followup':
        {
          const handoff: VoiceHandoffRequest = {
            id: crypto.randomUUID(),
            kind: 'followup_summary',
            caller: { ...session.caller },
            sessionId: session.sessionId,
            summary: String(event.args?.summary || event.reason || '').trim(),
            requestedAction:
              typeof event.args?.requestedAction === 'string'
                ? event.args.requestedAction
                : undefined,
            priority: 'normal',
            createdAt: nowIso(),
          };
          session.deferredHandoffs.push(handoff);
          this.persistHandoff(handoff);
        }
        return;
      case 'place_call':
        if (typeof event.args?.to === 'string' && event.args.to.trim()) {
          await this.placeCall(event.args.to);
        }
        return;
      default:
        return;
    }
  }

  private persistHandoff(handoff: VoiceHandoffRequest): void {
    this.handoffStore.enqueue(handoff);
  }

  private async persistCallerTurn(
    session: CallSession,
    text: string,
    timestamp: string,
  ): Promise<void> {
    const message: NewMessage = {
      id: makeMessageId('caller', session.sessionId),
      chat_jid: session.chatJid,
      sender: session.caller.phoneNumber,
      sender_name: session.caller.displayName,
      content: text,
      timestamp,
      is_from_me: false,
    };
    storeChatMetadata(
      session.chatJid,
      timestamp,
      session.caller.displayName,
      INTEGRATION_NAME,
      false,
    );
    storeMessageIfNew(message);
  }

  private async persistAgentTurn(
    session: CallSession,
    text: string,
    timestamp: string,
  ): Promise<void> {
    const message: NewMessage = {
      id: makeMessageId('assistant', session.sessionId),
      chat_jid: session.chatJid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    };
    storeChatMetadata(
      session.chatJid,
      timestamp,
      session.caller.displayName,
      INTEGRATION_NAME,
      false,
    );
    storeMessageIfNew(message);
  }

  private flushDeferredHandoffs(session: CallSession): void {
    for (const handoff of session.deferredHandoffs) {
      const message: NewMessage = {
        id: `${handoff.id}:deferred`,
        chat_jid: session.chatJid,
        sender: session.caller.phoneNumber,
        sender_name: session.caller.displayName,
        content: stringifyHandoff(handoff, session),
        timestamp: nowIso(),
        is_from_me: false,
      };
      this.opts.onMessage(session.chatJid, message);
      this.handoffStore.markDelivered(handoff.id);
    }
  }

  private drainBrowserSessionEvents(
    session: BrowserVoiceSession,
  ): BrowserVoiceSessionEvent[] {
    const drained = [...session.events];
    session.events = [];
    return drained;
  }

  private ensureRegisteredVoiceChat(
    chatJid: string,
    displayName: string,
  ): void {
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) return;
    const group: RegisteredGroup = {
      name: displayName,
      folder: deriveUniqueGroupFolder(
        displayName,
        Object.values(groups).map((candidate) => candidate.folder),
        chatJid,
      ),
      trigger: '',
      added_at: nowIso(),
      requiresTrigger: false,
    };
    groups[chatJid] = group;
    setRegisteredGroup(chatJid, group);
    const groupDir = resolveGroupFolderPath(group.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    ensureAgentMemoryFile(
      groupDir,
      path.join(GROUPS_DIR, 'global'),
      ASSISTANT_NAME,
    );
  }
}

let channelInstance: PhoneVoiceChannel | null = null;
let browserHarnessInstance: PhoneVoiceChannel | null = null;

export function getPhoneVoiceChannelInstance(): PhoneVoiceChannel | null {
  return channelInstance;
}

export function getPhoneVoiceBrowserHarness(
  settings?: Record<string, unknown>,
): PhoneVoiceChannel {
  const nextSettings = {
    ...(settings || getIntegrationSettings(INTEGRATION_NAME)),
    // Browser playback currently uses HTMLAudioElement, which is smooth with
    // one complete WAV but choppy with many tiny WAV chunks.
    voiceTtsStreaming: false,
  };
  if (!browserHarnessInstance) {
    browserHarnessInstance = new PhoneVoiceChannel(
      NOOP_CHANNEL_OPTS,
      nextSettings,
    );
  } else {
    browserHarnessInstance.refreshSettings(nextSettings);
  }
  return browserHarnessInstance;
}

export function resolvePhoneVoiceBrowserSessionChannel(
  sessionId: string,
  settings?: Record<string, unknown>,
): PhoneVoiceChannel {
  if (channelInstance?.ownsBrowserVoiceSession(sessionId)) {
    return channelInstance;
  }
  const harness = getPhoneVoiceBrowserHarness(settings);
  if (harness.ownsBrowserVoiceSession(sessionId)) {
    return harness;
  }
  throw new Error('Browser voice session not found');
}

const credentialStep: CredentialInputStep = {
  type: 'credential_input',
  label: 'Phone Voice API Key',
  description:
    'Paste the API key from the Android dialer companion or local phone voice gateway.',
  helpUrl: 'https://github.com/crockpotveggies/sms-socket-app',
  fields: [
    {
      key: API_KEY_SETTING,
      label: 'API Key',
      type: 'password',
      required: true,
    },
  ],
  validate: async (values) => {
    const apiKey = String(values[API_KEY_SETTING] || '').trim();
    if (!apiKey) return { valid: false, error: 'API key is required' };
    return { valid: true };
  },
  save: async (values) => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    saveIntegrationSettings(INTEGRATION_NAME, {
      ...settings,
      [API_KEY_SETTING]: String(values[API_KEY_SETTING] || '').trim(),
    });
    channelInstance?.refreshSettings(getIntegrationSettings(INTEGRATION_NAME));
  },
  isComplete: async () =>
    Boolean(getApiKey(getIntegrationSettings(INTEGRATION_NAME))),
};

export const phoneVoiceIntegration: IntegrationDefinition = {
  name: INTEGRATION_NAME,
  description:
    'Live phone-call voice integration with a warm low-latency runner and deferred post-call handoffs',
  core: false,
  version: '1.0.0',
  credentials: [
    {
      key: API_KEY_SETTING,
      label: 'Phone Voice API Key',
      type: 'api_key',
      envVar: API_KEY_SETTING,
      required: true,
    },
  ],
  settings: {
    schema: {
      type: 'object',
      properties: {
        [API_KEY_SETTING]: {
          type: 'string',
          title: 'Phone Voice API Key',
          description:
            'Stored locally for host-side phone voice gateway access.',
          sensitive: true,
        },
        gatewayUrl: {
          type: 'string',
          title: 'Gateway URL',
          description:
            'WebSocket URL for the Android dialer companion or phone voice gateway.',
          format: 'url',
          default: DEFAULT_GATEWAY_URL,
        },
        allowUnknownCallers: {
          type: 'boolean',
          title: 'Allow Unknown Callers',
          description:
            'If disabled, only numbers on the allowlist are admitted to the live voice runner.',
          default: false,
        },
        allowedNumbers: {
          type: 'string',
          title: 'Allowed Numbers',
          description:
            'Comma or newline separated E.164 numbers for allowlist-only admission mode.',
          format: 'textarea',
        },
        inputDeviceId: {
          type: 'string',
          title: 'Audio Input Device ID',
          description: 'Reserved for the local call microphone path.',
        },
        outputDeviceId: {
          type: 'string',
          title: 'Audio Output Device ID',
          description: 'Reserved for the local call speaker path.',
        },
        defaultVoice: {
          type: 'string',
          title: 'Default Voice',
          description:
            'Voice profile or speaker id used by the sidecar TTS path.',
          default: MANAGED_F5_TTS_DEFAULT_VOICE,
        },
        voiceRunnerProvider: {
          type: 'string',
          title: 'Voice Runner Provider',
          description:
            'Use the managed local OpenArc/Qwen service, a heuristic fast path, or an external OpenAI-compatible backend for text generation.',
          enum: ['managed_openarc', 'heuristic', 'openai'],
          enumLabels: [
            'Managed OpenArc Qwen 3 4B service',
            'Heuristic (lowest latency)',
            'External OpenAI-compatible backend',
          ],
          default: 'managed_openarc',
        },
        voiceRunnerMode: {
          type: 'string',
          title: 'Voice Runner Mode',
          description:
            'Run the live voice path in a resident sidecar process or inline for debugging.',
          enum: ['sidecar', 'in_process'],
          enumLabels: ['Resident sidecar process', 'In-process debug mode'],
          default: 'sidecar',
        },
        voiceRunnerBaseUrl: {
          type: 'string',
          title: 'Voice Runner Base URL',
          description:
            'OpenAI-compatible base URL for the live voice runner backend. Ignored when the managed OpenArc service is selected.',
          format: 'url',
          default: MANAGED_OPENARC_LLM_BASE_URL,
          dependsOn: { field: 'voiceRunnerProvider', value: 'openai' },
        },
        voiceRunnerApiKey: {
          type: 'string',
          title: 'Voice Runner API Key',
          description:
            'Optional override API key for the live voice runner backend.',
          sensitive: true,
          dependsOn: { field: 'voiceRunnerProvider', value: 'openai' },
        },
        voiceRunnerModel: {
          type: 'string',
          title: 'Voice Runner Model',
          description:
            'Low-latency chat model used only for the live runner. The managed path serves this name from the local OpenArc container.',
          default: MANAGED_OPENARC_LLM_MODEL,
        },
        voiceRunnerSystemPrompt: {
          type: 'string',
          title: 'LLM System Prompt',
          description:
            'Base system prompt sent to the live voice LLM for browser tests and real phone calls.',
          format: 'textarea',
          default:
            'You are a low-latency phone-call assistant. Keep replies short, spoken, and interruption-friendly. Never claim to browse files or use broad tools. If a request needs deep work, briefly acknowledge it and keep the call moving.',
        },
        voiceRunnerInstructions: {
          type: 'string',
          title: 'Live Call Instructions',
          description:
            'Additional operator instructions injected into each live voice LLM turn for browser tests and real phone calls.',
          format: 'textarea',
          default:
            'Sound natural and concise. Prefer one short sentence unless the caller clearly asks for detail. Ask at most one brief clarification question when needed.',
        },
        voiceRunnerFillersEnabled: {
          type: 'boolean',
          title: 'Latency Fillers',
          description:
            'Speak a canned filler if the LLM is slow. Off by default because repeated fillers make browser testing and short calls feel broken.',
          default: false,
        },
        voiceRunnerFillers: {
          type: 'string',
          title: 'Latency Filler Phrases',
          description:
            'Optional newline-separated filler phrases used only when Latency Fillers is on. Keep them very short, for example: hmmm',
          format: 'textarea',
          default: DEFAULT_VOICE_RUNNER_FILLERS,
          dependsOn: { field: 'voiceRunnerFillersEnabled', value: true },
        },
        voiceSttProvider: {
          type: 'string',
          title: 'Speech-to-Text Provider',
          description:
            'Use the managed local Whisper service, the experimental streaming STT WebSocket service, an external OpenAI-compatible endpoint, or a mock path for testing.',
          enum: ['managed_openvino', 'managed_stream', 'openai', 'mock'],
          enumLabels: [
            'Managed OpenVINO Whisper service',
            'Managed streaming Whisper (WebSocket)',
            'External OpenAI-compatible transcription API',
            'Mock/test transcriber',
          ],
          default: 'managed_openvino',
        },
        voiceStreamSttBaseUrl: {
          type: 'string',
          title: 'Streaming STT Base URL',
          description:
            'HTTP base URL for the streaming STT service. The WebSocket URL is derived from it (e.g. ws://host:8794/v1/stt/stream).',
          format: 'url',
          default: MANAGED_STREAM_STT_BASE_URL,
          dependsOn: { field: 'voiceSttProvider', value: 'managed_stream' },
        },
        voiceSttTargetDevice: {
          type: 'string',
          title: 'Managed STT Device',
          description:
            'OpenVINO target for the managed Whisper container. AUTO prefers the B580 and falls back to CPU.',
          enum: ['AUTO:GPU,CPU', 'GPU', 'CPU'],
          enumLabels: ['AUTO (GPU then CPU)', 'GPU only', 'CPU only'],
          default: 'AUTO:GPU,CPU',
          dependsOn: { field: 'voiceSttProvider', value: 'managed_openvino' },
        },
        voiceSttQuantization: {
          type: 'string',
          title: 'Managed STT Weights',
          description:
            'INT8 is the best default for the B580; FP16 is available if you want to trade memory for simplicity.',
          enum: ['int8', 'fp16'],
          enumLabels: ['INT8', 'FP16'],
          default: 'int8',
          dependsOn: { field: 'voiceSttProvider', value: 'managed_openvino' },
        },
        voiceSttBaseUrl: {
          type: 'string',
          title: 'STT Base URL',
          description:
            'OpenAI-compatible base URL for speech-to-text. Ignored when the managed local Whisper service is selected.',
          format: 'url',
          default: OPENAI_BASE_URL,
          dependsOn: { field: 'voiceSttProvider', value: 'openai' },
        },
        voiceSttApiKey: {
          type: 'string',
          title: 'STT API Key',
          description: 'Optional override API key for speech-to-text.',
          sensitive: true,
          dependsOn: { field: 'voiceSttProvider', value: 'openai' },
        },
        voiceSttModel: {
          type: 'string',
          title: 'STT Model',
          description:
            'Transcription model used by the live sidecar or managed Whisper service.',
          default: MANAGED_OPENVINO_STT_MODEL,
        },
        voiceTtsProvider: {
          type: 'string',
          title: 'Text-to-Speech Provider',
          description:
            'Synthesize the assistant audio locally with the managed F5-TTS Arc stack, or keep a mock path for testing.',
          enum: ['managed_f5_tts', 'mock', 'openai'],
          enumLabels: [
            'Managed F5-TTS XPU service',
            'Mock/test synthesizer',
            'OpenAI-compatible speech API',
          ],
          default: 'managed_f5_tts',
        },
        voiceTtsBaseUrl: {
          type: 'string',
          title: 'TTS Base URL',
          description: 'OpenAI-compatible base URL for text-to-speech.',
          format: 'url',
          default: OPENAI_BASE_URL,
          dependsOn: { field: 'voiceTtsProvider', value: 'openai' },
        },
        voiceTtsApiKey: {
          type: 'string',
          title: 'TTS API Key',
          description: 'Optional override API key for text-to-speech.',
          sensitive: true,
          dependsOn: { field: 'voiceTtsProvider', value: 'openai' },
        },
        voiceTtsModel: {
          type: 'string',
          title: 'TTS Model',
          description:
            'Managed F5-TTS model identifier or the external speech API model name.',
          default: MANAGED_F5_TTS_MODEL,
        },
        voiceTtsDeviceTarget: {
          type: 'string',
          title: 'Managed TTS Device',
          description:
            'Preferred runtime target for the managed F5-TTS service. XPU is the intended fast path for the B580.',
          enum: ['auto', 'xpu', 'cpu'],
          enumLabels: ['AUTO (XPU then CPU)', 'XPU only', 'CPU only'],
          default: MANAGED_F5_TTS_DEVICE_TARGET,
          dependsOn: {
            field: 'voiceTtsProvider',
            value: 'managed_f5_tts',
          },
        },
        voiceTtsResponseFormat: {
          type: 'string',
          title: 'TTS Output Format',
          description:
            'Prefer WAV for simple low-latency wiring; PCM is fastest if the gateway supports it.',
          enum: ['wav', 'pcm', 'mp3'],
          enumLabels: ['WAV', 'PCM', 'MP3'],
          default: 'wav',
          dependsOn: { field: 'voiceTtsProvider', value: 'openai' },
        },
        voiceAudioInputContentType: {
          type: 'string',
          title: 'Audio Input Content Type',
          description:
            'Default audio MIME type for raw audio chunks from the gateway.',
          default: 'audio/wav',
        },
        voiceAudioSampleRateHz: {
          type: 'number',
          title: 'Audio Input Sample Rate',
          description:
            'Default sample rate used when the gateway sends raw PCM audio chunks.',
          default: 16000,
          minimum: 8000,
          maximum: 48000,
        },
        voiceAudioChannels: {
          type: 'number',
          title: 'Audio Input Channels',
          description:
            'Default channel count used when the gateway sends raw PCM audio chunks.',
          default: 1,
          minimum: 1,
          maximum: 2,
        },
      },
      required: [API_KEY_SETTING],
    },
    defaults: {
      gatewayUrl: DEFAULT_GATEWAY_URL,
      allowUnknownCallers: false,
      allowedNumbers: '',
      inputDeviceId: '',
      outputDeviceId: '',
      defaultVoice: MANAGED_F5_TTS_DEFAULT_VOICE,
      voiceRunnerProvider: 'managed_openarc',
      voiceRunnerMode: 'sidecar',
      voiceRunnerBaseUrl: MANAGED_OPENARC_LLM_BASE_URL,
      voiceRunnerApiKey: '',
      voiceRunnerModel: MANAGED_OPENARC_LLM_MODEL,
      voiceRunnerSystemPrompt:
        'You are a low-latency phone-call assistant. Keep replies short, spoken, and interruption-friendly. Never claim to browse files or use broad tools. If a request needs deep work, briefly acknowledge it and keep the call moving.',
      voiceRunnerInstructions:
        'Sound natural and concise. Prefer one short sentence unless the caller clearly asks for detail. Ask at most one brief clarification question when needed.',
      voiceRunnerFillersEnabled: false,
      voiceRunnerFillers: DEFAULT_VOICE_RUNNER_FILLERS,
      voiceSttProvider: 'managed_stream',
      voiceSttTargetDevice: 'AUTO:GPU,CPU',
      voiceSttQuantization: 'int8',
      voiceSttBaseUrl: MANAGED_OPENVINO_STT_BASE_URL,
      voiceSttApiKey: '',
      voiceSttModel: MANAGED_OPENVINO_STT_MODEL,
      voiceStreamSttBaseUrl: MANAGED_STREAM_STT_BASE_URL,
      voiceTtsProvider: 'managed_f5_tts',
      voiceTtsBaseUrl: MANAGED_F5_TTS_BASE_URL,
      voiceTtsApiKey: '',
      voiceTtsModel: MANAGED_F5_TTS_MODEL,
      voiceTtsDeviceTarget: MANAGED_F5_TTS_DEVICE_TARGET,
      voiceTtsResponseFormat: 'wav',
      voiceAudioInputContentType: 'audio/wav',
      voiceAudioSampleRateHz: 16000,
      voiceAudioChannels: 1,
    },
  },
  service: {
    composeFile: 'scripts/phone-voice-stt/docker-compose.yml',
    projectName: MANAGED_SPEECH_PROJECT_NAME,
    envFile: 'scripts/phone-voice-stt/.env',
    serviceName: 'phone-voice-stt',
    autoStart: false,
    buildEnv: buildManagedSpeechEnv,
    healthCheck: {
      url: MANAGED_OPENVINO_STT_HEALTH_URL,
      intervalMs: 15_000,
    },
  },
  adminPage: {
    icon: 'cilPhone',
    category: 'messaging',
    getStatus: async (ctx) => {
      const apiKey = getApiKey(ctx.settings);
      const managedLlm = usesManagedOpenArcLlm(ctx.settings);
      const managedStt =
        usesManagedOpenVinoStt(ctx.settings) ||
        usesManagedStreamStt(ctx.settings);
      const managedTts = usesManagedF5Tts(ctx.settings);
      const serviceStatus = usesManagedSpeechServices(ctx.settings)
        ? getServiceStatus(INTEGRATION_NAME)
        : null;
      if (!apiKey) {
        return {
          state: 'unconfigured',
          message: 'Phone voice API key not configured',
          serviceRunning: serviceStatus?.running,
        };
      }
      const health = channelInstance
        ? await channelInstance
            .refreshRuntimeHealth()
            .catch(() => channelInstance?.getRuntimeHealth() || undefined)
        : undefined;
      const pendingHandoffs = channelInstance?.getPendingHandoffCount() || 0;
      const lastLatency = channelInstance?.getLastLatencySampleAt();
      const ttsReady = managedTts ? await isManagedF5TtsReady() : true;
      const llmReady = managedLlm
        ? await isManagedOpenArcLlmReady(ctx.settings)
        : true;
      if (channelInstance?.isConnected()) {
        const runnerReady = Boolean(health?.ready);
        const sttReady = !managedStt || Boolean(serviceStatus?.running);
        return {
          state:
            runnerReady && sttReady && ttsReady && llmReady
              ? 'online'
              : 'degraded',
          message:
            runnerReady && sttReady && ttsReady && llmReady
              ? `Connected to phone voice gateway; runner ${health?.mode || 'unknown'}:${health?.backend || 'unknown'}; managed LLM ${managedLlm ? 'hot' : 'external'}; managed STT ${managedStt ? 'hot' : 'external'}; managed TTS ${managedTts ? 'hot' : 'external'}; pending handoffs ${pendingHandoffs}${lastLatency ? `; latency sample ${lastLatency}` : ''}`
              : managedLlm && !llmReady
                ? 'Connected to phone voice gateway; managed OpenArc Qwen LLM container is still starting'
                : managedStt && !sttReady
                  ? 'Connected to phone voice gateway; managed Whisper STT container is still starting'
                  : managedTts && !ttsReady
                    ? 'Connected to phone voice gateway; managed F5-TTS container is still starting'
                    : 'Connected to phone voice gateway; live runner still warming',
          serviceRunning: serviceStatus?.running,
        };
      }
      return {
        state: 'offline',
        message: usesManagedSpeechServices(ctx.settings)
          ? `Configured but not connected to ${getGatewayUrl(ctx.settings)}; managed speech services are ${serviceStatus?.running ? 'running' : 'offline'}`
          : `Configured but not connected to ${getGatewayUrl(ctx.settings)}`,
        serviceRunning: serviceStatus?.running,
      };
    },
    getNotifications: async (ctx) => {
      const notifications: IntegrationNotification[] = [];
      const managedLlm = usesManagedOpenArcLlm(ctx.settings);
      const managedStt =
        usesManagedOpenVinoStt(ctx.settings) ||
        usesManagedStreamStt(ctx.settings);
      const managedTts = usesManagedF5Tts(ctx.settings);
      const serviceStatus = usesManagedSpeechServices(ctx.settings)
        ? getServiceStatus(INTEGRATION_NAME)
        : null;
      if (!getApiKey(ctx.settings)) {
        notifications.push({
          id: 'phone-voice:missing-api-key',
          integration: INTEGRATION_NAME,
          severity: 'warning',
          title: 'Phone Voice Not Configured',
          message:
            'Add the phone voice API key from the Android companion or gateway setup page.',
        });
        return notifications;
      }
      if (managedStt && !serviceStatus?.running) {
        notifications.push({
          id: 'phone-voice:managed-stt-offline',
          integration: INTEGRATION_NAME,
          severity: 'error',
          title: 'Managed Whisper STT Offline',
          message:
            'The managed local Whisper speech-to-text container is not running yet. Reconnect the integration or review the service logs.',
        });
      }
      if (managedLlm && !(await isManagedOpenArcLlmReady(ctx.settings))) {
        notifications.push({
          id: 'phone-voice:managed-llm-offline',
          integration: INTEGRATION_NAME,
          severity: 'error',
          title: 'Managed OpenArc LLM Offline',
          message:
            'The managed local OpenArc Qwen container is not running or has not loaded the tiny voice model yet.',
        });
      }
      if (managedTts && !(await isManagedF5TtsReady())) {
        notifications.push({
          id: 'phone-voice:managed-tts-offline',
          integration: INTEGRATION_NAME,
          severity: 'error',
          title: 'Managed F5-TTS Offline',
          message:
            'The managed F5-TTS container is not running yet. Reconnect the integration or review the service logs.',
        });
      }
      if (!channelInstance?.isConnected()) {
        notifications.push({
          id: 'phone-voice:offline',
          integration: INTEGRATION_NAME,
          severity: 'error',
          title: 'Phone Voice Offline',
          message:
            'The phone voice gateway is not reachable. Check the gateway URL, the companion app, and the local network path.',
        });
      }
      const health = channelInstance?.getRuntimeHealth();
      if (channelInstance?.isConnected() && health && !health.ready) {
        notifications.push({
          id: 'phone-voice:runner-warming',
          integration: INTEGRATION_NAME,
          severity: 'warning',
          title: 'Phone Voice Runner Warming',
          message:
            'The phone voice sidecar is connected but not yet ready for the low-latency path.',
        });
      }
      return notifications;
    },
  },
  channel: (opts: ChannelOpts) => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    if (!getApiKey(settings)) return null;
    channelInstance = new PhoneVoiceChannel(opts, settings);
    return channelInstance;
  },
  tools: [
    {
      name: 'voice_end_call',
      description:
        'End the currently active phone-voice call for the current voice chat.',
      parameters: {
        type: 'object',
        properties: {},
      },
      location: 'host',
      execute: async (_args, ctx) => {
        if (!ctx.chatJid?.startsWith('voice:')) {
          throw new Error('voice_end_call requires an active phone voice chat');
        }
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as PhoneVoiceChannel | undefined;
        if (!channel) throw new Error('Phone voice channel is not connected');
        await channel.endCallByJid(ctx.chatJid);
        return JSON.stringify({ ok: true });
      },
    },
    {
      name: 'voice_set_mute',
      description: 'Mute or unmute the active phone-voice call.',
      parameters: {
        type: 'object',
        properties: {
          muted: {
            type: 'boolean',
            description: 'True to mute, false to unmute.',
          },
        },
        required: ['muted'],
      },
      location: 'host',
      execute: async (args, ctx) => {
        if (!ctx.chatJid?.startsWith('voice:')) {
          throw new Error('voice_set_mute requires an active phone voice chat');
        }
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as PhoneVoiceChannel | undefined;
        if (!channel) throw new Error('Phone voice channel is not connected');
        const callId = channel.getActiveCallId(ctx.chatJid);
        if (!callId) throw new Error('No active phone voice call');
        await channel.setMute(callId, Boolean(args.muted));
        return JSON.stringify({ ok: true, muted: Boolean(args.muted) });
      },
    },
    {
      name: 'voice_send_dtmf',
      description: 'Send DTMF digits on the active phone-voice call.',
      parameters: {
        type: 'object',
        properties: {
          digits: {
            type: 'string',
            description: 'Digits to send, such as 1234#.',
          },
        },
        required: ['digits'],
      },
      location: 'host',
      execute: async (args, ctx) => {
        if (!ctx.chatJid?.startsWith('voice:')) {
          throw new Error(
            'voice_send_dtmf requires an active phone voice chat',
          );
        }
        const digits = String(args.digits || '').trim();
        if (!digits) throw new Error('digits is required');
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as PhoneVoiceChannel | undefined;
        if (!channel) throw new Error('Phone voice channel is not connected');
        const callId = channel.getActiveCallId(ctx.chatJid);
        if (!callId) throw new Error('No active phone voice call');
        await channel.sendDtmf(callId, digits);
        return JSON.stringify({ ok: true, digits });
      },
    },
    {
      name: 'voice_mark_followup',
      description:
        'Queue a structured post-call follow-up for the main runtime without blocking the live call.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'What needs to happen after the call.',
          },
          requested_action: {
            type: 'string',
            description: 'Optional explicit action to attach to the follow-up.',
          },
        },
        required: ['summary'],
      },
      location: 'host',
      execute: async (args, ctx) => {
        if (!ctx.chatJid?.startsWith('voice:')) {
          throw new Error(
            'voice_mark_followup requires an active phone voice chat',
          );
        }
        const summary = String(args.summary || '').trim();
        if (!summary) throw new Error('summary is required');
        const requestedAction =
          String(args.requested_action || '').trim() || undefined;
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as PhoneVoiceChannel | undefined;
        if (!channel) throw new Error('Phone voice channel is not connected');
        await channel.markFollowupForChat(
          ctx.chatJid,
          summary,
          requestedAction,
        );
        return JSON.stringify({ ok: true });
      },
    },
    {
      name: 'voice_place_call',
      description:
        'Place an outbound phone call through the Android companion.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Phone number to call in E.164 format.',
          },
        },
        required: ['to'],
      },
      location: 'host',
      controllerOnly: true,
      execute: async (args, ctx) => {
        const to = String(args.to || '').trim();
        if (!to) throw new Error('to is required');
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as PhoneVoiceChannel | undefined;
        if (!channel) throw new Error('Phone voice channel is not connected');
        return channel.placeCall(to);
      },
    },
  ],
  setup: {
    steps: [credentialStep],
    getStatus: async () => {
      const completed = await credentialStep.isComplete();
      return {
        completed,
        currentStep: completed ? 1 : 0,
        steps: [
          {
            type: 'credential_input',
            label: credentialStep.label,
            description:
              'Paste the API key from the Android dialer companion or phone voice gateway.',
            status: completed ? 'completed' : 'pending',
          },
        ],
      };
    },
  },
  lifecycle: {
    onEnable: async () => {
      return;
    },
    onReconnect: async (ctx) => {
      if (!channelInstance) {
        throw new Error('Phone voice channel is not initialized');
      }
      channelInstance.refreshSettings(ctx.settings);
      await channelInstance.disconnect();
      await channelInstance.connect();
    },
    onSettingsChange: async (prev, next) => {
      const enabled = isIntegrationEnabled(INTEGRATION_NAME);
      if (usesManagedSpeechServices(prev) && !usesManagedSpeechServices(next)) {
        stopService(INTEGRATION_NAME);
      } else if (
        enabled &&
        usesManagedSpeechServices(next) &&
        (!usesManagedSpeechServices(prev) ||
          shouldRestartManagedStt(prev, next) ||
          shouldRestartManagedTts(prev, next) ||
          shouldRestartManagedLlm(prev, next))
      ) {
        void ensureManagedSpeechServices(next).catch((err) =>
          log.warn({ err }, 'Phone voice managed speech restart failed'),
        );
      }
      channelInstance?.refreshSettings(next);
      if (enabled) {
        void channelInstance
          ?.warmRuntime()
          .catch((err) =>
            log.warn(
              { err },
              'Phone voice runtime warmup failed after settings change',
            ),
          );
      }
    },
    onDisable: async () => {
      await channelInstance?.shutdown();
      try {
        stopService(INTEGRATION_NAME);
      } catch {
        // Ignore stop errors when the managed STT service was never started.
      }
    },
  },
};

registerIntegration(phoneVoiceIntegration);
