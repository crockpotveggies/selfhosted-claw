import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { ASSISTANT_NAME } from '../config.js';
import {
  inferMimeTypeFromPath,
  resolveAgentFilePath,
} from '../agent-path-resolver.js';
import { canonicalizeIdentity } from '../control-identities.js';
import { ControlStore } from '../control-store.js';
import { createChildLogger } from '../logger.js';
import type {
  Channel,
  ChannelGroupLookupResult,
  NewMessage,
} from '../types.js';

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
  FormSetupStep,
  IntegrationDefinition,
  IntegrationNotification,
} from './types.js';

const INTEGRATION_NAME = 'slack';
const BOT_TOKEN_SETTING = 'SLACK_BOT_TOKEN';
const APP_TOKEN_SETTING = 'SLACK_APP_TOKEN';
const CONTROLLER_IDENTITY_SETTING = 'controllerSlackIdentity';
const CONTROLLER_LABEL_SETTING = 'controllerSlackLabel';
const SLACK_API_BASE = 'https://slack.com/api';
const SLACK_HELP_URL = 'https://api.slack.com/apps';
const MAX_SLACK_MESSAGE_CHARS = 3500;

const log = createChildLogger({ integration: INTEGRATION_NAME });

interface SlackApiSuccess {
  ok: true;
  [key: string]: unknown;
}

interface SlackApiFailure {
  ok: false;
  error?: string;
  [key: string]: unknown;
}

type SlackApiResponse = SlackApiSuccess | SlackApiFailure;

interface SlackConversationInfo {
  id: string;
  name: string;
  isGroup: boolean;
  type: 'im' | 'channel' | 'group' | 'mpim' | 'unknown';
}

interface SlackSocketEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: SlackMessageEvent;
  };
}

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
}

function getStoredToken(
  key: string,
  settings?: Record<string, unknown>,
): string {
  const env = readEnvFile([key]);
  return (env[key] || process.env[key] || String(settings?.[key] || '')).trim();
}

function getBotToken(settings?: Record<string, unknown>): string {
  return getStoredToken(BOT_TOKEN_SETTING, settings);
}

function getAppToken(settings?: Record<string, unknown>): string {
  return getStoredToken(APP_TOKEN_SETTING, settings);
}

function normalizeControllerSlackIdentity(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Accept any of: bare user id ("U0A5GB3BJFL"), the "slack:user:…" event
  // form, or the already-canonical "slack-user:…" form. Previously this
  // only recognised "slack:user:", so an already-canonical input got
  // re-prefixed → re-canonicalised, stripping the colon and mangling it to
  // "slack-user:SLACKUSER…". That left a broken identity in storage that
  // no real inbound sender could ever match.
  if (trimmed.startsWith('slack-user:') || trimmed.startsWith('slack:user:')) {
    return canonicalizeIdentity(trimmed);
  }
  return canonicalizeIdentity(`slack:user:${trimmed}`);
}

function hasVerifiedSlackController(
  settings?: Record<string, unknown>,
): boolean {
  const identity = normalizeControllerSlackIdentity(
    String(settings?.[CONTROLLER_IDENTITY_SETTING] || ''),
  );
  if (!identity) return false;
  return new ControlStore()
    .getVerifiedIdentities()
    .some((item) => canonicalizeIdentity(item.identity) === identity);
}

function saveVerifiedSlackController(
  identityInput: string,
  labelInput: string,
): void {
  const identity = normalizeControllerSlackIdentity(identityInput);
  if (!identity) {
    throw new Error('Controller Slack identity is required');
  }
  if (!identity.startsWith('slack-user:')) {
    throw new Error('Controller Slack identity must be a Slack user identity');
  }

  const label = labelInput.trim() || 'Slack Controller';
  const store = new ControlStore();
  const existing = store.getVerifiedIdentities();
  const next = existing.some(
    (item) => canonicalizeIdentity(item.identity) === identity,
  )
    ? existing.map((item) =>
        canonicalizeIdentity(item.identity) === identity
          ? { ...item, label }
          : item,
      )
    : [
        ...existing,
        {
          identity,
          label,
          addedAt: new Date().toISOString(),
        },
      ];
  store.saveVerifiedIdentities(next);
}

