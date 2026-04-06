import {
  SIGNAL_ACCOUNT,
  SIGNAL_RECEIVE_TIMEOUT_SEC,
  SIGNAL_RPC_URL,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

interface SignalEnvelope {
  envelope?: SignalEnvelope;
  timestamp?: number | string;
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  dataMessage?: {
    message?: string;
    timestamp?: number | string;
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
  return `signal:group:${normalizeIdentifier(identifier)}`;
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

  private connected = false;
  private stopped = false;
  private receiveSocket: WebSocket | null = null;
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly opts: ChannelOpts,
    private readonly rpcUrl: string,
    private readonly account: string,
  ) {}

  async connect(): Promise<void> {
    this.stopped = false;
    await this.listGroups();
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const recipients = jid.startsWith('signal:group:')
      ? [jid.slice('signal:group:'.length)]
      : jid.startsWith('signal:user:')
        ? [formatUuidLike(jid.slice('signal:user:'.length))]
        : null;
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

  async createGroup(input: {
    title?: string;
    members: string[];
    message?: string;
  }): Promise<{ jid: string; title: string }> {
    const members = input.members.map((member) => formatUuidLike(member));
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
    const groupId = String(payload.id || '').trim();
    if (!groupId) {
      throw new Error('Signal RPC createGroup did not return a group id');
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
        this.connected = false;
        logger.warn(
          { channel: this.name, err: String(err) },
          'Signal polling error',
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
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
    const content = dataMessage?.message?.trim();
    if (!content) return null;

    const groupId =
      dataMessage?.groupInfo?.groupId ||
      dataMessage?.groupInfo?.id ||
      envelope.groupInfo?.groupId ||
      envelope.groupInfo?.id ||
      envelope.groupId;
    const isGroup = Boolean(groupId);
    const sender =
      envelope.sourceNumber ||
      envelope.source ||
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

  private handleReceivePayload(raw: unknown): void {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf-8')
          : Buffer.from(raw as ArrayBufferLike).toString('utf-8');
    if (!text.trim()) return;

    const payload = JSON.parse(text) as unknown;
    const envelopes = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { envelopes?: unknown[] })?.envelopes)
        ? ((payload as { envelopes: unknown[] }).envelopes ?? [])
        : [payload];

    for (const rawEnvelope of envelopes) {
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
    }
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  if (!SIGNAL_ACCOUNT.trim()) return null;
  return new SignalChannel(opts, SIGNAL_RPC_URL, SIGNAL_ACCOUNT);
});
