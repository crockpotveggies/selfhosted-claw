import type { RunResult, RunSpec } from '../../protocol/types.js';

export interface RunSpecExecutor {
  execute(runSpec: RunSpec): Promise<RunResult>;
}
