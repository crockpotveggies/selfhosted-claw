import { describe, expect, it } from 'vitest';

import {
  buildSilentTurnFallback,
  buildSilentTurnRecoveryMessages,
} from '../container/agent-runner/src/response-fallback.js';

describe('buildSilentTurnFallback', () => {
  it('asks for clearer contact details after lookup dead ends', () => {
    const result = buildSilentTurnFallback([
      { role: 'user', content: 'Send an sms to Nikola Cucuk' },
      {
        role: 'tool',
        name: 'google_contacts.search',
        content: '{"query":"Nikola Cucuk","results":[]}',
      },
      {
        role: 'tool',
        name: 'list_chats',
        content: '{"chats":[]}',
      },
    ]);

    expect(result).toContain("couldn't find a matching contact or chat");
    expect(result).toContain('phone number');
  });

  it('acknowledges successful sends when the model omits a final reply', () => {
    const result = buildSilentTurnFallback([
      { role: 'user', content: 'Send Elyssa a joke' },
      {
        role: 'tool',
        name: 'sms_socket.send_message',
        content: '{"status":"sent","to":"sms:+17788366073"}',
      },
    ]);

    expect(result).toContain('Done');
    expect(result).toContain('sms:+17788366073');
    expect(result).not.toContain("didn't generate a normal confirmation reply");
  });

  it('acknowledges skipped duplicate sends without pretending to send again', () => {
    const result = buildSilentTurnFallback([
      { role: 'user', content: 'Send Elyssa a joke again' },
      {
        role: 'tool',
        name: 'sms_socket.send_message',
        content: '{"status":"duplicate","to":"sms:+17788366073"}',
      },
    ]);

    expect(result).toContain('already been sent');
    expect(result).toContain('skipped');
    expect(result).toContain('sms:+17788366073');
  });

  it('surfaces calendar credential failures instead of the generic dead-end reply', () => {
    const result = buildSilentTurnFallback([
      { role: 'user', content: 'Please create a calendar event' },
      {
        role: 'tool',
        name: 'calendar_check_availability',
        content:
          'Tool error: Calendar API 401: {"error":{"message":"Invalid Credentials","status":"UNAUTHENTICATED"}}',
      },
      {
        role: 'tool',
        name: 'notify_controller',
        content:
          'Already in the controller DM - put the message in your normal text response rather than calling notify_controller.',
      },
    ]);

    expect(result).toContain("couldn't access your calendar");
    expect(result).toContain('reconnect the calendar integration');
  });
});

describe('buildSilentTurnRecoveryMessages', () => {
  it('builds a recovery prompt from the current turn after a successful send', () => {
    const messages = buildSilentTurnRecoveryMessages([
      { role: 'user', content: 'Send Nikola the GitHub link' },
      {
        role: 'assistant',
        content: 'I found Nikola in contacts and I am sending it now.',
      },
      {
        role: 'tool',
        name: 'sms_socket.send_message',
        content:
          '{"status":"sent","to":"sms:+16047228402","message":"Here is the link"}',
      },
      { role: 'assistant', content: null },
    ]);

    expect(messages).not.toBeNull();
    expect(messages?.[0]?.content).toContain('Write the final user-facing reply');
    expect(messages?.[1]?.content).toContain('Original user request');
    expect(messages?.[1]?.content).toContain('sms_socket.send_message');
    expect(messages?.[1]?.content).toContain('sms:+16047228402');
  });
});
