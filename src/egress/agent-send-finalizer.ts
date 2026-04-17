import { randomUUID } from 'crypto';

import {
  createActionRecord,
  createCoreTask,
  createPrincipal,
  getPrincipal,
} from '../db.js';
import type { Channel } from '../types.js';
import { OutboundFinalizer } from './outbound-finalizer.js';

const SYSTEM_AGENT_PRINCIPAL_ID = 'principal-system-agent';

export class AgentSendFinalizer {
  constructor(private readonly outboundFinalizer = new OutboundFinalizer()) {}

  async finalizeSignalSend(input: {
    channel: Pick<Channel, 'sendMessage'>;
    sourceChatJid: string;
    targetJid: string;
    message: string;
    threadId?: string;
  }): Promise<{ actionId: string; result: 'sent' | 'duplicate' }> {
    this.ensureSystemPrincipal();
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const actionId = randomUUID();

    createCoreTask({
      id: taskId,
      principal_id: SYSTEM_AGENT_PRINCIPAL_ID,
      source_channel: 'agent',
      source_thread_id: input.sourceChatJid,
      status: 'open',
      summary: `Finalize outbound Signal message to ${input.targetJid}`,
      created_at: now,
      updated_at: now,
    });
    createActionRecord({
      id: actionId,
      task_id: taskId,
      type: 'send_message_now',
      status: 'approved',
      runner_pool: 'trusted',
      permission_profile: 'trusted-ops',
      idempotency_key: `signal-send:${input.targetJid}:${input.message}`,
      semantic_dedupe_key: `signal-send:${input.targetJid}:${input.message}`,
      requested_by_principal_id: SYSTEM_AGENT_PRINCIPAL_ID,
      approved_by_principal_id: SYSTEM_AGENT_PRINCIPAL_ID,
      created_at: now,
      updated_at: now,
    });

    const result = await this.outboundFinalizer.finalizeMessage({
      actionId,
      channel: input.channel,
      chatJid: input.targetJid,
      text: input.message,
      threadId: input.threadId,
    });
    return { actionId, result };
  }

  private ensureSystemPrincipal(): void {
    if (getPrincipal(SYSTEM_AGENT_PRINCIPAL_ID)) return;
    createPrincipal({
      id: SYSTEM_AGENT_PRINCIPAL_ID,
      type: 'system',
      display_name: 'NanoClaw Agent',
      trust_tier: 'trusted',
      status: 'active',
      created_at: new Date().toISOString(),
    });
  }
}
