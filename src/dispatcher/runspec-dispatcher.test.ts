import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createActionRecord,
  createCoreTask,
  createPrincipal,
  getActionRecord,
} from '../db.js';
import { ArtifactStore } from '../core/artifacts/store.js';
import { RunSpecDispatcher } from './runspec-dispatcher.js';

describe('RunSpecDispatcher', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // ignored
    }
  });

  it('materializes input artifacts and captures output artifacts', async () => {
    _initTestDatabase();
    const artifactRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-artifacts-'),
    );
    const artifactStore = new ArtifactStore(artifactRoot);

    createPrincipal({
      id: 'principal-1',
      type: 'controller',
      display_name: 'Alex',
      trust_tier: 'trusted',
      status: 'active',
      created_at: '2026-04-16T00:00:00.000Z',
    });
    createCoreTask({
      id: 'task-1',
      principal_id: 'principal-1',
      source_channel: 'signal',
      source_thread_id: 'thread-1',
      status: 'open',
      summary: 'Draft a polite follow-up',
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });
    const inputArtifact = artifactStore.writeArtifact({
      taskId: 'task-1',
      kind: 'document',
      mediaType: 'text/plain',
      content: 'Original conversation context',
      extension: '.txt',
    });
    createActionRecord({
      id: 'action-1',
      task_id: 'task-1',
      type: 'draft_reply_from_thread',
      status: 'approved',
      runner_pool: 'trusted',
      permission_profile: 'trusted-ops',
      idempotency_key: 'idem-1',
      semantic_dedupe_key: 'dedupe-1',
      requested_by_principal_id: 'principal-1',
      approved_by_principal_id: 'principal-1',
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });

    const dispatcher = new RunSpecDispatcher({ artifactStore });
    const compiled = await dispatcher.compileRunSpec('action-1');
    expect(compiled.runner_pool).toBe('trusted');
    expect(compiled.workspace.input_artifact_ids).toContain(inputArtifact.id);

    const dispatched = await dispatcher.dispatch('action-1');
    expect(dispatched.runRecord.runner_pool).toBe('trusted');
    expect(dispatched.result.status).toBe('succeeded');

    const taskArtifacts = artifactStore.listTaskArtifacts('task-1');
    expect(taskArtifacts.length).toBeGreaterThan(1);
    const generated = taskArtifacts.find(
      (artifact) =>
        artifact.created_by_run_id === dispatched.runRecord.id &&
        artifact.media_type === 'text/markdown',
    );
    expect(generated).toBeTruthy();
    expect(generated && artifactStore.readArtifact(generated)).toContain(
      'Draft Reply',
    );
  });

  it('routes restricted actions to the restricted pool only', async () => {
    _initTestDatabase();
    createPrincipal({
      id: 'principal-2',
      type: 'external',
      display_name: 'Morgan',
      trust_tier: 'restricted',
      status: 'active',
      created_at: '2026-04-16T00:00:00.000Z',
    });
    createCoreTask({
      id: 'task-2',
      principal_id: 'principal-2',
      source_channel: 'signal',
      source_thread_id: 'thread-2',
      status: 'open',
      summary: 'Draft a safe external reply',
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });
    createActionRecord({
      id: 'action-2',
      task_id: 'task-2',
      type: 'draft_reply_from_thread',
      status: 'approved',
      runner_pool: 'restricted',
      permission_profile: 'external-default',
      idempotency_key: 'idem-2',
      semantic_dedupe_key: 'dedupe-2',
      requested_by_principal_id: 'principal-2',
      approved_by_principal_id: null,
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });

    const trustedExecute = vi.fn();
    const restrictedExecute = vi.fn(async () => ({
      run_id: 'run-2',
      status: 'succeeded' as const,
      exit_code: 0,
      artifacts: [],
      stdout_tail: 'ok',
      stderr_tail: '',
    }));
    const dispatcher = new RunSpecDispatcher({
      trustedPool: {
        execute: trustedExecute,
        prewarm: vi.fn(),
        close: vi.fn(),
        getSnapshot: vi.fn(() => ({
          lane: 'trusted',
          totalSessions: 0,
          idleSessions: 0,
          busySessions: 0,
        })),
      } as never,
      restrictedPool: {
        execute: restrictedExecute,
        prewarm: vi.fn(),
        close: vi.fn(),
        getSnapshot: vi.fn(() => ({
          lane: 'restricted',
          totalSessions: 1,
          idleSessions: 1,
          busySessions: 0,
        })),
      } as never,
    });

    const dispatched = await dispatcher.dispatch('action-2', 'run-2');

    expect(dispatched.result.status).toBe('succeeded');
    expect(restrictedExecute).toHaveBeenCalledOnce();
    expect(trustedExecute).not.toHaveBeenCalled();
  });

  it('can stage deep research without prematurely completing the action', async () => {
    _initTestDatabase();
    createPrincipal({
      id: 'principal-3',
      type: 'controller',
      display_name: 'Alex',
      trust_tier: 'trusted',
      status: 'active',
      created_at: '2026-04-16T00:00:00.000Z',
    });
    createCoreTask({
      id: 'task-3',
      principal_id: 'principal-3',
      source_channel: 'signal',
      source_thread_id: 'thread-3',
      status: 'open',
      summary: 'Deep research: Life in Canada',
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });
    createActionRecord({
      id: 'action-3',
      task_id: 'task-3',
      type: 'deep_research',
      status: 'queued',
      runner_pool: 'trusted',
      permission_profile: 'trusted-ops',
      idempotency_key: 'idem-3',
      semantic_dedupe_key: 'dedupe-3',
      requested_by_principal_id: 'principal-3',
      approved_by_principal_id: 'principal-3',
      progress_json: JSON.stringify({
        prompt: 'Life in Canada',
        groupFolder: 'main',
        chatJid: 'signal:user:+15550001111',
      }),
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });

    const dispatcher = new RunSpecDispatcher();
    const staged = await dispatcher.stage('action-3');

    expect(staged.result.status).toBe('succeeded');
    expect(getActionRecord('action-3')?.status).toBe('executing');
  });

  it('exposes lifecycle hooks for shared pool management', async () => {
    const trustedPrewarm = vi.fn(async () => {});
    const restrictedPrewarm = vi.fn(async () => {});
    const trustedClose = vi.fn(async () => {});
    const restrictedClose = vi.fn(async () => {});

    const dispatcher = new RunSpecDispatcher({
      trustedPool: {
        execute: vi.fn(),
        prewarm: trustedPrewarm,
        close: trustedClose,
        getSnapshot: vi.fn(() => ({
          lane: 'trusted',
          totalSessions: 2,
          idleSessions: 1,
          busySessions: 1,
        })),
      } as never,
      restrictedPool: {
        execute: vi.fn(),
        prewarm: restrictedPrewarm,
        close: restrictedClose,
        getSnapshot: vi.fn(() => ({
          lane: 'restricted',
          totalSessions: 1,
          idleSessions: 1,
          busySessions: 0,
        })),
      } as never,
    });

    await dispatcher.prewarm();
    expect(trustedPrewarm).toHaveBeenCalledOnce();
    expect(restrictedPrewarm).toHaveBeenCalledOnce();
    expect(dispatcher.getPoolSnapshots()).toEqual({
      trusted: {
        lane: 'trusted',
        totalSessions: 2,
        idleSessions: 1,
        busySessions: 1,
      },
      restricted: {
        lane: 'restricted',
        totalSessions: 1,
        idleSessions: 1,
        busySessions: 0,
      },
    });

    await dispatcher.close();
    expect(trustedClose).toHaveBeenCalledOnce();
    expect(restrictedClose).toHaveBeenCalledOnce();
  });
});
