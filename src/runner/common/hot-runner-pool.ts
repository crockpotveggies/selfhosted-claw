import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  ENABLE_HOT_RUNNER_CONTAINERS,
  HOT_RUNNER_POOL_IDLE_TTL_MS,
  HOT_RUNNER_POOL_MAX_SIZE,
  HOT_RUNNER_POOL_MIN_IDLE,
  MOUNT_ROOT,
  STORE_DIR,
} from '../../config.js';
import { resolveHostPath } from '../../host-paths.js';
import {
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from '../../container-runtime.js';
import { parseRunSpec } from '../../protocol/schemas.js';
import type { RunResult, RunSpec } from '../../protocol/types.js';
import { getKnownTemplateNames } from './templates.js';
import { LocalRunSpecExecutor } from './local-runspec-executor.js';
import type { RunSpecExecutor } from './contracts.js';

type SessionStatus = 'idle' | 'busy';

export interface RunnerSession {
  id: string;
  execute(runSpec: RunSpec): Promise<RunResult>;
  close(): Promise<void>;
}

export interface RunnerSessionFactory {
  create(): Promise<RunnerSession>;
}

export interface HotRunnerPoolOptions {
  lane: RunSpec['runner_pool'];
  maxSize?: number;
  minIdle?: number;
  idleTtlMs?: number;
  sessionFactory?: RunnerSessionFactory;
}

interface SessionEntry {
  session: RunnerSession;
  status: SessionStatus;
  lastUsedAt: number;
}

const DOCKER_RUNNER_WORKER = String.raw`
const fs = require('fs');
const path = require('path');

async function main() {
  const jobRoot = process.argv[2];
  if (!jobRoot) {
    throw new Error('job root is required');
  }

  const metaDir = path.join(jobRoot, 'workspace', 'meta');
  const inDir = path.join(jobRoot, 'workspace', 'in');
  const outDir = path.join(jobRoot, 'workspace', 'out');
  const runSpec = JSON.parse(
    fs.readFileSync(path.join(metaDir, 'run-spec.json'), 'utf-8'),
  );

  let outputs;
  switch (runSpec.template) {
    case 'draft_reply_from_thread': {
      const inputArtifacts = (runSpec.workspace.input_artifact_ids || [])
        .map((artifactId) => {
          const artifactPath = path.join(inDir, artifactId + '.txt');
          if (!fs.existsSync(artifactPath)) return '';
          return fs.readFileSync(artifactPath, 'utf-8').trim();
        })
        .filter(Boolean)
        .join('\n\n');
      const prompt = String(runSpec.template_args.prompt || '').trim();
      const threadSummary = String(runSpec.template_args.thread_summary || '').trim();
      const draft = [
        'Draft Reply',
        '',
        prompt ? 'Request: ' + prompt : 'Request: follow up',
        threadSummary ? 'Thread Summary: ' + threadSummary : null,
        inputArtifacts ? 'Sources:\n' + inputArtifacts : null,
      ].filter(Boolean).join('\n');
      outputs = [
        {
          relativePath: 'draft-reply.md',
          mediaType: 'text/markdown',
          content: draft,
        },
      ];
      break;
    }
    default:
      throw new Error('Unknown template: ' + runSpec.template);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const output of outputs) {
    const outputPath = path.join(outDir, output.relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output.content, 'utf-8');
  }

  const result = {
    run_id: runSpec.run_id,
    status: 'succeeded',
    exit_code: 0,
    artifacts: outputs.map((output) => ({
      artifact_id: output.relativePath,
      path: path.join(outDir, output.relativePath),
      media_type: output.mediaType,
    })),
    stdout_tail: 'draft generated',
    stderr_tail: '',
  };
  fs.writeFileSync(
    path.join(metaDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf-8',
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const jobRoot = process.argv[2];
  if (jobRoot) {
    const metaDir = path.join(jobRoot, 'workspace', 'meta');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, 'result.json'),
      JSON.stringify(
        {
          run_id: 'unknown',
          status: 'failed_terminal',
          exit_code: 1,
          artifacts: [],
          stdout_tail: '',
          stderr_tail: message,
        },
        null,
        2,
      ),
      'utf-8',
    );
  }
  console.error(message);
  process.exit(1);
});
`;

function materializeWorkspace(jobRoot: string, runSpec: RunSpec): void {
  const workspaceIn = path.join(jobRoot, 'workspace', 'in');
  const workspaceOut = path.join(jobRoot, 'workspace', 'out');
  const workspaceMeta = path.join(jobRoot, 'workspace', 'meta');
  fs.mkdirSync(workspaceIn, { recursive: true });
  fs.mkdirSync(workspaceOut, { recursive: true });
  fs.mkdirSync(workspaceMeta, { recursive: true });

  fs.writeFileSync(
    path.join(workspaceMeta, 'run-spec.json'),
    JSON.stringify(runSpec, null, 2),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceMeta, 'metadata.json'),
    JSON.stringify(runSpec.workspace.metadata, null, 2),
    'utf-8',
  );

  for (const artifactId of runSpec.workspace.input_artifact_ids) {
    const content = runSpec.env[`ARTIFACT_${artifactId}`] ?? '';
    fs.writeFileSync(
      path.join(workspaceIn, `${artifactId}.txt`),
      content,
      'utf-8',
    );
  }
}

