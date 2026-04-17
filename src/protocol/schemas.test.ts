import { describe, expect, it } from 'vitest';

import { parseRunSpec } from './schemas.js';

describe('protocol schema validation', () => {
  it('rejects invalid RunSpecs', () => {
    expect(() =>
      parseRunSpec({
        run_id: 'run-1',
        action_id: 'action-1',
        runner_pool: 'restricted',
        template: 'draft_reply',
        template_args: {},
        workspace: {
          input_artifact_ids: [],
          expected_outputs: [],
          metadata: {},
        },
        env: {},
        capabilities: [],
        limits: {
          timeout_ms: 0,
          max_output_bytes: 128,
        },
      }),
    ).toThrow(/limits\.timeout_ms/);
  });

  it('rejects unknown templates', () => {
    expect(() =>
      parseRunSpec(
        {
          run_id: 'run-1',
          action_id: 'action-1',
          runner_pool: 'restricted',
          template: 'unknown_template',
          template_args: {},
          workspace: {
            input_artifact_ids: [],
            expected_outputs: ['/workspace/out/draft.txt'],
            metadata: {},
          },
          env: {},
          capabilities: ['draft'],
          limits: {
            timeout_ms: 5000,
            max_output_bytes: 4096,
          },
        },
        { knownTemplates: ['draft_reply_from_thread'] },
      ),
    ).toThrow(/Unknown template/);
  });
});
