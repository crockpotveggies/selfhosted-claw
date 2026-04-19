import fs from 'fs';
import path from 'path';

import {
  inferMimeTypeFromPath,
  resolveAgentFilePath,
} from '../agent-path-resolver.js';
import { readEnvFile } from '../env.js';
import { createChildLogger } from '../logger.js';
import { resolveSmsSocketGatewayUrl } from '../sms-socket-gateway-url.js';
import type { Channel, NewMessage } from '../types.js';
import { normalizePhone } from '../contact-resolution.js';

import { registerIntegration } from './registry.js';
import {
  getIntegrationSettings,
  isIntegrationEnabled,
  saveIntegrationSettings,
  setIntegrationEnabled,
} from './settings-store.js';
import type {
  ChannelOpts,
  CredentialInputStep,
  IntegrationDefinition,
  IntegrationNotification,
} from './types.js';

const INTEGRATION_NAME = 'sms-socket';
const API_KEY_SETTING = 'SMS_SOCKET_API_KEY';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8787/';
const DEFAULT_REHYDRATE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const AGENT_SMS_DEDUP_WINDOW_MS = 30_000;
const RECONNECT_DELAY_MS = 3_000;

const log = createChildLogger({ integration: INTEGRATION_NAME });
const recentAgentSmsSends = new Map<string, number>();