export function isSlackJid(jid: string): boolean {
  return jid.startsWith('slack:');
}

export function makeSlackJid(conversationId: string): string {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    throw new Error('Slack conversation ID cannot be empty');
  }
  return `slack:${trimmed}`;
}

function toSlackConversationId(jid: string): string {
  return jid.startsWith('slack:') ? jid.slice('slack:'.length) : jid;
}

function isDirectMessageChannel(channelType?: string): boolean {
  return channelType === 'im';
}

function normalizeSlackText(text: string, selfUserId?: string): string {
  let normalized = text.trim();
  if (!normalized) return '';

  if (selfUserId) {
    const selfMention = new RegExp(`<@${selfUserId}>`, 'g');
    normalized = normalized.replace(selfMention, `@${ASSISTANT_NAME}`);
  }

  return normalized
    .replace(/<@([A-Z0-9]+)>/g, '@user')
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .trim();
}

export function shouldProcessSlackMessage(input: {
  text?: string;
  channelType?: string;
  selfUserId?: string;
  allowDirectMessages?: boolean;
  mentionOnlyInChannels?: boolean;
}): boolean {
  const text = String(input.text || '').trim();
  if (!text) return false;

  if (isDirectMessageChannel(input.channelType)) {
    return input.allowDirectMessages !== false;
  }

  if (input.mentionOnlyInChannels === false) return true;
  if (!input.selfUserId) return false;

  return text.includes(`<@${input.selfUserId}>`);
}

export function splitSlackMessage(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_SLACK_MESSAGE_CHARS) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > MAX_SLACK_MESSAGE_CHARS) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_SLACK_MESSAGE_CHARS);
    if (splitAt < MAX_SLACK_MESSAGE_CHARS / 2) {
      splitAt = remaining.lastIndexOf('\n', MAX_SLACK_MESSAGE_CHARS);
    }
    if (splitAt < MAX_SLACK_MESSAGE_CHARS / 2) {
      splitAt = remaining.lastIndexOf(' ', MAX_SLACK_MESSAGE_CHARS);
    }
    if (splitAt < MAX_SLACK_MESSAGE_CHARS / 2) {
      splitAt = MAX_SLACK_MESSAGE_CHARS;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

// Slack has two body-encoding conventions across Web API methods. Most JSON-
// friendly methods (chat.postMessage, conversations.list, etc.) accept
// application/json. A handful of legacy / file-transfer methods — notably
// files.getUploadURLExternal — only accept application/x-www-form-urlencoded
// and return `invalid_arguments` when sent JSON. Enumerate those explicitly
// so we pick the right encoding per method.
const FORM_ENCODED_SLACK_METHODS = new Set([
  'files.getUploadURLExternal',
]);

function encodeSlackFormBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.append(
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  return params.toString();
}

async function callSlackApi(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<SlackApiSuccess> {
  const useForm = FORM_ENCODED_SLACK_METHODS.has(method);
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': useForm
        ? 'application/x-www-form-urlencoded; charset=utf-8'
        : 'application/json; charset=utf-8',
    },
    body: useForm
      ? encodeSlackFormBody(body || {})
      : JSON.stringify(body || {}),
  });
  if (!response.ok) {
    throw new Error(`Slack API ${method} failed with ${response.status}`);
  }
  const payload = (await response.json()) as SlackApiResponse;
  if (!payload.ok) {
    throw new Error(
      `Slack API ${method} failed: ${String(payload.error || 'unknown_error')}`,
    );
  }
  return payload;
}

async function validateSlackCredentials(
  botToken: string,
  appToken: string,
): Promise<void> {
  if (!/^xoxb-/.test(botToken)) {
    throw new Error('Bot token must start with xoxb-');
  }
  if (!/^xapp-/.test(appToken)) {
    throw new Error('App token must start with xapp-');
  }

  await callSlackApi('auth.test', botToken);
  await callSlackApi('apps.connections.open', appToken);
}

function getMentionOnlyInChannels(settings?: Record<string, unknown>): boolean {
  return settings?.mentionOnlyInChannels !== false;
}

