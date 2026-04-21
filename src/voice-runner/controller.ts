import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { createChildLogger } from '../logger.js';

import {
  getVoiceRunnerService,
  type VoiceRunnerService,
} from './live-runner.js';
import type {
  VoiceAudioInputChunk,
  VoiceRunnerCallbacks,
  VoiceRunnerHealth,
  VoiceRunnerSessionStart,
  VoiceRunnerSessionUpdate,
  VoiceTranscriptFinal,
  VoiceTranscriptPartial,
  VoiceRunnerSidecarEvent,
  VoiceRunnerSidecarRequest,
  VoiceRunnerSidecarResponse,
} from './protocol.js';

const log = createChildLogger({ subsystem: 'voice-runner-controller' });

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function getRequestTimeoutMs(
  action: VoiceRunnerSidecarRequest['action'],
): number {
  switch (action) {
    case 'warm':
      return 240_000;
    case 'session.start':
    case 'audio.input':
    case 'transcript.final':
      return 180_000;
    case 'session.idle':
      return 120_000;
    default:
      return 10_000;
  }
}

export interface VoiceRunnerController {
  readonly mode: 'sidecar' | 'in_process';
  configure(settings: Record<string, unknown>): void;
  warm(): Promise<void>;
  refreshHealth(): Promise<VoiceRunnerHealth>;
  getHealthSnapshot(): VoiceRunnerHealth;
  startSession(
    input: VoiceRunnerSessionStart,
    callbacks?: VoiceRunnerCallbacks,
  ): Promise<void>;
  updateSession(input: VoiceRunnerSessionUpdate): Promise<void>;
  waitForIdle(sessionId: string): Promise<void>;
  handleAudioInput(event: VoiceAudioInputChunk): Promise<void>;
  handleTranscriptPartial(event: VoiceTranscriptPartial): Promise<void>;
  handleTranscriptFinal(event: VoiceTranscriptFinal): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

function normalizeHealth(
  payload: Record<string, unknown>,
  mode: VoiceRunnerHealth['mode'],
): VoiceRunnerHealth {
  return {
    ready: Boolean(payload.ready),
    sessions:
      typeof payload.sessions === 'number' ? Math.trunc(payload.sessions) : 0,
    backend: String(payload.backend || 'heuristic'),
    warmedAt:
      typeof payload.warmedAt === 'string' ? payload.warmedAt : undefined,
    pid: typeof payload.pid === 'number' ? payload.pid : undefined,
    lastError:
      typeof payload.lastError === 'string' ? payload.lastError : undefined,
    mode,
  };
}

class InProcessVoiceRunnerController implements VoiceRunnerController {
  readonly mode = 'in_process' as const;
  private readonly service: VoiceRunnerService;

  constructor(settings?: Record<string, unknown>) {
    this.service = getVoiceRunnerService(settings);
  }

  configure(settings: Record<string, unknown>): void {
    this.service.configure(settings);
  }

  async warm(): Promise<void> {
    await this.service.warm();
  }

  async refreshHealth(): Promise<VoiceRunnerHealth> {
    return {
      ...this.service.getHealth(),
      mode: this.mode,
      pid: process.pid,
    };
  }

  getHealthSnapshot(): VoiceRunnerHealth {
    return {
      ...this.service.getHealth(),
      mode: this.mode,
      pid: process.pid,
    };
  }

  async startSession(
    input: VoiceRunnerSessionStart,
    callbacks?: VoiceRunnerCallbacks,
  ): Promise<void> {
    await this.service.startSession(input, callbacks);
  }

  async updateSession(input: VoiceRunnerSessionUpdate): Promise<void> {
    await this.service.updateSession(input);
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.service.waitForIdle(sessionId);
  }

  async handleAudioInput(event: VoiceAudioInputChunk): Promise<void> {
    await this.service.handleAudioInput(event);
  }

  async handleTranscriptPartial(event: VoiceTranscriptPartial): Promise<void> {
    this.service.handleTranscriptPartial(event);
  }

  async handleTranscriptFinal(event: VoiceTranscriptFinal): Promise<void> {
    await this.service.handleTranscriptFinal(event);
  }

  async endSession(sessionId: string): Promise<void> {
    await this.service.endSession(sessionId);
  }

  async shutdown(): Promise<void> {
    return;
  }
}

export class VoiceRunnerSidecarClient implements VoiceRunnerController {
  readonly mode = 'sidecar' as const;
  private child: ChildProcess | null = null;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly callbacksBySession = new Map<string, VoiceRunnerCallbacks>();
  private settings: Record<string, unknown>;
  private lastHealth: VoiceRunnerHealth = {
    ready: false,
    sessions: 0,
    backend: 'unknown',
    mode: 'sidecar',
  };
  private lastError?: string;

  constructor(settings?: Record<string, unknown>) {
    this.settings = { ...(settings || {}) };
  }

  configure(settings: Record<string, unknown>): void {
    this.settings = { ...settings };
    if (this.child) {
      void this.sendRequest('configure', { settings }).catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    }
  }

  async warm(): Promise<void> {
    await this.ensureChild();
    await this.sendRequest('configure', { settings: this.settings });
    await this.sendRequest('warm', {});
    await this.refreshHealth();
  }

  async refreshHealth(): Promise<VoiceRunnerHealth> {
    await this.ensureChild();
    const payload = await this.sendRequest('health', {});
    this.lastHealth = normalizeHealth(payload, this.mode);
    this.lastHealth.lastError = this.lastError;
    return this.lastHealth;
  }

