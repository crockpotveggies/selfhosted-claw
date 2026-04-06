import { ControlActionService } from './control-actions.js';
import {
  canonicalizeIdentity,
  identitiesMatch,
} from './control-identities.js';
import { ContactDetailView, ContactView } from './control-actions.js';
import { ControlPolicy, VerifiedIdentity } from './control-types.js';
import { NewMessage, RegisteredGroup } from './types.js';

interface CommandHandleResult {
  handled: boolean;
}

interface SignalControlCommandDeps {
  service: ControlActionService;
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function parseScope(value: string): 'global' | 'main' | `group:${string}` {
  if (value === 'global' || value === 'main') return value;
  return value.startsWith('group:')
    ? (value as `group:${string}`)
    : `group:${value}`;
}

function formatContact(contact: {
  identity: string;
  displayName: string;
  status: string;
  messageCount: number;
  lastMessageTime: string;
  classificationSummary: string;
}): string {
  const summary = contact.classificationSummary
    ? `\nReason: ${contact.classificationSummary}`
    : '';
  return `${contact.displayName} (${contact.identity})\nStatus: ${contact.status}\nMessages: ${contact.messageCount}\nLast seen: ${contact.lastMessageTime}${summary}`;
}

export class SignalControlCommandParser {
  constructor(private readonly deps: SignalControlCommandDeps) {}

