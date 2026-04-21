import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

import { getIntegrationsWithService, getIntegration } from './registry.js';
import {
  getIntegrationSettings,
  isIntegrationEnabled,
} from './settings-store.js';
import type {
  IntegrationDefinition,
  IntegrationService,
  ServiceHealthState,
} from './types.js';

// ---------------------------------------------------------------------------
// Docker Compose runner (same pattern as SignalComposeManager)
// ---------------------------------------------------------------------------

interface ComposeResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export type ComposeRunner = (args: string[], cwd: string) => ComposeResult;

const defaultRunner: ComposeRunner = (args, cwd) => {
  const composeBin = process.env.SELF_HOSTED_CLAW_COMPOSE_BIN || 'docker';
  const command =
    composeBin === 'docker-compose' ? 'docker-compose' : composeBin;
  const finalArgs =
    composeBin === 'docker-compose' ? args : ['compose', ...args];
  const result = spawnSync(command, finalArgs, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
};

// ---------------------------------------------------------------------------
// Env file writer
// ---------------------------------------------------------------------------

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
  fs.writeFileSync(filePath, `${content}\n`, { mode: 0o600 });
}

function isComposeRecreateError(message: string): boolean {
  return /needs to be recreated|has changed/i.test(message);
}

function buildComposeArgs(
  composeFile: string,
  envFile: string,
  commandArgs: string[],
  projectName?: string,
): string[] {
  return [
    ...(projectName ? ['-p', projectName] : []),
    '-f',
    composeFile,
    '--env-file',
    envFile,
    ...commandArgs,
  ];
}

// ---------------------------------------------------------------------------
// Service status
// ---------------------------------------------------------------------------

export interface ServiceStatus {
  integrationName: string;
  serviceName: string;
  configured: boolean;
  running: boolean;
  lastError: string;
  circuitOpen: boolean;
}

// ---------------------------------------------------------------------------
// Service manager
// ---------------------------------------------------------------------------

const healthStates = new Map<string, ServiceHealthState>();

const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
const CIRCUIT_OPEN_THRESHOLD = 10;

let runner: ComposeRunner = defaultRunner;
let healthInterval: ReturnType<typeof setInterval> | null = null;

/** Override the compose runner (for testing). */
export function setComposeRunner(r: ComposeRunner): void {
  runner = r;
}

function getHealthState(name: string): ServiceHealthState {
  let state = healthStates.get(name);
  if (!state) {
    state = {
      consecutiveFailures: 0,
      lastRestartAttempt: 0,
      backoffMs: INITIAL_BACKOFF_MS,
      circuitOpen: false,
    };
    healthStates.set(name, state);
  }
  return state;
}

