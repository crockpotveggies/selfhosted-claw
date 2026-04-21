import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { refreshIntegrationToolsManifests } from './container-runner.js';
import { invalidateSkillCatalogCache } from './core/skills/catalog.js';
import {
  ADMIN_BIND_HOST,
  ADMIN_PORT,
  ADMIN_UI_TOKEN,
  ADMIN_UI_USERNAME,
  STORE_DIR,
} from './config.js';
import { ControlActionService } from './control-actions.js';
import {
  deleteTask,
  getActionRecord,
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getCoreTask,
  getPrincipal,
  getTaskById,
  listActionsByType,
  listArtifactsForAction,
  updateTask,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  getRegisteredIntegrations,
  getIntegration,
} from './integrations/registry.js';
import {
  clearPendingBridgeSession,
  getPendingBridgeSession,
  getPhoneVoiceBrowserHarness,
  getPhoneVoiceChannelInstance,
  resolvePhoneVoiceBrowserSessionChannel,
} from './integrations/phone-voice.js';
import { attachPhoneVoiceBrowserWsServer } from './integrations/phone-voice-ws.js';
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  isIntegrationEnabled,
  setIntegrationEnabled,
} from './integrations/settings-store.js';
import {
  applyIntegrationRuntimeFaultToStatus,
  buildIntegrationRuntimeFaultNotification,
  clearIntegrationRuntimeFault,
  getIntegrationRuntimeFault,
} from './integrations/runtime-health.js';
import {
  getServiceStatus,
  startService,
  stopService,
  resetCircuitBreaker,
} from './integrations/service-manager.js';
import {
  activateRegisteredChannel,
  deactivateRegisteredChannel,
  reconnectRegisteredChannel,
} from './channel-runtime.js';
import {
  handleSetupRoute,
  registerSetupRoutes,
} from './integrations/setup-router.js';
import { getLogSettings, saveLogSettings } from './logger/pruner.js';
import {
  filterLogRows,
  paginateLogRows,
  readJsonlLogRows,
  sortLogRowsDesc,
  summarizeLogRows,
  type LogQueryFilters,
  type PersistedLogRow,
} from './logger/jsonl-stream.js';
import { getLogPersistenceInfo, logger } from './logger.js';
import { getDeepResearchService } from './research/service.js';
import { resolveSignalRpcUrl } from './signal-rpc-url.js';
import { runTaskNow } from './task-scheduler.js';
import {
  buildEffectiveToolRegistry,
  getNormalizedToolAccessPolicy,
} from './tool-registry.js';

interface StartAdminServerOptions {
  service: ControlActionService;
}

function getGoogleContactsOAuthStep() {
  const def = getIntegration('google-contacts');
  const step = def?.setup?.steps.find((item) => item.type === 'oauth2');
  if (!step || step.type !== 'oauth2') {
    throw new Error(
      'Google Contacts integration is not registered or missing OAuth setup.',
    );
  }
  return {
    def,
    step,
  };
}

function isContainerRuntime(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

function normalizeRemoteAddress(remoteAddress: string | undefined): string {
  if (!remoteAddress) return '';
  return remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
}

function isPrivateIpv4Address(remoteAddress: string): boolean {
  if (net.isIP(remoteAddress) !== 4) return false;
  const [a, b] = remoteAddress.split('.').map((part) => Number(part));
  return (
    a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  );
}

export function isAllowedAdminRemoteAddress(
  remoteAddress: string | undefined,
  inContainer = isContainerRuntime(),
): boolean {
  const normalized = normalizeRemoteAddress(remoteAddress);
  if (!normalized) return false;
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    (inContainer && isPrivateIpv4Address(normalized))
  );
}

export function requiresAdminAuth(pathname: string): boolean {
  return pathname.startsWith('/api/admin/');
}

export interface SetupChecks {
  openAIConfigured: boolean;
  signalConfigured: boolean;
  signalReachable: boolean;
  signalComposeConfigured: boolean;
  signalComposeRunning: boolean;
  googleContactsAvailable: boolean;
  googleContactsSource: 'env' | 'oauth' | 'none';
  controlChatConfigured: boolean;
  verifiedIdentityCount: number;
  assistantSignalConfigured: boolean;
  wizardComplete: boolean;
}

export function buildSetupChecks(input: {
  openAIConfigured: boolean;
  signalConfigured: boolean;
  signalReachable: boolean;
  signalComposeConfigured: boolean;
  signalComposeRunning: boolean;
  controlChatConfigured: boolean;
  verifiedIdentityCount: number;
  assistantSignalConfigured: boolean;
  setupWizardReviewed: boolean;
}): SetupChecks {
  const coreSetupComplete =
    input.openAIConfigured &&
    input.signalConfigured &&
    input.signalComposeRunning &&
    input.signalReachable &&
    input.controlChatConfigured &&
    input.verifiedIdentityCount > 0;

  return {
    openAIConfigured: input.openAIConfigured,
    signalConfigured: input.signalConfigured,
    signalReachable: input.signalReachable,
    signalComposeConfigured: input.signalComposeConfigured,
    signalComposeRunning: input.signalComposeRunning,
    googleContactsAvailable: false,
    googleContactsSource: 'none',
    controlChatConfigured: input.controlChatConfigured,
    verifiedIdentityCount: input.verifiedIdentityCount,
    assistantSignalConfigured: input.assistantSignalConfigured,
    wizardComplete: input.setupWizardReviewed || coreSetupComplete,
  };
}

export function buildSignalReachabilityProbeUrl(
  rawRpcUrl: string,
  account: string,
  inContainer?: boolean,
): URL {
  return new URL(
    `/v1/groups/${encodeURIComponent(account)}`,
    resolveSignalRpcUrl(rawRpcUrl, inContainer),
  );
}