  getHealthSnapshot(): VoiceRunnerHealth {
    return {
      ...this.lastHealth,
      lastError: this.lastError,
    };
  }

  async startSession(
    input: VoiceRunnerSessionStart,
    callbacks: VoiceRunnerCallbacks = {},
  ): Promise<void> {
    await this.ensureChild();
    this.callbacksBySession.set(input.sessionId, callbacks);
    try {
      await this.sendRequest('session.start', { input });
    } catch (err) {
      this.callbacksBySession.delete(input.sessionId);
      throw err;
    }
  }

  async updateSession(input: VoiceRunnerSessionUpdate): Promise<void> {
    await this.sendRequest('session.update', { input });
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.sendRequest('session.idle', { sessionId });
  }

  async handleAudioInput(event: VoiceAudioInputChunk): Promise<void> {
    await this.sendRequest('audio.input', { event });
  }

  async handleTranscriptPartial(event: VoiceTranscriptPartial): Promise<void> {
    await this.sendRequest('transcript.partial', { event });
  }

  async handleTranscriptFinal(event: VoiceTranscriptFinal): Promise<void> {
    await this.sendRequest('transcript.final', { event });
  }

  async endSession(sessionId: string): Promise<void> {
    await this.sendRequest('session.end', { sessionId });
    this.callbacksBySession.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try {
      await this.sendRequest('shutdown', {});
    } catch {
      // Fall through to hard kill.
    }
    this.child.kill();
    this.child = null;
    this.callbacksBySession.clear();
  }

  private async ensureChild(): Promise<void> {
    if (this.child?.connected) return;
    const currentFile = fileURLToPath(import.meta.url);
    const sidecarPath = path.join(
      path.dirname(currentFile),
      path.extname(currentFile) === '.ts'
        ? 'sidecar-process.ts'
        : 'sidecar-process.js',
    );
    const child = spawn(process.execPath, [...process.execArgv, sidecarPath], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    child.on('message', (message) => {
      try {
        this.handleChildMessage(message);
      } catch (err) {
        log.warn({ err }, 'Voice runner sidecar message handling failed');
      }
    });
    child.on('exit', (code, signal) => {
      const error = `voice runner sidecar exited (${code ?? 'null'}/${signal ?? 'none'})`;
      this.lastError = error;
      this.lastHealth = {
        ...this.lastHealth,
        ready: false,
        mode: this.mode,
        lastError: error,
      };
      this.child = null;
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(error));
      }
      this.pendingRequests.clear();
    });
    child.stderr?.on('data', (chunk) => {
      log.warn({ stderr: String(chunk) }, 'Voice runner sidecar stderr');
    });
    this.child = child;
    await this.sendRequest('configure', { settings: this.settings });
  }

  private async sendRequest(
    action: VoiceRunnerSidecarRequest['action'],
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.ensureChildConnected();
    const id = `vr-${++this.requestCounter}`;
    const request: VoiceRunnerSidecarRequest = {
      kind: 'request',
      id,
      action,
      payload,
    };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Voice runner sidecar request timed out: ${action}`));
      }, getRequestTimeoutMs(action));
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.child!.send?.(request);
    });
  }

  private async ensureChildConnected(): Promise<void> {
    if (!this.child) {
      await this.ensureChild();
    }
    if (!this.child?.send) {
      throw new Error('Voice runner sidecar IPC channel is unavailable');
    }
  }

  private handleChildMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const payload = message as
      | VoiceRunnerSidecarResponse
      | VoiceRunnerSidecarEvent;
    if (payload.kind === 'response') {
      const pending = this.pendingRequests.get(payload.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(payload.id);
      if (!payload.ok) {
        pending.reject(new Error(payload.error || 'sidecar_request_failed'));
      } else {
        pending.resolve(payload.payload || {});
      }
      return;
    }

    if (payload.kind !== 'event') return;
    const sessionId =
      typeof payload.payload.sessionId === 'string'
        ? payload.payload.sessionId
        : undefined;
    const callbacks = sessionId
      ? this.callbacksBySession.get(sessionId)
      : undefined;
    switch (payload.event) {
      case 'transcript.partial':
        callbacks?.onTranscriptPartial?.(payload.payload as any);
        return;
      case 'transcript.final':
        void callbacks?.onTranscriptFinal?.(payload.payload as any);
        return;
      case 'response.text.delta':
        callbacks?.onResponseTextDelta?.(payload.payload as any);
        return;
      case 'response.audio.delta':
        callbacks?.onResponseAudioDelta?.(payload.payload as any);
        return;
      case 'response.cancel':
        callbacks?.onResponseCancel?.(payload.payload as any);
        return;
      case 'action.request':
        void callbacks?.onActionRequest?.(payload.payload as any);
        return;
      case 'handoff.enqueue':
        void callbacks?.onHandoffEnqueue?.(payload.payload as any);
        return;
      case 'finalized.agent.turn':
        void callbacks?.onFinalizedAgentTurn?.(payload.payload as any);
        return;
      case 'latency.sample':
        callbacks?.onLatencySample?.(payload.payload as any);
        return;
      default:
        return;
    }
  }
}

export function createVoiceRunnerController(
  settings?: Record<string, unknown>,
): VoiceRunnerController {
  const mode =
    String(settings?.voiceRunnerMode || '').trim() === 'in_process'
      ? 'in_process'
      : 'sidecar';
  return mode === 'in_process'
    ? new InProcessVoiceRunnerController(settings)
    : new VoiceRunnerSidecarClient(settings);
}
