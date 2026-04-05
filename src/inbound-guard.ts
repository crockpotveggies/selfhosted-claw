import fs from 'fs';
import { pathToFileURL } from 'url';

import { INBOUND_GUARD_SCRIPT } from './config.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

interface GuardResult {
  allow?: boolean;
  content?: string;
  reply_to_message_content?: string | null;
  reason?: string;
}

interface GuardModule {
  sanitizeInboundMessage?: (
    message: NewMessage,
  ) => GuardResult | Promise<GuardResult>;
}

let cachedModulePromise: Promise<GuardModule | null> | null = null;

function fallbackSanitizeText(text: string): string {
  const lines = text.split('\n');
  const dangerousPatterns = [
    /\bignore (all|any|previous|prior) (instructions|rules|prompts)\b/i,
    /\b(system prompt|developer message|hidden prompt)\b/i,
    /\b(reveal|print|dump|show) (your )?(system prompt|instructions)\b/i,
    /\bact as\b/i,
    /\btool call\b/i,
    /\b<\s*system\b/i,
    /\b<\s*assistant\b/i,
    /\b<\s*developer\b/i,
  ];

  const sanitized = lines
    .filter((line) => !dangerousPatterns.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim();

  if (sanitized) return sanitized;
  return '[Potential prompt-injection content removed]';
}

async function loadGuardModule(): Promise<GuardModule | null> {
  if (cachedModulePromise) return cachedModulePromise;
  cachedModulePromise = (async () => {
    if (!INBOUND_GUARD_SCRIPT || !fs.existsSync(INBOUND_GUARD_SCRIPT)) {
      return null;
    }
    try {
      const imported = (await import(
        pathToFileURL(INBOUND_GUARD_SCRIPT).href
      )) as GuardModule;
      return imported;
    } catch (err) {
      logger.warn(
        { err: String(err), script: INBOUND_GUARD_SCRIPT },
        'Failed to load inbound guard script, using fallback sanitizer',
      );
      return null;
    }
  })();
  return cachedModulePromise;
}

export async function sanitizeInboundMessage(
  message: NewMessage,
): Promise<{ message: NewMessage; blocked: boolean; reason?: string }> {
  const module = await loadGuardModule();
  const sanitize =
    module?.sanitizeInboundMessage ||
    ((msg: NewMessage): GuardResult => ({
      allow: true,
      content: fallbackSanitizeText(msg.content),
      reply_to_message_content: msg.reply_to_message_content
        ? fallbackSanitizeText(msg.reply_to_message_content)
        : msg.reply_to_message_content,
    }));

  try {
    const result = await sanitize(message);
    if (result.allow === false) {
      return {
        message,
        blocked: true,
        reason: result.reason || 'Blocked by inbound guard',
      };
    }

    const nextMessage: NewMessage = {
      ...message,
      content:
        typeof result.content === 'string' ? result.content : message.content,
      reply_to_message_content:
        result.reply_to_message_content !== undefined
          ? result.reply_to_message_content || undefined
          : message.reply_to_message_content,
    };

    return {
      message: nextMessage,
      blocked: false,
      reason: result.reason,
    };
  } catch (err) {
    logger.warn(
      { err: String(err), script: INBOUND_GUARD_SCRIPT },
      'Inbound guard execution failed, using fallback sanitizer',
    );
    return {
      message: {
        ...message,
        content: fallbackSanitizeText(message.content),
        reply_to_message_content: message.reply_to_message_content
          ? fallbackSanitizeText(message.reply_to_message_content)
          : message.reply_to_message_content,
      },
      blocked: false,
      reason: 'Fallback sanitizer applied',
    };
  }
}
