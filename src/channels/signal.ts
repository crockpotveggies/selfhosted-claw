import fs from 'fs';

import {
  ASSISTANT_NAME,
  SIGNAL_ACCOUNT,
  SIGNAL_RECEIVE_TIMEOUT_SEC,
  SIGNAL_RPC_URL,
} from '../config.js';
import { logger } from '../logger.js';
import { resolveSignalRpcUrl } from '../signal-rpc-url.js';
import { Channel, ChannelGroupLookupResult, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
  name?: string;
}

interface SignalEnvelope {
  envelope?: SignalEnvelope;
  timestamp?: number | string;
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  dataMessage?: {
    message?: string;
    timestamp?: number | string;
    mentions?: SignalMention[];
    groupInfo?: {
      groupId?: string;
      id?: string;
      title?: string;
      groupName?: string;
    };
  };
  syncMessage?: {
    sentMessage?: {
      destination?: string;
      message?: string;
      timestamp?: number | string;
      mentions?: SignalMention[];
      groupInfo?: {
        groupId?: string;
        id?: string;
        title?: string;
      };
    };
  };
  groupId?: string;
  groupInfo?: {
    groupId?: string;
    id?: string;
    title?: string;
    groupName?: string;
  };
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^\dA-Za-z:+-]/g, '').toLowerCase();
}

/**
 * Resolve Signal mentions in message text.
 * Signal replaces @-mentions with U+FFFC (Object Replacement Character) in the
 * message body, with the actual mention data in a separate `mentions` array.
 * This function splices the mention names back into the text as `@Name`.
 *
 * When a mention targets the agent's own account, it uses the configured
 * ASSISTANT_NAME (e.g. "Lena") so that trigger patterns like `@Lena` match.
 */
function resolveMentions(
  text: string,
  mentions?: SignalMention[],
  selfAccount?: string,
): string {
  if (!mentions || mentions.length === 0) return text;

  const selfNorm = selfAccount ? normalizeIdentifier(selfAccount) : '';

  // Sort mentions by start position descending so replacements don't shift indices
  const sorted = [...mentions]
    .filter((m) => m.start !== undefined && m.length !== undefined)
    .sort((a, b) => (b.start ?? 0) - (a.start ?? 0));

  let result = text;
  for (const mention of sorted) {
    const start = mention.start ?? 0;
    const len = mention.length ?? 1;

    // Check if this mention targets the agent itself
    let name: string;
    const mentionId = mention.number || mention.uuid || '';
    if (selfNorm && mentionId && normalizeIdentifier(mentionId) === selfNorm) {
      name = ASSISTANT_NAME;
    } else {
      name = mention.name || mention.number || mention.uuid || 'Unknown';
    }

    // Replace the mention placeholder (U+FFFC or whatever signal put there) with @Name
    result = result.slice(0, start) + `@${name}` + result.slice(start + len);
  }
  return result;
}

function formatUuidLike(value: string): string {
  const normalized = normalizeIdentifier(value);
  if (/^[0-9a-f]{32}$/.test(normalized)) {
    return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
  }
  return normalized;
}

function makeSignalUserJid(identifier: string): string {
  return `signal:user:${formatUuidLike(identifier)}`;
}

function makeSignalGroupJid(identifier: string): string {
  return `signal:group:${identifier}`;
}

function toIsoTimestamp(raw: number | string | undefined): string {
  if (typeof raw === 'number') return new Date(raw).toISOString();
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return new Date(Number(raw)).toISOString();
  }
  if (typeof raw === 'string' && raw) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

export class SignalChannel implements Channel {
  name = 'signal';
  capabilities = {
    attachments: {
      pdf: true,
      maxBytes: 25_000_000,
    },
  };

  private connected = false;
  private stopped = false;
  private receiveSocket: WebSocket | null = null;
  private readonly seenMessageIds = new Set<string>();
  /** Maps Signal UUIDs → phone numbers so DMs always use a stable JID. */
  private readonly uuidToPhone = new Map<string, string>();

  constructor(
    private readonly opts: ChannelOpts,
    private readonly rpcUrl: string,
    private readonly account: string,
    private readonly startupOptions: {
      maxAttempts?: number;
      delayMs?: number;
    } = {},
  ) {}

