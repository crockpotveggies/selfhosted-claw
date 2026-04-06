import { describe, expect, it } from 'vitest';

import { _buildConfiguredMainGroup } from './index.js';
import { RegisteredGroup } from './types.js';

describe('configured Signal main group', () => {
  it('builds a main group for a direct Signal control chat when none exists', () => {
    const result = _buildConfiguredMainGroup('signal:user:+15550001111', {});

    expect(result).toBeTruthy();
    expect(result?.jid).toBe('signal:user:+15550001111');
    expect(result?.group.folder).toBe('main');
    expect(result?.group.isMain).toBe(true);
    expect(result?.group.requiresTrigger).toBe(false);
  });

  it('does not build a second main group when one already exists', () => {
    const groups: Record<string, RegisteredGroup> = {
      'signal:user:+15550002222': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
        requiresTrigger: false,
      },
    };

    expect(
      _buildConfiguredMainGroup('signal:user:+15550001111', groups),
    ).toBeNull();
  });

  it('ignores non-direct-signal control identifiers', () => {
    expect(_buildConfiguredMainGroup('signal:group:abc123', {})).toBeNull();
    expect(_buildConfiguredMainGroup('phone:+15550001111', {})).toBeNull();
  });
});
