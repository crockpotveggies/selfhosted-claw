import type http from 'http';

import type { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Channel factory (re-export from channel registry for convenience)
// ---------------------------------------------------------------------------

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface CredentialRequirement {
  key: string;
  label: string;
  type: 'api_key' | 'oauth2' | 'bearer_token' | 'secret' | 'url';
  /** If set, auto-populates from this environment variable. */
  envVar?: string;
  required: boolean;
}

// ---------------------------------------------------------------------------
// Settings (JSON Schema driven)
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumLabels?: string[];
  minimum?: number;
  maximum?: number;
  items?: { type: string };
  format?: 'url' | 'email' | 'path' | 'cron' | 'textarea';
  sensitive?: boolean;
  dependsOn?: { field: string; value: unknown };
}

export interface IntegrationSettingsSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface IntegrationSettings {
  schema: IntegrationSettingsSchema;
  defaults: Record<string, unknown>;
  /** Allow per-group setting overrides. */
  perGroup?: boolean;
  /** Custom validation beyond JSON Schema. Return null if valid. */
  validate?: (
    values: Record<string, unknown>,
  ) => Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolContext {
  settings: Record<string, unknown>;
  sourceGroup: string;
  isMain: boolean;
  calendarAccess: boolean;
}

export interface IntegrationTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  controllerOnly?: boolean;
  rateLimit?: number;

  /**
   * Where the tool runs:
   * - 'host': execute runs host-side, reached by container via IPC
   * - 'container': code bundled into container (memory tools etc.)
   */
  location: 'host' | 'container';

  /** For host tools: called by the generic integration_tool IPC handler. */
  execute?: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Admin page
// ---------------------------------------------------------------------------

export interface IntegrationStatus {
  state: 'online' | 'offline' | 'degraded' | 'unconfigured';
  message: string;
  serviceRunning?: boolean;
}

export interface IntegrationAdminPage {
  icon: string;
  category: 'messaging' | 'productivity' | 'utility' | 'developer';
  getStatus: (ctx: IntegrationContext) => Promise<IntegrationStatus>;
}

// ---------------------------------------------------------------------------
// Docker service lifecycle
// ---------------------------------------------------------------------------

export interface ServiceHealthCheck {
  /** URL to probe (e.g., 'http://127.0.0.1:8080/v1/accounts'). */
  url: string;
  method?: 'GET' | 'POST';
  expectStatus?: number;
  /** Milliseconds between health checks. Default: 30000. */
  intervalMs?: number;
}

export interface RegistrationInput {
  account: string;
  rpcUrl: string;
  useVoice: boolean;
  captchaToken?: string;
}

export interface RegistrationResponse {
  message: string;
  captchaRequired?: boolean;
  captchaUrl?: string;
}

export interface IntegrationServiceSetup {
  fetchLinkQr?: (
    rpcUrl: string,
    deviceName: string,
  ) => Promise<string>;
  listAccounts?: (rpcUrl: string) => Promise<string[]>;
  startRegistration?: (
    input: RegistrationInput,
  ) => Promise<RegistrationResponse>;
  verifyRegistration?: (input: {
    account: string;
    rpcUrl: string;
    code: string;
  }) => Promise<RegistrationResponse>;
}

export interface IntegrationService {
  /** Path to docker-compose.yml relative to project root. */
  composeFile: string;
  /** Path to .env file for the compose service. */
  envFile?: string;
  /** Docker Compose service name (e.g., 'signal-cli'). */
  serviceName: string;

  /** Generate .env contents from settings. */
  buildEnv: (settings: Record<string, unknown>) => Record<string, string>;

  healthCheck: ServiceHealthCheck;

