const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'of',
  'on',
  'the',
  'to',
  'with',
]);

export function isValidTopicSlug(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+){0,2}$/.test(value);
}

export function deterministicTopicSlug(input: string): string {
  const words = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !STOPWORDS.has(word))
    .slice(0, 3);

  const candidate = words.join('-');
  if (isValidTopicSlug(candidate)) {
    return candidate;
  }

  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 18);
  if (normalized) {
    const hash = Math.abs(
      Array.from(input).reduce(
        (acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) | 0,
        0,
      ),
    )
      .toString(36)
      .slice(0, 6);
    const fallback = `${normalized.slice(0, 10)}-${hash}`
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    if (isValidTopicSlug(fallback)) {
      return fallback;
    }
  }

  return 'research-report';
}

export function ensureTopicSlug(value: string, fallbackSource: string): string {
  const trimmed = value.trim().toLowerCase();
  return isValidTopicSlug(trimmed)
    ? trimmed
    : deterministicTopicSlug(fallbackSource);
}
