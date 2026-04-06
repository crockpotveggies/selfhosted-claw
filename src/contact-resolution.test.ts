import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizePhone,
  resolveLiteralTarget,
  searchGoogleContacts,
} from './contact-resolution.js';

describe('contact resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes phone numbers for outbound resolution', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+5551234567');
    expect(normalizePhone('+1 555 123 4567')).toBe('+15551234567');
  });

  it('resolves literal email and sms targets without lookup', () => {
    expect(resolveLiteralTarget('email', 'sam@example.com')).toMatchObject({
      resolvedTarget: 'sam@example.com',
      source: 'literal',
    });
    expect(resolveLiteralTarget('sms', '(555) 123-4567')).toMatchObject({
      resolvedTarget: '+5551234567',
      source: 'literal',
    });
  });

  it('resolves Google contact email matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              person: {
                names: [{ displayName: 'Sam Example' }],
                emailAddresses: [{ value: 'sam@example.com' }],
              },
            },
          ],
        }),
      }),
    );

    const result = await searchGoogleContacts('token', 'email', 'Sam');
    expect(result).toEqual({
      channel: 'email',
      query: 'Sam',
      resolvedTarget: 'sam@example.com',
      displayName: 'Sam Example',
      source: 'google_contacts',
      existingConversation: false,
    });
  });

  it('resolves Google contact phone matches for sms', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              person: {
                names: [{ displayName: 'Sam Example' }],
                phoneNumbers: [
                  { value: '(555) 123-4567', canonicalForm: '+15551234567' },
                ],
              },
            },
          ],
        }),
      }),
    );

    const result = await searchGoogleContacts('token', 'sms', 'Sam');
    expect(result).toEqual({
      channel: 'sms',
      query: 'Sam',
      resolvedTarget: '+15551234567',
      displayName: 'Sam Example',
      source: 'google_contacts',
      existingConversation: false,
    });
  });
});
