export const principalTypes = ['controller', 'external', 'system'] as const;
export type PrincipalType = (typeof principalTypes)[number];

export const trustTiers = ['trusted', 'restricted'] as const;
export type TrustTier = (typeof trustTiers)[number];

export const runnerPools = ['trusted', 'restricted'] as const;
export type RunnerPool = (typeof runnerPools)[number];

export const actionStatuses = [
  'proposed',
  'approved',
  'queued',
  'executing',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'outcome_unknown',
] as const;
export type ActionStatus = (typeof actionStatuses)[number];

export type PrincipalStatus = 'active' | 'disabled';
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'not_required';
export type RunStatus =
  | 'queued'
  | 'executing'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'outcome_unknown';

export interface PrincipalRecord {
  id: string;
  type: PrincipalType;
  display_name: string;
  trust_tier: TrustTier;
  status: PrincipalStatus;
  created_at: string;
}

export interface IdentityRecord {
  id: string;
  principal_id: string;
  channel_type: string;
  external_id: string;
  external_handle?: string | null;
  verified: boolean;
}

export interface PrincipalGroupRecord {
  id: string;
  name: string;
  type: string;
  visibility: string;
}

export interface GroupMembershipRecord {
  principal_id: string;
  group_id: string;
  role: string;
}

export interface TaskRecord {
  id: string;
  principal_id: string;
  source_channel: string;
  source_thread_id?: string | null;
  status: string;
  summary: string;
  created_at: string;
  updated_at: string;
}

export interface ActionRecord {
  id: string;
  task_id: string;
  type: string;
  status: ActionStatus;
  runner_pool: RunnerPool;
  permission_profile: string;
  idempotency_key?: string | null;
  semantic_dedupe_key?: string | null;
  requested_by_principal_id: string;
  approved_by_principal_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: string;
  action_id: string;
  runner_pool: RunnerPool;
  status: RunStatus;
  attempt_no: number;
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  error_class?: string | null;
}

export interface ArtifactRecord {
  id: string;
  task_id: string;
  kind: string;
  path: string;
  media_type: string;
  sha256: string;
  size_bytes: number;
  created_by_run_id?: string | null;
}

export interface ApprovalRecord {
  id: string;
  action_id: string;
  required_from_principal_id: string;
  status: ApprovalStatus;
  reason: string;
}

export interface AuditLogRecord {
  id: string;
  principal_id?: string | null;
  task_id?: string | null;
  action_id?: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
}
