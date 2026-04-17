import { actionStatuses, runnerPools } from '../core/state/types.js';
import type {
  ProposedAction,
  ProtocolActionRecord,
  RunResult,
  RunSpec,
} from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${field}: expected non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field}: expected string`);
  }
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid ${field}: expected string[]`);
  }
  return value;
}

function readStringRecord(
  value: unknown,
  field: string,
): Record<string, string> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid ${field}: expected object`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`Invalid ${field}.${key}: expected string`);
    }
    result[key] = entry;
  }
  return result;
}

function assertRunnerPool(
  value: unknown,
): asserts value is RunSpec['runner_pool'] {
  if (typeof value !== 'string' || !runnerPools.includes(value as never)) {
    throw new Error('Invalid runner_pool');
  }
}

export function parseProposedAction(input: unknown): ProposedAction {
  if (!isPlainObject(input)) throw new Error('Invalid ProposedAction');
  if (!isPlainObject(input.inputs)) {
    throw new Error('Invalid inputs: expected object');
  }
  return {
    type: readString(input.type, 'type'),
    skill: readString(input.skill, 'skill'),
    reason: readString(input.reason, 'reason'),
    inputs: input.inputs,
  };
}

export function parseActionRecord(input: unknown): ProtocolActionRecord {
  if (!isPlainObject(input)) throw new Error('Invalid ActionRecord');
  assertRunnerPool(input.runner_pool);
  const status = readString(
    input.status,
    'status',
  ) as ProtocolActionRecord['status'];
  if (!actionStatuses.includes(status as never)) {
    throw new Error('Invalid status');
  }
  return {
    action_id: readString(input.action_id, 'action_id'),
    task_id: readString(input.task_id, 'task_id'),
    principal_id: readString(input.principal_id, 'principal_id'),
    runner_pool: input.runner_pool,
    permission_profile: readString(
      input.permission_profile,
      'permission_profile',
    ),
    status,
    idempotency_key: readString(input.idempotency_key, 'idempotency_key'),
  };
}

export function parseRunSpec(
  input: unknown,
  options?: { knownTemplates?: string[] },
): RunSpec {
  if (!isPlainObject(input)) throw new Error('Invalid RunSpec');
  assertRunnerPool(input.runner_pool);
  if (!isPlainObject(input.template_args)) {
    throw new Error('Invalid template_args: expected object');
  }
  if (!isPlainObject(input.workspace)) {
    throw new Error('Invalid workspace');
  }
  if (!isPlainObject(input.limits)) {
    throw new Error('Invalid limits');
  }

  const template = readString(input.template, 'template');
  if (options?.knownTemplates && !options.knownTemplates.includes(template)) {
    throw new Error(`Unknown template: ${template}`);
  }

  const timeoutMs = input.limits.timeout_ms;
  const maxOutputBytes = input.limits.max_output_bytes;
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    throw new Error('Invalid limits.timeout_ms');
  }
  if (typeof maxOutputBytes !== 'number' || maxOutputBytes <= 0) {
    throw new Error('Invalid limits.max_output_bytes');
  }

  return {
    run_id: readString(input.run_id, 'run_id'),
    action_id: readString(input.action_id, 'action_id'),
    runner_pool: input.runner_pool,
    template,
    template_args: input.template_args,
    workspace: {
      input_artifact_ids: readStringArray(
        input.workspace.input_artifact_ids,
        'workspace.input_artifact_ids',
      ),
      expected_outputs: readStringArray(
        input.workspace.expected_outputs,
        'workspace.expected_outputs',
      ),
      metadata: readStringRecord(
        input.workspace.metadata,
        'workspace.metadata',
      ),
    },
    env: readStringRecord(input.env, 'env'),
    capabilities: readStringArray(input.capabilities, 'capabilities'),
    limits: {
      timeout_ms: timeoutMs,
      max_output_bytes: maxOutputBytes,
    },
  };
}

export function parseRunResult(input: unknown): RunResult {
  if (!isPlainObject(input)) throw new Error('Invalid RunResult');
  const status = readString(input.status, 'status') as RunResult['status'];
  if (
    ![
      'succeeded',
      'failed_retryable',
      'failed_terminal',
      'outcome_unknown',
    ].includes(status)
  ) {
    throw new Error('Invalid RunResult.status');
  }
  if (
    !Array.isArray(input.artifacts) ||
    input.artifacts.some(
      (artifact) =>
        !isPlainObject(artifact) ||
        typeof artifact.artifact_id !== 'string' ||
        typeof artifact.path !== 'string' ||
        typeof artifact.media_type !== 'string',
    )
  ) {
    throw new Error('Invalid artifacts');
  }

  return {
    run_id: readString(input.run_id, 'run_id'),
    status,
    exit_code:
      typeof input.exit_code === 'number' || input.exit_code === null
        ? input.exit_code
        : (() => {
            throw new Error('Invalid exit_code');
          })(),
    artifacts: input.artifacts as RunResult['artifacts'],
    stdout_tail: readOptionalString(input.stdout_tail ?? '', 'stdout_tail'),
    stderr_tail: readOptionalString(input.stderr_tail ?? '', 'stderr_tail'),
  };
}
