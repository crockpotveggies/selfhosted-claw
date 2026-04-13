import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import { ADMIN_BIND_HOST, ADMIN_CONFIG_DIR, ADMIN_PORT } from '../config.js';
import { readEnvFile } from '../env.js';
import { createChildLogger } from '../logger.js';
import { resolveSignalTarget } from '../outbound-directives.js';
import type { GoogleContactsOAuthState } from '../control-types.js';

import { registerIntegration } from './registry.js';
import {
  getIntegrationSettings,
  saveIntegrationSettings,
} from './settings-store.js';
import type {
  IntegrationDefinition,
  IntegrationNotification,
  IntegrationTool,
} from './types.js';

const log = createChildLogger({ integration: 'google-contacts' });

const GOOGLE_CONTACTS_SCOPE =
  'https://www.googleapis.com/auth/contacts.readonly';
const CALLBACK_PATH =
  '/api/admin/integrations/google-contacts/setup/oauth/callback';
const LEGACY_OAUTH_PATH = path.join(
  ADMIN_CONFIG_DIR,
  'google-contacts-oauth.json',
);

type ContactsChannel = 'signal' | 'whatsapp' | 'sms' | 'email';

interface GooglePerson {
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
}

interface GoogleContactsPayload {
  results?: Array<{
    person?: GooglePerson;
  }>;
}

interface ContactSearchResult {
  displayName: string;
  emails: string[];
  phones: string[];
  resolvedTarget: string;
  channel: ContactsChannel;
}

function readLegacyOAuthState(): GoogleContactsOAuthState {
  try {
    return JSON.parse(
      fs.readFileSync(LEGACY_OAUTH_PATH, 'utf-8'),
    ) as GoogleContactsOAuthState;
  } catch {
    return {
      accessToken: '',
      refreshToken: '',
      expiryDate: new Date(0).toISOString(),
      scope: '',
      tokenType: '',
      connectedAt: '',
      oauthState: '',
      oauthStateCreatedAt: '',
    };
  }
}

