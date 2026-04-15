import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const integrationSettings = {
  SMS_SOCKET_API_KEY: 'secret-key',
  gatewayUrl: 'ws://192.168.1.25:8787/',
  rehydrateLimit: 50,
  lastSeenTimestamp: 0,
};

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createChildLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('./settings-store.js', () => ({
  getIntegrationSettings: vi.fn(() => integrationSettings),
  saveIntegrationSettings: vi.fn(),
  isIntegrationEnabled: vi.fn(() => false),
  setIntegrationEnabled: vi.fn(),
}));

import { SmsSocketChannel } from './sms-socket.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  readonly sentMessages: Array<Record<string, unknown>> = [];
  readonly url: string;

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string) {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    this.sentMessages.push(payload);
    const type = String(payload.type || '');
    const requestId = String(payload.requestId || '');

    if (type === 'authenticate') {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        timestamp: 1,
        payload: { authenticated: true },
      });
      return;
    }

    if (type === 'getGatewayState') {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        timestamp: 2,
        payload: {
          enabled: true,
          running: true,
          addresses: ['192.168.1.25'],
          connectionCount: 1,
        },
      });
      return;
    }

    if (type === 'rehydrate') {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        timestamp: 3,
        payload: {
          events: [
            {
              id: 'history-1',
              type: 'sms.received',
              timestamp: 1_700_000_000_000,
              payload: {
                address: '+15551234567',
                body: 'rehydrated hello',
                receivedAt: 1_700_000_000_000,
              },
            },
          ],
        },
      });
      return;
    }

    if (type === 'sendSms') {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        timestamp: 4,
        payload: { messageId: 'msg-1' },
      });
    }
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('SmsSocketChannel', () => {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups = vi.fn(() => ({}));

  beforeEach(() => {
    onMessage.mockReset();
    onChatMetadata.mockReset();
    registeredGroups.mockReset();
    registeredGroups.mockReturnValue({});
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects, authenticates, and rehydrates inbound messages', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();

    expect(MockWebSocket.instances[0]?.url).toBe('ws://192.168.1.25:8787/');
    expect(
      MockWebSocket.instances[0]?.sentMessages.map((message) => message.type),
    ).toEqual(['authenticate', 'getGatewayState', 'rehydrate']);
    expect(onChatMetadata).toHaveBeenCalledWith(
      'sms:+15551234567',
      expect.any(String),
      undefined,
      'sms-socket',
      false,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'sms:+15551234567',
      expect.objectContaining({
        content: 'rehydrated hello',
        sender: '+15551234567',
        is_from_me: false,
      }),
    );

    await channel.disconnect();
  });

  it('sends outbound sms messages through the websocket gateway', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();
    await channel.sendMessage('sms:+15557654321', 'hello from claw');

    const sentMessages = MockWebSocket.instances[0]?.sentMessages || [];
    const sendRequest = sentMessages.find((message) => message.type === 'sendSms');
    expect(sendRequest).toMatchObject({
      type: 'sendSms',
      payload: {
        destination: '+15557654321',
        body: 'hello from claw',
      },
    });

    await channel.disconnect();
  });

  it('normalizes live inbound and outbound websocket events', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();
    onMessage.mockClear();
    onChatMetadata.mockClear();

    MockWebSocket.instances[0]?.emit({
      type: 'sms.received',
      timestamp: 1_700_000_100_000,
      payload: {
        address: '(555) 111-2222',
        body: 'live inbound',
        receivedAt: 1_700_000_100_000,
      },
    });
    MockWebSocket.instances[0]?.emit({
      type: 'sms.outbound.sent',
      timestamp: 1_700_000_200_000,
      payload: {
        messageId: 'msg-2',
        destination: '+15551112222',
        body: 'live outbound',
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'sms:+5551112222',
      expect.objectContaining({
        content: 'live inbound',
        is_from_me: false,
      }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      'sms:+15551112222',
      expect.objectContaining({
        content: 'live outbound',
        is_from_me: true,
        sender_name: 'You',
      }),
    );

    await channel.disconnect();
  });
});
