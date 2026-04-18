import { readEnvFile } from '../env.js';

import { getGoogleOAuthClientCredentials } from './google-oauth-client.js';

export interface LegacyOAuthState {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: string;
  scope?: string;
  tokenType?: string;
  connectedAt?: string;
}

export interface CalendarRuntimeContext {
  calendarAccess: boolean;
}

export interface CalendarEventListResult {
  items?: Array<{
    start?: unknown;
    end?: unknown;
    summary?: string;
    status?: string;
  }>;
  [key: string]: unknown;
}

export interface CalendarApiRuntime {
  readLegacyOAuthState: () => LegacyOAuthState;
  writeLegacyOAuthState: (state: LegacyOAuthState) => void;
}

const GOOGLE_CALENDAR_TOKEN_KEYS = [
  'GOOGLE_CALENDAR_ACCESS_TOKEN',
  'GOOGLE_CONTACTS_ACCESS_TOKEN',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
] as const;

export function sanitizeCalendarListResult(
  result: CalendarEventListResult,
  context: CalendarRuntimeContext,
): CalendarEventListResult {
  if (context.calendarAccess || !Array.isArray(result.items)) {
    return result;
  }
  return {
    ...result,
    items: result.items.map((item) => ({
      start: item.start,
      end: item.end,
      status: item.status || 'confirmed',
      summary: '(busy)',
    })),
  };
}

export function assertCalendarReadDetailAllowed(
  context: CalendarRuntimeContext,
): void {
  if (!context.calendarAccess) {
    throw new Error(
      'Calendar event details are only available from the control chat.',
    );
  }
}

export function assertCalendarMutationAllowed(
  context: CalendarRuntimeContext,
): void {
  if (!context.calendarAccess) {
    throw new Error(
      'Calendar events can only be modified from the control chat.',
    );
  }
}

async function refreshLegacyOAuthState(
  state: LegacyOAuthState,
  runtime: CalendarApiRuntime,
): Promise<LegacyOAuthState | null> {
  if (!state.refreshToken) return null;

  const { clientId, clientSecret } = getGoogleOAuthClientCredentials();
  if (!clientId || !clientSecret) {
    return null;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
  runtime.writeLegacyOAuthState(next);
  return next;
}

export async function ensureGoogleCalendarAccessToken(
  runtime: CalendarApiRuntime,
): Promise<string> {
  let legacy = runtime.readLegacyOAuthState();
  if (legacy.accessToken || legacy.refreshToken) {
    const expiry = legacy.expiryDate ? new Date(legacy.expiryDate) : null;
    const expired = expiry && expiry.getTime() < Date.now() + 60_000;
    if (!expired && legacy.accessToken) {
      return legacy.accessToken;
    }

    const refreshed = await refreshLegacyOAuthState(legacy, runtime);
    if (refreshed?.accessToken) {
      legacy = refreshed;
    }

    if (legacy.accessToken) {
      return legacy.accessToken;
    }
  }

  const env = readEnvFile([...GOOGLE_CALENDAR_TOKEN_KEYS]);
  for (const key of GOOGLE_CALENDAR_TOKEN_KEYS) {
    const value = env[key];
    if (value?.trim()) return value.trim();
  }

  return '';
}

async function forceRefreshGoogleCalendarAccessToken(
  runtime: CalendarApiRuntime,
): Promise<string> {
  const refreshed = await refreshLegacyOAuthState(
    runtime.readLegacyOAuthState(),
    runtime,
  );
  return refreshed?.accessToken || '';
}

export async function calendarFetch(
  urlOrPath: string,
  runtime: CalendarApiRuntime,
  init?: RequestInit,
): Promise<unknown> {
  const token = await ensureGoogleCalendarAccessToken(runtime);
  if (!token) {
    throw new Error(
      'Google Calendar is not connected. Connect via the admin UI first.',
    );
  }
  const url = urlOrPath.startsWith('https://')
    ? urlOrPath
    : `https://www.googleapis.com${urlOrPath}`;

  const makeRequest = (accessToken: string) =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string>) || {}),
      },
    });

  let response = await makeRequest(token);

  if (response.status === 401) {
    try {
      const refreshedToken =
        await forceRefreshGoogleCalendarAccessToken(runtime);
      if (refreshedToken) {
        response = await makeRequest(refreshedToken);
      }
    } catch {
      // Preserve the original 401 response body below when refresh fails.
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Calendar API ${response.status}: ${body}`);
  }

  if (response.status === 204) return { deleted: true };
  return response.json();
}

export async function calendarListEventsApi(
  runtime: CalendarApiRuntime,
  params: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    maxResults: number;
    query?: string;
  },
): Promise<CalendarEventListResult> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(params.calendarId)}/events`,
  );
  url.searchParams.set('timeMin', params.timeMin);
  url.searchParams.set('timeMax', params.timeMax);
  url.searchParams.set('maxResults', String(params.maxResults));
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  if (params.query) url.searchParams.set('q', params.query);
  return (await calendarFetch(
    url.toString(),
    runtime,
  )) as CalendarEventListResult;
}