interface SmsSocketEnvelope {
  id?: string;
  type?: string;
  requestId?: string;
  ok?: boolean;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface GatewayStateSnapshot {
  running?: boolean;
  enabled?: boolean;
  addresses?: string[];
  connectionCount?: number;
  apiKeyPreview?: string;
}

interface SmsSocketAttachmentPayload {
  id?: string;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  base64?: string;
  previewBase64?: string;
}

function getApiKey(settings?: Record<string, unknown>): string {
  const env = readEnvFile([API_KEY_SETTING]);
  return (
    env[API_KEY_SETTING] ||
    process.env[API_KEY_SETTING] ||
    String(settings?.[API_KEY_SETTING] || '')
  ).trim();
}

function getGatewayUrl(settings?: Record<string, unknown>): string {
  return String(settings?.gatewayUrl || DEFAULT_GATEWAY_URL).trim();
}

function getGatewayRelayHint(_settings?: Record<string, unknown>): string {
  // The Windows portproxy relay was removed — the container connects directly
  // to the gateway URL. Kept as a no-op so status/notification call sites stay
  // stable; can be inlined and deleted in a follow-up.
  return '';
}

function getRehydrateLimit(settings?: Record<string, unknown>): number {
  const parsed = Number(settings?.rehydrateLimit);
  if (!Number.isFinite(parsed)) return DEFAULT_REHYDRATE_LIMIT;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function getDefaultSubscriptionId(
  settings?: Record<string, unknown>,
): number | undefined {
  const raw = settings?.defaultSubscriptionId;
  if (raw == null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function getLastSeenTimestamp(settings?: Record<string, unknown>): number {
  const parsed = Number(settings?.lastSeenTimestamp);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return new Date(Number(value)).toISOString();
  }
  return new Date().toISOString();
}

export function makeSmsJid(value: string): string {
  const phone = normalizePhone(value);
  if (!phone || phone.replace(/[^\d]/g, '').length < 7) {
    throw new Error(`Invalid SMS phone number: ${value}`);
  }
  return `sms:${phone}`;
}

function messageKeyFor(
  type: string,
  payload: Record<string, unknown>,
  timestamp: number,
): string {
  const address = String(payload.address || payload.destination || '').trim();
  const body = String(payload.body || '').trim();
  const messageId = String(payload.messageId || payload.id || '').trim();
  const attachmentNames = getAttachmentPayloads(payload)
    .map((attachment) => attachment.fileName || attachment.id || '')
    .filter(Boolean)
    .join(',');
  return [type, messageId || address, timestamp, body, attachmentNames].join(
    '|',
  );
}

function consumeRecentAgentSmsSend(
  jid: string,
  text: string,
): 'fresh' | 'duplicate' {
  const now = Date.now();
  const key = `${jid}\0${text}`;
  const previous = recentAgentSmsSends.get(key);
  if (previous && now - previous < AGENT_SMS_DEDUP_WINDOW_MS) {
    return 'duplicate';
  }
  recentAgentSmsSends.set(key, now);
  if (recentAgentSmsSends.size > 512) {
    for (const [candidate, ts] of recentAgentSmsSends) {
      if (now - ts > AGENT_SMS_DEDUP_WINDOW_MS) {
        recentAgentSmsSends.delete(candidate);
      }
    }
  }
  return 'fresh';
}

function getAttachmentPayloads(
  payload: Record<string, unknown>,
): SmsSocketAttachmentPayload[] {
  const rawAttachments = payload.attachments;
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null,
    )
    .map((attachment) => ({
      id: typeof attachment.id === 'string' ? attachment.id : undefined,
      fileName: String(attachment.fileName || '').trim(),
      mimeType: String(attachment.mimeType || '').trim(),
      sizeBytes:
        typeof attachment.sizeBytes === 'number'
          ? attachment.sizeBytes
          : undefined,
      base64:
        typeof attachment.base64 === 'string' ? attachment.base64 : undefined,
      previewBase64:
        typeof attachment.previewBase64 === 'string'
          ? attachment.previewBase64
          : undefined,
    }))
    .filter((attachment) => attachment.fileName || attachment.id);
}

function describeMmsContent(payload: Record<string, unknown>): string {
  const body = String(payload.body || '').trim();
  const attachments = getAttachmentPayloads(payload);
  const attachmentSummary = attachments
    .map((attachment) => attachment.fileName || attachment.id || 'attachment')
    .filter(Boolean)
    .join(', ');
  if (body && attachmentSummary) {
    return `${body}\n[MMS attachment: ${attachmentSummary}]`;
  }
  if (body) return body;
  if (attachmentSummary) {
    return `[MMS attachment: ${attachmentSummary}]`;
  }
  return '[MMS attachment]';
}

export class SmsSocketChannel implements Channel {
  name = INTEGRATION_NAME;

  private connected = false;
  private stopped = false;
  private socket: WebSocket | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly seenMessages = new Set<string>();
  private requestCounter = 0;
  private gatewayState: GatewayStateSnapshot | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private settings: Record<string, unknown>;
  private lastSeenTimestamp: number;

  constructor(
    private readonly opts: ChannelOpts,
    initialSettings: Record<string, unknown>,
  ) {
    this.settings = { ...initialSettings };
    this.lastSeenTimestamp = getLastSeenTimestamp(initialSettings);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.refreshSettings(getIntegrationSettings(INTEGRATION_NAME));
    await this.ensureConnected();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.connectionGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('SMS Socket disconnected'));
    this.socket?.close();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sms:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const destination = jid.startsWith('sms:')
      ? jid.slice(4)
      : normalizePhone(jid);
    if (!destination || destination.replace(/[^\d]/g, '').length < 7) {
      throw new Error(`Unsupported SMS destination: ${jid}`);
    }

    const payload: Record<string, unknown> = {
      destination,
      body,
    };
    const subscriptionId = getDefaultSubscriptionId(this.settings);
    if (subscriptionId !== undefined) {
      payload.subscriptionId = subscriptionId;
    }
    await this.ensureConnected();
    try {
      await this.sendRequest('sendSms', payload);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('SMS Socket is not connected')
      ) {
        await this.ensureConnected();
        await this.sendRequest('sendSms', payload);
        return;
      }
      throw error;
    }
  }

