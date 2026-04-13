/**
 * WhatsApp Integration
 *
 * Installable integration providing:
 * - Channel: Baileys-based WhatsApp Web client
 * - Setup: QR code pairing via admin UI
 * - Profile: WhatsApp profile name/about/avatar
 * - Notifications: disconnection alerts
 * - Memory: per-integration agent context
 *
 * No Docker service needed — Baileys runs in-process.
 */

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type {
  GroupMetadata,
  WAMessageKey,
  WASocket,
  proto as ProtoTypes,
} from '@whiskeysockets/baileys';
import pino from 'pino';

const { proto } = createRequire(import.meta.url)('@whiskeysockets/baileys') as {
  proto: typeof ProtoTypes;
};

// @ts-expect-error no type declarations
import QRCode from 'qrcode';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  STORE_DIR,
} from '../config.js';
import {
  getLastGroupSync,
  getMessageContentById,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger, createChildLogger } from '../logger.js';
import type {
  Channel,
  ChannelGroupLookupResult,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

import { registerIntegration } from './registry.js';
import {
  getIntegrationSettings,
  saveIntegrationSettings,
} from './settings-store.js';
import type {
  ChannelOpts,
  IntegrationDefinition,
  IntegrationNotification,
} from './types.js';

const log = createChildLogger({ integration: 'whatsapp' });
const baileysLogger = pino({ level: 'silent' });

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isWhatsAppJid(jid: string): boolean {
  return (
    jid.endsWith('@g.us') ||
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@lid')
  );
}

export function dataUrlToBuffer(value: string): Buffer | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:image\/[A-Za-z0-9.+-]+;base64,(.+)$/);
  if (!match) return null;
  const encoded = match[1].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const buffer = Buffer.from(encoded, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

export function getReadReceiptKey(
  key: WAMessageKey,
): Pick<WAMessageKey, 'remoteJid' | 'id' | 'participant'> | null {
  if (!key.remoteJid || !key.id || key.fromMe) return null;
  return {
    remoteJid: key.remoteJid,
    id: key.id,
    participant: key.participant,
  };
}

async function qrToDataUrl(qrData: string): Promise<string> {
  try {
    return await (
      QRCode as {
        toDataURL(text: string, opts: Record<string, unknown>): Promise<string>;
      }
    ).toDataURL(qrData, { width: 300, margin: 2 });
  } catch {
    // Fallback: return empty image
    return '';
  }
}

function normalizeWhatsAppParticipantJid(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('WhatsApp participant identifier cannot be empty');
  }
  if (
    trimmed.endsWith('@s.whatsapp.net') ||
    trimmed.endsWith('@lid') ||
    trimmed.endsWith('@g.us')
  ) {
    return trimmed;
  }
  const signalPhoneMatch = trimmed.match(/^signal:user:(\+\d+)$/);
  if (signalPhoneMatch) {
    return `${signalPhoneMatch[1].replace(/[^\d]/g, '')}@s.whatsapp.net`;
  }
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length >= 7) {
    return `${digits}@s.whatsapp.net`;
  }
  throw new Error(`Unsupported WhatsApp participant identifier: ${trimmed}`);
}
const AUTH_DIR = path.join(STORE_DIR, 'auth');
const STATUS_FILE = path.join(STORE_DIR, 'auth-status.txt');
const QR_DATA_FILE = path.join(STORE_DIR, 'qr-data.txt');

// ---------------------------------------------------------------------------
// WhatsApp Channel
// ---------------------------------------------------------------------------

