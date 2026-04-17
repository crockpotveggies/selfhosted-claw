import type { ActionStatus, RunnerPool } from '../core/state/types.js';

export interface ProposedAction {
  type: string;
  skill: string;
  reason: string;
  inputs: Record<string, unknown>;
}

export interface ProtocolActionRecord {
  action_id: string;
  task_id: string;
  principal_id: string;
  runner_pool: RunnerPool;
  permission_profile: string;
  status: ActionStatus;
  idempotency_key: string;
}

export interface RunSpec {
  run_id: string;
  action_id: string;
  runner_pool: RunnerPool;
  template: string;
  template_args: Record<string, unknown>;
  workspace: {
    input_artifact_ids: string[];
    expected_outputs: string[];
    metadata: Record<string, string>;
  };
  env: Record<string, string>;
  capabilities: string[];
  limits: {
    timeout_ms: number;
    max_output_bytes: number;
  };
}

export interface RunResult {
  run_id: string;
  status:
    | 'succeeded'
    | 'failed_retryable'
    | 'failed_terminal'
    | 'outcome_unknown';
  exit_code: number | null;
  artifacts: Array<{
    artifact_id: string;
    path: string;
    media_type: string;
  }>;
  stdout_tail: string;
  stderr_tail: string;
}
