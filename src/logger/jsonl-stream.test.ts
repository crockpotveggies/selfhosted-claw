import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createJsonlLogStream,
  filterLogRows,
  readJsonlLogRows,
  summarizeLogRows,
} from './jsonl-stream.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('jsonl log stream', () => {
  it('writes newline-delimited JSON log rows to a fallback file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-jsonl-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'live.jsonl');
    const stream = createJsonlLogStream({ filePath });

    stream.write(
      `${JSON.stringify({
        level: 30,
        time: Date.parse('2026-04-18T18:00:00.000Z'),
        msg: 'jsonl fallback smoke test',
        integration: 'signal',
        extra: 'field',
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    stream.end();

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('jsonl fallback smoke test');
  });

  it('reads, filters, and summarizes fallback log rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-jsonl-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'live.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          level: 30,
          time: Date.parse('2026-04-18T18:00:00.000Z'),
          msg: 'signal info event',
          integration: 'signal',
        }),
        JSON.stringify({
          level: 50,
          time: Date.parse('2026-04-18T18:05:00.000Z'),
          msg: 'calendar auth failed',
          integration: 'google-calendar',
          tool: 'calendar_check_availability',
        }),
      ].join('\n'),
      'utf8',
    );

    const rows = readJsonlLogRows(filePath);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBeLessThan(0);

    const filtered = filterLogRows(rows, {
      integration: 'google-calendar',
      minLevel: 40,
      q: 'auth failed',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tool).toBe('calendar_check_availability');

    expect(summarizeLogRows(rows)).toEqual({
      total: 2,
      byLevel: {
        info: 1,
        error: 1,
      },
      byIntegration: {
        signal: 1,
        'google-calendar': 1,
      },
    });
  });
});
