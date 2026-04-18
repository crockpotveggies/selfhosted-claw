import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

const { mkdirSync, writeFileSync } = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const { buildSessionToolRegistrySnapshot } = vi.hoisted(() => ({
  buildSessionToolRegistrySnapshot: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync,
      writeFileSync,
      existsSync: vi.fn(() => false),
    },
  };
});

vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: (groupFolder: string) => `/tmp/ipc/${groupFolder}`,
  resolveGroupFolderPath: (groupFolder: string) => `/tmp/groups/${groupFolder}`,
}));

vi.mock('./tool-registry.js', () => ({
  buildSessionToolRegistrySnapshot,
}));

import { writeIntegrationToolsManifest } from './container-runner.js';

describe('writeIntegrationToolsManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSessionToolRegistrySnapshot.mockReturnValue({
      tools: [],
      allowedToolNames: ['web_search', 'signal.reply'],
      integrationManifest: [
        {
          name: 'signal.reply',
          description: 'Reply in thread',
          parameters: { type: 'object', properties: {} },
          integration: 'signal',
          controllerOnly: false,
        },
      ],
    });
  });

  it('writes both the integration manifest and the allowed tool list', () => {
    writeIntegrationToolsManifest('calendar-group', false, true, {
      scheduledTaskMode: true,
    });

    expect(buildSessionToolRegistrySnapshot).toHaveBeenCalledWith({
      groupFolder: 'calendar-group',
      isMain: false,
      controllerTriggered: true,
      scheduledTaskMode: true,
    });
    expect(mkdirSync).toHaveBeenCalledWith('/tmp/ipc/calendar-group', {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledTimes(2);

    expect(writeFileSync.mock.calls[0][0]).toBe(
      path.join('/tmp/ipc/calendar-group', 'integration_tools.json'),
    );
    expect(JSON.parse(String(writeFileSync.mock.calls[0][1]))).toEqual([
      {
        name: 'signal.reply',
        description: 'Reply in thread',
        parameters: { type: 'object', properties: {} },
        integration: 'signal',
        controllerOnly: false,
      },
    ]);

    expect(writeFileSync.mock.calls[1][0]).toBe(
      path.join('/tmp/ipc/calendar-group', 'allowed_tools.json'),
    );
    expect(JSON.parse(String(writeFileSync.mock.calls[1][1]))).toEqual({
      internal: true,
      allowedToolNames: ['web_search', 'signal.reply'],
    });
  });
});
