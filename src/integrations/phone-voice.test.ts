import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const integrationSettings: Record<string, any> = {
  PHONE_VOICE_API_KEY: 'voice-secret',
  gatewayUrl: 'ws://127.0.0.1:8787/',
  allowUnknownCallers: true,
  defaultVoice: 'default',
  voiceRunnerMode: 'in_process',
  voiceRunnerProvider: 'heuristic',
  voiceTtsProvider: 'mock',
  voiceTtsBaseUrl: '',
  voiceTtsApiKey: '',
  voiceTtsModel: '',
};

const dbMocks = vi.hoisted(() => ({
  storeMessageIfNew: vi.fn((message: Record<string, unknown>) =>
    Boolean(message),
  ),
  storeChatMetadata: vi.fn(
    (
      _chatJid: string,
      _timestamp: string,
      _name?: string,
      _channel?: string,
      _isGroup?: boolean,
    ) => undefined,
  ),
  setRegisteredGroup: vi.fn(
    (_jid: string, _group: import('../types.js').RegisteredGroup) => undefined,
  ),
  updateChatName: vi.fn((_chatJid: string, _name: string) => undefined),
}));

const serviceManagerMocks = vi.hoisted(() => ({
  startService: vi.fn(() => ({
    integrationName: 'phone-voice',
    serviceName: 'phone-voice-stt',
    configured: true,
    running: true,
    lastError: '',
    circuitOpen: false,
  })),
  stopService: vi.fn(() => ({
    integrationName: 'phone-voice',
    serviceName: 'phone-voice-stt',
    configured: true,
    running: false,
    lastError: '',
    circuitOpen: false,
  })),
  getServiceStatus: vi.fn(() => ({
    integrationName: 'phone-voice',
    serviceName: 'phone-voice-stt',
    configured: true,
    running: true,
    lastError: '',
    circuitOpen: false,
  })),
}));

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

vi.mock('./service-manager.js', () => ({
  startService: serviceManagerMocks.startService,
  stopService: serviceManagerMocks.stopService,
  getServiceStatus: serviceManagerMocks.getServiceStatus,
}));

vi.mock('../db.js', () => ({
  storeMessageIfNew: dbMocks.storeMessageIfNew,
  storeChatMetadata: dbMocks.storeChatMetadata,
  setRegisteredGroup: dbMocks.setRegisteredGroup,
  updateChatName: dbMocks.updateChatName,
}));

vi.mock('../group-folder.js', () => ({
  deriveUniqueGroupFolder: vi.fn(() => 'voice-caller'),
  resolveGroupFolderPath: vi.fn(() =>
    path.join(os.tmpdir(), 'phone-voice-test'),
  ),
}));

vi.mock('../agent-memory.js', () => ({
  ensureAgentMemoryFile: vi.fn(),
}));

vi.mock('../voice-runner/handoff-store.js', () => ({
  VoiceHandoffStore: class {
    private pending = new Set<string>();

    enqueue(handoff: { id: string }) {
      this.pending.add(handoff.id);
      return handoff.id;
    }

    markDelivered(id: string) {
      this.pending.delete(id);
    }

    getPendingCount() {
      return this.pending.size;
    }
  },
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sentMessages: Array<Record<string, unknown>> = [];
  readonly options?: { headers?: Record<string, string> };

  constructor(
    public readonly url: string | URL,
    options?: { headers?: Record<string, string> },
  ) {
    this.options = options;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string) {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    this.sentMessages.push(payload);
    const type = String(payload.type || '');
    const requestId = String(payload.requestId || '');
    if (type === 'getDialerState') {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        payload: { ready: true },
      });
      return;
    }
    if (type === 'getGatewayState') {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        payload: { running: true, enabled: true },
      });
      return;
    }
    if (
      type === 'assistant.audio' ||
      type === 'assistant.speak' ||
      type === 'assistant.cancel' ||
      type === 'setMuted' ||
      type === 'sendDtmf' ||
      type === 'endCall' ||
      type === 'rejectCall' ||
      type === 'placeCall'
    ) {
      this.emit({
        type: 'response',
        requestId,
        ok: true,
        payload: { ok: true },
      });
    }
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    this.onclose?.();
  }
}

import { PhoneVoiceChannel } from './phone-voice.js';

