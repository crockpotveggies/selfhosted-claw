import { describe, expect, it } from 'vitest';

import {
  deterministicTopicSlug,
  ensureTopicSlug,
  isValidTopicSlug,
} from './slug.js';

describe('research slug helpers', () => {
  it('validates 1-3 word topic slugs', () => {
    expect(isValidTopicSlug('life-canada')).toBe(true);
    expect(isValidTopicSlug('life-in-canada')).toBe(true);
    expect(isValidTopicSlug('life-in-modern-canada')).toBe(false);
  });

  it('builds deterministic slugs from prompts', () => {
    expect(deterministicTopicSlug('Life in Canada')).toBe('life-canada');
    expect(deterministicTopicSlug('Cost of Living for Newcomers')).toBe(
      'cost-living-newcomers',
    );
  });

  it('falls back when model slugs are invalid', () => {
    expect(ensureTopicSlug('bad slug here', 'Life in Canada')).toBe(
      'life-canada',
    );
  });
});