function getAllowDirectMessages(settings?: Record<string, unknown>): boolean {
  return settings?.allowDirectMessages !== false;
}

async function fetchSlackSocketUrl(appToken: string): Promise<string> {
  const payload = await callSlackApi('apps.connections.open', appToken);
  const url = String(payload.url || '').trim();
  if (!url) {
    throw new Error('Slack did not return a Socket Mode URL');
  }
  return url;
}

class SlackChannel implements Channel {
  name = INTEGRATION_NAME;
  capabilities = {
    attachments: {
      pdf: true,
      maxBytes: 25_000_000,
    },
  };

  private connected = false;
  private stopped = false;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private botToken: string;
  private appToken: string;
  private settings: Record<string, unknown>;
  private selfUserId = '';
  private readonly conversationCache = new Map<string, SlackConversationInfo>();
  private readonly userCache = new Map<string, string>();

  constructor(
    private readonly opts: ChannelOpts,
    initialSettings: Record<string, unknown>,
  ) {
    this.settings = { ...initialSettings };
    this.botToken = getBotToken(initialSettings);
    this.appToken = getAppToken(initialSettings);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.refreshSettings(getIntegrationSettings(INTEGRATION_NAME));

    const auth = await callSlackApi('auth.test', this.botToken);
    this.selfUserId = String(auth.user_id || '').trim();
    if (!this.selfUserId) {
      throw new Error('Slack bot auth did not return a bot user ID');
    }

    const socketUrl = await fetchSlackSocketUrl(this.appToken);
    await this.openSocket(socketUrl);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return isSlackJid(jid);
  }

  refreshSettings(next: Record<string, unknown>): void {
    this.settings = { ...next };
    this.botToken = getBotToken(next);
    this.appToken = getAppToken(next);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: { threadId?: string },
  ): Promise<void> {
    const channel = toSlackConversationId(jid);
    const chunks = splitSlackMessage(text);
    for (const chunk of chunks) {
      await callSlackApi('chat.postMessage', this.botToken, {
        channel,
        text: chunk,
        ...(options?.threadId ? { thread_ts: options.threadId } : {}),
      });
    }
  }

