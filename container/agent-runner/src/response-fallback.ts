export interface TerminalTurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
}

function getCurrentTurnMessages(
  history: TerminalTurnMessage[],
): TerminalTurnMessage[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') {
      return history.slice(i + 1);
    }
  }
  return history;
}

function parseSendRecipient(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { to?: string; status?: string };
    if (
      (parsed.status === 'sent' || parsed.status === 'duplicate') &&
      typeof parsed.to === 'string'
    ) {
      return parsed.to;
    }
  } catch {
    // Tool content is sometimes plain text. Fall through to regex parsing.
  }

  const match = content.match(/"to"\s*:\s*"([^"]+)"/);
  return match?.[1] || null;
}

function parseSendStatus(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { status?: string };
    return typeof parsed.status === 'string' ? parsed.status : null;
  } catch {
    // Tool content is sometimes plain text. Fall through to regex parsing.
  }

  const match = content.match(/"status"\s*:\s*"([^"]+)"/);
  return match?.[1] || null;
}

function extractToolError(content: string | null): string | null {
  if (!content) return null;
  const prefix = 'Tool error: ';
  if (!content.startsWith(prefix)) return null;
  return content.slice(prefix.length).trim() || null;
}

function summariseToolError(
  toolName: string,
  error: string,
): string | null {
  if (
    toolName.startsWith('calendar_') &&
    /invalid credentials|401|unauthenticated/i.test(error)
  ) {
    return "I couldn't access your calendar because the Google Calendar credentials are invalid right now. Please reconnect the calendar integration, then I can try that again.";
  }

  if (/already in the controller dm/i.test(error)) {
    return null;
  }

  if (toolName.startsWith('calendar_')) {
    return `I couldn't complete that calendar request because ${error}`;
  }

  return `I couldn't complete that request because ${error}`;
}

export function buildSilentTurnFallback(
  history: TerminalTurnMessage[],
): string {
  const currentTurn = getCurrentTurnMessages(history);
  const toolMessages = currentTurn.filter(
    (message): message is TerminalTurnMessage & { role: 'tool'; name: string } =>
      message.role === 'tool' && typeof message.name === 'string',
  );

  const successfulSend = toolMessages.find((message) => {
    const toolName = message.name || '';
    const status = parseSendStatus(message.content);
    return (
      /\.send_message$/.test(toolName) &&
      (status === 'sent' || status === 'duplicate')
    );
  });
  if (successfulSend) {
    const recipient = parseSendRecipient(successfulSend.content);
    const status = parseSendStatus(successfulSend.content);
    if (status === 'duplicate') {
      return recipient
        ? `Done — that message had already been sent to ${recipient} recently, so I skipped sending it again.`
        : `Done — that message had already been sent recently, so I skipped sending it again.`;
    }
    return recipient
      ? `Done — I sent the requested message to ${recipient}, but I didn't generate a normal confirmation reply.`
      : `Done — I sent the requested message, but I didn't generate a normal confirmation reply.`;
  }

  const lastUsefulToolError = [...toolMessages]
    .reverse()
    .map((message) => ({
      toolName: message.name || '',
      error: extractToolError(message.content),
    }))
    .find(
      (candidate): candidate is { toolName: string; error: string } =>
        typeof candidate.error === 'string' &&
        summariseToolError(candidate.toolName, candidate.error) !== null,
    );
  if (lastUsefulToolError) {
    return (
      summariseToolError(
        lastUsefulToolError.toolName,
        lastUsefulToolError.error,
      ) ||
      "I couldn't complete that request because a tool call failed."
    );
  }

  const attemptedContactLookup = toolMessages.some((message) =>
    ['google_contacts.search', 'read_chat_history', 'list_chats'].includes(
      message.name || '',
    ),
  );
  if (attemptedContactLookup) {
    return "I couldn't find a matching contact or chat to complete that request. Please send me the phone number or a more specific contact name and I'll try again.";
  }

  return "I hit a dead end and didn't generate a usable final reply. Please try again, and if you're asking me to message someone, include the recipient's exact number or a more specific contact name.";
}
