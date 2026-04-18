import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import type {
  ActionRecord,
  ApprovalRecord,
  ArtifactRecord,
  AuditLogRecord,
  GroupMembershipRecord,
  IdentityRecord,
  PrincipalGroupRecord,
  PrincipalRecord,
  RunRecord,
  TaskRecord,
} from './core/state/types.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function normalizeScheduledTaskContextModes(database: Database.Database): void {
  database
    .prepare(
      `
      UPDATE scheduled_tasks
      SET context_mode = 'isolated'
      WHERE context_mode IS NULL
        OR context_mode NOT IN ('group', 'isolated')
    `,
    )
    .run();

  const migratedLegacyDirectTasks = database
    .prepare(
      `
      UPDATE scheduled_tasks
      SET context_mode = 'isolated'
      WHERE context_mode = 'group'
        AND chat_jid LIKE 'signal:user:%'
    `,
    )
    .run().changes;

  if (migratedLegacyDirectTasks > 0) {
    logger.info(
      { migratedLegacyDirectTasks },
      'Migrated legacy direct-message scheduled tasks to isolated context',
    );
  }
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0,
      pending_followup_action_id TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      thread_id TEXT,
      reply_to_message_id TEXT,
      reply_to_message_content TEXT,
      reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS cp_principals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('controller', 'external', 'system')),
      display_name TEXT NOT NULL,
      trust_tier TEXT NOT NULL CHECK (trust_tier IN ('trusted', 'restricted')),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cp_identities (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_handle TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      UNIQUE(channel_type, external_id),
      FOREIGN KEY (principal_id) REFERENCES cp_principals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_identities_principal
      ON cp_identities(principal_id);

    CREATE TABLE IF NOT EXISTS cp_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      visibility TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cp_group_memberships (
      principal_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (principal_id, group_id),
      FOREIGN KEY (principal_id) REFERENCES cp_principals(id),
      FOREIGN KEY (group_id) REFERENCES cp_groups(id)
    );

    CREATE TABLE IF NOT EXISTS cp_tasks (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_thread_id TEXT,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (principal_id) REFERENCES cp_principals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_tasks_principal
      ON cp_tasks(principal_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS cp_actions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'proposed',
          'approved',
          'queued',
          'executing',
          'succeeded',
          'failed_retryable',
          'failed_terminal',
          'outcome_unknown'
        )
      ),
      runner_pool TEXT NOT NULL CHECK (runner_pool IN ('trusted', 'restricted')),
      permission_profile TEXT NOT NULL,
      idempotency_key TEXT,
      semantic_dedupe_key TEXT,
      requested_by_principal_id TEXT NOT NULL,
      approved_by_principal_id TEXT,
      research_substate TEXT,
      progress_json TEXT,
      artifact_paths_json TEXT,
      followup_count INTEGER NOT NULL DEFAULT 0,
      spend_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES cp_tasks(id),
      FOREIGN KEY (requested_by_principal_id) REFERENCES cp_principals(id),
      FOREIGN KEY (approved_by_principal_id) REFERENCES cp_principals(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_actions_idempotency
      ON cp_actions(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_cp_actions_semantic
      ON cp_actions(semantic_dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_cp_actions_task
      ON cp_actions(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cp_runs (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      runner_pool TEXT NOT NULL CHECK (runner_pool IN ('trusted', 'restricted')),
      status TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      error_class TEXT,
      FOREIGN KEY (action_id) REFERENCES cp_actions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_runs_action
      ON cp_runs(action_id, attempt_no DESC);

    CREATE TABLE IF NOT EXISTS cp_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      action_id TEXT,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_by_run_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES cp_tasks(id),
      FOREIGN KEY (action_id) REFERENCES cp_actions(id),
      FOREIGN KEY (created_by_run_id) REFERENCES cp_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_artifacts_task
      ON cp_artifacts(task_id, created_by_run_id);

    CREATE TABLE IF NOT EXISTS cp_approvals (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      required_from_principal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      FOREIGN KEY (action_id) REFERENCES cp_actions(id),
      FOREIGN KEY (required_from_principal_id) REFERENCES cp_principals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_approvals_action
      ON cp_approvals(action_id);

    CREATE TABLE IF NOT EXISTS cp_audit_logs (
      id TEXT PRIMARY KEY,
      principal_id TEXT,
      task_id TEXT,
      action_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (principal_id) REFERENCES cp_principals(id),
      FOREIGN KEY (task_id) REFERENCES cp_tasks(id),
      FOREIGN KEY (action_id) REFERENCES cp_actions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_audit_logs_created
      ON cp_audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS cp_inbound_events (
      id TEXT PRIMARY KEY,
      source_system TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      principal_id TEXT,
      task_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(source_system, source_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_inbound_events_hash
      ON cp_inbound_events(source_system, message_hash);

    CREATE TABLE IF NOT EXISTS cp_action_leases (
      action_id TEXT PRIMARY KEY,
      lease_token TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      FOREIGN KEY (action_id) REFERENCES cp_actions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_action_leases_expiry
      ON cp_action_leases(expires_at);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'signal', is_group = CASE WHEN jid LIKE 'signal:group:%' THEN 1 ELSE 0 END WHERE jid LIKE 'signal:%'`,
    );
  } catch {
    /* columns already exist */
  }

  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN pending_followup_action_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE cp_actions ADD COLUMN research_substate TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE cp_actions ADD COLUMN progress_json TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE cp_actions ADD COLUMN artifact_paths_json TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE cp_actions ADD COLUMN followup_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE cp_actions ADD COLUMN spend_json TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE cp_artifacts ADD COLUMN action_id TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE cp_artifacts ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`,
    );
    database.exec(
      `UPDATE cp_artifacts SET created_at = COALESCE(NULLIF(created_at, ''), CURRENT_TIMESTAMP)`,
    );
  } catch {
    /* column already exists */
  }

  normalizeScheduledTaskContextModes(database);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/** @internal - for tests only. */
export function _normalizeScheduledTaskContextModesForTests(): void {
  normalizeScheduledTaskContextModes(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
  pending_followup_action_id?: string | null;
}

export interface ContactActivitySummary {
  sender: string;
  sender_name: string;
  last_message_time: string;
  message_count: number;
}

/**
 * Find a Signal group chat by name (case-insensitive substring match).
 * Returns the JID if exactly one group matches, or null.
 */
export function findSignalGroupByName(
  name: string,
): { jid: string; name: string } | null {
  const rows = db
    .prepare(
      `SELECT jid, name FROM chats
       WHERE jid LIKE 'signal:group:%' AND LOWER(name) = LOWER(?)
       LIMIT 2`,
    )
    .all(name.trim()) as { jid: string; name: string }[];
  if (rows.length === 1) return rows[0];
  // Try substring match if exact fails
  if (rows.length === 0) {
    const fuzzy = db
      .prepare(
        `SELECT jid, name FROM chats
         WHERE jid LIKE 'signal:group:%' AND LOWER(name) LIKE '%' || LOWER(?) || '%'
         LIMIT 2`,
      )
      .all(name.trim()) as { jid: string; name: string }[];
    if (fuzzy.length === 1) return fuzzy[0];
  }
  return null;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group, pending_followup_action_id
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

export function getChatPendingFollowupActionId(chatJid: string): string | null {
  const row = db
    .prepare(
      `SELECT pending_followup_action_id
       FROM chats
       WHERE jid = ?`,
    )
    .get(chatJid) as { pending_followup_action_id?: string | null } | undefined;
  return row?.pending_followup_action_id ?? null;
}

export function setChatPendingFollowupActionId(
  chatJid: string,
  actionId: string | null,
): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time, pending_followup_action_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET pending_followup_action_id = excluded.pending_followup_action_id
  `,
  ).run(chatJid, chatJid, new Date().toISOString(), actionId);
}

export function getIncomingContactSummaries(): ContactActivitySummary[] {
  return db
    .prepare(
      `
      SELECT sender,
             MAX(sender_name) AS sender_name,
             MAX(timestamp) AS last_message_time,
             COUNT(*) AS message_count
      FROM messages
      WHERE is_from_me = 0 AND is_bot_message = 0
        AND sender IS NOT NULL AND sender != ''
      GROUP BY sender
      ORDER BY last_message_time DESC
    `,
    )
    .all() as ContactActivitySummary[];
}

export function getMessagesBySender(
  sender: string,
  limit: number = 100,
): NewMessage[] {
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             thread_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE sender = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    )
    .all(sender, limit) as NewMessage[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.thread_id ?? null,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message only if we have not already seen it. This protects the
 * agent loop from double-processing the same inbound message when a channel
 * delivers it through multiple receive paths (for example websocket + poll
 * fallback) with either the same id or the same semantic payload.
 */
export function storeMessageIfNew(msg: NewMessage): boolean {
  const exact = db
    .prepare(
      `SELECT 1
       FROM messages
       WHERE id = ? AND chat_jid = ?
       LIMIT 1`,
    )
    .get(msg.id, msg.chat_jid) as { 1: number } | undefined;
  if (exact) return false;

  const semantic = db
    .prepare(
      `SELECT 1
       FROM messages
       WHERE chat_jid = ?
         AND sender = ?
         AND content = ?
         AND timestamp = ?
         AND is_from_me = ?
         AND is_bot_message = ?
         AND COALESCE(thread_id, '') = COALESCE(?, '')
         AND COALESCE(reply_to_message_id, '') = COALESCE(?, '')
       LIMIT 1`,
    )
    .get(
      msg.chat_jid,
      msg.sender,
      msg.content,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
      msg.thread_id ?? null,
      msg.reply_to_message_id ?? null,
    ) as { 1: number } | undefined;
  if (semantic) return false;

  storeMessage(msg);
  return true;
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
               thread_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name
        FROM messages
        WHERE timestamp > ? AND chat_jid IN (${placeholders})
          AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
               thread_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name
        FROM messages
        WHERE chat_jid = ? AND timestamp > ?
          AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

/**
 * Check whether this chat has recent outbound activity from us
 * (agent-sent or manually-sent from the host), within `sinceIso`.
 * Used to decide whether an inbound reply should be auto-forwarded to
 * the controller, on the assumption that we initiated the thread.
 */
export function hasRecentOutboundActivity(
  chatJid: string,
  sinceIso: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ? AND timestamp > ?
         AND (is_from_me = 1 OR is_bot_message = 1)
       LIMIT 1`,
    )
    .get(chatJid, sinceIso) as { '1': number } | undefined;
  return !!row;
}

/**
 * Whether the given sender has ever posted a message in this chat.
 * Used to detect whether the controller is present in a group chat
 * (and therefore sees external replies directly — no relay needed).
 */
export function hasMessageFromSender(chatJid: string, sender: string): boolean {
  if (!sender) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ? AND sender = ?
       LIMIT 1`,
    )
    .get(chatJid, sender) as { '1': number } | undefined;
  return !!row;
}

/** Whether the chat is a group chat (per the chats metadata table). */
export function isChatGroup(chatJid: string): boolean {
  const row = db
    .prepare(`SELECT is_group FROM chats WHERE jid = ? LIMIT 1`)
    .get(chatJid) as { is_group: number } | undefined;
  return row?.is_group === 1;
}

/**
 * Get the most recent messages in a chat regardless of timestamp cursor.
 * Used by the controller's read_chat_history tool so the main-chat agent
 * can see replies that landed in sibling chats (SMS, Signal DMs, etc.).
 */
export function getRecentMessages(
  chatJid: string,
  limit: number = 25,
): NewMessage[] {
  const bounded = Math.max(1, Math.min(200, limit));
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             thread_id, reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ?
        AND content IS NOT NULL AND content != ''
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, bounded) as NewMessage[];
}

export function getMessageContentById(
  id: string,
  chatJid: string,
): string | undefined {
  const row = db
    .prepare(`SELECT content FROM messages WHERE id = ? AND chat_jid = ?`)
    .get(id, chatJid) as { content: string } | undefined;
  return row?.content;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Control-plane v2 accessors ---

export function createPrincipal(principal: PrincipalRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_principals (id, type, display_name, trust_tier, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    principal.id,
    principal.type,
    principal.display_name,
    principal.trust_tier,
    principal.status,
    principal.created_at,
  );
}

export function getPrincipal(id: string): PrincipalRecord | undefined {
  return db
    .prepare(
      `SELECT id, type, display_name, trust_tier, status, created_at
       FROM cp_principals
       WHERE id = ?`,
    )
    .get(id) as PrincipalRecord | undefined;
}

export function upsertIdentity(identity: IdentityRecord): void {
  db.prepare(
    `
    INSERT INTO cp_identities (id, principal_id, channel_type, external_id, external_handle, verified)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_type, external_id) DO UPDATE SET
      id = excluded.id,
      principal_id = excluded.principal_id,
      external_handle = excluded.external_handle,
      verified = excluded.verified
  `,
  ).run(
    identity.id,
    identity.principal_id,
    identity.channel_type,
    identity.external_id,
    identity.external_handle ?? null,
    identity.verified ? 1 : 0,
  );
}

export function findIdentity(
  channelType: string,
  externalId: string,
): IdentityRecord | undefined {
  const row = db
    .prepare(
      `SELECT id, principal_id, channel_type, external_id, external_handle, verified
       FROM cp_identities
       WHERE channel_type = ? AND external_id = ?`,
    )
    .get(channelType, externalId) as
    | (Omit<IdentityRecord, 'verified'> & { verified: number })
    | undefined;
  if (!row) return undefined;
  return {
    ...row,
    verified: row.verified === 1,
  };
}

export function createPrincipalGroup(group: PrincipalGroupRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_groups (id, name, type, visibility)
    VALUES (?, ?, ?, ?)
  `,
  ).run(group.id, group.name, group.type, group.visibility);
}

export function addGroupMembership(membership: GroupMembershipRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_group_memberships (principal_id, group_id, role)
    VALUES (?, ?, ?)
  `,
  ).run(membership.principal_id, membership.group_id, membership.role);
}

export function createCoreTask(task: TaskRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_tasks (id, principal_id, source_channel, source_thread_id, status, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.principal_id,
    task.source_channel,
    task.source_thread_id ?? null,
    task.status,
    task.summary,
    task.created_at,
    task.updated_at,
  );
}

export function getCoreTask(id: string): TaskRecord | undefined {
  return db
    .prepare(
      `SELECT id, principal_id, source_channel, source_thread_id, status, summary, created_at, updated_at
       FROM cp_tasks
       WHERE id = ?`,
    )
    .get(id) as TaskRecord | undefined;
}

export function updateCoreTaskSummary(
  id: string,
  summary: string,
  updatedAt = new Date().toISOString(),
): void {
  db.prepare(
    `
    UPDATE cp_tasks
    SET summary = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(summary, updatedAt, id);
}

export function createActionRecord(action: ActionRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_actions (
      id, task_id, type, status, runner_pool, permission_profile,
      idempotency_key, semantic_dedupe_key, requested_by_principal_id,
      approved_by_principal_id, research_substate, progress_json,
      artifact_paths_json, followup_count, spend_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    action.id,
    action.task_id,
    action.type,
    action.status,
    action.runner_pool,
    action.permission_profile,
    action.idempotency_key ?? null,
    action.semantic_dedupe_key ?? null,
    action.requested_by_principal_id,
    action.approved_by_principal_id ?? null,
    action.research_substate ?? null,
    action.progress_json ?? null,
    action.artifact_paths_json ?? null,
    action.followup_count ?? 0,
    action.spend_json ?? null,
    action.created_at,
    action.updated_at,
  );
}

export function getActionRecord(id: string): ActionRecord | undefined {
  return db
    .prepare(
      `SELECT id, task_id, type, status, runner_pool, permission_profile,
              idempotency_key, semantic_dedupe_key, requested_by_principal_id,
              approved_by_principal_id, research_substate, progress_json,
              artifact_paths_json, followup_count, spend_json, created_at, updated_at
       FROM cp_actions
       WHERE id = ?`,
    )
    .get(id) as ActionRecord | undefined;
}

export function findSucceededActionBySemanticKey(
  semanticDedupeKey: string,
): ActionRecord | undefined {
  return db
    .prepare(
      `SELECT id, task_id, type, status, runner_pool, permission_profile,
              idempotency_key, semantic_dedupe_key, requested_by_principal_id,
              approved_by_principal_id, research_substate, progress_json,
              artifact_paths_json, followup_count, spend_json, created_at, updated_at
       FROM cp_actions
       WHERE semantic_dedupe_key = ? AND status = 'succeeded'
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(semanticDedupeKey) as ActionRecord | undefined;
}

export function findActionByIdempotencyKey(
  idempotencyKey: string,
): ActionRecord | undefined {
  return db
    .prepare(
      `SELECT id, task_id, type, status, runner_pool, permission_profile,
              idempotency_key, semantic_dedupe_key, requested_by_principal_id,
              approved_by_principal_id, research_substate, progress_json,
              artifact_paths_json, followup_count, spend_json, created_at, updated_at
       FROM cp_actions
       WHERE idempotency_key = ?`,
    )
    .get(idempotencyKey) as ActionRecord | undefined;
}

export function listActionsByType(type: string, limit = 100): ActionRecord[] {
  return db
    .prepare(
      `SELECT id, task_id, type, status, runner_pool, permission_profile,
              idempotency_key, semantic_dedupe_key, requested_by_principal_id,
              approved_by_principal_id, research_substate, progress_json,
              artifact_paths_json, followup_count, spend_json, created_at, updated_at
       FROM cp_actions
       WHERE type = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(type, limit) as ActionRecord[];
}

export function getLatestActionForThreadByType(
  sourceThreadId: string,
  type: string,
): ActionRecord | undefined {
  return db
    .prepare(
      `SELECT a.id, a.task_id, a.type, a.status, a.runner_pool, a.permission_profile,
              a.idempotency_key, a.semantic_dedupe_key, a.requested_by_principal_id,
              a.approved_by_principal_id, a.research_substate, a.progress_json,
              a.artifact_paths_json, a.followup_count, a.spend_json, a.created_at, a.updated_at
       FROM cp_actions a
       JOIN cp_tasks t ON t.id = a.task_id
       WHERE t.source_thread_id = ? AND a.type = ?
       ORDER BY a.updated_at DESC
       LIMIT 1`,
    )
    .get(sourceThreadId, type) as ActionRecord | undefined;
}

export function updateActionRecordStatus(
  id: string,
  status: ActionRecord['status'],
  updates?: {
    approvedByPrincipalId?: string | null;
    updatedAt?: string;
  },
): void {
  db.prepare(
    `
    UPDATE cp_actions
    SET status = ?,
        approved_by_principal_id = COALESCE(?, approved_by_principal_id),
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    status,
    updates?.approvedByPrincipalId ?? null,
    updates?.updatedAt ?? new Date().toISOString(),
    id,
  );
}

export function updateActionResearchState(
  id: string,
  updates: {
    researchSubstate?: ActionRecord['research_substate'];
    progressJson?: string | null;
    artifactPathsJson?: string | null;
    followupCount?: number;
    spendJson?: string | null;
    updatedAt?: string;
  },
): void {
  const existing = getActionRecord(id);
  if (!existing) return;
  db.prepare(
    `
    UPDATE cp_actions
    SET research_substate = ?,
        progress_json = ?,
        artifact_paths_json = ?,
        followup_count = ?,
        spend_json = ?,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    updates.researchSubstate === undefined
      ? (existing.research_substate ?? null)
      : (updates.researchSubstate ?? null),
    updates.progressJson === undefined
      ? (existing.progress_json ?? null)
      : updates.progressJson,
    updates.artifactPathsJson === undefined
      ? (existing.artifact_paths_json ?? null)
      : updates.artifactPathsJson,
    updates.followupCount ?? existing.followup_count ?? 0,
    updates.spendJson === undefined
      ? (existing.spend_json ?? null)
      : updates.spendJson,
    updates.updatedAt ?? new Date().toISOString(),
    id,
  );
}

export function createRunRecord(run: RunRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_runs (
      id, action_id, runner_pool, status, attempt_no,
      started_at, finished_at, exit_code, error_class
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    run.id,
    run.action_id,
    run.runner_pool,
    run.status,
    run.attempt_no,
    run.started_at ?? null,
    run.finished_at ?? null,
    run.exit_code ?? null,
    run.error_class ?? null,
  );
}

export function getRunRecord(id: string): RunRecord | undefined {
  return db
    .prepare(
      `SELECT id, action_id, runner_pool, status, attempt_no,
              started_at, finished_at, exit_code, error_class
       FROM cp_runs
       WHERE id = ?`,
    )
    .get(id) as RunRecord | undefined;
}

export function updateRunRecord(
  id: string,
  updates: Partial<
    Pick<
      RunRecord,
      | 'status'
      | 'attempt_no'
      | 'started_at'
      | 'finished_at'
      | 'exit_code'
      | 'error_class'
    >
  >,
): void {
  const existing = getRunRecord(id);
  if (!existing) return;
  db.prepare(
    `
    UPDATE cp_runs
    SET status = ?, attempt_no = ?, started_at = ?, finished_at = ?, exit_code = ?, error_class = ?
    WHERE id = ?
  `,
  ).run(
    updates.status ?? existing.status,
    updates.attempt_no ?? existing.attempt_no,
    updates.started_at ?? existing.started_at ?? null,
    updates.finished_at ?? existing.finished_at ?? null,
    updates.exit_code ?? existing.exit_code ?? null,
    updates.error_class ?? existing.error_class ?? null,
    id,
  );
}

export function createArtifactRecord(artifact: ArtifactRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_artifacts (
      id, task_id, action_id, kind, path, media_type, sha256, size_bytes, created_by_run_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    artifact.id,
    artifact.task_id,
    artifact.action_id ?? null,
    artifact.kind,
    artifact.path,
    artifact.media_type,
    artifact.sha256,
    artifact.size_bytes,
    artifact.created_by_run_id ?? null,
    artifact.created_at ?? new Date().toISOString(),
  );
}

export function listArtifactsForTask(taskId: string): ArtifactRecord[] {
  return db
    .prepare(
      `SELECT id, task_id, action_id, kind, path, media_type, sha256, size_bytes, created_by_run_id, created_at
       FROM cp_artifacts
       WHERE task_id = ?
       ORDER BY id`,
    )
    .all(taskId) as ArtifactRecord[];
}

export function listArtifactsForAction(actionId: string): ArtifactRecord[] {
  return db
    .prepare(
      `SELECT id, task_id, action_id, kind, path, media_type, sha256, size_bytes, created_by_run_id, created_at
       FROM cp_artifacts
       WHERE action_id = ?
       ORDER BY id`,
    )
    .all(actionId) as ArtifactRecord[];
}

export function createApprovalRecord(approval: ApprovalRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_approvals (id, action_id, required_from_principal_id, status, reason)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    approval.id,
    approval.action_id,
    approval.required_from_principal_id,
    approval.status,
    approval.reason,
  );
}

export function listApprovalsForAction(actionId: string): ApprovalRecord[] {
  return db
    .prepare(
      `SELECT id, action_id, required_from_principal_id, status, reason
       FROM cp_approvals
       WHERE action_id = ?
       ORDER BY id`,
    )
    .all(actionId) as ApprovalRecord[];
}

export function createAuditLogRecord(log: AuditLogRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO cp_audit_logs (
      id, principal_id, task_id, action_id, event_type, payload_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.id,
    log.principal_id ?? null,
    log.task_id ?? null,
    log.action_id ?? null,
    log.event_type,
    log.payload_json,
    log.created_at,
  );
}

export function listAuditLogRecords(limit = 100): AuditLogRecord[] {
  return db
    .prepare(
      `SELECT id, principal_id, task_id, action_id, event_type, payload_json, created_at
       FROM cp_audit_logs
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as AuditLogRecord[];
}

export function hasAuditLogEvent(actionId: string, eventType: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM cp_audit_logs
       WHERE action_id = ? AND event_type = ?`,
    )
    .get(actionId, eventType) as { count: number };
  return row.count > 0;
}

export function recordInboundEvent(input: {
  id: string;
  sourceSystem: string;
  sourceEventId: string;
  messageHash: string;
  principalId?: string | null;
  taskId?: string | null;
  createdAt: string;
}): boolean {
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO cp_inbound_events (
        id, source_system, source_event_id, message_hash, principal_id, task_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.id,
      input.sourceSystem,
      input.sourceEventId,
      input.messageHash,
      input.principalId ?? null,
      input.taskId ?? null,
      input.createdAt,
    );
  return result.changes > 0;
}

export function countInboundEvents(
  sourceSystem: string,
  sourceEventId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM cp_inbound_events WHERE source_system = ? AND source_event_id = ?`,
    )
    .get(sourceSystem, sourceEventId) as { count: number };
  return row.count;
}

export function claimActionLease(input: {
  actionId: string;
  leaseToken: string;
  workerId: string;
  expiresAt: string;
  claimedAt: string;
}): boolean {
  db.prepare(`DELETE FROM cp_action_leases WHERE expires_at <= ?`).run(
    input.claimedAt,
  );
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO cp_action_leases (
        action_id, lease_token, worker_id, expires_at, claimed_at
      )
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.actionId,
      input.leaseToken,
      input.workerId,
      input.expiresAt,
      input.claimedAt,
    );
  return result.changes > 0;
}

export function releaseActionLease(
  actionId: string,
  leaseToken: string,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM cp_action_leases WHERE action_id = ? AND lease_token = ?`,
    )
    .run(actionId, leaseToken);
  return result.changes > 0;
}

export function getActionLease(actionId: string):
  | {
      action_id: string;
      lease_token: string;
      worker_id: string;
      expires_at: string;
      claimed_at: string;
    }
  | undefined {
  return db
    .prepare(
      `SELECT action_id, lease_token, worker_id, expires_at, claimed_at
       FROM cp_action_leases
       WHERE action_id = ?`,
    )
    .get(actionId) as
    | {
        action_id: string;
        lease_token: string;
        worker_id: string;
        expires_at: string;
        claimed_at: string;
      }
    | undefined;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
