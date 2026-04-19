import { createHash } from 'crypto';
import { resolve as dnsResolve } from 'dns/promises';

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet?: string;
  imageUrl?: string;
  imageCandidates?: string[];
}

export interface ResearchFetchResult {
  url: string;
  title: string;
  contentType: string;
  textContent: string;
  fetchedAt: string;
  contentHash: string;
  imageUrl?: string;
  imageCandidates?: string[];
}

// Exa-compatible category values. Providers that don't support categories
// (e.g. Brave) ignore the field.
export type ResearchCategory =
  | 'research paper'
  | 'news'
  | 'pdf'
  | 'company'
  | 'financial report'
  | 'github'
  | 'personal site'
  | 'tweet'
  | 'linkedin profile';

export interface ResearchSearchOptions {
  maxResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  category?: ResearchCategory;
  startPublishedDate?: string;
  endPublishedDate?: string;
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

interface ExaSearchResult {
  id?: string;
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
  author?: string;
  image?: string;
  extras?: {
    imageLinks?: string[];
  };
}

// Exa is a search API designed for LLM/research use cases. Key advantages
// over generic web search for this pipeline:
//   1. `category` filter returns only research papers, news, PDFs, etc.
//   2. `/search` can return cleaned main-body text inline, eliminating our
//      downstream HTML-stripping + boilerplate extraction.
//   3. Neural ranking surfaces higher-signal content than keyword search.
// See https://docs.exa.ai/ for the full API surface.
export class ExaProvider implements ResearchProvider {
  private readonly endpoint = 'https://api.exa.ai';
  // Cache content returned by /search so fetch() doesn't need a second call.
  private readonly cache = new Map<
    string,
    {
      text: string;
      title: string;
      publishedDate?: string;
      imageUrl?: string;
      imageCandidates?: string[];
    }
  >();

  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    options: ResearchSearchOptions,
  ): Promise<ResearchSearchResult[]> {
    if (!this.apiKey.trim()) {
      throw new Error('Exa API key is required for deep research');
    }
    const body: Record<string, unknown> = {
      query,
      numResults: Math.max(1, Math.min(25, options.maxResults)),
      type: 'auto',
      contents: {
        text: { maxCharacters: 8000 },
        // imageLinks returns multiple in-page images per result, not just
        // the og:image. Critical for academic / PDF / Nature-style sources
        // where og:image is usually empty. We request a generous count so
        // the score-and-rank stage downstream has good candidates to pick
        // from after the quality gate filters out logos and icons.
        extras: { imageLinks: 10 },
      },
    };
    if (options.category) body.category = options.category;
    if (options.includeDomains?.length) {
      body.includeDomains = options.includeDomains;
    }
    if (options.excludeDomains?.length) {
      body.excludeDomains = options.excludeDomains;
    }
    if (options.startPublishedDate) {
      body.startPublishedDate = options.startPublishedDate;
    }
    if (options.endPublishedDate) {
      body.endPublishedDate = options.endPublishedDate;
    }

    const response = await fetch(`${this.endpoint}/search`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Exa search failed (${response.status}): ${text || response.statusText}`,
      );
    }
    const payload = (await response.json()) as {
      results?: ExaSearchResult[];
    };
    const results: ResearchSearchResult[] = [];
    for (const entry of payload.results || []) {
      const url = String(entry.url || '').trim();
      const title = String(entry.title || '').trim();
      if (!url || !title) continue;
      const text = String(entry.text || '').trim();
      const imageUrl = String(entry.image || '').trim() || undefined;
      const imageCandidates: string[] = [];
      if (imageUrl) imageCandidates.push(imageUrl);
      if (Array.isArray(entry.extras?.imageLinks)) {
        for (const candidate of entry.extras.imageLinks) {
          const trimmed = String(candidate || '').trim();
          if (trimmed && !imageCandidates.includes(trimmed)) {
            imageCandidates.push(trimmed);
          }
        }
      }
      if (text) {
        this.cache.set(url, {
          text,
          title,
          publishedDate: entry.publishedDate,
          imageUrl,
          imageCandidates: imageCandidates.length ? imageCandidates : undefined,
        });
      }
      results.push({
        title,
        url,
        snippet: text ? text.slice(0, 240) : undefined,
        imageUrl,
        imageCandidates: imageCandidates.length ? imageCandidates : undefined,
      });
    }
    return results;
  }

  async fetch(
    url: string,
    _options?: ResearchFetchOptions,
  ): Promise<ResearchFetchResult> {
    const cached = this.cache.get(url);
    if (cached) {
      const fetchedAt = new Date().toISOString();
      return {
        url,
        title: cached.title,
        contentType: 'text/plain',
        textContent: cached.text,
        fetchedAt,
        contentHash: createHash('sha256').update(cached.text).digest('hex'),
        imageUrl: cached.imageUrl,
        imageCandidates: cached.imageCandidates,
      };
    }
    // Fallback: request content from Exa's /contents endpoint. Happens when
    // fetch() is called for a URL not previously seen via search().
    if (!this.apiKey.trim()) {
      throw new Error('Exa API key is required for deep research');
    }
    const response = await fetch(`${this.endpoint}/contents`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        urls: [url],
        text: { maxCharacters: 8000 },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Exa contents failed (${response.status}): ${text || response.statusText}`,
      );
    }
    const payload = (await response.json()) as {
      results?: ExaSearchResult[];
    };
    const first = payload.results?.[0];
    if (!first) throw new Error(`Exa returned no content for ${url}`);
    const text = String(first.text || '').trim();
    const fetchedAt = new Date().toISOString();
    return {
      url: String(first.url || url),
      title: String(first.title || url),
      contentType: 'text/plain',
      textContent: text,
      fetchedAt,
      contentHash: createHash('sha256').update(text).digest('hex'),
      imageUrl: String(first.image || '').trim() || undefined,
    };
  }
}

