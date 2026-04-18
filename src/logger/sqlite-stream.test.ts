import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSqliteLogStream,
  resetSqliteLogDatabaseForTests,
} from './sqlite-stream.js';

const tempDirs: string[] = [];

afterEach(() => {
  resetSqliteLogDatabaseForTests();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createSqliteLogStream', () => {
  it('persists newline-delimited log rows to sqlite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-logs-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'logs.db');
    const stream = createSqliteLogStream({
      dbPath,
      flushIntervalMs: 10,
      flushSize: 1,
    });

    stream.write(
      `${JSON.stringify({
        level: 30,
        time: Date.parse('2026-04-18T12:00:00.000Z'),
        msg: 'sqlite stream smoke test',
        integration: 'calendar',
        extra: 'field',
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    stream.end();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        'select msg, integration, data from logs where msg = ? order by id desc limit 1',
      )
      .get('sqlite stream smoke test') as
      | { msg: string; integration: string | null; data: string | null }
      | undefined;
    db.close();

    expect(row?.msg).toBe('sqlite stream smoke test');
    expect(row?.integration).toBe('calendar');
    expect(row?.data).toContain('"extra":"field"');
  });
});