class LocalRunnerSession implements RunnerSession {
  readonly id = `local-${randomUUID()}`;

  constructor(
    private readonly executor: RunSpecExecutor = new LocalRunSpecExecutor(),
  ) {}

  async execute(runSpec: RunSpec): Promise<RunResult> {
    return this.executor.execute(runSpec);
  }

  async close(): Promise<void> {
    // no-op
  }
}

export class LocalRunnerSessionFactory implements RunnerSessionFactory {
  constructor(
    private readonly executor: RunSpecExecutor = new LocalRunSpecExecutor(),
  ) {}

  async create(): Promise<RunnerSession> {
    return new LocalRunnerSession(this.executor);
  }
}

export function buildRunnerContainerArgs(input: {
  lane: RunSpec['runner_pool'];
  containerName: string;
  sessionRoot: string;
}): string[] {
  const args = ['run', '-d', '--rm', '--name', input.containerName];
  args.push(...hostGatewayArgs());
  args.push('-v', `${input.sessionRoot}:/runner`);
  if (input.lane === 'trusted') {
    args.push(
      ...readonlyMountArgs(resolveHostPath(MOUNT_ROOT), '/workspace/project'),
    );
    args.push(
      '-v',
      `${resolveHostPath(path.join(MOUNT_ROOT, 'store'))}:/workspace/project/store`,
    );
  } else {
    args.push('--network', 'none');
  }
  args.push(
    '-v',
    `${resolveHostPath(path.join(MOUNT_ROOT, 'data'))}:/workspace/data`,
  );
  args.push('--entrypoint', 'tail', CONTAINER_IMAGE, '-f', '/dev/null');
  return args;
}

export class DockerRunnerSession implements RunnerSession {
  readonly id: string;
  readonly containerName: string;
  readonly sessionRoot: string;
  readonly hostSessionRoot: string;

  constructor(private readonly lane: RunSpec['runner_pool']) {
    this.id = `${lane}-${randomUUID()}`;
    this.containerName = `nanoclaw-runner-${lane}-${this.id.slice(0, 8)}`;
    this.sessionRoot = path.join(DATA_DIR, 'runner-sessions', this.id);
    fs.mkdirSync(this.sessionRoot, { recursive: true });
    this.hostSessionRoot = resolveHostPath(
      path.join(MOUNT_ROOT, 'data', 'runner-sessions', this.id),
    );
    fs.mkdirSync(path.join(this.sessionRoot, 'jobs'), { recursive: true });
    fs.writeFileSync(
      path.join(this.sessionRoot, 'worker.js'),
      DOCKER_RUNNER_WORKER,
      'utf-8',
    );

    const args = buildRunnerContainerArgs({
      lane,
      containerName: this.containerName,
      sessionRoot: this.hostSessionRoot,
    });
    execFileSync(CONTAINER_RUNTIME_BIN, args, {
      stdio: 'pipe',
      windowsHide: true,
    });
  }

  async execute(runSpec: RunSpec): Promise<RunResult> {
    const parsed = parseRunSpec(runSpec, {
      knownTemplates: getKnownTemplateNames(),
    });
    const jobRoot = path.join(this.sessionRoot, 'jobs', parsed.run_id);
    materializeWorkspace(jobRoot, parsed);

    execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'exec',
        this.containerName,
        'node',
        '/runner/worker.js',
        `/runner/jobs/${parsed.run_id}`,
      ],
      { stdio: 'pipe', windowsHide: true },
    );

    const resultPath = path.join(jobRoot, 'workspace', 'meta', 'result.json');
    const raw = fs.readFileSync(resultPath, 'utf-8');
    return JSON.parse(raw) as RunResult;
  }

  async close(): Promise<void> {
    try {
      stopContainer(this.containerName);
    } catch {
      // ignore cleanup races
    }
    fs.rmSync(this.sessionRoot, { recursive: true, force: true });
  }
}

