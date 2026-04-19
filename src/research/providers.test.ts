import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChainProvider,
  FixtureProvider,
  frameFetchedContent,
  isBlockedIpAddress,
  isProviderCircuitOpen,
  resetProviderCircuits,
  safeFetchUrl,
  type NamedProvider,
  type ResearchFetchResult,
  type ResearchProvider,
  type ResearchSearchResult,
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
    await expect(
      provider.fetch('https://example.com/life'),
    ).resolves.toMatchObject({
      title: 'Life',
    });
  });

  it('revalidates redirects before following a new host', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
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

describe('ChainProvider + circuit breaker', () => {
  beforeEach(() => {
    resetProviderCircuits();
  });

  function makeProvider(
    name: string,
    impl: Partial<ResearchProvider>,
  ): NamedProvider {
    const defaultSearch = async (): Promise<ResearchSearchResult[]> => [];
    const defaultFetch = async (url: string): Promise<ResearchFetchResult> => ({
      url,
      title: name,
      contentType: 'text/plain',
      textContent: '',
      fetchedAt: '2026-04-19T00:00:00.000Z',
      contentHash: 'x',
    });
    return {
      name,
      provider: {
        search: impl.search ?? defaultSearch,
        fetch: impl.fetch ?? defaultFetch,
      },
    };
  }

  it('falls through to the next provider on failure', async () => {
    const failing = makeProvider('primary', {
      search: vi.fn().mockRejectedValue(new Error('quota exhausted')),
    });
    const ok = makeProvider('fallback', {
      search: vi
        .fn()
        .mockResolvedValue([{ title: 'Result', url: 'https://example.com/a' }]),
    });
    const chain = new ChainProvider([failing, ok]);
    const results = await chain.search('anything', { maxResults: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/a');
  });

  it('opens the circuit after repeated failures and skips the provider', async () => {
    const failingSearch = vi.fn().mockRejectedValue(new Error('429'));
    const failing = makeProvider('primary', { search: failingSearch });
    const okSearch = vi
      .fn()
      .mockResolvedValue([{ title: 'B', url: 'https://example.com/b' }]);
    const ok = makeProvider('fallback', { search: okSearch });
    const chain = new ChainProvider([failing, ok]);

    await chain.search('q', { maxResults: 5 });
    await chain.search('q', { maxResults: 5 });
    expect(failingSearch).toHaveBeenCalledTimes(2);
    expect(isProviderCircuitOpen('primary')).toBe(true);

    // Third call should skip the primary entirely — no new call on it.
    await chain.search('q', { maxResults: 5 });
    expect(failingSearch).toHaveBeenCalledTimes(2);
    expect(okSearch).toHaveBeenCalledTimes(3);
  });

  it('invokes onFailure and onSkip handlers in the expected order', async () => {
    const failing = makeProvider('primary', {
      search: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const ok = makeProvider('fallback', {
      search: vi
        .fn()
        .mockResolvedValue([{ title: 'C', url: 'https://example.com/c' }]),
    });
    const onFailure = vi.fn();
    const onSkip = vi.fn();
    const chain = new ChainProvider([failing, ok], { onFailure, onSkip });

    await chain.search('q', { maxResults: 5 });
    await chain.search('q', { maxResults: 5 });
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure.mock.calls[0][0]).toBe('primary');
    expect(onFailure.mock.calls[0][1]).toBe('search');

    await chain.search('q', { maxResults: 5 });
    expect(onSkip).toHaveBeenCalledWith('primary', 'search', 'circuit open');
  });

  it('ignores breakers when every provider is circuit-open so the job still runs', async () => {
    const first = makeProvider('a', {
      search: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const second = makeProvider('b', {
      search: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const chain = new ChainProvider([first, second]);

    // Prime both breakers to open state.
    for (let i = 0; i < 2; i++) {
      await chain.search('q', { maxResults: 5 }).catch(() => {});
    }
    expect(isProviderCircuitOpen('a')).toBe(true);
    expect(isProviderCircuitOpen('b')).toBe(true);

    // Next call: both open, but we still try them rather than give up.
    const firstCalls = (first.provider.search as ReturnType<typeof vi.fn>).mock
      .calls.length;
    const secondCalls = (second.provider.search as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    await chain.search('q', { maxResults: 5 }).catch(() => {});
    expect(
      (first.provider.search as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(firstCalls + 1);
    expect(
      (second.provider.search as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(secondCalls + 1);
  });

  it('resets breaker state on a successful call', async () => {
    let flaky = 0;
    const failing = makeProvider('primary', {
      search: vi.fn().mockImplementation(async () => {
        flaky += 1;
        if (flaky <= 2) throw new Error('transient');
        return [{ title: 'ok', url: 'https://example.com/ok' }];
      }),
    });
    const ok = makeProvider('fallback', {
      search: vi
        .fn()
        .mockResolvedValue([{ title: 'fb', url: 'https://example.com/fb' }]),
    });
    const chain = new ChainProvider([failing, ok]);

    // Two failures -> primary's breaker opens.
    await chain.search('q', { maxResults: 5 });
    await chain.search('q', { maxResults: 5 });
    expect(isProviderCircuitOpen('primary')).toBe(true);

    // Manually reset to simulate cooldown elapsed.
    resetProviderCircuits();
    const results = await chain.search('q', { maxResults: 5 });
    expect(results[0].url).toBe('https://example.com/ok');
    expect(isProviderCircuitOpen('primary')).toBe(false);
  });
});