class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private sentMessageCache = new Map<string, ProtoTypes.IMessage>();
  private groupMetadataCache = new Map<
    string,
    { metadata: GroupMetadata; expiresAt: number }
  >();
  private botLidUser?: string;
  private pendingFirstOpen?: () => void;

  constructor(private opts: ChannelOpts) {}

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingFirstOpen = resolve;
      this.connectInternal().catch(reject);
    });
  }

  private async connectInternal(): Promise<void> {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
      version: undefined,
    }));

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.appropriate('Chrome'),
      cachedGroupMetadata: async (jid: string) => {
        if (!jid.endsWith('@g.us')) return undefined;
        try {
          return await this.sock.groupMetadata(jid);
        } catch {
          return undefined;
        }
      },
      getMessage: async (key: WAMessageKey) => {
        const cached = this.sentMessageCache.get(key.id || '');
        if (cached) return cached;
        const content =
          key.id && key.remoteJid
            ? getMessageContentById(key.id, key.remoteJid)
            : undefined;
        if (content) {
          return proto.Message.fromObject({ conversation: content });
        }
        // Return undefined — NOT an empty message object.
        // Returning {} makes WhatsApp think there's a message but can't
        // decrypt it, causing "Waiting for this message" on recipients.
        return undefined as unknown as ProtoTypes.IMessage;
      },
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Write QR data for the setup wizard to poll
        try {
          fs.writeFileSync(QR_DATA_FILE, qr);
          fs.writeFileSync(STATUS_FILE, 'awaiting_scan');
        } catch {
          // ignore
        }
        log.warn('WhatsApp QR code generated — authenticate via admin UI');
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        log.info({ reason, shouldReconnect }, 'Connection closed');

        if (shouldReconnect) {
          log.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            log.error({ err }, 'Reconnect failed, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                log.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          log.warn('Logged out — re-authenticate via admin UI');
        }
      } else if (connection === 'open') {
        this.connected = true;
        log.info('Connected to WhatsApp');

        // Write status for setup wizard
        try {
          fs.writeFileSync(STATUS_FILE, 'authenticated');
          autoEnable();
          fs.unlinkSync(QR_DATA_FILE);
        } catch {
          // ignore
        }

        this.sock.sendPresenceUpdate('available').catch(() => {});

        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.setLidPhoneMapping(lidUser, `${phoneUser}@s.whatsapp.net`);
            this.botLidUser = lidUser;
          }
        }

        this.flushOutgoingQueue().catch(() => {});
        this.syncGroupMetadata().catch(() => {});
        // Delay profile updates to avoid interfering with initial key exchange
        setTimeout(() => {
          this.applyPendingProfileUpdates().catch((err) => {
            log.error(
              { err },
              'Failed to apply pending WhatsApp profile updates',
            );
          });
        }, 10000);

        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch(() => {});
          }, GROUP_SYNC_INTERVAL_MS);
        }

        if (this.pendingFirstOpen) {
          this.pendingFirstOpen();
          this.pendingFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    // Phone number share events (Baileys version-dependent)
    try {
      (this.sock.ev as any).on(
        'chats.phoneNumberShare',
        (data: { lid?: string; jid?: string }) => {
          const lidUser = data.lid?.split('@')[0].split(':')[0];
          if (lidUser && data.jid) {
            this.setLidPhoneMapping(lidUser, data.jid);
          }
        },
      );
    } catch {
      // Event not available in this Baileys version
    }

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;
          await this.markMessageRead(msg.key);

          let chatJid = await this.translateJid(rawJid);
          if (
            chatJid.endsWith('@lid') &&
            (msg.key as Record<string, unknown>).senderPn
          ) {
            const pn = (msg.key as Record<string, unknown>).senderPn as string;
            const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
            this.setLidPhoneMapping(
              rawJid.split('@')[0].split(':')[0],
              phoneJid,
            );
            chatJid = phoneJid;
          }

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Deliver ALL messages to the host — the host's onMessage handler
          // decides whether to auto-register new chats or process existing ones.
          // This ensures WhatsApp works the same as Signal for group context.
          let content =
            normalized.conversation ||
            normalized.extendedTextMessage?.text ||
            normalized.imageMessage?.caption ||
            normalized.videoMessage?.caption ||
            '';

          if (this.botLidUser && content.includes(`@${this.botLidUser}`)) {
            content = content.replace(
              `@${this.botLidUser}`,
              `@${ASSISTANT_NAME}`,
            );
          }

          // Skip protocol messages with no text content
          if (!content) continue;

          const rawSender = msg.key.participant || msg.key.remoteJid || '';
          const sender = rawSender ? await this.translateJid(rawSender) : '';
          const senderName = msg.pushName || sender.split('@')[0];
          const fromMe = msg.key.fromMe || false;
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        } catch (err) {
          log.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Message processing error',
          );
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      log.warn({ jid }, 'WhatsApp not connected; queueing outbound message');
      this.outgoingQueue.push({ jid, text: prefixed });
      return;
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      if (sent?.key?.id && sent.message) {
        this.sentMessageCache.set(sent.key.id, sent.message);
        if (this.sentMessageCache.size > 256) {
          const oldest = this.sentMessageCache.keys().next().value!;
          this.sentMessageCache.delete(oldest);
        }
      }
      log.info(
        { jid, messageId: sent?.key?.id },
        'WhatsApp outbound message sent',
      );
    } catch (err) {
      log.error({ err, jid }, 'WhatsApp outbound send failed');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return isWhatsAppJid(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      await this.sock.sendPresenceUpdate(
        isTyping ? 'composing' : 'paused',
        jid,
      );
    } catch {
      // best effort
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  async getGroups(): Promise<ChannelGroupLookupResult[]> {
    const groups = await this.sock.groupFetchAllParticipating();
    return Promise.all(
      Object.entries(groups).map(async ([jid, metadata]) => {
        const normalized = await this.getNormalizedGroupMetadata(jid, true);
        return {
          id: jid,
          jid,
          name: metadata.subject || normalized?.subject || jid,
          members: (normalized?.participants || []).map(
            (participant) => participant.id,
          ),
        };
      }),
    );
  }

  async findGroupByName(
    name: string,
  ): Promise<ChannelGroupLookupResult | null> {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) return null;
    const groups = await this.getGroups();
    return (
      groups.find(
        (group) => group.name.trim().toLowerCase() === normalizedName,
      ) || null
    );
  }

  async createGroup(input: {
    title: string;
    members: string[];
    message?: string;
  }): Promise<{ jid: string; title: string }> {
    const title = input.title.trim();
    if (!title) throw new Error('WhatsApp group title is required');
    const participants = input.members.map(normalizeWhatsAppParticipantJid);
    const created = await this.sock.groupCreate(title, participants);
    updateChatName(created.id, created.subject || title);
    this.groupMetadataCache.delete(created.id);
    if (input.message?.trim()) {
      await this.sendMessage(created.id, input.message.trim());
    }
    return {
      jid: created.id,
      title: created.subject || title,
    };
  }

  async addMembers(groupId: string, members: string[]): Promise<void> {
    const participants = members.map(normalizeWhatsAppParticipantJid);
    await this.sock.groupParticipantsUpdate(groupId, participants, 'add');
    this.groupMetadataCache.delete(groupId);
  }

  async leaveGroup(groupId: string): Promise<void> {
    await this.sock.groupLeave(groupId);
    this.groupMetadataCache.delete(groupId);
  }

  async updateOwnProfile(values: Record<string, string>): Promise<void> {
    const name = values.name?.trim() || '';
    const about = values.about?.trim() || '';
    const avatar = values.avatar?.trim() || '';

    if (name) {
      await this.sock.updateProfileName(name);
    }
    await this.sock.updateProfileStatus(about);

    if (avatar) {
      const imageBuffer = dataUrlToBuffer(avatar);
      if (imageBuffer) {
        const selfJid = this.sock.user?.id;
        if (!selfJid) {
          throw new Error(
            'WhatsApp profile picture update requires an authenticated user',
          );
        }
        await this.sock.updateProfilePicture(selfJid, imageBuffer);
      }
    }
  }

  async getOwnProfilePhotoUrl(): Promise<string> {
    const selfJid = this.sock.user?.id;
    if (!selfJid) return '';
    try {
      return (await this.sock.profilePictureUrl(selfJid, 'image', 5000)) || '';
    } catch {
      return '';
    }
  }

  private async applyPendingProfileUpdates(): Promise<void> {
    const settings = getIntegrationSettings('whatsapp');
    if (!settings.profileSyncPending) return;

    await this.updateOwnProfile({
      name: String(settings.profileName || ''),
      about: String(settings.profileAbout || ''),
      avatar: String(settings.profileAvatarDataUrl || ''),
    });

    saveIntegrationSettings('whatsapp', {
      ...settings,
      profileSyncPending: false,
      profileLastSyncedAt: new Date().toISOString(),
    });
  }

  private async markMessageRead(key: WAMessageKey): Promise<void> {
    const receiptKey = getReadReceiptKey(key);
    if (!receiptKey) return;
    try {
      await this.sock.sendReceipts([receiptKey], 'read');
    } catch (err) {
      log.debug(
        { err, remoteJid: receiptKey.remoteJid, id: receiptKey.id },
        'Failed to mark WhatsApp message as read',
      );
    }
  }

  private async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) return;
      }
    }
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          this.groupMetadataCache.delete(jid);
          count++;
        }
      }
      setLastGroupSync();
      log.info({ count }, 'Group metadata synced');
    } catch (err) {
      log.error({ err }, 'Group sync failed');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) return cached;
    try {
      const pn = await (
        this.sock.signalRepository as unknown as {
          lidMapping?: {
            getPNForLID(jid: string): Promise<string | undefined>;
          };
        }
      )?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.setLidPhoneMapping(lidUser, phoneJid);
        return phoneJid;
      }
    } catch {
      // fallback
    }
    return jid;
  }

  private setLidPhoneMapping(lidUser: string, phoneJid: string): void {
    if (this.lidToPhoneMap[lidUser] === phoneJid) return;
    this.lidToPhoneMap[lidUser] = phoneJid;
    this.groupMetadataCache.clear();
  }

  private async getNormalizedGroupMetadata(
    jid: string,
    forceRefresh = false,
  ): Promise<GroupMetadata | undefined> {
    if (!jid.endsWith('@g.us')) return undefined;
    const cached = this.groupMetadataCache.get(jid);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }
    const metadata = await this.sock.groupMetadata(jid);
    const participants = await Promise.all(
      metadata.participants.map(async (p) => ({
        ...p,
        id: await this.translateJid(p.id),
      })),
    );
    const normalized = { ...metadata, participants };
    this.groupMetadataCache.set(jid, {
      metadata: normalized,
      expiresAt: Date.now() + 60_000,
    });
    return normalized;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        try {
          const sent = await this.sock.sendMessage(item.jid, {
            text: item.text,
          });
          if (sent?.key?.id && sent.message) {
            this.sentMessageCache.set(sent.key.id, sent.message);
          }
          log.info(
            { jid: item.jid, messageId: sent?.key?.id },
            'Flushed queued WhatsApp outbound message',
          );
        } catch (err) {
          log.error(
            { err, jid: item.jid },
            'Failed to flush queued WhatsApp outbound message',
          );
          this.outgoingQueue.unshift(item);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Track channel instance for status checks
// ---------------------------------------------------------------------------

let channelInstance: WhatsAppChannel | null = null;

/** Persistent auth socket — kept alive during QR setup until auth completes. */
let authSocket: WASocket | null = null;

function hasCredentials(): boolean {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
}

function autoEnable(): void {
  try {
    const { isIntegrationEnabled, setIntegrationEnabled } =
      require('./settings-store.js') as {
        isIntegrationEnabled: (name: string) => boolean;
        setIntegrationEnabled: (name: string, enabled: boolean) => void;
      };
    if (!isIntegrationEnabled('whatsapp')) {
      setIntegrationEnabled('whatsapp', true);
      log.info('WhatsApp auto-enabled after successful authentication');
    }
  } catch {
    // ignore
  }
}

function cleanupAuthSocket(): void {
  if (authSocket) {
    try {
      authSocket.end(undefined);
    } catch {
      // ignore
    }
    authSocket = null;
  }
}

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

const whatsappIntegration: IntegrationDefinition = {
  name: 'whatsapp',
  description: 'WhatsApp via Baileys (WhatsApp Web client)',
  core: false,
  version: '1.0.0',
  credentials: [],

  settings: {
    schema: {
      type: 'object',
      properties: {
        assistantHasOwnNumber: {
          type: 'boolean',
          title: 'Dedicated bot number',
          description:
            'Enable if using a separate phone number for the bot. Disables message prefixing.',
          default: false,
        },
      },
    },
    defaults: { assistantHasOwnNumber: false },
  },

  adminPage: {
    icon: 'cilPhone',
    category: 'messaging',
    getStatus: async () => {
      if (!hasCredentials()) {
        return {
          state: 'unconfigured',
          message: 'Not authenticated — run setup from the integration page',
        };
      }
      if (channelInstance?.isConnected()) {
        return { state: 'online', message: 'Connected to WhatsApp' };
      }
      return { state: 'offline', message: 'Authenticated but not connected' };
    },
    getNotifications: async () => {
      const notifications: IntegrationNotification[] = [];
      if (!hasCredentials()) {
        notifications.push({
          id: 'whatsapp:not-authenticated',
          integration: 'whatsapp',
          severity: 'warning',
          title: 'WhatsApp Not Authenticated',
          message: 'Scan a QR code from the integration setup page.',
        });
      } else if (channelInstance && !channelInstance.isConnected()) {
        notifications.push({
          id: 'whatsapp:disconnected',
          integration: 'whatsapp',
          severity: 'error',
          title: 'WhatsApp Disconnected',
          message:
            'The WhatsApp connection dropped. It will auto-reconnect, or re-authenticate from the setup page.',
        });
      }
      return notifications;
    },
  },

  channel: (opts: ChannelOpts) => {
    if (!hasCredentials()) return null;
    channelInstance = new WhatsAppChannel(opts);
    return channelInstance;
  },

  tools: [
    {
      name: 'whatsapp.send_message',
      description: 'Send a WhatsApp message to a person or group.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient name, phone number, or WhatsApp JID',
          },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['to', 'text'],
      },
      location: 'host' as const,
      controllerOnly: true,
      execute: async (args, ctx) => {
        const to = args.to as string;
        const text = args.text as string;
        if (!ctx.sendMessage)
          throw new Error('Messaging context not available');
        // If it's already a WhatsApp JID, use directly
        const jid =
          to.endsWith('@s.whatsapp.net') || to.endsWith('@g.us')
            ? to
            : ctx.resolveRecipient
              ? await ctx.resolveRecipient(to)
              : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await ctx.sendMessage(jid, text);
        return JSON.stringify({ status: 'sent', to: jid });
      },
    },
    {
      name: 'whatsapp.reply',
      description: 'Reply in the current WhatsApp conversation.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Reply text' },
        },
        required: ['text'],
      },
      location: 'host' as const,
      execute: async (args, ctx) => {
        const text = args.text as string;
        if (!ctx.chatJid || !ctx.sendMessage)
          throw new Error('Chat context not available');
        await ctx.sendMessage(ctx.chatJid, text);
        return JSON.stringify({ status: 'sent' });
      },
    },
    {
      name: 'whatsapp.create_group',
      description: 'Create a new WhatsApp group.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Group name' },
          members: {
            type: 'array',
            items: { type: 'string' },
            description: 'Member phone numbers',
          },
          message: { type: 'string', description: 'Optional initial message' },
        },
        required: ['title', 'members'],
      },
      location: 'host' as const,
      controllerOnly: true,
      execute: async (args, ctx) => {
        if (!channelInstance?.isConnected())
          throw new Error('WhatsApp not connected');
        const result = await channelInstance.createGroup({
          title: args.title as string,
          members: args.members as string[],
          message: args.message as string | undefined,
        });
        return JSON.stringify(result);
      },
    },
    {
      name: 'whatsapp.add_group_members',
      description: 'Add members to an existing WhatsApp group.',
      parameters: {
        type: 'object',
        properties: {
          groupName: {
            type: 'string',
            description: 'Group name to search for',
          },
          members: {
            type: 'array',
            items: { type: 'string' },
            description: 'Phone numbers to add',
          },
        },
        required: ['groupName', 'members'],
      },
      location: 'host' as const,
      controllerOnly: true,
      execute: async (args, ctx) => {
        if (!channelInstance?.isConnected())
          throw new Error('WhatsApp not connected');
        const group = await channelInstance.findGroupByName(
          args.groupName as string,
        );
        if (!group)
          throw new Error(`WhatsApp group "${args.groupName}" not found`);
        await channelInstance.addMembers(group.id, args.members as string[]);
        return JSON.stringify({ status: 'members_added', group: group.name });
      },
    },
    {
      name: 'whatsapp.list_groups',
      description: 'List all WhatsApp groups.',
      parameters: { type: 'object', properties: {} },
      location: 'host' as const,
      controllerOnly: true,
      execute: async () => {
        if (!channelInstance?.isConnected())
          throw new Error('WhatsApp not connected');
        const groups = await channelInstance.getGroups();
        return JSON.stringify(groups);
      },
    },
  ],

  memory: {
    contextChars: 200,
  },

  profile: {
    label: 'WhatsApp Profile',
    fields: [
      { key: 'name', label: 'Profile Name', type: 'text' },
      { key: 'about', label: 'Status / About', type: 'text' },
      { key: 'avatar', label: 'Profile Photo', type: 'image' },
    ],
    getProfile: async () => {
      const settings = getIntegrationSettings('whatsapp');
      const liveAvatar = channelInstance?.isConnected()
        ? await channelInstance.getOwnProfilePhotoUrl()
        : '';
      return {
        name: (settings.profileName as string) || '',
        about: (settings.profileAbout as string) || '',
        avatar:
          liveAvatar ||
          (settings.profileAvatarDataUrl as string) ||
          (settings.profileAvatarUrl as string) ||
          '',
      };
    },
    saveProfile: async (values) => {
      const existing = getIntegrationSettings('whatsapp');
      const avatarValue = values.avatar || '';
      const avatarDataUrl = dataUrlToBuffer(avatarValue) ? avatarValue : '';
      const nextSettings = {
        ...existing,
        profileName: values.name || '',
        profileAbout: values.about || '',
        profileAvatarDataUrl: avatarDataUrl,
        profileAvatarUrl:
          avatarValue.startsWith('http://') ||
          avatarValue.startsWith('https://')
            ? avatarValue
            : '',
        profileUpdatedAt: new Date().toISOString(),
        profileSyncPending: true,
      };
      saveIntegrationSettings('whatsapp', nextSettings);

      if (channelInstance?.isConnected()) {
        try {
          await channelInstance.updateOwnProfile({
            name: values.name || '',
            about: values.about || '',
            avatar: values.avatar || '',
          });
          saveIntegrationSettings('whatsapp', {
            ...nextSettings,
            profileSyncPending: false,
            profileLastSyncedAt: new Date().toISOString(),
          });
          log.info('WhatsApp profile updated via Baileys');
        } catch (err) {
          log.error({ err }, 'Failed to update WhatsApp profile');
          throw err;
        }
      }
    },
  },

  setup: {
    steps: [
      {
        type: 'verification_code' as const,
        label: 'Link WhatsApp Device',
        description:
          'Enter your phone number to receive a pairing code, then enter it in WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead.',
        inputFields: [
          {
            key: 'phone',
            label: 'Phone number (with country code, no + or spaces)',
            type: 'text' as const,
            placeholder: '14155551234',
            required: true,
          },
        ],
        sendCode: async (input) => {
          const phone = (input.phone || '').replace(/[^0-9]/g, '');
          if (!phone || phone.length < 7) {
            throw new Error('Enter a valid phone number with country code');
          }

          fs.mkdirSync(AUTH_DIR, { recursive: true });
          cleanupAuthSocket();

          // Clear stale state
          try {
            fs.unlinkSync(STATUS_FILE);
          } catch {}
          try {
            fs.unlinkSync(QR_DATA_FILE);
          } catch {}

          fs.writeFileSync(STATUS_FILE, 'connecting');

          const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
          const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
            version: undefined,
          }));

          authSocket = makeWASocket({
            version,
            auth: {
              creds: state.creds,
              keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
            },
            printQRInTerminal: false,
            logger: baileysLogger,
            browser: Browsers.appropriate('Chrome'),
          });

          const sock = authSocket;
          sock.ev.on('creds.update', saveCreds);

          // Handle connection events — keep socket alive for the full handshake
          sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
              fs.writeFileSync(STATUS_FILE, 'authenticated');
              autoEnable();
              log.info('WhatsApp authenticated via pairing code');
              cleanupAuthSocket();
            }
            if (update.connection === 'close') {
              const reason = (
                update.lastDisconnect?.error as {
                  output?: { statusCode?: number };
                }
              )?.output?.statusCode;
              if (reason === 515) {
                // 515 = stream error after pairing — reconnect to finish
                log.info(
                  'Stream error (515) — reconnecting to finish handshake',
                );
                fs.writeFileSync(STATUS_FILE, 'reconnecting');
                setTimeout(async () => {
                  try {
                    const { state: s2, saveCreds: sc2 } =
                      await useMultiFileAuthState(AUTH_DIR);
                    const { version: v2 } = await fetchLatestWaWebVersion(
                      {},
                    ).catch(() => ({ version: undefined }));
                    authSocket = makeWASocket({
                      version: v2,
                      auth: {
                        creds: s2.creds,
                        keys: makeCacheableSignalKeyStore(
                          s2.keys,
                          baileysLogger,
                        ),
                      },
                      printQRInTerminal: false,
                      logger: baileysLogger,
                      browser: Browsers.appropriate('Chrome'),
                    });
                    authSocket.ev.on('creds.update', sc2);
                    authSocket.ev.on('connection.update', (u) => {
                      if (u.connection === 'open') {
                        fs.writeFileSync(STATUS_FILE, 'authenticated');
                        autoEnable();
                        log.info('WhatsApp authenticated after 515 reconnect');
                        cleanupAuthSocket();
                      }
                    });
                  } catch (err) {
                    log.error({ err }, 'Reconnect after 515 failed');
                    fs.writeFileSync(STATUS_FILE, 'failed');
                  }
                }, 2000);
              } else if (reason === DisconnectReason.loggedOut) {
                fs.writeFileSync(STATUS_FILE, 'failed');
              }
            }
          });

          // Wait for socket to be ready, then request pairing code
          await new Promise<void>((resolve) => setTimeout(resolve, 3000));

          try {
            const code = await sock.requestPairingCode(phone);
            fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
            log.info(
              { phone: phone.slice(0, 4) + '***' },
              'Pairing code generated',
            );
            return {
              message: `Your pairing code is: **${code}**\n\nOn your phone: WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead" → enter this code.`,
            };
          } catch (err) {
            cleanupAuthSocket();
            throw new Error(
              `Failed to request pairing code: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        verifyCode: async () => {
          // The pairing code flow doesn't need manual verification —
          // WhatsApp handles it automatically after the user enters
          // the code on their phone. We just check the status file.
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              if (hasCredentials()) {
                return { message: 'WhatsApp linked successfully!' };
              }
              if (fs.existsSync(STATUS_FILE)) {
                const status = fs.readFileSync(STATUS_FILE, 'utf-8').trim();
                if (status === 'authenticated') {
                  return { message: 'WhatsApp linked successfully!' };
                }
                if (status === 'failed') {
                  throw new Error('Pairing failed — try again');
                }
              }
            } catch (err) {
              if (err instanceof Error && err.message.includes('failed'))
                throw err;
            }
          }
          cleanupAuthSocket();
          throw new Error(
            'Timed out waiting for pairing to complete. Try again.',
          );
        },
        isComplete: async () => hasCredentials(),
      },
    ],
    getStatus: async () => {
      const authenticated = hasCredentials();
      return {
        completed: authenticated,
        currentStep: 0,
        steps: [
          {
            type: 'verification_code',
            label: 'Link WhatsApp Device',
            status: authenticated ? 'completed' : 'pending',
          },
        ],
      };
    },
  },
};

registerIntegration(whatsappIntegration);
