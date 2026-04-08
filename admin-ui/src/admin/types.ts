export type ContactStatus = 'trusted' | 'unknown' | 'abuse';
export type PersonalityScope = 'global' | 'main' | `group:${string}`;
export type SignalProvisionMode = 'link' | 'register';
export type AdminTab =
  | 'contacts'
  | 'personality'
  | 'policy'
  | 'connections'
  | 'tools'
  | 'skills'
  | 'approvals'
  | 'audit';

export interface SkillView {
  name: string;
  description: string;
}

export interface SkillDetailView extends SkillView {
  content: string;
}

export interface ContactView {
  identity: string;
  displayName: string;
  status: ContactStatus;
  messageCount: number;
  lastMessageTime: string;
  classificationSummary: string;
}

export interface ContactDetailView extends ContactView {
  history: Array<{
    id: string;
    chatJid: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
  }>;
}

export interface PersonalityProfile {
  scope: PersonalityScope;
  displayName: string;
  role: string;
  tone: string;
  communicationStyle: string;
  initiative: string;
  aboutAgent: string;
  aboutController: string;
  /** @deprecated Use aboutAgent + aboutController. */
  aboutMe?: string;
  customInstructions: string;
}

export interface ControlPolicy {
  pausedProviders: string[];
}

export interface VerifiedIdentity {
  identity: string;
  label: string;
}

export interface ControlSettings {
  controlSignalJid: string;
  assistantSignalIdentity: string;
}

export interface SignalProfileSettings {
  account: string;
  name: string;
  about: string;
  avatarDataUrl: string;
}

export interface ToastMessage {
  kind: 'success' | 'error';
  text: string;
}

export interface AuditRecord {
  id: string;
  actorIdentity: string;
  actionName: string;
  status: string;
  createdAt: string;
  payloadSummary: string;
}

export interface ToolRegistryItem {
  name: string;
  commandableAction: boolean;
  interactiveView?: boolean;
  previewable?: boolean;
  toolType?: string;
  iconKey?: string;
}

export interface SetupStatusResponse {
  env: {
    ASSISTANT_NAME: string;
    OPENAI_BASE_URL: string;
    OPENAI_MODEL: string;
    OPENAI_MAX_TOKENS: string;
    OPENAI_TEMPERATURE: string;
    SIGNAL_ACCOUNT: string;
    SIGNAL_RPC_URL: string;
    SIGNAL_RECEIVE_TIMEOUT_SEC: string;
    CONTROL_SIGNAL_JID: string;
    ONECLI_URL: string;
    GOOGLE_CLIENT_ID: string;
    ADMIN_BIND_HOST: string;
    ADMIN_PORT: string;
    INBOUND_GUARD_SCRIPT: string;
    OPENAI_API_KEY_SET: boolean;
    ADMIN_UI_TOKEN_SET: boolean;
  };
  checks: {
    openAIConfigured: boolean;
    signalConfigured: boolean;
    signalReachable: boolean;
    signalComposeConfigured: boolean;
    signalComposeRunning: boolean;
    onecliConfigured: boolean;
    onecliReachable: boolean;
    googleContactsAvailable: boolean;
    googleContactsSource: 'env' | 'onecli' | 'oauth' | 'none';
    controlChatConfigured: boolean;
    verifiedIdentityCount: number;
    assistantSignalConfigured: boolean;
    wizardComplete: boolean;
  };
  signalCompose: {
    account: string;
    localRpcUrl: string;
    composeFile: string;
    envFile: string;
    dataDir: string;
    configured: boolean;
    running: boolean;
    lastError: string;
  };
}

export interface SetupDraft {
  ASSISTANT_NAME: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  OPENAI_API_KEY: string;
  OPENAI_MAX_TOKENS: string;
  OPENAI_TEMPERATURE: string;
  SIGNAL_ACCOUNT: string;
  SIGNAL_RPC_URL: string;
  SIGNAL_RECEIVE_TIMEOUT_SEC: string;
  CONTROL_SIGNAL_JID: string;
  ONECLI_URL: string;
  ADMIN_BIND_HOST: string;
  ADMIN_PORT: string;
  ADMIN_UI_TOKEN: string;
  INBOUND_GUARD_SCRIPT: string;
  assistantSignalIdentity: string;
}

export interface PendingControlAction {
  id: string;
  actionName: string;
  summary: string;
  actorIdentity: string;
  source: 'ui' | 'signal_control' | 'agent';
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface ProviderAvailability {
  onecliConfigured: boolean;
  onecliReachable: boolean;
  googleContactsAvailable: boolean;
  googleContactsSource: 'env' | 'onecli' | 'oauth' | 'none';
  signalOutboundAvailable: boolean;
  smsOutboundAvailable: boolean;
  emailOutboundAvailable: boolean;
  contactResolutionAvailable: boolean;
}

export interface ResolvedContactTarget {
  channel: 'signal' | 'sms' | 'email';
  query: string;
  resolvedTarget: string;
  displayName: string;
  source: 'literal' | 'signal_history' | 'google_contacts';
  existingConversation: boolean;
}

export interface GoogleContactsSetup {
  origin: string;
  callbackUri: string;
  scopes: string[];
  configured: {
    clientId: boolean;
    clientSecret: boolean;
    accessToken: boolean;
  };
}

export interface GoogleOAuthStartResponse {
  url: string;
}

export interface AvailabilityWindow {
  days: number[];
  startTime: string;
  endTime: string;
}