  async handle(chatJid: string, msg: NewMessage): Promise<CommandHandleResult> {
    const content = msg.content.trim();
    if (!content.startsWith('/')) return { handled: false };

    const actorIdentity = canonicalizeIdentity(msg.sender);
    const settings = this.deps.service.getSettings();
    const group = this.deps.registeredGroups()[chatJid];
    const isVerifiedOwnerDirectSignalChat =
      chatJid.startsWith('signal:user:') &&
      settings.controlSignalJid.startsWith('signal:user:') &&
      this.deps.service.isVerifiedIdentity(actorIdentity);
    const inControlChat =
      (settings.controlSignalJid &&
        identitiesMatch(chatJid, settings.controlSignalJid)) ||
      isVerifiedOwnerDirectSignalChat ||
      (chatJid.startsWith('signal:') && group?.isMain === true);
    if (!inControlChat) return { handled: false };

    const parts = content.split(/\s+/);
    const command = parts[0];
    const context = { actorIdentity, source: 'signal_control' as const };

    const respond = async (text: string) => {
      await this.deps.sendMessage(chatJid, text);
    };

    try {
      if (!this.deps.service.isVerifiedIdentity(actorIdentity)) {
        await respond('Control command denied: sender is not owner-verified.');
        return { handled: true };
      }

      switch (command) {
        case '/contact': {
          const sub = parts[1];
          const identity = parts[2];
          if (!sub || !identity) {
            await respond(
              'Usage: /contact <show|trust|abuse|reset|reclassify> <identity>',
            );
            return { handled: true };
          }
          if (sub === 'show') {
            const contact = this.deps.service.getContact(identity);
            await respond(
              contact ? formatContact(contact) : 'Contact not found.',
            );
            return { handled: true };
          }
          if (sub === 'trust') {
            const contact = await this.deps.service.executeAction<
              { identity: string },
              ContactView
            >('contact.trust', { identity }, context);
            await respond(`Trusted contact.\n\n${formatContact(contact)}`);
            return { handled: true };
          }
          if (sub === 'abuse') {
            const contact = await this.deps.service.executeAction<
              { identity: string },
              ContactView
            >('contact.abuse', { identity }, context);
            await respond(`Marked as abuse.\n\n${formatContact(contact)}`);
            return { handled: true };
          }
          if (sub === 'reset') {
            const contact = await this.deps.service.executeAction<
              { identity: string },
              ContactView
            >('contact.reset', { identity }, context);
            await respond(`Reset contact.\n\n${formatContact(contact)}`);
            return { handled: true };
          }
          if (sub === 'reclassify') {
            const contact = await this.deps.service.executeAction<
              { identity: string },
              ContactDetailView
            >('contact.reclassify', { identity }, context);
            await respond(`Reclassified contact.\n\n${formatContact(contact)}`);
            return { handled: true };
          }
          await respond('Unknown /contact subcommand.');
          return { handled: true };
        }
        case '/contacts': {
          const sub = parts[1];
          if (sub !== 'list') {
            await respond('Usage: /contacts list [status]');
            return { handled: true };
          }
          const statusArg = parts[2]?.startsWith('status=')
            ? parts[2].slice('status='.length)
            : undefined;
          const contacts = this.deps.service.listContacts(
            statusArg as 'trusted' | 'unknown' | 'abuse' | undefined,
          );
          const body =
            contacts.length === 0
              ? 'No contacts found.'
              : contacts
                  .slice(0, 10)
                  .map(
                    (contact) =>
                      `- ${contact.displayName} (${contact.identity}) [${contact.status}]`,
                  )
                  .join('\n');
          await respond(body);
          return { handled: true };
        }
        case '/verified': {
          const sub = parts[1];
          if (sub === 'list') {
            const identities = this.deps.service.listVerifiedIdentities();
            await respond(
              identities.length === 0
                ? 'No verified identities configured.'
                : identities
                    .map((item) => `- ${item.label}: ${item.identity}`)
                    .join('\n'),
            );
            return { handled: true };
          }
          if ((sub === 'add' || sub === 'remove') && parts[2]) {
            const identity = parts[2];
            if (sub === 'add') {
              const label = parts.slice(3).join(' ');
              const result = await this.deps.service.executeAction<
                { identity: string; label: string },
                VerifiedIdentity[]
              >('verified.add', { identity, label }, context);
              await respond(
                `Verified identities updated (${result.length} total).`,
              );
              return { handled: true };
            }
            const result = await this.deps.service.executeAction<
              { identity: string },
              VerifiedIdentity[]
            >('verified.remove', { identity }, context);
            await respond(
              `Verified identities updated (${result.length} total).`,
            );
            return { handled: true };
          }
          await respond('Usage: /verified <list|add|remove> ...');
          return { handled: true };
        }
        case '/personality': {
          const sub = parts[1];
          if (sub === 'show' && parts[2]) {
            const scope = parseScope(parts[2]);
            const profile = this.deps.service.getResolvedPersonality(scope);
            await respond(
              `Scope: ${scope}\nName: ${profile.displayName}\nRole: ${profile.role}\nTone: ${profile.tone}\nCommunication: ${profile.communicationStyle}\nInitiative: ${profile.initiative}\nCustom instructions:\n${profile.customInstructions || '(none)'}`,
            );
            return { handled: true };
          }
          if (sub === 'set' && parts[2] && parts[3]) {
            const scope = parseScope(parts[2]);
            const field = parts[3];
            const value = parts.slice(4).join(' ').trim();
            if (!value) {
              await respond('Usage: /personality set <scope> <field> <value>');
              return { handled: true };
            }
            const pending = this.deps.service.previewAction(
              'personality.setField',
              {
                scope,
                field,
                value,
              },
              context,
            );
            await respond(
              `Pending personality change created.\nID: ${pending.id}\nSummary: ${pending.summary}\nApprove with /approve ${pending.id}`,
            );
            return { handled: true };
          }
          if (sub === 'append' && parts[2]) {
            const scope = parseScope(parts[2]);
            const text = parts.slice(3).join(' ').trim();
            if (!text) {
              await respond('Usage: /personality append <scope> <text>');
              return { handled: true };
            }
            const pending = this.deps.service.previewAction(
              'personality.appendInstructions',
              { scope, text },
              context,
            );
            await respond(
              `Pending personality append created.\nID: ${pending.id}\nApprove with /approve ${pending.id}`,
            );
            return { handled: true };
          }
          if (sub === 'reset' && parts[2]) {
            const scope = parseScope(parts[2]);
            const pending = this.deps.service.previewAction(
              'personality.reset',
              { scope },
              context,
            );
            await respond(
              `Pending personality reset created.\nID: ${pending.id}\nApprove with /approve ${pending.id}`,
            );
            return { handled: true };
          }
          await respond('Usage: /personality <show|set|append|reset> ...');
          return { handled: true };
        }
        case '/policy': {
          const sub = parts[1];
          if (sub === 'show') {
            const policy = this.deps.service.getPolicy();
            await respond(
              policy.pausedProviders.length === 0
                ? 'No providers are paused.'
                : `Paused providers: ${policy.pausedProviders.join(', ')}`,
            );
            return { handled: true };
          }
          if (
            (sub === 'pause-outbound' || sub === 'resume-outbound') &&
            parts[2]
          ) {
            const provider = parts[2];
            const actionName =
              sub === 'pause-outbound'
                ? 'policy.pauseProvider'
                : 'policy.resumeProvider';
            const policy = await this.deps.service.executeAction<
              { provider: string },
              ControlPolicy
            >(actionName, { provider }, context);
            await respond(
              policy.pausedProviders.length === 0
                ? 'No providers are paused.'
                : `Paused providers: ${policy.pausedProviders.join(', ')}`,
            );
            return { handled: true };
          }
          await respond(
            'Usage: /policy <show|pause-outbound|resume-outbound> [provider]',
          );
          return { handled: true };
        }
        case '/settings': {
          const sub = parts[1];
          if (sub === 'show') {
            const settings = this.deps.service.getSettings();
            const signalCompose = this.deps.service.getSignalComposeStatus();
            await respond(
              `Control chat: ${settings.controlSignalJid || '(unset)'}\nAssistant Signal identity: ${settings.assistantSignalIdentity || '(unset)'}\nManaged Signal compose: ${signalCompose.running ? 'running' : 'stopped'}`,
            );
            return { handled: true };
          }
          if (sub === 'env' && parts[2] && parts[3]) {
            const key = parts[2];
            const value = parts.slice(3).join(' ').trim();
            if (!value) {
              await respond('Usage: /settings env <KEY> <value>');
              return { handled: true };
            }
            const pending = this.deps.service.previewAction(
              'settings.updateEnv',
              { values: { [key]: value } },
              context,
            );
            await respond(
              `Pending environment change created.\nID: ${pending.id}\nApprove with /approve ${pending.id}`,
            );
            return { handled: true };
          }
          if (
            (sub === 'set-control-chat' || sub === 'set-assistant-signal') &&
            parts[2]
          ) {
            const pending = this.deps.service.previewAction(
              'settings.update',
              sub === 'set-control-chat'
                ? { controlSignalJid: parts[2] }
                : { assistantSignalIdentity: parts[2] },
              context,
            );
            await respond(
              `Pending settings change created.\nID: ${pending.id}\nApprove with /approve ${pending.id}`,
            );
            return { handled: true };
          }
          await respond(
            'Usage: /settings <show|env|set-control-chat|set-assistant-signal> ...',
          );
          return { handled: true };
        }
        case '/signal-compose': {
          const sub = parts[1];
          if (sub === 'status' || !sub) {
            const status = this.deps.service.getSignalComposeStatus();
            await respond(
              `Managed Signal compose\nRunning: ${status.running ? 'yes' : 'no'}\nRPC URL: ${status.localRpcUrl}\nAccount: ${status.account || '(unset)'}\nCompose file: ${status.composeFile}${status.lastError ? `\nLast error: ${status.lastError}` : ''}`,
            );
            return { handled: true };
          }
          if (sub === 'up') {
            const status = await this.deps.service.executeAction<
              { account?: string; rpcUrl?: string },
              { running: boolean; localRpcUrl: string; account: string }
            >(
              'signal.composeUp',
              {
                account: parts[2],
                rpcUrl: parts[3],
              },
              context,
            );
            await respond(
              `Managed Signal compose started.\nRunning: ${status.running ? 'yes' : 'no'}\nRPC URL: ${status.localRpcUrl}\nAccount: ${status.account}`,
            );
            return { handled: true };
          }
          await respond(
            'Usage: /signal-compose <status|up> [account] [rpcUrl]',
          );
          return { handled: true };
        }
        case '/audit': {
          const sub = parts[1];
          if (sub === 'recent') {
            const count = Number(parts[2] || '10');
            const records = this.deps.service.getAuditRecords(count);
            await respond(
              records.length === 0
                ? 'No audit entries.'
                : records
                    .map(
                      (record) =>
                        `- ${record.createdAt} ${record.actionName} [${record.status}] by ${record.actorIdentity}`,
                    )
                    .join('\n'),
            );
            return { handled: true };
          }
          if (sub === 'contact' && parts[2]) {
            const records = this.deps.service.getAuditRecords(20, parts[2]);
            await respond(
              records.length === 0
                ? 'No audit entries for that contact.'
                : records
                    .map(
                      (record) =>
                        `- ${record.createdAt} ${record.actionName} [${record.status}]`,
                    )
                    .join('\n'),
            );
            return { handled: true };
          }
          await respond('Usage: /audit <recent|contact> ...');
          return { handled: true };
        }
        case '/approve': {
          if (!parts[1]) {
            await respond('Usage: /approve <pending-id>');
            return { handled: true };
          }
          const result = await this.deps.service.approvePending(
            parts[1],
            context,
          );
          await respond(result.message);
          return { handled: true };
        }
        case '/reject': {
          if (!parts[1]) {
            await respond('Usage: /reject <pending-id>');
            return { handled: true };
          }
          const result = this.deps.service.rejectPending(parts[1], context);
          await respond(result.message);
          return { handled: true };
        }
        default:
          return { handled: false };
      }
    } catch (err) {
      await respond(
        err instanceof Error
          ? `Control command failed: ${err.message}`
          : 'Control command failed.',
      );
      return { handled: true };
    }
  }
}