  async sendAttachment(input: {
    jid: string;
    filePath: string;
    mimeType: string;
    caption?: string;
    fileName?: string;
    threadId?: string;
  }): Promise<void> {
    const channel = toSlackConversationId(input.jid);
    const fileName = input.fileName || path.basename(input.filePath);
    const fileBuffer = fs.readFileSync(input.filePath);
    const uploadInfo = await callSlackApi(
      'files.getUploadURLExternal',
      this.botToken,
      {
        filename: fileName,
        length: fileBuffer.byteLength,
      },
    );
    const uploadUrl = String(uploadInfo.upload_url || '');
    const fileId = String(uploadInfo.file_id || '');
    if (!uploadUrl || !fileId) {
      throw new Error('Slack upload URL negotiation failed');
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': input.mimeType,
      },
      body: fileBuffer,
    });
    if (!uploadResponse.ok) {
      throw new Error(`Slack file upload failed with ${uploadResponse.status}`);
    }

    await callSlackApi('files.completeUploadExternal', this.botToken, {
      files: [{ id: fileId, title: fileName }],
      channel_id: channel,
      initial_comment: input.caption || '',
      ...(input.threadId ? { thread_ts: input.threadId } : {}),
    });
  }

  async syncGroups(): Promise<void> {
    let cursor = '';
    do {
      const payload = await callSlackApi('conversations.list', this.botToken, {
        types: 'public_channel,private_channel,mpim,im',
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });

      const channels = Array.isArray(payload.channels)
        ? (payload.channels as Array<Record<string, unknown>>)
        : [];

      for (const channel of channels) {
        const info = this.mapConversation(channel);
        this.conversationCache.set(info.id, info);
      }

      cursor = String(
        (payload.response_metadata as { next_cursor?: string } | undefined)
          ?.next_cursor || '',
      ).trim();
    } while (cursor);
  }

  async getGroups(): Promise<ChannelGroupLookupResult[]> {
    await this.syncGroups();
    return [...this.conversationCache.values()]
      .filter((conversation) => conversation.isGroup)
      .map((conversation) => ({
        id: conversation.id,
        jid: makeSlackJid(conversation.id),
        name: conversation.name,
        members: [],
      }));
  }

  async findGroupByName(
    name: string,
  ): Promise<ChannelGroupLookupResult | null> {
    const normalized = name.trim().toLowerCase().replace(/^#/, '');
    if (!normalized) return null;
    const groups = await this.getGroups();
    return (
      groups.find(
        (group) =>
          group.name.trim().toLowerCase().replace(/^#/, '') === normalized,
      ) || null
    );
  }

  private async openSocket(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        this.connected = true;
        settled = true;
        resolve();
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        reject(new Error('Slack Socket Mode connection failed'));
      };

      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.connected = false;
        if (!settled) {
          settled = true;
          reject(new Error('Slack Socket Mode closed before ready'));
        }
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      };

      socket.onmessage = (event) => {
        this.handleSocketMessage(event.data).catch((error) => {
          log.warn(
            { err: String(error) },
            'Slack socket event handling failed',
          );
        });
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        log.warn({ err: String(error) }, 'Slack reconnect failed');
        this.scheduleReconnect();
      });
    }, 3000);
  }

  private async handleSocketMessage(raw: unknown): Promise<void> {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf-8')
          : Buffer.from(raw as ArrayBufferLike).toString('utf-8');
    if (!text.trim()) return;

    const envelope = JSON.parse(text) as SlackSocketEnvelope;
    if (envelope.envelope_id && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    if (envelope.type !== 'events_api') return;
    const event = envelope.payload?.event;
    if (!event || event.type !== 'message') return;
    if (event.subtype || event.bot_id || !event.user) return;

    const shouldProcess = shouldProcessSlackMessage({
      text: event.text,
      channelType: event.channel_type,
      selfUserId: this.selfUserId,
      allowDirectMessages: getAllowDirectMessages(this.settings),
      mentionOnlyInChannels: getMentionOnlyInChannels(this.settings),
    });
    if (!shouldProcess) return;

    const conversationId = String(event.channel || '').trim();
    const messageTs = String(event.ts || '').trim();
    const normalizedText = normalizeSlackText(
      String(event.text || ''),
      this.selfUserId,
    );
    if (!conversationId || !messageTs || !normalizedText) return;

    const [conversation, senderName] = await Promise.all([
      this.getConversationInfo(conversationId, event.channel_type),
      this.getUserDisplayName(event.user),
    ]);

    const chatJid = makeSlackJid(conversationId);
    const timestamp = slackTsToIso(messageTs);
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      conversation.name,
      INTEGRATION_NAME,
      conversation.isGroup,
    );

    this.opts.onMessage(chatJid, {
      id: messageTs,
      chat_jid: chatJid,
      sender: `slack:user:${event.user}`,
      sender_name: senderName,
      content: normalizedText,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_id:
        event.thread_ts && event.thread_ts !== messageTs
          ? event.thread_ts
          : undefined,
    });
  }

  private async getConversationInfo(
    conversationId: string,
    channelType?: string,
  ): Promise<SlackConversationInfo> {
    const cached = this.conversationCache.get(conversationId);
    if (cached) return cached;

    try {
      const payload = await callSlackApi('conversations.info', this.botToken, {
        channel: conversationId,
      });
      const raw = (payload.channel || {}) as Record<string, unknown>;
      const mapped = this.mapConversation(raw, channelType);
      this.conversationCache.set(conversationId, mapped);
      return mapped;
    } catch {
      const fallback: SlackConversationInfo = {
        id: conversationId,
        name: conversationId,
        isGroup: !isDirectMessageChannel(channelType),
        type: isDirectMessageChannel(channelType) ? 'im' : 'unknown',
      };
      this.conversationCache.set(conversationId, fallback);
      return fallback;
    }
  }

  private mapConversation(
    raw: Record<string, unknown>,
    channelType?: string,
  ): SlackConversationInfo {
    const id = String(raw.id || '').trim();
    const isIm = raw.is_im === true || channelType === 'im';
    const isMpim = raw.is_mpim === true || channelType === 'mpim';
    const isChannel = raw.is_channel === true || channelType === 'channel';
    const isGroup = raw.is_group === true || channelType === 'group';
    const type = isIm
      ? 'im'
      : isMpim
        ? 'mpim'
        : isChannel
          ? 'channel'
          : isGroup
            ? 'group'
            : 'unknown';

    let name = String(raw.name || '').trim();
    if (!name && isIm) {
      const userId = String(raw.user || '').trim();
      name = userId ? `Slack DM ${userId}` : id;
    }
    if (!name && isMpim) {
      name = 'Slack Group DM';
    }
    if (!name) {
      name = id;
    }

    return {
      id,
      name: isIm ? name : `#${name}`,
      isGroup: !isIm,
      type,
    };
  }

  private async getUserDisplayName(userId?: string): Promise<string> {
    const trimmed = String(userId || '').trim();
    if (!trimmed) return 'Slack User';
    const cached = this.userCache.get(trimmed);
    if (cached) return cached;

    try {
      const payload = await callSlackApi('users.info', this.botToken, {
        user: trimmed,
      });
      const user = (payload.user || {}) as Record<string, unknown>;
      const profile = (user.profile || {}) as Record<string, unknown>;
      const displayName = String(
        profile.display_name ||
          profile.real_name ||
          user.real_name ||
          user.name ||
          trimmed,
      ).trim();
      this.userCache.set(trimmed, displayName);
      return displayName;
    } catch {
      return trimmed;
    }
  }
}