  async sendAttachment(input: {
    jid: string;
    filePath: string;
    mimeType: string;
    caption?: string;
    fileName?: string;
  }): Promise<void> {
    const destination = input.jid.startsWith('sms:')
      ? input.jid.slice(4)
      : normalizePhone(input.jid);
    if (!destination || destination.replace(/[^\d]/g, '').length < 7) {
      throw new Error(`Unsupported MMS destination: ${input.jid}`);
    }

    const fileBuffer = fs.readFileSync(input.filePath);
    const fileName = input.fileName || path.basename(input.filePath);
    const payload: Record<string, unknown> = {
      destination,
      body: input.caption?.trim() || undefined,
      attachment: {
        fileName,
        mimeType: input.mimeType,
        sizeBytes: fileBuffer.byteLength,
        base64: fileBuffer.toString('base64'),
      } satisfies SmsSocketAttachmentPayload,
    };
    const subscriptionId = getDefaultSubscriptionId(this.settings);
    if (subscriptionId !== undefined) {
      payload.subscriptionId = subscriptionId;
    }

    await this.ensureConnected();
    try {
      await this.sendRequest('sendMms', payload);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('SMS Socket is not connected')
      ) {
        await this.ensureConnected();
        await this.sendRequest('sendMms', payload);
        return;
      }
      throw error;
    }
  }

  async resolveRecipient(name: string): Promise<string> {
    return makeSmsJid(name);
  }

  getGatewayState(): GatewayStateSnapshot | null {
    return this.gatewayState;
  }

  refreshSettings(next: Record<string, unknown>): void {
    this.settings = { ...next };
    this.lastSeenTimestamp = Math.max(
      this.lastSeenTimestamp,
      getLastSeenTimestamp(next),
    );
  }

  private async ensureConnected(): Promise<void> {
    if (
      this.connected &&
      this.socket &&
      this.socket.readyState === WebSocket.OPEN
    ) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopped = false;
    const generation = this.connectionGeneration;
    const attempt = this.openSocket(generation);
    void attempt.catch(() => {
      // Ensure background reconnect attempts never surface as unhandled rejections.
    });
    const trackedPromise = attempt.finally(() => {
      if (this.connectPromise === trackedPromise) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = trackedPromise;
    await trackedPromise;
  }

  private async openSocket(generation: number): Promise<void> {
    const apiKey = getApiKey(this.settings);
    if (!apiKey) {
      throw new Error('SMS Socket API key is not configured');
    }

    const wsUrl = resolveSmsSocketGatewayUrl(getGatewayUrl(this.settings));
    log.info(
      {
        gatewayUrl: wsUrl.toString(),
        hostNetwork: process.env.NANOCLAW_CONTROL_PLANE_NET === 'host',
      },
      'SMS Socket dialing gateway',
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let ready = false;
      const socket = new WebSocket(wsUrl);
      this.socket = socket;

      socket.onopen = async () => {
        if (this.stopped || generation !== this.connectionGeneration) {
          settled = true;
          socket.close();
          reject(new Error('SMS Socket connection was cancelled'));
          return;
        }
        try {
          await this.sendRequest('authenticate', undefined, socket);
          const state = await this.sendRequest(
            'getGatewayState',
            undefined,
            socket,
          );
          this.gatewayState = {
            running: state.running === true,
            enabled: state.enabled === true,
            addresses: Array.isArray(state.addresses)
              ? state.addresses.map((value) => String(value))
              : [],
            connectionCount: Number(state.connectionCount || 0),
            apiKeyPreview: String(state.apiKeyPreview || ''),
          };
          this.connected = true;
          await this.rehydrateHistory(socket);
          ready = true;
          settled = true;
          resolve();
        } catch (error) {
          settled = true;
          socket.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      socket.onmessage = (event) => {
        try {
          this.handleSocketMessage(event.data);
        } catch (error) {
          log.warn(
            { err: String(error) },
            'SMS Socket payload handling failed',
          );
        }
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`SMS Socket websocket failed for ${wsUrl.toString()}`),
        );
      };

      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.connected = false;
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `SMS Socket websocket closed before ready for ${wsUrl.toString()}`,
            ),
          );
        }
        if (
          ready &&
          !this.stopped &&
          generation === this.connectionGeneration
        ) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch((error) => {
        log.warn({ err: String(error) }, 'SMS Socket reconnect failed');
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private async rehydrateHistory(socket: WebSocket): Promise<void> {
    const payload = await this.sendRequest(
      'rehydrate',
      {
        since: this.lastSeenTimestamp,
        limit: getRehydrateLimit(this.settings),
      },
      socket,
    );
    const events = Array.isArray(payload.events) ? payload.events : [];
    for (const event of events) {
      this.handleGatewayEvent(event as SmsSocketEnvelope);
    }
  }

  private sendRequest(
    type: string,
    payload?: Record<string, unknown>,
    socket: WebSocket | null = this.socket,
  ): Promise<Record<string, unknown>> {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`SMS Socket is not connected for ${type}`);
    }

    const requestId = `sms-socket-${++this.requestCounter}`;
    const auth = getApiKey(this.settings);
    const envelope: Record<string, unknown> = {
      type,
      requestId,
      auth,
    };
    if (payload) {
      envelope.payload = payload;
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`SMS Socket ${type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });
      socket.send(JSON.stringify(envelope));
    });
  }

  private handleSocketMessage(raw: unknown): void {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf-8')
          : Buffer.from(raw as ArrayBufferLike).toString('utf-8');
    if (!text.trim()) return;

    const envelope = JSON.parse(text) as SmsSocketEnvelope;
    if (envelope.type === 'response') {
      const requestId = String(envelope.requestId || '');
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
      if (envelope.ok === false) {
        const detail = String(
          envelope.payload?.error || 'SMS Socket request failed',
        );
        pending.reject(new Error(detail));
      } else {
        pending.resolve(envelope.payload || {});
      }
      return;
    }

    this.handleGatewayEvent(envelope);
  }

  private handleGatewayEvent(envelope: SmsSocketEnvelope): void {
    const type = String(envelope.type || '');
    const payload = envelope.payload || {};
    const timestamp = Number(
      payload.receivedAt || envelope.timestamp || Date.now(),
    );

    if (type === 'gateway.state') {
      this.gatewayState = {
        running: payload.running === true,
        enabled: payload.enabled === true,
        addresses: Array.isArray(payload.addresses)
          ? payload.addresses.map((value) => String(value))
          : this.gatewayState?.addresses || [],
        connectionCount: Number(payload.connectionCount || 0),
        apiKeyPreview: String(payload.apiKeyPreview || ''),
      };
      this.persistLastSeen(timestamp);
      return;
    }

    if (!type.startsWith('sms.') && !type.startsWith('mms.')) {
      this.persistLastSeen(timestamp);
      return;
    }

    const dedupeKey = messageKeyFor(type, payload, timestamp);
    if (this.seenMessages.has(dedupeKey)) return;
    this.seenMessages.add(dedupeKey);
    if (this.seenMessages.size > 512) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest) this.seenMessages.delete(oldest);
    }

    if (
      type === 'sms.received' ||
      type === 'sms.outbound.sent' ||
      type === 'mms.received' ||
      type === 'mms.outbound.sent' ||
      type === 'mms.outbound.delivered'
    ) {
      const normalized = this.normalizeEventMessage(
        type,
        payload,
        timestamp,
        envelope,
      );
      if (normalized) {
        this.opts.onChatMetadata(
          normalized.chat_jid,
          normalized.timestamp,
          undefined,
          INTEGRATION_NAME,
          false,
        );
        this.opts.onMessage(normalized.chat_jid, normalized);
      }
    }

    this.persistLastSeen(timestamp);
  }

  private normalizeEventMessage(
    type: string,
    payload: Record<string, unknown>,
    timestamp: number,
    envelope: SmsSocketEnvelope,
  ): NewMessage | null {
    const address = normalizePhone(
      String(payload.address || payload.destination || ''),
    );
    const body = type.startsWith('mms.')
      ? describeMmsContent(payload)
      : String(payload.body || '').trim();
    if (!address || !body) return null;

    const chatJid = makeSmsJid(address);
    const isFromMe =
      type === 'sms.outbound.sent' ||
      type === 'mms.outbound.sent' ||
      type === 'mms.outbound.delivered';
    const isoTimestamp = toIsoTimestamp(
      payload.receivedAt || envelope.timestamp || timestamp,
    );

    return {
      id:
        String(payload.messageId || envelope.id || '').trim() ||
        `sms-${type}-${address}-${timestamp}-${body.length}`,
      chat_jid: chatJid,
      sender: address,
      sender_name: isFromMe ? 'You' : address,
      content: body,
      timestamp: isoTimestamp,
      is_from_me: isFromMe,
      is_bot_message: isFromMe,
    };
  }

  private persistLastSeen(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp <= this.lastSeenTimestamp)
      return;
    this.lastSeenTimestamp = timestamp;
    saveIntegrationSettings(INTEGRATION_NAME, {
      ...getIntegrationSettings(INTEGRATION_NAME),
      lastSeenTimestamp: timestamp,
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }
}

let channelInstance: SmsSocketChannel | null = null;

const credentialStep: CredentialInputStep = {
  type: 'credential_input',
  label: 'SMS Socket API Key',
  description:
    'Install the Android SMS Socket app, start the local gateway, then paste the API key it generates.',
  helpUrl: 'https://github.com/crockpotveggies/sms-socket-app',
  fields: [
    {
      key: API_KEY_SETTING,
      label: 'API Key',
      type: 'password',
      required: true,
    },
  ],
  validate: async (values) => {
    const apiKey = String(values[API_KEY_SETTING] || '').trim();
    if (!apiKey) {
      return { valid: false, error: 'API key is required' };
    }
    return { valid: true };
  },
  save: async (values) => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    saveIntegrationSettings(INTEGRATION_NAME, {
      ...settings,
      [API_KEY_SETTING]: String(values[API_KEY_SETTING] || '').trim(),
    });
    if (!isIntegrationEnabled(INTEGRATION_NAME)) {
      setIntegrationEnabled(INTEGRATION_NAME, true);
    }
    channelInstance?.refreshSettings(getIntegrationSettings(INTEGRATION_NAME));
  },
  isComplete: async () =>
    Boolean(getApiKey(getIntegrationSettings(INTEGRATION_NAME))),
};

const smsSocketIntegration: IntegrationDefinition = {
  name: INTEGRATION_NAME,
  description: 'Android SMS gateway over a local WebSocket connection',
  core: false,
  version: '1.0.0',
  credentials: [
    {
      key: API_KEY_SETTING,
      label: 'SMS Socket API Key',
      type: 'api_key',
      envVar: API_KEY_SETTING,
      required: true,
    },
  ],
  settings: {
    schema: {
      type: 'object',
      properties: {
        [API_KEY_SETTING]: {
          type: 'string',
          title: 'SMS Socket API Key',
          description: 'Stored locally for host-side SMS gateway access.',
          sensitive: true,
        },
        gatewayUrl: {
          type: 'string',
          title: 'Gateway URL',
          description: 'WebSocket URL for the Android gateway on your LAN.',
          format: 'url',
          default: DEFAULT_GATEWAY_URL,
        },
        defaultSubscriptionId: {
          type: 'integer',
          title: 'Default SIM Subscription ID',
          description:
            'Optional SIM subscription ID to use when the Android device has multiple active SIMs.',
        },
        rehydrateLimit: {
          type: 'integer',
          title: 'Rehydrate Limit',
          description:
            'How many SMS history events to request after reconnecting.',
          default: DEFAULT_REHYDRATE_LIMIT,
          minimum: 1,
          maximum: 500,
        },
        lastSeenTimestamp: {
          type: 'integer',
          title: 'Last Seen Timestamp',
          description: 'Internal cursor for gateway history replay.',
        },
      },
    },
    defaults: {
      [API_KEY_SETTING]: '',
      gatewayUrl: DEFAULT_GATEWAY_URL,
      defaultSubscriptionId: '',
      rehydrateLimit: DEFAULT_REHYDRATE_LIMIT,
      lastSeenTimestamp: 0,
    },
    validate: (values) => {
      const errors: Record<string, string> = {};
      try {
        resolveSmsSocketGatewayUrl(
          String(values.gatewayUrl || DEFAULT_GATEWAY_URL),
          {
            inContainer: false,
            relayPort: null,
          },
        );
      } catch (error) {
        errors.gatewayUrl =
          error instanceof Error ? error.message : 'Invalid gateway URL';
      }
      const subscriptionId = values.defaultSubscriptionId;
      if (
        subscriptionId !== '' &&
        subscriptionId != null &&
        !Number.isFinite(Number(subscriptionId))
      ) {
        errors.defaultSubscriptionId =
          'Default SIM subscription must be a number';
      }
      return Object.keys(errors).length > 0 ? errors : null;
    },
  },
  adminPage: {
    icon: 'cilChatBubble',
    category: 'messaging',
    getStatus: async (ctx) => {
      const apiKey = getApiKey(ctx.settings);
      if (!apiKey) {
        return {
          state: 'unconfigured',
          message: 'API key not configured',
        };
      }

      if (channelInstance?.isConnected()) {
        const state = channelInstance.getGatewayState();
        const address = state?.addresses?.[0];
        return {
          state: 'online',
          message: address
            ? `Connected to SMS gateway at ${address}`
            : `Connected to SMS gateway.${getGatewayRelayHint(ctx.settings)}`,
        };
      }

      return {
        state: 'offline',
        message: `Configured but not connected to ${getGatewayUrl(ctx.settings)}.${getGatewayRelayHint(ctx.settings)}`,
      };
    },
    getNotifications: async (ctx) => {
      const notifications: IntegrationNotification[] = [];
      const apiKey = getApiKey(ctx.settings);
      if (!apiKey) {
        notifications.push({
          id: 'sms-socket:missing-api-key',
          integration: INTEGRATION_NAME,
          severity: 'warning',
          title: 'SMS Socket Not Configured',
          message:
            'Install the Android SMS Socket app and add its API key from the setup page.',
        });
        return notifications;
      }

      if (!channelInstance?.isConnected()) {
        notifications.push({
          id: 'sms-socket:offline',
          integration: INTEGRATION_NAME,
          severity: 'error',
          title: 'SMS Socket Offline',
          message:
            'The Android SMS gateway is not reachable. Check the gateway URL, device network, and foreground service.',
        });
      }

      return notifications;
    },
  },
  channel: (opts: ChannelOpts) => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    if (!getApiKey(settings)) return null;
    channelInstance = new SmsSocketChannel(opts, settings);
    return channelInstance;
  },
  tools: [
    {
      name: 'sms_socket.send_message',
      description:
        'Send an SMS message to a phone number. This tool IS the user-visible message — do not also produce a text reply summarising what you sent. After calling this tool, return an empty text response to end your turn.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient phone number or sms:+E164 JID',
          },
          text: {
            type: 'string',
            description: 'Message text',
          },
        },
        required: ['to', 'text'],
      },
      location: 'host' as const,
      controllerOnly: true,
      execute: async (args, ctx) => {
        const text = String(args.text || '').trim();
        const to = String(args.to || '').trim();
        if (!text) throw new Error('text is required');
        if (!to) throw new Error('to is required');
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as SmsSocketChannel | undefined;
        if (!channel) throw new Error('SMS Socket channel is not connected');
        const jid = to.startsWith('sms:')
          ? to
          : await channel.resolveRecipient(to);
        if (consumeRecentAgentSmsSend(jid, text) === 'duplicate') {
          log.warn({ jid }, 'Suppressed duplicate agent SMS send');
          return JSON.stringify({ status: 'duplicate', to: jid });
        }
        await channel.sendMessage(jid, text);
        return JSON.stringify({ status: 'sent', to: jid });
      },
    },
    {
      name: 'sms_socket.reply',
      description:
        'Reply in the current SMS conversation. This tool IS the user-visible reply — do not also produce a text response summarising what you replied. After calling this tool, return an empty text response to end your turn.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Reply text',
          },
        },
        required: ['text'],
      },
      location: 'host' as const,
      execute: async (args, ctx) => {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text is required');
        if (!ctx.chatJid || !ctx.chatJid.startsWith('sms:')) {
          throw new Error('Chat context is not an SMS conversation');
        }
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        );
        if (!channel?.sendMessage) {
          throw new Error('SMS Socket channel is not connected');
        }
        if (consumeRecentAgentSmsSend(ctx.chatJid, text) === 'duplicate') {
          log.warn(
            { jid: ctx.chatJid },
            'Suppressed duplicate agent SMS reply',
          );
          return JSON.stringify({ status: 'duplicate', to: ctx.chatJid });
        }
        await channel.sendMessage(ctx.chatJid, text);
        return JSON.stringify({ status: 'sent', to: ctx.chatJid });
      },
    },
    {
      name: 'sms_socket.send_file',
      description:
        'Send a file over MMS to a phone number or the current SMS conversation. The path can be an agent-visible container path (e.g. /workspace/group/report.pdf) or an absolute host path. This tool IS the user-visible attachment - do not also produce a text reply summarising what you sent. After calling this tool, return an empty text response to end your turn.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient phone number or sms:+E164 JID. Omit to send to the current conversation.',
          },
          file_path: {
            type: 'string',
            description:
              'Path to the file being uploaded. Agent-visible paths under /workspace/group, /workspace/global, and /workspace/state are auto-translated to their host equivalents.',
          },
          caption: {
            type: 'string',
            description: 'Optional message body to send alongside the file.',
          },
          file_name: {
            type: 'string',
            description:
              'Optional override for the visible file name. Defaults to basename(file_path).',
          },
        },
        required: ['file_path'],
      },
      location: 'host' as const,
      controllerOnly: true,
      execute: async (args, ctx) => {
        const rawFilePath = String(args.file_path || '').trim();
        if (!rawFilePath) throw new Error('file_path is required');
        const filePath = resolveAgentFilePath(rawFilePath, ctx.sourceGroup);
        if (!fs.existsSync(filePath)) {
          throw new Error(
            `file_path does not exist: ${rawFilePath}` +
              (rawFilePath === filePath
                ? ''
                : ` (resolved host path: ${filePath})`),
          );
        }
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as
          | (SmsSocketChannel & {
              sendAttachment?: (input: {
                jid: string;
                filePath: string;
                mimeType: string;
                caption?: string;
                fileName?: string;
              }) => Promise<void>;
            })
          | undefined;
        if (!channel?.sendAttachment) {
          throw new Error('SMS Socket channel is not connected');
        }
        const targetRaw =
          String(args.to || '').trim() || String(ctx.chatJid || '').trim();
        if (!targetRaw) {
          throw new Error(
            'No target SMS conversation - provide "to" or use inside an SMS chat',
          );
        }
        const jid = targetRaw.startsWith('sms:')
          ? targetRaw
          : await channel.resolveRecipient(targetRaw);
        const caption = String(args.caption || '').trim();
        const fileName =
          String(args.file_name || '').trim() || path.basename(filePath);
        const mimeType = inferMimeTypeFromPath(filePath);
        await channel.sendAttachment({
          jid,
          filePath,
          mimeType,
          caption: caption || undefined,
          fileName,
        });
        return JSON.stringify({
          status: 'uploaded',
          to: jid,
          file_name: fileName,
          ack_text: `Uploaded ${fileName} to MMS.`,
          agent_instruction:
            'Reply to the user with ack_text verbatim. No commentary, no emoji, no rephrasing.',
        });
      },
    },
  ],
  memory: {
    contextChars: 200,
  },
  setup: {
    steps: [credentialStep],
    getStatus: async () => {
      const completed = await credentialStep.isComplete();
      return {
        completed,
        currentStep: completed ? 1 : 0,
        steps: [
          {
            type: 'credential_input',
            label: credentialStep.label,
            description:
              'Download the Android app, start its gateway, and paste the generated API key.',
            status: completed ? 'completed' : 'pending',
          },
        ],
      };
    },
  },
  lifecycle: {
    onReconnect: async (ctx) => {
      if (!channelInstance) {
        throw new Error('SMS Socket channel is not initialized');
      }
      channelInstance.refreshSettings(ctx.settings);
      await channelInstance.disconnect();
      await channelInstance.connect();
    },
    onSettingsChange: async (_prev, next) => {
      channelInstance?.refreshSettings(next);
    },
  },
};

registerIntegration(smsSocketIntegration);
