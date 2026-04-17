import { createHash, randomUUID } from 'crypto';

import { countInboundEvents, recordInboundEvent } from '../../db.js';

export interface InboundEventDescriptor {
  sourceSystem: string;
  sourceEventId: string;
  messageParts: string[];
  principalId?: string;
  taskId?: string;
  createdAt?: string;
}

export class InboundDedupeStore {
  registerEvent(input: InboundEventDescriptor): boolean {
    return recordInboundEvent({
      id: randomUUID(),
      sourceSystem: input.sourceSystem,
      sourceEventId: input.sourceEventId,
      messageHash: this.hashParts(input.messageParts),
      principalId: input.principalId,
      taskId: input.taskId,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  hasSeen(sourceSystem: string, sourceEventId: string): boolean {
    return countInboundEvents(sourceSystem, sourceEventId) > 0;
  }

  private hashParts(parts: string[]): string {
    return createHash('sha256').update(parts.join('\0')).digest('hex');
  }
}
