import { randomUUID } from 'crypto';

import {
  claimActionLease,
  getActionLease,
  releaseActionLease,
} from '../../db.js';

export interface LeaseClaim {
  actionId: string;
  leaseToken: string;
  workerId: string;
  expiresAt: string;
}

export class ActionLeaseManager {
  constructor(private readonly leaseTtlMs = 60_000) {}

  claim(
    actionId: string,
    workerId: string,
    now = new Date(),
  ): LeaseClaim | null {
    const claimedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.leaseTtlMs).toISOString();
    const leaseToken = randomUUID();
    const claimed = claimActionLease({
      actionId,
      leaseToken,
      workerId,
      expiresAt,
      claimedAt,
    });
    return claimed
      ? {
          actionId,
          leaseToken,
          workerId,
          expiresAt,
        }
      : null;
  }

  release(claim: LeaseClaim): boolean {
    return releaseActionLease(claim.actionId, claim.leaseToken);
  }

  current(actionId: string) {
    return getActionLease(actionId);
  }
}
