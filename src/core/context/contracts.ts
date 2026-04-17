import type {
  ActionRecord,
  ArtifactRecord,
  PrincipalRecord,
  TaskRecord,
} from '../state/types.js';

export interface PlannerContextBundle {
  principal: PrincipalRecord;
  task: TaskRecord;
  actionHistory: ActionRecord[];
  artifacts: ArtifactRecord[];
  sections: Record<string, unknown>;
}

export interface ExecutionContextBundle {
  taskId: string;
  actionId: string;
  inputArtifactIds: string[];
  metadataFiles: string[];
}

export interface ContextVisibilityPolicy {
  allowedSectionKeys: string[];
  allowedArtifactKinds?: string[];
}

export interface ContextAssembler {
  assemblePlannerContext(
    task: TaskRecord,
    policy?: ContextVisibilityPolicy,
  ): PlannerContextBundle;
  assembleExecutionContext(action: ActionRecord): ExecutionContextBundle;
}
