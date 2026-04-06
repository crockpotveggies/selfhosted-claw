import { randomBytes } from 'crypto';

import { OneCLI } from '@onecli-sh/sdk';

import { readEnvFile, setEnvFileValues } from './env.js';
import {
  CONTROL_SIGNAL_JID,
  SIGNAL_ACCOUNT,
  SIGNAL_RPC_URL,
} from './config.js';
import {
  ContactActivitySummary,
  getIncomingContactSummaries,
  getMessagesBySender,
} from './db.js';
import {
  ProviderAvailability,
  ResolvedContactTarget,
  resolveLiteralTarget,
  searchGoogleContacts,
} from './contact-resolution.js';
import { canonicalizeIdentity, displayIdentity } from './control-identities.js';
import {
  previewPersonalityProfile,
  resolveProfile,
  writePersonalityProfile,
} from './control-personality.js';
import { ControlStore } from './control-store.js';
import {
  ContactClassificationEntry,
  ContactStatus,
  ControlActionContext,
  ControlActionDefinition,
  ControlAuditRecord,
  ControlContact,
  ControlPolicy,
  ControlSettings,
  GoogleContactsOAuthState,
  PendingControlAction,
  PersonalityProfile,
  PersonalityScope,
  SignalProfileSettings,
  VerifiedIdentity,
} from './control-types.js';
import { SignalComposeManager, SignalComposeStatus } from './signal-compose.js';
import { resolveSignalTarget } from './outbound-directives.js';

interface ContactMutationInput {
  identity: string;
  note?: string;
}

interface VerifiedIdentityInput {
  identity: string;
  label?: string;
}

interface PersonalityUpsertInput {
  scope: PersonalityScope;
  displayName: string;
  role: string;
  tone: string;
  communicationStyle: string;
  initiative: string;
  customInstructions: string;
}

interface PersonalityFieldInput {
  scope: PersonalityScope;
  field:
    | 'displayName'
    | 'role'
    | 'tone'
    | 'communicationStyle'
    | 'initiative'
    | 'customInstructions';
  value: string;
}

interface PersonalityAppendInput {
  scope: PersonalityScope;
  text: string;
}

interface PolicyProviderInput {
  provider: string;
}

interface SettingsInput {
  controlSignalJid?: string;
  assistantSignalIdentity?: string;
}

interface EnvUpdateInput {
  values: Record<string, string>;
}

interface SignalComposeUpInput {
  account?: string;
  rpcUrl?: string;
}

interface SignalProfileInput {
  account?: string;
  name?: string;
  about?: string;
  avatarDataUrl?: string;
}

export interface OutboundSendInput {
  channel: 'signal' | 'sms' | 'email';
  target: string;
  message: string;
  requiresConfirmation: boolean;
  confirmationReason?: string;
  resolvedSignalJid?: string;
  resolvedTarget?: string;
  resolvedDisplayName?: string;
  resolutionSource?: string;
}

export interface OutboundCreateGroupInput {
  channel: 'signal';
  title?: string;
  message: string;
  members: string[];
  resolvedMemberTargets: string[];
  resolvedMemberDisplayNames: string[];
}

export interface OutboundDeleteInput {
  channel: 'signal' | 'sms' | 'email' | 'calendar';
  target: string;
  reason: string;
}

export interface OutboundUpdateGroupInput {
  channel: 'signal';
  groupName: string;
  groupId: string;
  action: 'add_member' | 'remove_member' | 'rename';
  resolvedMemberTargets: string[];
  resolvedMemberDisplayNames: string[];
  newName?: string;
}

interface OutboundHandlers {
  sendSignalMessage?: (jid: string, text: string) => Promise<void>;
  createSignalGroup?: (input: {
    title?: string;
    members: string[];
    message?: string;
  }) => Promise<{ jid: string; title: string }>;
  updateSignalGroup?: (input: OutboundUpdateGroupInput) => Promise<void>;
  deleteResource?: (input: OutboundDeleteInput) => Promise<string>;
}

export type ApprovalReplyDecision = 'approve' | 'reject' | 'revise' | 'unclear';

interface ApprovalReplyClassification {
  decision: ApprovalReplyDecision;
  reason?: string;
}

type ApprovalReplyClassifier = (input: {
  reply: string;
  pendingSummary: string;
}) => Promise<ApprovalReplyClassification>;

const GOOGLE_CONTACT_TOKEN_KEYS = [
  'GOOGLE_CONTACTS_ACCESS_TOKEN',
  'GOOGLE_PEOPLE_ACCESS_TOKEN',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GMAIL_ACCESS_TOKEN',
] as const;
const GOOGLE_CONTACTS_SCOPE =
  'https://www.googleapis.com/auth/contacts.readonly';

function resolveSignalHistoryTarget(query: string): ResolvedContactTarget {
  const resolved = resolveSignalTarget(query);
  return {
    channel: 'signal',
    query,
    resolvedTarget: resolved.jid,
    displayName: query,
    source: 'signal_history',
    existingConversation: resolved.existingConversation,
  };
}

interface ActionResultEnvelope<TResult> {
  result: TResult;
  beforeState: string;
  afterState: string;
}

export interface ContactView extends ControlContact {
  messageCount: number;
  lastMessageTime: string;
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

function nowIso(): string {
  return new Date().toISOString();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function normalizeSignalAvatar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^data:[^;]+;base64,(.+)$/i);
  return match ? match[1] : trimmed;
}

function summarizeStatus(status: ContactStatus, reasons: string[]): string {
  if (status === 'abuse') {
    return reasons.length
      ? `Classified as abuse: ${reasons.join('; ')}`
      : 'Classified as abuse.';
  }
  if (status === 'trusted') {
    return reasons.length
      ? `Marked trusted: ${reasons.join('; ')}`
      : 'Marked trusted.';
  }
  return reasons.length
    ? `Reset to unknown: ${reasons.join('; ')}`
    : 'Reset to unknown.';
}

