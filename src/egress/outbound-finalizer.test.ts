import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createActionRecord,
  createCoreTask,
  createPrincipal,
} from '../db.js';
import { ApprovalService } from '../core/approvals/service.js';
import { OutboundFinalizer } from './outbound-finalizer.js';

function seedAction() {
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
    summary: 'Send the final reply',
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
  });
  createActionRecord({
    id: 'action-1',
    task_id: 'task-1',
    type: 'send_message_now',
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
}

describe('OutboundFinalizer', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // ignored
    }
  });

  it('blocks sensitive finalization until approval exists', async () => {
    _initTestDatabase();
    seedAction();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const approvals = new ApprovalService();
    approvals.requireApproval({
      approvalId: 'approval-1',
      actionId: 'action-1',
      principalId: 'principal-2',
      reason: 'sensitive side effect',
    });
    const finalizer = new OutboundFinalizer(approvals);

    await expect(
      finalizer.finalizeMessage({
        actionId: 'action-1',
        channel: { sendMessage },
        chatJid: 'signal:user:+15559990000',
        text: 'Final reply',
      }),
    ).rejects.toThrow(/cannot finalize without approval/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not duplicate the same send on retry', async () => {
    _initTestDatabase();
    seedAction();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const approvals = new ApprovalService();
    approvals.requireApproval({
      approvalId: 'approval-1',
      actionId: 'action-1',
      principalId: 'principal-2',
      reason: 'sensitive side effect',
    });
    approvals.markApproved('action-1', 'principal-2');
    const finalizer = new OutboundFinalizer(approvals);

    const first = await finalizer.finalizeMessage({
      actionId: 'action-1',
      channel: { sendMessage },
      chatJid: 'signal:user:+15559990000',
      text: 'Final reply',
    });
    const second = await finalizer.finalizeMessage({
      actionId: 'action-1',
      channel: { sendMessage },
      chatJid: 'signal:user:+15559990000',
      text: 'Final reply',
    });

    expect(first).toBe('sent');
    expect(second).toBe('duplicate');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
