export function shouldForcePreflightCompaction(
  historyLength: number,
  estimatedRequestTokens: number,
  contextWindow: number,
  maxHistoryKeepMessages: number,
): boolean {
  // Deterministically compact obviously bloated histories even if token
  // estimation undercounts for some reason. This keeps hot startup bounded
  // for long-lived main sessions.
  if (historyLength > maxHistoryKeepMessages * 4) {
    return true;
  }

  return (
    historyLength > maxHistoryKeepMessages &&
    estimatedRequestTokens > contextWindow
  );
}
