import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mkdirSync, writeFileSync } = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
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

vi.mock('./integrations/settings-store.js', () => ({
  isIntegrationEnabled: vi.fn(() => true),
}));

vi.mock('./integrations/registry.js', () => ({
  getRegisteredIntegrations: vi.fn(() => [
    {
      name: 'google-calendar',
      tools: [
        {
          name: 'calendar_list_events',
          description: 'List calendar events',
          parameters: { type: 'object', properties: {} },
          controllerOnly: true,
          location: 'host',
        },
        {
          name: 'calendar_check_availability',
          description: 'Check free busy',
          parameters: { type: 'object', properties: {} },
          controllerOnly: false,
          location: 'host',
        },
      ],
    },
  ]),
}));

import { writeIntegrationToolsManifest } from './container-runner.js';

describe('writeIntegrationToolsManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes controller-only host tools for controller-triggered non-main sessions', () => {
    writeIntegrationToolsManifest('calendar-group', false, true);

    expect(mkdirSync).toHaveBeenCalledWith('/tmp/ipc/calendar-group', {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledTimes(1);

    const [, rawManifest] = writeFileSync.mock.calls[0];
    const manifest = JSON.parse(String(rawManifest)) as Array<{ name: string }>;
    expect(manifest.map((tool) => tool.name)).toEqual([
      'calendar_list_events',
      'calendar_check_availability',
    ]);
  });
});
