import { describe, expect, it } from 'vitest';

import { RestrictedRunnerPool } from './restricted/pool.js';
import { TrustedRunnerPool } from './trusted/pool.js';

const baseSpec = {
  run_id: 'run-1',
  action_id: 'action-1',
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
  limits: {
    timeout_ms: 1000,
    max_output_bytes: 1000,
  },
};

describe('runner pools', () => {
  it('controller-style trusted jobs can use the trusted runner', async () => {
    const pool = new TrustedRunnerPool();
    const result = await pool.execute({
      ...baseSpec,
      runner_pool: 'trusted',
      capabilities: ['draft', 'project_read'],
    });

    expect(result.status).toBe('succeeded');
  });

  it('external jobs use the restricted runner and reject elevated capabilities', async () => {
    const pool = new RestrictedRunnerPool();

    await expect(
      pool.execute({
        ...baseSpec,
        runner_pool: 'restricted',
        capabilities: ['draft', 'network'],
      }),
    ).rejects.toThrow(/Restricted runner cannot execute capability/);
  });
});
