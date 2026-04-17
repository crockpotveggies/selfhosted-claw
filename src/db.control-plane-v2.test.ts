import { afterEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  addGroupMembership,
  createActionRecord,
  createApprovalRecord,
  createArtifactRecord,
  createAuditLogRecord,
  createCoreTask,
  createPrincipal,
  createPrincipalGroup,
  createRunRecord,
  findIdentity,
  getActionRecord,
  getCoreTask,
  getPrincipal,
  getRunRecord,
  listApprovalsForAction,
  listArtifactsForTask,
  listAuditLogRecords,
  upsertIdentity,
} from './db.js';

describe('control-plane v2 schema', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // no-op for tests that did not initialize the db
    }
  });

  it('stores and retrieves control-plane durable records', () => {
    _initTestDatabase();

    createPrincipal({
      id: 'principal-1',
      type: 'controller',
      display_name: 'Alex',
      trust_tier: 'trusted',
      status: 'active',
      created_at: '2026-04-16T00:00:00.000Z',
    });
    upsertIdentity({
      id: 'identity-1',
      principal_id: 'principal-1',
      channel_type: 'signal',
      external_id: 'signal:user:+15550001111',
      external_handle: 'alex@example.com',
      verified: true,
    });
    createPrincipalGroup({
      id: 'group-1',
      name: 'Controllers',
      type: 'role',
      visibility: 'private',
    });
    addGroupMembership({
      principal_id: 'principal-1',
      group_id: 'group-1',
      role: 'owner',
    });
    createCoreTask({
      id: 'task-1',
      principal_id: 'principal-1',
      source_channel: 'signal',
      source_thread_id: 'thread-1',
      status: 'open',
      summary: 'Prepare a meeting brief',
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });
    createActionRecord({
      id: 'action-1',
      task_id: 'task-1',
      type: 'prepare_meeting_brief',
      status: 'approved',
      runner_pool: 'trusted',
      permission_profile: 'briefing',
      idempotency_key: 'idem-1',
      semantic_dedupe_key: 'dedupe-1',
      requested_by_principal_id: 'principal-1',
      approved_by_principal_id: 'principal-1',
      created_at: '2026-04-16T00:00:00.000Z',
      updated_at: '2026-04-16T00:00:00.000Z',
    });
    createRunRecord({
      id: 'run-1',
      action_id: 'action-1',
      runner_pool: 'trusted',
      status: 'executing',
      attempt_no: 1,
      started_at: '2026-04-16T00:01:00.000Z',
      finished_at: null,
      exit_code: null,
      error_class: null,
    });
    createArtifactRecord({
      id: 'artifact-1',
      task_id: 'task-1',
      kind: 'document',
      path: '/workspace/out/brief.md',
      media_type: 'text/markdown',
      sha256: 'abc123',
      size_bytes: 42,
      created_by_run_id: 'run-1',
    });
    createApprovalRecord({
      id: 'approval-1',
      action_id: 'action-1',
      required_from_principal_id: 'principal-1',
      status: 'approved',
      reason: 'controller confirmed',
    });
    createAuditLogRecord({
      id: 'audit-1',
      principal_id: 'principal-1',
      task_id: 'task-1',
      action_id: 'action-1',
      event_type: 'action.approved',
      payload_json: '{"ok":true}',
      created_at: '2026-04-16T00:02:00.000Z',
    });

    expect(getPrincipal('principal-1')?.display_name).toBe('Alex');
    expect(
      findIdentity('signal', 'signal:user:+15550001111')?.principal_id,
    ).toBe('principal-1');
    expect(getCoreTask('task-1')?.summary).toContain('meeting brief');
    expect(getActionRecord('action-1')?.runner_pool).toBe('trusted');
    expect(getRunRecord('run-1')?.attempt_no).toBe(1);
    expect(listArtifactsForTask('task-1')).toHaveLength(1);
    expect(listApprovalsForAction('action-1')).toHaveLength(1);
    expect(listAuditLogRecords(10)).toHaveLength(1);
  });
});
