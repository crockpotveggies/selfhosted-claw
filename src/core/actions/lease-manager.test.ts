import { afterEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createActionRecord,
  createCoreTask,
  createPrincipal,
} from '../../db.js';
import { ActionLeaseManager } from './lease-manager.js';

function seedAction(): void {
  createPrincipal({
    id: 'principal-1',
    type: 'external',
    display_name: 'Requester',
    trust_tier: 'restricted',
    status: 'active',
    created_at: '2026-04-16T00:00:00.000Z',
  });
  createCoreTask({
    id: 'task-1',
    principal_id: 'principal-1',
    source_channel: 'signal',
    source_thread_id: 'thread-1',
    status: 'open',
    summary: 'Lease me maybe',
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
  });
  createActionRecord({
    id: 'action-1',
    task_id: 'task-1',
    type: 'draft_reply_from_thread',
    status: 'approved',
    runner_pool: 'restricted',
    permission_profile: 'drafting',
    idempotency_key: 'idem-1',
    semantic_dedupe_key: 'semantic-1',
    requested_by_principal_id: 'principal-1',
    approved_by_principal_id: null,
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
  });
}

describe('ActionLeaseManager', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // ignored
    }
  });

  it('allows only one active lease per action at a time', () => {
    _initTestDatabase();
    seedAction();
    const manager = new ActionLeaseManager(5_000);

    const first = manager.claim(
      'action-1',
      'worker-a',
      new Date('2026-04-16T00:00:00.000Z'),
    );
    const second = manager.claim(
      'action-1',
      'worker-b',
      new Date('2026-04-16T00:00:01.000Z'),
    );

    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(manager.current('action-1')?.worker_id).toBe('worker-a');
  });

  it('allows a new lease after expiry', () => {
    _initTestDatabase();
    seedAction();
    const manager = new ActionLeaseManager(1_000);

    const first = manager.claim(
      'action-1',
      'worker-a',
      new Date('2026-04-16T00:00:00.000Z'),
    );
    const second = manager.claim(
      'action-1',
      'worker-b',
      new Date('2026-04-16T00:00:02.000Z'),
    );

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(manager.current('action-1')?.worker_id).toBe('worker-b');
  });
});