export interface NamedProvider {
  name: string;
  provider: ResearchProvider;
}

// --- Circuit breaker state (module-level, shared across ChainProvider
// instances so a provider poisoned during one research job stays poisoned
// for the next one within the cooldown window). After N consecutive
// failures the provider's breaker opens and we skip it in the chain until
// the cooldown elapses — saves ~30 retries per job when a provider is
// hard-down (quota exhausted, key revoked, etc.).

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number; // epoch ms; 0 means closed
  openedAt?: number;
  lastError?: string;
}

const breakerStates = new Map<string, BreakerState>();
const BREAKER_FAILURE_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

export function isProviderCircuitOpen(name: string): boolean {
  const state = breakerStates.get(name);
  if (!state) return false;
  if (state.openUntil > Date.now()) return true;
  if (state.openUntil !== 0) {
    // Cooldown elapsed; fully reset so the next failure starts a fresh count.
    breakerStates.delete(name);
  }
  return false;
}

export function recordProviderSuccess(name: string): void {
  breakerStates.delete(name);
}

export function recordProviderFailure(
  name: string,
  error: Error,
): BreakerState {
  const prior = breakerStates.get(name) ?? {
    consecutiveFailures: 0,
    openUntil: 0,
  };
  const next: BreakerState = {
    consecutiveFailures: prior.consecutiveFailures + 1,
    openUntil: prior.openUntil,
    openedAt: prior.openedAt,
    lastError: error.message,
  };
  if (
    next.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD &&
    next.openUntil <= Date.now()
  ) {
    next.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    next.openedAt = Date.now();
  }
  breakerStates.set(name, next);
  return next;
}

export function resetProviderCircuits(): void {
  breakerStates.clear();
}

export interface ChainEventHandlers {
  /**
   * Per-provider failure. Informational when the chain eventually recovers;
   * the real user-facing failure event is `onChainFailure` below.
   */
  onFailure?: (
    providerName: string,
    op: 'search' | 'fetch',
    error: Error,
    breaker: BreakerState,
  ) => void;
  /** A provider was skipped because its breaker is open. */
  onSkip?: (
    providerName: string,
    op: 'search' | 'fetch',
    reason: string,
  ) => void;
  /**
   * Every provider in the chain failed. This is the *only* chain-level
   * signal that the caller should surface to users — anything else is
   * recoverable noise.
   */
  onChainFailure?: (
    op: 'search' | 'fetch',
    lastError: Error,
    providerSequence: string[],
  ) => void;
  /** Fires on fallback success so callers can see which provider won. */
  onFallbackRecovery?: (
    providerName: string,
    op: 'search' | 'fetch',
    skippedOrFailed: string[],
  ) => void;
}

