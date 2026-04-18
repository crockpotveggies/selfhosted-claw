/**
 * Google Calendar integration — installable, not core.
 *
 * The integration owns the agent-facing calendar tools directly. Runtime
 * visibility still comes from the tool registry, while host-side execute
 * handlers preserve the existing control-chat auth and privacy rules.
 */

import fs from 'fs';
import path from 'path';

import { ADMIN_BIND_HOST, ADMIN_CONFIG_DIR, ADMIN_PORT } from '../config.js';
import {
  assertCalendarMutationAllowed,
  assertCalendarReadDetailAllowed,
  calendarCheckAvailabilityApi,
  calendarCreateEventApi,
  calendarDeleteEventApi,
  calendarGetEventApi,
  calendarListEventsApi,
  calendarUpdateEventApi,
  sanitizeCalendarListResult,
} from './calendar-runtime.js';
import { getGoogleOAuthClientCredentials } from './google-oauth-client.js';

import { registerIntegration } from './registry.js';
import {
  getIntegrationSettings,
  saveIntegrationSettings,
} from './settings-store.js';
import { clearIntegrationRuntimeFault } from './runtime-health.js';
import type {
  IntegrationDefinition,
  IntegrationNotification,
  IntegrationTool,
} from './types.js';

// ---------------------------------------------------------------------------
// Legacy OAuth state — read from the existing google-contacts-oauth.json
// which also holds calendar tokens (shared OAuth with expanded scopes)
// ---------------------------------------------------------------------------

interface LegacyOAuthState {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: string;
  scope?: string;
  tokenType?: string;
  connectedAt?: string;
}