function slackTsToIso(ts: string): string {
  const parsed = Number(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed * 1000).toISOString();
}

let channelInstance: SlackChannel | null = null;

const credentialStep: CredentialInputStep = {
  type: 'credential_input',
  label: 'Slack Bot Credentials',
  description:
    'Create a Slack app with bot-user messaging enabled, turn on Socket Mode, then paste the bot and app tokens.',
  helpUrl: SLACK_HELP_URL,
  fields: [
    {
      key: BOT_TOKEN_SETTING,
      label: 'Bot Token',
      type: 'password',
      placeholder: 'xoxb-...',
      required: true,
      pattern: '^xoxb-',
      patternHelp: 'Slack bot tokens start with xoxb-',
    },
    {
      key: APP_TOKEN_SETTING,
      label: 'App Token',
      type: 'password',
      placeholder: 'xapp-...',
      required: true,
      pattern: '^xapp-',
      patternHelp: 'Slack app-level tokens start with xapp-',
    },
  ],
  validate: async (values) => {
    try {
      await validateSlackCredentials(
        String(values[BOT_TOKEN_SETTING] || '').trim(),
        String(values[APP_TOKEN_SETTING] || '').trim(),
      );
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error:
          error instanceof Error ? error.message : 'Slack validation failed',
      };
    }
  },
  save: async (values) => {
    const existing = getIntegrationSettings(INTEGRATION_NAME);
    saveIntegrationSettings(INTEGRATION_NAME, {
      ...existing,
      [BOT_TOKEN_SETTING]: String(values[BOT_TOKEN_SETTING] || '').trim(),
      [APP_TOKEN_SETTING]: String(values[APP_TOKEN_SETTING] || '').trim(),
    });
    if (!isIntegrationEnabled(INTEGRATION_NAME)) {
      setIntegrationEnabled(INTEGRATION_NAME, true);
    }
    channelInstance?.refreshSettings(getIntegrationSettings(INTEGRATION_NAME));
  },
  isComplete: async () => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    return Boolean(getBotToken(settings) && getAppToken(settings));
  },
};