export async function calendarCheckAvailabilityApi(
  runtime: CalendarApiRuntime,
  params: {
    timeMin: string;
    timeMax: string;
    calendarIds: string[];
  },
): Promise<unknown> {
  return calendarFetch(
    'https://www.googleapis.com/calendar/v3/freeBusy',
    runtime,
    {
      method: 'POST',
      body: JSON.stringify({
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        items: params.calendarIds.map((id) => ({ id })),
      }),
    },
  );
}

export async function calendarGetEventApi(
  runtime: CalendarApiRuntime,
  params: {
    calendarId: string;
    eventId: string;
  },
): Promise<unknown> {
  return calendarFetch(
    `/calendar/v3/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`,
    runtime,
  );
}

export async function calendarCreateEventApi(
  runtime: CalendarApiRuntime,
  params: {
    calendarId: string;
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
  },
): Promise<unknown> {
  const event: Record<string, unknown> = {
    summary: params.summary,
    start: { dateTime: params.start },
    end: { dateTime: params.end },
  };
  if (params.description) event.description = params.description;
  if (params.location) event.location = params.location;
  if (params.attendees?.length) {
    event.attendees = params.attendees.map((email) => ({ email }));
  }
  const sendNotifications = params.attendees?.length
    ? '?sendNotifications=true'
    : '';
  return calendarFetch(
    `/calendar/v3/calendars/${encodeURIComponent(params.calendarId)}/events${sendNotifications}`,
    runtime,
    { method: 'POST', body: JSON.stringify(event) },
  );
}

export async function calendarUpdateEventApi(
  runtime: CalendarApiRuntime,
  params: {
    calendarId: string;
    eventId: string;
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
  },
): Promise<unknown> {
  const patch: Record<string, unknown> = {};
  if (params.summary !== undefined) patch.summary = params.summary;
  if (params.start !== undefined) patch.start = { dateTime: params.start };
  if (params.end !== undefined) patch.end = { dateTime: params.end };
  if (params.description !== undefined) patch.description = params.description;
  if (params.location !== undefined) patch.location = params.location;
  if (params.attendees !== undefined) {
    patch.attendees = params.attendees.map((email) => ({ email }));
  }
  const sendNotifications =
    params.attendees !== undefined ? '?sendNotifications=true' : '';
  return calendarFetch(
    `/calendar/v3/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}${sendNotifications}`,
    runtime,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
}

export async function calendarDeleteEventApi(
  runtime: CalendarApiRuntime,
  params: {
    calendarId: string;
    eventId: string;
  },
): Promise<unknown> {
  return calendarFetch(
    `/calendar/v3/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`,
    runtime,
    { method: 'DELETE' },
  );
}
