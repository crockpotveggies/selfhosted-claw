import type { RunSpec } from '../../protocol/types.js';
import {
  HotRunnerPool,
  type RunnerSessionFactory,
} from '../common/hot-runner-pool.js';

const DISALLOWED_CAPABILITIES = new Set(['network', 'host_fs', 'secrets']);

export class RestrictedRunnerPool {
  private readonly pool: HotRunnerPool;

  constructor(
    sessionFactory?: RunnerSessionFactory,
    pool = new HotRunnerPool({
      lane: 'restricted',
      sessionFactory,
    }),
  ) {
    this.pool = pool;
  }

  async prewarm(): Promise<void> {
    await this.pool.prewarm();
  }

  async execute(runSpec: RunSpec) {
    for (const capability of runSpec.capabilities) {
      if (DISALLOWED_CAPABILITIES.has(capability)) {
        throw new Error(
          `Restricted runner cannot execute capability: ${capability}`,
        );
      }
    }
    return this.pool.execute(runSpec);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  getSnapshot() {
    return this.pool.getSnapshot();
  }
}
