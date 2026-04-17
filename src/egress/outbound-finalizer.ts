import { randomUUID } from 'crypto';

import {
  createAuditLogRecord,
  getActionRecord,
  getCoreTask,
  hasAuditLogEvent,
} from '../db.js';
import { ApprovalService } from '../core/approvals/service.js';
import type { Channel } from '../types.js';

export class OutboundFinalizer {
  constructor(private readonly approvalService = new ApprovalService()) {}

  async finalizeMessage(input: {
    actionId: string;
    channel: Pick<Channel, 'sendMessage'>;
    chatJid: string;
    text: string;
    threadId?: string;
  }): Promise<'sent' | 'duplicate'> {
    const action = getActionRecord(input.actionId);
    if (!action) {
      throw new Error(`Unknown action ${input.actionId}`);
    }
    if (!this.approvalService.canFinalize(input.actionId)) {
      throw new Error(
        `Action ${input.actionId} cannot finalize without approval`,
      );
    }
    if (hasAuditLogEvent(input.actionId, 'side_effect.message_sent')) {
      return 'duplicate';
    }

    await input.channel.sendMessage(input.chatJid, input.text, {
      threadId: input.threadId,
    });

    const task = getCoreTask(action.task_id);
    createAuditLogRecord({
      id: randomUUID(),
      principal_id: task?.principal_id ?? null,
      task_id: action.task_id,
      action_id: action.id,
      event_type: 'side_effect.message_sent',
      payload_json: JSON.stringify({
        chatJid: input.chatJid,
        threadId: input.threadId ?? null,
        textLength: input.text.length,
      }),
      created_at: new Date().toISOString(),
    });
    return 'sent';
  }
}
