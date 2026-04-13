import fs from 'fs';
import path from 'path';

import { ADMIN_CONFIG_DIR } from '../config.js';
import { logger } from '../logger.js';

import { getIntegration } from './registry.js';

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

// ---------------------------------------------------------------------------
// Settings store — per-integration JSON persistence
// ---------------------------------------------------------------------------

const baseDir = () => path.join(ADMIN_CONFIG_DIR, 'integrations');

function integrationDir(integrationName: string): string {
  return path.join(baseDir(), integrationName);
}

function settingsPath(integrationName: string): string {
  return path.join(integrationDir(integrationName), 'settings.json');
}

function statePath(integrationName: string): string {
  return path.join(integrationDir(integrationName), 'state.json');
}

function groupSettingsPath(
  integrationName: string,
  groupFolder: string,
): string {
  return path.join(
    integrationDir(integrationName),
    'groups',
    `${groupFolder}.json`,
  );
}

// ---------------------------------------------------------------------------
// Default resolution
// ---------------------------------------------------------------------------

function getDefaults(integrationName: string): Record<string, unknown> {
  const def = getIntegration(integrationName);
  return def?.settings?.defaults ?? {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getIntegrationSettings(
  integrationName: string,
): Record<string, unknown> {
  const defaults = getDefaults(integrationName);
  const saved = readJsonFile<Record<string, unknown>>(
    settingsPath(integrationName),
    {},
  );
  return { ...defaults, ...saved };
}

export function saveIntegrationSettings(
  integrationName: string,
  values: Record<string, unknown>,
): void {
  const def = getIntegration(integrationName);
  if (def?.settings?.validate) {
    const errors = def.settings.validate(values);
    if (errors) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }
  }
  writeJsonFile(settingsPath(integrationName), values);
  logger.info({ integration: integrationName }, 'Integration settings saved');
}

export function getIntegrationGroupSettings(
  integrationName: string,
  groupFolder: string,
): Record<string, unknown> {
  const global = getIntegrationSettings(integrationName);
  const groupOverrides = readJsonFile<Record<string, unknown>>(
    groupSettingsPath(integrationName, groupFolder),
    {},
  );
  return { ...global, ...groupOverrides };
}

export function saveIntegrationGroupSettings(
  integrationName: string,
  groupFolder: string,
  values: Record<string, unknown>,
): void {
  writeJsonFile(groupSettingsPath(integrationName, groupFolder), values);
  logger.info(
    { integration: integrationName, group: groupFolder },
    'Integration group settings saved',
  );
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

interface IntegrationState {
  enabled: boolean;
  updatedAt: string;
}

export function isIntegrationEnabled(integrationName: string): boolean {
  const def = getIntegration(integrationName);
  // Core integrations are always enabled.
  if (def?.core) return true;

  const state = readJsonFile<IntegrationState>(statePath(integrationName), {
    enabled: false,
    updatedAt: '',
  });
  return state.enabled;
}

export function setIntegrationEnabled(
  integrationName: string,
  enabled: boolean,
): void {
  const def = getIntegration(integrationName);
  if (def?.core) {
    throw new Error(`Cannot disable core integration: ${integrationName}`);
  }
  writeJsonFile(statePath(integrationName), {
    enabled,
    updatedAt: new Date().toISOString(),
  });
  logger.info(
    { integration: integrationName, enabled },
    'Integration state changed',
  );
}
