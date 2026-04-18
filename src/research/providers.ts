import { createHash } from 'crypto';
import { resolve as dnsResolve } from 'dns/promises';

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface ResearchFetchResult {
  url: string;
  title: string;
  contentType: string;
  textContent: string;
  fetchedAt: string;
  contentHash: string;
}

export interface ResearchSearchOptions {
  maxResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface ResearchFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ResearchProvider {
  search(
    query: string,
    options: ResearchSearchOptions,
  ): Promise<ResearchSearchResult[]>;
  fetch(
    url: string,
    options?: ResearchFetchOptions,
  ): Promise<ResearchFetchResult>;
}

export interface FixtureProviderFixture {
  searches: Record<string, ResearchSearchResult[]>;
  fetches: Record<string, Omit<ResearchFetchResult, 'contentHash'>>;
}

const BLOCKED_IPV4_PREFIXES = ['0.', '10.', '127.', '169.254.', '192.168.'];
const ALLOWED_FETCH_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/pdf',
]);

export function isBlockedIpAddress(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '0.0.0.0') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  if (BLOCKED_IPV4_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  if (normalized === '169.254.169.254') return true;
  const private172 = normalized.match(/^172\.(\d+)\./);
  if (private172) {
    const second = Number(private172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function validateResolvedHost(hostname: string): Promise<void> {
  const addresses = await dnsResolve(hostname);
  for (const address of addresses) {
    if (isBlockedIpAddress(address)) {
      throw new Error(
        `Blocked fetch target: ${hostname} resolved to ${address}`,
      );
    }
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<\/?(p|div|br|hr|h[1-6]|li|tr|blockquote|section|article|header|footer|nav|aside|main)[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function frameFetchedContent(
  source: string,
  fetchedAt: string,
  rawText: string,
): string {
  const capped =
    rawText.length > 50_000
      ? `${rawText.slice(0, 50_000)}\n...[truncated source content]`
      : rawText;
  return `<web_content source="${source}" fetched_at="${fetchedAt}">\n${capped}\n</web_content>`;
}

export async function safeFetchUrl(
  inputUrl: string,
  options?: ResearchFetchOptions,
): Promise<ResearchFetchResult> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const maxBytes = options?.maxBytes ?? 10 * 1024 * 1024;
  let currentUrl = new URL(inputUrl);
  await validateResolvedHost(currentUrl.hostname);

  for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'self-hosted-claw deep research',
          Accept: 'text/html,text/plain,application/json,application/pdf',
        },
      });
      clearTimeout(timeout);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        const nextUrl = new URL(location, currentUrl);
        await validateResolvedHost(nextUrl.hostname);
        currentUrl = nextUrl;
        continue;
      }

      const contentType = (response.headers.get('content-type') || 'text/plain')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_FETCH_CONTENT_TYPES.has(contentType)) {
        throw new Error(
          `Unsupported content type for research fetch: ${contentType}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.byteLength > maxBytes) {
        throw new Error(`Research fetch exceeded ${maxBytes} bytes`);
      }

      const fetchedAt = new Date().toISOString();
      const rawText =
        contentType === 'application/pdf'
          ? '[pdf document omitted from inline source text]'
          : contentType === 'text/html'
            ? htmlToText(buffer.toString('utf-8'))
            : buffer.toString('utf-8');
      const framed = frameFetchedContent(
        currentUrl.toString(),
        fetchedAt,
        rawText,
      );
      return {
        url: currentUrl.toString(),
        title: currentUrl.hostname,
        contentType,
        textContent: framed,
        fetchedAt,
        contentHash: createHash('sha256').update(buffer).digest('hex'),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Too many redirects for research fetch: ${inputUrl}`);
}

export class BraveProvider implements ResearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    options: ResearchSearchOptions,
  ): Promise<ResearchSearchResult[]> {
    if (!this.apiKey.trim()) {
      throw new Error('Brave API key is required for deep research');
    }

    const params = new URLSearchParams({
      q: query,
      count: String(Math.max(1, Math.min(20, options.maxResults))),
    });
    if (options.includeDomains?.length) {
      params.set('site', options.includeDomains.join(','));
    }

    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.apiKey,
        },
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Brave search failed (${response.status}): ${text || response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
        }>;
      };
    };

    const exclude = new Set(
      (options.excludeDomains || []).map((domain) => domain.toLowerCase()),
    );
    return (payload.web?.results || [])
      .map((result) => ({
        title: String(result.title || '').trim(),
        url: String(result.url || '').trim(),
        snippet: String(result.description || '').trim(),
      }))
      .filter((result) => result.title && result.url)
      .filter((result) => {
        try {
          const hostname = new URL(result.url).hostname.toLowerCase();
          return ![...exclude].some(
            (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
          );
        } catch {
          return false;
        }
      });
  }

  async fetch(
    url: string,
    options?: ResearchFetchOptions,
  ): Promise<ResearchFetchResult> {
    return safeFetchUrl(url, options);
  }
}

export class FixtureProvider implements ResearchProvider {
  constructor(private readonly fixture: FixtureProviderFixture) {}

  async search(
    query: string,
    options: ResearchSearchOptions,
  ): Promise<ResearchSearchResult[]> {
    return (this.fixture.searches[query] || []).slice(0, options.maxResults);
  }

  async fetch(url: string): Promise<ResearchFetchResult> {
    const match = this.fixture.fetches[url];
    if (!match) {
      throw new Error(`Fixture fetch not found: ${url}`);
    }
    return {
      ...match,
      contentHash: createHash('sha256').update(match.textContent).digest('hex'),
    };
  }
}

export class OpenAIWebSearchProvider implements ResearchProvider {
  async search(): Promise<ResearchSearchResult[]> {
    throw new Error('OpenAI web search provider is not implemented in v1');
  }

  async fetch(): Promise<ResearchFetchResult> {
    throw new Error('OpenAI web search provider is not implemented in v1');
  }
}