describe('PhoneVoiceChannel', () => {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroupsState: Record<
    string,
    import('../types.js').RegisteredGroup
  > = {};
  const registeredGroups = vi.fn(() => registeredGroupsState);

  beforeEach(() => {
    onMessage.mockReset();
    onChatMetadata.mockReset();
    registeredGroups.mockReset();
    registeredGroups.mockReturnValue(registeredGroupsState);
    for (const key of Object.keys(registeredGroupsState))
      delete registeredGroupsState[key];
    dbMocks.storeMessageIfNew.mockClear();
    dbMocks.storeChatMetadata.mockClear();
    dbMocks.setRegisteredGroup.mockClear();
    dbMocks.updateChatName.mockClear();
    serviceManagerMocks.startService.mockClear();
    serviceManagerMocks.stopService.mockClear();
    serviceManagerMocks.getServiceStatus.mockClear();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/healthz')) {
          return new Response(JSON.stringify({ ok: true, ready: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/warm')) {
          return new Response(JSON.stringify({ ok: true, ready: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores finalized turns directly and avoids waking the normal queue during routine voice turns', async () => {
    const channel = new PhoneVoiceChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();

    expect(String(MockWebSocket.instances[0]?.url)).toBe(
      'ws://127.0.0.1:8787/',
    );
    expect(MockWebSocket.instances[0]?.options).toEqual({
      headers: {
        Authorization: 'Bearer voice-secret',
      },
    });
    await vi.waitFor(() => {
      expect(
        MockWebSocket.instances[0]?.sentMessages
          .slice(0, 2)
          .map((message) => message.type),
      ).toEqual(['getGatewayState', 'getDialerState']);
    });

    MockWebSocket.instances[0]?.emit({
      type: 'call.added',
      payload: {
        callId: 'call-1',
        sessionId: 'sess-1',
        phoneNumber: '+15551234567',
        displayName: 'Caller One',
        direction: 'incoming',
        state: 'active',
      },
    });

    await vi.waitFor(() => {
      expect(onChatMetadata).toHaveBeenCalledWith(
        'voice:+15551234567',
        expect.any(String),
        'Caller One',
        'phone-voice',
        false,
      );
    });

    onMessage.mockClear();
    dbMocks.storeMessageIfNew.mockClear();

    MockWebSocket.instances[0]?.emit({
      type: 'transcript.partial',
      payload: {
        sessionId: 'sess-1',
        text: 'hello there',
      },
    });
    MockWebSocket.instances[0]?.emit({
      type: 'transcript.final',
      payload: {
        sessionId: 'sess-1',
        text: 'Can you help me with my account',
        timestamp: new Date().toISOString(),
      },
    });

    await vi.waitFor(() => {
      expect(
        dbMocks.storeMessageIfNew.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });

    expect(onMessage).not.toHaveBeenCalled();
    const storedMessages = dbMocks.storeMessageIfNew.mock.calls.map(
      (call) => call[0],
    );
    expect(
      storedMessages.some(
        (message) =>
          message.chat_jid === 'voice:+15551234567' &&
          message.content === 'Can you help me with my account' &&
          message.is_from_me === false,
      ),
    ).toBe(true);
    expect(
      storedMessages.some(
        (message) =>
          message.chat_jid === 'voice:+15551234567' &&
          message.is_from_me === true &&
          message.is_bot_message === true,
      ),
    ).toBe(true);

    await channel.disconnect();
  });

  it('forwards gateway audio chunks into the runner and sends synthesized audio back out', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from('WAVDATA', 'utf8'), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    const previousTtsProvider = integrationSettings.voiceTtsProvider;
    const previousTtsBaseUrl = integrationSettings.voiceTtsBaseUrl;
    const previousTtsApiKey = integrationSettings.voiceTtsApiKey;
    const previousTtsModel = integrationSettings.voiceTtsModel;
    integrationSettings.voiceTtsProvider = 'openai';
    integrationSettings.voiceTtsBaseUrl = 'https://example.test/v1';
    integrationSettings.voiceTtsApiKey = 'tts-key';
    integrationSettings.voiceTtsModel = 'gpt-4o-mini-tts';

    const channel = new PhoneVoiceChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    try {
      await channel.connect();

      MockWebSocket.instances[0]?.emit({
        type: 'call.added',
        payload: {
          callId: 'call-audio',
          sessionId: 'sess-audio',
          phoneNumber: '+15550002222',
          displayName: 'Audio Caller',
          direction: 'incoming',
          state: 'active',
        },
      });

      await vi.waitFor(() => {
        expect(onChatMetadata).toHaveBeenCalledWith(
          'voice:+15550002222',
          expect.any(String),
          'Audio Caller',
          'phone-voice',
          false,
        );
      });

      dbMocks.storeMessageIfNew.mockClear();
      MockWebSocket.instances[0]!.sentMessages.length = 0;

      MockWebSocket.instances[0]?.emit({
        type: 'audio.input',
        payload: {
          sessionId: 'sess-audio',
          dataBase64: Buffer.from(
            'Please follow up with me later about the renewal',
            'utf8',
          ).toString('base64'),
          contentType: 'text/plain; charset=utf-8',
          endOfTurn: true,
          timestamp: new Date().toISOString(),
        },
      });

      await vi.waitFor(() => {
        expect(
          dbMocks.storeMessageIfNew.mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
      });

      await vi.waitFor(() => {
        expect(
          MockWebSocket.instances[0]!.sentMessages.some(
            (message) => message.type === 'assistant.audio',
          ),
        ).toBe(true);
      });

      await channel.disconnect();
    } finally {
      integrationSettings.voiceTtsProvider = previousTtsProvider;
      integrationSettings.voiceTtsBaseUrl = previousTtsBaseUrl;
      integrationSettings.voiceTtsApiKey = previousTtsApiKey;
      integrationSettings.voiceTtsModel = previousTtsModel;
      vi.unstubAllGlobals();
    }
  });

  it('supports an ephemeral browser voice test session without the phone gateway path', async () => {
    const channel = new PhoneVoiceChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    const started = await channel.startBrowserVoiceSession('Browser QA');
    expect(started.sessionId).toContain('browser:');
    expect(
      started.events.some(
        (event) =>
          event.type === 'assistant_turn' &&
          event.text?.includes('Browser voice test is ready'),
      ),
    ).toBe(true);

    const response = await channel.sendBrowserVoiceAudio({
      sessionId: started.sessionId,
      dataBase64: Buffer.from(
        'Please follow up with me later about the browser path',
        'utf8',
      ).toString('base64'),
      contentType: 'text/plain; charset=utf-8',
    });

    expect(
      response.events.some(
        (event) =>
          event.type === 'caller_turn' &&
          event.text ===
            'Please follow up with me later about the browser path',
      ),
    ).toBe(true);
    expect(
      response.events.some(
        (event) =>
          event.type === 'assistant_turn' &&
          event.text?.includes('right after we finish here'),
      ),
    ).toBe(true);

    await channel.endBrowserVoiceSession(started.sessionId);
  });

  it('defers follow-up work until the call ends', async () => {
    const channel = new PhoneVoiceChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    await channel.connect();

    MockWebSocket.instances[0]?.emit({
      type: 'call.added',
      payload: {
        callId: 'call-2',
        sessionId: 'sess-2',
        phoneNumber: '+15557654321',
        displayName: 'Caller Two',
        direction: 'incoming',
        state: 'ringing',
      },
    });

    await vi.waitFor(() => {
      expect(onChatMetadata).toHaveBeenCalledWith(
        'voice:+15557654321',
        expect.any(String),
        'Caller Two',
        'phone-voice',
        false,
      );
    });

    dbMocks.storeMessageIfNew.mockClear();
    onMessage.mockClear();

    MockWebSocket.instances[0]?.emit({
      type: 'transcript.final',
      payload: {
        sessionId: 'sess-2',
        text: 'Please follow up with me later about the invoice',
        timestamp: new Date().toISOString(),
      },
    });

    await vi.waitFor(() => {
      expect(
        dbMocks.storeMessageIfNew.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(onMessage).not.toHaveBeenCalled();

    MockWebSocket.instances[0]?.emit({
      type: 'call.removed',
      payload: {
        callId: 'call-2',
      },
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        'voice:+15557654321',
        expect.objectContaining({
          content: expect.stringContaining('[Phone voice follow-up]'),
        }),
      );
    });

    await channel.disconnect();
  });

  it('starts and warms the managed STT service in the background when the channel connects', async () => {
    const previousProvider = integrationSettings.voiceSttProvider;
    const previousModel = integrationSettings.voiceSttModel;
    const previousDevice = integrationSettings.voiceSttTargetDevice;
    const previousQuantization = integrationSettings.voiceSttQuantization;
    integrationSettings.voiceSttProvider = 'managed_openvino';
    integrationSettings.voiceSttModel = 'openai/whisper-base.en';
    integrationSettings.voiceSttTargetDevice = 'AUTO:GPU,CPU';
    integrationSettings.voiceSttQuantization = 'int8';

    const channel = new PhoneVoiceChannel(
      { onMessage, onChatMetadata, registeredGroups },
      integrationSettings,
    );

    try {
      await channel.connect();

      await vi.waitFor(() => {
        expect(serviceManagerMocks.startService).toHaveBeenCalledWith(
          'phone-voice',
        );
      });
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          'http://127.0.0.1:8791/healthz',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8791/warm',
        expect.objectContaining({ method: 'POST' }),
      );

      await channel.disconnect();
    } finally {
      integrationSettings.voiceSttProvider = previousProvider;
      integrationSettings.voiceSttModel = previousModel;
      integrationSettings.voiceSttTargetDevice = previousDevice;
      integrationSettings.voiceSttQuantization = previousQuantization;
    }
  });
});
