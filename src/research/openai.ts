import { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } from '../config.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function callJsonChatCompletion<T>(
  messages: ChatMessage[],
  options?: {
    maxTokens?: number;
    temperature?: number;
  },
): Promise<T> {
  const response = await fetch(
    `${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OPENAI_API_KEY
          ? { Authorization: `Bearer ${OPENAI_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens ?? 1800,
        messages,
        response_format: { type: 'json_object' },
        // Qwen3 defaults to extended chain-of-thought ("thinking") mode, which
        // burns thousands of silent reasoning tokens before the final JSON.
        // Deep research stages want direct output, so disable it. Backends
        // that ignore this field are unaffected.
        chat_template_kwargs: { enable_thinking: false },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Chat completion failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const raw = payload.choices?.[0]?.message?.content || '';
  return extractJson<T>(raw);
}

function extractJson<T>(raw: string): T {
  // Models occasionally wrap JSON in markdown fences or prose despite
  // response_format=json_object. Strip a code fence, then fall back to
  // extracting the outermost {...} span.
  const fenceStripped = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(fenceStripped) as T;
  } catch {
    const first = fenceStripped.indexOf('{');
    const last = fenceStripped.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return JSON.parse(fenceStripped.slice(first, last + 1)) as T;
    }
    throw new Error('Model response did not contain parseable JSON');
  }
}

export async function callTextChatCompletion(
  messages: ChatMessage[],
  options?: {
    maxTokens?: number;
    temperature?: number;
  },
): Promise<string> {
  const response = await fetch(
    `${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OPENAI_API_KEY
          ? { Authorization: `Bearer ${OPENAI_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens ?? 3200,
        messages,
        chat_template_kwargs: { enable_thinking: false },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Chat completion failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  return payload.choices?.[0]?.message?.content?.trim() || '';
}
