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

/** Strip zero-width chars and homoglyphs so patterns catch obfuscated text. */
function normalise(text: string): string {
  // Zero-width characters
  let s = text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, '');
  // Cyrillic homoglyphs
  const homoglyphs: Record<string, string> = {
    '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p',
    '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i',
    '\u0455': 's', '\u0442': 't', '\u043C': 'm', '\u043A': 'k',
  };
  s = s.replace(/./g, (ch) => homoglyphs[ch] || ch);
  return s.toLowerCase();
}

const FALLBACK_PATTERNS = [
  // Instruction override
  /\bignore (all|any|previous|prior|above|system) (instructions|rules|prompts|context)\b/i,
  /\bdisregard (all|any|previous|prior|above) (instructions|rules|prompts)\b/i,
  /\bforget (all|any|previous|prior|your) (instructions|rules|prompts|context)\b/i,
  // System prompt extraction
  /\b(system prompt|developer message|hidden prompt|system message)\b/i,
  /\b(reveal|print|dump|show|output|repeat|echo) (your |the |)(system prompt|instructions|rules)\b/i,
  // Role play / persona hijacking
  /\bact as\b/i,
  /\bpretend (to be|you are)\b/i,
  /\b(jailbreak|dan mode|developer mode|god mode)\b/i,
  // Safety override
  /\boverride\b.*\b(safety|policy|guardrails?)\b/i,
  /\b(bypass|circumvent|disable)\b.*\b(safety|filter|guard|restriction)\b/i,
  // Tool injection
  /\btool.?call\b/i,
  /\bfunction.?call\b/i,
  // XML / tag injection
  /<\s*(system|assistant|developer|function|tool|internal|thinking)\b/i,
  // Chat-ML / Instruct delimiters
  /\[inst\]/i,
  /\[system\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /### (system|instruction|human|assistant):/i,
];

function fallbackSanitizeText(text: string): string {
  const lines = text.split('\n');
  const sanitized = lines
    .filter((line) => {
      const norm = normalise(line);
      return !FALLBACK_PATTERNS.some((pattern) => pattern.test(norm));
    })
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
