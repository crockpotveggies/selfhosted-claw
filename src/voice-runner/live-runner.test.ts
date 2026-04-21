import { describe, expect, it, vi } from 'vitest';

import { MANAGED_F5_TTS_MODEL_NAME } from './local-tts.js';
import { VoiceRunnerService } from './live-runner.js';

describe('VoiceRunnerService', () => {
  it('cancels active playback on barge-in partials', async () => {
    const runner = new VoiceRunnerService({
      voiceRunnerProvider: 'openai',
      voiceRunnerBaseUrl: 'https://example.test/v1',
      voiceRunnerApiKey: '',
      voiceRunnerModel: 'gpt-4o-mini',
      voiceSttProvider: 'mock',
      voiceTtsProvider: 'mock',
    });
    const cancels: Array<{ reason: string }> = [];
    const turns: string[] = [];
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  choices: [
                    { message: { content: 'Helpful reply from the model' } },
                  ],
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          }, 50);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      await runner.startSession(
        {
          sessionId: 'sess-1',
          chatJid: 'voice:+15551234567',
          caller: {
            phoneNumber: '+15551234567',
            displayName: 'Test Caller',
          },
          metadata: {
            callId: 'call-1',
            startedAt: new Date().toISOString(),
            state: 'active',
            direction: 'incoming',
          },
        },
        {
          onResponseCancel: (event) => cancels.push({ reason: event.reason }),
          onFinalizedAgentTurn: async (event) => {
            turns.push(event.text);
          },
        },
      );

      const pending = runner.handleTranscriptFinal({
        sessionId: 'sess-1',
        text: 'Tell me something helpful',
        timestamp: new Date().toISOString(),
      });
      // Barge-in requires a sustained partial: 4+ words, appearing twice in
      // a growing/stable form within BARGE_IN_WINDOW_MS.
      runner.handleTranscriptPartial({
        sessionId: 'sess-1',
        text: 'Actually wait a second',
        timestamp: new Date().toISOString(),
      });
      runner.handleTranscriptPartial({
        sessionId: 'sess-1',
        text: 'Actually wait a second please',
        timestamp: new Date().toISOString(),
      });
      await pending;

      expect(cancels).toEqual([{ reason: 'barge_in' }]);
      expect(turns).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates deferred handoffs without blocking the call loop', async () => {
    const runner = new VoiceRunnerService({
      voiceRunnerProvider: 'heuristic',
    });
    const handoffs: string[] = [];
    const turns: string[] = [];

    await runner.startSession(
      {
        sessionId: 'sess-2',
        chatJid: 'voice:+15557654321',
        caller: {
          phoneNumber: '+15557654321',
          displayName: 'Follow Up Caller',
        },
        metadata: {
          callId: 'call-2',
          startedAt: new Date().toISOString(),
          state: 'active',
        },
      },
      {
        onHandoffEnqueue: async (event) => {
          handoffs.push(event.summary);
        },
        onFinalizedAgentTurn: async (event) => {
          turns.push(event.text);
        },
      },
    );

    await runner.handleTranscriptFinal({
      sessionId: 'sess-2',
      text: 'Please follow up with me later about the budget',
      timestamp: new Date().toISOString(),
    });

    expect(handoffs).toEqual([
      'Please follow up with me later about the budget',
    ]);
    expect(turns[0]).toContain('right after we finish here');
  });

  it('keeps poor-confidence transcripts out of deep reasoning and asks for clarification', async () => {
    const runner = new VoiceRunnerService({
      voiceRunnerProvider: 'heuristic',
    });
    const turns: string[] = [];
    const actionSpy = vi.fn();

    await runner.startSession(
      {
        sessionId: 'sess-3',
        chatJid: 'voice:+15550001111',
        caller: {
          phoneNumber: '+15550001111',
          displayName: 'Noisy Caller',
        },
        metadata: {
          callId: 'call-3',
          startedAt: new Date().toISOString(),
          state: 'active',
        },
      },
      {
        onFinalizedAgentTurn: async (event) => {
          turns.push(event.text);
        },
        onActionRequest: actionSpy,
      },
    );

    await runner.handleTranscriptFinal({
      sessionId: 'sess-3',
      text: 'muffled audio',
      confidence: 0.2,
      timestamp: new Date().toISOString(),
    });

    expect(actionSpy).not.toHaveBeenCalled();
    expect(turns).toEqual([
      'I did not quite catch that. Could you say it one more time?',
    ]);
  });

  it('owns the audio pipeline from audio input through transcript and synthesized output', async () => {
    const runner = new VoiceRunnerService({
      voiceRunnerProvider: 'heuristic',
      voiceSttProvider: 'mock',
      voiceTtsProvider: 'mock',
    });
    const transcripts: string[] = [];
    const audioChunks: Array<{ contentType: string; text: string }> = [];
    const turns: string[] = [];

    await runner.startSession(
      {
        sessionId: 'sess-4',
        chatJid: 'voice:+15558889999',
        caller: {
          phoneNumber: '+15558889999',
          displayName: 'Audio Caller',
        },
        metadata: {
          callId: 'call-4',
          startedAt: new Date().toISOString(),
          state: 'active',
        },
      },
      {
        onTranscriptFinal: async (event) => {
          transcripts.push(event.text);
        },
        onResponseAudioDelta: (event) => {
          audioChunks.push({
            contentType: event.contentType,
            text: Buffer.from(event.dataBase64, 'base64').toString('utf8'),
          });
        },
        onFinalizedAgentTurn: async (event) => {
          turns.push(event.text);
        },
      },
    );

    await runner.handleAudioInput({
      sessionId: 'sess-4',
      dataBase64: Buffer.from(
        'Please follow up with me later',
        'utf8',
      ).toString('base64'),
      contentType: 'text/plain; charset=utf-8',
      timestamp: new Date().toISOString(),
      endOfTurn: true,
    });

    expect(transcripts).toEqual(['Please follow up with me later']);
    expect(
      audioChunks.some((chunk) => chunk.contentType.startsWith('text/plain')),
    ).toBe(true);
    expect(turns[0]).toContain('right after we finish here');
  });

  it('warms and uses managed F5 TTS when configured as the local synthesizer', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:8792/warm') {
        return new Response(
          JSON.stringify({
            ok: true,
            ready: true,
            data: [{ id: MANAGED_F5_TTS_MODEL_NAME }],
            model_name: MANAGED_F5_TTS_MODEL_NAME,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url === 'http://127.0.0.1:8792/v1/audio/speech') {
        return new Response(Buffer.from('CSMWAV', 'utf8'), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'heuristic',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'managed_f5_tts',
        voiceTtsBaseUrl: 'http://127.0.0.1:8792/v1',
        defaultVoice: 'basic_ref_en',
      });
      const audioChunks: Array<{ contentType: string; bytes: string }> = [];

      await runner.startSession(
        {
          sessionId: 'sess-pocket',
          chatJid: 'voice:+15551110000',
          caller: {
            phoneNumber: '+15551110000',
            displayName: 'OpenVINO TTS Caller',
          },
          metadata: {
            callId: 'call-openvino-tts',
            startedAt: new Date().toISOString(),
            state: 'active',
          },
        },
        {
          onResponseAudioDelta: (event) => {
            audioChunks.push({
              contentType: event.contentType,
              bytes: Buffer.from(event.dataBase64, 'base64').toString('utf8'),
            });
          },
        },
      );

      await runner.handleTranscriptFinal({
        sessionId: 'sess-pocket',
        text: 'Please follow up with me later',
        timestamp: new Date().toISOString(),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8792/warm',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8792/v1/audio/speech',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(
        audioChunks.some(
          (chunk) =>
            chunk.contentType === 'audio/wav' && chunk.bytes === 'CSMWAV',
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not block session startup on greeting synthesis', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:8792/v1/models') {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: MANAGED_F5_TTS_MODEL_NAME }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url === 'http://127.0.0.1:8792/v1/audio/speech') {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return new Response(Buffer.from('WAVDATA', 'utf8'), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'heuristic',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'managed_f5_tts',
        voiceTtsBaseUrl: 'http://127.0.0.1:8792/v1',
        defaultVoice: 'basic_ref_en',
      });
      const audioChunks: string[] = [];

      const startedAt = Date.now();
      await runner.startSession(
        {
          sessionId: 'sess-greeting',
          chatJid: 'voice:+15551110001',
          caller: {
            phoneNumber: '+15551110001',
            displayName: 'Greeting Caller',
          },
          metadata: {
            callId: 'call-greeting',
            startedAt: new Date().toISOString(),
            state: 'active',
          },
          greeting: 'Hello there from the assistant.',
        },
        {
          onResponseAudioDelta: (event) => {
            audioChunks.push(
              Buffer.from(event.dataBase64, 'base64').toString('utf8'),
            );
          },
        },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(75);
      await vi.waitFor(() => {
        expect(audioChunks).toContain('WAVDATA');
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('disables thinking for Qwen-backed live calls so the model returns spoken content', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        chat_template_kwargs?: { enable_thinking?: boolean };
      };
      const content =
        body.chat_template_kwargs?.enable_thinking === false
          ? 'Hey, I am doing well. How are you?'
          : null;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content,
                reasoning: content
                  ? null
                  : 'Thinking Process: this should not leak into the call.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'openai',
        voiceRunnerBaseUrl: 'http://127.0.0.1:8000/v1',
        voiceRunnerModel: 'QuantTrio/Qwen3.5-27B-AWQ',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'mock',
      });
      const turns: string[] = [];

      await runner.startSession(
        {
          sessionId: 'sess-qwen',
          chatJid: 'voice:+15550000001',
          caller: {
            phoneNumber: '+15550000001',
            displayName: 'Qwen Caller',
          },
          metadata: {
            callId: 'call-qwen',
            startedAt: new Date().toISOString(),
            state: 'active',
          },
        },
        {
          onFinalizedAgentTurn: async (event) => {
            turns.push(event.text);
          },
        },
      );

      await runner.handleTranscriptFinal({
        sessionId: 'sess-qwen',
        text: "How's your day going?",
        timestamp: new Date().toISOString(),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8000/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"enable_thinking":false'),
        }),
      );
      expect(turns).toEqual(['Hey, I am doing well. How are you?']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('applies custom LLM prompts and instructions to live turns', async () => {
    let capturedBody: any;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Custom prompt received.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'openai',
        voiceRunnerBaseUrl: 'http://127.0.0.1:8793/v1',
        voiceRunnerModel: 'phone-voice-qwen3-4b',
        voiceRunnerSystemPrompt: 'You are Lena. Be very brief.',
        voiceRunnerInstructions:
          'Use a warmer tone and never ask what the next thing is.',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'mock',
      });
      const turns: string[] = [];

      await runner.startSession(
        {
          sessionId: 'sess-custom-prompt',
          chatJid: 'voice:+15550000002',
          caller: {
            phoneNumber: '+15550000002',
            displayName: 'Prompt Caller',
          },
          metadata: {
            callId: 'call-custom-prompt',
            startedAt: new Date().toISOString(),
            state: 'active',
          },
        },
        {
          onFinalizedAgentTurn: async (event) => {
            turns.push(event.text);
          },
        },
      );

      await runner.handleTranscriptFinal({
        sessionId: 'sess-custom-prompt',
        text: 'How are you?',
        timestamp: new Date().toISOString(),
      });

      expect(capturedBody.messages[0].role).toBe('system');
      expect(capturedBody.messages[0].content).toContain(
        'You are Lena. Be very brief.',
      );
      expect(capturedBody.messages[0].content).toContain(
        'Use a warmer tone and never ask what the next thing is.',
      );
      expect(capturedBody.messages[0].content).toContain('/no_think');
      expect(capturedBody.messages[0].content).toContain('Caller: Prompt Caller');
      expect(capturedBody.messages[1]).toEqual({
        role: 'user',
        content: 'How are you?',
      });
      expect(capturedBody.messages[1].content).not.toContain('Caller now:');
      expect(turns).toEqual(['Custom prompt received.']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not emit canned latency fillers by default while the LLM is slow', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  choices: [{ message: { content: 'Actual model response.' } }],
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          }, 220);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'openai',
        voiceRunnerBaseUrl: 'https://example.test/v1',
        voiceRunnerModel: 'gpt-4o-mini',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'mock',
      });
      const deltas: string[] = [];

      await runner.startSession(
        {
          sessionId: 'sess-no-fillers',
          chatJid: 'voice:+15550000003',
          caller: {
            phoneNumber: '+15550000003',
            displayName: 'No Filler Caller',
          },
          metadata: {
            callId: 'call-no-fillers',
            startedAt: new Date().toISOString(),
            state: 'active',
          },
        },
        {
          onResponseTextDelta: (event) => {
            deltas.push(event.text);
          },
        },
      );

      await runner.handleTranscriptFinal({
        sessionId: 'sess-no-fillers',
        text: 'Pause before answering',
        timestamp: new Date().toISOString(),
      });

      expect(deltas).toEqual(['Actual model response.']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses custom latency filler phrases when fillers are enabled', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  choices: [{ message: { content: 'Actual model response.' } }],
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          }, 220);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'openai',
        voiceRunnerBaseUrl: 'https://example.test/v1',
        voiceRunnerModel: 'gpt-4o-mini',
        voiceRunnerFillersEnabled: true,
        voiceRunnerFillers: 'hmmm\none sec',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'mock',
      });
      const deltas: string[] = [];

      await runner.startSession(
        {
          sessionId: 'sess-custom-fillers',
          chatJid: 'voice:+15550000004',
          caller: {
            phoneNumber: '+15550000004',
            displayName: 'Custom Filler Caller',
          },
          metadata: {
            callId: 'call-custom-fillers',
            startedAt: new Date().toISOString(),
            state: 'active',
          },
        },
        {
          onResponseTextDelta: (event) => {
            deltas.push(event.text);
          },
        },
      );

      await runner.handleTranscriptFinal({
        sessionId: 'sess-custom-fillers',
        text: 'Pause before answering',
        timestamp: new Date().toISOString(),
      });

      expect(deltas).toContain('one sec');
      expect(deltas).toContain('Actual model response.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes streaming STT partial and final events through the runner', async () => {
    const sockets: any[] = [];
    class FakeStreamSocket {
      url: string;
      readyState = 0;
      private listeners = new Map<string, Array<(ev: any) => void>>();
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.fire('open', {});
        });
      }
      addEventListener(event: string, handler: (ev: any) => void) {
        const list = this.listeners.get(event) || [];
        list.push(handler);
        this.listeners.set(event, list);
      }
      removeEventListener() {}
      fire(event: string, ev: any) {
        for (const h of this.listeners.get(event) || []) h(ev);
      }
      send(_data: unknown) {}
      close() {
        this.readyState = 3;
        this.fire('close', {});
      }
    }
    vi.stubGlobal('WebSocket', FakeStreamSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/healthz')) {
          return new Response(JSON.stringify({ ready: true }), {
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

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'heuristic',
        voiceSttProvider: 'managed_stream',
        voiceStreamSttBaseUrl: 'http://127.0.0.1:8794',
        voiceTtsProvider: 'mock',
      });
      const partials: string[] = [];
      const finals: string[] = [];

      await runner.startSession(
        {
          sessionId: 'sess-stream',
          chatJid: 'voice:+15550001234',
          caller: {
            phoneNumber: '+15550001234',
            displayName: 'Stream Caller',
          },
          metadata: {
            callId: 'call-stream',
            startedAt: new Date().toISOString(),
            state: 'active',
          },
        },
        {
          onTranscriptPartial: (event) => partials.push(event.text),
          onTranscriptFinal: async (event) => {
            finals.push(event.text);
          },
        },
      );

      await vi.waitFor(() => {
        expect(sockets.length).toBeGreaterThanOrEqual(1);
        expect(sockets[0].readyState).toBe(1);
      });

      sockets[0].fire('message', {
        data: JSON.stringify({
          type: 'partial',
          text: 'hello wo',
          timestamp: new Date().toISOString(),
        }),
      });
      sockets[0].fire('message', {
        data: JSON.stringify({
          type: 'final',
          text: 'hello world please',
          timestamp: new Date().toISOString(),
          isEndpoint: true,
        }),
      });

      await vi.waitFor(() => {
        expect(finals).toContain('hello world please');
      });
      expect(partials).toContain('hello wo');

      await runner.endSession('sess-stream');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('injects caller profile, call summary, and barge-in context into the next turn without blocking the response path', async () => {
    const responseBodies: string[] = [];
    const digestBodies: string[] = [];
    let blockDigest!: () => void;
    const digestBlocked = new Promise<void>((resolve) => {
      blockDigest = resolve;
    });
    let digestDone!: () => void;
    const digestFinished = new Promise<void>((resolve) => {
      digestDone = resolve;
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        messages: Array<{ role: string; content: string }>;
      };
      const systemMsg = body.messages[0]?.content || '';
      const isDigest = systemMsg.includes('note-taker');
      if (isDigest) {
        digestBodies.push(JSON.stringify(body));
        await digestBlocked;
        const response = new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Caller asked about the budget.',
                    intent: 'Budget review',
                    promisedActions: ['send the numbers later'],
                    openQuestions: ['final deadline'],
                    mood: 'focused',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
        queueMicrotask(() => digestDone());
        return response;
      }
      responseBodies.push(JSON.stringify(body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `Reply #${responseBodies.length}.`,
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'openai',
        voiceRunnerBaseUrl: 'https://example.test/v1',
        voiceRunnerApiKey: '',
        voiceRunnerModel: 'gpt-4o-mini',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'mock',
      });

      await runner.startSession(
        {
          sessionId: 'sess-digest',
          chatJid: 'voice:+15559998888',
          caller: {
            phoneNumber: '+15559998888',
            displayName: 'Digest Caller',
          },
          metadata: {
            callId: 'call-digest',
            startedAt: '2026-04-20T12:00:00.000Z',
            state: 'active',
            direction: 'incoming',
          },
        },
        {},
      );

      expect(responseBodies.length).toBe(0);
      expect(digestBodies.length).toBe(0);

      for (let i = 0; i < 7; i++) {
        await runner.handleTranscriptFinal({
          sessionId: 'sess-digest',
          text: `Turn number ${i} text`,
          timestamp: new Date().toISOString(),
        });
      }

      const firstReply = JSON.parse(responseBodies[0]) as {
        messages: Array<{ content: string }>;
      };
      expect(firstReply.messages[0].content).toContain('Caller: Digest Caller');
      expect(firstReply.messages[0].content).toContain('Phone: +15559998888');
      expect(firstReply.messages[0].content).toContain('Direction: incoming');

      // Digest was kicked off but not awaited by the response path.
      expect(digestBodies.length).toBeGreaterThan(0);
      expect(responseBodies.length).toBe(7);

      // Release the digest and wait for it to propagate to the next prompt.
      blockDigest();
      await digestFinished;

      // Poll: fire additional turns until the summary lands on the prompt.
      await vi.waitFor(
        async () => {
          await runner.handleTranscriptFinal({
            sessionId: 'sess-digest',
            text: `Probe turn ${responseBodies.length}`,
            timestamp: new Date().toISOString(),
          });
          const latest = JSON.parse(
            responseBodies[responseBodies.length - 1],
          ) as { messages: Array<{ content: string }> };
          expect(latest.messages[0].content).toContain(
            'Call so far: Caller asked about the budget.',
          );
        },
        { timeout: 2000, interval: 20 },
      );

      const latest = JSON.parse(
        responseBodies[responseBodies.length - 1],
      ) as { messages: Array<{ content: string }> };
      expect(latest.messages[0].content).toContain('Intent: Budget review');
      expect(latest.messages[0].content).toContain(
        'Promised: send the numbers later',
      );
      expect(latest.messages[0].content).toContain(
        'Open questions: final deadline',
      );
      expect(latest.messages[0].content).toContain('Mood: focused');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces a barge-in interruption note in the next turn and clears it afterward', async () => {
    const responseBodies: string[] = [];

    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        messages: Array<{ role: string; content: string }>;
      };
      if ((body.messages[0]?.content || '').includes('note-taker')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{}' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      responseBodies.push(JSON.stringify(body));
      if (responseBodies.length === 1) {
        // Hold the first response until a barge-in partial cancels it.
        const abort = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          abort?.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: 'Second reply after interruption.' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    try {
      const runner = new VoiceRunnerService({
        voiceRunnerProvider: 'openai',
        voiceRunnerBaseUrl: 'https://example.test/v1',
        voiceRunnerApiKey: '',
        voiceRunnerModel: 'gpt-4o-mini',
        voiceSttProvider: 'mock',
        voiceTtsProvider: 'mock',
      });
      const cancels: string[] = [];

      await runner.startSession(
        {
          sessionId: 'sess-barge',
          chatJid: 'voice:+15554445555',
          caller: {
            phoneNumber: '+15554445555',
            displayName: 'Barge Caller',
          },
          metadata: {
            callId: 'call-barge',
            startedAt: new Date().toISOString(),
            state: 'active',
            direction: 'incoming',
          },
        },
        {
          onResponseCancel: (event) => cancels.push(event.reason),
        },
      );

      const pending = runner.handleTranscriptFinal({
        sessionId: 'sess-barge',
        text: 'First caller question',
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(responseBodies.length).toBe(1);
      });

      // Simulate partial speech from the caller (barge-in). No assistant text
      // was emitted yet since the response is still pending, so we manually
      // inject it through a fixed-response path to exercise the capture.
      runner.handleTranscriptPartial({
        sessionId: 'sess-barge',
        text: 'Wait hold on please',
        timestamp: new Date().toISOString(),
      });
      runner.handleTranscriptPartial({
        sessionId: 'sess-barge',
        text: 'Wait hold on please stop',
        timestamp: new Date().toISOString(),
      });

      await pending;
      expect(cancels).toContain('barge_in');

      // Now do a second turn: without a spokenSoFar, no interruption note
      // expected. Confirm the next prompt does not include it stale.
      await runner.handleTranscriptFinal({
        sessionId: 'sess-barge',
        text: 'Second caller question',
        timestamp: new Date().toISOString(),
      });
      const second = JSON.parse(
        responseBodies[responseBodies.length - 1],
      ) as { messages: Array<{ content: string }> };
      expect(second.messages[0].content).not.toContain(
        'previous reply was interrupted',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