function writeLegacyOAuthState(state: GoogleContactsOAuthState): void {
  fs.mkdirSync(path.dirname(LEGACY_OAUTH_PATH), { recursive: true });
  const tempPath = `${LEGACY_OAUTH_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, LEGACY_OAUTH_PATH);
}

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  return {
    clientId: env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret:
      env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
  };
}

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function readIntegrationOAuthState(): GoogleContactsOAuthState {
  const settings = getIntegrationSettings('google-contacts');
  return {
    accessToken: String(settings.accessToken || ''),
    refreshToken: String(settings.refreshToken || ''),
    expiryDate: String(settings.expiryDate || new Date(0).toISOString()),
    scope: String(settings.scope || ''),
    tokenType: String(settings.tokenType || ''),
    connectedAt: String(settings.connectedAt || ''),
    oauthState: String(settings.oauthState || ''),
    oauthStateCreatedAt: String(settings.oauthStateCreatedAt || ''),
  };
}

function writeIntegrationOAuthState(state: GoogleContactsOAuthState): void {
  const settings = getIntegrationSettings('google-contacts');
  saveIntegrationSettings('google-contacts', {
    ...settings,
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    expiryDate: state.expiryDate,
    scope: state.scope,
    tokenType: state.tokenType,
    connectedAt: state.connectedAt,
    oauthState: state.oauthState,
    oauthStateCreatedAt: state.oauthStateCreatedAt,
  });
}

/**
 * Get OAuth state from the integration's OWN settings store first,
 * falling back to legacy file only for backward-compat token access.
 * Admin UI status/setup checks should use getOwnOAuthState() instead.
 */
function getStoredOAuthState(): GoogleContactsOAuthState {
  const integrationState = readIntegrationOAuthState();
  if (integrationState.accessToken || integrationState.refreshToken) {
    return integrationState;
  }
  return readLegacyOAuthState();
}

/**
 * Get OAuth state ONLY from the integration's own settings store.
 * Used by status checks and isComplete — the integration is only
 * "connected" when it has done its own OAuth flow.
 */
function getOwnOAuthState(): GoogleContactsOAuthState {
  return readIntegrationOAuthState();
}

function writeOAuthState(state: GoogleContactsOAuthState): void {
  writeIntegrationOAuthState(state);
  writeLegacyOAuthState(state);
}

function resolveTargetForChannel(
  channel: ContactsChannel,
  phone: string,
  email: string,
): string {
  if (channel === 'email') return email;
  if (channel === 'sms') return phone;
  if (channel === 'whatsapp') {
    return `${phone.replace(/[^\d]/g, '')}@s.whatsapp.net`;
  }
  return resolveSignalTarget(phone).jid;
}

function isTokenExpired(expiryDate: string): boolean {
  const expiresAt = new Date(expiryDate).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000;
}

async function refreshAccessToken(
  current: GoogleContactsOAuthState,
): Promise<GoogleContactsOAuthState | null> {
  if (!current.refreshToken) return null;
  const { clientId, clientSecret } = getClientCredentials();
  if (!clientId || !clientSecret) return null;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: current.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!response.ok || !payload.access_token) return null;

  const next: GoogleContactsOAuthState = {
    ...current,
    accessToken: payload.access_token,
    expiryDate: new Date(
      Date.now() + Math.max(60, payload.expires_in || 3600) * 1000,
    ).toISOString(),
    scope: payload.scope || current.scope || GOOGLE_CONTACTS_SCOPE,
    tokenType: payload.token_type || current.tokenType || 'Bearer',
    connectedAt: current.connectedAt || new Date().toISOString(),
  };
  writeOAuthState(next);
  return next;
}

export async function ensureGoogleContactsAccessToken(): Promise<string> {
  let stored = getStoredOAuthState();
  if (!stored.accessToken && !stored.refreshToken) return '';
  if (stored.accessToken && !isTokenExpired(stored.expiryDate)) {
    return stored.accessToken;
  }
  const refreshed = await refreshAccessToken(stored);
  if (refreshed?.accessToken) return refreshed.accessToken;
  return stored.accessToken || '';
}

function pickDisplayName(
  person: GooglePerson | undefined,
  fallback: string,
): string {
  return (
    person?.names
      ?.find((entry) => entry.displayName?.trim())
      ?.displayName?.trim() || fallback
  );
}

function pickEmails(person: GooglePerson | undefined): string[] {
  return (person?.emailAddresses || [])
    .map((entry) => entry.value?.trim() || '')
    .filter(Boolean);
}

function pickPhones(person: GooglePerson | undefined): string[] {
  return (person?.phoneNumbers || [])
    .map((entry) => normalizePhone(entry.canonicalForm || entry.value || ''))
    .filter(Boolean);
}

export async function searchGoogleContactsApi(
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<Array<{ displayName: string; emails: string[]; phones: string[] }>> {
  const response = await fetch(
    `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(
      query,
    )}&pageSize=${encodeURIComponent(String(maxResults))}&readMask=names,emailAddresses,phoneNumbers`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Google contact lookup failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const payload = (await response.json()) as GoogleContactsPayload;
  return (payload.results || [])
    .map((entry) => entry.person)
    .filter(Boolean)
    .map((person) => ({
      displayName: pickDisplayName(person, query),
      emails: pickEmails(person),
      phones: pickPhones(person),
    }))
    .filter((person) => person.emails.length > 0 || person.phones.length > 0);
}

export async function searchGoogleContactsForChannel(
  accessToken: string,
  channel: ContactsChannel,
  query: string,
  maxResults: number,
): Promise<ContactSearchResult[]> {
  const contacts = await searchGoogleContactsApi(
    accessToken,
    query,
    maxResults,
  );
  return contacts
    .map((contact) => {
      const email = contact.emails[0] || '';
      const phone = contact.phones[0] || '';
      if (channel === 'email' && !email) return null;
      if (channel !== 'email' && !phone) return null;
      return {
        displayName: contact.displayName,
        emails: contact.emails,
        phones: contact.phones,
        resolvedTarget: resolveTargetForChannel(channel, phone, email),
        channel,
      };
    })
    .filter((contact): contact is ContactSearchResult => Boolean(contact));
}

export async function resolveGoogleContactsTarget<
  TChannel extends ContactsChannel,
>(
  channel: TChannel,
  query: string,
): Promise<{
  channel: TChannel;
  query: string;
  resolvedTarget: string;
  displayName: string;
  source: 'google_contacts';
  existingConversation: boolean;
} | null> {
  const token = await ensureGoogleContactsAccessToken();
  if (!token) return null;
  const results = await searchGoogleContactsForChannel(
    token,
    channel,
    query,
    10,
  );
  if (results.length === 0) return null;
  if (results.length > 1) {
    throw new Error(
      `Multiple Google contacts matched "${query}": ${results
        .slice(0, 5)
        .map((result) => result.displayName)
        .join(', ')}`,
    );
  }
  const result = results[0];
  return {
    channel,
    query,
    resolvedTarget: result.resolvedTarget,
    displayName: result.displayName,
    source: 'google_contacts',
    existingConversation: false,
  };
}

async function startAuth(
  origin: string,
): Promise<{ url: string; state: string }> {
  const { clientId, clientSecret } = getClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required before connecting Google Contacts.',
    );
  }

  const state = randomBytes(18).toString('base64url');
  const current = getStoredOAuthState();
  writeOAuthState({
    ...current,
    oauthState: state,
    oauthStateCreatedAt: new Date().toISOString(),
  });

  const redirectUri = `${origin.replace(/\/$/, '')}${CALLBACK_PATH}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_CONTACTS_SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return { url: authUrl.toString(), state };
}

