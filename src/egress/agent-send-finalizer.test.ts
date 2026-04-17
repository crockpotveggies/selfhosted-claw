import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getActionRecord,
  getCoreTask,
} from '../db.js';
import { AgentSendFinalizer } from './agent-send-finalizer.js';

describe('AgentSendFinalizer', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // ignored
    }
  });

  it('creates durable records and finalizes an outbound signal send', async () => {
    _initTestDatabase();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const service = new AgentSendFinalizer();

    const result = await service.finalizeSignalSend({
      channel: { sendMessage },
      sourceChatJid: 'signal:user:+15550001111',
      targetJid: 'signal:user:+15559990000',
      message: 'Hello from the control plane',
    });

    expect(result.result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getActionRecord(result.actionId)?.type).toBe('send_message_now');
    expect(
      getCoreTask(getActionRecord(result.actionId)?.task_id || '')
        ?.source_channel,
    ).toBe('agent');
  });
});
