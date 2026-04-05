import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_MAX_TOKENS',
  'OPENAI_TEMPERATURE',
  'OPENAI_CONTEXT_WINDOW',
  'ONECLI_URL',
  'SIGNAL_ACCOUNT',
  'SIGNAL_RPC_URL',
  'SIGNAL_RECEIVE_TIMEOUT_SEC',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL ||
  envConfig.OPENAI_BASE_URL ||
  'http://127.0.0.1:8000/v1';
export const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || envConfig.OPENAI_API_KEY || '';
export const OPENAI_MODEL =
  process.env.OPENAI_MODEL || envConfig.OPENAI_MODEL || 'local-model';
export const OPENAI_MAX_TOKENS = Math.max(
  256,
  parseInt(
    process.env.OPENAI_MAX_TOKENS || envConfig.OPENAI_MAX_TOKENS || '4096',
    10,
  ) || 4096,
);
export const OPENAI_TEMPERATURE = Number.parseFloat(
  process.env.OPENAI_TEMPERATURE || envConfig.OPENAI_TEMPERATURE || '0.2',
);
export const OPENAI_CONTEXT_WINDOW = Math.max(
  OPENAI_MAX_TOKENS,
  parseInt(
    process.env.OPENAI_CONTEXT_WINDOW ||
      envConfig.OPENAI_CONTEXT_WINDOW ||
      '24000',
    10,
  ) || 24000,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const SIGNAL_RPC_URL =
  process.env.SIGNAL_RPC_URL || envConfig.SIGNAL_RPC_URL || 'http://127.0.0.1:8080';
export const SIGNAL_ACCOUNT =
  process.env.SIGNAL_ACCOUNT || envConfig.SIGNAL_ACCOUNT || '';
export const SIGNAL_RECEIVE_TIMEOUT_SEC = Math.max(
  1,
  parseInt(
    process.env.SIGNAL_RECEIVE_TIMEOUT_SEC ||
      envConfig.SIGNAL_RECEIVE_TIMEOUT_SEC ||
      '5',
    10,
  ) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
