import { afterEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { parseAgentOutput, resolveSignalTarget } from './outbound-directives.js';

describe('parseAgentOutput', () => {
  it('extracts send directives and leaves visible text', () => {
    const parsed = parseAgentOutput(
      'On it.\n<send_message channel="signal" to="Justin">Hello there</send_message>',
    );

    expect(parsed.visibleText).toBe('On it.');
    expect(parsed.directives).toEqual([
      {
        kind: 'send_message',
        channel: 'signal',
        to: 'Justin',
        message: 'Hello there',
      },
    ]);
  });

  it('extracts delete directives and leaves visible text', () => {
    const parsed = parseAgentOutput(
      'I can handle that.\n<delete_resource channel="email" target="Draft to Sam">duplicate draft</delete_resource>',
    );

    expect(parsed.visibleText).toBe('I can handle that.');
    expect(parsed.directives).toEqual([
      {
        kind: 'delete_resource',
        channel: 'email',
        target: 'Draft to Sam',
        reason: 'duplicate draft',
      },
    ]);
  });

  it('extracts create-group directives and leaves visible text', () => {
    const parsed = parseAgentOutput(
      'Will do.\n<create_group channel="signal" members="Elyssa, Sam" title="Lunch planning">Can we set up lunch for next Monday?</create_group>',
    );

    expect(parsed.visibleText).toBe('Will do.');
    expect(parsed.directives).toEqual([
      {
        kind: 'create_group',
        channel: 'signal',
        members: ['Elyssa', 'Sam'],
        title: 'Lunch planning',
        message: 'Can we set up lunch for next Monday?',
      },
    ]);
  });
});

describe('resolveSignalTarget', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // ignore tests that did not initialize the in-memory DB
    }
  });

  it('returns explicit signal JIDs unchanged', () => {
    _initTestDatabase();
    expect(resolveSignalTarget('signal:user:+15551234567')).toEqual({
      jid: 'signal:user:+15551234567',
      existingConversation: false,
    });
  });

  it('matches a sender by display name from recent contact history', () => {
    _initTestDatabase();
    storeChatMetadata(
      'signal:user:+15551234567',
      new Date().toISOString(),
      'Justin',
      'signal',
      false,
    );
    storeMessageDirect({
      id: '1',
      chat_jid: 'signal:user:+15551234567',
      sender: 'signal:user:+15551234567',
      sender_name: 'Justin',
      content: 'hello',
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });

    expect(resolveSignalTarget('Justin')).toEqual({
      jid: 'signal:user:+15551234567',
      existingConversation: true,
    });
  });
});