  /** Service-specific setup hooks (registration, QR linking, etc.). */
  setup?: IntegrationServiceSetup;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface IntegrationMemory {
  /** Max chars injected into system prompt for this integration. Default: 200. */
  contextChars: number;
  /** Only inject memories with these tags. */
  contextTags?: string[];
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------

export interface SetupStatus {
  completed: boolean;
  currentStep: number;
  steps: Array<{
    type: string;
    label: string;
    description?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    error?: string;
  }>;
}

export interface OAuthSetupStep {
  type: 'oauth2';
  label: string;
  provider: string;
  scopes: string[];
  helpUrl?: string;
  /** The callback path to register with the OAuth provider. */
  callbackPath: string;
  startAuth: (
    origin: string,
  ) => Promise<{ url: string; state: string }>;
  completeAuth: (params: {
    code: string;
    state: string;
    origin: string;
  }) => Promise<void>;
  isComplete: () => Promise<boolean>;
}

export interface CredentialInputStep {
  type: 'credential_input';
  label: string;
  description?: string;
  helpUrl?: string;
  fields: Array<{
    key: string;
    label: string;
    type: 'text' | 'password' | 'url' | 'email' | 'number';
    placeholder?: string;
    required?: boolean;
    pattern?: string;
    patternHelp?: string;
  }>;
  validate: (
    values: Record<string, string>,
  ) => Promise<{ valid: boolean; error?: string }>;
  save: (values: Record<string, string>) => Promise<void>;
  isComplete: () => Promise<boolean>;
}

export interface FormSetupStep {
  type: 'form';
  label: string;
  description?: string;
  schema: IntegrationSettingsSchema;
  defaults?: Record<string, unknown>;
  validate?: (
    values: Record<string, unknown>,
  ) => Promise<{ valid: boolean; errors?: Record<string, string> }>;
  save: (values: Record<string, unknown>) => Promise<void>;
  isComplete: () => Promise<boolean>;
}

export interface QrCodeSetupStep {
  type: 'qr_code';
  label: string;
  description?: string;
  inputFields?: Array<{
    key: string;
    label: string;
    type: 'text';
    placeholder?: string;
    required?: boolean;
  }>;
  generateQr: (
    input: Record<string, string>,
  ) => Promise<{ dataUrl: string; expiresIn?: number }>;
  pollComplete: () => Promise<{ done: boolean; message?: string }>;
  pollIntervalMs?: number;
  isComplete: () => Promise<boolean>;
}

export interface VerificationCodeSetupStep {
  type: 'verification_code';
  label: string;
  description?: string;
  inputFields?: Array<{
    key: string;
    label: string;
    type: 'text' | 'tel' | 'email';
    placeholder?: string;
    required?: boolean;
  }>;
  sendCode: (input: Record<string, string>) => Promise<{
    message: string;
    captchaRequired?: boolean;
    captchaUrl?: string;
  }>;
  verifyCode: (code: string) => Promise<{ message: string }>;
  isComplete: () => Promise<boolean>;
}

export interface WebhookUrlSetupStep {
  type: 'webhook_url';
  label: string;
  description?: string;
  getUrl: () => string;
  helpUrl?: string;
  validate: () => Promise<{ received: boolean; message?: string }>;
  isComplete: () => Promise<boolean>;
}

export interface CustomSetupStep {
  type: 'custom';
  label: string;
  description?: string;
  routes: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void>;
  }>;
  component?: string;
  isComplete: () => Promise<boolean>;
}

export type SetupStep =
  | OAuthSetupStep
  | CredentialInputStep
  | FormSetupStep
  | QrCodeSetupStep
  | VerificationCodeSetupStep
  | WebhookUrlSetupStep
  | CustomSetupStep;

export interface IntegrationSetupFlow {
  steps: SetupStep[];
  getStatus: () => Promise<SetupStatus>;
}

// ---------------------------------------------------------------------------
// Integration context (passed to lifecycle hooks and status checks)
// ---------------------------------------------------------------------------

export interface IntegrationContext {
  settings: Record<string, unknown>;
  groupSettings: (folder: string) => Record<string, unknown>;
  hasCredential: (key: string) => boolean;
}

// ---------------------------------------------------------------------------
// Top-level integration definition
// ---------------------------------------------------------------------------

export interface IntegrationDefinition {
  name: string;
  description: string;
  /** true = always on, cannot be disabled. */
  core: boolean;
  version: string;
  credentials: CredentialRequirement[];
  settings?: IntegrationSettings;
  adminPage?: IntegrationAdminPage;

  // Capabilities — provide any combination
  channel?: ChannelFactory;
  tools?: IntegrationTool[];
  /** Skill content injected into agent system prompt. */
  skills?: string[];

  // Infrastructure
  service?: IntegrationService;
  memory?: IntegrationMemory;
  setup?: IntegrationSetupFlow;

  lifecycle?: {
    onEnable?: (ctx: IntegrationContext) => Promise<void>;
    onDisable?: () => Promise<void>;
    onSettingsChange?: (
      prev: Record<string, unknown>,
      next: Record<string, unknown>,
    ) => Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Service health state (used by health monitor)
// ---------------------------------------------------------------------------

export interface ServiceHealthState {
  consecutiveFailures: number;
  lastRestartAttempt: number;
  backoffMs: number;
  circuitOpen: boolean;
}

// ---------------------------------------------------------------------------
// Log settings
// ---------------------------------------------------------------------------

export interface LogSettings {
  retentionDays: number;
  maxSizeMb: number;
  pruneIntervalMinutes: number;
  /** Minimum level written to SQLite. Console is unaffected. */
  minLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  retentionDays: 30,
  maxSizeMb: 200,
  pruneIntervalMinutes: 60,
  minLevel: 'info',
};
