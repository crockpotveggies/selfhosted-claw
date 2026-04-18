import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const integrationSettings = {
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  SLACK_APP_TOKEN: 'xapp-test-token',
  mentionOnlyInChannels: true,
  allowDirectMessages: true,
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

vi.mock('./registry.js', () => ({
  registerIntegration: vi.fn(),
}));

vi.mock('../control-store.js', () => ({
  ControlStore: class {
    getVerifiedIdentities() {
      return [];
    }
    saveVerifiedIdentities() {}
  },
}));

import {
  SlackChannel,
  isSlackJid,
  makeSlackJid,
  shouldProcessSlackMessage,
} from './slack.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  readonly sentMessages: string[] = [];
  readonly url: string;

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string) {
    this.sentMessages.push(raw);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('Slack integration', () => {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups = vi.fn(() => ({}));
  const fetchMock = vi.fn();

  beforeEach(() => {
    onMessage.mockReset();
    onChatMetadata.mockReset();
    registeredGroups.mockReset();
    registeredGroups.mockReturnValue({});
    MockWebSocket.instances = [];
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = url.split('/').pop();
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;

      if (method === 'auth.test') {
        return jsonResponse({ ok: true, user_id: 'U_BOT' });
      }
      if (method === 'apps.connections.open') {
        return jsonResponse({ ok: true, url: 'wss://slack.example/socket' });
      }
      if (method === 'conversations.info') {
        return jsonResponse({
          ok: true,
          channel: {
            id: body.channel,
            name: 'builds',
            is_channel: true,
          },
        });
      }
      if (method === 'users.info') {
        return jsonResponse({
          ok: true,
          user: {
            id: body.user,
            profile: {
              display_name: 'Alice',
            },
          },
        });
      }
      if (method === 'chat.postMessage') {
        return jsonResponse({ ok: true, ts: '1710000000.000100' });
      }
      if (method === 'conversations.list') {
        return jsonResponse({ ok: true, channels: [], response_metadata: {} });
      }
      throw new Error(`Unexpected Slack API method: ${method}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects and processes mentioned channel messages', async () => {
    const channel = new SlackChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();
    MockWebSocket.instances[0]?.emit({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        event: {
          type: 'message',
          channel: 'C123',
          channel_type: 'channel',
          user: 'U_ALICE',
          text: '<@U_BOT> hello there',
          ts: '1710000000.000100',
        },
      },
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        'slack:C123',
        expect.objectContaining({
          sender: 'slack:user:U_ALICE',
          sender_name: 'Alice',
          content: '@Andy hello there',
        }),
      );
    });
    expect(onChatMetadata).toHaveBeenCalledWith(
      'slack:C123',
      expect.any(String),
      '#builds',
      'slack',
      true,
    );

    await channel.disconnect();
  });

  it('ignores channel messages that do not mention the bot', async () => {
    const channel = new SlackChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();
    MockWebSocket.instances[0]?.emit({
      envelope_id: 'env-2',
      type: 'events_api',
      payload: {
        event: {
          type: 'message',
          channel: 'C123',
          channel_type: 'channel',
          user: 'U_ALICE',
          text: 'plain hello',
          ts: '1710000000.000200',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).not.toHaveBeenCalled();

    await channel.disconnect();
  });

  it('processes direct messages without a mention and preserves thread ids', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = url.split('/').pop();
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;

      if (method === 'auth.test') {
        return jsonResponse({ ok: true, user_id: 'U_BOT' });
      }
      if (method === 'apps.connections.open') {
        return jsonResponse({ ok: true, url: 'wss://slack.example/socket' });
      }
      if (method === 'conversations.info') {
        return jsonResponse({
          ok: true,
          channel: {
            id: body.channel,
            user: 'U_ALICE',
            is_im: true,
          },
        });
      }
      if (method === 'users.info') {
        return jsonResponse({
          ok: true,
          user: {
            id: body.user,
            profile: {
              display_name: 'Alice',
            },
          },
        });
      }
      if (method === 'chat.postMessage') {
        return jsonResponse({ ok: true, ts: '1710000000.000100' });
      }
      if (method === 'conversations.list') {
        return jsonResponse({ ok: true, channels: [], response_metadata: {} });
      }
      throw new Error(`Unexpected Slack API method: ${method}`);
    });

    const channel = new SlackChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();
    MockWebSocket.instances[0]?.emit({
      envelope_id: 'env-3',
      type: 'events_api',
      payload: {
        event: {
          type: 'message',
          channel: 'D123',
          channel_type: 'im',
          user: 'U_ALICE',
          text: 'hi in a thread',
          ts: '1710000000.000300',
          thread_ts: '1710000000.000250',
        },
      },
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        'slack:D123',
        expect.objectContaining({
          content: 'hi in a thread',
          thread_id: '1710000000.000250',
        }),
      );
    });

    await channel.disconnect();
  });

  it('sends threaded replies via chat.postMessage', async () => {
    const channel = new SlackChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();
    await channel.sendMessage('slack:C123', 'reply in thread', {
      threadId: '1710000000.000400',
    });

    const postCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/chat.postMessage'),
    );
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse(String(postCalls[0][1]?.body))).toMatchObject({
      channel: 'C123',
      text: 'reply in thread',
      thread_ts: '1710000000.000400',
    });

    await channel.disconnect();
  });

  it('uploads attachments through the Slack external upload flow', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://slack.example/upload') {
        return {
          ok: true,
          status: 200,
          text: async () => 'ok',
        } as Response;
      }
      const method = url.split('/').pop();
      if (method === 'auth.test') {
        return jsonResponse({ ok: true, user_id: 'U_BOT' });
      }
      if (method === 'apps.connections.open') {
        return jsonResponse({ ok: true, url: 'wss://slack.example/socket' });
      }
      if (method === 'files.getUploadURLExternal') {
        return jsonResponse({
          ok: true,
          upload_url: 'https://slack.example/upload',
          file_id: 'F123',
        });
      }
      if (method === 'files.completeUploadExternal') {
        return jsonResponse({ ok: true });
      }
      if (method === 'conversations.list') {
        return jsonResponse({ ok: true, channels: [], response_metadata: {} });
      }
      throw new Error(`Unexpected Slack API method: ${method}`);
    });

    const fs = await import('fs');
    const tmpFile = 'slack-report.pdf';
    fs.writeFileSync(tmpFile, 'pdf-body');

    const channel = new SlackChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );
    await channel.connect();
    await channel.sendAttachment?.({
      jid: 'slack:C123',
      filePath: tmpFile,
      mimeType: 'application/pdf',
      fileName: 'life-canada-report.pdf',
      caption: 'Report attached',
    });

    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith('/files.getUploadURLExternal'),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith('/files.completeUploadExternal'),
      ),
    ).toBe(true);

    await channel.disconnect();
    fs.unlinkSync(tmpFile);
  });

  it('exposes Slack-specific helper behavior', () => {
    expect(isSlackJid('slack:C123')).toBe(true);
    expect(makeSlackJid('D123')).toBe('slack:D123');
    expect(
      shouldProcessSlackMessage({
        text: 'hello',
        channelType: 'im',
        selfUserId: 'U_BOT',
      }),
    ).toBe(true);
    expect(
      shouldProcessSlackMessage({
        text: 'hello',
        channelType: 'channel',
        selfUserId: 'U_BOT',
      }),
    ).toBe(false);
  });
});

function jsonResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
