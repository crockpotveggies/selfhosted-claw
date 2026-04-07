export type ControlActorSource = 'ui' | 'signal_control' | 'agent';

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
  /** Biographical facts about the controller that the agent can reference in
   *  conversations (e.g. location, job, hobbies). */
  aboutMe: string;
  customInstructions: string;
  updatedAt: string;
}

/** A recurring weekly time window (e.g. "Mon–Fri 9am–5pm"). */
export interface AvailabilityWindow {
  /** Days of the week (0=Sun … 6=Sat). */
  days: number[];
  /** Start time in HH:MM 24h format (e.g. "09:00"). */
  startTime: string;
  /** End time in HH:MM 24h format (e.g. "17:00"). */
  endTime: string;
}

export interface CalendarAvailabilitySettings {
  /** IANA timezone (e.g. "America/New_York"). */
  timezone: string;
  /** Weekly availability windows. Events should only be scheduled within these. */
  windows: AvailabilityWindow[];
  /** Free-text notes the agent should consider (e.g. "No meetings before 10am on Mondays"). */
  notes: string;
  updatedAt: string;
}

export interface ControlPolicy {
  pausedProviders: string[];
  calendarAvailability?: CalendarAvailabilitySettings;
  updatedAt: string;
}

export interface ControlSettings {
  controlSignalJid: string;
  assistantSignalIdentity: string;
  updatedAt: string;
}

export interface SignalProfileSettings {
  account: string;
  name: string;
  about: string;
  avatarDataUrl: string;
  updatedAt: string;
}

export interface GoogleContactsOAuthState {
  accessToken: string;
  refreshToken: string;
  expiryDate: string;
  scope: string;
  tokenType: string;
  connectedAt: string;
  oauthState: string;
  oauthStateCreatedAt: string;
}

export interface PendingControlAction {
  id: string;
  actionName: string;
  input: unknown;
  summary: string;
  actorIdentity: string;
  source: ControlActorSource;
  chatJid?: string;
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
  toolType?: string;
  iconKey?: string;
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

export interface ControlToolDefinitionSummary {
  name: string;
  commandableAction: boolean;
  interactiveView?: boolean;
  previewable?: boolean;
  toolType?: string;
  iconKey?: string;
}
