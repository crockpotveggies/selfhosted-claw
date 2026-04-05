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

interface SignalRpcResponse {
  result?: any;
  error?: {
    message?: string;
  };
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^\dA-Za-z:+]/g, '').toLowerCase();
}

function makeSignalUserJid(identifier: string): string {
  return `signal:user:${normalizeIdentifier(identifier)}`;
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
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly opts: ChannelOpts,
    private readonly rpcUrl: string,
    private readonly account: string,
  ) {}

  async connect(): Promise<void> {
    this.stopped = false;
    await this.request('listGroups', {});
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
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!text.trim()) return;
    if (jid.startsWith('signal:group:')) {
      await this.request('send', {
        message: text,
        groupId: jid.slice('signal:group:'.length),
      });
      return;
    }
    if (jid.startsWith('signal:user:')) {
      await this.request('send', {
        message: text,
        recipient: jid.slice('signal:user:'.length),
      });
      return;
    }
    throw new Error(`Unsupported Signal JID: ${jid}`);
  }

  async syncGroups(_force: boolean): Promise<void> {
    const result = await this.request('listGroups', {});
    const groups = Array.isArray(result)
      ? result
      : Array.isArray(result?.groups)
        ? result.groups
        : [];
    const now = new Date().toISOString();
    for (const group of groups) {
      const groupId = String(group.id || group.groupId || '').trim();
      if (!groupId) continue;
      const name = String(group.name || group.title || group.groupName || groupId);
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
        const result = await this.request('receive', {
          timeout: SIGNAL_RECEIVE_TIMEOUT_SEC,
        });
        const envelopes = Array.isArray(result)
          ? result
          : Array.isArray(result?.envelopes)
            ? result.envelopes
            : [];
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

  private parseEnvelope(
    rawEnvelope: SignalEnvelope,
  ): {
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

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method,
        params: {
          account: this.account,
          ...params,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Signal RPC ${method} failed with ${response.status}`);
    }
    const payload = (await response.json()) as SignalRpcResponse;
    if (payload.error) {
      throw new Error(
        payload.error.message || `Signal RPC ${method} returned an error`,
      );
    }
    return payload.result;
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  if (!SIGNAL_ACCOUNT.trim()) return null;
  return new SignalChannel(opts, SIGNAL_RPC_URL, SIGNAL_ACCOUNT);
});
