import type {
  ActionRecord,
  ArtifactRecord,
  PrincipalRecord,
  TaskRecord,
} from '../state/types.js';
import type {
  ContextAssembler,
  ContextVisibilityPolicy,
  ExecutionContextBundle,
  PlannerContextBundle,
} from './contracts.js';

export interface ContextSnapshot {
  principal: PrincipalRecord;
  task: TaskRecord;
  actionHistory: ActionRecord[];
  artifacts: ArtifactRecord[];
  sections: Record<string, unknown>;
}

export interface ContextRepository {
  getTask(taskId: string): TaskRecord;
  getPrincipal(principalId: string): PrincipalRecord;
  listActions(taskId: string): ActionRecord[];
  listArtifacts(taskId: string): ArtifactRecord[];
  getPlannerSections(task: TaskRecord): Record<string, unknown>;
}

export class ContextPolicyFilter {
  filterPlannerSnapshot(
    snapshot: ContextSnapshot,
    policy: ContextVisibilityPolicy,
  ): ContextSnapshot {
    const allowedSectionKeys = new Set(policy.allowedSectionKeys);
    const allowedArtifactKinds = policy.allowedArtifactKinds
      ? new Set(policy.allowedArtifactKinds)
      : null;

    return {
      ...snapshot,
      artifacts: snapshot.artifacts.filter((artifact) =>
        allowedArtifactKinds ? allowedArtifactKinds.has(artifact.kind) : true,
      ),
      sections: Object.fromEntries(
        Object.entries(snapshot.sections).filter(([key]) =>
          allowedSectionKeys.has(key),
        ),
      ),
    };
  }
}

export class RollingTaskSummarizer {
  constructor(private readonly maxLength = 600) {}

  updateSummary(previousSummary: string, nextEvent: string): string {
    const normalizedPrevious = previousSummary.trim();
    const normalizedEvent = nextEvent.trim();
    const joined = normalizedPrevious
      ? `${normalizedPrevious}\n${normalizedEvent}`
      : normalizedEvent;
    if (joined.length <= this.maxLength) return joined;

    const clipped = joined.slice(joined.length - this.maxLength);
    const newlineIndex = clipped.indexOf('\n');
    return newlineIndex === -1 ? clipped : clipped.slice(newlineIndex + 1);
  }
}

export class StructuredContextAssembler implements ContextAssembler {
  constructor(
    private readonly repository: ContextRepository,
    private readonly policyFilter = new ContextPolicyFilter(),
  ) {}

  assemblePlannerContext(
    task: TaskRecord,
    policy?: ContextVisibilityPolicy,
  ): PlannerContextBundle {
    const snapshot: ContextSnapshot = {
      task,
      principal: this.repository.getPrincipal(task.principal_id),
      actionHistory: this.repository.listActions(task.id),
      artifacts: this.repository.listArtifacts(task.id),
      sections: this.repository.getPlannerSections(task),
    };
    const filtered = policy
      ? this.policyFilter.filterPlannerSnapshot(snapshot, policy)
      : snapshot;
    return {
      principal: filtered.principal,
      task: filtered.task,
      actionHistory: filtered.actionHistory,
      artifacts: filtered.artifacts,
      sections: filtered.sections,
    };
  }

  assembleExecutionContext(action: ActionRecord): ExecutionContextBundle {
    const task = this.repository.getTask(action.task_id);
    const artifacts = this.repository
      .listArtifacts(task.id)
      .filter((artifact) => artifact.kind !== 'secret');
    return {
      taskId: task.id,
      actionId: action.id,
      inputArtifactIds: artifacts.map((artifact) => artifact.id),
      metadataFiles: ['meta/task.json', 'meta/action.json'],
    };
  }
}
