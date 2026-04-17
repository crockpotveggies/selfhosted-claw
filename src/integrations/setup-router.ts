import type http from 'http';

import { logger } from '../logger.js';

import { getIntegrationsWithSetup, getIntegration } from './registry.js';
import type {
  SetupStep,
  OAuthSetupStep,
  CredentialInputStep,
  FormSetupStep,
  QrCodeSetupStep,
  VerificationCodeSetupStep,
  WebhookUrlSetupStep,
  CustomSetupStep,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface SetupRoute {
  method: 'GET' | 'POST';
  /** Pattern like /api/admin/integrations/:name/setup/... */
  test: (method: string, pathname: string) => boolean;
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    params: { integrationName: string },
  ) => Promise<void>;
}

const routes: SetupRoute[] = [];

function registerRoute(route: SetupRoute): void {
  routes.push(route);
}

function makePrefix(name: string): string {
  return `/api/admin/integrations/${name}/setup`;
}

// ---------------------------------------------------------------------------
// Register routes for all integrations with setup flows
// ---------------------------------------------------------------------------

export function registerSetupRoutes(): void {
  routes.length = 0; // Clear any previous (idempotent re-registration)

  for (const def of getIntegrationsWithSetup()) {
    const name = def.name;
    const setup = def.setup!;
    const prefix = makePrefix(name);

    // GET .../setup/status
    registerRoute({
      method: 'GET',
      test: (m, p) => m === 'GET' && p === `${prefix}/status`,
      handler: async (_req, res) => {
        const status = await setup.getStatus();
        sendJson(res, 200, status);
      },
    });

    // Per-step routes
    for (let idx = 0; idx < setup.steps.length; idx++) {
      const step = setup.steps[idx];
      registerStepRoutes(name, prefix, step, idx);
    }
  }

  logger.debug(
    { routeCount: routes.length },
    'Integration setup routes registered',
  );
}

function registerStepRoutes(
  integrationName: string,
  prefix: string,
  step: SetupStep,
  _idx: number,
): void {
  switch (step.type) {
    case 'oauth2':
      registerOAuthRoutes(integrationName, prefix, step);
      break;
    case 'credential_input':
      registerCredentialRoutes(integrationName, prefix, step);
      break;
    case 'form':
      registerFormRoutes(integrationName, prefix, step, _idx);
      break;
    case 'qr_code':
      registerQrRoutes(integrationName, prefix, step);
      break;
    case 'verification_code':
      registerVerificationRoutes(integrationName, prefix, step);
      break;
    case 'webhook_url':
      registerWebhookRoutes(integrationName, prefix, step);
      break;
    case 'custom':
      registerCustomRoutes(integrationName, prefix, step);
      break;
  }
}

// ---------------------------------------------------------------------------
// OAuth2 routes
// ---------------------------------------------------------------------------

function registerOAuthRoutes(
  integrationName: string,
  prefix: string,
  step: OAuthSetupStep,
): void {
  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/oauth/start`,
    handler: async (req, res) => {
      const host = req.headers.host || 'localhost:3030';
      const origin = `http://${host}`;
      const result = await step.startAuth(origin);
      sendJson(res, 200, result);
    },
  });

  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/oauth/callback`,
    handler: async (req, res) => {
      const host = req.headers.host || 'localhost:3030';
      const origin = `http://${host}`;
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';

      let success = false;
      let errorMsg = '';
      try {
        await step.completeAuth({ code, state, origin });
        success = true;
      } catch (err) {
        logger.error(
          { integration: integrationName, err: String(err) },
          'OAuth callback failed',
        );
        errorMsg = err instanceof Error ? err.message : 'OAuth failed';
      }

      // Return a self-closing HTML page — the parent window detects
      // the popup closing and refreshes the integration status.
      const html = success
        ? `<!DOCTYPE html><html><body><p>Connected! This window will close automatically.</p><script>window.close();</script></body></html>`
        : `<!DOCTYPE html><html><body><p>OAuth error: ${errorMsg.replace(/[<>&"]/g, '')}</p><p>You can close this window and try again.</p><script>setTimeout(function(){window.close()},5000);</script></body></html>`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
    },
  });

  // Also return the callback URL for display in the admin UI
  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/oauth/callback-url`,
    handler: async (req, res) => {
      const host = req.headers.host || 'localhost:3030';
      sendJson(res, 200, {
        callbackUrl: `http://${host}${step.callbackPath}`,
        callbackPath: step.callbackPath,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Credential input routes
// ---------------------------------------------------------------------------