function parseNaturalApprovalDecision(
  text: string,
): ApprovalReplyDecision | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 160) return null;

  const cleaned = normalized.replace(/[.!]/g, '').trim();
  const hasQuestion = normalized.includes('?');
  if (hasQuestion) return null;

  const rejectPatterns = [
    /\b(no|nope|nah)\b/,
    /\bcancel( it| that)?\b/,
    /\breject\b/,
    /\bdo not\b/,
    /\bdon't\b/,
    /\bdont\b/,
    /\bnot now\b/,
    /\bnever mind\b/,
    /\bhold off\b/,
    /\bskip it\b/,
    /\bplease stop\b/,
  ];
  if (rejectPatterns.some((pattern) => pattern.test(cleaned))) {
    return 'reject';
  }

  const approvePatterns = [
    /\b(yes|yep|yeah|yup)\b/,
    /\bok(ay)?\b/,
    /\bsure\b/,
    /\bgo ahead\b/,
    /\bdo it\b/,
    /\bsend it\b/,
    /\bapprove(d)?\b/,
    /\bsounds good\b/,
    /\bplease do\b/,
    /\blooks good\b/,
    /\bthat works\b/,
    /\blets do it\b/,
    /\blet's do it\b/,
    /\bi'm good with that\b/,
    /\bi am good with that\b/,
    /\bthat is fine\b/,
    /\bthats fine\b/,
  ];
  if (approvePatterns.some((pattern) => pattern.test(cleaned))) {
    return 'approve';
  }

  return null;
}

