/**
 * Log retention pruner — periodically deletes old logs from SQLite.
 *
 * Reads settings from ADMIN_CONFIG_DIR/log-settings.json.
 * Runs on setInterval (default: every 60 minutes).
 */

import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { ADMIN_CONFIG_DIR, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { LogSettings } from '../integrations/types.js';
import { DEFAULT_LOG_SETTINGS } from '../integrations/types.js';

const LOG_DB_PATH = path.join(STORE_DIR, 'logs.db');
const SETTINGS_PATH = path.join(ADMIN_CONFIG_DIR, 'log-settings.json');

let pruneInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

export function getLogSettings(): LogSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LogSettings>;
    return { ...DEFAULT_LOG_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_LOG_SETTINGS };
  }
}

export function saveLogSettings(settings: Partial<LogSettings>): void {
  const current = getLogSettings();
  const merged = { ...current, ...settings };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmpPath = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, SETTINGS_PATH);
}

// ---------------------------------------------------------------------------
// Pruning logic
// ---------------------------------------------------------------------------

function runPrune(): void {
  if (!fs.existsSync(LOG_DB_PATH)) return;

  const settings = getLogSettings();

  let db: Database.Database | null = null;
  try {
    db = new Database(LOG_DB_PATH);
    db.pragma('journal_mode = WAL');

    // 1. Time-based deletion
    const timeResult = db
      .prepare(`DELETE FROM logs WHERE time < datetime('now', ?)`)
      .run(`-${settings.retentionDays} days`);

    const timeDeleted =
      typeof timeResult.changes === 'number' ? timeResult.changes : 0;

    if (timeDeleted > 0) {
      logger.info(
        { deletedRows: timeDeleted, retentionDays: settings.retentionDays },
        'Log pruner: time-based deletion',
      );
    }

    // 2. Size-based fallback
    const stats = fs.statSync(LOG_DB_PATH);
    const sizeMb = stats.size / (1024 * 1024);

    if (sizeMb > settings.maxSizeMb) {
      const totalRows = (
        db.prepare('SELECT count(*) as cnt FROM logs').get() as {
          cnt: number;
        }
      ).cnt;
      const deleteCount = Math.ceil(totalRows * 0.2);

      if (deleteCount > 0) {
        db.prepare(
          `DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY time ASC LIMIT ?)`,
        ).run(deleteCount);

        logger.info(
          { deletedRows: deleteCount, sizeMb: sizeMb.toFixed(1) },
          'Log pruner: size-based deletion',
        );
      }
    }

    // 3. VACUUM if we deleted a significant number of rows
    const totalAfter = (
      db.prepare('SELECT count(*) as cnt FROM logs').get() as {
        cnt: number;
      }
    ).cnt;

    // Only VACUUM if we deleted >10% of rows (VACUUM is expensive)
    if (timeDeleted > 0 && totalAfter > 0) {
      const deletedPct = timeDeleted / (totalAfter + timeDeleted);
      if (deletedPct > 0.1) {
        db.exec('VACUUM');
        logger.debug('Log pruner: VACUUM completed');
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'Log pruner error');
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startLogPruner(): void {
  if (pruneInterval) return;

  const settings = getLogSettings();
  const intervalMs = settings.pruneIntervalMinutes * 60 * 1000;

  // Run once immediately (async, non-blocking)
  setTimeout(runPrune, 5000);

  pruneInterval = setInterval(runPrune, intervalMs);
  logger.info(
    { intervalMinutes: settings.pruneIntervalMinutes },
    'Log pruner started',
  );
}

export function stopLogPruner(): void {
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }
}
