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

function makeJsonResponse(result: unknown) {
  return {
    ok: true,
    json: async () => ({ result }),
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
    const fetchMock = vi.fn(async () => makeJsonResponse([]));
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
    expect(JSON.parse(String(options?.body))).toMatchObject({
      method: 'send',
      params: {
        account: '+15555550123',
        recipient: '+15551234567',
        message: 'hello',
      },
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
});
