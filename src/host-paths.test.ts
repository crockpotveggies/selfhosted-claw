import path from 'path';

import { describe, expect, it } from 'vitest';

import { mapContainerPathToHostPath } from './host-paths.js';

describe('mapContainerPathToHostPath', () => {
  it('maps a nested bind-mounted project path back to the host source', () => {
    const result = mapContainerPathToHostPath(
      '/workspace-host/data/sessions/a',
      [
        {
          Type: 'bind',
          Source: '/Users/example/selfhosted-claw',
          Destination: '/workspace-host',
        },
      ],
    );

    expect(result).toBe('/Users/example/selfhosted-claw/data/sessions/a');
  });

  it('prefers the deepest matching mount', () => {
    const result = mapContainerPathToHostPath('/app/data/sessions/a', [
      {
        Type: 'bind',
        Source: '/host/project',
        Destination: '/app',
      },
      {
        Type: 'bind',
        Source: '/host/project/data',
        Destination: '/app/data',
      },
    ]);

    expect(result).toBe('/host/project/data/sessions/a');
  });

  it('preserves windows-style sources', () => {
    const result = mapContainerPathToHostPath(
      '\\workspace-host\\store\\logs.db'.replace(/\\/g, path.sep),
      [
        {
          Type: 'bind',
          Source: 'C:\\Users\\justi\\Projects\\selfhosted-claw',
          Destination: `${path.sep}workspace-host`,
        },
      ],
    );

    expect(result).toBe(
      'C:\\Users\\justi\\Projects\\selfhosted-claw\\store\\logs.db',
    );
  });
});
