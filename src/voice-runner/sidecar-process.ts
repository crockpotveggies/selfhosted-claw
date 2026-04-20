import { createChildLogger } from '../logger.js';

import { VoiceRunnerService } from './live-runner.js';
import type {
  VoiceRunnerSidecarEvent,
  VoiceRunnerSidecarRequest,
  VoiceRunnerSidecarResponse,
  VoiceRunnerCallbacks,
} from './protocol.js';

const log = createChildLogger({ subsystem: 'voice-runner-sidecar' });
const runner = new VoiceRunnerService();

function toRecord<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function sendResponse(message: VoiceRunnerSidecarResponse): void {
  process.send?.(message);
}

function sendEvent(
  event: VoiceRunnerSidecarEvent['event'],
  payload: Record<string, unknown>,
): void {
  const message: VoiceRunnerSidecarEvent = {
    kind: 'event',
    event,
    payload,
  };
  process.send?.(message);
}

function buildCallbacks(): VoiceRunnerCallbacks {
  return {
    onTranscriptPartial: (event) =>
      sendEvent('transcript.partial', toRecord(event)),
    onTranscriptFinal: async (event) =>
      sendEvent('transcript.final', toRecord(event)),
    onResponseTextDelta: (event) =>
      sendEvent('response.text.delta', toRecord(event)),
    onResponseAudioDelta: (event) =>
      sendEvent('response.audio.delta', toRecord(event)),
    onResponseCancel: (event) => sendEvent('response.cancel', toRecord(event)),
    onActionRequest: async (event) =>
      sendEvent('action.request', toRecord(event)),
    onHandoffEnqueue: async (event) =>
      sendEvent('handoff.enqueue', toRecord(event)),
    onFinalizedAgentTurn: async (event) =>
      sendEvent('finalized.agent.turn', toRecord(event)),
    onLatencySample: (sample) => sendEvent('latency.sample', toRecord(sample)),
  };
}

async function handleRequest(
  request: VoiceRunnerSidecarRequest,
): Promise<void> {
  try {
    switch (request.action) {
      case 'configure':
        runner.configure(
          (request.payload?.settings as Record<string, unknown> | undefined) ||
            {},
        );
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'warm':
        await runner.warm();
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'health':
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {
            ...runner.getHealth(),
            pid: process.pid,
          },
        });
        return;
      case 'session.start':
        await runner.startSession(
          request.payload?.input as any,
          buildCallbacks(),
        );
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'session.update':
        await runner.updateSession(request.payload?.input as any);
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'session.idle':
        await runner.waitForIdle(String(request.payload?.sessionId || ''));
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'audio.input':
        await runner.handleAudioInput(request.payload?.event as any);
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'transcript.partial':
        runner.handleTranscriptPartial(request.payload?.event as any);
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'transcript.final':
        await runner.handleTranscriptFinal(request.payload?.event as any);
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'session.end':
        await runner.endSession(String(request.payload?.sessionId || ''));
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        return;
      case 'shutdown':
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: true,
          payload: {},
        });
        setTimeout(() => process.exit(0), 10);
        return;
      default:
        sendResponse({
          kind: 'response',
          id: request.id,
          ok: false,
          error: `Unsupported action: ${request.action}`,
        });
    }
  } catch (err) {
    log.error(
      { err, action: request.action },
      'Voice runner sidecar request failed',
    );
    sendResponse({
      kind: 'response',
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  const request = message as VoiceRunnerSidecarRequest;
  if (request.kind !== 'request' || !request.id) return;
  void handleRequest(request);
});

process.on('disconnect', () => {
  process.exit(0);
});
