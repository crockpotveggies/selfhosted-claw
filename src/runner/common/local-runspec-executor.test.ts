import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { LocalRunSpecExecutor } from './local-runspec-executor.js';

describe('LocalRunSpecExecutor', () => {
  it('rejects unknown templates', async () => {
    const executor = new LocalRunSpecExecutor();

    await expect(
      executor.execute({
        run_id: 'run-1',
        action_id: 'action-1',
        runner_pool: 'restricted',
        template: 'unknown',
        template_args: {},
        workspace: {
          input_artifact_ids: [],
          expected_outputs: [],
          metadata: {},
        },
        env: {},
        capabilities: [],
        limits: {
          timeout_ms: 1000,
          max_output_bytes: 1000,
        },
      }),
    ).rejects.toThrow(/Unknown template/);
  });

  it('executes a draft template and returns output artifacts', async () => {
    const executor = new LocalRunSpecExecutor();

    const result = await executor.execute({
      run_id: 'run-1',
      action_id: 'action-1',
      runner_pool: 'restricted',
      template: 'draft_reply_from_thread',
      template_args: {
        prompt: 'Reply to Alex',
        thread_summary: 'Need a quick follow-up',
      },
      workspace: {
        input_artifact_ids: ['artifact-1'],
        expected_outputs: ['/workspace/out/draft-reply.md'],
        metadata: {},
      },
      env: {
        'ARTIFACT_artifact-1': 'Original thread transcript',
      },
      capabilities: ['draft'],
      limits: {
        timeout_ms: 1000,
        max_output_bytes: 1000,
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].media_type).toBe('text/markdown');
    expect(fs.existsSync(result.artifacts[0].path)).toBe(true);
    const workspaceRoot = result.artifacts[0].path.split(
      `${path.sep}workspace${path.sep}out`,
    )[0];
    expect(
      fs.existsSync(
        `${workspaceRoot}${path.sep}workspace${path.sep}in${path.sep}artifact-1.txt`,
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        `${workspaceRoot}${path.sep}workspace${path.sep}meta${path.sep}run-spec.json`,
      ),
    ).toBe(true);
  });
});