const verifiedControllerStep: FormSetupStep = {
  type: 'form',
  label: 'Verified Slack Controller',
  description:
    'Add the controller Slack user identity that should be trusted as an owner-verified operator. This writes into the shared Verified Identities list shown on the Policy page.',
  schema: {
    type: 'object',
    properties: {
      [CONTROLLER_IDENTITY_SETTING]: {
        type: 'string',
        title: 'Controller Slack Identity',
        description:
          'Slack user identity in the form slack:user:U123ABC456. You can also paste the raw user ID and it will be normalized.',
      },
      [CONTROLLER_LABEL_SETTING]: {
        type: 'string',
        title: 'Controller Label',
        description:
          'Friendly label shown on the Policy page for this verified Slack identity.',
      },
    },
    required: [CONTROLLER_IDENTITY_SETTING],
  },
  defaults: {
    [CONTROLLER_IDENTITY_SETTING]: '',
    [CONTROLLER_LABEL_SETTING]: 'Slack Controller',
  },
  validate: async (values) => {
    const errors: Record<string, string> = {};
    const canonical = normalizeControllerSlackIdentity(
      String(values[CONTROLLER_IDENTITY_SETTING] || ''),
    );
    if (!canonical) {
      errors[CONTROLLER_IDENTITY_SETTING] =
        'Controller Slack identity is required';
    } else if (!canonical.startsWith('slack-user:')) {
      errors[CONTROLLER_IDENTITY_SETTING] =
        'Enter a Slack user identity like slack:user:U123ABC456';
    }
    return Object.keys(errors).length > 0
      ? { valid: false, errors }
      : { valid: true };
  },
  save: async (values) => {
    const existing = getIntegrationSettings(INTEGRATION_NAME);
    const normalizedIdentity = normalizeControllerSlackIdentity(
      String(values[CONTROLLER_IDENTITY_SETTING] || ''),
    );
    const label = String(values[CONTROLLER_LABEL_SETTING] || '').trim();
    saveIntegrationSettings(INTEGRATION_NAME, {
      ...existing,
      [CONTROLLER_IDENTITY_SETTING]: normalizedIdentity,
      [CONTROLLER_LABEL_SETTING]: label || 'Slack Controller',
    });
    saveVerifiedSlackController(normalizedIdentity, label);
  },
  isComplete: async () => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    return hasVerifiedSlackController(settings);
  },
};

