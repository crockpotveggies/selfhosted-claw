import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ADMIN_BIND_HOST,
  ADMIN_PORT,
  ADMIN_UI_TOKEN,
  ADMIN_UI_USERNAME,
} from './config.js';
import { ControlActionService } from './control-actions.js';
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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'WWW-Authenticate': 'Basic realm="NanoClaw Admin", charset="UTF-8"',
  });
  res.end(JSON.stringify({ error: 'admin_ui_auth_required' }));
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

      if (req.method === 'GET' && url.pathname === '/api/admin/setup-status') {
        const env = options.service.getSetupEnvironment();
        const signalCompose = options.service.getSignalComposeStatus();
        const providers = await options.service.getProviderAvailability();
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

      if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
        sendJson(res, 200, { settings: options.service.getSettings() });
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
