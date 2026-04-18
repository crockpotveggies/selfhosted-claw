function getCurrentTurnStartIndex(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.role === 'user') {
            return i;
        }
    }
    return 0;
}
function getCurrentTurnMessages(history, options = {}) {
    const startIndex = getCurrentTurnStartIndex(history);
    return history.slice(options.includeUser ? startIndex : startIndex + 1);
}
function parseSendRecipient(content) {
    if (!content)
        return null;
    try {
        const parsed = JSON.parse(content);
        if ((parsed.status === 'sent' || parsed.status === 'duplicate') &&
            typeof parsed.to === 'string') {
            return parsed.to;
        }
    }
    catch {
        // Tool content is sometimes plain text. Fall through to regex parsing.
    }
    const match = content.match(/"to"\s*:\s*"([^"]+)"/);
    return match?.[1] || null;
}
function parseSendStatus(content) {
    if (!content)
        return null;
    try {
        const parsed = JSON.parse(content);
        return typeof parsed.status === 'string' ? parsed.status : null;
    }
    catch {
        // Tool content is sometimes plain text. Fall through to regex parsing.
    }
    const match = content.match(/"status"\s*:\s*"([^"]+)"/);
    return match?.[1] || null;
}
function extractToolError(content) {
    if (!content)
        return null;
    const prefix = 'Tool error: ';
    if (!content.startsWith(prefix))
        return null;
    return content.slice(prefix.length).trim() || null;
}
function summariseToolError(toolName, error) {
    if (toolName.startsWith('calendar_') &&
        /invalid credentials|401|unauthenticated/i.test(error)) {
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
function formatRecoveryContent(content) {
    if (!content)
        return '(empty)';
    return content.length <= 1200 ? content : `${content.slice(0, 1200)}...`;
}
export function buildSilentTurnRecoveryMessages(history) {
    const currentTurn = getCurrentTurnMessages(history, { includeUser: true });
    if (currentTurn.length === 0)
        return null;
    const lastUserMessage = [...currentTurn]
        .reverse()
        .find((message) => message.role === 'user');
    if (!lastUserMessage?.content?.trim())
        return null;
    const toolMessages = currentTurn
        .filter((message) => message.role === 'tool')
        .slice(-8);
    const assistantToolPlans = currentTurn
        .filter((message) => message.role === 'assistant' && message.content && message.content.trim())
        .slice(-3);
    const transcript = [
        `Original user request:\n${formatRecoveryContent(lastUserMessage.content)}`,
        assistantToolPlans.length > 0
            ? `Assistant partial replies this turn:\n${assistantToolPlans
                .map((message) => `- ${formatRecoveryContent(message.content)}`)
                .join('\n')}`
            : '',
        toolMessages.length > 0
            ? `Tool results this turn:\n${toolMessages
                .map((message) => `- ${message.name || 'tool'}: ${formatRecoveryContent(message.content)}`)
                .join('\n')}`
            : '',
    ]
        .filter(Boolean)
        .join('\n\n');
    return [
        {
            role: 'system',
            content: 'Write the final user-facing reply for this NanoClaw turn. Tools have already run. Do not call tools. Do not mention internal model behavior, fallbacks, or that a normal reply was missing. If a send_message tool succeeded, confirm it naturally and concisely. If a tool failed, explain that plainly. Return only the final reply text.',
        },
        {
            role: 'user',
            content: `${transcript}\n\nNow write the final reply that should be sent to the user.`,
        },
    ];
}
export function buildSilentTurnFallback(history) {
    const currentTurn = getCurrentTurnMessages(history);
    const toolMessages = currentTurn.filter((message) => message.role === 'tool' && typeof message.name === 'string');
    const successfulSend = toolMessages.find((message) => {
        const toolName = message.name || '';
        const status = parseSendStatus(message.content);
        return (/\.send_message$/.test(toolName) &&
            (status === 'sent' || status === 'duplicate'));
    });
    if (successfulSend) {
        const recipient = parseSendRecipient(successfulSend.content);
        const status = parseSendStatus(successfulSend.content);
        if (status === 'duplicate') {
            return recipient
                ? `Done - that message had already been sent to ${recipient} recently, so I skipped sending it again.`
                : 'Done - that message had already been sent recently, so I skipped sending it again.';
        }
        return recipient
            ? `Done - I sent the requested message to ${recipient}.`
            : 'Done - I sent the requested message.';
    }
    const lastUsefulToolError = [...toolMessages]
        .reverse()
        .map((message) => ({
        toolName: message.name || '',
        error: extractToolError(message.content),
    }))
        .find((candidate) => typeof candidate.error === 'string' &&
        summariseToolError(candidate.toolName, candidate.error) !== null);
    if (lastUsefulToolError) {
        return (summariseToolError(lastUsefulToolError.toolName, lastUsefulToolError.error) ||
            "I couldn't complete that request because a tool call failed.");
    }
    const attemptedContactLookup = toolMessages.some((message) => ['google_contacts.search', 'read_chat_history', 'list_chats'].includes(message.name || ''));
    if (attemptedContactLookup) {
        return "I couldn't find a matching contact or chat to complete that request. Please send me the phone number or a more specific contact name and I'll try again.";
    }
    return "I hit a dead end and didn't generate a usable final reply. Please try again, and if you're asking me to message someone, include the recipient's exact number or a more specific contact name.";
}
//# sourceMappingURL=response-fallback.js.map
