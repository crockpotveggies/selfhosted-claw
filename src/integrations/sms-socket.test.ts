import fs from 'fs';
import os from 'os';
import path from 'path';

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

import { getIntegration } from './registry.js';
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
  readonly options?: { headers?: Record<string, string> };

  constructor(
    url: string | URL,
    options?: { headers?: Record<string, string> },
  ) {
    this.url = String(url);
    this.options = options;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string) {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    this.sentMessages.push(payload);
    const type = String(payload.type || '');
    const requestId = String(payload.requestId || '');

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
      return;
    }

    if (type === 'sendMms') {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        timestamp: 5,
        payload: { messageId: 'mms-1' },
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
    vi.useRealTimers();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects with bearer auth in the websocket handshake and rehydrates inbound messages', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();

    expect(MockWebSocket.instances[0]?.url).toBe('ws://192.168.1.25:8787/');
    expect(MockWebSocket.instances[0]?.options).toEqual({
      headers: {
        Authorization: 'Bearer secret-key',
      },
    });
    expect(
      MockWebSocket.instances[0]?.sentMessages.map((message) => message.type),
    ).toEqual(['getGatewayState', 'rehydrate']);
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
    const sendRequest = sentMessages.find(
      (message) => message.type === 'sendSms',
    );
    expect(sendRequest).toMatchObject({
      type: 'sendSms',
      payload: {
        destination: '+15557654321',
        body: 'hello from claw',
      },
    });

    await channel.disconnect();
  });

  it('sends outbound mms attachments through the websocket gateway', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );
    const tmpFile = path.join(os.tmpdir(), `sms-socket-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, 'hello mms');

    try {
      await channel.connect();
      await channel.sendAttachment({
        jid: 'sms:+15557654321',
        filePath: tmpFile,
        mimeType: 'application/pdf',
        caption: 'see attached',
        fileName: 'hello.pdf',
      });

      const sentMessages = MockWebSocket.instances[0]?.sentMessages || [];
      const sendRequest = sentMessages.find(
        (message) => message.type === 'sendMms',
      );
      expect(sendRequest).toMatchObject({
        type: 'sendMms',
        payload: {
          destination: '+15557654321',
          body: 'see attached',
          attachment: {
            fileName: 'hello.pdf',
            mimeType: 'application/pdf',
            sizeBytes: Buffer.byteLength('hello mms'),
            base64: Buffer.from('hello mms').toString('base64'),
          },
        },
      });
    } finally {
      await channel.disconnect();
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('reconnects on demand before sending when the socket has dropped', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();
    MockWebSocket.instances[0]?.close();

    await channel.sendMessage('sms:+15557654321', 'retry after reconnect');

    expect(MockWebSocket.instances).toHaveLength(2);
    const sentMessages = MockWebSocket.instances[1]?.sentMessages || [];
    expect(sentMessages.map((message) => message.type)).toContain('sendSms');
    expect(
      sentMessages.find((message) => message.type === 'sendSms'),
    ).toMatchObject({
      payload: {
        destination: '+15557654321',
        body: 'retry after reconnect',
      },
    });

    await channel.disconnect();
  });

  it('suppresses duplicate agent sms tool sends within the short replay window', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );
    await channel.connect();

    const tool = getIntegration('sms-socket')?.tools?.find(
      (candidate) => candidate.name === 'sms_socket.send_message',
    );
    expect(tool?.execute).toBeTypeOf('function');

    const first = await tool!.execute!(
      { to: '+15557654321', text: 'hello from claw' },
      {
        settings: integrationSettings,
        sourceGroup: 'main',
        isMain: true,
        calendarAccess: true,
        chatJid: 'signal:user:+15550001111',
        channels: [channel],
      },
    );
    const second = await tool!.execute!(
      { to: '+15557654321', text: 'hello from claw' },
      {
        settings: integrationSettings,
        sourceGroup: 'main',
        isMain: true,
        calendarAccess: true,
        chatJid: 'signal:user:+15550001111',
        channels: [channel],
      },
    );

    const sentMessages = MockWebSocket.instances[0]?.sentMessages || [];
    const sendRequests = sentMessages.filter(
      (message) => message.type === 'sendSms',
    );
    expect(sendRequests).toHaveLength(1);
    expect(first).toContain('"status":"sent"');
    expect(second).toContain('"status":"duplicate"');

    await channel.disconnect();
  });

  it('uploads files over mms through the integration tool', async () => {
    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-socket-tool-'));
    const tmpFile = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(tmpFile, 'mms tool payload');

    try {
      await channel.connect();

      const tool = getIntegration('sms-socket')?.tools?.find(
        (candidate) => candidate.name === 'sms_socket.send_file',
      );
      expect(tool?.execute).toBeTypeOf('function');

      const result = await tool!.execute!(
        {
          to: '+15557654321',
          file_path: tmpFile,
          caption: 'Monthly report',
          file_name: 'monthly-report.pdf',
        },
        {
          settings: integrationSettings,
          sourceGroup: 'main',
          isMain: true,
          calendarAccess: true,
          chatJid: 'signal:user:+15550001111',
          channels: [channel],
        },
      );

      const sentMessages = MockWebSocket.instances[0]?.sentMessages || [];
      const sendRequest = sentMessages.find(
        (message) => message.type === 'sendMms',
      );
      expect(sendRequest).toMatchObject({
        payload: {
          destination: '+15557654321',
          body: 'Monthly report',
          attachment: {
            fileName: 'monthly-report.pdf',
            mimeType: 'application/pdf',
          },
        },
      });
      expect(result).toContain('"status":"uploaded"');
      expect(result).toContain('"file_name":"monthly-report.pdf"');
    } finally {
      await channel.disconnect();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it('does not schedule a background reconnect loop when the initial websocket connection fails', async () => {
    vi.useFakeTimers();

    class FailingWebSocket extends MockWebSocket {
      constructor(url: string | URL) {
        super(url);
        queueMicrotask(() => this.onerror?.());
        queueMicrotask(() => this.onclose?.());
      }
    }

    vi.stubGlobal('WebSocket', FailingWebSocket as unknown as typeof WebSocket);

    const channel = new SmsSocketChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await expect(channel.connect()).rejects.toThrow(
      'SMS Socket websocket failed',
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(FailingWebSocket.instances).toHaveLength(1);
  });
});
