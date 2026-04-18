import fs from 'fs';
import path from 'path';

export interface JsonlLogStreamOptions {
  filePath?: string;
}

export interface PersistedLogRow {
  id: number;
  time: string;
  level: number;
  level_label: string;
  msg: string;
  integration: string | null;
  channel: string | null;
  group_folder: string | null;
  entity: string | null;
  run_id: string | null;
  tool: string | null;
  data: string | null;
}

export interface LogQueryFilters {
  integration?: string;
  group?: string;
  minLevel?: number;
  since?: string;
  until?: string;
  entity?: string;
  runId?: string;
  q?: string;
}

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const INDEXED_KEYS = new Set([
  'integration',
  'channel',
  'group_folder',
  'entity',
  'run_id',
  'tool',
]);

export function createJsonlLogStream(options: JsonlLogStreamOptions = {}) {
  const filePath = path.resolve(
    options.filePath || path.join('logs', 'live.jsonl'),
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return fs.createWriteStream(filePath, {
    flags: 'a',
    encoding: 'utf8',
    mode: 0o600,
  });
}

function mapRawLogObject(
  obj: Record<string, unknown>,
  sequence: number,
): PersistedLogRow {
  const level = typeof obj.level === 'number' ? obj.level : 30;
  const levelLabel = PINO_LEVELS[level] || 'info';
  const msg = typeof obj.msg === 'string' ? obj.msg : '';
  const time =
    typeof obj.time === 'number'
      ? new Date(obj.time).toISOString()
      : typeof obj.time === 'string'
        ? obj.time
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

  return {
    id: -sequence,
    time,
    level,
    level_label: levelLabel,
    msg,
    integration,
    channel,
    group_folder: groupFolder,
    entity,
    run_id: runId,
    tool,
    data: Object.keys(data).length > 0 ? JSON.stringify(data) : null,
  };
}

export function readJsonlLogRows(filePath: string): PersistedLogRow[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const rows: PersistedLogRow[] = [];
  let sequence = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      sequence += 1;
      rows.push(mapRawLogObject(obj, sequence));
    } catch {
      // Ignore malformed lines so one bad row does not hide the rest.
    }
  }

  return rows;
}

export function filterLogRows(
  rows: PersistedLogRow[],
  filters: LogQueryFilters,
): PersistedLogRow[] {
  const sinceMs = filters.since ? Date.parse(filters.since) : null;
  const untilMs = filters.until ? Date.parse(filters.until) : null;
  const q = filters.q?.toLowerCase().trim();

  return rows.filter((row) => {
    if (filters.integration && row.integration !== filters.integration) {
      return false;
    }
    if (filters.group && row.group_folder !== filters.group) {
      return false;
    }
    if (filters.minLevel && row.level < filters.minLevel) {
      return false;
    }
    if (filters.entity && row.entity !== filters.entity) {
      return false;
    }
    if (filters.runId && row.run_id !== filters.runId) {
      return false;
    }

    const rowMs = Date.parse(row.time);
    if (sinceMs !== null && Number.isFinite(sinceMs) && rowMs < sinceMs) {
      return false;
    }
    if (untilMs !== null && Number.isFinite(untilMs) && rowMs > untilMs) {
      return false;
    }

    if (q) {
      const haystack = `${row.msg}\n${row.data || ''}`.toLowerCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }

    return true;
  });
}

export function sortLogRowsDesc(rows: PersistedLogRow[]): PersistedLogRow[] {
  return [...rows].sort((left, right) => {
    const timeDiff = Date.parse(right.time) - Date.parse(left.time);
    if (timeDiff !== 0) return timeDiff;
    return right.id - left.id;
  });
}

export function paginateLogRows(
  rows: PersistedLogRow[],
  limit: number,
  offset: number,
): PersistedLogRow[] {
  return rows.slice(offset, offset + limit);
}

export function summarizeLogRows(rows: PersistedLogRow[]) {
  const byLevel: Record<string, number> = {};
  const byIntegration: Record<string, number> = {};

  for (const row of rows) {
    byLevel[row.level_label] = (byLevel[row.level_label] || 0) + 1;
    const key = row.integration || '_system';
    byIntegration[key] = (byIntegration[key] || 0) + 1;
  }

  return {
    total: rows.length,
    byLevel,
    byIntegration,
  };
}
