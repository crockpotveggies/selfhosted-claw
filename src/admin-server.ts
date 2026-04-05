import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ADMIN_BIND_HOST,
  ADMIN_PORT,
  ADMIN_UI_TOKEN,
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(payload));
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
        if (provided !== ADMIN_UI_TOKEN) {
          sendJson(res, 401, { error: 'admin_ui_auth_required' });
          return;
        }
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/api/admin/health') {
        sendJson(res, 200, { ok: true });
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

      if (req.method === 'GET' && url.pathname === '/api/admin/verified-identities') {
        sendJson(res, 200, {
          verifiedIdentities: options.service.listVerifiedIdentities(),
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
        const filePath = fs.existsSync(candidate)
          && candidate.startsWith(uiDistDir)
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