async function completeAuth(input: {
  code: string;
  state: string;
  origin: string;
}): Promise<void> {
  const { clientId, clientSecret } = getClientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth client settings are missing. Save the client ID and secret first.',
    );
  }

  const stored = getStoredOAuthState();
  if (!stored.oauthState || stored.oauthState !== input.state) {
    throw new Error(
      'Google OAuth state did not match the active login request.',
    );
  }

  const redirectUri = `${input.origin.replace(/\/$/, '')}${CALLBACK_PATH}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code: input.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description ||
        payload.error ||
        `Token exchange failed with ${response.status}`,
    );
  }

  writeOAuthState({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || stored.refreshToken,
    expiryDate: new Date(
      Date.now() + Math.max(60, payload.expires_in || 3600) * 1000,
    ).toISOString(),
    scope: payload.scope || GOOGLE_CONTACTS_SCOPE,
    tokenType: payload.token_type || 'Bearer',
    connectedAt: new Date().toISOString(),
    oauthState: '',
    oauthStateCreatedAt: '',
  });
}

const searchTool: IntegrationTool = {
  name: 'google_contacts.search',
  description: 'Search Google Contacts by name, email, or phone number.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (name, email, or phone)',
      },
      channel: {
        type: 'string',
        enum: ['signal', 'whatsapp', 'sms', 'email'],
        description: 'Which channel to resolve for',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  location: 'host',
  execute: async (args, ctx) => {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');
    const channel = (
      typeof args.channel === 'string' ? args.channel : 'signal'
    ) as ContactsChannel;
    const maxResults = Math.max(
      1,
      Math.min(50, Number(ctx.settings.maxResults || 10) || 10),
    );
    const accessToken = await ensureGoogleContactsAccessToken();
    if (!accessToken) {
      throw new Error(
        'Google Contacts is not configured or requires re-authentication.',
      );
    }
    const results = await searchGoogleContactsForChannel(
      accessToken,
      channel,
      query,
      maxResults,
    );
    return JSON.stringify({
      query,
      channel,
      results,
    });
  },
};

const googleContactsIntegration: IntegrationDefinition = {
  name: 'google-contacts',
  description: 'Google Contacts — contact resolution for outbound messaging',
  core: false,
  version: '1.0.0',
  credentials: [
    {
      key: 'GOOGLE_CLIENT_ID',
      label: 'Google Client ID',
      type: 'secret',
      envVar: 'GOOGLE_CLIENT_ID',
      required: true,
    },
    {
      key: 'GOOGLE_CLIENT_SECRET',
      label: 'Google Client Secret',
      type: 'secret',
      envVar: 'GOOGLE_CLIENT_SECRET',
      required: true,
    },
  ],
  settings: {
    schema: {
      type: 'object',
      properties: {
        maxResults: {
          type: 'integer',
          title: 'Max search results',
          default: 10,
          minimum: 1,
          maximum: 50,
        },
      },
    },
    defaults: {
      maxResults: 10,
    },
  },
  adminPage: {
    icon: 'cilAddressBook',
    category: 'productivity',
    getStatus: async () => {
      const own = getOwnOAuthState();
      if (!own.accessToken && !own.refreshToken) {
        return {
          state: 'unconfigured',
          message: 'Not connected — run setup from the integration page',
        };
      }
      if (own.accessToken && !isTokenExpired(own.expiryDate)) {
        return {
          state: 'online',
          message: `Connected${own.connectedAt ? ` since ${own.connectedAt.split('T')[0]}` : ''}`,
        };
      }
      if (own.refreshToken) {
        const refreshed = await refreshAccessToken(own).catch(() => null);
        if (refreshed?.accessToken) {
          return {
            state: 'online',
            message: `Connected${refreshed.connectedAt ? ` since ${refreshed.connectedAt.split('T')[0]}` : ''}`,
          };
        }
        return {
          state: 'degraded',
          message: 'OAuth token expired or refresh failed — re-authenticate',
        };
      }
      return {
        state: 'degraded',
        message: 'OAuth token expired — re-authenticate',
      };
    },
    getNotifications: async () => {
      const notifications: IntegrationNotification[] = [];
      const own = getOwnOAuthState();
      if (!own.accessToken && !own.refreshToken) {
        return notifications; // Not connected yet — no alert needed
      }
      if (own.accessToken && !isTokenExpired(own.expiryDate)) {
        return notifications;
      }
      const refreshed = own.refreshToken
        ? await refreshAccessToken(own).catch(() => null)
        : null;
      if (!refreshed?.accessToken) {
        notifications.push({
          id: 'google-contacts:oauth-expired',
          integration: 'google-contacts',
          severity: 'error',
          title: 'Google Contacts OAuth Expired',
          message:
            'The Google Contacts access token has expired or been revoked. Re-authenticate from the integration setup page.',
        });
      }
      return notifications;
    },
  },
  tools: [searchTool],
  setup: {
    steps: [
      {
        type: 'oauth2',
        label: 'Connect Google Account',
        provider: 'google',
        scopes: [GOOGLE_CONTACTS_SCOPE],
        callbackPath: CALLBACK_PATH,
        helpUrl: 'https://console.cloud.google.com/apis/credentials',
        startAuth,
        completeAuth,
        isComplete: async () => {
          const own = getOwnOAuthState();
          return Boolean(own.accessToken || own.refreshToken);
        },
      },
    ],
    getStatus: async () => {
      const host = `${ADMIN_BIND_HOST}:${ADMIN_PORT}`;
      const own = getOwnOAuthState();
      const hasOwnToken = Boolean(own.accessToken || own.refreshToken);
      return {
        completed: hasOwnToken,
        currentStep: hasOwnToken ? 1 : 0,
        steps: [
          {
            type: 'oauth2',
            label: 'Connect Google Account',
            description: `Register callback URL: http://${host}${CALLBACK_PATH}`,
            status: hasOwnToken ? 'completed' : 'pending',
          },
        ],
      };
    },
  },
};

registerIntegration(googleContactsIntegration);

log.debug('Google Contacts integration registered');
