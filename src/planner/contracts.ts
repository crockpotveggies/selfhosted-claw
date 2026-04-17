import type { PlannerContextBundle } from '../core/context/contracts.js';
import type { ProposedAction } from '../protocol/types.js';

export interface Planner {
  proposeActions(context: PlannerContextBundle): Promise<ProposedAction[]>;
}
