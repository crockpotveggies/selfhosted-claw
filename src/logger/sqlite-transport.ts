/**
 * Pino transport that writes structured log entries to SQLite.
 *
 * Runs in a Pino worker thread. Opens its own Database connection
 * with WAL mode for safe concurrent access (main thread queries via
 * a separate read-only connection).
 *
 * Usage in pino config:
 *   transport: { target: './logger/sqlite-transport.js', options: { dbPath: 'store/logs.db' } }
 */

import path from 'path';
import fs from 'fs';
import { Transform } from 'stream';

import Database from 'better-sqlite3';

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

// Minimum pino numeric level to write (set via options.minLevel)
const LEVEL_NUMBERS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// Known keys that get their own indexed column
const INDEXED_KEYS = new Set([
  'integration',
  'channel',
  'group_folder',
  'entity',
  'run_id',
]);

interface TransportOptions {
  dbPath?: string;
  minLevel?: string;
}

export default function buildTransport(options: TransportOptions) {
  const dbPath = path.resolve(
    options.dbPath || path.join('store', 'logs.db'),
  );

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      level INTEGER NOT NULL,
      level_label TEXT NOT NULL,
      msg TEXT NOT NULL DEFAULT '',
      integration TEXT,
      channel TEXT,
      group_folder TEXT,
      entity TEXT,
      run_id TEXT,
      data TEXT,
      created_at REAL DEFAULT (unixepoch('subsec'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(time);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
    CREATE INDEX IF NOT EXISTS idx_logs_integration ON logs(integration);
    CREATE INDEX IF NOT EXISTS idx_logs_group ON logs(group_folder);
    CREATE INDEX IF NOT EXISTS idx_logs_entity ON logs(entity);
    CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id);
  `);

  const insert = db.prepare(`
    INSERT INTO logs (time, level, level_label, msg, integration, channel, group_folder, entity, run_id, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const minLevelNum = LEVEL_NUMBERS[options.minLevel || 'info'] ?? 30;

  // Batch buffer for performance
  const buffer: unknown[][] = [];
  const FLUSH_SIZE = 50;
  const FLUSH_INTERVAL_MS = 100;

  function flush(): void {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const txn = db.transaction(() => {
      for (const row of batch) {
        insert.run(...row);
      }
    });
    txn();
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  const transport = new Transform({
    objectMode: true,
    transform(chunk, _encoding, callback) {
      try {
        const obj =
          typeof chunk === 'string' ? JSON.parse(chunk) : chunk;

        const level = obj.level as number;
        if (level < minLevelNum) {
          callback();
          return;
        }

        const levelLabel = PINO_LEVELS[level] || 'info';
        const msg = (obj.msg as string) || '';
        const time = obj.time
          ? new Date(obj.time as number).toISOString()
          : new Date().toISOString();

        // Extract indexed keys
        const integration =
          (obj.integration as string) || null;
        const channel = (obj.channel as string) || null;
        const groupFolder =
          (obj.group_folder as string) || null;
        const entity = (obj.entity as string) || null;
        const runId = (obj.run_id as string) || null;

        // Everything else goes to data blob
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (
            k === 'level' ||
            k === 'time' ||
            k === 'msg' ||
            k === 'pid' ||
            k === 'hostname' ||
            INDEXED_KEYS.has(k)
          ) {
            continue;
          }
          data[k] = v;
        }

        buffer.push([
          time,
          level,
          levelLabel,
          msg,
          integration,
          channel,
          groupFolder,
          entity,
          runId,
          Object.keys(data).length > 0
            ? JSON.stringify(data)
            : null,
        ]);

        if (buffer.length >= FLUSH_SIZE) {
          flush();
        }
      } catch {
        // Swallow parse errors — don't crash the transport
      }
      callback();
    },
    flush(callback) {
      flush();
      clearInterval(flushTimer);
      db.close();
      callback();
    },
  });

  // Ensure cleanup on process exit
  process.on('beforeExit', () => {
    flush();
    clearInterval(flushTimer);
    try {
      db.close();
    } catch {
      // Already closed
    }
  });

  return transport;
}
