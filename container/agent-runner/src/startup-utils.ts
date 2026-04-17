export function shouldForcePreflightCompaction(
  historyLength: number,
  estimatedRequestTokens: number,
  contextWindow: number,
  maxHistoryKeepMessages: number,
): boolean {
  return (
    historyLength > maxHistoryKeepMessages &&
    estimatedRequestTokens > contextWindow
  );
}