const slackIntegration: IntegrationDefinition = {
  name: INTEGRATION_NAME,
  description: 'Slack app with bot-user messaging over Socket Mode',
  core: false,
  version: '1.0.0',
  credentials: [
    {
      key: BOT_TOKEN_SETTING,
      label: 'Slack Bot Token',
      type: 'bearer_token',
      envVar: BOT_TOKEN_SETTING,
      required: true,
    },
    {
      key: APP_TOKEN_SETTING,
      label: 'Slack App Token',
      type: 'secret',
      envVar: APP_TOKEN_SETTING,
      required: true,
    },
  ],
  settings: {
    schema: {
      type: 'object',
      properties: {
        [BOT_TOKEN_SETTING]: {
          type: 'string',
          title: 'Slack Bot Token',
          description: 'Bot user OAuth token used for Slack Web API calls.',
          sensitive: true,
        },
        [APP_TOKEN_SETTING]: {
          type: 'string',
          title: 'Slack App Token',
          description: 'App-level token used for Socket Mode.',
          sensitive: true,
        },
        mentionOnlyInChannels: {
          type: 'boolean',
          title: 'Require mentions in channels',
          description:
            'When enabled, the bot only responds in channels and group chats when explicitly @mentioned.',
          default: true,
        },
        allowDirectMessages: {
          type: 'boolean',
          title: 'Allow direct messages',
          description:
            'When enabled, the bot responds in Slack DMs without requiring an @mention.',
          default: true,
        },
        [CONTROLLER_IDENTITY_SETTING]: {
          type: 'string',
          title: 'Verified controller Slack identity',
          description:
            'Owner-verified Slack user identity stored in the shared Verified Identities list.',
        },
        [CONTROLLER_LABEL_SETTING]: {
          type: 'string',
          title: 'Verified controller label',
          description:
            'Friendly label for the verified controller identity on the Policy page.',
        },
      },
    },
    defaults: {
      [BOT_TOKEN_SETTING]: '',
      [APP_TOKEN_SETTING]: '',
      mentionOnlyInChannels: true,
      allowDirectMessages: true,
      [CONTROLLER_IDENTITY_SETTING]: '',
      [CONTROLLER_LABEL_SETTING]: 'Slack Controller',
    },
  },
  adminPage: {
    icon: 'cilChatBubble',
    category: 'messaging',
    getStatus: async (ctx) => {
      const botToken = getBotToken(ctx.settings);
      const appToken = getAppToken(ctx.settings);
      if (!botToken || !appToken) {
        return {
          state: 'unconfigured',
          message: 'Slack bot credentials are not configured',
        };
      }
      if (channelInstance?.isConnected()) {
        return {
          state: 'online',
          message: 'Connected to Slack via Socket Mode',
        };
      }
      return {
        state: 'offline',
        message: 'Configured, but the Slack Socket Mode connection is offline',
      };
    },
    getNotifications: async (ctx) => {
      const notifications: IntegrationNotification[] = [];
      const botToken = getBotToken(ctx.settings);
      const appToken = getAppToken(ctx.settings);
      if (!botToken || !appToken) {
        notifications.push({
          id: 'slack:not-configured',
          integration: INTEGRATION_NAME,
          severity: 'warning',
          title: 'Slack Not Configured',
          message:
            'Add the Slack bot token and app token from the integration setup page.',
        });
        return notifications;
      }
      if (!hasVerifiedSlackController(ctx.settings)) {
        notifications.push({
          id: 'slack:verified-controller-missing',
          integration: INTEGRATION_NAME,
          severity: 'warning',
          title: 'Slack Controller Not Verified',
          message:
            'Add the controller Slack identity in the setup flow so it appears in the shared Verified Identities list.',
        });
      }
      if (!channelInstance?.isConnected()) {
        notifications.push({
          id: 'slack:offline',
          integration: INTEGRATION_NAME,
          severity: 'error',
          title: 'Slack Offline',
          message:
            'The Slack bot is configured but not connected. Check Socket Mode, scopes, and the app tokens.',
        });
      }
      return notifications;
    },
  },
  channel: (opts: ChannelOpts) => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    if (!getBotToken(settings) || !getAppToken(settings)) return null;
    channelInstance = new SlackChannel(opts, settings);
    return channelInstance;
  },
  tools: [
    {
      name: 'slack.send_message',
      description:
        'Send a Slack message to a Slack channel or conversation. Accepts a channel name like #general or tests, or a Slack JID like slack:C12345678. This tool IS the user-visible message — do not also produce a text reply summarising what you sent. After calling this tool, return an empty text response to end your turn.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Channel name (e.g. #tests or tests) or Slack JID (e.g. slack:C12345678)',
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
        const to = String(args.to || '').trim();
        const text = String(args.text || '').trim();
        if (!to) throw new Error('to is required');
        if (!text) throw new Error('text is required');
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as SlackChannel | undefined;
        if (!channel) throw new Error('Slack channel is not connected');
        let destination = to;
        if (!isSlackJid(destination)) {
          const matchedGroup = await channel.findGroupByName(destination);
          if (!matchedGroup?.jid) {
            throw new Error(
              'Slack messaging requires a slack:<id> JID or an already-known Slack channel name',
            );
          }
          destination = matchedGroup.jid;
        }
        await channel.sendMessage(destination, text);
        return JSON.stringify({ status: 'sent', to: destination });
      },
    },
    {
      name: 'slack.list_channels',
      description:
        'List all Slack channels and conversations the bot is a member of. Returns names and JIDs.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      location: 'host' as const,
      controllerOnly: true,
      execute: async (_args, ctx) => {
        const channel = ctx.channels?.find(
          (candidate) => candidate.name === INTEGRATION_NAME,
        ) as SlackChannel | undefined;
        if (!channel) throw new Error('Slack channel is not connected');
        const groups = await channel.getGroups();
        return JSON.stringify(
          groups.map((g) => ({ name: g.name, jid: g.jid })),
        );
      },
    },
    {
      name: 'slack.reply',
      description:
        'Reply in the current Slack conversation. This tool IS the user-visible reply — do not also produce a text response summarising what you replied. After calling this tool, return an empty text response to end your turn.',
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
        if (!ctx.chatJid || !isSlackJid(ctx.chatJid)) {
          throw new Error('Chat context is not a Slack conversation');
        }
        if (!ctx.sendMessage) {
          throw new Error('Messaging context not available');
        }
        await ctx.sendMessage(ctx.chatJid, text);
        return JSON.stringify({ status: 'sent', to: ctx.chatJid });
      },
    },
    {
      name: 'slack.send_file',
      description:
        'Upload a file (PDF, image, etc.) to a Slack channel or conversation. The path must be inside a workspace path the agent can read. This tool IS the user-visible attachment — do not also produce a text reply summarising what you sent. After calling this tool, return an empty text response to end your turn. Requires the Slack bot token to have the "files:write" OAuth scope.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Target Slack channel name (e.g. "#general" or "general") or Slack JID (e.g. "slack:C12345678"). Omit to send to the current conversation.',
          },
          file_path: {
            type: 'string',
            description:
              'Absolute path inside the container workspace to the file being uploaded.',
          },
          caption: {
            type: 'string',
            description: 'Optional message body to post alongside the file.',
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
        const ch = ctx.channels?.find((c) => c.name === INTEGRATION_NAME) as
          | (Channel & {
              findGroupByName?: (
                name: string,
              ) => Promise<ChannelGroupLookupResult | null>;
              sendAttachment?: (input: {
                jid: string;
                filePath: string;
                mimeType: string;
                caption?: string;
                fileName?: string;
              }) => Promise<void>;
            })
          | undefined;
        if (!ch?.sendAttachment) {
          throw new Error('Slack channel is not connected');
        }
        const targetRaw =
          String(args.to || '').trim() || String(ctx.chatJid || '').trim();
        if (!targetRaw) {
          throw new Error(
            'No target Slack channel — provide "to" or use inside a Slack conversation',
          );
        }
        let jid = '';
        if (isSlackJid(targetRaw)) {
          jid = targetRaw;
        } else if (ch.findGroupByName) {
          const match = await ch.findGroupByName(targetRaw);
          if (match?.jid) jid = match.jid;
        }
        if (!jid) {
          throw new Error(
            `Could not resolve Slack target "${targetRaw}" — pass a channel name (e.g. "general") or a slack:C… JID`,
          );
        }
        const caption = String(args.caption || '').trim();
        const fileName =
          String(args.file_name || '').trim() || path.basename(filePath);
        const mimeType = inferMimeTypeFromPath(filePath);
        await ch.sendAttachment({
          jid,
          filePath,
          mimeType,
          caption: caption || undefined,
          fileName,
          // Keep uploads in the inbound thread when the user asked from one.
          // If 'to' was an explicit different channel, ctx.threadId is still
          // from the originating chat — only apply it when we're replying to
          // the same chat the request came from.
          ...(jid === ctx.chatJid && ctx.threadId
            ? { threadId: ctx.threadId }
            : {}),
        });
        return JSON.stringify({
          status: 'uploaded',
          to: jid,
          file_name: fileName,
          ack_text: `Uploaded ${fileName} to Slack.`,
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
    steps: [credentialStep, verifiedControllerStep],
    getStatus: async () => {
      const credentialsComplete = await credentialStep.isComplete();
      const verifiedComplete = await verifiedControllerStep.isComplete();
      const completed = credentialsComplete && verifiedComplete;
      return {
        completed,
        currentStep: credentialsComplete ? 1 : 0,
        steps: [
          {
            type: 'credential_input',
            label: credentialStep.label,
            description:
              'Provide the Slack bot token and app token for a Socket Mode app with bot-user messaging enabled.',
            status: credentialsComplete ? 'completed' : 'pending',
          },
          {
            type: 'form',
            label: verifiedControllerStep.label,
            description: verifiedControllerStep.description,
            status: verifiedComplete ? 'completed' : 'pending',
          },
        ],
      };
    },
  },
  lifecycle: {
    onReconnect: async (ctx) => {
      if (!channelInstance) {
        throw new Error('Slack channel is not initialized');
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

registerIntegration(slackIntegration);

export { SlackChannel };
