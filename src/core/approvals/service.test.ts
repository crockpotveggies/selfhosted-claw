import { afterEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createActionRecord,
  createCoreTask,
  createPrincipal,
  getActionRecord,
} from '../../db.js';
import { ApprovalService } from './service.js';

describe('ApprovalService', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // ignored
    }
  });

  it('blocks finalization until required approval exists', () => {
    _initTestDatabase();
    createPrincipal({
      id: 'principal-1',
      type: 'external',
      display_name: 'Requester',
      trust_tier: 'restricted',
      status: 'active',
      created_at: '2026-04-16T00:00:00.000Z',
    });
    createPrincipal({
      id: 'principal-2',
      type: 'controller',
      display_name: 'Approver',
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
      summary: 'Send outbound message',
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });
    createActionRecord({
      id: 'action-1',
      task_id: 'task-1',
      type: 'send_email_now',
      status: 'approved',
      runner_pool: 'trusted',
      permission_profile: 'trusted-ops',
      idempotency_key: 'idem-1',
      semantic_dedupe_key: 'dedupe-1',
      requested_by_principal_id: 'principal-1',
      approved_by_principal_id: null,
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });

    const approvals = new ApprovalService();
    approvals.requireApproval({
      approvalId: 'approval-1',
      actionId: 'action-1',
      principalId: 'principal-2',
      reason: 'sensitive side effect',
    });

    expect(() => approvals.finalize('action-1')).toThrow(/cannot finalize/);

    approvals.markApproved('action-1', 'principal-2');
    approvals.finalize('action-1');

    expect(getActionRecord('action-1')?.status).toBe('succeeded');
  });
});
