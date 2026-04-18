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

import { getGoogleOAuthClientCredentials } from './google-oauth-client.js';

describe('google oauth client credentials', () => {
  beforeEach(() => {
    readEnvFileMock.mockReset();
    readEnvFileMock.mockReturnValue({});
    getIntegrationSettingsMock.mockReset();
    getIntegrationSettingsMock.mockReturnValue({});
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it('falls back to google-calendar integration settings when env is missing', () => {
    getIntegrationSettingsMock.mockImplementation((integrationName: string) => {
      if (integrationName === 'google-calendar') {
        return {
          GOOGLE_CLIENT_ID: 'calendar-client-id',
          GOOGLE_CLIENT_SECRET: 'calendar-client-secret',
        };
      }
      return {};
    });

    expect(getGoogleOAuthClientCredentials()).toEqual({
      clientId: 'calendar-client-id',
      clientSecret: 'calendar-client-secret',
    });
  });

  it('shares google oauth client credentials across calendar and contacts settings', () => {
    getIntegrationSettingsMock.mockImplementation((integrationName: string) => {
      if (integrationName === 'google-contacts') {
        return {
          googleClientId: 'contacts-client-id',
          googleClientSecret: 'contacts-client-secret',
        };
      }
      return {};
    });

    expect(getGoogleOAuthClientCredentials()).toEqual({
      clientId: 'contacts-client-id',
      clientSecret: 'contacts-client-secret',
    });
  });
});
