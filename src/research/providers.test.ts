import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FixtureProvider,
  frameFetchedContent,
  isBlockedIpAddress,
  safeFetchUrl,
} from './providers.js';

vi.mock('dns/promises', () => ({
  resolve: vi.fn(async (hostname: string) => {
    if (hostname === 'blocked.test') return ['127.0.0.1'];
    return ['93.184.216.34'];
  }),
}));

describe('research provider helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks private and metadata IP ranges', () => {
    expect(isBlockedIpAddress('127.0.0.1')).toBe(true);
    expect(isBlockedIpAddress('169.254.169.254')).toBe(true);
    expect(isBlockedIpAddress('fd00::1')).toBe(true);
    expect(isBlockedIpAddress('93.184.216.34')).toBe(false);
  });

  it('frames fetched content as web data', () => {
    const framed = frameFetchedContent(
      'https://example.com',
      '2026-04-18T00:00:00.000Z',
      'hello world',
    );
    expect(framed).toContain('<web_content source="https://example.com"');
    expect(framed).toContain('hello world');
  });

  it('truncates oversized framed content', () => {
    const framed = frameFetchedContent(
      'https://example.com',
      '2026-04-18T00:00:00.000Z',
      'x'.repeat(60_000),
    );
    expect(framed).toContain('[truncated source content]');
  });

  it('rejects blocked hosts before fetching', async () => {
    await expect(safeFetchUrl('http://blocked.test')).rejects.toThrow(
      /Blocked fetch target/,
    );
  });

  it('uses fixture providers for deterministic tests', async () => {
    const provider = new FixtureProvider({
      searches: {
        canada: [{ title: 'Life', url: 'https://example.com/life' }],
      },
      fetches: {
        'https://example.com/life': {
          url: 'https://example.com/life',
          title: 'Life',
          contentType: 'text/plain',
          textContent: 'Life in Canada',
          fetchedAt: '2026-04-18T00:00:00.000Z',
        },
      },
    });

    await expect(
      provider.search('canada', { maxResults: 5 }),
    ).resolves.toHaveLength(1);
    await expect(provider.fetch('https://example.com/life')).resolves.toMatchObject({
      title: 'Life',
    });
  });

  it('revalidates redirects before following a new host', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location'
              ? 'http://blocked.test/private'
              : null,
        },
      } as Partial<Response> as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetchUrl('https://example.com/start')).rejects.toThrow(
      /Blocked fetch target/,
    );
  });

  it('strips script tags from fetched html content', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'text/html' : null,
      },
      arrayBuffer: async () =>
        Buffer.from(
          '<html><body><script>alert(1)</script><p>Hello</p></body></html>',
          'utf-8',
        ),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await safeFetchUrl('https://example.com/article');
    expect(result.textContent).toContain('Hello');
    expect(result.textContent).not.toContain('alert(1)');
  });
});
