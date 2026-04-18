export interface TerminalTurnMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
}
export declare function buildSilentTurnFallback(history: TerminalTurnMessage[]): string;
//# sourceMappingURL=response-fallback.d.ts.map