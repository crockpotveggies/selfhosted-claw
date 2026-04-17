import { afterEach, describe, expect, it, vi } from 'vitest';

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  _closeDatabase,
  _initTestDatabase,
  getActionLease,
  getActionRecord,
  getCoreTask,
  getRunRecord,
  listAuditLogRecords,
} from '../../db.js';
import { ActionLeaseManager } from '../actions/lease-manager.js';
import { RollingTaskSummarizer } from '../context/assembler.js';
import { SkillVisibilityService } from '../skills/visibility-service.js';
import type { NewMessage, RegisteredGroup } from '../../types.js';
import { LegacyWrappedActionEngine } from './action-engine.js';

function makeMessage(overrides?: Partial<NewMessage>): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'signal:user:+15550001111',
    sender: '+15550001111',
    sender_name: 'Alex',
    content: 'Please draft a reply.',
    timestamp: '2026-04-16T00:00:00.000Z',
    ...overrides,
  };
}

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andy',
  added_at: '2026-04-16T00:00:00.000Z',
  isMain: true,
  requiresTrigger: false,
};

const externalGroup: RegisteredGroup = {
  name: 'Client',
  folder: 'client',
  trigger: '@Andy',
  added_at: '2026-04-16T00:00:00.000Z',
  requiresTrigger: true,
};

describe('LegacyWrappedActionEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      _closeDatabase();
    } catch {
      // ignored in tests that did not init the db
    }
  });

  it('routes controller-originated work to the trusted lane and records durable state', async () => {
    _initTestDatabase();
    const executor = {
      run: vi.fn().mockResolvedValue('success' as const),
    };
    const engine = new LegacyWrappedActionEngine(executor);

    const result = await engine.processInbound({
      group: mainGroup,
      chatJid: 'signal:user:+15550001111',
      prompt: 'Prompt body',
      missedMessages: [makeMessage()],
      controllerTriggered: true,
    });

    expect(result.outcome).toBe('success');
    expect(executor.run).toHaveBeenCalledOnce();
    expect(getCoreTask(result.taskId || '')?.source_thread_id).toBe(
      'signal:user:+15550001111',
    );
    expect(getActionRecord(result.actionId || '')?.runner_pool).toBe('trusted');
    expect(getActionRecord(result.actionId || '')?.status).toBe('succeeded');
    expect(getRunRecord(result.runId || '')?.status).toBe('succeeded');
    expect(listAuditLogRecords(10)).toHaveLength(1);
  });

  it('routes external-originated work to the restricted lane', async () => {
    _initTestDatabase();
    const engine = new LegacyWrappedActionEngine({
      run: vi.fn().mockResolvedValue('success' as const),
    });

    const result = await engine.processInbound({
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Prompt body',
      missedMessages: [
        makeMessage({
          id: 'msg-2',
          chat_jid: 'signal:user:+15559990000',
          sender: '+15559990000',
          sender_name: 'External User',
        }),
      ],
      controllerTriggered: false,
    });

    expect(getActionRecord(result.actionId || '')?.runner_pool).toBe(
      'restricted',
    );
  });

  it('dedupes the same inbound event and does not duplicate side effects', async () => {
    _initTestDatabase();
    const executor = {
      run: vi.fn().mockResolvedValue('success' as const),
    };
    const engine = new LegacyWrappedActionEngine(executor);
    const request = {
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Prompt body',
      missedMessages: [
        makeMessage({
          id: 'msg-dup',
          chat_jid: 'signal:user:+15559990000',
          sender: '+15559990000',
          sender_name: 'External User',
        }),
      ],
      controllerTriggered: false,
    };

    const first = await engine.processInbound(request);
    const second = await engine.processInbound(request);

    expect(first.outcome).toBe('success');
    expect(second.outcome).toBe('duplicate');
    expect(executor.run).toHaveBeenCalledTimes(1);
  });

  it('dedupes the same semantic intent after a completed action', async () => {
    _initTestDatabase();
    const executor = {
      run: vi.fn().mockResolvedValue('success' as const),
    };
    const engine = new LegacyWrappedActionEngine(executor);

    const first = await engine.processInbound({
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Draft a concise reply',
      missedMessages: [
        makeMessage({
          id: 'msg-semantic-1',
          chat_jid: 'signal:user:+15559990000',
          sender: '+15559990000',
          sender_name: 'External User',
        }),
      ],
      controllerTriggered: false,
    });

    const second = await engine.processInbound({
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Draft a concise reply',
      missedMessages: [
        makeMessage({
          id: 'msg-semantic-2',
          chat_jid: 'signal:user:+15559990000',
          sender: '+15559990000',
          sender_name: 'External User',
          timestamp: '2026-04-16T00:00:01.000Z',
        }),
      ],
      controllerTriggered: false,
    });

    expect(first.outcome).toBe('success');
    expect(second.outcome).toBe('duplicate');
    expect(executor.run).toHaveBeenCalledTimes(1);
  });

  it('releases the action lease after execution', async () => {
    _initTestDatabase();
    const executor = {
      run: vi.fn().mockResolvedValue('success' as const),
    };
    const engine = new LegacyWrappedActionEngine(executor, {
      leaseManager: new ActionLeaseManager(30_000),
    });

    const result = await engine.processInbound({
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Prompt body',
      missedMessages: [
        makeMessage({
          id: 'msg-lease',
          chat_jid: 'signal:user:+15559990000',
          sender: '+15559990000',
          sender_name: 'External User',
        }),
      ],
      controllerTriggered: false,
    });

    expect(result.outcome).toBe('success');
    expect(getActionLease(result.actionId || '')).toBeUndefined();
  });

  it('writes a visible-skill snapshot for the current principal and lane', async () => {
    _initTestDatabase();
    const snapshotRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-visible-skills-'),
    );
    const executor = {
      run: vi.fn().mockResolvedValue('success' as const),
    };
    const engine = new LegacyWrappedActionEngine(executor, {
      skillVisibilityService: new SkillVisibilityService(snapshotRoot),
    });

    await engine.processInbound({
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Prompt body',
      missedMessages: [
        makeMessage({
          id: 'msg-visible-skills',
          chat_jid: 'signal:user:+15559990000',
          sender: '+15559990000',
          sender_name: 'External User',
        }),
      ],
      controllerTriggered: false,
    });

    const snapshotPath = path.join(
      snapshotRoot,
      'client',
      'visible-skills.v2.json',
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
      skills: Array<{ name: string }>;
    };
    expect(
      snapshot.skills.some((skill) => skill.name === 'executive-assistant'),
    ).toBe(true);
    expect(snapshot.skills.some((skill) => skill.name === 'status')).toBe(
      false,
    );
  });

  it('updates the rolling task summary as the action progresses', async () => {
    _initTestDatabase();
    const executor = {
      run: vi.fn().mockResolvedValue('success' as const),
    };
    const engine = new LegacyWrappedActionEngine(executor, {
      taskSummarizer: new RollingTaskSummarizer(120),
    });

    const result = await engine.processInbound({
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Prompt body',
      missedMessages: [
        makeMessage({
          id: 'msg-summary',
          chat_jid: 'signal:user:+15559990000',
          sender: '+15559990000',
          sender_name: 'External User',
          content: 'Need a follow-up summary.',
        }),
      ],
      controllerTriggered: false,
    });

    const task = getCoreTask(result.taskId || '');
    expect(task?.summary).toContain('Executing action');
    expect(task?.summary).toContain('succeeded');
    expect((task?.summary || '').length).toBeLessThanOrEqual(120);
  });
});
