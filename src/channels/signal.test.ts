import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  SIGNAL_ACCOUNT: '+15555550123',
  SIGNAL_RECEIVE_TIMEOUT_SEC: 1,
  SIGNAL_RPC_URL: 'http://127.0.0.1:8080',
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { SignalChannel } from './signal.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  close() {
    this.onclose?.();
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data });
  }
}

function makeJsonResponse(result: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => result,
    text: async () => JSON.stringify(result),
  } as Response;
}

describe('SignalChannel', () => {
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

  it('owns signal-prefixed jids', () => {
    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    expect(channel.ownsJid('signal:user:+15555550123')).toBe(true);
    expect(channel.ownsJid('signal:group:abc123')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
  });

  it('sends direct messages through signal-cli rpc', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse({}, 201));
    vi.stubGlobal('fetch', fetchMock);

    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    await channel.sendMessage('signal:user:+15551234567', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ];
    const options = firstCall[1];
    expect(String(firstCall[0])).toBe('http://127.0.0.1:8080/v2/send');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      number: '+15555550123',
      recipients: ['+15551234567'],
      message: 'hello',
    });
  });

  it('creates Signal groups and sends the initial message', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.members) {
        return makeJsonResponse({ id: 'group.Z3JvdXAtMTIz' }, 201);
      }
      return makeJsonResponse({}, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    const created = await channel.createGroup({
      title: 'Lunch plans',
      members: ['+15551234567'],
      message: 'Can we do lunch next Monday?',
    });

    expect(created).toEqual({
      jid: 'signal:group:group.Z3JvdXAtMTIz',
      title: 'Lunch plans',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://127.0.0.1:8080/v1/groups/%2B15555550123',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      name: 'Lunch plans',
      members: ['+15551234567'],
    });
    expect(onChatMetadata).toHaveBeenCalledWith(
      'signal:group:group.Z3JvdXAtMTIz',
      expect.any(String),
      'Lunch plans',
      'signal',
      true,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      recipients: ['group.Z3JvdXAtMTIz'],
      message: 'Can we do lunch next Monday?',
    });
  });

  it('re-hyphenates uuid recipients before sending', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse({}, 201));
    vi.stubGlobal('fetch', fetchMock);

    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    await channel.sendMessage(
      'signal:user:5396f0507ac246108c5fc8f1be353fec',
      'hello uuid',
    );

    const firstCall = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ];
    const options = firstCall[1];
    expect(JSON.parse(String(options?.body))).toMatchObject({
      recipients: ['5396f050-7ac2-4610-8c5f-c8f1be353fec'],
      message: 'hello uuid',
    });
  });

  it('normalizes inbound signal envelopes', async () => {
    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    const parsed = (channel as any).parseEnvelope({
      envelope: {
        sourceNumber: '+15551234567',
        sourceName: 'Taylor',
        timestamp: 1_700_000_000_000,
        dataMessage: {
          message: 'hello from signal',
        },
      },
    });

    expect(parsed).toMatchObject({
      chatJid: 'signal:user:+15551234567',
      chatName: 'Taylor',
      isGroup: false,
      message: {
        content: 'hello from signal',
        sender: '+15551234567',
        sender_name: 'Taylor',
        is_from_me: false,
      },
    });
  });

  it('preserves hyphenated signal uuid identities on inbound messages', async () => {
    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    const parsed = (channel as any).parseEnvelope({
      envelope: {
        source: '5396f050-7ac2-4610-8c5f-c8f1be353fec',
        sourceName: 'Taylor',
        timestamp: 1_700_000_000_000,
        dataMessage: {
          message: 'uuid hello',
        },
      },
    });

    expect(parsed).toMatchObject({
      chatJid: 'signal:user:5396f050-7ac2-4610-8c5f-c8f1be353fec',
      message: {
        sender: '5396f050-7ac2-4610-8c5f-c8f1be353fec',
      },
    });
  });

  it('surfaces rpc url when fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    await expect(channel.connect()).rejects.toThrow(
      'Signal RPC listGroups failed to reach http://127.0.0.1:8080/v1/groups/%2B15555550123: fetch failed',
    );
  });

  it('consumes inbound messages over websocket receive stream', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const channel = new SignalChannel(
      { onMessage, onChatMetadata, registeredGroups },
      'http://127.0.0.1:8080',
      '+15555550123',
    );

    await channel.connect();
    expect(MockWebSocket.instances[0]?.url).toBe(
      'ws://127.0.0.1:8080/v1/receive/%2B15555550123',
    );

    MockWebSocket.instances[0].emitMessage(
      JSON.stringify({
        envelope: {
          sourceNumber: '+15551234567',
          sourceName: 'Taylor',
          timestamp: 1_700_000_000_000,
          dataMessage: {
            message: 'hello from websocket',
          },
        },
      }),
    );

    expect(onChatMetadata).toHaveBeenCalledWith(
      'signal:user:+15551234567',
      expect.any(String),
      'Taylor',
      'signal',
      false,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'signal:user:+15551234567',
      expect.objectContaining({
        content: 'hello from websocket',
      }),
    );

    await channel.disconnect();
  });
});
