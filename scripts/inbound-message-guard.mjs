const DANGEROUS_LINE_PATTERNS = [
  /\bignore (all|any|previous|prior) (instructions|rules|prompts)\b/i,
  /\b(system prompt|developer message|hidden prompt)\b/i,
  /\b(reveal|print|dump|show) (your )?(system prompt|instructions)\b/i,
  /\bact as\b/i,
  /\bpretend to be\b/i,
  /\boverride\b.*\b(safety|policy|guardrails?)\b/i,
  /\btool call\b/i,
  /\bexecute\b.*\bsecret\b/i,
  /<\s*(system|assistant|developer)\b/i,
];

function sanitizeText(text) {
  const lines = String(text || '').split('\n');
  const removed = [];
  const kept = [];

  for (const line of lines) {
    if (DANGEROUS_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
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

  return {
    content,
    removed,
  };
}

export function sanitizeInboundMessage(message) {
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
        ? 'Sanitized possible prompt-injection content'
        : undefined,
  };
}