function resetHealthState(name: string): void {
  healthStates.set(name, {
    consecutiveFailures: 0,
    lastRestartAttempt: 0,
    backoffMs: INITIAL_BACKOFF_MS,
    circuitOpen: false,
  });
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Start a service.
 *
 * @param integrationName — integration to start
 * @param bootstrapInput — if provided, used directly to build .env instead
 *                          of reading from settings store. Used during first-time setup.
 */
export function startService(
  integrationName: string,
  bootstrapInput?: Record<string, string>,
): ServiceStatus {
  const def = getIntegration(integrationName);
  if (!def?.service) {
    throw new Error(`Integration '${integrationName}' has no service`);
  }

  const svc = def.service;
  const composeFile = path.resolve(svc.composeFile);
  const composeDir = path.dirname(composeFile);

  // Build env values from bootstrap input or stored settings
  let envValues: Record<string, string>;
  if (bootstrapInput) {
    envValues = svc.buildEnv(bootstrapInput);
  } else {
    const settings = getIntegrationSettings(integrationName);
    envValues = svc.buildEnv(settings);
  }

  // Write .env file (resolve relative to project root, not compose dir)
  const envFile = svc.envFile
    ? path.resolve(svc.envFile)
    : path.join(composeDir, '.env');
  writeEnvFile(envFile, envValues);

  // Start via docker compose
  let result = runner(
    buildComposeArgs(composeFile, envFile, ['up', '-d'], svc.projectName),
    composeDir,
  );

  if (
    result.status !== 0 &&
    isComposeRecreateError(result.stderr || result.stdout || '')
  ) {
    runner(
      buildComposeArgs(composeFile, envFile, ['down'], svc.projectName),
      composeDir,
    );
    result = runner(
      buildComposeArgs(composeFile, envFile, ['up', '-d'], svc.projectName),
      composeDir,
    );
  }

  if (result.status !== 0) {
    const msg = (
      result.stderr ||
      result.stdout ||
      'docker compose up failed'
    ).trim();
    logger.error(
      { integration: integrationName, error: msg },
      'Service start failed',
    );
    throw new Error(msg);
  }

  // Reset circuit breaker on successful start
  resetHealthState(integrationName);

  logger.info({ integration: integrationName }, 'Service started');
  return getServiceStatus(integrationName);
}

export function stopService(integrationName: string): ServiceStatus {
  const def = getIntegration(integrationName);
  if (!def?.service) {
    throw new Error(`Integration '${integrationName}' has no service`);
  }

  const svc = def.service;
  const composeFile = path.resolve(svc.composeFile);
  const composeDir = path.dirname(composeFile);
  const envFile = svc.envFile
    ? path.resolve(svc.envFile)
    : path.join(composeDir, '.env');

  const args = svc.projectName
    ? ['-p', svc.projectName, '-f', composeFile]
    : ['-f', composeFile];
  if (fs.existsSync(envFile)) {
    args.push('--env-file', envFile);
  }
  args.push('down');

  const result = runner(args, composeDir);

  if (result.status !== 0) {
    logger.warn(
      { integration: integrationName, stderr: result.stderr?.trim() },
      'Service stop may have had issues',
    );
  }

  logger.info({ integration: integrationName }, 'Service stopped');
  return getServiceStatus(integrationName);
}

export function getServiceStatus(integrationName: string): ServiceStatus {
  const def = getIntegration(integrationName);
  if (!def?.service) {
    return {
      integrationName,
      serviceName: '',
      configured: false,
      running: false,
      lastError: 'No service defined',
      circuitOpen: false,
    };
  }

  const svc = def.service;
  const composeFile = path.resolve(svc.composeFile);
  const composeDir = path.dirname(composeFile);
  const envFile = svc.envFile
    ? path.resolve(svc.envFile)
    : path.join(composeDir, '.env');

  let running = false;
  let lastError = '';

  if (fs.existsSync(composeFile) && fs.existsSync(envFile)) {
    const result = runner(
      [
        ...(svc.projectName ? ['-p', svc.projectName] : []),
        '-f',
        composeFile,
        '--env-file',
        envFile,
        'ps',
        '-q',
        svc.serviceName,
      ],
      composeDir,
    );
    if (result.status === 0) {
      running = result.stdout.trim().length > 0;
    } else {
      lastError = (
        result.stderr ||
        result.stdout ||
        'docker compose ps failed'
      ).trim();
    }
  }

  const health = getHealthState(integrationName);

  return {
    integrationName,
    serviceName: svc.serviceName,
    configured: fs.existsSync(composeFile) && fs.existsSync(envFile),
    running,
    lastError,
    circuitOpen: health.circuitOpen,
  };
}

// ---------------------------------------------------------------------------
// Startup: ensure all configured services are running
// ---------------------------------------------------------------------------

export async function ensureServicesRunning(): Promise<void> {
  const integrations = getIntegrationsWithService();
  for (const def of integrations) {
    if (!isIntegrationEnabled(def.name)) continue;
    if (def.service?.autoStart === false) {
      logger.debug(
        { integration: def.name },
        'Service auto-start disabled; skipping global startup sweep',
      );
      continue;
    }

    const settings = getIntegrationSettings(def.name);

    // Check if settings have enough data to start (non-empty values)
    const envValues = def.service!.buildEnv(settings);
    const hasRequiredValues = Object.values(envValues).some(
      (v) => v && v.trim() !== '',
    );

    if (!hasRequiredValues) {
      logger.info(
        { integration: def.name },
        'Service settings incomplete — skipping auto-start (setup required)',
      );
      continue;
    }

    const status = getServiceStatus(def.name);
    if (status.running) {
      logger.debug({ integration: def.name }, 'Service already running');
      continue;
    }

    try {
      startService(def.name);
    } catch (err) {
      logger.error(
        { integration: def.name, err: String(err) },
        'Failed to auto-start service',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Health monitor with circuit breaker
// ---------------------------------------------------------------------------

async function checkServiceHealth(
  def: IntegrationDefinition,
): Promise<boolean> {
  const svc = def.service!;
  const { url, method = 'GET', expectStatus = 200 } = svc.healthCheck;

  try {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(5000),
    });
    return response.status === expectStatus || response.status < 500;
  } catch {
    return false;
  }
}

async function runHealthChecks(): Promise<void> {
  const integrations = getIntegrationsWithService();
  for (const def of integrations) {
    if (!isIntegrationEnabled(def.name)) continue;

    const status = getServiceStatus(def.name);
    if (!status.configured) continue;

    const health = getHealthState(def.name);

    // Skip if circuit is open
    if (health.circuitOpen) continue;

    const isHealthy = await checkServiceHealth(def);

    if (isHealthy) {
      if (health.consecutiveFailures > 0) {
        logger.info(
          { integration: def.name },
          'Service recovered — health check passed',
        );
      }
      resetHealthState(def.name);
      continue;
    }

    // Unhealthy
    health.consecutiveFailures++;

    if (health.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
      health.circuitOpen = true;
      logger.error(
        {
          integration: def.name,
          failures: health.consecutiveFailures,
        },
        'Circuit breaker OPEN — stopping restart attempts. Manual restart required.',
      );
      continue;
    }

    // Check backoff
    const now = Date.now();
    if (now - health.lastRestartAttempt < health.backoffMs) {
      continue; // Not time to retry yet
    }

    logger.warn(
      {
        integration: def.name,
        failures: health.consecutiveFailures,
        backoffMs: health.backoffMs,
      },
      'Service unhealthy — attempting restart',
    );

    health.lastRestartAttempt = now;
    health.backoffMs = Math.min(health.backoffMs * 2, MAX_BACKOFF_MS);

    try {
      startService(def.name);
      // startService resets health state on success
    } catch (err) {
      logger.error(
        { integration: def.name, err: String(err) },
        'Restart attempt failed',
      );
    }
  }
}

export function startHealthMonitor(): void {
  if (healthInterval) return;

  // Find the shortest health check interval across all integrations
  const intervals = getIntegrationsWithService()
    .map((d) => d.service!.healthCheck.intervalMs ?? 30_000)
    .filter((v) => v > 0);
  const interval = intervals.length > 0 ? Math.min(...intervals) : 30_000;

  healthInterval = setInterval(() => {
    void runHealthChecks();
  }, interval);

  logger.info({ intervalMs: interval }, 'Service health monitor started');
}

export function stopHealthMonitor(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

/**
 * Reset the circuit breaker for a specific integration.
 * Called when user manually starts a service from the admin UI.
 */
export function resetCircuitBreaker(integrationName: string): void {
  resetHealthState(integrationName);
  logger.info({ integration: integrationName }, 'Circuit breaker reset');
}
