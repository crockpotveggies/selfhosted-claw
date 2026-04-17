import type { RunSpec } from '../../protocol/types.js';
import {
  HotRunnerPool,
  type RunnerSessionFactory,
} from '../common/hot-runner-pool.js';

export class TrustedRunnerPool {
  private readonly pool: HotRunnerPool;

  constructor(
    sessionFactory?: RunnerSessionFactory,
    pool = new HotRunnerPool({
      lane: 'trusted',
      sessionFactory,
    }),
  ) {
    this.pool = pool;
  }

  async prewarm(): Promise<void> {
    await this.pool.prewarm();
  }

  async execute(runSpec: RunSpec) {
    return this.pool.execute(runSpec);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  getSnapshot() {
    return this.pool.getSnapshot();
  }
}
