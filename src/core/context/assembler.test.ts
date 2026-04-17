import { describe, expect, it } from 'vitest';

import type {
  ActionRecord,
  ArtifactRecord,
  PrincipalRecord,
  TaskRecord,
} from '../state/types.js';
import {
  ContextPolicyFilter,
  RollingTaskSummarizer,
  StructuredContextAssembler,
} from './assembler.js';

const principal: PrincipalRecord = {
  id: 'principal-1',
  type: 'external',
  display_name: 'Alex',
  trust_tier: 'restricted',
  status: 'active',
  created_at: '2026-04-16T00:00:00.000Z',
};

const task: TaskRecord = {
  id: 'task-1',
  principal_id: 'principal-1',
  source_channel: 'signal',
  source_thread_id: 'thread-1',
  status: 'open',
  summary: 'Need a meeting brief',
  created_at: '2026-04-16T00:00:00.000Z',
  updated_at: '2026-04-16T00:00:00.000Z',
};

const actions: ActionRecord[] = [
  {
    id: 'action-1',
    task_id: 'task-1',
    type: 'draft_reply',
    status: 'succeeded',
    runner_pool: 'restricted',
    permission_profile: 'drafting',
    idempotency_key: 'idem-1',
    semantic_dedupe_key: 'semantic-1',
    requested_by_principal_id: 'principal-1',
    approved_by_principal_id: null,
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:01:00.000Z',
  },
];

const artifacts: ArtifactRecord[] = [
  {
    id: 'artifact-1',
    task_id: 'task-1',
    kind: 'document',
    path: '/workspace/out/draft.md',
    media_type: 'text/markdown',
    sha256: 'abc',
    size_bytes: 10,
    created_by_run_id: 'run-1',
  },
  {
    id: 'artifact-2',
    task_id: 'task-1',
    kind: 'secret',
    path: '/workspace/out/secret.txt',
    media_type: 'text/plain',
    sha256: 'def',
    size_bytes: 8,
    created_by_run_id: 'run-1',
  },
];

function createAssembler() {
  return new StructuredContextAssembler({
    getTask: () => task,
    getPrincipal: () => principal,
    listActions: () => actions,
    listArtifacts: () => artifacts,
    getPlannerSections: () => ({
      current_message: 'Please draft the follow-up',
      task_summary: task.summary,
      internal_notes: 'Controller-only note',
    }),
  });
}

describe('StructuredContextAssembler', () => {
  it('builds richer planner context than execution context', () => {
    const assembler = createAssembler();

    const planner = assembler.assemblePlannerContext(task);
    const execution = assembler.assembleExecutionContext(actions[0]);

    expect(Object.keys(planner.sections)).toContain('current_message');
    expect(planner.actionHistory).toHaveLength(1);
    expect(execution.inputArtifactIds).toEqual(['artifact-1']);
    expect(execution.metadataFiles).toHaveLength(2);
  });

  it('removes disallowed context via policy filtering', () => {
    const assembler = createAssembler();

    const planner = assembler.assemblePlannerContext(task, {
      allowedSectionKeys: ['current_message', 'task_summary'],
      allowedArtifactKinds: ['document'],
    });

    expect(planner.sections.internal_notes).toBeUndefined();
    expect(planner.artifacts.map((artifact) => artifact.id)).toEqual([
      'artifact-1',
    ]);
  });
});

describe('RollingTaskSummarizer', () => {
  it('updates a rolling summary without unbounded growth', () => {
    const summarizer = new RollingTaskSummarizer(40);
    const first = summarizer.updateSummary('', 'Opened task');
    const second = summarizer.updateSummary(first, 'Draft created');
    const third = summarizer.updateSummary(
      second,
      'Approval requested from controller',
    );

    expect(first).toBe('Opened task');
    expect(second).toContain('Draft created');
    expect(third.length).toBeLessThanOrEqual(40);
    expect(third).toContain('Approval requested');
  });
});

describe('ContextPolicyFilter', () => {
  it('filters sections and artifacts deterministically', () => {
    const filter = new ContextPolicyFilter();

    const filtered = filter.filterPlannerSnapshot(
      {
        principal,
        task,
        actionHistory: actions,
        artifacts,
        sections: {
          keep: 'yes',
          drop: 'no',
        },
      },
      {
        allowedSectionKeys: ['keep'],
        allowedArtifactKinds: ['document'],
      },
    );

    expect(filtered.sections).toEqual({ keep: 'yes' });
    expect(filtered.artifacts).toHaveLength(1);
  });
});