export function normalizeTaskPromptUpdate(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeToolAccessPolicyUpdate(input: unknown) {
  const body =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {};
  const toolsInput =
    body.tools && typeof body.tools === 'object'
      ? (body.tools as Record<string, unknown>)
      : {};
  const tools = Object.fromEntries(
    Object.entries(toolsInput).map(([name, value]) => {
      const record =
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)
          : {};
      return [
        name,
        {
          ...(record.enabled === undefined
            ? {}
            : { enabled: record.enabled === true }),
          ...(record.controllerOnly === undefined
            ? {}
            : { controllerOnly: record.controllerOnly === true }),
        },
      ];
    }),
  );

  return getNormalizedToolAccessPolicy({
    internalToolsEnabled: body.internalToolsEnabled !== false,
    externalToolsEnabled: body.externalToolsEnabled !== false,
    tools,
    updatedAt: new Date().toISOString(),
  });
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type, X-Admin-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function withLogDatabaseSnapshot<T>(
  logDbPath: string,
  callback: (db: Database.Database) => T,
): T {
  const snapshotDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-log-snapshot-'),
  );
  const snapshotBase = path.join(snapshotDir, 'logs.db');
  const siblingSuffixes = ['', '-wal', '-shm'];

  try {
    for (const suffix of siblingSuffixes) {
      const source = `${logDbPath}${suffix}`;
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, `${snapshotBase}${suffix}`);
      }
    }

    const db = new Database(snapshotBase, { readonly: true });
    try {
      return callback(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function getMinLogLevelNumber(level: string | null): number | undefined {
  if (!level) return undefined;
  const levelMap: Record<string, number> = {
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
  };
  return levelMap[level];
}

function buildLogQueryFilters(url: URL): LogQueryFilters {
  return {
    integration: url.searchParams.get('integration') || undefined,
    group: url.searchParams.get('group') || undefined,
    minLevel: getMinLogLevelNumber(url.searchParams.get('level')),
    since: url.searchParams.get('since') || undefined,
    until: url.searchParams.get('until') || undefined,
    entity: url.searchParams.get('entity') || undefined,
    runId: url.searchParams.get('runId') || undefined,
    q: url.searchParams.get('q') || undefined,
  };
}

function querySqliteLogRows(
  logDbPath: string,
  filters: LogQueryFilters,
  limitHint: number,
): PersistedLogRow[] {
  if (!fs.existsSync(logDbPath)) {
    return [];
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.integration) {
    conditions.push('integration = ?');
    params.push(filters.integration);
  }
  if (filters.group) {
    conditions.push('group_folder = ?');
    params.push(filters.group);
  }
  if (filters.minLevel) {
    conditions.push('level >= ?');
    params.push(filters.minLevel);
  }
  if (filters.since) {
    conditions.push('time >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push('time <= ?');
    params.push(filters.until);
  }
  if (filters.entity) {
    conditions.push('entity = ?');
    params.push(filters.entity);
  }
  if (filters.runId) {
    conditions.push('run_id = ?');
    params.push(filters.runId);
  }
  if (filters.q) {
    conditions.push('(msg LIKE ? OR data LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return withLogDatabaseSnapshot(
    logDbPath,
    (logDb) =>
      logDb
        .prepare(
          `SELECT id, time, level, level_label, msg, integration, channel, group_folder, entity, run_id, tool, data FROM logs ${where} ORDER BY time DESC LIMIT ?`,
        )
        .all(...params, limitHint) as PersistedLogRow[],
  );
}

function queryJsonlFallbackRows(filters: LogQueryFilters): PersistedLogRow[] {
  const persistence = getLogPersistenceInfo();
  if (
    persistence.mode !== 'jsonl-fallback' ||
    !persistence.jsonlPath ||
    !fs.existsSync(persistence.jsonlPath)
  ) {
    return [];
  }

  return sortLogRowsDesc(
    filterLogRows(readJsonlLogRows(persistence.jsonlPath), filters),
  );
}

function querySqliteLogStats(logDbPath: string): {
  total: number;
  byLevel: Record<string, number>;
  byIntegration: Record<string, number>;
} {
  if (!fs.existsSync(logDbPath)) {
    return { total: 0, byLevel: {}, byIntegration: {} };
  }

  const total = withLogDatabaseSnapshot(
    logDbPath,
    (logDb) =>
      (
        logDb.prepare('SELECT count(*) as cnt FROM logs').get() as {
          cnt: number;
        }
      ).cnt,
  );
  const byLevel = withLogDatabaseSnapshot(
    logDbPath,
    (logDb) =>
      logDb
        .prepare(
          'SELECT level_label, count(*) as cnt FROM logs GROUP BY level_label',
        )
        .all() as Array<{ level_label: string; cnt: number }>,
  );
  const byIntegration = withLogDatabaseSnapshot(
    logDbPath,
    (logDb) =>
      logDb
        .prepare(
          "SELECT COALESCE(integration, '_system') as name, count(*) as cnt FROM logs GROUP BY integration",
        )
        .all() as Array<{ name: string; cnt: number }>,
  );

  return {
    total,
    byLevel: Object.fromEntries(
      byLevel.map((row) => [row.level_label, row.cnt]),
    ),
    byIntegration: Object.fromEntries(
      byIntegration.map((row) => [row.name, row.cnt]),
    ),
  };
}

function refreshAllIntegrationToolManifests(): void {
  refreshIntegrationToolsManifests(
    Object.values(getAllRegisteredGroups()).map((group) => ({
      folder: group.folder,
      isMain: group.isMain === true,
    })),
  );
}

function listResearchArtifactsForWorkspace(folder: string) {
  let researchDir: string;
  try {
    researchDir = path.join(resolveGroupFolderPath(folder), 'research');
  } catch {
    return [];
  }
  if (!fs.existsSync(researchDir)) return [];

  const files: Array<{
    name: string;
    path: string;
    sizeBytes: number;
    updatedAt: string;
  }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const stat = fs.statSync(fullPath);
      files.push({
        name: entry.name,
        path: fullPath,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  };
  walk(researchDir);
  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function buildWorkspaceVisibility() {
  return Object.entries(getAllRegisteredGroups()).map(([jid, group]) => ({
    jid,
    name: group.name,
    folder: group.folder,
    mounts: [
      {
        kind: 'group',
        hostPath: resolveGroupFolderPath(group.folder),
        containerPath: '/workspace/group',
        readonly: false,
      },
      ...(group.isMain
        ? [
            {
              kind: 'project',
              hostPath: process.cwd(),
              containerPath: '/workspace/project',
              readonly: true,
            },
            {
              kind: 'store',
              hostPath: STORE_DIR,
              containerPath: '/workspace/project/store',
              readonly: false,
            },
          ]
        : []),
      ...((group.containerConfig?.additionalMounts || []).map((mount) => ({
        kind: 'additional',
        hostPath: mount.hostPath,
        containerPath: `/workspace/extra/${mount.containerPath || path.basename(mount.hostPath)}`,
        readonly: mount.readonly !== false,
      })) || []),
    ],
    artifacts: listResearchArtifactsForWorkspace(group.folder),
  }));
}

function isBasicAuthAuthorized(
  req: http.IncomingMessage,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(
      header.slice('Basic '.length),
      'base64',
    ).toString('utf-8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username === expectedUsername && password === expectedPassword;
  } catch {
    return false;
  }
}

function sendUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type, X-Admin-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'WWW-Authenticate': 'Basic realm="NanoClaw Admin", charset="UTF-8"',
  });
  res.end(JSON.stringify({ error: 'admin_ui_auth_required' }));
}

function parseSkillFrontmatter(raw: string): {
  name: string;
  description: string;
  body: string;
} {
  let name = '';
  let description = '';
  let body = raw;
  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('---', 3);
    if (endIdx !== -1) {
      const frontmatter = raw.slice(3, endIdx);
      body = raw.slice(endIdx + 3).trim();
      for (const line of frontmatter.split('\n')) {
        const match = line.match(/^(\w+):\s*(.*)$/);
        if (!match) continue;
        if (match[1] === 'name') name = match[2].trim();
        if (match[1] === 'description') description = match[2].trim();
      }
    }
  }
  return { name, description, body };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function startAdminServer(
  options: StartAdminServerOptions,
): http.Server {
  const uiDistDir = path.resolve(process.cwd(), 'admin-ui', 'dist');

  // Register setup routes for all integrations with setup flows
  registerSetupRoutes();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
      }

      if (!isAllowedAdminRemoteAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'admin_ui_local_only' });
        return;
      }
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );

      if (ADMIN_UI_TOKEN && requiresAdminAuth(url.pathname)) {
        const provided = req.headers['x-admin-token'];
        const tokenAuthorized = provided === ADMIN_UI_TOKEN;
        const basicAuthorized = isBasicAuthAuthorized(
          req,
          ADMIN_UI_USERNAME,
          ADMIN_UI_TOKEN,
        );
        if (!tokenAuthorized && !basicAuthorized) {
          sendUnauthorized(res);
          return;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Dashboard stats
      if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
        const registeredGroups = getAllRegisteredGroups();
        const groups = Object.values(registeredGroups);
        const chats = getAllChats();
        const contacts = options.service.listContacts();
        const pending = options.service.listPendingActions();
        const auditRecords = options.service.getAuditRecords(100);

        // Message counts from logs.db
        let messagesLast24h = 0;
        let messagesLast7d = 0;
        let errorsLast24h = 0;
        const logDbPath = path.join(STORE_DIR, 'logs.db');
        if (fs.existsSync(logDbPath)) {
          let logDb: Database.Database | null = null;
          try {
            logDb = new Database(logDbPath, { readonly: true });
            messagesLast24h = (
              logDb
                .prepare(
                  "SELECT count(*) as cnt FROM logs WHERE time >= datetime('now', '-1 day')",
                )
                .get() as { cnt: number }
            ).cnt;
            messagesLast7d = (
              logDb
                .prepare(
                  "SELECT count(*) as cnt FROM logs WHERE time >= datetime('now', '-7 days')",
                )
                .get() as { cnt: number }
            ).cnt;
            errorsLast24h = (
              logDb
                .prepare(
                  "SELECT count(*) as cnt FROM logs WHERE level >= 50 AND time >= datetime('now', '-1 day')",
                )
                .get() as { cnt: number }
            ).cnt;
          } catch {
            // logs.db may not exist yet
          } finally {
            try {
              logDb?.close();
            } catch {
              /* already closed */
            }
          }
        }

        // Recent activity from messages DB
        let recentMessages: Array<{
          chat_name: string;
          sender_name: string;
          content: string;
          timestamp: string;
          channel: string;
          is_from_me: number;
        }> = [];
        try {
          const messagesDb = new Database(path.join(STORE_DIR, 'messages.db'), {
            readonly: true,
          });
          recentMessages = messagesDb
            .prepare(
              `SELECT m.sender_name, m.content, m.timestamp, m.is_from_me,
                      COALESCE(c.name, c.jid) as chat_name,
                      COALESCE(c.channel, '') as channel
               FROM messages m
               LEFT JOIN chats c ON m.chat_jid = c.jid
               ORDER BY m.timestamp DESC
               LIMIT 20`,
            )
            .all() as typeof recentMessages;
          messagesDb.close();
        } catch {
          // DB not available
        }

        const integrations = getRegisteredIntegrations();

        sendJson(res, 200, {
          metrics: {
            groups: groups.length,
            chats: chats.length,
            contacts: contacts.length,
            pendingApprovals: pending.length,
            activeTasks: getAllTasks().filter((t) => t.status === 'active')
              .length,
            integrations: integrations.length,
            logEventsLast24h: messagesLast24h,
            logEventsLast7d: messagesLast7d,
            errorsLast24h,
          },
          recentActivity: recentMessages.map((m) => ({
            chatName: m.chat_name,
            senderName: m.sender_name,
            content:
              m.content.length > 120
                ? m.content.slice(0, 120) + '...'
                : m.content,
            timestamp: m.timestamp,
            channel: m.channel,
            isFromMe: Boolean(m.is_from_me),
          })),
          auditRecent: auditRecords.slice(0, 10).map((r) => ({
            actionName: r.actionName,
            status: r.status,
            createdAt: r.createdAt,
            summary: r.payloadSummary,
          })),
        });
        return;
      }

      // Notifications — separate from setup-status to avoid blocking the wizard
      if (req.method === 'GET' && url.pathname === '/api/admin/notifications') {
        const integrations = getRegisteredIntegrations();
        const notifications: Array<{
          id: string;
          integration: string;
          severity: string;
          title: string;
          message: string;
        }> = [];

        for (const def of integrations) {
          if (!isIntegrationEnabled(def.name)) continue;
          const settings = getIntegrationSettings(def.name);
          const runtimeFault = getIntegrationRuntimeFault(def.name);
          const ctx = {
            settings,
            groupSettings: () => settings,
            hasCredential: (key: string) =>
              Boolean(
                process.env[key] ||
                options.service.getSetupEnvironment()[key] ||
                settings[key],
              ),
            runtimeFault,
          };

          if (def.adminPage?.getNotifications) {
            try {
              const items = await def.adminPage.getNotifications(ctx);
              notifications.push(...items);
            } catch {
              // Per-integration failure — skip, don't crash
            }
          }

          try {
            if (!def.adminPage?.getStatus) continue;
            const status = applyIntegrationRuntimeFaultToStatus(
              await def.adminPage.getStatus(ctx),
              runtimeFault,
            );
            const hasIntegrationNotification = notifications.some(
              (item) => item.integration === def.name,
            );
            if (!hasIntegrationNotification && runtimeFault) {
              notifications.push(
                buildIntegrationRuntimeFaultNotification(
                  def.name,
                  runtimeFault,
                ),
              );
              continue;
            }
            if (!hasIntegrationNotification && status.state === 'degraded') {
              notifications.push({
                id: `${def.name}:status-degraded`,
                integration: def.name,
                severity: 'error',
                title: `${def.name} needs attention`,
                message: status.message,
              });
            }
            if (!hasIntegrationNotification && status.state === 'offline') {
              notifications.push({
                id: `${def.name}:status-offline`,
                integration: def.name,
                severity: 'warning',
                title: `${def.name} is offline`,
                message: status.message,
              });
            }
          } catch {
            // Status fallback failed — skip
          }
        }

        // Also check service health (circuit breaker open)
        for (const def of integrations) {
          if (!def.service) continue;
          if (!isIntegrationEnabled(def.name)) continue;
          try {
            const status = getServiceStatus(def.name);
            if (status.circuitOpen) {
              notifications.push({
                id: `${def.name}:circuit-open`,
                integration: def.name,
                severity: 'error',
                title: `${def.name} Service Circuit Breaker Open`,
                message:
                  'Service has failed repeatedly and auto-restart is disabled. Manual restart required.',
              });
            }
          } catch {
            // Skip
          }
        }

        sendJson(res, 200, notifications);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/tasks') {
        const tasks = getAllTasks();
        sendJson(res, 200, tasks);
        return;
      }

      const taskPromptMatch = url.pathname.match(
        /^\/api\/admin\/tasks\/([^/]+)$/,
      );
      if (req.method === 'PATCH' && taskPromptMatch) {
        const taskId = decodeURIComponent(taskPromptMatch[1]);
        const task = getTaskById(taskId);
        if (!task) {
          sendJson(res, 404, { error: 'task_not_found' });
          return;
        }
        const prompt = normalizeTaskPromptUpdate(
          JSON.parse((await readBody(req)) || '{}'),
        );
        if (!prompt) {
          sendJson(res, 400, { error: 'invalid_task_prompt' });
          return;
        }
        updateTask(taskId, { prompt });
        sendJson(res, 200, {
          ok: true,
          task: getTaskById(taskId),
        });
        return;
      }
      if (req.method === 'DELETE' && taskPromptMatch) {
        const taskId = decodeURIComponent(taskPromptMatch[1]);
        const task = getTaskById(taskId);
        if (!task) {
          sendJson(res, 404, { error: 'task_not_found' });
          return;
        }
        deleteTask(taskId);
        sendJson(res, 200, {
          ok: true,
          message: `Deleted task ${taskId}.`,
        });
        return;
      }

      const runTaskMatch =
        req.method === 'POST' &&
        url.pathname.match(/^\/api\/admin\/tasks\/([^/]+)\/run$/);
      if (runTaskMatch) {
        const taskId = decodeURIComponent(runTaskMatch[1]);
        runTaskNow(taskId);
        sendJson(res, 200, {
          ok: true,
          message: `Queued task ${taskId} for immediate execution.`,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/research/jobs') {
        const summary = getDeepResearchService().getQuotaSummary();
        const jobs = getDeepResearchService()
          .listJobs(200)
          .map((action) => {
            const task = getCoreTask(action.task_id);
            const principal = getPrincipal(action.requested_by_principal_id);
            const progress = action.progress_json
              ? JSON.parse(action.progress_json)
              : null;
            return {
              id: action.id,
              status: action.status,
              researchSubstate: action.research_substate || null,
              createdAt: action.created_at,
              updatedAt: action.updated_at,
              summary: task?.summary || '',
              sourceThreadId: task?.source_thread_id || null,
              principalDisplayName: principal?.display_name || 'Unknown',
              spend: action.spend_json ? JSON.parse(action.spend_json) : null,
              progress,
            };
          });
        sendJson(res, 200, { jobs, summary });
        return;
      }

      const researchJobDetailMatch =
        req.method === 'GET' &&
        url.pathname.match(/^\/api\/admin\/research\/jobs\/([^/]+)$/);
      if (researchJobDetailMatch) {
        const actionId = decodeURIComponent(researchJobDetailMatch[1]);
        const action = getActionRecord(actionId);
        if (!action || action.type !== 'deep_research') {
          sendJson(res, 404, { error: 'research_job_not_found' });
          return;
        }
        const task = getCoreTask(action.task_id);
        const principal = getPrincipal(action.requested_by_principal_id);
        sendJson(res, 200, {
          action,
          task,
          principal,
          progress: action.progress_json
            ? JSON.parse(action.progress_json)
            : null,
          spend: action.spend_json ? JSON.parse(action.spend_json) : null,
          artifacts: listArtifactsForAction(actionId),
        });
        return;
      }

      const researchJobCancelMatch =
        req.method === 'POST' &&
        url.pathname.match(/^\/api\/admin\/research\/jobs\/([^/]+)\/cancel$/);
      if (researchJobCancelMatch) {
        const actionId = decodeURIComponent(researchJobCancelMatch[1]);
        getDeepResearchService().cancel(actionId);
        sendJson(res, 200, { ok: true, actionId });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/files/visibility'
      ) {
        sendJson(res, 200, {
          workspaces: buildWorkspaceVisibility(),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/setup-status') {
        const env = options.service.getSetupEnvironment();
        const signalCompose = options.service.getSignalComposeStatus();
        const signalConfigured = Boolean(
          env.SIGNAL_ACCOUNT && env.SIGNAL_RPC_URL,
        );
        let signalReachable = false;
        if (signalConfigured) {
          try {
            const signalUrl = buildSignalReachabilityProbeUrl(
              env.SIGNAL_RPC_URL,
              env.SIGNAL_ACCOUNT,
            );
            const response = await fetch(signalUrl, { method: 'GET' });
            signalReachable = response.ok;
          } catch {
            signalReachable = false;
          }
        }

        sendJson(res, 200, {
          env: {
            ASSISTANT_NAME: env.ASSISTANT_NAME || '',
            OPENAI_BASE_URL: env.OPENAI_BASE_URL || '',
            OPENAI_MODEL: env.OPENAI_MODEL || '',
            OPENAI_MAX_TOKENS: env.OPENAI_MAX_TOKENS || '',
            OPENAI_TEMPERATURE: env.OPENAI_TEMPERATURE || '',
            SIGNAL_ACCOUNT: env.SIGNAL_ACCOUNT || '',
            SIGNAL_RPC_URL: env.SIGNAL_RPC_URL || '',
            SIGNAL_RECEIVE_TIMEOUT_SEC: env.SIGNAL_RECEIVE_TIMEOUT_SEC || '',
            CONTROL_SIGNAL_JID: env.CONTROL_SIGNAL_JID || '',
            GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || '',
            ADMIN_BIND_HOST: env.ADMIN_BIND_HOST || '',
            ADMIN_PORT: env.ADMIN_PORT || '',
            INBOUND_GUARD_SCRIPT: env.INBOUND_GUARD_SCRIPT || '',
            OPENAI_API_KEY_SET: Boolean(env.OPENAI_API_KEY),
            ADMIN_UI_TOKEN_SET: Boolean(env.ADMIN_UI_TOKEN),
          },
          checks: buildSetupChecks({
            openAIConfigured: Boolean(env.OPENAI_BASE_URL && env.OPENAI_MODEL),
            signalConfigured,
            signalReachable,
            signalComposeConfigured: signalCompose.configured,
            signalComposeRunning: signalCompose.running,
            controlChatConfigured: Boolean(env.CONTROL_SIGNAL_JID),
            verifiedIdentityCount:
              options.service.listVerifiedIdentities().length,
            assistantSignalConfigured: Boolean(
              options.service.getSettings().assistantSignalIdentity ||
              env.SIGNAL_ACCOUNT,
            ),
            setupWizardReviewed:
              options.service.getSettings().setupWizardReviewed,
          }),
          signalCompose,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/providers') {
        sendJson(res, 200, {
          providers: await options.service.getProviderAvailability(),
        });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/google-contacts/setup'
      ) {
        const env = options.service.getSetupEnvironment();
        const host = req.headers.host || `${ADMIN_BIND_HOST}:${ADMIN_PORT}`;
        const origin = `http://${host}`;
        const { step } = getGoogleContactsOAuthStep();
        const isComplete = await step.isComplete();
        sendJson(res, 200, {
          origin,
          callbackUri: `${origin}${step.callbackPath}`,
          scopes: step.scopes,
          configured: {
            clientId: Boolean(env.GOOGLE_CLIENT_ID),
            clientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
            accessToken: isComplete,
          },
        });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/google/oauth/start'
      ) {
        const host = req.headers.host || `${ADMIN_BIND_HOST}:${ADMIN_PORT}`;
        const origin = `http://${host}`;
        const { step } = getGoogleContactsOAuthStep();
        const result = await step.startAuth(origin);
        sendJson(res, 200, result);
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/google/oauth/callback'
      ) {
        const host = req.headers.host || `${ADMIN_BIND_HOST}:${ADMIN_PORT}`;
        const origin = `http://${host}`;
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        const error = url.searchParams.get('error') || '';

        if (error) {
          res.writeHead(302, {
            Location: `/?tab=contacts&google_contacts=error&message=${encodeURIComponent(error)}`,
          });
          res.end();
          return;
        }
        if (!code || !state) {
          res.writeHead(302, {
            Location:
              '/?tab=contacts&google_contacts=error&message=missing_code_or_state',
          });
          res.end();
          return;
        }

        try {
          const { step } = getGoogleContactsOAuthStep();
          await step.completeAuth({
            origin,
            code,
            state,
          });
          res.writeHead(302, {
            Location:
              '/?tab=contacts&google_contacts=connected&message=Google%20Contacts%20connected',
          });
          res.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(302, {
            Location: `/?tab=contacts&google_contacts=error&message=${encodeURIComponent(message)}`,
          });
          res.end();
        }
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/resolve-contact'
      ) {
        const query = url.searchParams.get('query') || '';
        const channel = (url.searchParams.get('channel') || 'signal') as
          | 'signal'
          | 'sms'
          | 'email';
        if (!query.trim()) {
          sendJson(res, 400, { error: 'missing_contact_query' });
          return;
        }
        sendJson(res, 200, {
          result: await options.service.resolveOutboundTarget(channel, query),
        });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/signal/accounts'
      ) {
        const rpcUrl = url.searchParams.get('rpcUrl') || undefined;
        const accounts = await options.service.listSignalAccounts(rpcUrl);
        sendJson(res, 200, { accounts });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/signal/link') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          deviceName?: string;
        };
        if (!body.deviceName?.trim()) {
          sendJson(res, 400, { error: 'missing_device_name' });
          return;
        }
        const dataUrl = await options.service.getSignalLinkQrDataUrl(
          body.deviceName,
        );
        sendJson(res, 200, { dataUrl });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/signal/register/start'
      ) {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          account?: string;
          useVoice?: boolean;
          captchaToken?: string;
        };
        const result = await options.service.startSignalRegistration(
          body.account || '',
          body.useVoice === true,
          body.captchaToken,
        );
        sendJson(res, 200, result);
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/signal/register/verify'
      ) {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          account?: string;
          code?: string;
        };
        const result = await options.service.verifySignalRegistration(
          body.account || '',
          body.code || '',
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/contacts') {
        const status = url.searchParams.get('status') || undefined;
        sendJson(res, 200, {
          contacts: options.service.listContacts(
            status as 'trusted' | 'unknown' | 'abuse' | undefined,
          ),
        });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname.startsWith('/api/admin/contacts/')
      ) {
        const identity = decodeURIComponent(
          url.pathname.slice('/api/admin/contacts/'.length),
        );
        const contact = options.service.getContact(identity);
        if (!contact) {
          sendJson(res, 404, { error: 'contact_not_found' });
          return;
        }
        sendJson(res, 200, { contact });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/verified-identities'
      ) {
        sendJson(res, 200, {
          verifiedIdentities: options.service.listVerifiedIdentities(),
        });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/signal/profile'
      ) {
        sendJson(res, 200, {
          profile: options.service.getSignalProfile(),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/personality') {
        const scope = (url.searchParams.get('scope') || 'global') as
          | 'global'
          | 'main'
          | `group:${string}`;
        sendJson(res, 200, {
          profile: options.service.getResolvedPersonality(scope),
        });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/personality/preview'
      ) {
        const scope = (url.searchParams.get('scope') || 'global') as
          | 'global'
          | 'main'
          | `group:${string}`;
        sendJson(res, 200, {
          preview: options.service.previewPersonality(scope),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/policy') {
        sendJson(res, 200, { policy: options.service.getPolicy() });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/policy/calendar-availability'
      ) {
        sendJson(res, 200, {
          calendarAvailability:
            options.service.getCalendarAvailability() || null,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/policy/calendar-availability'
      ) {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          timezone?: string;
          windows?: { days: number[]; startTime: string; endTime: string }[];
          notes?: string;
        };
        options.service.saveCalendarAvailability({
          timezone: body.timezone || 'UTC',
          windows: body.windows || [],
          notes: body.notes || '',
          updatedAt: new Date().toISOString(),
        });
        sendJson(res, 200, { message: 'Calendar availability saved.' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
        sendJson(res, 200, { settings: options.service.getSettings() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/tools') {
        sendJson(res, 200, { tools: options.service.listToolDefinitions() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/tool-registry') {
        sendJson(res, 200, {
          tools: buildEffectiveToolRegistry({ service: options.service }),
          policy: getNormalizedToolAccessPolicy(
            options.service.getToolAccessPolicy(),
          ),
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/tool-registry/policy'
      ) {
        const policy = normalizeToolAccessPolicyUpdate(
          JSON.parse((await readBody(req)) || '{}'),
        );
        options.service.saveToolAccessPolicy(policy);
        refreshAllIntegrationToolManifests();
        sendJson(res, 200, {
          policy: getNormalizedToolAccessPolicy(
            options.service.getToolAccessPolicy(),
          ),
          tools: buildEffectiveToolRegistry({ service: options.service }),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
        const limit = Number(url.searchParams.get('limit') || '100');
        const identity = url.searchParams.get('identity') || undefined;
        sendJson(res, 200, {
          audit: options.service.getAuditRecords(limit, identity),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/pending') {
        const limit = Number(url.searchParams.get('limit') || '50');
        sendJson(res, 200, {
          pending: options.service.listPendingActions(limit),
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname.startsWith('/api/admin/pending/') &&
        (url.pathname.endsWith('/approve') || url.pathname.endsWith('/reject'))
      ) {
        const approve = url.pathname.endsWith('/approve');
        const actionPath = approve ? '/approve' : '/reject';
        const id = decodeURIComponent(
          url.pathname
            .slice('/api/admin/pending/'.length)
            .slice(0, -actionPath.length),
        );
        const result = approve
          ? await options.service.approvePending(id, {
              actorIdentity: 'ui:local-admin',
              source: 'ui',
            })
          : options.service.rejectPending(id, {
              actorIdentity: 'ui:local-admin',
              source: 'ui',
            });
        sendJson(res, 200, { result });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/actions') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          action?: string;
          input?: unknown;
        };
        if (!body.action) {
          sendJson(res, 400, { error: 'missing_action' });
          return;
        }
        const result = await options.service.executeAction(
          body.action,
          body.input,
          { actorIdentity: 'ui:local-admin', source: 'ui' },
        );
        sendJson(res, 200, { result });
        return;
      }

      // ── Skills CRUD ──────────────────────────────────────────────
      const skillsDir = path.resolve(process.cwd(), 'container', 'skills');

      if (req.method === 'GET' && url.pathname === '/api/admin/skills') {
        const skills: { name: string; description: string }[] = [];
        if (fs.existsSync(skillsDir)) {
          for (const entry of fs.readdirSync(skillsDir, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillFile)) continue;
            const raw = fs.readFileSync(skillFile, 'utf-8');
            const { name, description } = parseSkillFrontmatter(raw);
            skills.push({ name: name || entry.name, description });
          }
        }
        sendJson(res, 200, { skills });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname.startsWith('/api/admin/skills/')
      ) {
        const skillName = decodeURIComponent(
          url.pathname.slice('/api/admin/skills/'.length),
        );
        if (
          !skillName ||
          skillName.includes('..') ||
          skillName.includes('/') ||
          skillName.includes('\\')
        ) {
          sendJson(res, 400, { error: 'invalid_skill_name' });
          return;
        }
        const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
        if (!fs.existsSync(skillFile)) {
          sendJson(res, 404, { error: 'skill_not_found' });
          return;
        }
        const raw = fs.readFileSync(skillFile, 'utf-8');
        const { name, description, body } = parseSkillFrontmatter(raw);
        sendJson(res, 200, {
          skill: { name: name || skillName, description, content: body },
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname.startsWith('/api/admin/skills/')
      ) {
        const skillName = decodeURIComponent(
          url.pathname.slice('/api/admin/skills/'.length),
        );
        if (
          !skillName ||
          skillName.includes('..') ||
          skillName.includes('/') ||
          skillName.includes('\\')
        ) {
          sendJson(res, 400, { error: 'invalid_skill_name' });
          return;
        }
        const bodyText = await readBody(req);
        const data = JSON.parse(bodyText) as {
          description?: string;
          content?: string;
        };
        const desc = (data.description || '').trim();
        const content = (data.content || '').trim();
        const fileContent = [
          '---',
          `name: ${skillName}`,
          `description: ${desc}`,
          '---',
          '',
          content,
          '',
        ].join('\n');
        const dir = path.join(skillsDir, skillName);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), fileContent);
        invalidateSkillCatalogCache();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        req.method === 'DELETE' &&
        url.pathname.startsWith('/api/admin/skills/')
      ) {
        const skillName = decodeURIComponent(
          url.pathname.slice('/api/admin/skills/'.length),
        );
        if (
          !skillName ||
          skillName.includes('..') ||
          skillName.includes('/') ||
          skillName.includes('\\')
        ) {
          sendJson(res, 400, { error: 'invalid_skill_name' });
          return;
        }
        const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
        if (!fs.existsSync(skillFile)) {
          sendJson(res, 404, { error: 'skill_not_found' });
          return;
        }
        fs.unlinkSync(skillFile);
        // Remove directory if empty
        try {
          fs.rmdirSync(path.join(skillsDir, skillName));
        } catch {
          /* directory not empty, that's fine */
        }
        invalidateSkillCatalogCache();
        sendJson(res, 200, { ok: true });
        return;
      }

      // -----------------------------------------------------------------
      // Integration API routes
      // -----------------------------------------------------------------

      // Setup routes (auto-registered per integration)
      if (
        url.pathname.startsWith('/api/admin/integrations/') &&
        url.pathname.includes('/setup/')
      ) {
        const handled = await handleSetupRoute(
          req,
          res,
          req.method || 'GET',
          url.pathname,
        );
        if (handled) return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/integrations') {
        const integrations = getRegisteredIntegrations();
        const results = await Promise.all(
          integrations.map(async (def) => {
            const enabled = isIntegrationEnabled(def.name);
            let status: {
              state: string;
              message: string;
              serviceRunning?: boolean;
            } = {
              state: 'unconfigured',
              message: 'No status check',
            };
            if (def.adminPage?.getStatus) {
              try {
                const settings = getIntegrationSettings(def.name);
                const runtimeFault = getIntegrationRuntimeFault(def.name);
                status = applyIntegrationRuntimeFaultToStatus(
                  await def.adminPage.getStatus({
                    settings,
                    groupSettings: () => settings,
                    hasCredential: (key) =>
                      Boolean(
                        process.env[key] ||
                        options.service.getSetupEnvironment()[key] ||
                        settings[key],
                      ),
                    runtimeFault,
                  }),
                  runtimeFault,
                );
              } catch {
                status = {
                  state: 'offline',
                  message: 'Status check failed',
                };
              }
            }
            const runtimeFault = getIntegrationRuntimeFault(def.name);
            const svcStatus = def.service
              ? getServiceStatus(def.name)
              : undefined;

            return {
              name: def.name,
              description: def.description,
              version: def.version,
              core: def.core,
              category: def.adminPage?.category || 'utility',
              icon: def.adminPage?.icon || 'cilPuzzle',
              enabled,
              status,
              runtimeFault,
              service: svcStatus
                ? {
                    running: svcStatus.running,
                    lastError: svcStatus.lastError,
                    circuitOpen: svcStatus.circuitOpen,
                  }
                : undefined,
              capabilities: {
                hasChannel: Boolean(def.channel),
                toolCount: def.tools?.length ?? 0,
                tools: def.tools?.map((t) => ({
                  name: t.name,
                  description: t.description,
                  controllerOnly: t.controllerOnly,
                  location: t.location,
                })),
                hasSkills: (def.skills?.length ?? 0) > 0,
                hasMemory: Boolean(def.memory),
                hasSetup: Boolean(def.setup),
              },
            };
          }),
        );
        sendJson(res, 200, results);
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname ===
          '/api/admin/integrations/phone-voice/outbound-call-test'
      ) {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            phoneNumber?: unknown;
            reason?: unknown;
            receivingPerson?: unknown;
          };
          const phoneNumber =
            typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
          if (!phoneNumber) {
            sendJson(res, 400, { error: 'phoneNumber_required' });
            return;
          }
          const receivingPerson =
            typeof body.receivingPerson === 'string'
              ? body.receivingPerson.trim()
              : '';
          if (!receivingPerson) {
            sendJson(res, 400, { error: 'receivingPerson_required' });
            return;
          }
          if (receivingPerson.length > 120) {
            sendJson(res, 400, { error: 'receivingPerson_too_long' });
            return;
          }
          const reasonRaw =
            typeof body.reason === 'string' ? body.reason.trim() : '';
          if (reasonRaw.length > 500) {
            sendJson(res, 400, { error: 'reason_too_long' });
            return;
          }
          const reason = reasonRaw || undefined;
          const channel = getPhoneVoiceChannelInstance();
          if (!channel) {
            sendJson(res, 503, { error: 'phone_voice_not_connected' });
            return;
          }
          const result = await channel.placeTestCall({
            phoneNumber,
            reason,
            receivingPerson,
          });
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error
                ? err.message
                : 'phone_voice_outbound_call_test_failed',
          });
        }
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname ===
          '/api/admin/integrations/phone-voice/bridge/pending-session'
      ) {
        const pending = getPendingBridgeSession();
        if (!pending) {
          sendJson(res, 200, {
            sessionId: null,
            phoneNumber: null,
            reason: null,
            receivingPerson: null,
          });
          return;
        }
        sendJson(res, 200, {
          sessionId: pending.sessionId,
          phoneNumber: pending.phoneNumber,
          reason: pending.reason,
          receivingPerson: pending.receivingPerson,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname ===
          '/api/admin/integrations/phone-voice/bridge/pending-session/clear'
      ) {
        clearPendingBridgeSession();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/integrations/phone-voice/call/end'
      ) {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            callId?: unknown;
          };
          const callId =
            typeof body.callId === 'string' && body.callId.trim()
              ? body.callId.trim()
              : undefined;
          const channel = getPhoneVoiceChannelInstance();
          if (!channel) {
            sendJson(res, 503, { error: 'phone_voice_not_connected' });
            return;
          }
          await channel.endActiveCall(callId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error
                ? err.message
                : 'phone_voice_end_call_failed',
          });
        }
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/integrations/phone-voice/call/dtmf'
      ) {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            digit?: unknown;
            callId?: unknown;
          };
          const digit = typeof body.digit === 'string' ? body.digit : '';
          if (!/^[0-9*#]$/.test(digit)) {
            sendJson(res, 400, { error: 'invalid_dtmf_digit' });
            return;
          }
          const callId =
            typeof body.callId === 'string' && body.callId.trim()
              ? body.callId.trim()
              : undefined;
          const channel = getPhoneVoiceChannelInstance();
          if (!channel) {
            sendJson(res, 503, { error: 'phone_voice_not_connected' });
            return;
          }
          await channel.sendDtmfToActiveCall(digit, callId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error ? err.message : 'phone_voice_dtmf_failed',
          });
        }
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/integrations/phone-voice/call/mute'
      ) {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            muted?: unknown;
            callId?: unknown;
          };
          if (typeof body.muted !== 'boolean') {
            sendJson(res, 400, { error: 'muted_required' });
            return;
          }
          const callId =
            typeof body.callId === 'string' && body.callId.trim()
              ? body.callId.trim()
              : undefined;
          const channel = getPhoneVoiceChannelInstance();
          if (!channel) {
            sendJson(res, 503, { error: 'phone_voice_not_connected' });
            return;
          }
          await channel.setMuteOnActiveCall(body.muted, callId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error ? err.message : 'phone_voice_mute_failed',
          });
        }
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname ===
          '/api/admin/integrations/phone-voice/browser-session/prepare'
      ) {
        try {
          const channel = getPhoneVoiceBrowserHarness(
            getIntegrationSettings('phone-voice'),
          );
          sendJson(res, 200, {
            ok: true,
            health: await channel.prepareBrowserVoiceRuntime(),
          });
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error
                ? err.message
                : 'browser_voice_session_prepare_failed',
          });
        }
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname ===
          '/api/admin/integrations/phone-voice/browser-session/start'
      ) {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            displayName?: string;
          };
          const channel = getPhoneVoiceBrowserHarness(
            getIntegrationSettings('phone-voice'),
          );
          sendJson(
            res,
            200,
            await channel.startBrowserVoiceSession(body.displayName),
          );
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error
                ? err.message
                : 'browser_voice_session_start_failed',
          });
        }
        return;
      }

      const browserVoiceAudioMatch =
        req.method === 'POST' &&
        url.pathname.match(
          /^\/api\/admin\/integrations\/phone-voice\/browser-session\/([^/]+)\/audio$/,
        );
      if (browserVoiceAudioMatch) {
        try {
          const channel = resolvePhoneVoiceBrowserSessionChannel(
            decodeURIComponent(browserVoiceAudioMatch[1]),
            getIntegrationSettings('phone-voice'),
          );
          const body = JSON.parse((await readBody(req)) || '{}') as {
            dataBase64?: string;
            contentType?: string;
            sampleRateHz?: number;
            channels?: number;
            endOfTurn?: boolean;
            awaitIdle?: boolean;
          };
          if (
            body.dataBase64 === undefined ||
            body.dataBase64 === null ||
            !body.contentType
          ) {
            sendJson(res, 400, { error: 'audio_payload_required' });
            return;
          }
          sendJson(
            res,
            200,
            await channel.sendBrowserVoiceAudio({
              sessionId: decodeURIComponent(browserVoiceAudioMatch[1]),
              dataBase64: body.dataBase64,
              contentType: body.contentType,
              sampleRateHz: body.sampleRateHz,
              channels: body.channels,
              endOfTurn: body.endOfTurn,
              awaitIdle: body.awaitIdle,
            }),
          );
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error ? err.message : 'browser_voice_audio_failed',
          });
        }
        return;
      }

      const browserVoiceEventsMatch =
        req.method === 'GET' &&
        url.pathname.match(
          /^\/api\/admin\/integrations\/phone-voice\/browser-session\/([^/]+)\/events$/,
        );
      if (browserVoiceEventsMatch) {
        try {
          const sessionId = decodeURIComponent(browserVoiceEventsMatch[1]);
          const channel = resolvePhoneVoiceBrowserSessionChannel(
            sessionId,
            getIntegrationSettings('phone-voice'),
          );
          sendJson(res, 200, channel.getBrowserVoiceEvents(sessionId));
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error
                ? err.message
                : 'browser_voice_session_events_failed',
          });
        }
        return;
      }

      const browserVoiceEndMatch =
        req.method === 'POST' &&
        url.pathname.match(
          /^\/api\/admin\/integrations\/phone-voice\/browser-session\/([^/]+)\/end$/,
        );
      if (browserVoiceEndMatch) {
        try {
          const sessionId = decodeURIComponent(browserVoiceEndMatch[1]);
          const channel = resolvePhoneVoiceBrowserSessionChannel(
            sessionId,
            getIntegrationSettings('phone-voice'),
          );
          await channel.endBrowserVoiceSession(sessionId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, {
            error:
              err instanceof Error
                ? err.message
                : 'browser_voice_session_end_failed',
          });
        }
        return;
      }

      // GET /api/admin/integrations/:name
      const integrationDetailMatch =
        req.method === 'GET' &&
        url.pathname.match(/^\/api\/admin\/integrations\/([^/]+)$/);
      if (integrationDetailMatch) {
        const name = integrationDetailMatch[1];
        const def = getIntegration(name);
        if (!def) {
          sendJson(res, 404, { error: 'integration_not_found' });
          return;
        }
        const settings = getIntegrationSettings(name);
        const svcStatus = def.service ? getServiceStatus(name) : undefined;
        const runtimeFault = getIntegrationRuntimeFault(name);
        let status;
        try {
          status = def.adminPage?.getStatus
            ? applyIntegrationRuntimeFaultToStatus(
                await def.adminPage.getStatus({
                  settings,
                  groupSettings: () => settings,
                  hasCredential: (key) =>
                    Boolean(
                      process.env[key] ||
                      options.service.getSetupEnvironment()[key] ||
                      settings[key],
                    ),
                  runtimeFault,
                }),
                runtimeFault,
              )
            : { state: 'unconfigured', message: '' };
        } catch {
          status = { state: 'offline', message: 'Status check failed' };
        }

        sendJson(res, 200, {
          name: def.name,
          description: def.description,
          version: def.version,
          core: def.core,
          category: def.adminPage?.category || 'utility',
          icon: def.adminPage?.icon || 'cilPuzzle',
          enabled: isIntegrationEnabled(name),
          status,
          runtimeFault,
          service: svcStatus,
          settings: {
            schema: def.settings?.schema || null,
            values: settings,
          },
          credentials: def.credentials.map((c) => {
            const envValues = options.service.getSetupEnvironment();
            return {
              key: c.key,
              label: c.label,
              type: c.type,
              configured: Boolean(
                c.envVar
                  ? process.env[c.envVar] ||
                      envValues[c.envVar] ||
                      settings[c.key]
                  : settings[c.key],
              ),
            };
          }),
          capabilities: {
            hasChannel: Boolean(def.channel),
            tools: def.tools?.map((t) => ({
              name: t.name,
              description: t.description,
              controllerOnly: t.controllerOnly,
              location: t.location,
            })),
            skills: def.skills,
            hasMemory: Boolean(def.memory),
            hasSetup: Boolean(def.setup),
          },
        });
        return;
      }

      // GET /api/admin/integrations/:name/settings
      const integrationSettingsGetMatch =
        req.method === 'GET' &&
        url.pathname.match(/^\/api\/admin\/integrations\/([^/]+)\/settings$/);
      if (integrationSettingsGetMatch) {
        const name = integrationSettingsGetMatch[1];
        sendJson(res, 200, getIntegrationSettings(name));
        return;
      }

      // POST /api/admin/integrations/:name/settings
      const integrationSettingsPostMatch =
        req.method === 'POST' &&
        url.pathname.match(/^\/api\/admin\/integrations\/([^/]+)\/settings$/);
      if (integrationSettingsPostMatch) {
        const name = integrationSettingsPostMatch[1];
        const body = JSON.parse((await readBody(req)) || '{}') as Record<
          string,
          unknown
        >;
        try {
          const def = getIntegration(name);
          const prev = getIntegrationSettings(name);
          saveIntegrationSettings(name, body);
          try {
            if (def?.lifecycle?.onSettingsChange) {
              await def.lifecycle.onSettingsChange(prev, body);
            }
            if (def?.channel && isIntegrationEnabled(name)) {
              await activateRegisteredChannel(name);
            }
          } catch (err) {
            saveIntegrationSettings(name, prev);
            throw err;
          }
          clearIntegrationRuntimeFault(name);
          refreshAllIntegrationToolManifests();
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'save_failed',
          });
        }
        return;
      }

      // POST /api/admin/integrations/:name/toggle
      const integrationToggleMatch =
        req.method === 'POST' &&
        url.pathname.match(/^\/api\/admin\/integrations\/([^/]+)\/toggle$/);
      if (integrationToggleMatch) {
        const name = integrationToggleMatch[1];
        const body = JSON.parse((await readBody(req)) || '{}') as {
          enabled?: boolean;
        };
        try {
          const enabled = body.enabled ?? false;
          const def = getIntegration(name);
          const wasEnabled = isIntegrationEnabled(name);
          setIntegrationEnabled(name, enabled);
          try {
            if (enabled && !wasEnabled) {
              const settings = getIntegrationSettings(name);
              if (def?.lifecycle?.onEnable) {
                await def.lifecycle.onEnable({
                  settings,
                  groupSettings: () => settings,
                  hasCredential: (key) =>
                    Boolean(settings[key] || process.env[key]),
                });
              }
              if (def?.channel) {
                await activateRegisteredChannel(name);
              }
              clearIntegrationRuntimeFault(name);
            } else if (!enabled && wasEnabled && def?.lifecycle?.onDisable) {
              await def.lifecycle.onDisable();
              if (def?.channel) {
                await deactivateRegisteredChannel(name);
              }
            } else if (!enabled && wasEnabled && def?.channel) {
              await deactivateRegisteredChannel(name);
            }
          } catch (err) {
            setIntegrationEnabled(name, wasEnabled);
            throw err;
          }
          refreshAllIntegrationToolManifests();
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'toggle_failed',
          });
        }
        return;
      }

      // POST /api/admin/integrations/:name/reconnect
      const integrationReconnectMatch =
        req.method === 'POST' &&
        url.pathname.match(/^\/api\/admin\/integrations\/([^/]+)\/reconnect$/);
      if (integrationReconnectMatch) {
        const name = integrationReconnectMatch[1];
        try {
          const def = getIntegration(name);
          if (!def) {
            sendJson(res, 404, { error: 'integration_not_found' });
            return;
          }
          if (!isIntegrationEnabled(name)) {
            sendJson(res, 400, { error: 'integration_disabled' });
            return;
          }

          const settings = getIntegrationSettings(name);
          const ctx = {
            settings,
            groupSettings: () => settings,
            hasCredential: (key: string) =>
              Boolean(
                process.env[key] ||
                options.service.getSetupEnvironment()[key] ||
                settings[key],
              ),
          };

          if (def.channel) {
            await reconnectRegisteredChannel(name);
          } else if (def.lifecycle?.onReconnect) {
            await def.lifecycle.onReconnect(ctx);
          } else if (def.service) {
            resetCircuitBreaker(name);
            startService(name);
          } else {
            sendJson(res, 400, { error: 'reconnect_not_supported' });
            return;
          }

          clearIntegrationRuntimeFault(name);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'reconnect_failed',
          });
        }
        return;
      }

      // POST /api/admin/integrations/:name/service/start
      const svcStartMatch =
        req.method === 'POST' &&
        url.pathname.match(
          /^\/api\/admin\/integrations\/([^/]+)\/service\/start$/,
        );
      if (svcStartMatch) {
        const name = svcStartMatch[1];
        const body = JSON.parse((await readBody(req)) || '{}') as Record<
          string,
          string
        >;
        try {
          resetCircuitBreaker(name);
          // If body has values, use as bootstrap input
          const hasBootstrap = Object.keys(body).length > 0;
          const status = startService(name, hasBootstrap ? body : undefined);
          sendJson(res, 200, status);
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'start_failed',
          });
        }
        return;
      }

      // POST /api/admin/integrations/:name/service/stop
      const svcStopMatch =
        req.method === 'POST' &&
        url.pathname.match(
          /^\/api\/admin\/integrations\/([^/]+)\/service\/stop$/,
        );
      if (svcStopMatch) {
        const name = svcStopMatch[1];
        try {
          const status = stopService(name);
          sendJson(res, 200, status);
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'stop_failed',
          });
        }
        return;
      }

      // GET /api/admin/integrations/:name/service/status
      const svcStatusMatch =
        req.method === 'GET' &&
        url.pathname.match(
          /^\/api\/admin\/integrations\/([^/]+)\/service\/status$/,
        );
      if (svcStatusMatch) {
        const name = svcStatusMatch[1];
        sendJson(res, 200, getServiceStatus(name));
        return;
      }

      // -----------------------------------------------------------------
      // Integration profile routes
      // -----------------------------------------------------------------

      // GET /api/admin/integrations/:name/profile
      const profileGetMatch =
        req.method === 'GET' &&
        url.pathname.match(/^\/api\/admin\/integrations\/([^/]+)\/profile$/);
      if (profileGetMatch) {
        const name = profileGetMatch[1];
        const def = getIntegration(name);
        if (!def?.profile) {
          sendJson(res, 404, { error: 'no_profile' });
          return;
        }
        try {
          const values = await def.profile.getProfile();
          sendJson(res, 200, {
            label: def.profile.label,
            fields: def.profile.fields,
            values,
          });
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'profile_load_failed',
          });
        }
        return;
      }

      // POST /api/admin/integrations/:name/profile
      const profilePostMatch =
        req.method === 'POST' &&
        url.pathname.match(/^\/api\/admin\/integrations\/([^/]+)\/profile$/);
      if (profilePostMatch) {
        const name = profilePostMatch[1];
        const def = getIntegration(name);
        if (!def?.profile) {
          sendJson(res, 404, { error: 'no_profile' });
          return;
        }
        const body = JSON.parse((await readBody(req)) || '{}') as Record<
          string,
          string
        >;
        try {
          await def.profile.saveProfile(body);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'profile_save_failed',
          });
        }
        return;
      }

      // GET /api/admin/integration-profiles (list all integrations with profiles)
      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/integration-profiles'
      ) {
        const integrations = getRegisteredIntegrations();
        const profiles = integrations
          .filter((def) => def.profile && isIntegrationEnabled(def.name))
          .map((def) => ({
            name: def.name,
            label: def.profile!.label,
            fields: def.profile!.fields,
          }));
        sendJson(res, 200, profiles);
        return;
      }

      // -----------------------------------------------------------------
      // Log API routes
      // -----------------------------------------------------------------

      if (req.method === 'GET' && url.pathname === '/api/admin/logs') {
        const logDbPath = path.join(STORE_DIR, 'logs.db');
        try {
          const filters = buildLogQueryFilters(url);
          const limit = Math.min(
            parseInt(url.searchParams.get('limit') || '100', 10) || 100,
            500,
          );
          const offset =
            parseInt(url.searchParams.get('offset') || '0', 10) || 0;
          const dbRows = querySqliteLogRows(
            logDbPath,
            filters,
            limit + offset + 500,
          );
          const fallbackRows = queryJsonlFallbackRows(filters);
          const rows = paginateLogRows(
            sortLogRowsDesc([...dbRows, ...fallbackRows]),
            limit,
            offset,
          );

          sendJson(res, 200, rows);
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'log_query_failed',
          });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/logs/stats') {
        const logDbPath = path.join(STORE_DIR, 'logs.db');
        try {
          const dbStats = querySqliteLogStats(logDbPath);
          const fallbackStats = summarizeLogRows(queryJsonlFallbackRows({}));
          sendJson(res, 200, {
            total: dbStats.total + fallbackStats.total,
            byLevel: Object.fromEntries(
              Array.from(
                new Set([
                  ...Object.keys(dbStats.byLevel),
                  ...Object.keys(fallbackStats.byLevel),
                ]),
              ).map((key) => [
                key,
                (dbStats.byLevel[key] || 0) + (fallbackStats.byLevel[key] || 0),
              ]),
            ),
            byIntegration: Object.fromEntries(
              Array.from(
                new Set([
                  ...Object.keys(dbStats.byIntegration),
                  ...Object.keys(fallbackStats.byIntegration),
                ]),
              ).map((key) => [
                key,
                (dbStats.byIntegration[key] || 0) +
                  (fallbackStats.byIntegration[key] || 0),
              ]),
            ),
          });
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'stats_failed',
          });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/logs/settings') {
        sendJson(res, 200, getLogSettings());
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/logs/settings'
      ) {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<
          string,
          unknown
        >;
        saveLogSettings(body as Parameters<typeof saveLogSettings>[0]);
        sendJson(res, 200, getLogSettings());
        return;
      }

      if (req.method === 'GET' && fs.existsSync(uiDistDir)) {
        const relativePath =
          url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const candidate = path.resolve(uiDistDir, relativePath);
        const filePath =
          fs.existsSync(candidate) && candidate.startsWith(uiDistDir)
            ? candidate
            : path.join(uiDistDir, 'index.html');
        const ext = path.extname(filePath);
        const contentType =
          ext === '.js'
            ? 'application/javascript; charset=utf-8'
            : ext === '.css'
              ? 'text/css; charset=utf-8'
              : 'text/html; charset=utf-8';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(filePath));
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      logger.error({ err }, 'Admin server request failed');
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'internal_error',
      });
    }
  });

  attachPhoneVoiceBrowserWsServer(server);

  server.listen(ADMIN_PORT, ADMIN_BIND_HOST, () => {
    logger.info(
      { host: ADMIN_BIND_HOST, port: ADMIN_PORT },
      'Admin server listening',
    );
  });

  return server;
}
