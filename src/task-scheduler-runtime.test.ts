import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(async () => ({
    status: 'success',
    result: null,
  })),
  writeTasksSnapshot: vi.fn(),
  writeIntegrationToolsManifest: vi.fn(),
}));

import { _initTestDatabase, createTask } from './db.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';
import {
  runContainerAgent,
  writeIntegrationToolsManifest,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

describe('task scheduler runtime permissions', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs scheduled tasks with controller privileges and writes a privileged tool manifest', async () => {
    createTask({
      id: 'task-calendar',
      group_folder: 'calendar-group',
      chat_jid: 'signal:user:+15550001111',
      prompt: 'Check tomorrow morning calendar conflicts',
      schedule_type: 'once',
      schedule_value: '2026-04-17T07:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-04-17T06:00:00.000Z',
    });

    const group: RegisteredGroup = {
      name: 'Calendar Group',
      folder: 'calendar-group',
      trigger: '@Andy',
      added_at: '2026-04-17T06:00:00.000Z',
      isMain: false,
    };

    const enqueueTask = vi.fn(
      async (_jid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'signal:user:+15550001111': group,
      }),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(writeIntegrationToolsManifest).toHaveBeenCalledWith(
      'calendar-group',
      false,
      true,
      {
        scheduledTaskMode: true,
      },
    );
    expect(runContainerAgent).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        groupFolder: 'calendar-group',
        chatJid: 'signal:user:+15550001111',
        runtimeStateKey: expect.stringMatching(
          /^calendar-group[\\/]tasks[\\/]task-calendar$/,
        ),
        isScheduledTask: true,
        controllerTriggered: true,
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
