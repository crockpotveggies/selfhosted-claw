export type ControlActorSource = 'ui' | 'signal_control';

export type ContactStatus = 'trusted' | 'unknown' | 'abuse';

export type ContactTrustSource =
  | 'manual'
  | 'signal_command'
  | 'classification'
  | 'imported'
  | 'system';

export interface ContactClassificationEntry {
  id: string;
  label: ContactStatus;
  summary: string;
  reasons: string[];
  createdAt: string;
  actorIdentity: string;
  source: ControlActorSource | 'system';
}

export interface ControlContact {
  id: string;
  identity: string;
  displayName: string;
  status: ContactStatus;
  trustSource: ContactTrustSource;
  notes: string;
  manualOverride: boolean;
  classificationSummary: string;
  classificationHistory: ContactClassificationEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface VerifiedIdentity {
  identity: string;
  label: string;
  addedAt: string;
}

export type PersonalityScope = 'global' | 'main' | `group:${string}`;

export interface PersonalityProfile {
  scope: PersonalityScope;
  displayName: string;
  role: string;
  tone: string;
  communicationStyle: string;
  initiative: string;
  customInstructions: string;
  updatedAt: string;
}

export interface ControlPolicy {
  pausedProviders: string[];
  updatedAt: string;
}

export interface ControlSettings {
  controlSignalJid: string;
  assistantSignalIdentity: string;
  updatedAt: string;
}

export interface PendingControlAction {
  id: string;
  actionName: string;
  input: unknown;
  summary: string;
  actorIdentity: string;
  source: ControlActorSource;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface ControlAuditRecord {
  id: string;
  actorIdentity: string;
  source: ControlActorSource;
  actionName: string;
  payloadSummary: string;
  beforeState: string;
  afterState: string;
  status: 'success' | 'rejected' | 'error' | 'pending';
  createdAt: string;
}

export interface ControlActionContext {
  actorIdentity: string;
  source: ControlActorSource;
}

export interface ControlActionDefinition<TInput, TResult> {
  name: string;
  requiredTrust: 'owner_verified';
  commandableAction: boolean;
  interactiveView?: boolean;
  previewable?: boolean;
  summarizeInput: (input: TInput) => string;
  execute: (
    input: TInput,
    context: ControlActionContext,
  ) => Promise<{
    result: TResult;
    beforeState: string;
    afterState: string;
  }>;
}
