import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchGoogleContactsForChannel } from './google-contacts.js';

describe('Google Contacts integration helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps Google contact search results to WhatsApp targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              person: {
                names: [{ displayName: 'Justin Example' }],
                phoneNumbers: [{ value: '+1 (604) 555-1212' }],
                emailAddresses: [{ value: 'justin@example.com' }],
              },
            },
          ],
        }),
      }),
    );

    const results = await searchGoogleContactsForChannel(
      'token',
      'whatsapp',
      'Justin',
      10,
    );

    expect(results).toEqual([
      {
        channel: 'whatsapp',
        displayName: 'Justin Example',
        emails: ['justin@example.com'],
        phones: ['+16045551212'],
        resolvedTarget: '16045551212@s.whatsapp.net',
      },
    ]);
  });

  it('filters out contacts missing the channel target field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              person: {
                names: [{ displayName: 'Email Only' }],
                emailAddresses: [{ value: 'email@example.com' }],
              },
            },
            {
              person: {
                names: [{ displayName: 'Phone Only' }],
                phoneNumbers: [{ value: '+1 555 000 9999' }],
              },
            },
          ],
        }),
      }),
    );

    const smsResults = await searchGoogleContactsForChannel(
      'token',
      'sms',
      'Only',
      10,
    );
    const emailResults = await searchGoogleContactsForChannel(
      'token',
      'email',
      'Only',
      10,
    );

    expect(smsResults).toEqual([
      {
        channel: 'sms',
        displayName: 'Phone Only',
        emails: [],
        phones: ['+15550009999'],
        resolvedTarget: '+15550009999',
      },
    ]);
    expect(emailResults).toEqual([
      {
        channel: 'email',
        displayName: 'Email Only',
        emails: ['email@example.com'],
        phones: [],
        resolvedTarget: 'email@example.com',
      },
    ]);
  });
});
