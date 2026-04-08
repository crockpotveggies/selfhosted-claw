// ── Inbound Message Guard ──────────────────────────────────────────
// Sanitizes incoming messages before they reach the agent.
// Lines matching dangerous patterns are stripped and replaced with a marker.
// Entire messages are blocked when the whole content is adversarial.

// ── Normalisation ──────────────────────────────────────────────────
// Collapse unicode tricks (homoglyphs, zero-width chars, leetspeak) so regex
// patterns work against obfuscated payloads.

const HOMOGLYPH_MAP = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p',
  '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i',
  '\u0458': 'j', '\u044C': 'b', '\u043D': 'h', '\u0442': 't',
  '\u043C': 'm', '\u0433': 'r', '\u043A': 'k', '\u0455': 's',
  '\u04BB': 'h', '\u0501': 'd',
  // Common fullwidth latin
  '\uFF41': 'a', '\uFF42': 'b', '\uFF43': 'c', '\uFF44': 'd',
  '\uFF45': 'e', '\uFF46': 'f', '\uFF47': 'g', '\uFF48': 'h',
  '\uFF49': 'i', '\uFF4A': 'j', '\uFF4B': 'k', '\uFF4C': 'l',
  '\uFF4D': 'm', '\uFF4E': 'n', '\uFF4F': 'o', '\uFF50': 'p',
  '\uFF51': 'q', '\uFF52': 'r', '\uFF53': 's', '\uFF54': 't',
  '\uFF55': 'u', '\uFF56': 'v', '\uFF57': 'w', '\uFF58': 'x',
  '\uFF59': 'y', '\uFF5A': 'z',
};

const LEET_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's',
  '7': 't', '@': 'a', '$': 's', '!': 'i',
};

function normalise(text) {
  // Strip zero-width characters
  let s = text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, '');
  // Replace homoglyphs
  s = s.replace(/./g, (ch) => HOMOGLYPH_MAP[ch] || ch);
  // Replace leetspeak (only in alpha context to avoid false positives on numbers)
  s = s.replace(/[0134578@$!]/g, (ch) => LEET_MAP[ch] || ch);
  return s.toLowerCase();
}

// ── Line-level patterns ────────────────────────────────────────────
// If ANY of these match a normalised line, that line is stripped.

const DANGEROUS_LINE_PATTERNS = [
  // Direct instruction override
  /\bignore (all|any|previous|prior|above|system) (instructions|rules|prompts|context)\b/,
  /\bdisregard (all|any|previous|prior|above) (instructions|rules|prompts)\b/,
  /\bforget (all|any|previous|prior|your) (instructions|rules|prompts|context)\b/,
  /\bdo not follow (your|the|any) (instructions|rules|guidelines)\b/,
  /\byou (are|were) (now |)(free|released|liberated) from (all |any |)(constraints|rules|restrictions)\b/,

  // System prompt / internal data extraction
  /\b(system prompt|developer message|hidden prompt|system message|initial prompt)\b/,
  /\b(reveal|print|dump|show|output|display|repeat|echo) (your |the |)(system prompt|instructions|rules|initial prompt|hidden prompt)\b/,
  /\bwhat (are|were) your (initial |original |system )?(instructions|rules|prompts)\b/,

  // Role play / persona hijacking
  /\bact as\b/,
  /\bpretend (to be|you are|you're)\b/,
  /\byou are (now|a|an)\b.*\b(ai|assistant|bot|model|system)\b/,
  /\bnew (persona|identity|role|character)\b/,
  /\b(enter|switch to|activate) (a |)(new |)(mode|persona|role|character)\b/,
  /\b(jailbreak|dan mode|developer mode|god mode)\b/,

  // Safety/policy override
  /\boverride\b.*\b(safety|policy|guardrails?|restrictions?|filters?)\b/,
  /\b(bypass|circumvent|disable|turn off)\b.*\b(safety|filter|guard|restriction|limitation)\b/,

  // Tool / function injection
  /\btool.?call\b/,
  /\bfunction.?call\b/,
  /\bexecute\b.*\bsecret\b/,

  // XML / special tag injection (normalised, so angle brackets may be present)
  /<\s*(system|assistant|developer|function|tool|internal|thinking)\b/,

  // Chat-ML / Instruct delimiters (attempt to inject role boundaries)
  /\[inst\]/,
  /\[\/inst\]/,
  /\[system\]/,
  /<\|im_start\|>/,
  /<\|im_end\|>/,
  /<\|system\|>/,
  /<\|user\|>/,
  /<\|assistant\|>/,
  /### (system|instruction|human|assistant):/,
  /<<sys>>/,
  /<\|endoftext\|>/,

  // Base64 encoded payload indicators (long base64 blocks are suspicious in chat)
  /\b(decode|eval|execute)\s*(this|the following)?\s*:?\s*[A-Za-z0-9+/]{40,}/,
];

// ── Message-level patterns ─────────────────────────────────────────
// Block outright only when the ENTIRE message is clearly adversarial.
// Mixed messages (injection + legitimate content) are handled by line-level
// sanitization instead — blocking those would drop legitimate user messages.

const BLOCK_PATTERNS = [
  // Encoded payloads as entire message (likely obfuscated injection)
  /^[A-Za-z0-9+/\s]{100,}={0,2}\s*$/,
];

// ── Sender name patterns ───────────────────────────────────────────
// Injection via display name — these warrant blocking the message.

const DANGEROUS_SENDER_PATTERNS = [
  /<\s*(system|assistant|developer|function|tool)\b/i,
  /\[inst\]/i,
  /### (system|instruction):/i,
  /<\|im_start\|>/i,
  /\bignore (all|any|previous|prior) instructions\b/i,
];

function sanitizeText(text) {
  const lines = String(text || '').split('\n');
  const removed = [];
  const kept = [];

  for (const line of lines) {
    const norm = normalise(line);
    if (DANGEROUS_LINE_PATTERNS.some((pattern) => pattern.test(norm))) {
      removed.push(line.trim());
    } else {
      kept.push(line);
    }
  }

  let content = kept.join('\n').trim();
  if (!content) {
    content = '[Potential prompt-injection content removed]';
  }
  if (removed.length > 0) {
    content = `[Untrusted instruction-like content stripped]\n${content}`;
  }

  return { content, removed };
}

export function sanitizeInboundMessage(message) {
  // Check sender name for injection attempts
  if (message.sender_name) {
    const senderNorm = normalise(message.sender_name);
    if (DANGEROUS_SENDER_PATTERNS.some((p) => p.test(message.sender_name) || p.test(senderNorm))) {
      return {
        allow: false,
        reason: `Sender name contains injection attempt: "${message.sender_name}"`,
      };
    }
  }

  // Check for full-message block patterns
  const normFull = normalise(message.content);
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(normFull)) {
      return {
        allow: false,
        reason: 'Entire message matched a block pattern',
      };
    }
  }

  // Line-level sanitization
  const contentResult = sanitizeText(message.content);
  const quotedResult = message.reply_to_message_content
    ? sanitizeText(message.reply_to_message_content)
    : null;

  return {
    allow: true,
    content: contentResult.content,
    reply_to_message_content: quotedResult
      ? quotedResult.content
      : message.reply_to_message_content,
    reason:
      contentResult.removed.length > 0 || (quotedResult && quotedResult.removed.length > 0)
        ? `Sanitized ${contentResult.removed.length + (quotedResult?.removed.length || 0)} injection line(s)`
        : undefined,
  };
}
