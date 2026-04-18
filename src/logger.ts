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

import pino from 'pino';

import { createJsonlLogStream } from './logger/jsonl-stream.js';
import { createSqliteLogStream } from './logger/sqlite-stream.js';

// ---------------------------------------------------------------------------
// Resolve STORE_DIR without importing config.js (avoids circular import)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const STORE_DIR_RESOLVED = path.resolve(PROJECT_ROOT, 'store');

// ---------------------------------------------------------------------------
// Pino instance
// ---------------------------------------------------------------------------

const isTest =
  process.env.NODE_ENV === 'test' ||
  typeof (globalThis as Record<string, unknown>).vi !== 'undefined';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_DB_PATH = path.join(STORE_DIR_RESOLVED, 'logs.db');
const LOG_JSONL_PATH = path.resolve(PROJECT_ROOT, 'logs', 'live.jsonl');

type LogPersistenceMode = 'sqlite' | 'jsonl-fallback' | 'stdout-only';

let logPersistenceInfo: {
  mode: LogPersistenceMode;
  sqlitePath: string;
  jsonlPath?: string;
} = {
  mode: 'stdout-only',
  sqlitePath: LOG_DB_PATH,
};

let pinoInstance: pino.Logger;

if (isTest) {
  // In tests: silent pino, no transports
  pinoInstance = pino({ level: 'silent' });
} else {
  try {
    const sqliteStream = createSqliteLogStream({
      dbPath: LOG_DB_PATH,
      minLevel: process.env.LOG_SQLITE_MIN_LEVEL || 'info',
    });
    const stdoutStream = pino.destination(1);

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
      pino.multistream([{ stream: stdoutStream }, { stream: sqliteStream }]),
    );
    logPersistenceInfo = {
      mode: 'sqlite',
      sqlitePath: LOG_DB_PATH,
    };
  } catch (err) {
    process.stderr.write(
      `[WARN] SQLite logger disabled: ${err instanceof Error ? err.message : err}\n`,
    );
    try {
      const jsonlStream = createJsonlLogStream({
        filePath: LOG_JSONL_PATH,
      });
      const stdoutStream = pino.destination(1);
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
        pino.multistream([{ stream: stdoutStream }, { stream: jsonlStream }]),
      );
      logPersistenceInfo = {
        mode: 'jsonl-fallback',
        sqlitePath: LOG_DB_PATH,
        jsonlPath: LOG_JSONL_PATH,
      };
      process.stderr.write(
        `[WARN] Falling back to JSONL log persistence at ${LOG_JSONL_PATH}\n`,
      );
    } catch (fallbackErr) {
      process.stderr.write(
        `[WARN] JSONL logger disabled: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}\n`,
      );
      pinoInstance = pino({ level: LOG_LEVEL });
      logPersistenceInfo = {
        mode: 'stdout-only',
        sqlitePath: LOG_DB_PATH,
      };
    }
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

export function getLogPersistenceInfo(): {
  mode: LogPersistenceMode;
  sqlitePath: string;
  jsonlPath?: string;
} {
  return { ...logPersistenceInfo };
}

// ---------------------------------------------------------------------------
// Uncaught error handlers
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  try {
    logger.fatal({ err }, 'Uncaught exception');
  } catch {
    // If logger itself is broken (e.g., transport worker died), fall back to stderr
    process.stderr.write(
      `[FATAL] Uncaught exception: ${err?.message || err}\n`,
    );
  }
  setTimeout(() => process.exit(1), 200);
});

process.on('unhandledRejection', (reason) => {
  try {
    logger.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'Unhandled rejection',
    );
  } catch {
    process.stderr.write(`[ERROR] Unhandled rejection: ${reason}\n`);
  }
});
