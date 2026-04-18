import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  tempDataDir,
  getIntegrationMock,
  getIntegrationSettingsMock,
  clearIntegrationRuntimeFaultMock,
  recordIntegrationRuntimeFaultMock,
} = vi.hoisted(() => ({
  tempDataDir: require('path').join(
    require('os').tmpdir(),
    'nanoclaw-ipc-runtime-health-test',
  ),
  getIntegrationMock: vi.fn(),
  getIntegrationSettingsMock: vi.fn(() => ({})),
  clearIntegrationRuntimeFaultMock: vi.fn(),
  recordIntegrationRuntimeFaultMock: vi.fn(),
}));

vi.mock('./config.js', () => ({
  CONTROL_SIGNAL_JID: '',
  DATA_DIR: tempDataDir,
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

vi.mock('./container-runner.js', () => ({}));

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getAllChats: vi.fn(() => []),
  getRecentMessages: vi.fn(() => []),
  getTaskById: vi.fn(() => null),
  updateTask: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  deriveGroupFolder: vi.fn(),
  isValidGroupFolder: vi.fn(() => true),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./integrations/registry.js', () => ({
  getIntegration: getIntegrationMock,
}));

vi.mock('./integrations/settings-store.js', () => ({
  getIntegrationSettings: getIntegrationSettingsMock,
}));

vi.mock('./integrations/runtime-health.js', () => ({
  clearIntegrationRuntimeFault: clearIntegrationRuntimeFaultMock,
  recordIntegrationRuntimeFault: recordIntegrationRuntimeFaultMock,
}));

import { processTaskIpc } from './ipc.js';

describe('processTaskIpc integration tool runtime health', () => {
  beforeEach(() => {
    fs.mkdirSync(tempDataDir, { recursive: true });
    getIntegrationMock.mockReset();
    getIntegrationSettingsMock.mockClear();
    clearIntegrationRuntimeFaultMock.mockReset();
    recordIntegrationRuntimeFaultMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('records runtime faults when a host integration tool fails', async () => {
    getIntegrationMock.mockReturnValue({
      name: 'google-calendar',
      tools: [
        {
          name: 'calendar_check_availability',
          location: 'host',
          sideEffecting: false,
          execute: vi.fn(async () => {
            throw new Error(
              'Calendar API 401: {"error":{"message":"Invalid Credentials"}}',
            );
          }),
        },
      ],
    });

    await processTaskIpc(
      {
        type: 'integration_tool',
        requestId: 'req-1',
        integration: 'google-calendar',
        tool: 'calendar_check_availability',
        args: {},
      },
      'main',
      true,
      {
        sendMessage: async () => {},
        resolveRecipient: async () => 'signal:user:+15550001111',
        registeredGroups: () => ({}),
        registerGroup: () => {},
        syncGroups: async () => {},
        getAvailableGroups: () => [],
        writeGroupsSnapshot: () => {},
        onTasksChanged: () => {},
      },
      true,
    );

    expect(recordIntegrationRuntimeFaultMock).toHaveBeenCalledWith(
      'google-calendar',
      expect.objectContaining({
        tool: 'calendar_check_availability',
        message: expect.stringContaining('Invalid Credentials'),
      }),
    );
    expect(clearIntegrationRuntimeFaultMock).not.toHaveBeenCalled();
  });

  it('clears stale runtime faults after a successful host integration tool call', async () => {
    getIntegrationMock.mockReturnValue({
      name: 'google-calendar',
      tools: [
        {
          name: 'calendar_check_availability',
          location: 'host',
          sideEffecting: false,
          execute: vi.fn(async () => JSON.stringify({ ok: true })),
        },
      ],
    });

    await processTaskIpc(
      {
        type: 'integration_tool',
        requestId: 'req-2',
        integration: 'google-calendar',
        tool: 'calendar_check_availability',
        args: {},
      },
      'main',
      true,
      {
        sendMessage: async () => {},
        resolveRecipient: async () => 'signal:user:+15550001111',
        registeredGroups: () => ({}),
        registerGroup: () => {},
        syncGroups: async () => {},
        getAvailableGroups: () => [],
        writeGroupsSnapshot: () => {},
        onTasksChanged: () => {},
      },
      true,
    );

    expect(clearIntegrationRuntimeFaultMock).toHaveBeenCalledWith(
      'google-calendar',
    );
    expect(recordIntegrationRuntimeFaultMock).not.toHaveBeenCalled();
  });
});