  async connect(): Promise<void> {
    this.stopped = false;
    await this.waitForRpcReady();
    this.connected = true;
    const now = new Date().toISOString();
    this.opts.onChatMetadata(
      makeSignalUserJid(this.account),
      now,
      'Signal self-chat',
      'signal',
      false,
    );
    void this.pollLoop();
    logger.info({ channel: this.name }, 'Signal channel connected');
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.receiveSocket?.close();
    this.receiveSocket = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    let recipient: string | null;
    if (jid.startsWith('signal:group:')) {
      const rawGroupId = jid.slice('signal:group:'.length);
      recipient = rawGroupId.startsWith('group.')
        ? rawGroupId
        : `group.${Buffer.from(rawGroupId).toString('base64')}`;
    } else if (jid.startsWith('signal:user:')) {
      recipient = formatUuidLike(jid.slice('signal:user:'.length));
    } else {
      recipient = null;
    }
    if (!recipient) return;
    const url = new URL(
      `/v1/typing-indicator/${encodeURIComponent(this.account)}`,
      this.rpcUrl,
    );
    try {
      await this.fetchWithContext(
        url,
        {
          method: isTyping ? 'PUT' : 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient }),
        },
        'setTyping',
      );
    } catch {
      // best-effort — don't break message flow if typing indicator fails
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!text.trim()) return;
    let recipients: string[] | null;
    if (jid.startsWith('signal:group:')) {
      const rawGroupId = jid.slice('signal:group:'.length);
      // signal-cli /v2/send expects the "group.<base64>" form.
      // Inbound envelopes provide the internal_id (raw base64 bytes),
      // so convert when the id doesn't already carry the prefix.
      const groupRecipient = rawGroupId.startsWith('group.')
        ? rawGroupId
        : `group.${Buffer.from(rawGroupId).toString('base64')}`;
      recipients = [groupRecipient];
    } else if (jid.startsWith('signal:user:')) {
      recipients = [formatUuidLike(jid.slice('signal:user:'.length))];
    } else {
      recipients = null;
    }
    if (!recipients) throw new Error(`Unsupported Signal JID: ${jid}`);

    const url = new URL('/v2/send', this.rpcUrl);
    const response = await this.fetchWithContext(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          number: this.account,
          recipients,
        }),
      },
      'send',
    );
    if (response.status !== 201) {
      throw new Error(`Signal RPC send failed with ${response.status}`);
    }
  }

  async sendAttachment(input: {
    jid: string;
    filePath: string;
    mimeType: string;
    caption?: string;
    fileName?: string;
  }): Promise<void> {
    const buffer = fs.readFileSync(input.filePath);
    let recipients: string[] | null;
    if (input.jid.startsWith('signal:group:')) {
      const rawGroupId = input.jid.slice('signal:group:'.length);
      const groupRecipient = rawGroupId.startsWith('group.')
        ? rawGroupId
        : `group.${Buffer.from(rawGroupId).toString('base64')}`;
      recipients = [groupRecipient];
    } else if (input.jid.startsWith('signal:user:')) {
      recipients = [formatUuidLike(input.jid.slice('signal:user:'.length))];
    } else {
      recipients = null;
    }
    if (!recipients) throw new Error(`Unsupported Signal JID: ${input.jid}`);

    const response = await this.fetchWithContext(
      new URL('/v2/send', this.rpcUrl),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: this.account,
          recipients,
          message: input.caption || '',
          base64_attachments: [buffer.toString('base64')],
        }),
      },
      'sendAttachment',
    );
    if (response.status !== 201) {
      throw new Error(
        `Signal RPC attachment send failed with ${response.status}`,
      );
    }
  }

  async createGroup(input: {
    title?: string;
    members: string[];
    message?: string;
  }): Promise<{ jid: string; title: string }> {
    const members = input.members.map((member) => {
      const raw = member.startsWith('signal:user:')
        ? member.slice('signal:user:'.length)
        : member;
      return formatUuidLike(raw);
    });
    const title = input.title?.trim() || 'New conversation';
    const url = new URL(
      `/v1/groups/${encodeURIComponent(this.account)}`,
      this.rpcUrl,
    );
    const response = await this.fetchWithContext(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: title,
          members,
        }),
      },
      'createGroup',
    );
    if (response.status !== 201) {
      throw new Error(`Signal RPC createGroup failed with ${response.status}`);
    }
    const payload = (await response.json()) as { id?: string };
    const createId = String(payload.id || '').trim();
    if (!createId) {
      throw new Error('Signal RPC createGroup did not return a group id');
    }

    // The ID returned by the create endpoint may differ from the ID used in
    // message envelopes (different base64 encoding).  Re-fetch via listGroups
    // to discover the canonical envelope-compatible ID.
    let groupId = createId;
    try {
      const groups = await this.listGroups();
      const match = groups.find((g) => {
        const gid = String(g.id || g.groupId || '');
        const gname = String(g.name || g.title || g.groupName || '');
        return gid === createId || gname === title;
      });
      if (match) {
        const canonicalId = String(match.id || match.groupId || '').trim();
        if (canonicalId && canonicalId !== createId) {
          logger.info(
            { createId, canonicalId, title },
            'Resolved canonical group ID from listGroups',
          );
          groupId = canonicalId;
        }
      }
    } catch (err) {
      logger.warn(
        { err: String(err), createId, title },
        'Failed to resolve canonical group ID after creation; using create ID',
      );
    }

    const jid = makeSignalGroupJid(groupId);
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      title,
      'signal',
      true,
    );
    if (input.message?.trim()) {
      await this.sendMessage(jid, input.message);
    }
    return { jid, title };
  }

  async addMembers(groupId: string, members: string[]): Promise<void> {
    const normalized = members.map((m) => {
      const raw = m.startsWith('signal:user:')
        ? m.slice('signal:user:'.length)
        : m;
      return formatUuidLike(raw);
    });
    const url = new URL(
      `/v1/groups/${encodeURIComponent(this.account)}/${encodeURIComponent(groupId)}/members`,
      this.rpcUrl,
    );
    const response = await this.fetchWithContext(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: normalized }),
      },
      'addMembers',
    );
    if (!response.ok) {
      throw new Error(`Signal RPC addMembers failed with ${response.status}`);
    }
  }

  async removeMembers(groupId: string, members: string[]): Promise<void> {
    const normalized = members.map((m) => {
      const raw = m.startsWith('signal:user:')
        ? m.slice('signal:user:'.length)
        : m;
      return formatUuidLike(raw);
    });
    const url = new URL(
      `/v1/groups/${encodeURIComponent(this.account)}/${encodeURIComponent(groupId)}/members`,
      this.rpcUrl,
    );
    const response = await this.fetchWithContext(
      url,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: normalized }),
      },
      'removeMembers',
    );
    if (!response.ok) {
      throw new Error(
        `Signal RPC removeMembers failed with ${response.status}`,
      );
    }
  }

  async leaveGroup(groupId: string): Promise<void> {
    const url = new URL(
      `/v1/groups/${encodeURIComponent(this.account)}/${encodeURIComponent(groupId)}`,
      this.rpcUrl,
    );
    const response = await this.fetchWithContext(
      url,
      { method: 'DELETE' },
      'leaveGroup',
    );
    if (!response.ok) {
      throw new Error(`Signal RPC leaveGroup failed with ${response.status}`);
    }
  }

  async updateGroupName(groupId: string, name: string): Promise<void> {
    const url = new URL(
      `/v1/groups/${encodeURIComponent(this.account)}/${encodeURIComponent(groupId)}`,
      this.rpcUrl,
    );
    const response = await this.fetchWithContext(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
      'updateGroupName',
    );
    if (!response.ok) {
      throw new Error(
        `Signal RPC updateGroupName failed with ${response.status}`,
      );
    }
  }

  async getGroups(): Promise<any[]> {
    return this.listGroups();
  }

  async findGroupByName(
    name: string,
  ): Promise<ChannelGroupLookupResult | null> {
    const groups = await this.listGroups();
    const normalized = name.toLowerCase().trim();
    const match = groups.find((g: any) => {
      const groupName = String(
        g.name || g.title || g.groupName || '',
      ).toLowerCase();
      return groupName === normalized || groupName.includes(normalized);
    });
    if (!match) return null;
    return {
      id: String(match.id || match.groupId || ''),
      name: String(match.name || match.title || match.groupName || ''),
      members: Array.isArray(match.members) ? (match.members as string[]) : [],
      jid: `signal:group:${String(match.id || match.groupId || '')}`,
    };
  }

  async syncGroups(_force: boolean): Promise<void> {
    const groups = await this.listGroups();
    const now = new Date().toISOString();
    for (const group of groups) {
      const groupId = String(group.id || group.groupId || '').trim();
      if (!groupId) continue;
      const name = String(
        group.name || group.title || group.groupName || groupId,
      );
      this.opts.onChatMetadata(
        makeSignalGroupJid(groupId),
        now,
        name,
        'signal',
        true,
      );
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.receiveOnce();
      } catch (err) {
        logger.warn(
          { channel: this.name, err: String(err) },
          'Signal receive websocket failed, falling back to HTTP polling',
        );
        try {
          await this.receiveOnceViaHttp();
        } catch (fallbackErr) {
          this.connected = false;
          logger.warn(
            { channel: this.name, err: String(fallbackErr) },
            'Signal polling error',
          );
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
      this.connected = !this.stopped;
    }
  }

  private parseEnvelope(rawEnvelope: SignalEnvelope): {
    chatJid: string;
    chatName: string;
    isGroup: boolean;
    message: NewMessage;
  } | null {
    const envelope = rawEnvelope.envelope || rawEnvelope;
    const sentMessage = envelope.syncMessage?.sentMessage;
    const dataMessage = sentMessage || envelope.dataMessage;
    const rawContent = dataMessage?.message?.trim();
    if (!rawContent) return null;

    // Resolve Signal mentions (U+FFFC placeholders) back into @Name text
    const mentions = (dataMessage as { mentions?: SignalMention[] })?.mentions;
    const content = resolveMentions(rawContent, mentions, this.account);

    const groupId =
      dataMessage?.groupInfo?.groupId ||
      dataMessage?.groupInfo?.id ||
      envelope.groupInfo?.groupId ||
      envelope.groupInfo?.id ||
      envelope.groupId;
    const isGroup = Boolean(groupId);
    const rawSourceNumber = envelope.sourceNumber?.trim() || '';
    const rawSourceUuid = (envelope.sourceUuid || envelope.source || '').trim();

    // Cache UUID→phone mapping whenever both are present
    if (rawSourceNumber && rawSourceUuid && !rawSourceUuid.startsWith('+')) {
      this.uuidToPhone.set(normalizeIdentifier(rawSourceUuid), rawSourceNumber);
    }

    // Prefer phone number; fall back to cached phone for the UUID; last resort: UUID
    const sender =
      rawSourceNumber ||
      (rawSourceUuid
        ? (this.uuidToPhone.get(normalizeIdentifier(rawSourceUuid)) ??
          rawSourceUuid)
        : '') ||
      sentMessage?.destination ||
      this.account;

    const timestamp = toIsoTimestamp(
      dataMessage?.timestamp || envelope.timestamp || Date.now(),
    );
    const chatJid = isGroup
      ? makeSignalGroupJid(String(groupId))
      : makeSignalUserJid(sender);
    const dataGroupInfo = dataMessage?.groupInfo as
      | { title?: string; groupName?: string }
      | undefined;
    const envelopeGroupInfo = envelope.groupInfo as
      | { title?: string; groupName?: string }
      | undefined;
    const chatName = isGroup
      ? String(
          dataGroupInfo?.title ||
            dataGroupInfo?.groupName ||
            envelopeGroupInfo?.title ||
            envelopeGroupInfo?.groupName ||
            groupId,
        )
      : String(envelope.sourceName || sender || 'Signal');
    const isFromMe =
      normalizeIdentifier(sender) === normalizeIdentifier(this.account);

    return {
      chatJid,
      chatName,
      isGroup,
      message: {
        id: `signal-${normalizeIdentifier(sender)}-${timestamp}-${content.length}`,
        chat_jid: chatJid,
        sender,
        sender_name: isFromMe ? 'You' : String(envelope.sourceName || sender),
        content,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isFromMe,
      },
    };
  }

  private async listGroups(): Promise<any[]> {
    const url = new URL(
      `/v1/groups/${encodeURIComponent(this.account)}`,
      this.rpcUrl,
    );
    const response = await this.fetchWithContext(
      url,
      { method: 'GET' },
      'listGroups',
    );
    if (!response.ok) {
      throw new Error(`Signal RPC listGroups failed with ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    return Array.isArray(payload) ? payload : [];
  }

  private async waitForRpcReady(): Promise<void> {
    const maxAttempts = Math.max(1, this.startupOptions.maxAttempts ?? 15);
    const delayMs = Math.max(0, this.startupOptions.delayMs ?? 1000);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.listGroups();
        return;
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fetchWithContext(
    url: URL,
    init: RequestInit,
    action: string,
  ): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Signal RPC ${action} failed to reach ${url.toString()}: ${reason}`,
      );
    }
  }

  private async receiveOnce(): Promise<void> {
    const wsUrl = new URL(
      `/v1/receive/${encodeURIComponent(this.account)}`,
      this.rpcUrl,
    );
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    // Read receipts are handled at the signal-cli daemon level via
    // --send-read-receipts flag (see scripts/signal-cli/enable-read-receipts.sh)

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.receiveSocket = socket;

      socket.onopen = () => {
        this.connected = true;
      };

      socket.onmessage = (event) => {
        try {
          this.handleReceivePayload(event.data);
        } catch (err) {
          logger.warn(
            { channel: this.name, err: String(err) },
            'Signal receive payload error',
          );
        }
      };

      socket.onerror = () => {
        reject(
          new Error(
            `Signal RPC receive websocket failed for ${wsUrl.toString()}`,
          ),
        );
      };

      socket.onclose = () => {
        if (this.receiveSocket === socket) {
          this.receiveSocket = null;
        }
        resolve();
      };
    });
  }

  private async receiveOnceViaHttp(): Promise<void> {
    const url = new URL(
      `/v1/receive/${encodeURIComponent(this.account)}`,
      this.rpcUrl,
    );
    url.searchParams.set('timeout', String(SIGNAL_RECEIVE_TIMEOUT_SEC));
    const response = await this.fetchWithContext(
      url,
      {
        method: 'GET',
        signal: AbortSignal.timeout((SIGNAL_RECEIVE_TIMEOUT_SEC + 2) * 1000),
      },
      'receive',
    );
    if (!response.ok) {
      throw new Error(`Signal RPC receive failed with ${response.status}`);
    }
    this.connected = true;
    this.handleReceivePayload(await response.text());
  }

  private handleReceivePayload(raw: unknown): void {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf-8')
          : Buffer.from(raw as ArrayBufferLike).toString('utf-8');
    if (!text.trim()) return;

    const payload = JSON.parse(text) as Record<string, unknown>;

    // Ignore JSON-RPC responses (e.g. from sendReceipt calls sent over this socket)
    if (payload && typeof payload === 'object' && 'jsonrpc' in payload) return;

    const envelopes = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { envelopes?: unknown[] })?.envelopes)
        ? ((payload as { envelopes: unknown[] }).envelopes ?? [])
        : [payload];

    for (const rawEnvelope of envelopes) {
      const envelope = (rawEnvelope as SignalEnvelope).envelope || rawEnvelope;
      const parsed = this.parseEnvelope(rawEnvelope as SignalEnvelope);
      if (!parsed) continue;
      if (this.seenMessageIds.has(parsed.message.id)) continue;
      this.seenMessageIds.add(parsed.message.id);
      this.opts.onChatMetadata(
        parsed.chatJid,
        parsed.message.timestamp,
        parsed.chatName,
        'signal',
        parsed.isGroup,
      );
      this.opts.onMessage(parsed.chatJid, parsed.message);
      // Read receipts are sent automatically by signal-cli daemon
      // via --send-read-receipts flag.
    }
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  if (!SIGNAL_ACCOUNT.trim()) return null;
  return new SignalChannel(
    opts,
    resolveSignalRpcUrl(SIGNAL_RPC_URL),
    SIGNAL_ACCOUNT,
  );
});
