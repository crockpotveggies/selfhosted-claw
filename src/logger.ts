/**
 * Structured logger — Pino with console + SQLite transports.
 *
 * API is identical to the previous custom logger:
 *   logger.info({ key: val }, 'message')
 *   logger.error('simple string message')
 *
 * All ~17 files that import { logger } from './logger.js' need zero changes.
 */

import path from 'path';
import { fileURLToPath } from 'url';

import pino from 'pino';

// ---------------------------------------------------------------------------
// Resolve STORE_DIR without importing config.js (avoids circular import)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const STORE_DIR_RESOLVED = path.resolve(PROJECT_ROOT, 'store');

// ---------------------------------------------------------------------------
// Pino instance
// ---------------------------------------------------------------------------

const isDev =
  process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
const isTest =
  process.env.NODE_ENV === 'test' ||
  typeof (globalThis as Record<string, unknown>).vi !== 'undefined';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_DB_PATH = path.join(STORE_DIR_RESOLVED, 'logs.db');

let pinoInstance: pino.Logger;

if (isTest) {
  // In tests: silent pino, no transports
  pinoInstance = pino({ level: 'silent' });
} else {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const sqliteTransportPath = path.join(
      __dirname,
      'logger',
      'sqlite-transport.js',
    );

    const targets: pino.TransportTargetOptions[] = [];

    if (isDev) {
      targets.push({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
        level: LOG_LEVEL,
      });
    } else {
      targets.push({
        target: 'pino/file',
        options: { destination: 1 },
        level: LOG_LEVEL,
      });
    }

    targets.push({
      target: sqliteTransportPath,
      options: {
        dbPath: LOG_DB_PATH,
        minLevel: process.env.LOG_SQLITE_MIN_LEVEL || 'info',
      },
      level: 'debug',
    });

    pinoInstance = pino(
      {
        level: LOG_LEVEL === 'trace' ? 'trace' : 'debug',
        redact: {
          paths: [
            '*.apiKey',
            '*.token',
            '*.secret',
            '*.password',
            '*.OPENAI_API_KEY',
          ],
          censor: '[REDACTED]',
        },
        serializers: {
          err: pino.stdSerializers.err,
        },
      },
      pino.transport({ targets }),
    );
  } catch {
    pinoInstance = pino({ level: LOG_LEVEL });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const logger = pinoInstance;

export function createChildLogger(
  bindings: Record<string, unknown>,
): pino.Logger {
  return pinoInstance.child(bindings);
}

// ---------------------------------------------------------------------------
// Uncaught error handlers
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  setTimeout(() => process.exit(1), 200);
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason : new Error(String(reason)) },
    'Unhandled rejection',
  );
});
