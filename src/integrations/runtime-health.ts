import fs from 'fs';
import path from 'path';

import { ADMIN_CONFIG_DIR } from '../config.js';

import type {
  IntegrationNotification,
  IntegrationStatus,
} from './types.js';

export type IntegrationRuntimeFaultCategory =
  | 'auth'
  | 'network'
  | 'permission'
  | 'unknown';

export interface IntegrationRuntimeFault {
  tool?: string;
  message: string;
  category: IntegrationRuntimeFaultCategory;
  lastOccurredAt: string;
}

interface StoredRuntimeHealth {
  fault?: IntegrationRuntimeFault | null;
}

function integrationDir(integrationName: string): string {
  return path.join(ADMIN_CONFIG_DIR, 'integrations', integrationName);
}

function runtimeHealthPath(integrationName: string): string {
  return path.join(integrationDir(integrationName), 'runtime-health.json');
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tempPath, payload, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err.code === 'EBUSY' || err.code === 'EPERM')
    ) {
      fs.writeFileSync(filePath, payload, { mode: 0o600 });
      return;
    }
    throw err;
  }
}

export function classifyIntegrationToolFailure(
  message: string,
): IntegrationRuntimeFaultCategory {
  const normalized = message.toLowerCase();
  if (
    /\b401\b/.test(normalized) ||
    normalized.includes('invalid credentials') ||
    normalized.includes('invalid_grant') ||
    normalized.includes('unauthenticated') ||
    normalized.includes('token has been expired or revoked') ||
    normalized.includes('expired or revoked') ||
    normalized.includes('oauth')
  ) {
    return 'auth';
  }
  if (
    normalized.includes('fetch failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('etimedout') ||
    normalized.includes('enotfound') ||
    normalized.includes('network') ||
    normalized.includes('timeout')
  ) {
    return 'network';
  }
  if (
    normalized.includes('forbidden') ||
    normalized.includes('permission denied') ||
    normalized.includes('not authorized') ||
    normalized.includes('unauthorized') ||
    normalized.includes('restricted to')
  ) {
    return 'permission';
  }
  return 'unknown';
}

export function getIntegrationRuntimeFault(
  integrationName: string,
): IntegrationRuntimeFault | null {
  const state = readJsonFile<StoredRuntimeHealth>(
    runtimeHealthPath(integrationName),
    {},
  );
  return state.fault || null;
}

export function recordIntegrationRuntimeFault(
  integrationName: string,
  input: {
    tool?: string;
    message: string;
    category?: IntegrationRuntimeFaultCategory;
  },
): void {
  writeJsonFile(runtimeHealthPath(integrationName), {
    fault: {
      tool: input.tool,
      message: input.message,
      category: input.category || classifyIntegrationToolFailure(input.message),
      lastOccurredAt: new Date().toISOString(),
    },
  } satisfies StoredRuntimeHealth);
}

export function clearIntegrationRuntimeFault(integrationName: string): void {
  const filePath = runtimeHealthPath(integrationName);
  if (!fs.existsSync(filePath)) return;
  writeJsonFile(filePath, { fault: null } satisfies StoredRuntimeHealth);
}

function formatIntegrationLabel(integrationName: string): string {
  return integrationName
    .split('-')
    .map((part) =>
      part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part,
    )
    .join(' ');
}

export function buildIntegrationRuntimeFaultNotification(
  integrationName: string,
  fault: IntegrationRuntimeFault,
): IntegrationNotification {
  const label = formatIntegrationLabel(integrationName);
  const toolLabel = fault.tool ? ` from ${fault.tool}` : '';

  if (fault.category === 'auth') {
    return {
      id: `${integrationName}:runtime-auth`,
      integration: integrationName,
      severity: 'error',
      title: `${label} authorization expired`,
      message: `The last tool call${toolLabel} failed with an authentication error. Reconnect the integration. Last error: ${fault.message}`,
    };
  }

  return {
    id: `${integrationName}:runtime-fault`,
    integration: integrationName,
    severity: fault.category === 'permission' ? 'warning' : 'error',
    title: `${label} tool error`,
    message: `The last tool call${toolLabel} failed: ${fault.message}`,
  };
}

export function applyIntegrationRuntimeFaultToStatus(
  status: IntegrationStatus,
  fault: IntegrationRuntimeFault | null,
): IntegrationStatus {
  if (!fault || fault.category !== 'auth') {
    return status;
  }
  if (status.state === 'unconfigured') {
    return status;
  }

  return {
    ...status,
    state: 'degraded',
    message:
      'Authentication failed during the last tool call. Reconnect the integration.',
  };
}