export class DockerRunnerSessionFactory implements RunnerSessionFactory {
  constructor(private readonly lane: RunSpec['runner_pool']) {}

  async create(): Promise<RunnerSession> {
    ensureContainerRuntimeRunning();
    return new DockerRunnerSession(this.lane);
  }
}

function defaultSessionFactory(
  lane: RunSpec['runner_pool'],
): RunnerSessionFactory {
  if (ENABLE_HOT_RUNNER_CONTAINERS && process.env.VITEST !== 'true') {
    return new DockerRunnerSessionFactory(lane);
  }
  return new LocalRunnerSessionFactory();
}

export class HotRunnerPool {
  private readonly lane: RunSpec['runner_pool'];
  private readonly maxSize: number;
  private readonly minIdle: number;
  private readonly idleTtlMs: number;
  private readonly sessionFactory: RunnerSessionFactory;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(options: HotRunnerPoolOptions) {
    this.lane = options.lane;
    this.maxSize = options.maxSize ?? HOT_RUNNER_POOL_MAX_SIZE;
    this.minIdle = options.minIdle ?? HOT_RUNNER_POOL_MIN_IDLE;
    this.idleTtlMs = options.idleTtlMs ?? HOT_RUNNER_POOL_IDLE_TTL_MS;
    this.sessionFactory =
      options.sessionFactory ?? defaultSessionFactory(this.lane);
  }

  async prewarm(): Promise<void> {
    while (this.sessions.size < this.minIdle) {
      const session = await this.sessionFactory.create();
      this.sessions.set(session.id, {
        session,
        status: 'idle',
        lastUsedAt: Date.now(),
      });
    }
  }

  async execute(runSpec: RunSpec): Promise<RunResult> {
    await this.prewarm();
    const entry = await this.acquireSession();
    entry.status = 'busy';
    try {
      return await entry.session.execute(runSpec);
    } finally {
      entry.status = 'idle';
      entry.lastUsedAt = Date.now();
      // Wake one waiter (if any) immediately — avoids up-to-25ms polling
      // jitter in acquireSession when the pool is saturated.
      const waiter = this.idleWaiters.shift();
      if (waiter) waiter.resolve(entry);
      await this.reapIdleSessions();
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((entry) => entry.session.close()));
  }

  getSnapshot(): {
    lane: RunSpec['runner_pool'];
    totalSessions: number;
    idleSessions: number;
    busySessions: number;
  } {
    const entries = [...this.sessions.values()];
    return {
      lane: this.lane,
      totalSessions: entries.length,
      idleSessions: entries.filter((entry) => entry.status === 'idle').length,
      busySessions: entries.filter((entry) => entry.status === 'busy').length,
    };
  }

  // Waiters blocked on a saturated pool — woken by the finally block in
  // execute() the moment a session returns to idle. If a busy session dies
  // without hitting the finally (process crash, parent SIGKILL), waiters
  // would hang forever without the watchdog timeout below.
  private readonly idleWaiters: Array<{
    resolve: (entry: SessionEntry) => void;
    reject: (err: Error) => void;
  }> = [];
  private static readonly WAITER_TIMEOUT_MS = 2 * 60_000;

  private async acquireSession(): Promise<SessionEntry> {
    const idle = [...this.sessions.values()].find(
      (entry) => entry.status === 'idle',
    );
    if (idle) return idle;

    if (this.sessions.size < this.maxSize) {
      const session = await this.sessionFactory.create();
      const entry: SessionEntry = {
        session,
        status: 'idle',
        lastUsedAt: Date.now(),
      };
      this.sessions.set(session.id, entry);
      return entry;
    }

    return new Promise<SessionEntry>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.idleWaiters.push(waiter);
      setTimeout(() => {
        const idx = this.idleWaiters.indexOf(waiter);
        if (idx === -1) return; // already woken
        this.idleWaiters.splice(idx, 1);
        reject(
          new Error(
            `Hot runner pool (${this.lane}) waiter timed out after ` +
              `${HotRunnerPool.WAITER_TIMEOUT_MS}ms; upstream likely crashed.`,
          ),
        );
      }, HotRunnerPool.WAITER_TIMEOUT_MS).unref?.();
    });
  }

  private async reapIdleSessions(): Promise<void> {
    const idleEntries = [...this.sessions.values()]
      .filter((entry) => entry.status === 'idle')
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    while (idleEntries.length > this.minIdle) {
      const oldest = idleEntries[0];
      if (Date.now() - oldest.lastUsedAt < this.idleTtlMs) break;
      idleEntries.shift();
      this.sessions.delete(oldest.session.id);
      await oldest.session.close();
    }
  }
}