function registerCredentialRoutes(
  integrationName: string,
  prefix: string,
  step: CredentialInputStep,
): void {
  registerRoute({
    method: 'POST',
    test: (m, p) => m === 'POST' && p === `${prefix}/credentials`,
    handler: async (req, res) => {
      const body = parseJson(await readBody(req)) as Record<string, string>;
      const result = await step.validate(body);
      if (!result.valid) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      await step.save(body);
      const def = getIntegration(integrationName);
      if (def?.channel) {
        const { isIntegrationEnabled } = await import('./settings-store.js');
        if (isIntegrationEnabled(integrationName)) {
          const { activateRegisteredChannel } =
            await import('../channel-runtime.js');
          await activateRegisteredChannel(integrationName);
        }
      }
      sendJson(res, 200, { ok: true });
    },
  });

  // GET fields schema
  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/credentials/fields`,
    handler: async (_req, res) => {
      sendJson(res, 200, {
        label: step.label,
        description: step.description,
        helpUrl: step.helpUrl,
        fields: step.fields,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Form routes
// ---------------------------------------------------------------------------

function registerFormRoutes(
  integrationName: string,
  prefix: string,
  step: FormSetupStep,
  idx: number,
): void {
  registerRoute({
    method: 'POST',
    test: (m, p) => m === 'POST' && p === `${prefix}/form/${idx}`,
    handler: async (req, res) => {
      const body = parseJson(await readBody(req));
      if (step.validate) {
        const result = await step.validate(body);
        if (!result.valid) {
          sendJson(res, 400, { errors: result.errors });
          return;
        }
      }
      await step.save(body);
      const def = getIntegration(integrationName);
      if (def?.channel) {
        const { isIntegrationEnabled } = await import('./settings-store.js');
        if (isIntegrationEnabled(integrationName)) {
          const { activateRegisteredChannel } =
            await import('../channel-runtime.js');
          await activateRegisteredChannel(integrationName);
        }
      }
      sendJson(res, 200, { ok: true });
    },
  });

  // GET schema
  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/form/${idx}/schema`,
    handler: async (_req, res) => {
      sendJson(res, 200, {
        label: step.label,
        description: step.description,
        schema: step.schema,
        defaults: step.defaults,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// QR code routes
// ---------------------------------------------------------------------------

function registerQrRoutes(
  _integrationName: string,
  prefix: string,
  step: QrCodeSetupStep,
): void {
  registerRoute({
    method: 'POST',
    test: (m, p) => m === 'POST' && p === `${prefix}/qr/generate`,
    handler: async (req, res) => {
      const body = parseJson(await readBody(req)) as Record<string, string>;
      const result = await step.generateQr(body);
      sendJson(res, 200, result);
    },
  });

  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/qr/poll`,
    handler: async (_req, res) => {
      const result = await step.pollComplete();
      sendJson(res, 200, result);
    },
  });

  // GET input fields
  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/qr/fields`,
    handler: async (_req, res) => {
      sendJson(res, 200, {
        label: step.label,
        description: step.description,
        inputFields: step.inputFields,
        pollIntervalMs: step.pollIntervalMs ?? 2000,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Verification code routes
// ---------------------------------------------------------------------------

function registerVerificationRoutes(
  _integrationName: string,
  prefix: string,
  step: VerificationCodeSetupStep,
): void {
  registerRoute({
    method: 'POST',
    test: (m, p) => m === 'POST' && p === `${prefix}/verify/send`,
    handler: async (req, res) => {
      const body = parseJson(await readBody(req)) as Record<string, string>;
      const result = await step.sendCode(body);
      sendJson(res, 200, result);
    },
  });

  registerRoute({
    method: 'POST',
    test: (m, p) => m === 'POST' && p === `${prefix}/verify/check`,
    handler: async (req, res) => {
      const body = parseJson(await readBody(req)) as {
        code?: string;
      };
      if (!body.code) {
        sendJson(res, 400, { error: 'code is required' });
        return;
      }
      const result = await step.verifyCode(body.code);
      sendJson(res, 200, result);
    },
  });
}

// ---------------------------------------------------------------------------
// Webhook URL routes
// ---------------------------------------------------------------------------

function registerWebhookRoutes(
  _integrationName: string,
  prefix: string,
  step: WebhookUrlSetupStep,
): void {
  registerRoute({
    method: 'GET',
    test: (m, p) => m === 'GET' && p === `${prefix}/webhook/url`,
    handler: async (_req, res) => {
      sendJson(res, 200, {
        url: step.getUrl(),
        label: step.label,
        description: step.description,
        helpUrl: step.helpUrl,
      });
    },
  });

  registerRoute({
    method: 'POST',
    test: (m, p) => m === 'POST' && p === `${prefix}/webhook/test`,
    handler: async (_req, res) => {
      const result = await step.validate();
      sendJson(res, 200, result);
    },
  });
}

// ---------------------------------------------------------------------------
// Custom routes
// ---------------------------------------------------------------------------

function registerCustomRoutes(
  _integrationName: string,
  prefix: string,
  step: CustomSetupStep,
): void {
  for (const route of step.routes) {
    registerRoute({
      method: route.method,
      test: (m, p) =>
        m === route.method && p === `${prefix}/custom${route.path}`,
      handler: async (req, res) => {
        await route.handler(req, res);
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Request dispatcher — called from admin-server.ts
// ---------------------------------------------------------------------------

/**
 * Try to handle a setup route. Returns true if handled.
 */
export async function handleSetupRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  pathname: string,
): Promise<boolean> {
  for (const route of routes) {
    if (route.test(method, pathname)) {
      // Extract integration name from path
      const match = pathname.match(
        /^\/api\/admin\/integrations\/([^/]+)\/setup/,
      );
      const integrationName = match?.[1] || '';

      try {
        await route.handler(req, res, { integrationName });
      } catch (err) {
        logger.error(
          { integration: integrationName, err: String(err), path: pathname },
          'Setup route error',
        );
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : 'Internal error',
        });
      }
      return true;
    }
  }
  return false;
}
