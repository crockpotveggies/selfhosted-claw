/**
 * Step: groups — Fetch group metadata from messaging platforms, write to DB.
 * WhatsApp requires an upfront sync (Baileys groupFetchAllParticipating).
 * Other channels discover group names at runtime — this step auto-skips for them.
 * Replaces 05-sync-groups.sh + 05b-list-groups.sh
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

function normalizeSignalIdentifier(value: string): string {
  return value.replace(/[^\dA-Za-z:+]/g, '').toLowerCase();
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  await syncGroups(projectRoot);
}

async function listGroups(limit: number): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: database not found');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT jid, name FROM chats
     WHERE jid <> '__group_sync__' AND is_group = 1 AND name <> jid
     ORDER BY last_message_time DESC
     LIMIT ?`,
    )
    .all(limit) as Array<{ jid: string; name: string }>;
  db.close();

  for (const row of rows) {
    console.log(`${row.jid}|${row.name}`);
  }
}

async function syncGroups(projectRoot: string): Promise<void> {
  const envVars = readEnvFile(['SIGNAL_ACCOUNT', 'SIGNAL_RPC_URL']);
  const signalAccount = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  const signalRpcUrl =
    process.env.SIGNAL_RPC_URL || envVars.SIGNAL_RPC_URL || 'http://127.0.0.1:8080';

  if (!signalAccount) {
    logger.info('Signal account not configured — skipping group sync');
    emitStatus('SYNC_GROUPS', {
      BUILD: 'skipped',
      SYNC: 'skipped',
      GROUPS_IN_DB: 0,
      REASON: 'signal_not_configured',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Build TypeScript first
  logger.info('Building TypeScript');
  let buildOk = false;
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SYNC_GROUPS', {
      BUILD: 'failed',
      SYNC: 'skipped',
      GROUPS_IN_DB: 0,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  logger.info('Fetching group metadata');
  let syncOk = false;
  try {
    const response = await fetch(signalRpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `sync-${Date.now()}`,
        method: 'listGroups',
        params: {
          account: signalAccount,
        },
      }),
    });
    const payload = await response.json();
    const groups = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.result?.groups)
        ? payload.result.groups
        : [];

    const dbPath = path.join(STORE_DIR, 'messages.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT, channel TEXT, is_group INTEGER DEFAULT 0)',
    );
    const upsert = db.prepare(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
       VALUES (?, ?, ?, 'signal', 1)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         last_message_time = excluded.last_message_time,
         channel = 'signal',
         is_group = 1`,
    );
    const now = new Date().toISOString();
    for (const group of groups) {
      const groupId = String(group.id || group.groupId || '').trim();
      if (!groupId) continue;
      const name = String(group.name || group.title || group.groupName || groupId);
      upsert.run(
        `signal:group:${normalizeSignalIdentifier(groupId)}`,
        name,
        now,
      );
    }
    db.close();
    syncOk = response.ok;
  } catch (err) {
    logger.error({ err }, 'Sync failed');
  }

  // Count groups in DB using better-sqlite3 (no sqlite3 CLI)
  let groupsInDb = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM chats WHERE channel = 'signal' AND is_group = 1 AND jid <> '__group_sync__'",
        )
        .get() as { count: number };
      groupsInDb = row.count;
      db.close();
    } catch {
      // DB may not exist yet
    }
  }

  const status = syncOk ? 'success' : 'failed';

  emitStatus('SYNC_GROUPS', {
    BUILD: buildOk ? 'success' : 'failed',
    SYNC: syncOk ? 'success' : 'failed',
    GROUPS_IN_DB: groupsInDb,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
