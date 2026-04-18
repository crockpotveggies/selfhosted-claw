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
  return JSON.parse(raw) as T;
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
