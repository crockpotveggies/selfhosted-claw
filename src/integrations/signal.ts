import { ADMIN_DATA_DIR, SIGNAL_ACCOUNT, SIGNAL_RPC_URL } from '../config.js';

import { registerIntegration } from './registry.js';
import type {
  IntegrationDefinition,
  IntegrationNotification,
  SetupStatus,
  CredentialInputStep,
  QrCodeSetupStep,
} from './types.js';
import { getIntegrationSettings } from './settings-store.js';

// ---------------------------------------------------------------------------
// Helpers (extracted from signal-compose.ts)
// ---------------------------------------------------------------------------

const DEFAULT_RPC_URL = 'http://127.0.0.1:8080';

function parseRpcUrl(rpcUrl: string): URL {
  const value = rpcUrl.trim() || DEFAULT_RPC_URL;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Signal RPC URL must use http or https');
  }
  return parsed;
}

function portFromRpcUrl(rpcUrl: string): string {
  const parsed = parseRpcUrl(rpcUrl);
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

function parseJsonMessage(text: string): string {
  if (!text.trim()) return '';
  try {
    const parsed = JSON.parse(text) as {
      message?: string;
      error?: string;
      detail?: string;
    };
    return parsed.message || parsed.error || parsed.detail || text.trim();
  } catch {
    return text.trim();
  }
}

// ---------------------------------------------------------------------------
// Setup flow steps
// ---------------------------------------------------------------------------

function getSettings(): { account: string; rpcUrl: string; dataDir: string } {
  const settings = getIntegrationSettings('signal');
  return {
    account: (settings.account as string) || SIGNAL_ACCOUNT || '',
    rpcUrl: (settings.rpcUrl as string) || SIGNAL_RPC_URL || DEFAULT_RPC_URL,
    dataDir:
      (settings.dataDir as string) || `${ADMIN_DATA_DIR}/signal-cli-managed`,
  };
}

const credentialStep: CredentialInputStep = {
  type: 'credential_input',
  label: 'Signal Account',
  description:
    'Enter the phone number and RPC URL for Signal. The RPC URL is where signal-cli-rest-api listens.',
  fields: [
    {
      key: 'account',
      label: 'Phone Number',
      type: 'text',
      placeholder: '+15551234567',
      required: true,
    },
    {
      key: 'rpcUrl',
      label: 'Signal RPC URL',
      type: 'url',
      placeholder: 'http://127.0.0.1:8080',
      required: false,
    },
  ],
  validate: async (values) => {
    const account = values.account?.trim();
    if (!account) {
      return { valid: false, error: 'Phone number is required' };
    }
    if (!account.startsWith('+')) {
      return {
        valid: false,
        error: 'Phone number must start with + and country code',
      };
    }
    return { valid: true };
  },
  save: async (values) => {
    // Settings are saved by the setup wizard framework after validation
    // The bootstrap input will be used by the service manager
    const { saveIntegrationSettings } = await import('./settings-store.js');
    const existing = getIntegrationSettings('signal');
    saveIntegrationSettings('signal', {
      ...existing,
      account: values.account.trim(),
      rpcUrl: values.rpcUrl?.trim() || DEFAULT_RPC_URL,
    });
  },
  isComplete: async () => {
    const s = getSettings();
    return Boolean(s.account);
  },
};

const qrCodeStep: QrCodeSetupStep = {
  type: 'qr_code',
  label: 'Link Signal Device',
  description:
    'Open Signal on your phone → Settings → Linked Devices → Scan the QR code below.',
  inputFields: [
    {
      key: 'deviceName',
      label: 'Device Name',
      type: 'text',
      placeholder: 'NanoClaw',
      required: true,
    },
  ],
  generateQr: async (input) => {
    const s = getSettings();
    const rpcUrl = parseRpcUrl(s.rpcUrl).toString().replace(/\/$/, '');
    const deviceName = input.deviceName?.trim() || 'NanoClaw';
    const url = new URL('/v1/qrcodelink', rpcUrl);
    url.searchParams.set('device_name', deviceName);

    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        parseJsonMessage(body) ||
          `Signal QR code request failed with ${response.status}`,
      );
    }
    const contentType = response.headers.get('content-type') || 'image/png';
    const body = Buffer.from(await response.arrayBuffer()).toString('base64');
    return { dataUrl: `data:${contentType};base64,${body}` };
  },
  pollComplete: async () => {
    // Check if the device has been linked by listing accounts
    const s = getSettings();
    try {
      const rpcUrl = parseRpcUrl(s.rpcUrl).toString().replace(/\/$/, '');
      const response = await fetch(new URL('/v1/accounts', rpcUrl));
      if (!response.ok) return { done: false };
      const accounts = (await response.json()) as unknown[];
      const linked = accounts.some((a) => {
        const num =
          typeof a === 'string'
            ? a
            : typeof a === 'object' && a !== null && 'number' in a
              ? String((a as { number: unknown }).number)
              : '';
        return num === s.account;
      });
      return { done: linked, message: linked ? 'Device linked!' : undefined };
    } catch {
      return { done: false };
    }
  },
  pollIntervalMs: 3000,
  isComplete: async () => {
    // Same as pollComplete but returns boolean
    const result = await qrCodeStep.pollComplete();
    return result.done;
  },
};

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