// Tries each provider in order until one succeeds. If a provider's circuit
// breaker is open, it's skipped entirely — unless EVERY provider's breaker
// is open, in which case we force a full cycle rather than fail the job
// (treating the cooldown as a heuristic, not a hard block).
export class ChainProvider implements ResearchProvider {
  constructor(
    private readonly providers: NamedProvider[],
    private readonly handlers?: ChainEventHandlers,
  ) {
    if (!providers.length) {
      throw new Error('ChainProvider requires at least one provider');
    }
  }

  private async runChain<T>(
    op: 'search' | 'fetch',
    call: (provider: ResearchProvider) => Promise<T>,
  ): Promise<T> {
    const allOpen = this.providers.every((p) => isProviderCircuitOpen(p.name));
    const skippedOrFailed: string[] = [];
    let lastError: Error | null = null;
    for (const { name, provider } of this.providers) {
      if (!allOpen && isProviderCircuitOpen(name)) {
        this.handlers?.onSkip?.(name, op, 'circuit open');
        skippedOrFailed.push(name);
        continue;
      }
      try {
        const result = await call(provider);
        recordProviderSuccess(name);
        // If we needed to pass over any previous provider to get here, this
        // is a successful fallback — let the caller log it.
        if (skippedOrFailed.length > 0) {
          this.handlers?.onFallbackRecovery?.(name, op, skippedOrFailed);
        }
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const breaker = recordProviderFailure(name, lastError);
        this.handlers?.onFailure?.(name, op, lastError, breaker);
        skippedOrFailed.push(name);
      }
    }
    // Every provider failed (or was skipped and then failed in the all-open
    // pass). Surface that as a single chain-level event, not N noisy
    // per-provider warnings.
    const finalError = lastError ?? new Error('All research providers failed');
    this.handlers?.onChainFailure?.(
      op,
      finalError,
      this.providers.map((p) => p.name),
    );
    throw finalError;
  }

  async search(
    query: string,
    options: ResearchSearchOptions,
  ): Promise<ResearchSearchResult[]> {
    return this.runChain('search', (p) => p.search(query, options));
  }

  async fetch(
    url: string,
    options?: ResearchFetchOptions,
  ): Promise<ResearchFetchResult> {
    return this.runChain('fetch', (p) => p.fetch(url, options));
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// DuckDuckGo has no official public search API. The `/html/` endpoint was
// designed for scripted access (it's what the "lite" interface uses) and is
// the canonical no-key fallback when Exa and Brave are both unavailable.
// Results are parsed from the returned HTML; fetch delegates to the shared
// safeFetchUrl so downstream gets the same content framing as Brave.
export class DuckDuckGoProvider implements ResearchProvider {
  async search(
    query: string,
    options: ResearchSearchOptions,
  ): Promise<ResearchSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    const response = await fetch(
      `https://html.duckduckgo.com/html/?${params.toString()}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (self-hosted-claw deep research; no-tracking)',
          Accept: 'text/html,application/xhtml+xml',
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `DuckDuckGo search failed (${response.status}): ${response.statusText}`,
      );
    }
    const html = await response.text();
    const results: ResearchSearchResult[] = [];
    const resultPattern =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetPattern =
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    for (const match of html.matchAll(snippetPattern)) {
      snippets.push(
        decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim()),
      );
    }
    let resultIdx = 0;
    const exclude = new Set(
      (options.excludeDomains || []).map((d) => d.toLowerCase()),
    );
    for (const match of html.matchAll(resultPattern)) {
      if (results.length >= options.maxResults) break;
      let rawUrl = match[1];
      // DDG wraps outbound URLs in a redirect: /l/?uddg=ENCODED
      const uddg = rawUrl.match(/[?&]uddg=([^&]+)/);
      if (uddg) rawUrl = decodeURIComponent(uddg[1]);
      const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
      if (!/^https?:\/\//i.test(url)) {
        resultIdx += 1;
        continue;
      }
      const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '').trim());
      if (!title) {
        resultIdx += 1;
        continue;
      }
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        const blocked = [...exclude].some(
          (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
        );
        if (blocked) {
          resultIdx += 1;
          continue;
        }
      } catch {
        resultIdx += 1;
        continue;
      }
      results.push({
        title,
        url,
        snippet: snippets[resultIdx] || '',
      });
      resultIdx += 1;
    }
    return results;
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
