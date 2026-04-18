import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  tempConfigDir,
  registerIntegrationMock,
  getIntegrationSettingsMock,
  saveIntegrationSettingsMock,
  clearIntegrationRuntimeFaultMock,
  readEnvFileMock,
} = vi.hoisted(() => ({
  tempConfigDir: require('path').join(
    require('os').tmpdir(),
    'nanoclaw-calendar-test',
  ),
  registerIntegrationMock: vi.fn(),
  getIntegrationSettingsMock:
    vi.fn<(integrationName: string) => Record<string, unknown>>(() => ({})),
  saveIntegrationSettingsMock: vi.fn(),
  clearIntegrationRuntimeFaultMock: vi.fn(),
  readEnvFileMock: vi.fn<(keys: string[]) => Record<string, string>>(() => ({})),
}));

vi.mock('../config.js', () => ({
  ADMIN_BIND_HOST: '127.0.0.1',
  ADMIN_CONFIG_DIR: tempConfigDir,
  ADMIN_PORT: 3030,
}));

vi.mock('../env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./registry.js', () => ({
  registerIntegration: registerIntegrationMock,
}));

vi.mock('./settings-store.js', () => ({
  getIntegrationSettings: getIntegrationSettingsMock,
  saveIntegrationSettings: saveIntegrationSettingsMock,
}));

vi.mock('./runtime-health.js', () => ({
  clearIntegrationRuntimeFault: clearIntegrationRuntimeFaultMock,
}));

vi.mock('./calendar-runtime.js', () => ({
  assertCalendarMutationAllowed: vi.fn(),
  assertCalendarReadDetailAllowed: vi.fn(),
  calendarCheckAvailabilityApi: vi.fn(),
  calendarCreateEventApi: vi.fn(),
  calendarDeleteEventApi: vi.fn(),
  calendarGetEventApi: vi.fn(),
  calendarListEventsApi: vi.fn(),
  calendarUpdateEventApi: vi.fn(),
  sanitizeCalendarListResult: vi.fn((result) => result),
}));

describe('google calendar integration oauth setup', () => {
  beforeEach(async () => {
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
    fs.mkdirSync(tempConfigDir, { recursive: true });
    registerIntegrationMock.mockReset();
    getIntegrationSettingsMock.mockReset();
    getIntegrationSettingsMock.mockReturnValue({});
    saveIntegrationSettingsMock.mockReset();
    clearIntegrationRuntimeFaultMock.mockReset();
    readEnvFileMock.mockReset();
    readEnvFileMock.mockReturnValue({});
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    vi.unstubAllGlobals();
    vi.resetModules();
    await import('./calendar.js');
  });

  afterEach(() => {
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('starts oauth with client credentials stored in integration settings', async () => {
    getIntegrationSettingsMock.mockImplementation((integrationName: string) => {
      if (integrationName === 'google-calendar') {
        return { GOOGLE_CLIENT_ID: 'settings-client-id' };
      }
      return {};
    });

    const integration = registerIntegrationMock.mock.calls[0]?.[0];
    const step = integration.setup.steps[0];
    const auth = await step.startAuth('http://localhost:3030');

    expect(auth.url).toContain('client_id=settings-client-id');
  });

  it('completes oauth with client credentials stored in integration settings', async () => {
    getIntegrationSettingsMock.mockImplementation((integrationName: string) => {
      if (integrationName === 'google-calendar') {
        return {
          GOOGLE_CLIENT_ID: 'settings-client-id',
          GOOGLE_CLIENT_SECRET: 'settings-client-secret',
        };
      }
      return {};
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const integration = registerIntegrationMock.mock.calls[0]?.[0];
    const step = integration.setup.steps[0];
    await step.completeAuth({
      code: 'auth-code',
      state: 'calendar-state',
      origin: 'http://localhost:3030',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams),
      }),
    );
    const request = fetchMock.mock.calls[0][1] as { body: URLSearchParams };
    expect(request.body.get('client_id')).toBe('settings-client-id');
    expect(request.body.get('client_secret')).toBe('settings-client-secret');
    expect(saveIntegrationSettingsMock).toHaveBeenCalledWith(
      'google-calendar',
      expect.objectContaining({
        oauthCode: 'auth-code',
        oauthState: 'calendar-state',
      }),
    );
  });
});