function readLegacyOAuthState(): LegacyOAuthState {
  try {
    const filePath = path.join(ADMIN_CONFIG_DIR, 'google-contacts-oauth.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LegacyOAuthState;
  } catch {
    return {};
  }
}

function writeLegacyOAuthState(state: LegacyOAuthState): void {
  const filePath = path.join(ADMIN_CONFIG_DIR, 'google-contacts-oauth.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

function hasCalendarScope(state: LegacyOAuthState): boolean {
  if (!state.scope) return false;
  return (
    state.scope.includes('calendar.readonly') ||
    state.scope.includes('calendar.events')
  );
}

async function tryRefreshLegacyOAuthState(
  state: LegacyOAuthState,
): Promise<LegacyOAuthState | null> {
  if (!state.refreshToken) return null;

  const { clientId, clientSecret } = getGoogleOAuthClientCredentials();
  if (!clientId || !clientSecret) {
    return null;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: state.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!response.ok || !payload.access_token) {
    return null;
  }

  const next: LegacyOAuthState = {
    ...state,
    accessToken: payload.access_token,
    expiryDate: new Date(
      Date.now() + Math.max(60, payload.expires_in || 3600) * 1000,
    ).toISOString(),
    scope: payload.scope || state.scope || '',
    tokenType: payload.token_type || state.tokenType || 'Bearer',
    connectedAt: state.connectedAt || new Date().toISOString(),
  };
  writeLegacyOAuthState(next);
  return next;
}

// ---------------------------------------------------------------------------
// Tool definitions (match existing TOOL_REGISTRY in agent-runner)
// ---------------------------------------------------------------------------

const calendarTools: IntegrationTool[] = [
  {
    name: 'calendar_list_events',
    description:
      'List Google Calendar events in a time range. Returns event summaries, times, and attendees.',
    parameters: {
      type: 'object',
      properties: {
        calendar_id: {
          type: 'string',
          description: 'Calendar ID (default: "primary")',
        },
        time_min: {
          type: 'string',
          description: 'Start of time range (ISO 8601)',
        },
        time_max: {
          type: 'string',
          description: 'End of time range (ISO 8601)',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum events to return (default: 25)',
        },
        query: {
          type: 'string',
          description: 'Free-text search query',
        },
      },
    },
    controllerOnly: true,
    location: 'host',
    sideEffecting: false,
    execute: async (args, ctx) => {
      const result = await calendarListEventsApi(
        {
          readLegacyOAuthState,
          writeLegacyOAuthState,
        },
        {
          calendarId: String(args.calendar_id || 'primary'),
          timeMin: String(args.time_min || ''),
          timeMax: String(args.time_max || ''),
          maxResults: Number(args.max_results || 25),
          query: args.query ? String(args.query) : undefined,
        },
      );
      return JSON.stringify(
        sanitizeCalendarListResult(result, {
          calendarAccess: ctx.calendarAccess,
        }),
      );
    },
  },
  {
    name: 'calendar_check_availability',
    description: 'Check free/busy availability across one or more calendars.',
    parameters: {
      type: 'object',
      properties: {
        time_min: {
          type: 'string',
          description: 'Start of time range (ISO 8601)',
        },
        time_max: {
          type: 'string',
          description: 'End of time range (ISO 8601)',
        },
        calendar_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Calendar IDs to check (default: ["primary"])',
        },
      },
      required: ['time_min', 'time_max'],
    },
    controllerOnly: false,
    location: 'host',
    sideEffecting: false,
    execute: async (args) => {
      const result = await calendarCheckAvailabilityApi(
        {
          readLegacyOAuthState,
          writeLegacyOAuthState,
        },
        {
          timeMin: String(args.time_min || ''),
          timeMax: String(args.time_max || ''),
          calendarIds: Array.isArray(args.calendar_ids)
            ? args.calendar_ids.map((id) => String(id))
            : ['primary'],
        },
      );
      return JSON.stringify(result);
    },
  },
  {
    name: 'calendar_get_event',
    description: 'Get details of a specific calendar event by ID.',
    parameters: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        event_id: { type: 'string', description: 'The event ID' },
      },
      required: ['event_id'],
    },
    controllerOnly: true,
    location: 'host',
    sideEffecting: false,
    execute: async (args, ctx) => {
      assertCalendarReadDetailAllowed({ calendarAccess: ctx.calendarAccess });
      const result = await calendarGetEventApi(
        {
          readLegacyOAuthState,
          writeLegacyOAuthState,
        },
        {
          calendarId: String(args.calendar_id || 'primary'),
          eventId: String(args.event_id || ''),
        },
      );
      return JSON.stringify(result);
    },
  },
  {
    name: 'calendar_create_event',
    description:
      'Create a new calendar event with summary, start, end, and optional attendees.',
    parameters: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601)' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses of attendees',
        },
      },
      required: ['summary', 'start', 'end'],
    },
    controllerOnly: true,
    location: 'host',
    sideEffecting: true,
    execute: async (args, ctx) => {
      assertCalendarMutationAllowed({ calendarAccess: ctx.calendarAccess });
      const result = await calendarCreateEventApi(
        {
          readLegacyOAuthState,
          writeLegacyOAuthState,
        },
        {
          calendarId: String(args.calendar_id || 'primary'),
          summary: String(args.summary || ''),
          start: String(args.start || ''),
          end: String(args.end || ''),
          description: args.description ? String(args.description) : undefined,
          location: args.location ? String(args.location) : undefined,
          attendees: Array.isArray(args.attendees)
            ? args.attendees.map((email) => String(email))
            : undefined,
        },
      );
      return JSON.stringify(result);
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Update an existing calendar event.',
    parameters: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        event_id: { type: 'string' },
        summary: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
      },
      required: ['event_id'],
    },
    controllerOnly: true,
    location: 'host',
    sideEffecting: true,
    execute: async (args, ctx) => {
      assertCalendarMutationAllowed({ calendarAccess: ctx.calendarAccess });
      const result = await calendarUpdateEventApi(
        {
          readLegacyOAuthState,
          writeLegacyOAuthState,
        },
        {
          calendarId: String(args.calendar_id || 'primary'),
          eventId: String(args.event_id || ''),
          summary:
            args.summary !== undefined ? String(args.summary) : undefined,
          start: args.start !== undefined ? String(args.start) : undefined,
          end: args.end !== undefined ? String(args.end) : undefined,
          description:
            args.description !== undefined
              ? String(args.description)
              : undefined,
          location:
            args.location !== undefined ? String(args.location) : undefined,
          attendees: Array.isArray(args.attendees)
            ? args.attendees.map((email) => String(email))
            : args.attendees !== undefined
              ? []
              : undefined,
        },
      );
      return JSON.stringify(result);
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete (cancel) a calendar event.',
    parameters: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        event_id: { type: 'string' },
      },
      required: ['event_id'],
    },
    controllerOnly: true,
    location: 'host',
    sideEffecting: true,
    execute: async (args, ctx) => {
      assertCalendarMutationAllowed({ calendarAccess: ctx.calendarAccess });
      const result = await calendarDeleteEventApi(
        {
          readLegacyOAuthState,
          writeLegacyOAuthState,
        },
        {
          calendarId: String(args.calendar_id || 'primary'),
          eventId: String(args.event_id || ''),
        },
      );
      return JSON.stringify(result);
    },
  },
];

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

