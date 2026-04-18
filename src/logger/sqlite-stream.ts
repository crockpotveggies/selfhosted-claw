import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';

import Database from 'better-sqlite3';

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const LEVEL_NUMBERS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const INDEXED_KEYS = new Set([
  'integration',
  'channel',
  'group_folder',
  'entity',
  'run_id',
  'tool',
]);

export interface SqliteLogStreamOptions {
  dbPath?: string;
  minLevel?: string;
  flushIntervalMs?: number;
  flushSize?: number;
}

const sharedDatabases = new Map<string, Database.Database>();

function initializeDatabase(dbPath: string): Database.Database {
  const existing = sharedDatabases.get(dbPath);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    db.pragma('journal_mode = DELETE');
  }
  try {
    db.pragma('synchronous = NORMAL');
  } catch {
    // Keep SQLite default if the underlying mount rejects this pragma.
  }

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
      tool TEXT,
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

  try {
    db.exec(`ALTER TABLE logs ADD COLUMN tool TEXT`);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_tool ON logs(tool)`);
  } catch {
    // Index already exists
  }

  sharedDatabases.set(dbPath, db);
  return db;
}

export function withSqliteLogDatabase<T>(
  dbPath: string,
  callback: (db: Database.Database) => T,
): T {
  const resolved = path.resolve(dbPath);
  const shared = sharedDatabases.get(resolved);
  if (shared) {
    return callback(shared);
  }

  const db = initializeDatabase(resolved);
  return callback(db);
}

export function resetSqliteLogDatabaseForTests(dbPath?: string): void {
  const targets = dbPath
    ? [path.resolve(dbPath)]
    : [...sharedDatabases.keys()];
  for (const target of targets) {
    const db = sharedDatabases.get(target);
    if (!db) continue;
    sharedDatabases.delete(target);
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export function createSqliteLogStream(options: SqliteLogStreamOptions = {}) {
  const dbPath = path.resolve(options.dbPath || path.join('store', 'logs.db'));
  const minLevelNum = LEVEL_NUMBERS[options.minLevel || 'info'] ?? 30;
  const flushSize = options.flushSize ?? 50;
  const flushIntervalMs = options.flushIntervalMs ?? 100;

  const db = initializeDatabase(dbPath);
  const insert = db.prepare(`
    INSERT INTO logs (time, level, level_label, msg, integration, channel, group_folder, entity, run_id, tool, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const buffer: unknown[][] = [];

  function flush(): void {
    if (buffer.length === 0) {
      return;
    }
    const batch = buffer.splice(0, buffer.length);
    const txn = db.transaction(() => {
      for (const row of batch) {
        insert.run(...row);
      }
    });
    txn();
  }

  const flushTimer = setInterval(flush, flushIntervalMs);

  function cleanup(): void {
    flush();
    clearInterval(flushTimer);
    if (sharedDatabases.get(dbPath) !== db) {
      try {
        db.close();
      } catch {
        // Already closed
      }
    }
  }

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const lines = text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        for (const line of lines) {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const level = typeof obj.level === 'number' ? obj.level : 30;
          if (level < minLevelNum) {
            continue;
          }

          const levelLabel = PINO_LEVELS[level] || 'info';
          const msg = typeof obj.msg === 'string' ? obj.msg : '';
          const time =
            typeof obj.time === 'number'
              ? new Date(obj.time).toISOString()
              : new Date().toISOString();

          const integration =
            typeof obj.integration === 'string' ? obj.integration : null;
          const channel = typeof obj.channel === 'string' ? obj.channel : null;
          const groupFolder =
            typeof obj.group_folder === 'string' ? obj.group_folder : null;
          const entity = typeof obj.entity === 'string' ? obj.entity : null;
          const runId = typeof obj.run_id === 'string' ? obj.run_id : null;
          const tool = typeof obj.tool === 'string' ? obj.tool : null;

          const data: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(obj)) {
            if (
              key === 'level' ||
              key === 'time' ||
              key === 'msg' ||
              key === 'pid' ||
              key === 'hostname' ||
              INDEXED_KEYS.has(key)
            ) {
              continue;
            }
            data[key] = value;
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
            tool,
            Object.keys(data).length > 0 ? JSON.stringify(data) : null,
          ]);

          if (buffer.length >= flushSize) {
            flush();
          }
        }
      } catch {
        // Do not break application logging because of malformed rows.
      }

      callback();
    },
    final(callback) {
      cleanup();
      callback();
    },
  });

  process.on('beforeExit', cleanup);

  return stream;
}
