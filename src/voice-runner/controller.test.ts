import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

class FakeChild extends EventEmitter {
  connected = true;
  stderr = new EventEmitter();
  killed = false;
  sent: unknown[] = [];
  constructor(private readonly suppressActions: string[] = []) {
    super();
  }

  send(message: any) {
    this.sent.push(message);
    const action = message.action;
    if (this.suppressActions.includes(action)) {
      return true;
    }
    if (
      action === 'configure' ||
      action === 'warm' ||
      action === 'session.start'
    ) {
      queueMicrotask(() =>
        this.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          payload: {},
        }),
      );
      return true;
    }
    if (action === 'health') {
      queueMicrotask(() =>
        this.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          payload: {
            ready: true,
            sessions: 1,
            backend: 'heuristic',
            pid: 4242,
          },
        }),
      );
      return true;
    }
    if (action === 'transcript.final') {
      queueMicrotask(() => {
        this.emit('message', {
          kind: 'event',
          event: 'finalized.agent.turn',
          payload: {
            sessionId: message.payload.event.sessionId,
            text: 'Sidecar says hello',
            timestamp: new Date().toISOString(),
          },
        });
        this.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          payload: {},
        });
      });
      return true;
    }
    if (action === 'audio.input') {
      queueMicrotask(() => {
        this.emit('message', {
          kind: 'event',
          event: 'transcript.final',
          payload: {
            sessionId: message.payload.event.sessionId,
            text: 'Audio transcript',
            timestamp: new Date().toISOString(),
            source: 'stt',
          },
        });
        this.emit('message', {
          kind: 'event',
          event: 'response.audio.delta',
          payload: {
            sessionId: message.payload.event.sessionId,
            dataBase64: Buffer.from('Audio reply', 'utf8').toString('base64'),
            contentType: 'text/plain; charset=utf-8',
            text: 'Audio reply',
            timestamp: new Date().toISOString(),
          },
        });
        this.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          payload: {},
        });
      });
      return true;
    }
    if (
      action === 'session.end' ||
      action === 'session.idle' ||
      action === 'shutdown'
    ) {
      queueMicrotask(() =>
        this.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          payload: {},
        }),
      );
      return true;
    }
    return true;
  }

  kill() {
    this.killed = true;
    this.connected = false;
    this.emit('exit', 0, null);
    return true;
  }
}

import {
  VoiceRunnerSidecarClient,
  createVoiceRunnerController,
} from './controller.js';

describe('voice runner controller', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('creates an in-process controller when explicitly requested', () => {
    const controller = createVoiceRunnerController({
      voiceRunnerMode: 'in_process',
    });
    expect(controller.mode).toBe('in_process');
  });

  it('bridges sidecar events back to session callbacks', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const controller = new VoiceRunnerSidecarClient({});
    const turns: string[] = [];
    const transcripts: string[] = [];
    const audioTexts: string[] = [];

    await controller.warm();
    await controller.startSession(
      {
        sessionId: 'sess-sidecar',
        chatJid: 'voice:+15551230000',
        caller: {
          phoneNumber: '+15551230000',
          displayName: 'Sidecar Caller',
        },
        metadata: {
          callId: 'call-sidecar',
          startedAt: new Date().toISOString(),
        },
      },
      {
        onTranscriptFinal: async (event) => {
          transcripts.push(event.text);
        },
        onResponseAudioDelta: (event) => {
          audioTexts.push(
            Buffer.from(event.dataBase64, 'base64').toString('utf8'),
          );
        },
        onFinalizedAgentTurn: async (event) => {
          turns.push(event.text);
        },
      },
    );

    await controller.handleAudioInput({
      sessionId: 'sess-sidecar',
      dataBase64: Buffer.from('audio', 'utf8').toString('base64'),
      contentType: 'text/plain; charset=utf-8',
      timestamp: new Date().toISOString(),
      endOfTurn: true,
    });

    await controller.handleTranscriptFinal({
      sessionId: 'sess-sidecar',
      text: 'hello',
      timestamp: new Date().toISOString(),
    });

    expect(turns).toEqual(['Sidecar says hello']);
    expect(transcripts).toEqual(['Audio transcript']);
    expect(audioTexts).toEqual(['Audio reply']);
    const health = await controller.refreshHealth();
    expect(health).toMatchObject({
      ready: true,
      backend: 'heuristic',
      mode: 'sidecar',
      pid: 4242,
    });

    await controller.shutdown();
    expect(child.killed).toBe(true);
  });

  it('gives warm requests a longer timeout budget than ordinary sidecar calls', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(['warm']);
    spawnMock.mockReturnValue(child);
    const controller = new VoiceRunnerSidecarClient({});

    let settled = false;
    const warmPromise = controller.warm().then(() => {
      settled = true;
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);

    const warmRequest = child.sent.find(
      (message: any) => message.action === 'warm',
    ) as { id: string } | undefined;
    expect(warmRequest?.id).toBeTruthy();

    child.emit('message', {
      kind: 'response',
      id: warmRequest!.id,
      ok: true,
      payload: {},
    });

    await warmPromise;
    expect(settled).toBe(true);
  });
});
