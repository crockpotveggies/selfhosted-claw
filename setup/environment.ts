/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { SignalComposeManager } from '../src/signal-compose.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();

  // Check Apple Container
  let appleContainer: 'installed' | 'not_found' = 'not_found';
  if (commandExists('container')) {
    appleContainer = 'installed';
  }

  // Check Docker
  let docker: 'running' | 'installed_not_running' | 'not_found' = 'not_found';
  if (commandExists('docker')) {
    try {
      const { execSync } = await import('child_process');
      execSync('docker info', { stdio: 'ignore' });
      docker = 'running';
    } catch {
      docker = 'installed_not_running';
    }
  }

  const signalCompose = new SignalComposeManager().getStatus();
  const envVars = readEnvFile([
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
    'SIGNAL_ACCOUNT',
    'SIGNAL_RPC_URL',
  ]);
  const hasOpenAIConfig = !!(
    process.env.OPENAI_BASE_URL ||
    envVars.OPENAI_BASE_URL ||
    process.env.OPENAI_MODEL ||
    envVars.OPENAI_MODEL
  );
  const hasSignalConfig = !!(
    process.env.SIGNAL_ACCOUNT ||
    envVars.SIGNAL_ACCOUNT ||
    process.env.SIGNAL_RPC_URL ||
    envVars.SIGNAL_RPC_URL
  );

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  let hasRegisteredGroups = false;
  // Check JSON file first (pre-migration)
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) {
    hasRegisteredGroups = true;
  } else {
    // Check SQLite directly using better-sqlite3 (no sqlite3 CLI needed)
    const dbPath = path.join(STORE_DIR, 'messages.db');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare('SELECT COUNT(*) as count FROM registered_groups')
          .get() as { count: number };
        if (row.count > 0) hasRegisteredGroups = true;
        db.close();
      } catch {
        // Table might not exist yet
      }
    }
  }

  logger.info(
    {
      platform,
      wsl,
      appleContainer,
      docker,
      signalComposeConfigured: signalCompose.configured,
      signalComposeRunning: signalCompose.running,
      hasEnv,
      hasAuth,
      hasOpenAIConfig,
      hasSignalConfig,
      hasRegisteredGroups,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    SIGNAL_COMPOSE_CONFIGURED: signalCompose.configured,
    SIGNAL_COMPOSE_RUNNING: signalCompose.running,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_OPENAI_CONFIG: hasOpenAIConfig,
    HAS_SIGNAL_CONFIG: hasSignalConfig,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
