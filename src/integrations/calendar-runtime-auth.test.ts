import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readEnvFileMock, getIntegrationSettingsMock } = vi.hoisted(() => ({
  readEnvFileMock: vi.fn<(keys: string[]) => Record<string, string>>(() => ({})),
  getIntegrationSettingsMock:
    vi.fn<(integrationName: string) => Record<string, unknown>>(() => ({})),
}));

vi.mock('../env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./settings-store.js', () => ({
  getIntegrationSettings: getIntegrationSettingsMock,
}));

import {
  calendarCheckAvailabilityApi,
  ensureGoogleCalendarAccessToken,
} from './calendar-runtime.js';

describe('calendar runtime auth', () => {
  beforeEach(() => {
    readEnvFileMock.mockReset();
    readEnvFileMock.mockReturnValue({});
    getIntegrationSettingsMock.mockReset();
    getIntegrationSettingsMock.mockReturnValue({});
    vi.unstubAllGlobals();
  });

  it('prefers refreshable oauth state over stale direct env calendar tokens', async () => {
    readEnvFileMock.mockImplementation((keys: string[]) => {
      if (keys.includes('GOOGLE_CALENDAR_ACCESS_TOKEN')) {
        return { GOOGLE_CALENDAR_ACCESS_TOKEN: 'stale-direct-token' };
      }
      return {} as Record<string, string>;
    });
    getIntegrationSettingsMock.mockImplementation((integrationName: string) => {
      if (integrationName === 'google-calendar') {
        return {
          GOOGLE_CLIENT_ID: 'settings-client-id',
          GOOGLE_CLIENT_SECRET: 'settings-client-secret',
        };
      }
      return {};
    });

    const runtime = {
      readLegacyOAuthState: vi.fn(() => ({
        accessToken: 'expired-oauth-token',
        refreshToken: 'refresh-token',
        expiryDate: new Date(0).toISOString(),
        scope: 'https://www.googleapis.com/auth/calendar.events',
      })),
      writeLegacyOAuthState: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-oauth-token',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await ensureGoogleCalendarAccessToken(runtime);

    expect(token).toBe('fresh-oauth-token');
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0][1] as { body: URLSearchParams };
    expect(request.body.get('client_id')).toBe('settings-client-id');
    expect(runtime.writeLegacyOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh-oauth-token' }),
    );
  });

  it('refreshes and retries calendar requests after a 401 using settings-backed client credentials', async () => {
    readEnvFileMock.mockReturnValue({});
    getIntegrationSettingsMock.mockImplementation((integrationName: string) => {
      if (integrationName === 'google-contacts') {
        return {
          GOOGLE_CLIENT_ID: 'settings-client-id',
          GOOGLE_CLIENT_SECRET: 'settings-client-secret',
        };
      }
      return {};
    });

    let state = {
      accessToken: 'stale-oauth-token',
      refreshToken: 'refresh-token',
      expiryDate: new Date(Date.now() + 3_600_000).toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar.events',
      tokenType: 'Bearer',
    };
    const runtime = {
      readLegacyOAuthState: vi.fn(() => state),
      writeLegacyOAuthState: vi.fn((next) => {
        state = { ...state, ...next };
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-oauth-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.events',
          token_type: 'Bearer',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ calendars: { primary: { busy: [] } } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await calendarCheckAvailabilityApi(runtime, {
      timeMin: '2026-04-18T08:00:00.000Z',
      timeMax: '2026-04-18T09:00:00.000Z',
      calendarIds: ['primary'],
    });

    expect(result).toEqual({ calendars: { primary: { busy: [] } } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer stale-oauth-token',
    });
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer refreshed-oauth-token',
    });
  });
});
