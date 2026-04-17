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
  'SIGNAL_ACCOUNT',
  'SIGNAL_RPC_URL',
  'SIGNAL_RECEIVE_TIMEOUT_SEC',
  'CONTROL_SIGNAL_JID',
  'ADMIN_BIND_HOST',
  'ADMIN_PORT',
  'ADMIN_UI_TOKEN',
  'ADMIN_UI_USERNAME',
  'SELF_HOSTED_CLAW_ADMIN_CONFIG_DIR',
  'SELF_HOSTED_CLAW_ADMIN_DATA_DIR',
  'INBOUND_GUARD_SCRIPT',
  'ENABLE_NEW_ACTION_ENGINE',
  'ENABLE_RUNSPEC_RUNNERS',
  'ENABLE_PRINCIPAL_POLICY',
  'ENABLE_SKILL_REGISTRY_V2',
  'ENABLE_CONTEXT_ASSEMBLER',
  'ENABLE_DEDUPE_V2',
  'ENABLE_HOT_RUNNER_CONTAINERS',
  'HOT_RUNNER_POOL_MIN_IDLE',
  'HOT_RUNNER_POOL_MAX_SIZE',
  'HOT_RUNNER_POOL_IDLE_TTL_MS',
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
export const MOUNT_ROOT = path.resolve(
  process.env.SELF_HOSTED_CLAW_MOUNT_ROOT || PROJECT_ROOT,
);

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
export const ADMIN_CONFIG_DIR = path.resolve(
  process.env.SELF_HOSTED_CLAW_ADMIN_CONFIG_DIR ||
    envConfig.SELF_HOSTED_CLAW_ADMIN_CONFIG_DIR ||
    path.join(HOME_DIR, '.config', 'self-hosted-claw'),
);
export const ADMIN_DATA_DIR = path.resolve(
  process.env.SELF_HOSTED_CLAW_ADMIN_DATA_DIR ||
    envConfig.SELF_HOSTED_CLAW_ADMIN_DATA_DIR ||
    path.join(HOME_DIR, '.local', 'share', 'self-hosted-claw'),
);

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
  process.env.SIGNAL_RPC_URL ||
  envConfig.SIGNAL_RPC_URL ||
  'http://127.0.0.1:8080';
export const SIGNAL_ACCOUNT =
  process.env.SIGNAL_ACCOUNT || envConfig.SIGNAL_ACCOUNT || '';
export const CONTROL_SIGNAL_JID =
  process.env.CONTROL_SIGNAL_JID || envConfig.CONTROL_SIGNAL_JID || '';
export const SIGNAL_RECEIVE_TIMEOUT_SEC = Math.max(
  1,
  parseInt(
    process.env.SIGNAL_RECEIVE_TIMEOUT_SEC ||
      envConfig.SIGNAL_RECEIVE_TIMEOUT_SEC ||
      '5',
    10,
  ) || 5,
);
export const ADMIN_BIND_HOST =
  process.env.ADMIN_BIND_HOST || envConfig.ADMIN_BIND_HOST || '127.0.0.1';
export const ADMIN_PORT = Math.max(
  1,
  parseInt(process.env.ADMIN_PORT || envConfig.ADMIN_PORT || '3030', 10) ||
    3030,
);
export const ADMIN_UI_TOKEN =
  process.env.ADMIN_UI_TOKEN || envConfig.ADMIN_UI_TOKEN || '';
export const ADMIN_UI_USERNAME =
  process.env.ADMIN_UI_USERNAME || envConfig.ADMIN_UI_USERNAME || 'admin';
export const ADMIN_PENDING_ACTION_TTL_MS = 15 * 60 * 1000;
export const INBOUND_GUARD_SCRIPT =
  process.env.INBOUND_GUARD_SCRIPT ||
  envConfig.INBOUND_GUARD_SCRIPT ||
  path.resolve(PROJECT_ROOT, 'scripts', 'inbound-message-guard.mjs');

function readBooleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name] ?? envConfig[name];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const ENABLE_NEW_ACTION_ENGINE = readBooleanEnv(
  'ENABLE_NEW_ACTION_ENGINE',
  false,
);
export const ENABLE_RUNSPEC_RUNNERS = readBooleanEnv(
  'ENABLE_RUNSPEC_RUNNERS',
  false,
);
export const ENABLE_PRINCIPAL_POLICY = readBooleanEnv(
  'ENABLE_PRINCIPAL_POLICY',
  false,
);
export const ENABLE_SKILL_REGISTRY_V2 = readBooleanEnv(
  'ENABLE_SKILL_REGISTRY_V2',
  false,
);
export const ENABLE_CONTEXT_ASSEMBLER = readBooleanEnv(
  'ENABLE_CONTEXT_ASSEMBLER',
  false,
);
export const ENABLE_DEDUPE_V2 = readBooleanEnv('ENABLE_DEDUPE_V2', false);
export const ENABLE_HOT_RUNNER_CONTAINERS = readBooleanEnv(
  'ENABLE_HOT_RUNNER_CONTAINERS',
  false,
);
export const HOT_RUNNER_POOL_MIN_IDLE = Math.max(
  0,
  parseInt(
    process.env.HOT_RUNNER_POOL_MIN_IDLE ||
      envConfig.HOT_RUNNER_POOL_MIN_IDLE ||
      '1',
    10,
  ) || 1,
);
export const HOT_RUNNER_POOL_MAX_SIZE = Math.max(
  1,
  parseInt(
    process.env.HOT_RUNNER_POOL_MAX_SIZE ||
      envConfig.HOT_RUNNER_POOL_MAX_SIZE ||
      '2',
    10,
  ) || 2,
);
export const HOT_RUNNER_POOL_IDLE_TTL_MS = Math.max(
  1000,
  parseInt(
    process.env.HOT_RUNNER_POOL_IDLE_TTL_MS ||
      envConfig.HOT_RUNNER_POOL_IDLE_TTL_MS ||
      '300000',
    10,
  ) || 300000,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  const trimmed = trigger.trim();
  // If the trigger starts with '@', make the '@' optional so bare name also matches
  if (trimmed.startsWith('@')) {
    const name = escapeRegex(trimmed.slice(1));
    return new RegExp(`^@?${name}\\b`, 'i');
  }
  return new RegExp(`^${escapeRegex(trimmed)}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  if (!normalizedTrigger) {
    // Default trigger: match "@Name" or bare "Name" at the start of message
    const name = escapeRegex(ASSISTANT_NAME.trim());
    return new RegExp(`^@?${name}\\b`, 'i');
  }
  return buildTriggerPattern(normalizedTrigger);
}

export const TRIGGER_PATTERN = getTriggerPattern();

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