const signalIntegration: IntegrationDefinition = {
  name: 'signal',
  description: 'Signal Messenger via signal-cli JSON-RPC bridge',
  core: true,
  version: '1.0.0',
  credentials: [
    {
      key: 'SIGNAL_ACCOUNT',
      label: 'Signal Phone Number',
      type: 'secret',
      envVar: 'SIGNAL_ACCOUNT',
      required: true,
    },
    {
      key: 'SIGNAL_RPC_URL',
      label: 'Signal RPC URL',
      type: 'url',
      envVar: 'SIGNAL_RPC_URL',
      required: true,
    },
  ],

  settings: {
    schema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          title: 'Phone Number',
          description: 'Signal phone number with country code',
        },
        rpcUrl: {
          type: 'string',
          title: 'RPC URL',
          description: 'signal-cli-rest-api base URL',
          format: 'url',
        },
        receiveTimeoutSec: {
          type: 'integer',
          title: 'Receive Timeout (seconds)',
          description: 'WebSocket receive timeout',
          default: 5,
          minimum: 1,
          maximum: 30,
        },
        dataDir: {
          type: 'string',
          title: 'Data Directory',
          description: 'signal-cli persistent data directory',
        },
      },
    },
    defaults: {
      account: SIGNAL_ACCOUNT || '',
      rpcUrl: SIGNAL_RPC_URL || DEFAULT_RPC_URL,
      receiveTimeoutSec: 5,
      dataDir: `${ADMIN_DATA_DIR}/signal-cli-managed`,
    },
  },

  adminPage: {
    icon: 'cilChatBubble',
    category: 'messaging',
    getStatus: async () => {
      const s = getSettings();
      if (!s.account) {
        return { state: 'unconfigured', message: 'No account configured' };
      }
      try {
        const rpcUrl = parseRpcUrl(s.rpcUrl).toString().replace(/\/$/, '');
        const response = await fetch(new URL('/v1/accounts', rpcUrl), {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          return { state: 'online', message: 'Signal bridge is reachable' };
        }
        return {
          state: 'degraded',
          message: `RPC returned ${response.status}`,
        };
      } catch {
        return { state: 'offline', message: 'Signal bridge unreachable' };
      }
    },
    getNotifications: async () => {
      const notifications: IntegrationNotification[] = [];
      const s = getSettings();
      if (!s.account) {
        notifications.push({
          id: 'signal:not-configured',
          integration: 'signal',
          severity: 'warning',
          title: 'Signal Not Configured',
          message:
            'No Signal account configured. Run setup from the Integrations page.',
        });
        return notifications;
      }
      try {
        const rpcUrl = parseRpcUrl(s.rpcUrl).toString().replace(/\/$/, '');
        const response = await fetch(new URL('/v1/accounts', rpcUrl), {
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
          notifications.push({
            id: 'signal:bridge-degraded',
            integration: 'signal',
            severity: 'warning',
            title: 'Signal Bridge Degraded',
            message: `RPC returned status ${response.status}`,
          });
        }
      } catch {
        notifications.push({
          id: 'signal:bridge-offline',
          integration: 'signal',
          severity: 'error',
          title: 'Signal Bridge Offline',
          message: 'Cannot reach the signal-cli RPC. Check the service status.',
        });
      }
      return notifications;
    },
  },

  // NOTE: channel is deliberately NOT set here.
  // Signal channel is registered via the legacy path (src/channels/signal.ts)
  // to avoid double-registration. See plan: "Phase 1 Signal has NO channel property."

  service: {
    composeFile: 'scripts/signal-cli/docker-compose.yml',
    envFile: 'scripts/signal-cli/.env',
    serviceName: 'signal-cli',
    buildEnv: (settings) => ({
      SIGNAL_ACCOUNT: (settings.account as string) || '',
      SIGNAL_RPC_URL: (settings.rpcUrl as string) || DEFAULT_RPC_URL,
      SIGNAL_CLI_PORT: portFromRpcUrl(
        (settings.rpcUrl as string) || DEFAULT_RPC_URL,
      ),
      SIGNAL_CLI_DATA_DIR:
        (settings.dataDir as string) || `${ADMIN_DATA_DIR}/signal-cli-managed`,
    }),
    healthCheck: {
      url: `${SIGNAL_RPC_URL || DEFAULT_RPC_URL}/v1/accounts`,
      intervalMs: 30_000,
    },
    setup: {
      fetchLinkQr: async (rpcUrl, deviceName) => {
        const result = await qrCodeStep.generateQr({ deviceName });
        return result.dataUrl;
      },
      listAccounts: async (rpcUrl) => {
        const base = parseRpcUrl(rpcUrl).toString().replace(/\/$/, '');
        const response = await fetch(new URL('/v1/accounts', base));
        if (!response.ok) return [];
        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) return [];
        return payload
          .map((item) =>
            typeof item === 'string'
              ? item
              : typeof item === 'object' && item !== null && 'number' in item
                ? String((item as { number: unknown }).number)
                : '',
          )
          .filter(Boolean);
      },
      startRegistration: async (input) => {
        const rpcUrl = parseRpcUrl(input.rpcUrl).toString().replace(/\/$/, '');
        const url = new URL(
          `/v1/register/${encodeURIComponent(input.account)}`,
          rpcUrl,
        );
        const body: Record<string, unknown> = {
          use_voice: input.useVoice,
        };
        if (input.captchaToken?.trim()) {
          body.captcha = input.captchaToken.trim();
        }
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        if (response.status === 402 || (text && /captcha/i.test(text))) {
          return {
            message:
              parseJsonMessage(text) ||
              'Captcha required before Signal will send the verification code.',
            captchaRequired: true,
            captchaUrl: 'https://signalcaptchas.org/registration/generate.html',
          };
        }
        if (!response.ok) {
          throw new Error(
            parseJsonMessage(text) ||
              `Signal registration failed with ${response.status}`,
          );
        }
        return {
          message: parseJsonMessage(text) || 'Signal registration started.',
        };
      },
      verifyRegistration: async (input) => {
        const rpcUrl = parseRpcUrl(input.rpcUrl).toString().replace(/\/$/, '');
        const url = new URL(
          `/v1/register/${encodeURIComponent(input.account)}/verify/${encodeURIComponent(input.code)}`,
          rpcUrl,
        );
        const response = await fetch(url, { method: 'POST' });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(
            parseJsonMessage(text) ||
              `Signal verification failed with ${response.status}`,
          );
        }
        return {
          message: parseJsonMessage(text) || 'Signal registration verified.',
        };
      },
    },
  },

  memory: {
    contextChars: 200,
  },

  setup: {
    steps: [credentialStep, qrCodeStep],
    getStatus: async () => {
      const credComplete = await credentialStep.isComplete();
      const qrComplete = await qrCodeStep.isComplete();
      return {
        completed: credComplete && qrComplete,
        currentStep: credComplete ? 1 : 0,
        steps: [
          {
            type: 'credential_input',
            label: credentialStep.label,
            status: credComplete ? 'completed' : 'pending',
          },
          {
            type: 'qr_code',
            label: qrCodeStep.label,
            status: qrComplete
              ? 'completed'
              : credComplete
                ? 'pending'
                : 'pending',
          },
        ],
      };
    },
  },
};

// Self-register
registerIntegration(signalIntegration);