const callbackPath = `/api/admin/integrations/google-calendar/setup/oauth/callback`;

const calendarIntegration: IntegrationDefinition = {
  name: 'google-calendar',
  description:
    'Google Calendar event management — list, create, update, delete events',
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
        defaultCalendarId: {
          type: 'string',
          title: 'Default Calendar ID',
          description:
            'Calendar ID used when none specified (e.g., "primary" or an email address)',
          default: 'primary',
        },
        maxResults: {
          type: 'integer',
          title: 'Max Results',
          description: 'Maximum events returned per query',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
      },
    },
    defaults: {
      defaultCalendarId: 'primary',
      maxResults: 25,
    },
    perGroup: false,
  },

  adminPage: {
    icon: 'cilCalendar',
    category: 'productivity',
    getStatus: async (ctx) => {
      // Check legacy OAuth state (shared google-contacts-oauth.json)
      let legacy = readLegacyOAuthState();
      if (legacy.accessToken && hasCalendarScope(legacy)) {
        const expiry = legacy.expiryDate ? new Date(legacy.expiryDate) : null;
        const isExpired = expiry && expiry.getTime() < Date.now();
        if (isExpired) {
          const refreshed = await tryRefreshLegacyOAuthState(legacy).catch(
            () => null,
          );
          if (refreshed?.accessToken) {
            legacy = refreshed;
          } else {
            return {
              state: 'degraded',
              message:
                'OAuth token expired or refresh failed — re-authenticate',
            };
          }
        }
        const calId = ctx.settings.defaultCalendarId || 'primary';
        return {
          state: 'online',
          message: `Connected (calendar: ${calId}, since ${legacy.connectedAt?.split('T')[0] || 'unknown'})`,
        };
      }

      // Check integration-level OAuth
      if (ctx.settings.oauthConnectedAt) {
        return {
          state: 'online',
          message: `Connected via integration OAuth (${(ctx.settings.oauthConnectedAt as string).split('T')[0]})`,
        };
      }

      // Check env-level credentials
      const { clientId, clientSecret } = getGoogleOAuthClientCredentials();
      if (!clientId || !clientSecret) {
        return {
          state: 'unconfigured',
          message: 'No Google OAuth connection — connect via admin UI',
        };
      }

      return {
        state: 'unconfigured',
        message: 'Client ID set but OAuth flow not completed',
      };
    },
    getNotifications: async () => {
      const notifications: IntegrationNotification[] = [];
      let legacy = readLegacyOAuthState();
      const settings = getIntegrationSettings('google-calendar');

      if (legacy.accessToken && hasCalendarScope(legacy)) {
        const expiry = legacy.expiryDate ? new Date(legacy.expiryDate) : null;
        const isExpired = expiry && expiry.getTime() < Date.now();
        if (isExpired) {
          const refreshed = await tryRefreshLegacyOAuthState(legacy).catch(
            () => null,
          );
          if (refreshed?.accessToken) {
            legacy = refreshed;
          } else {
            notifications.push({
              id: 'google-calendar:oauth-expired',
              integration: 'google-calendar',
              severity: 'error',
              title: 'Google OAuth Token Expired',
              message:
                'The Google access token has expired or been revoked. Re-authenticate from the integration setup page.',
            });
          }
        }
      } else if (!legacy.accessToken && !settings.oauthConnectedAt) {
        if (!settings.oauthConnectedAt) {
          notifications.push({
            id: 'google-calendar:not-connected',
            integration: 'google-calendar',
            severity: 'info',
            title: 'Google Calendar Not Connected',
            message:
              'Connect your Google account from the integration setup page.',
          });
        }
      }

      return notifications;
    },
  },

  tools: calendarTools,

  memory: {
    contextChars: 300,
    contextTags: ['scheduling', 'meeting', 'availability', 'calendar'],
  },

  setup: {
    steps: [
      {
        type: 'oauth2' as const,
        label: 'Connect Google Account',
        provider: 'google',
        scopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/calendar.events',
        ],
        callbackPath,
        helpUrl: 'https://console.cloud.google.com/apis/credentials',
        startAuth: async (origin) => {
          const { clientId } = getGoogleOAuthClientCredentials();
          if (!clientId) {
            throw new Error(
              'GOOGLE_CLIENT_ID not configured. Set it in .env or integration settings.',
            );
          }
          const redirectUri = `${origin}${callbackPath}`;
          const scopes = [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.events',
          ].join(' ');
          const state = `cal_${Date.now()}`;
          const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&state=${state}`;
          return { url, state };
        },
        completeAuth: async ({ code, state, origin }) => {
          // Exchange authorization code for access + refresh tokens
          const { clientId, clientSecret } = getGoogleOAuthClientCredentials();
          if (!clientId || !clientSecret) {
            throw new Error(
              'Google OAuth client settings are missing. Save the client ID and secret first.',
            );
          }
          const redirectUri = `${origin}${callbackPath}`;

          const tokenResponse = await fetch(
            'https://oauth2.googleapis.com/token',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
              }),
            },
          );
          const tokenData = (await tokenResponse.json().catch(() => ({}))) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            scope?: string;
            token_type?: string;
            error?: string;
            error_description?: string;
          };

          if (!tokenResponse.ok || !tokenData.access_token) {
            throw new Error(
              tokenData.error_description ||
                tokenData.error ||
                `Token exchange failed with ${tokenResponse.status}`,
            );
          }

          const now = new Date();
          const expiryDate = new Date(
            now.getTime() + Math.max(60, tokenData.expires_in || 3600) * 1000,
          ).toISOString();

          // Update the legacy OAuth file so the rest of the system
          // (calendar tools, contact resolution) picks up the new token
          const legacyPath = path.join(
            ADMIN_CONFIG_DIR,
            'google-contacts-oauth.json',
          );
          let legacyState: Record<string, unknown> = {};
          try {
            legacyState = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
          } catch {
            // No existing file
          }
          const updatedLegacy = {
            ...legacyState,
            accessToken: tokenData.access_token,
            refreshToken:
              tokenData.refresh_token ||
              (legacyState.refreshToken as string) ||
              '',
            expiryDate,
            scope: tokenData.scope || (legacyState.scope as string) || '',
            tokenType: tokenData.token_type || 'Bearer',
            connectedAt: now.toISOString(),
            oauthState: '',
            oauthStateCreatedAt: '',
          };
          fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
          const tmpPath = `${legacyPath}.tmp`;
          fs.writeFileSync(tmpPath, JSON.stringify(updatedLegacy, null, 2), {
            mode: 0o600,
          });
          fs.renameSync(tmpPath, legacyPath);

          // Also save to integration settings
          const { saveIntegrationSettings } =
            await import('./settings-store.js');
          const existing = getIntegrationSettings('google-calendar');
          saveIntegrationSettings('google-calendar', {
            ...existing,
            oauthCode: code,
            oauthState: state,
            oauthConnectedAt: now.toISOString(),
          });
          clearIntegrationRuntimeFault('google-calendar');
          clearIntegrationRuntimeFault('google-contacts');
        },
        isComplete: async () => {
          // Check legacy OAuth (shared with Google Contacts)
          const legacy = readLegacyOAuthState();
          if (legacy.accessToken && hasCalendarScope(legacy)) return true;
          // Check integration-level OAuth
          const settings = getIntegrationSettings('google-calendar');
          return Boolean(settings.oauthCode || settings.oauthConnectedAt);
        },
      },
    ],
    getStatus: async () => {
      const legacy = readLegacyOAuthState();
      const legacyDone = Boolean(
        legacy.accessToken && hasCalendarScope(legacy),
      );
      const settings = getIntegrationSettings('google-calendar');
      const integrationDone = Boolean(
        settings.oauthCode || settings.oauthConnectedAt,
      );
      const oauthDone = legacyDone || integrationDone;
      return {
        completed: oauthDone,
        currentStep: 0,
        steps: [
          {
            type: 'oauth2',
            label: 'Connect Google Account',
            status: oauthDone ? 'completed' : 'pending',
            description: legacyDone
              ? 'Using existing Google OAuth connection (shared with Contacts)'
              : undefined,
          },
        ],
      };
    },
  },
};

registerIntegration(calendarIntegration);
