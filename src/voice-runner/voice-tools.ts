// Tool registry exposed to the voice-runner LLM.
//
// Why a dedicated voice-side registry instead of reusing `src/tool-registry.ts`:
//   - The container-agent registry exposes ~30 tools designed for long-horizon
//     chat (scheduling, memory, research-start, integration-specific actions).
//     Many are too slow or too stateful for a phone call.
//   - The voice loop has strict latency budgets: any tool we expose must return
//     a compact conversational answer within a few seconds.
//   - Voice tools live inside the host process and share fetch semantics with
//     the rest of the admin server — no Docker round-trip.
//
// Each tool declares its OpenAI-compatible schema (shipped to OpenArc via the
// `tools` request field) plus an `execute(args)` that returns a string suitable
// for feeding back into the model as a `role: "tool"` message.

import { DuckDuckGoProvider } from '../research/providers.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ subsystem: 'voice-tools' });

export interface VoiceToolSchema {
  /** Stable tool name — matches the `tool_calls[].function.name` we expect. */
  name: string;
  /** Short imperative description the LLM reads to decide whether to call it. */
  description: string;
  /** JSON Schema for arguments, as accepted by OpenAI's `tools[].function.parameters`. */
  parameters: Record<string, unknown>;
}

export interface VoiceTool {
  schema: VoiceToolSchema;
  /**
   * Run the tool and return a compact string the LLM can reference. Return
   * short text (<= ~500 words) — voice replies are small, and long tool
   * outputs blow up the follow-up turn's prompt.
   *
   * Must not throw for recoverable failures; return `Error: <reason>` so the
   * model can apologize naturally. Throw only on abort.
   */
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

const WEB_SEARCH_TIMEOUT_MS = 8_000;
const WEB_SEARCH_DEFAULT_RESULTS = 3;
const WEB_SEARCH_MAX_RESULTS = 5;
const WEB_SEARCH_MAX_SNIPPET = 280;

const webSearchProvider = new DuckDuckGoProvider();

const webSearchTool: VoiceTool = {
  schema: {
    name: 'web_search',
    description:
      'Search the public web for current, factual information. Use this when the caller asks about real-time data — weather, news, prices, specific facts, recent events, or anything that may have changed since your training. Returns a short list of titles + snippets + URLs.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query, phrased as a person would type it.',
        },
        max_results: {
          type: 'integer',
          description: `Number of results to return (1-${WEB_SEARCH_MAX_RESULTS}). Defaults to ${WEB_SEARCH_DEFAULT_RESULTS}.`,
        },
      },
      required: ['query'],
    },
  },
  async execute(args, signal) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return 'Error: web_search requires a non-empty query argument.';
    }
    const maxResultsRaw = Number(args.max_results);
    const maxResults =
      Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
        ? Math.min(Math.trunc(maxResultsRaw), WEB_SEARCH_MAX_RESULTS)
        : WEB_SEARCH_DEFAULT_RESULTS;

    // Wrap the provider's search in a timeout + abort signal so a slow SERP
    // can never stall the voice turn indefinitely.
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(
      () => abortController.abort(new Error('web_search timeout')),
      WEB_SEARCH_TIMEOUT_MS,
    );
    const onParentAbort = () => abortController.abort(signal.reason);
    if (signal.aborted) onParentAbort();
    else signal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const results = await webSearchProvider.search(query, {
        maxResults,
      });
      if (!results.length) {
        return `No web results for "${query}".`;
      }
      const lines = [`Web search results for "${query}":`];
      for (let i = 0; i < results.length; i += 1) {
        const r = results[i];
        const snippet = (r.snippet || '').slice(0, WEB_SEARCH_MAX_SNIPPET);
        lines.push(
          `${i + 1}. ${r.title}${snippet ? ` — ${snippet}` : ''} (${r.url})`,
        );
      }
      return lines.join('\n');
    } catch (err) {
      log.warn({ err, query }, 'web_search failed');
      const message = err instanceof Error ? err.message : String(err);
      return `Error: web_search failed (${message}).`;
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener?.('abort', onParentAbort);
    }
  },
};

const getCurrentTimeTool: VoiceTool = {
  schema: {
    name: 'get_current_time',
    description:
      'Get the current date and time on the server (UTC and local). Use when the caller asks "what day is it", "what time is it", or anything that needs the present moment.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  async execute() {
    const now = new Date();
    const localeString = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    return `Current time: ${localeString} (UTC: ${now.toISOString()}).`;
  },
};

/**
 * The fixed tool set exposed to the voice agent. Order is intentional —
 * OpenArc/Qwen3 reads the list in-order when filling its chat template.
 */
const VOICE_TOOLS: VoiceTool[] = [webSearchTool, getCurrentTimeTool];

export interface VoiceToolRegistry {
  list(): VoiceTool[];
  find(name: string): VoiceTool | undefined;
  openAiSchemas(): Array<{ type: 'function'; function: VoiceToolSchema }>;
}

export function createVoiceToolRegistry(
  tools: VoiceTool[] = VOICE_TOOLS,
): VoiceToolRegistry {
  const byName = new Map<string, VoiceTool>();
  for (const tool of tools) {
    byName.set(tool.schema.name, tool);
  }
  return {
    list: () => [...tools],
    find: (name) => byName.get(name),
    openAiSchemas: () =>
      tools.map((tool) => ({ type: 'function', function: tool.schema })),
  };
}

/**
 * Build the instruction line the LLM sees describing what tools it has. Kept
 * small so it fits comfortably within the voice-turn token budget.
 */
export function describeAvailableToolsForPrompt(
  registry: VoiceToolRegistry,
): string {
  const tools = registry.list();
  if (tools.length === 0) return '';
  const bullets = tools
    .map(
      (tool) =>
        `- ${tool.schema.name}: ${tool.schema.description.split('.')[0]}.`,
    )
    .join('\n');
  return [
    'You can invoke tools via OpenAI-compatible function calls. Use them ONLY when you need real-time or external data you do not already know. For greetings, small talk, or anything you can answer from the call context, respond directly without calling a tool.',
    'Available tools:',
    bullets,
    'When a tool is needed: emit the tool_call, wait for the result, then deliver a short spoken answer.',
  ].join('\n');
}

// Re-exported so tests can inject their own tools without using the default
// registry.
export const __defaultVoiceTools = VOICE_TOOLS;
