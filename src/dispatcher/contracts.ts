import type { ActionRecord, RunRecord } from '../core/state/types.js';
import type { RunSpec } from '../protocol/types.js';

export interface Dispatcher {
  compileRunSpec(action: ActionRecord): Promise<RunSpec>;
  dispatch(runSpec: RunSpec): Promise<RunRecord>;
}
