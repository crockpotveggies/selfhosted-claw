import { describe, expect, it, vi } from 'vitest';

import { VoiceRunnerService } from './live-runner.js';

describe('VoiceRunnerService', () => {
  it('cancels active playback on barge-in partials', async () => {
    const runner = new VoiceRunnerService({
      voiceRunnerProvider: 'openai',
      voiceRunnerBaseUrl: 'https://example.test/v1',
      voiceRunnerApiKey: 'voice-key',
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
      runner.handleTranscriptPartial({
        sessionId: 'sess-1',
        text: 'Actually wait',
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
});