function buildClassificationEntry(
  label: ContactStatus,
  actorIdentity: string,
  source: ControlActionContext['source'] | 'system',
  reasons: string[],
): ContactClassificationEntry {
  return {
    id: `classification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    summary: summarizeStatus(label, reasons),
    reasons,
    createdAt: nowIso(),
    actorIdentity,
    source,
  };
}

function defaultContact(
  identity: string,
  displayName?: string,
): ControlContact {
  const now = nowIso();
  return {
    id: identity,
    identity,
    displayName: displayName || displayIdentity(identity),
    status: 'unknown',
    trustSource: 'system',
    notes: '',
    manualOverride: false,
    classificationSummary: '',
    classificationHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeScope(scope: string): PersonalityScope {
  if (scope === 'global' || scope === 'main') return scope;
  if (scope.startsWith('group:')) return scope as PersonalityScope;
  return `group:${scope}`;
}

function classifyMessages(messages: Array<{ content: string }>): {
  label: ContactStatus;
  reasons: string[];
} {
  if (messages.length === 0) {
    return { label: 'unknown', reasons: ['No message history available'] };
  }

  const combined = messages
    .map((message) => message.content.toLowerCase())
    .join('\n');
  const reasons: string[] = [];

  const suspiciousPatterns = [
    /gift card/,
    /wire transfer/,
    /bitcoin|crypto/,
    /verify (your )?(account|wallet|identity)/,
    /urgent action required/,
    /password reset/,
    /click (here|this link)/,
  ];
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(combined)) reasons.push(`Matched ${pattern}`);
  }

  const linkMatches = combined.match(/https?:\/\//g) || [];
  if (linkMatches.length >= 2) reasons.push('Contains multiple links');

  const repeated =
    new Set(messages.map((message) => message.content.trim())).size <=
    Math.max(1, Math.floor(messages.length / 2));
  if (messages.length >= 3 && repeated) {
    reasons.push('Repeated message content');
  }

  if (reasons.length > 0) {
    return { label: 'abuse', reasons };
  }
  return { label: 'unknown', reasons: ['No strong abuse indicators found'] };
}

export class ControlActionService {
  private readonly definitions = new Map<
    string,
    ControlActionDefinition<any, any>
  >();
  private outboundHandlers: OutboundHandlers = {};
  private approvalReplyClassifier?: ApprovalReplyClassifier;

  constructor(
    private readonly store: ControlStore = new ControlStore(),
    private readonly signalCompose: SignalComposeManager = new SignalComposeManager(),
  ) {
    this.registerDefinitions();
  }

  private registerDefinitions(): void {
    this.register<ContactMutationInput, ContactView>({
      name: 'contact.trust',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) =>
        `Trust contact ${canonicalizeIdentity(input.identity)}`,
      execute: async (input, context) => {
        const next = this.upsertContactStatus(
          input.identity,
          'trusted',
          context,
          input.note ? [input.note] : ['Manually trusted'],
          'manual',
          true,
        );
        return {
          result: this.getContact(next.identity)!,
          beforeState: next.beforeState,
          afterState: next.afterState,
        };
      },
    });

    this.register<ContactMutationInput, ContactView>({
      name: 'contact.abuse',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) =>
        `Mark contact ${canonicalizeIdentity(input.identity)} as abuse`,
      execute: async (input, context) => {
        const next = this.upsertContactStatus(
          input.identity,
          'abuse',
          context,
          input.note ? [input.note] : ['Manually marked as abuse'],
          'manual',
          true,
        );
        return {
          result: this.getContact(next.identity)!,
          beforeState: next.beforeState,
          afterState: next.afterState,
        };
      },
    });

    this.register<ContactMutationInput, ContactView>({
      name: 'contact.reset',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) =>
        `Reset contact ${canonicalizeIdentity(input.identity)} to unknown`,
      execute: async (input, context) => {
        const next = this.upsertContactStatus(
          input.identity,
          'unknown',
          context,
          input.note ? [input.note] : ['Manually reset to unknown'],
          'manual',
          true,
        );
        return {
          result: this.getContact(next.identity)!,
          beforeState: next.beforeState,
          afterState: next.afterState,
        };
      },
    });

    this.register<ContactMutationInput, ContactDetailView>({
      name: 'contact.reclassify',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) =>
        `Reclassify contact ${canonicalizeIdentity(input.identity)}`,
      execute: async (input, context) => {
        const identity = canonicalizeIdentity(input.identity);
        const contact = this.loadContactRecord(identity);
        const messages = this.loadMessagesForIdentity(identity);
        const classification = classifyMessages(messages);
        const contacts = this.store.getContacts();
        const nextRecord = {
          ...contact,
          status: classification.label,
          trustSource:
            classification.label === 'abuse'
              ? 'classification'
              : contact.trustSource,
          classificationSummary: summarizeStatus(
            classification.label,
            classification.reasons,
          ),
          classificationHistory: [
            buildClassificationEntry(
              classification.label,
              context.actorIdentity,
              context.source,
              classification.reasons,
            ),
            ...contact.classificationHistory,
          ],
          manualOverride: false,
          updatedAt: nowIso(),
        };
        const beforeState = stableStringify(contact);
        contacts[identity] = nextRecord;
        this.store.saveContacts(contacts);
        return {
          result: this.getContact(identity)!,
          beforeState,
          afterState: stableStringify(nextRecord),
        };
      },
    });

    this.register<VerifiedIdentityInput, VerifiedIdentity[]>({
      name: 'verified.add',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) =>
        `Add verified identity ${canonicalizeIdentity(input.identity)}`,
      execute: async (input) => {
        const before = this.store.getVerifiedIdentities();
        const identity = canonicalizeIdentity(input.identity);
        const existing = before.find((item) => item.identity === identity);
        const next = existing
          ? before.map((item) =>
              item.identity === identity
                ? { ...item, label: input.label || item.label }
                : item,
            )
          : [
              {
                identity,
                label: input.label || displayIdentity(identity),
                addedAt: nowIso(),
              },
              ...before,
            ];
        this.store.saveVerifiedIdentities(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<VerifiedIdentityInput, VerifiedIdentity[]>({
      name: 'verified.remove',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) =>
        `Remove verified identity ${canonicalizeIdentity(input.identity)}`,
      execute: async (input) => {
        const before = this.store.getVerifiedIdentities();
        const identity = canonicalizeIdentity(input.identity);
        const next = before.filter((item) => item.identity !== identity);
        this.store.saveVerifiedIdentities(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<PersonalityUpsertInput, PersonalityProfile>({
      name: 'personality.upsert',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) => `Update personality profile ${input.scope}`,
      execute: async (input) => {
        const profiles = this.store.getPersonalityProfiles();
        const scope = normalizeScope(input.scope);
        const before = profiles[scope] || resolveProfile(scope, profiles);
        const next: PersonalityProfile = {
          ...before,
          ...input,
          scope,
          updatedAt: nowIso(),
        };
        profiles[scope] = next;
        this.store.savePersonalityProfiles(profiles);
        writePersonalityProfile(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<PersonalityFieldInput, PersonalityProfile>({
      name: 'personality.setField',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      previewable: true,
      summarizeInput: (input) =>
        `Set personality field ${input.field} on ${input.scope}`,
      execute: async (input) => {
        const profiles = this.store.getPersonalityProfiles();
        const scope = normalizeScope(input.scope);
        const before = profiles[scope] || resolveProfile(scope, profiles);
        const next: PersonalityProfile = {
          ...before,
          [input.field]: input.value,
          updatedAt: nowIso(),
        };
        profiles[scope] = next;
        this.store.savePersonalityProfiles(profiles);
        writePersonalityProfile(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<PersonalityAppendInput, PersonalityProfile>({
      name: 'personality.appendInstructions',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      previewable: true,
      summarizeInput: (input) =>
        `Append custom personality instructions on ${input.scope}`,
      execute: async (input) => {
        const profiles = this.store.getPersonalityProfiles();
        const scope = normalizeScope(input.scope);
        const before = profiles[scope] || resolveProfile(scope, profiles);
        const next: PersonalityProfile = {
          ...before,
          customInstructions: [before.customInstructions, input.text]
            .filter(Boolean)
            .join('\n\n')
            .trim(),
          updatedAt: nowIso(),
        };
        profiles[scope] = next;
        this.store.savePersonalityProfiles(profiles);
        writePersonalityProfile(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<{ scope: PersonalityScope }, PersonalityProfile>({
      name: 'personality.reset',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      previewable: true,
      summarizeInput: (input) => `Reset personality scope ${input.scope}`,
      execute: async (input) => {
        const profiles = this.store.getPersonalityProfiles();
        const scope = normalizeScope(input.scope);
        const before = profiles[scope] || resolveProfile(scope, profiles);
        delete profiles[scope];
        this.store.savePersonalityProfiles(profiles);
        const next = resolveProfile(scope, profiles);
        writePersonalityProfile(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<PolicyProviderInput, ControlPolicy>({
      name: 'policy.pauseProvider',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) => `Pause outbound provider ${input.provider}`,
      execute: async (input) => {
        const before = this.getPolicy();
        const provider = input.provider.toLowerCase();
        const next: ControlPolicy = {
          pausedProviders: [...new Set([...before.pausedProviders, provider])],
          updatedAt: nowIso(),
        };
        this.store.savePolicy(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<PolicyProviderInput, ControlPolicy>({
      name: 'policy.resumeProvider',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: (input) => `Resume outbound provider ${input.provider}`,
      execute: async (input) => {
        const before = this.getPolicy();
        const provider = input.provider.toLowerCase();
        const next: ControlPolicy = {
          pausedProviders: before.pausedProviders.filter(
            (item) => item !== provider,
          ),
          updatedAt: nowIso(),
        };
        this.store.savePolicy(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<SettingsInput, ControlSettings>({
      name: 'settings.update',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      previewable: true,
      summarizeInput: () => 'Update control settings',
      execute: async (input) => {
        const before = this.getSettings();
        const next: ControlSettings = {
          controlSignalJid:
            input.controlSignalJid !== undefined
              ? input.controlSignalJid
              : before.controlSignalJid,
          assistantSignalIdentity:
            input.assistantSignalIdentity !== undefined
              ? input.assistantSignalIdentity
              : before.assistantSignalIdentity,
          updatedAt: nowIso(),
        };
        this.store.saveSettings(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<EnvUpdateInput, { updatedKeys: string[] }>({
      name: 'settings.updateEnv',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      previewable: true,
      summarizeInput: (input) =>
        `Update environment keys ${Object.keys(input.values).join(', ')}`,
      execute: async (input) => {
        const allowedKeys = new Set([
          'ASSISTANT_NAME',
          'OPENAI_BASE_URL',
          'OPENAI_API_KEY',
          'OPENAI_MODEL',
          'OPENAI_MAX_TOKENS',
          'OPENAI_TEMPERATURE',
          'OPENAI_CONTEXT_WINDOW',
          'SIGNAL_ACCOUNT',
          'SIGNAL_RPC_URL',
          'SIGNAL_RECEIVE_TIMEOUT_SEC',
          'CONTROL_SIGNAL_JID',
          'ONECLI_URL',
          'GOOGLE_CLIENT_ID',
          'GOOGLE_CLIENT_SECRET',
          'GOOGLE_CONTACTS_ACCESS_TOKEN',
          'ADMIN_BIND_HOST',
          'ADMIN_PORT',
          'ADMIN_UI_TOKEN',
          'INBOUND_GUARD_SCRIPT',
        ]);
        const filtered = Object.fromEntries(
          Object.entries(input.values).filter(([key]) => allowedKeys.has(key)),
        );
        if (Object.keys(filtered).length === 0) {
          throw new Error('No allowed environment keys provided');
        }
        const before = this.getSetupEnvironment();
        setEnvFileValues(filtered);
        const after = this.getSetupEnvironment();
        return {
          result: { updatedKeys: Object.keys(filtered) },
          beforeState: stableStringify(this.redactEnvSnapshot(before)),
          afterState: stableStringify(this.redactEnvSnapshot(after)),
        };
      },
    });

    this.register<SignalComposeUpInput, SignalComposeStatus>({
      name: 'signal.composeUp',
      requiredTrust: 'owner_verified',
      commandableAction: true,
      summarizeInput: () => 'Start managed Signal bridge container',
      execute: async (input) => {
        const before = this.getSignalComposeStatus();
        const env = this.getSetupEnvironment();
        const account = input.account || env.SIGNAL_ACCOUNT || SIGNAL_ACCOUNT;
        const rpcUrl = input.rpcUrl || env.SIGNAL_RPC_URL || SIGNAL_RPC_URL;
        const next = this.signalCompose.start({ account, rpcUrl });
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<SignalProfileInput, SignalProfileSettings>({
      name: 'signal.profile.update',
      requiredTrust: 'owner_verified',
      commandableAction: false,
      previewable: true,
      summarizeInput: () => 'Update Signal profile',
      execute: async (input) => {
        const before = this.getSignalProfile();
        const env = this.getSetupEnvironment();
        const account =
          input.account ||
          before.account ||
          env.SIGNAL_ACCOUNT ||
          SIGNAL_ACCOUNT;
        const rpcUrl = env.SIGNAL_RPC_URL || SIGNAL_RPC_URL;

        if (!account) {
          throw new Error(
            'SIGNAL_ACCOUNT is required before updating the profile',
          );
        }

        const response = await this.fetchSignal(
          `/v1/profiles/${encodeURIComponent(account)}`,
          rpcUrl,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: input.name ?? before.name ?? '',
              about: input.about ?? before.about ?? '',
              ...(input.avatarDataUrl !== undefined
                ? {
                    base64_avatar: input.avatarDataUrl
                      ? normalizeSignalAvatar(input.avatarDataUrl)
                      : '',
                  }
                : before.avatarDataUrl
                  ? {
                      base64_avatar: normalizeSignalAvatar(
                        before.avatarDataUrl,
                      ),
                    }
                  : {}),
            }),
          },
          'update profile',
        );
        if (response.status !== 204) {
          throw new Error(
            `Signal profile update failed with ${response.status}`,
          );
        }

        const next: SignalProfileSettings = {
          account,
          name: input.name ?? before.name ?? '',
          about: input.about ?? before.about ?? '',
          avatarDataUrl:
            input.avatarDataUrl !== undefined
              ? input.avatarDataUrl
              : before.avatarDataUrl,
          updatedAt: nowIso(),
        };
        this.store.saveSignalProfile(next);
        return {
          result: next,
          beforeState: stableStringify(before),
          afterState: stableStringify(next),
        };
      },
    });

    this.register<OutboundSendInput, { status: string }>({
      name: 'outbound.send',
      requiredTrust: 'owner_verified',
      commandableAction: false,
      previewable: true,
      summarizeInput: (input) =>
        input.requiresConfirmation
          ? `Start a new ${input.channel} conversation with ${input.resolvedDisplayName || input.target}`
          : `Send ${input.channel} message to ${input.resolvedDisplayName || input.target}`,
      execute: async (input) => {
        const beforeState = stableStringify({
          status: 'pending',
          channel: input.channel,
          target: input.resolvedTarget || input.target,
        });
        if (input.channel === 'signal') {
          if (!input.resolvedSignalJid) {
            throw new Error('Signal target could not be resolved for approval');
          }
          if (!this.outboundHandlers.sendSignalMessage) {
            throw new Error('Signal delivery is not configured');
          }
          await this.outboundHandlers.sendSignalMessage(
            input.resolvedSignalJid,
            input.message,
          );
          return {
            result: { status: 'sent' },
            beforeState,
            afterState: stableStringify({
              status: 'sent',
              channel: input.channel,
              target: input.resolvedTarget || input.target,
            }),
          };
        }
        if (input.channel === 'email') {
          throw new Error(
            'Email delivery is not configured yet. Configure an email provider first.',
          );
        }
        throw new Error(
          'SMS delivery is not configured yet. Configure an SMS provider first.',
        );
      },
    });

    this.register<OutboundDeleteInput, { status: string }>({
      name: 'outbound.delete',
      requiredTrust: 'owner_verified',
      commandableAction: false,
      previewable: true,
      summarizeInput: (input) =>
        `Delete ${input.channel} item "${input.target}"`,
      execute: async (input) => {
        if (!this.outboundHandlers.deleteResource) {
          throw new Error(`Deletion is not configured for ${input.channel}.`);
        }
        const result = await this.outboundHandlers.deleteResource(input);
        return {
          result: { status: result || 'deleted' },
          beforeState: stableStringify({
            status: 'pending',
            channel: input.channel,
            target: input.target,
          }),
          afterState: stableStringify({
            status: result || 'deleted',
            channel: input.channel,
            target: input.target,
          }),
        };
      },
    });

    this.register<OutboundCreateGroupInput, { status: string; jid: string }>({
      name: 'outbound.createGroup',
      requiredTrust: 'owner_verified',
      commandableAction: false,
      previewable: true,
      summarizeInput: (input) =>
        `Create a new ${input.channel} group with ${input.resolvedMemberDisplayNames.join(', ')}`,
      execute: async (input) => {
        if (input.channel !== 'signal') {
          throw new Error(
            'Only Signal group creation is implemented right now.',
          );
        }
        if (!this.outboundHandlers.createSignalGroup) {
          throw new Error('Signal group creation is not configured.');
        }

        const created = await this.outboundHandlers.createSignalGroup({
          title: input.title,
          members: input.resolvedMemberTargets,
          message: input.message,
        });
        return {
          result: { status: 'created', jid: created.jid },
          beforeState: stableStringify({
            status: 'pending',
            channel: input.channel,
            members: input.resolvedMemberTargets,
            title: input.title || '',
          }),
          afterState: stableStringify({
            status: 'created',
            channel: input.channel,
            jid: created.jid,
            title: created.title,
          }),
        };
      },
    });

    this.register<OutboundUpdateGroupInput, { status: string }>({
      name: 'outbound.updateGroup',
      requiredTrust: 'owner_verified',
      commandableAction: false,
      previewable: true,
      summarizeInput: (input) => {
        if (input.action === 'rename') {
          return `Rename Signal group "${input.groupName}" to "${input.newName}"`;
        }
        const verb = input.action === 'add_member' ? 'Add' : 'Remove';
        const prep = input.action === 'add_member' ? 'to' : 'from';
        return `${verb} ${input.resolvedMemberDisplayNames.join(', ')} ${prep} Signal group "${input.groupName}"`;
      },
      execute: async (input) => {
        if (!this.outboundHandlers.updateSignalGroup) {
          throw new Error('Signal group management is not configured.');
        }
        await this.outboundHandlers.updateSignalGroup(input);
        return {
          result: { status: 'updated' },
          beforeState: stableStringify({
            groupName: input.groupName,
            action: input.action,
          }),
          afterState: stableStringify({
            groupName: input.action === 'rename' ? input.newName : input.groupName,
            action: input.action,
            members: input.resolvedMemberTargets,
          }),
        };
      },
    });
  }

  private register<TInput, TResult>(
    definition: ControlActionDefinition<TInput, TResult>,
  ): void {
    this.definitions.set(definition.name, definition);
  }

  getDefinition(name: string): ControlActionDefinition<any, any> | undefined {
    return this.definitions.get(name);
  }

  setOutboundHandlers(handlers: OutboundHandlers): void {
    this.outboundHandlers = handlers;
  }

  getSettings(): ControlSettings {
    const stored = this.store.getSettings();
    return {
      controlSignalJid: stored.controlSignalJid || CONTROL_SIGNAL_JID,
      assistantSignalIdentity:
        stored.assistantSignalIdentity || SIGNAL_ACCOUNT || '',
      updatedAt: stored.updatedAt,
    };
  }

  getSetupEnvironment(): Record<string, string> {
    return readEnvFile([
      'ASSISTANT_NAME',
      'OPENAI_BASE_URL',
      'OPENAI_API_KEY',
      'OPENAI_MODEL',
      'OPENAI_MAX_TOKENS',
      'OPENAI_TEMPERATURE',
      'OPENAI_CONTEXT_WINDOW',
      'SIGNAL_ACCOUNT',
      'SIGNAL_RPC_URL',
      'SIGNAL_RECEIVE_TIMEOUT_SEC',
      'CONTROL_SIGNAL_JID',
      'ONECLI_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_CONTACTS_ACCESS_TOKEN',
      'ADMIN_BIND_HOST',
      'ADMIN_PORT',
      'ADMIN_UI_TOKEN',
      'INBOUND_GUARD_SCRIPT',
    ]);
  }

  getSignalComposeStatus(): SignalComposeStatus {
    const env = this.getSetupEnvironment();
    return this.signalCompose.getStatus({
      account: env.SIGNAL_ACCOUNT || SIGNAL_ACCOUNT,
      rpcUrl: env.SIGNAL_RPC_URL || SIGNAL_RPC_URL,
    });
  }

  getSignalProfile(): SignalProfileSettings {
    const stored = this.store.getSignalProfile();
    const env = this.getSetupEnvironment();
    return {
      ...stored,
      account: stored.account || env.SIGNAL_ACCOUNT || SIGNAL_ACCOUNT || '',
    };
  }

  getGoogleContactsOAuth(): GoogleContactsOAuthState {
    return this.store.getGoogleContactsOAuth();
  }

  async startGoogleContactsOAuth(origin: string): Promise<{ url: string }> {
    const env = this.getSetupEnvironment();
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error(
        'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required before connecting Google Contacts.',
      );
    }

    const current = this.store.getGoogleContactsOAuth();
    const oauthState = randomBytes(18).toString('base64url');
    this.store.saveGoogleContactsOAuth({
      ...current,
      oauthState,
      oauthStateCreatedAt: nowIso(),
    });

    const callbackUri = `${origin.replace(/\/$/, '')}/api/admin/google/oauth/callback`;
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', callbackUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_CONTACTS_SCOPE);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('state', oauthState);

    return { url: authUrl.toString() };
  }

  async completeGoogleContactsOAuth(input: {
    origin: string;
    state: string;
    code: string;
  }): Promise<{ message: string }> {
    const env = this.getSetupEnvironment();
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error(
        'Google OAuth client settings are missing. Save the client ID and secret first.',
      );
    }

    const stored = this.store.getGoogleContactsOAuth();
    if (!stored.oauthState || stored.oauthState !== input.state) {
      throw new Error(
        'Google OAuth state did not match the active login request.',
      );
    }

    const callbackUri = `${input.origin.replace(/\/$/, '')}/api/admin/google/oauth/callback`;
    const body = new URLSearchParams({
      code: input.code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new Error(
        payload.error_description ||
          payload.error ||
          `Google token exchange failed with ${response.status}`,
      );
    }

    this.store.saveGoogleContactsOAuth({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || stored.refreshToken,
      expiryDate: new Date(
        Date.now() + Math.max(60, payload.expires_in || 3600) * 1000,
      ).toISOString(),
      scope: payload.scope || GOOGLE_CONTACTS_SCOPE,
      tokenType: payload.token_type || 'Bearer',
      connectedAt: nowIso(),
      oauthState: '',
      oauthStateCreatedAt: '',
    });

    return { message: 'Google Contacts connected.' };
  }

  async getProviderAvailability(): Promise<ProviderAvailability> {
    const env = this.getSetupEnvironment();
    const providerEnv = await this.loadProviderEnvironment(env);
    const googleToken = await this.ensureGoogleContactsAccessToken(
      providerEnv,
      env,
    );
    const storedOAuth = this.store.getGoogleContactsOAuth();

    return {
      onecliConfigured: Boolean(env.ONECLI_URL),
      onecliReachable: providerEnv.__onecliReachable === 'true',
      googleContactsAvailable: Boolean(googleToken),
      googleContactsSource: env.GOOGLE_CONTACTS_ACCESS_TOKEN
        ? 'env'
        : storedOAuth.accessToken || storedOAuth.refreshToken
          ? 'oauth'
          : providerEnv.GOOGLE_CONTACTS_ACCESS_TOKEN ||
              providerEnv.GOOGLE_PEOPLE_ACCESS_TOKEN ||
              providerEnv.GOOGLE_OAUTH_ACCESS_TOKEN ||
              providerEnv.GMAIL_ACCESS_TOKEN
            ? 'onecli'
            : 'none',
      signalOutboundAvailable: Boolean(
        (env.SIGNAL_ACCOUNT || SIGNAL_ACCOUNT) &&
        (env.SIGNAL_RPC_URL || SIGNAL_RPC_URL),
      ),
      smsOutboundAvailable: false,
      emailOutboundAvailable: false,
      contactResolutionAvailable:
        Boolean(googleToken) || getIncomingContactSummaries().length > 0,
    };
  }

  async resolveOutboundTarget(
    channel: 'signal' | 'sms' | 'email',
    query: string,
  ): Promise<ResolvedContactTarget> {
    const literal = resolveLiteralTarget(channel, query);
    if (literal) return literal;

    if (channel === 'signal') {
      try {
        return resolveSignalHistoryTarget(query);
      } catch {
        // Fall through to Google Contacts lookup.
      }
    }

    const env = this.getSetupEnvironment();
    const providerEnv = await this.loadProviderEnvironment(env);
    const googleToken = await this.ensureGoogleContactsAccessToken(
      providerEnv,
      env,
    );
    if (!googleToken) {
      throw new Error(
        `No ${channel} contact matched "${query}", and Google Contacts is not configured for host-side resolution.`,
      );
    }

    const googleMatch = await searchGoogleContacts(googleToken, channel, query);
    if (!googleMatch) {
      throw new Error(
        `No ${channel} contact matched "${query}" in Google Contacts.`,
      );
    }
    return googleMatch;
  }

  async resolveOutboundTargets(
    channel: 'signal' | 'sms' | 'email',
    queries: string[],
  ): Promise<ResolvedContactTarget[]> {
    const uniqueQueries = queries.map((item) => item.trim()).filter(Boolean);
    return Promise.all(
      uniqueQueries.map((query) => this.resolveOutboundTarget(channel, query)),
    );
  }

  async getSignalLinkQrDataUrl(deviceName: string): Promise<string> {
    const env = this.getSetupEnvironment();
    return this.signalCompose.fetchLinkQrDataUrl({
      deviceName,
      rpcUrl: env.SIGNAL_RPC_URL || SIGNAL_RPC_URL,
    });
  }

  async startSignalRegistration(
    account: string,
    useVoice: boolean,
  ): Promise<{ message: string }> {
    const env = this.getSetupEnvironment();
    return this.signalCompose.startRegistration({
      account: account || env.SIGNAL_ACCOUNT || SIGNAL_ACCOUNT,
      rpcUrl: env.SIGNAL_RPC_URL || SIGNAL_RPC_URL,
      useVoice,
    });
  }

  async verifySignalRegistration(
    account: string,
    code: string,
  ): Promise<{ message: string }> {
    const env = this.getSetupEnvironment();
    return this.signalCompose.verifyRegistration({
      account: account || env.SIGNAL_ACCOUNT || SIGNAL_ACCOUNT,
      rpcUrl: env.SIGNAL_RPC_URL || SIGNAL_RPC_URL,
      code,
    });
  }

  getPolicy(): ControlPolicy {
    return this.store.getPolicy();
  }

  isProviderPaused(provider: string): boolean {
    return this.getPolicy().pausedProviders.includes(provider.toLowerCase());
  }

  isVerifiedIdentity(identity: string): boolean {
    const canonical = canonicalizeIdentity(identity);
    return this.store
      .getVerifiedIdentities()
      .some((item) => canonicalizeIdentity(item.identity) === canonical);
  }

  requireOwnerVerified(context: ControlActionContext): void {
    if (context.source === 'ui' || context.source === 'agent') return;
    if (!this.isVerifiedIdentity(context.actorIdentity)) {
      throw new Error(
        `Identity ${canonicalizeIdentity(context.actorIdentity)} is not owner-verified`,
      );
    }
  }

  async executeAction<TInput, TResult>(
    name: string,
    input: TInput,
    context: ControlActionContext,
  ): Promise<TResult> {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Unknown action: ${name}`);
    this.requireOwnerVerified(context);
    const outcome = (await definition.execute(
      input,
      context,
    )) as ActionResultEnvelope<TResult>;
    this.audit(
      name,
      definition.summarizeInput(input),
      outcome,
      context,
      'success',
    );
    return outcome.result;
  }

  previewAction<TInput>(
    name: string,
    input: TInput,
    context: ControlActionContext,
    options?: { chatJid?: string },
  ): PendingControlAction {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Unknown action: ${name}`);
    if (!definition.previewable) {
      throw new Error(`Action ${name} does not support preview mode`);
    }
    this.requireOwnerVerified(context);
    const pending = this.store.createPendingAction({
      actionName: name,
      input,
      summary: definition.summarizeInput(input),
      actorIdentity: canonicalizeIdentity(context.actorIdentity),
      source: context.source,
      chatJid: options?.chatJid,
    });
    this.store.appendAuditRecord({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorIdentity: canonicalizeIdentity(context.actorIdentity),
      source: context.source,
      actionName: name,
      payloadSummary: definition.summarizeInput(input),
      beforeState: '',
      afterState: `Pending approval ${pending.id}`,
      status: 'pending',
      createdAt: nowIso(),
    });
    return pending;
  }

  setApprovalReplyClassifier(
    classifier: ApprovalReplyClassifier | undefined,
  ): void {
    this.approvalReplyClassifier = classifier;
  }

  async handleNaturalApprovalReply(
    chatJid: string,
    text: string,
    context: ControlActionContext,
  ): Promise<{ handled: boolean; message?: string }> {
    this.requireOwnerVerified(context);

    const pending = this.listPendingActions(10).filter(
      (item) => item.status === 'pending' && item.chatJid === chatJid,
    );
    if (pending.length === 0) return { handled: false };
    if (pending.length > 1) {
      return {
        handled: true,
        message:
          'There are multiple pending approvals in this chat. Use /pending list and then /approve <id> or /reject <id>.',
      };
    }

    let decision: ApprovalReplyDecision | null = null;
    let reason: string | undefined;
    if (this.approvalReplyClassifier) {
      try {
        const classified = await this.approvalReplyClassifier({
          reply: text,
          pendingSummary: pending[0].summary,
        });
        decision = classified.decision;
        reason = classified.reason;
      } catch {
        decision = parseNaturalApprovalDecision(text);
      }
    } else {
      decision = parseNaturalApprovalDecision(text);
    }
    if (!decision) return { handled: false };

    if (decision === 'approve') {
      const result = await this.approvePending(pending[0].id, context);
      return { handled: true, message: result.message };
    }

    if (decision === 'reject') {
      const result = this.rejectPending(pending[0].id, context);
      return { handled: true, message: result.message };
    }

    if (decision === 'revise') {
      return {
        handled: true,
        message: reason?.trim()
          ? `I kept that pending. It sounds like you want changes first: ${reason.trim()}`
          : 'I kept that pending. Tell me what you want changed, or reply naturally to approve or reject it.',
      };
    }

    return {
      handled: true,
      message: reason?.trim()
        ? `I couldn't confidently tell whether that means approve or reject: ${reason.trim()}`
        : 'I could not confidently tell whether that means approve or reject.',
    };
  }

  async approvePending(
    id: string,
    context: ControlActionContext,
  ): Promise<{ message: string }> {
    this.requireOwnerVerified(context);
    const pending = this.store
      .getPendingActions()
      .find((item) => item.id === id && item.status === 'pending');
    if (!pending) throw new Error(`Pending action not found: ${id}`);
    await this.executeAction(pending.actionName, pending.input, {
      actorIdentity: context.actorIdentity,
      source: context.source,
    });
    this.store.updatePendingAction(id, 'approved');
    return { message: `Approved ${pending.summary}` };
  }

  rejectPending(
    id: string,
    context: ControlActionContext,
  ): { message: string } {
    this.requireOwnerVerified(context);
    const pending = this.store.updatePendingAction(id, 'rejected');
    if (!pending) throw new Error(`Pending action not found: ${id}`);
    this.store.appendAuditRecord({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorIdentity: canonicalizeIdentity(context.actorIdentity),
      source: context.source,
      actionName: pending.actionName,
      payloadSummary: pending.summary,
      beforeState: `Pending approval ${pending.id}`,
      afterState: 'Rejected',
      status: 'rejected',
      createdAt: nowIso(),
    });
    return { message: `Rejected ${pending.summary}` };
  }

  listContacts(status?: ContactStatus): ContactView[] {
    const summaries = getIncomingContactSummaries();
    const contacts = this.store.getContacts();
    const views = new Map<string, ContactView>();

    for (const summary of summaries) {
      const identity = canonicalizeIdentity(summary.sender);
      const stored = contacts[identity];
      views.set(identity, this.mergeContactSummary(identity, stored, summary));
    }

    for (const [identity, stored] of Object.entries(contacts)) {
      if (!views.has(identity)) {
        views.set(identity, {
          ...stored,
          messageCount: 0,
          lastMessageTime: stored.updatedAt,
        });
      }
    }

    return [...views.values()]
      .filter((item) => (status ? item.status === status : true))
      .sort((a, b) => b.lastMessageTime.localeCompare(a.lastMessageTime));
  }

  getContact(identityInput: string): ContactDetailView | undefined {
    const identity = canonicalizeIdentity(identityInput);
    const summaries = getIncomingContactSummaries();
    const summary = summaries.find(
      (item) => canonicalizeIdentity(item.sender) === identity,
    );
    const stored = this.store.getContacts()[identity];
    if (!stored && !summary) return undefined;

    const base = this.mergeContactSummary(identity, stored, summary);
    const history = this.loadMessagesForIdentity(identity).map((message) => ({
      id: message.id,
      chatJid: message.chat_jid,
      senderName: message.sender_name,
      content: message.content,
      timestamp: message.timestamp,
      isFromMe: message.is_from_me === true,
    }));
    return { ...base, history };
  }

  listVerifiedIdentities(): VerifiedIdentity[] {
    return this.store.getVerifiedIdentities();
  }

  listPendingActions(limit: number = 50): PendingControlAction[] {
    return this.store.getPendingActions().slice(0, Math.max(1, limit));
  }

  getPersonalityProfiles(): Record<string, PersonalityProfile> {
    return this.store.getPersonalityProfiles();
  }

  getResolvedPersonality(scope: PersonalityScope): PersonalityProfile {
    return resolveProfile(
      normalizeScope(scope),
      this.store.getPersonalityProfiles(),
    );
  }

  previewPersonality(scope: PersonalityScope): string {
    return previewPersonalityProfile(
      normalizeScope(scope),
      this.store.getPersonalityProfiles(),
    );
  }

  getAuditRecords(
    limit: number = 100,
    identity?: string,
  ): ControlAuditRecord[] {
    const normalized = identity ? canonicalizeIdentity(identity) : '';
    return this.store
      .getAuditRecords(limit)
      .filter((record) =>
        normalized
          ? record.actorIdentity === normalized ||
            record.payloadSummary.includes(displayIdentity(normalized))
          : true,
      );
  }

  private async loadProviderEnvironment(
    env: Record<string, string>,
  ): Promise<Record<string, string>> {
    const merged = { ...env };
    if (!env.ONECLI_URL) return merged;

    try {
      const onecli = new OneCLI({ url: env.ONECLI_URL });
      const config = await onecli.getContainerConfig();
      for (const [key, value] of Object.entries(config.env || {})) {
        if (!merged[key]) merged[key] = value;
      }
      merged.__onecliReachable = 'true';
    } catch {
      merged.__onecliReachable = 'false';
    }
    return merged;
  }

  private getGoogleContactsAccessToken(env: Record<string, string>): string {
    for (const key of GOOGLE_CONTACT_TOKEN_KEYS) {
      const value = env[key];
      if (value?.trim()) return value.trim();
    }
    return '';
  }

  private async ensureGoogleContactsAccessToken(
    providerEnv: Record<string, string>,
    env: Record<string, string>,
  ): Promise<string> {
    const direct = this.getGoogleContactsAccessToken(providerEnv);
    if (direct) return direct;

    const stored = this.store.getGoogleContactsOAuth();
    if (!stored.accessToken && !stored.refreshToken) return '';

    const expiresAt = new Date(stored.expiryDate).getTime();
    if (stored.accessToken && expiresAt > Date.now() + 60_000) {
      return stored.accessToken;
    }

    if (
      !stored.refreshToken ||
      !env.GOOGLE_CLIENT_ID ||
      !env.GOOGLE_CLIENT_SECRET
    ) {
      return stored.accessToken || '';
    }

    const refreshed = await this.refreshGoogleContactsAccessToken(
      stored.refreshToken,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      stored,
    );
    return refreshed.accessToken;
  }

  private async refreshGoogleContactsAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
    current: GoogleContactsOAuthState,
  ): Promise<GoogleContactsOAuthState> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new Error(
        payload.error_description ||
          payload.error ||
          `Google token refresh failed with ${response.status}`,
      );
    }

    const next: GoogleContactsOAuthState = {
      ...current,
      accessToken: payload.access_token,
      refreshToken,
      expiryDate: new Date(
        Date.now() + Math.max(60, payload.expires_in || 3600) * 1000,
      ).toISOString(),
      scope: payload.scope || current.scope || GOOGLE_CONTACTS_SCOPE,
      tokenType: payload.token_type || current.tokenType || 'Bearer',
      connectedAt: current.connectedAt || nowIso(),
      oauthState: '',
      oauthStateCreatedAt: '',
    };
    this.store.saveGoogleContactsOAuth(next);
    return next;
  }

  private audit(
    actionName: string,
    payloadSummary: string,
    outcome: ActionResultEnvelope<unknown>,
    context: ControlActionContext,
    status: ControlAuditRecord['status'],
  ): void {
    this.store.appendAuditRecord({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorIdentity: canonicalizeIdentity(context.actorIdentity),
      source: context.source,
      actionName,
      payloadSummary,
      beforeState: outcome.beforeState,
      afterState: outcome.afterState,
      status,
      createdAt: nowIso(),
    });
  }

  private redactEnvSnapshot(
    values: Record<string, string>,
  ): Record<string, string> {
    const redacted = { ...values };
    for (const key of [
      'OPENAI_API_KEY',
      'ADMIN_UI_TOKEN',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_CONTACTS_ACCESS_TOKEN',
    ]) {
      if (redacted[key]) redacted[key] = '<redacted>';
    }
    return redacted;
  }

  private async fetchSignal(
    pathname: string,
    rpcUrl: string,
    init: RequestInit,
    action: string,
  ): Promise<Response> {
    try {
      return await fetch(new URL(pathname, rpcUrl), init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Signal RPC ${action} failed: ${reason}`);
    }
  }

  private mergeContactSummary(
    identity: string,
    stored: ControlContact | undefined,
    summary?: ContactActivitySummary,
  ): ContactView {
    const base = stored || defaultContact(identity, summary?.sender_name);
    return {
      ...base,
      displayName:
        base.displayName || summary?.sender_name || displayIdentity(identity),
      messageCount: summary?.message_count || 0,
      lastMessageTime: summary?.last_message_time || base.updatedAt,
    };
  }

  private loadContactRecord(identity: string): ControlContact {
    const stored = this.store.getContacts()[identity];
    return stored || defaultContact(identity);
  }

  private loadMessagesForIdentity(identity: string) {
    const matchingRawSenders = getIncomingContactSummaries()
      .filter((summary) => canonicalizeIdentity(summary.sender) === identity)
      .map((summary) => summary.sender);
    return matchingRawSenders.flatMap((sender) =>
      getMessagesBySender(sender, 50),
    );
  }

  private upsertContactStatus(
    identityInput: string,
    status: ContactStatus,
    context: ControlActionContext,
    reasons: string[],
    trustSource: ControlContact['trustSource'],
    manualOverride: boolean,
  ): { identity: string; beforeState: string; afterState: string } {
    const identity = canonicalizeIdentity(identityInput);
    const contacts = this.store.getContacts();
    const current = this.loadContactRecord(identity);
    const next: ControlContact = {
      ...current,
      status,
      trustSource,
      notes: reasons.join(' | '),
      manualOverride,
      classificationSummary: summarizeStatus(status, reasons),
      classificationHistory: [
        buildClassificationEntry(
          status,
          context.actorIdentity,
          context.source,
          reasons,
        ),
        ...current.classificationHistory,
      ],
      updatedAt: nowIso(),
    };
    contacts[identity] = next;
    this.store.saveContacts(contacts);
    return {
      identity,
      beforeState: stableStringify(current),
      afterState: stableStringify(next),
    };
  }
}
