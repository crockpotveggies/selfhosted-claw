import { readEnvFile, setEnvFileValues } from './env.js';
import { CONTROL_SIGNAL_JID, SIGNAL_ACCOUNT, SIGNAL_RPC_URL } from './config.js';
import {
  ContactActivitySummary,
  getIncomingContactSummaries,
  getMessagesBySender,
} from './db.js';
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
  PendingControlAction,
  PersonalityProfile,
  PersonalityScope,
  VerifiedIdentity,
} from './control-types.js';
import { SignalComposeManager, SignalComposeStatus } from './signal-compose.js';

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
  }

  private register<TInput, TResult>(
    definition: ControlActionDefinition<TInput, TResult>,
  ): void {
    this.definitions.set(definition.name, definition);
  }

  getDefinition(name: string): ControlActionDefinition<any, any> | undefined {
    return this.definitions.get(name);
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
      .some((item) => item.identity === canonical);
  }

  requireOwnerVerified(context: ControlActionContext): void {
    if (context.source === 'ui') return;
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
    for (const key of ['OPENAI_API_KEY', 'ADMIN_UI_TOKEN']) {
      if (redacted[key]) redacted[key] = '<redacted>';
    }
    return redacted;
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
