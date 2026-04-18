import { readEnvFile } from '../env.js';

import { getIntegrationSettings } from './settings-store.js';

interface GoogleOAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getGoogleIntegrationCredentials(integrationName: string): {
  clientId: string;
  clientSecret: string;
} {
  const settings = getIntegrationSettings(integrationName);
  return {
    clientId: firstNonEmpty(
      settings.GOOGLE_CLIENT_ID,
      settings.googleClientId,
    ),
    clientSecret: firstNonEmpty(
      settings.GOOGLE_CLIENT_SECRET,
      settings.googleClientSecret,
    ),
  };
}

export function getGoogleOAuthClientCredentials(): GoogleOAuthClientCredentials {
  const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const calendar = getGoogleIntegrationCredentials('google-calendar');
  const contacts = getGoogleIntegrationCredentials('google-contacts');

  return {
    clientId: firstNonEmpty(
      process.env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_ID,
      calendar.clientId,
      contacts.clientId,
    ),
    clientSecret: firstNonEmpty(
      process.env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_CLIENT_SECRET,
      calendar.clientSecret,
      contacts.clientSecret,
    ),
  };
}
