import { getIncomingContactSummaries } from './db.js';

export interface SendMessageDirective {
  kind: 'send_message';
  channel: 'signal' | 'sms' | 'email';
  to: string;
  message: string;
}

export interface CreateGroupDirective {
  kind: 'create_group';
  channel: 'signal';
  members: string[];
  title?: string;
  message: string;
}

export interface DeleteResourceDirective {
  kind: 'delete_resource';
  channel: 'signal' | 'sms' | 'email' | 'calendar';
  target: string;
  reason: string;
}

export type OutboundDirective =
  | SendMessageDirective
  | CreateGroupDirective
  | DeleteResourceDirective;

export interface ParsedAgentOutput {
  visibleText: string;
  directives: OutboundDirective[];
}

const SEND_MESSAGE_PATTERN =
  /<send_message\s+channel="(signal|sms|email)"\s+to="([^"]+)">([\s\S]*?)<\/send_message>/gi;
const CREATE_GROUP_PATTERN =
  /<create_group\s+channel="(signal)"\s+members="([^"]+)"(?:\s+title="([^"]*)")?>((?:[\s\S](?!<\/create_group>))*[\s\S]*?)<\/create_group>/gi;
const DELETE_RESOURCE_PATTERN =
  /<delete_resource\s+channel="(signal|sms|email|calendar)"\s+target="([^"]+)">([\s\S]*?)<\/delete_resource>/gi;

export interface ResolvedSignalTarget {
  jid: string;
  existingConversation: boolean;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\r/g, '').trim();
}

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function parseAgentOutput(rawText: string): ParsedAgentOutput {
  const directives: OutboundDirective[] = [];
  const withoutSend = rawText.replace(
    SEND_MESSAGE_PATTERN,
    (_match, channel: string, to: string, message: string) => {
      directives.push({
        kind: 'send_message',
        channel: channel as SendMessageDirective['channel'],
        to: collapseWhitespace(to),
        message: collapseWhitespace(message),
      });
      return '';
    },
  );
  const withoutGroups = withoutSend.replace(
    CREATE_GROUP_PATTERN,
    (_match, channel: string, members: string, title: string, message: string) => {
      directives.push({
        kind: 'create_group',
        channel: channel as CreateGroupDirective['channel'],
        members: members
          .split(',')
          .map((member) => collapseWhitespace(member))
          .filter(Boolean),
        title: collapseWhitespace(title || ''),
        message: collapseWhitespace(message),
      });
      return '';
    },
  );
  const visibleText = withoutGroups.replace(
    DELETE_RESOURCE_PATTERN,
    (_match, channel: string, target: string, reason: string) => {
      directives.push({
        kind: 'delete_resource',
        channel: channel as DeleteResourceDirective['channel'],
        target: collapseWhitespace(target),
        reason: collapseWhitespace(reason),
      });
      return '';
    },
  );

  return {
    visibleText: collapseWhitespace(visibleText),
    directives,
  };
}

function hasKnownSignalConversation(identifier: string): boolean {
  const normalized = identifier.toLowerCase();
  return getIncomingContactSummaries().some((summary) => {
    const sender = summary.sender.toLowerCase();
    return sender === normalized || sender === `signal:user:${normalized}`;
  });
}

export function resolveSignalTarget(to: string): ResolvedSignalTarget {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error('Signal recipient is required');
  }

  if (trimmed.startsWith('signal:user:')) {
    return {
      jid: trimmed,
      existingConversation: hasKnownSignalConversation(trimmed),
    };
  }
  if (trimmed.startsWith('+')) {
    const jid = `signal:user:${normalizePhone(trimmed)}`;
    return {
      jid,
      existingConversation: hasKnownSignalConversation(jid),
    };
  }

  const normalized = trimmed.toLowerCase();
  const matches = getIncomingContactSummaries().filter((summary) => {
    const sender = summary.sender.toLowerCase();
    const senderName = summary.sender_name.toLowerCase();
    return sender.includes(normalized) || senderName.includes(normalized);
  });

  if (matches.length === 0) {
    throw new Error(`No Signal contact matched "${trimmed}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Signal contacts matched "${trimmed}": ${matches
        .slice(0, 5)
        .map((match) => match.sender_name || match.sender)
        .join(', ')}`,
    );
  }

  const sender = matches[0].sender;
  if (sender.startsWith('signal:user:')) {
    return { jid: sender, existingConversation: true };
  }
  if (sender.startsWith('+')) {
    return {
      jid: `signal:user:${normalizePhone(sender)}`,
      existingConversation: true,
    };
  }
  throw new Error(`Matched contact "${trimmed}" is not a Signal direct chat`);
}
