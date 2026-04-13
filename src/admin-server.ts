import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';

import {
  ADMIN_BIND_HOST,
  ADMIN_PORT,
  ADMIN_UI_TOKEN,
  ADMIN_UI_USERNAME,
  STORE_DIR,
} from './config.js';
import { ControlActionService } from './control-actions.js';
import { getAllChats, getAllRegisteredGroups, getAllTasks } from './db.js';
import {
  getRegisteredIntegrations,
  getIntegration,
} from './integrations/registry.js';
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  isIntegrationEnabled,
  setIntegrationEnabled,
} from './integrations/settings-store.js';
import {
  getServiceStatus,
  startService,
  stopService,
  resetCircuitBreaker,
} from './integrations/service-manager.js';
import {
  handleSetupRoute,
  registerSetupRoutes,
} from './integrations/setup-router.js';
import { getLogSettings, saveLogSettings } from './logger/pruner.js';
import { logger } from './logger.js';

interface StartAdminServerOptions {
  service: ControlActionService;
}

function isLocalAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
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

      if (!isLocalAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'admin_ui_local_only' });
        return;
      }
      if (ADMIN_UI_TOKEN) {
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

      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );

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
            const status = await def.adminPage.getStatus(ctx);
            const hasIntegrationNotification = notifications.some(
              (item) => item.integration === def.name,
            );
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

      if (req.method === 'GET' && url.pathname === '/api/admin/setup-status') {
        const env = options.service.getSetupEnvironment();
        const signalCompose = options.service.getSignalComposeStatus();
        let providers;
        try {
          providers = await options.service.getProviderAvailability();
        } catch {
          // Provider check failed (e.g., expired OAuth token) — use safe defaults
          providers = {
            onecliConfigured: false,
            onecliReachable: false,
            googleContactsAvailable: false,
            googleContactsSource: 'none' as const,
            signalOutboundAvailable: false,
            smsOutboundAvailable: false,
            emailOutboundAvailable: false,
            contactResolutionAvailable: false,
          };
        }
        const signalConfigured = Boolean(
          env.SIGNAL_ACCOUNT && env.SIGNAL_RPC_URL,
        );
        let onecliReachable = false;
        if (env.ONECLI_URL) {
          try {
            const response = await fetch(env.ONECLI_URL, { method: 'GET' });
            onecliReachable = response.status < 500;
          } catch {
            onecliReachable = false;
          }
        }
        let signalReachable = false;
        if (signalConfigured) {
          try {
            const signalUrl = new URL(
              `/v1/groups/${encodeURIComponent(env.SIGNAL_ACCOUNT)}`,
              env.SIGNAL_RPC_URL,
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
            ONECLI_URL: env.ONECLI_URL || '',
            GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || '',
            ADMIN_BIND_HOST: env.ADMIN_BIND_HOST || '',
            ADMIN_PORT: env.ADMIN_PORT || '',
            INBOUND_GUARD_SCRIPT: env.INBOUND_GUARD_SCRIPT || '',
            OPENAI_API_KEY_SET: Boolean(env.OPENAI_API_KEY),
            ADMIN_UI_TOKEN_SET: Boolean(env.ADMIN_UI_TOKEN),
          },
          checks: {
            openAIConfigured: Boolean(env.OPENAI_BASE_URL && env.OPENAI_MODEL),
            signalConfigured,
            signalReachable,
            signalComposeConfigured: signalCompose.configured,
            signalComposeRunning: signalCompose.running,
            onecliConfigured: Boolean(env.ONECLI_URL),
            onecliReachable,
            googleContactsAvailable: providers.googleContactsAvailable,
            googleContactsSource: providers.googleContactsSource,
            controlChatConfigured: Boolean(env.CONTROL_SIGNAL_JID),
            verifiedIdentityCount:
              options.service.listVerifiedIdentities().length,
            assistantSignalConfigured: Boolean(
              options.service.getSettings().assistantSignalIdentity ||
              env.SIGNAL_ACCOUNT,
            ),
            wizardComplete:
              Boolean(env.OPENAI_BASE_URL && env.OPENAI_MODEL) &&
              signalConfigured &&
              signalCompose.running &&
              signalReachable &&
              Boolean(env.CONTROL_SIGNAL_JID) &&
              options.service.listVerifiedIdentities().length > 0,
          },
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
        const providers = await options.service.getProviderAvailability();
        sendJson(res, 200, {
          origin,
          callbackUri: `${origin}/api/admin/google/oauth/callback`,
          scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
          configured: {
            clientId: Boolean(env.GOOGLE_CLIENT_ID),
            clientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
            accessToken: providers.googleContactsAvailable,
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
        const result = await options.service.startGoogleContactsOAuth(origin);
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
          await options.service.completeGoogleContactsOAuth({
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
                status = await def.adminPage.getStatus({
                  settings,
                  groupSettings: () => settings,
                  hasCredential: (key) =>
                    Boolean(
                      process.env[key] ||
                      options.service.getSetupEnvironment()[key] ||
                      settings[key],
                    ),
                });
              } catch {
                status = {
                  state: 'offline',
                  message: 'Status check failed',
                };
              }
            }
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
        let status;
        try {
          status = def.adminPage?.getStatus
            ? await def.adminPage.getStatus({
                settings,
                groupSettings: () => settings,
                hasCredential: (key) =>
                  Boolean(
                    process.env[key] ||
                    options.service.getSetupEnvironment()[key] ||
                    settings[key],
                  ),
              })
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
          if (def?.lifecycle?.onSettingsChange) {
            await def.lifecycle.onSettingsChange(prev, body);
          }
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
          setIntegrationEnabled(name, body.enabled ?? false);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'toggle_failed',
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
        url.pathname.match(
          /^\/api\/admin\/integrations\/([^/]+)\/profile$/,
        );
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
        url.pathname.match(
          /^\/api\/admin\/integrations\/([^/]+)\/profile$/,
        );
      if (profilePostMatch) {
        const name = profilePostMatch[1];
        const def = getIntegration(name);
        if (!def?.profile) {
          sendJson(res, 404, { error: 'no_profile' });
          return;
        }
        const body = JSON.parse(
          (await readBody(req)) || '{}',
        ) as Record<string, string>;
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
        if (!fs.existsSync(logDbPath)) {
          sendJson(res, 200, []);
          return;
        }
        let logDb: Database.Database | null = null;
        try {
          logDb = new Database(logDbPath, { readonly: true });
          const conditions: string[] = [];
          const params: unknown[] = [];

          const integration = url.searchParams.get('integration');
          if (integration) {
            conditions.push('integration = ?');
            params.push(integration);
          }
          const group = url.searchParams.get('group');
          if (group) {
            conditions.push('group_folder = ?');
            params.push(group);
          }
          const level = url.searchParams.get('level');
          if (level) {
            const levelMap: Record<string, number> = {
              debug: 20,
              info: 30,
              warn: 40,
              error: 50,
              fatal: 60,
            };
            const levelNum = levelMap[level];
            if (levelNum) {
              conditions.push('level >= ?');
              params.push(levelNum);
            }
          }
          const since = url.searchParams.get('since');
          if (since) {
            conditions.push('time >= ?');
            params.push(since);
          }
          const until = url.searchParams.get('until');
          if (until) {
            conditions.push('time <= ?');
            params.push(until);
          }
          const entity = url.searchParams.get('entity');
          if (entity) {
            conditions.push('entity = ?');
            params.push(entity);
          }
          const runId = url.searchParams.get('runId');
          if (runId) {
            conditions.push('run_id = ?');
            params.push(runId);
          }
          const q = url.searchParams.get('q');
          if (q) {
            conditions.push('(msg LIKE ? OR data LIKE ?)');
            params.push(`%${q}%`, `%${q}%`);
          }

          const where =
            conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
          const limit = Math.min(
            parseInt(url.searchParams.get('limit') || '100', 10) || 100,
            500,
          );
          const offset =
            parseInt(url.searchParams.get('offset') || '0', 10) || 0;

          const rows = logDb
            .prepare(
              `SELECT id, time, level, level_label, msg, integration, channel, group_folder, entity, run_id, tool, data FROM logs ${where} ORDER BY time DESC LIMIT ? OFFSET ?`,
            )
            .all(...params, limit, offset);

          sendJson(res, 200, rows);
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'log_query_failed',
          });
        } finally {
          try {
            logDb?.close();
          } catch {
            /* already closed */
          }
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/logs/stats') {
        const logDbPath = path.join(STORE_DIR, 'logs.db');
        if (!fs.existsSync(logDbPath)) {
          sendJson(res, 200, { total: 0, byLevel: {}, byIntegration: {} });
          return;
        }
        let logDb: Database.Database | null = null;
        try {
          logDb = new Database(logDbPath, { readonly: true });
          const total = (
            logDb.prepare('SELECT count(*) as cnt FROM logs').get() as {
              cnt: number;
            }
          ).cnt;
          const byLevel = logDb
            .prepare(
              'SELECT level_label, count(*) as cnt FROM logs GROUP BY level_label',
            )
            .all() as Array<{ level_label: string; cnt: number }>;
          const byIntegration = logDb
            .prepare(
              "SELECT COALESCE(integration, '_system') as name, count(*) as cnt FROM logs GROUP BY integration",
            )
            .all() as Array<{ name: string; cnt: number }>;

          sendJson(res, 200, {
            total,
            byLevel: Object.fromEntries(
              byLevel.map((r) => [r.level_label, r.cnt]),
            ),
            byIntegration: Object.fromEntries(
              byIntegration.map((r) => [r.name, r.cnt]),
            ),
          });
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'stats_failed',
          });
        } finally {
          try {
            logDb?.close();
          } catch {
            /* already closed */
          }
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

  server.listen(ADMIN_PORT, ADMIN_BIND_HOST, () => {
    logger.info(
      { host: ADMIN_BIND_HOST, port: ADMIN_PORT },
      'Admin server listening',
    );
  });

  return server;
}
