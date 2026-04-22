import { describe, expect, it, vi } from 'vitest';

import {
  createVoiceToolRegistry,
  describeAvailableToolsForPrompt,
  type VoiceTool,
} from './voice-tools.js';

describe('voice-tools registry', () => {
  it('exposes default tools with well-formed OpenAI schemas', () => {
    const registry = createVoiceToolRegistry();
    const schemas = registry.openAiSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(2);
    for (const schema of schemas) {
      expect(schema.type).toBe('function');
      expect(typeof schema.function.name).toBe('string');
      expect(schema.function.name.length).toBeGreaterThan(0);
      expect(typeof schema.function.description).toBe('string');
      expect(schema.function.parameters).toBeTypeOf('object');
      expect((schema.function.parameters as { type?: string }).type).toBe(
        'object',
      );
    }
  });

  it('find() returns tools by name and undefined for misses', () => {
    const registry = createVoiceToolRegistry();
    expect(registry.find('web_search')?.schema.name).toBe('web_search');
    expect(registry.find('get_current_time')?.schema.name).toBe(
      'get_current_time',
    );
    expect(registry.find('nonexistent_tool')).toBeUndefined();
  });

  it('get_current_time returns a string containing the current year', async () => {
    const registry = createVoiceToolRegistry();
    const tool = registry.find('get_current_time');
    expect(tool).toBeDefined();
    const ac = new AbortController();
    const result = await tool!.execute({}, ac.signal);
    expect(result).toContain(String(new Date().getFullYear()));
    expect(result).toMatch(/UTC:/);
  });

  it('web_search returns a formatted string on success', async () => {
    // Stub fetch with a minimal DuckDuckGo-ish HTML payload.
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">
        Example Page One
      </a>
      <a class="result__snippet">A short snippet for page one.</a>
      <a class="result__a" href="https://example.com/page2">Example Page Two</a>
      <a class="result__snippet">Another snippet.</a>
    `;
    const fetchMock = vi.fn(
      async () =>
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    try {
      const registry = createVoiceToolRegistry();
      const tool = registry.find('web_search');
      const ac = new AbortController();
      const result = await tool!.execute(
        { query: 'example', max_results: 2 },
        ac.signal,
      );
      expect(result).toContain('Web search results for "example"');
      expect(result).toContain('Example Page One');
      expect(result).toContain('Example Page Two');
      expect(result).toContain('https://example.com/page1');
      // DDG redirect URL should be unwrapped.
      expect(result).not.toContain('uddg=');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('web_search returns an Error string (does not throw) on network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    try {
      const registry = createVoiceToolRegistry();
      const tool = registry.find('web_search');
      const ac = new AbortController();
      const result = await tool!.execute({ query: 'anything' }, ac.signal);
      expect(result.startsWith('Error:')).toBe(true);
      expect(result).toContain('network down');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('web_search returns an Error for missing query', async () => {
    const registry = createVoiceToolRegistry();
    const tool = registry.find('web_search');
    const ac = new AbortController();
    const result = await tool!.execute({}, ac.signal);
    expect(result.startsWith('Error:')).toBe(true);
  });

  it('describeAvailableToolsForPrompt lists every registered tool', () => {
    const registry = createVoiceToolRegistry();
    const desc = describeAvailableToolsForPrompt(registry);
    expect(desc).toContain('web_search');
    expect(desc).toContain('get_current_time');
    expect(desc).toMatch(/Available tools:/);
  });

  it('custom registry overrides the default tool list', () => {
    const custom: VoiceTool = {
      schema: {
        name: 'noop',
        description: 'Does nothing.',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => 'ok',
    };
    const registry = createVoiceToolRegistry([custom]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.find('noop')).toBe(custom);
    expect(registry.find('web_search')).toBeUndefined();
  });
});
