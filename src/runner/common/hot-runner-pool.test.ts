import { describe, expect, it } from 'vitest';

import type { RunResult, RunSpec } from '../../protocol/types.js';
import {
  buildRunnerContainerArgs,
  HotRunnerPool,
  type RunnerSession,
  type RunnerSessionFactory,
} from './hot-runner-pool.js';

const baseSpec: RunSpec = {
  run_id: 'run-1',
  action_id: 'action-1',
  runner_pool: 'restricted',
  template: 'draft_reply_from_thread',
  template_args: {
    prompt: 'Reply to Alex',
    thread_summary: 'Need a quick follow-up',
  },
  workspace: {
    input_artifact_ids: [],
    expected_outputs: ['/workspace/out/draft-reply.md'],
    metadata: {},
  },
  env: {},
  capabilities: ['draft'],
  limits: {
    timeout_ms: 1000,
    max_output_bytes: 1000,
  },
};

class FakeSession implements RunnerSession {
  closed = false;

  constructor(
    readonly id: string,
    private readonly onExecute: (runSpec: RunSpec) => Promise<RunResult>,
  ) {}

  async execute(runSpec: RunSpec): Promise<RunResult> {
    return this.onExecute(runSpec);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSessionFactory implements RunnerSessionFactory {
  createdIds: string[] = [];
  sessions: FakeSession[] = [];

  constructor(
    private readonly onExecute: (
      runSpec: RunSpec,
      sessionId: string,
    ) => Promise<RunResult>,
  ) {}

  async create(): Promise<RunnerSession> {
    const id = `session-${this.createdIds.length + 1}`;
    this.createdIds.push(id);
    const session = new FakeSession(id, (runSpec) =>
      this.onExecute(runSpec, id),
    );
    this.sessions.push(session);
    return session;
  }
}

describe('HotRunnerPool', () => {
  it('reuses prewarmed idle sessions across runs', async () => {
    const factory = new FakeSessionFactory(async (runSpec, sessionId) => ({
      run_id: runSpec.run_id,
      status: 'succeeded',
      exit_code: 0,
      artifacts: [],
      stdout_tail: sessionId,
      stderr_tail: '',
    }));
    const pool = new HotRunnerPool({
      lane: 'restricted',
      minIdle: 1,
      maxSize: 2,
      sessionFactory: factory,
    });

    await pool.prewarm();
    const first = await pool.execute(baseSpec);
    const second = await pool.execute({ ...baseSpec, run_id: 'run-2' });

    expect(factory.createdIds).toHaveLength(1);
    expect(first.stdout_tail).toBe('session-1');
    expect(second.stdout_tail).toBe('session-1');
    await pool.close();
  });

  it('reuses the surviving idle session after reaping extras', async () => {
    const factory = new FakeSessionFactory(async (runSpec, sessionId) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        run_id: runSpec.run_id,
        status: 'succeeded',
        exit_code: 0,
        artifacts: [],
        stdout_tail: sessionId,
        stderr_tail: '',
      };
    });
    const pool = new HotRunnerPool({
      lane: 'restricted',
      minIdle: 1,
      maxSize: 2,
      idleTtlMs: 1,
      sessionFactory: factory,
    });

    await Promise.all([
      pool.execute(baseSpec),
      pool.execute({ ...baseSpec, run_id: 'run-2' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await pool.execute({ ...baseSpec, run_id: 'run-3' });

    expect(factory.createdIds).toHaveLength(2);
    expect(factory.createdIds).toContain(third.stdout_tail);
    expect(factory.sessions.filter((session) => session.closed)).toHaveLength(
      1,
    );
    expect(pool.getSnapshot().idleSessions).toBe(1);
    await pool.close();
  });
});

describe('buildRunnerContainerArgs', () => {
  it('uses a no-network ceiling for restricted containers', () => {
    const args = buildRunnerContainerArgs({
      lane: 'restricted',
      containerName: 'restricted-test',
      sessionRoot: '/tmp/session',
    });

    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--entrypoint');
    expect(args).toContain('tail');
    expect(args).not.toContain('/workspace/project');
  });

  it('mounts project access for trusted containers', () => {
    const args = buildRunnerContainerArgs({
      lane: 'trusted',
      containerName: 'trusted-test',
      sessionRoot: '/tmp/session',
    });

    expect(args.some((arg) => arg.includes('/workspace/project'))).toBe(true);
    expect(args).not.toContain('none');
  });
});
