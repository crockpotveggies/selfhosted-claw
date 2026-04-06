/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, and talks to an
 * OpenAI-compatible chat completions endpoint with native tool calling.
 */

import { execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface ChatCompletionResult {
  content: string | null;
  toolCalls: OpenAIToolCall[];
}

interface ToolSpec {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

interface ToolContext {
  containerInput: ContainerInput;
}

interface TaskRow {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const GROUP_DIR = '/workspace/group';
const STATE_DIR = '/workspace/state';
const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const CONVERSATIONS_DIR = path.join(GROUP_DIR, 'conversations');
const HISTORY_FILE = path.join(STATE_DIR, 'history.jsonl');
const SUMMARY_FILE = path.join(STATE_DIR, 'summary.md');

const AGENT_MEMORY_FILENAMES = ['AGENT.md', 'CLAUDE.md'];
const OPENAI_BASE_URL = (
  process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8000/v1'
).replace(/\/$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'local-model';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MAX_TOKENS = Math.max(
  256,
  parseInt(process.env.OPENAI_MAX_TOKENS || '4096', 10) || 4096,
);
const OPENAI_TEMPERATURE = Number.parseFloat(
  process.env.OPENAI_TEMPERATURE || '0.2',
);
const OPENAI_CONTEXT_WINDOW = Math.max(
  OPENAI_MAX_TOKENS,
  parseInt(process.env.OPENAI_CONTEXT_WINDOW || '24000', 10) || 24000,
);
const SCRIPT_TIMEOUT_MS = 30_000;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_HISTORY_KEEP_MESSAGES = 16;
const MAX_GROUP_MEMORY_CHARS = 2_000;
const MAX_SHARED_MEMORY_CHARS = 1_200;
const WEB_SEARCH_ENDPOINT = 'https://duckduckgo.com/html/';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function truncate(text: string, maxChars: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function truncateMemory(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[memory truncated: ${text.length - maxChars} more chars]`;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function ensureRuntimeDirs(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

function readCompatibleMemoryFile(dirPath: string): string | null {
  for (const filename of AGENT_MEMORY_FILENAMES) {
    const filePath = path.join(dirPath, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  }
  return null;
}

function buildSystemPrompt(containerInput: ContainerInput): string {
  const sections: string[] = [];
  const baseline = [
    `You are ${containerInput.assistantName || 'the assistant'}, running inside NanoClaw.`,
    `You use an OpenAI-compatible chat completions backend and NanoClaw-native tools.`,
    `Use tools when they materially improve the answer. Prefer concise responses.`,
    `If the user explicitly asks you to reach out, contact, message, email, or text someone, you may emit a send directive in this exact format: <send_message channel="signal|sms|email" to="recipient name or address">message to send</send_message>.`,
    `If the user explicitly asks you to start a new Signal group conversation, you may emit a directive in this exact format: <create_group channel="signal" members="recipient one, recipient two" title="optional group title">first message to send to the new group</create_group>.`,
    `If the user asks you to add or remove someone from an existing Signal group, emit: <update_group channel="signal" group_name="Group Name" action="add_member" members="person name"></update_group> or action="remove_member". To rename a group: <update_group channel="signal" group_name="Group Name" action="rename" new_name="New Name"></update_group>. Adding/removing members and renaming require user confirmation.`,
    `If the user asks you to list their Signal groups or check who is in a group, emit: <inspect_group channel="signal"></inspect_group> (lists all groups) or <inspect_group channel="signal" group_name="Group Name"></inspect_group> (shows members of that group). This does not require confirmation.`,
    `If the user explicitly asks you to delete or remove an email, calendar item, or outbound thread, you may emit a directive in this exact format: <delete_resource channel="email|calendar|signal|sms" target="identifier or short label">short reason</delete_resource>.`,
    `Only emit send directives for explicit outbound requests. If recipient, channel, or message content is ambiguous, ask a short clarifying question instead of guessing.`,
    `Starting a new conversation thread, creating a new group conversation, or deleting something requires user confirmation; the host will enforce that approval gate.`,
    `Do not mention OneCLI or secrets unless directly relevant; host-side credentials may be managed outside the container.`,
    `Your current working directory is ${GROUP_DIR}.`,
    `Current time: ${new Date().toISOString()}.`,
  ].join(' ');
  sections.push(baseline);

  const groupMemory = readCompatibleMemoryFile(GROUP_DIR);
  if (groupMemory) {
    sections.push(
      `Group memory:\n${truncateMemory(groupMemory, MAX_GROUP_MEMORY_CHARS)}`,
    );
  }

  const globalDirs = ['/workspace/global', '/workspace/project/groups/global'];
  for (const dirPath of globalDirs) {
    if (!fs.existsSync(dirPath)) continue;
    const globalMemory = readCompatibleMemoryFile(dirPath);
    if (globalMemory) {
      sections.push(
        `Shared memory:\n${truncateMemory(globalMemory, MAX_SHARED_MEMORY_CHARS)}`,
      );
      break;
    }
  }

  return sections.join('\n\n');
}

function readSummary(): string | null {
  if (!fs.existsSync(SUMMARY_FILE)) return null;
  const content = fs.readFileSync(SUMMARY_FILE, 'utf-8').trim();
  return content || null;
}

function loadHistory(): OpenAIMessage[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const lines = fs
    .readFileSync(HISTORY_FILE, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const messages: OpenAIMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as OpenAIMessage;
      if (
        parsed &&
        (parsed.role === 'user' ||
          parsed.role === 'assistant' ||
          parsed.role === 'tool')
      ) {
        messages.push(parsed);
      }
    } catch {
      // Ignore corrupt lines and keep the rest of history usable.
    }
  }
  return messages;
}

function saveHistory(history: OpenAIMessage[]): void {
  ensureRuntimeDirs();
  const content =
    history.map((entry) => JSON.stringify(entry)).join('\n') +
    (history.length > 0 ? '\n' : '');
  fs.writeFileSync(HISTORY_FILE, content);
}

function estimateTokens(messages: OpenAIMessage[], summary: string | null): number {
  return Math.ceil((JSON.stringify(messages).length + (summary?.length || 0)) / 4);
}

function estimateConversationRequestTokens(
  systemPrompt: string,
  history: OpenAIMessage[],
): number {
  return Math.ceil(
    JSON.stringify(buildConversationMessages(systemPrompt, history)).length / 4,
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function formatMessagesForArchive(messages: OpenAIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      lines.push(
        `**Assistant tool plan**: ${message.tool_calls.map((call) => call.function.name).join(', ')}`,
      );
      if (message.content) lines.push(message.content);
      lines.push('');
      continue;
    }
    if (message.role === 'tool') {
      lines.push(`**Tool ${message.name || message.tool_call_id || 'result'}**`);
      lines.push(truncate(message.content || '', 2000));
      lines.push('');
      continue;
    }
    lines.push(`**${message.role === 'user' ? 'User' : 'Assistant'}**`);
    lines.push(message.content || '');
    lines.push('');
  }
  return lines.join('\n');
}

function fallbackSummary(messages: OpenAIMessage[]): string {
  const snippets = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(0, 8)
    .map((message) => {
      const prefix = message.role === 'user' ? 'User' : 'Assistant';
      const text = truncate((message.content || '').replace(/\s+/g, ' '), 200);
      return `- ${prefix}: ${text}`;
    });
  return snippets.join('\n') || '- Conversation contained tool activity and no text summary was available.';
}

async function archiveAndCompactHistory(systemPrompt: string): Promise<void> {
  const summary = readSummary();
  const history = loadHistory();
  if (estimateTokens(history, summary) <= OPENAI_CONTEXT_WINDOW) return;
  if (history.length <= MAX_HISTORY_KEEP_MESSAGES) return;

  const archived = history.slice(0, history.length - MAX_HISTORY_KEEP_MESSAGES);
  const retained = history.slice(history.length - MAX_HISTORY_KEEP_MESSAGES);
  if (archived.length === 0) return;

  let newSummary = fallbackSummary(archived);
  try {
    const prompt = [
      'Summarize this archived NanoClaw conversation history for future continuity.',
      'Focus on durable user preferences, pending work, decisions, and open loops.',
      summary ? `Existing summary:\n${summary}` : '',
      `Archived conversation:\n${formatMessagesForArchive(archived)}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const generated = await createPlainCompletion([
      {
        role: 'system',
        content:
          'Produce a concise but information-dense summary for a future agent run.',
      },
      { role: 'user', content: prompt },
    ]);
    if (generated.trim()) newSummary = generated.trim();
  } catch (err) {
    log(
      `Compaction summarization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const timestamp = new Date().toISOString();
  const archivePath = path.join(
    CONVERSATIONS_DIR,
    `${timestamp.slice(0, 10)}-${slugify(newSummary || 'conversation')}.md`,
  );
  const archiveContent = [
    `# Archived Conversation`,
    '',
    `Archived: ${timestamp}`,
    '',
    `## Summary`,
    '',
    newSummary,
    '',
    `## Messages`,
    '',
    formatMessagesForArchive(archived),
  ].join('\n');
  fs.writeFileSync(archivePath, archiveContent);

  fs.writeFileSync(SUMMARY_FILE, newSummary + '\n');
  saveHistory(retained);
}

function buildConversationMessages(
  systemPrompt: string,
  history: OpenAIMessage[],
): OpenAIMessage[] {
  const summary = readSummary();
  const messages: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];
  if (summary) {
    messages.push({
      role: 'system',
      content: `Conversation summary from prior runs:\n${summary}`,
    });
  }
  return messages.concat(history);
}

function openAIHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (OPENAI_API_KEY) headers.Authorization = `Bearer ${OPENAI_API_KEY}`;
  return headers;
}

async function parseEventStream(response: Response): Promise<ChatCompletionResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response body was not readable');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = new Map<number, OpenAIToolCall>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

    let splitIndex = buffer.indexOf('\n\n');
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      splitIndex = buffer.indexOf('\n\n');

      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const line of dataLines) {
        if (line === '[DONE]') {
          return {
            content: content || null,
            toolCalls: [...toolCalls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map((entry) => entry[1]),
          };
        }

        const payload = JSON.parse(line) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: 'function';
                function?: {
                  name?: string;
                  arguments?: string;
                };
              }>;
            };
          }>;
        };
        const choice = payload.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        if (typeof delta.content === 'string') {
          content += delta.content;
        }

        for (const toolDelta of delta.tool_calls || []) {
          const existing = toolCalls.get(toolDelta.index) || {
            id: toolDelta.id || `tool-${toolDelta.index}`,
            type: 'function' as const,
            function: {
              name: '',
              arguments: '',
            },
          };
          if (toolDelta.id) existing.id = toolDelta.id;
          if (toolDelta.function?.name) {
            existing.function.name += toolDelta.function.name;
          }
          if (toolDelta.function?.arguments) {
            existing.function.arguments += toolDelta.function.arguments;
          }
          toolCalls.set(toolDelta.index, existing);
        }
      }
    }
  }

  return {
    content: content || null,
    toolCalls: [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]),
  };
}

async function createChatCompletion(
  messages: OpenAIMessage[],
  tools?: Array<Record<string, unknown>>,
  maxTokensOverride: number = OPENAI_MAX_TOKENS,
): Promise<ChatCompletionResult> {
  const requestPayload = {
    model: OPENAI_MODEL,
    temperature: OPENAI_TEMPERATURE,
    max_tokens: maxTokensOverride,
    stream: true,
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: openAIHeaders(),
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (
      tools &&
      tools.length > 0 &&
      response.status === 400 &&
      errorText.includes('tool choice requires --enable-auto-tool-choice')
    ) {
      log(
        'Backend rejected automatic tool choice; retrying this turn without tools',
      );
      return createChatCompletion(messages);
    }
    const reducedMaxTokens = deriveRetryMaxTokens(errorText, maxTokensOverride);
    if (
      response.status === 400 &&
      reducedMaxTokens != null &&
      reducedMaxTokens < maxTokensOverride
    ) {
      log(
        `Backend rejected max_tokens=${maxTokensOverride}; retrying with ${reducedMaxTokens}`,
      );
      return createChatCompletion(messages, tools, reducedMaxTokens);
    }
    throw new Error(`OpenAI request failed (${response.status}): ${truncate(errorText, 1000)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    return parseEventStream(response);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: OpenAIToolCall[];
      };
    }>;
  };
  const message = payload.choices?.[0]?.message;
  return {
    content: message?.content || null,
    toolCalls: message?.tool_calls || [],
  };
}

function deriveRetryMaxTokens(
  errorText: string,
  currentMaxTokens: number,
): number | null {
  const match = errorText.match(
    /maximum context length is (\d+) tokens and your request has (\d+) input tokens/i,
  );
  if (!match) return null;

  const modelContext = parseInt(match[1], 10);
  const inputTokens = parseInt(match[2], 10);
  if (!Number.isFinite(modelContext) || !Number.isFinite(inputTokens)) {
    return null;
  }

  const available = modelContext - inputTokens - 64;
  if (available <= 0) {
    return Math.min(currentMaxTokens, 256);
  }

  return Math.max(256, Math.min(currentMaxTokens - 1, available));
}

function parseContextLimitError(
  errorText: string,
): { maxContextTokens: number; inputTokens: number } | null {
  const match = errorText.match(
    /maximum context length is (\d+) tokens(?: and your request has|\. However, your request has) (\d+) input tokens/i,
  );
  if (!match) return null;

  const maxContextTokens = parseInt(match[1], 10);
  const inputTokens = parseInt(match[2], 10);
  if (!Number.isFinite(maxContextTokens) || !Number.isFinite(inputTokens)) {
    return null;
  }
  return { maxContextTokens, inputTokens };
}

function trimHistoryToFitContext(
  systemPrompt: string,
  history: OpenAIMessage[],
  maxContextTokens: number,
): OpenAIMessage[] | null {
  if (history.length <= 1) return null;

  const targetTokens = Math.max(512, maxContextTokens - 256);
  const trimmed = [...history];

  while (trimmed.length > 1) {
    if (estimateConversationRequestTokens(systemPrompt, trimmed) <= targetTokens) {
      return trimmed;
    }
    trimmed.shift();
  }

  return estimateConversationRequestTokens(systemPrompt, trimmed) <= targetTokens
    ? trimmed
    : null;
}

async function createPlainCompletion(
  messages: OpenAIMessage[],
  maxTokensOverride: number = Math.min(OPENAI_MAX_TOKENS, 1024),
): Promise<string> {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: openAIHeaders(),
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.1,
      max_tokens: maxTokensOverride,
      stream: false,
      messages,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const reducedMaxTokens = deriveRetryMaxTokens(errorText, maxTokensOverride);
    if (
      response.status === 400 &&
      reducedMaxTokens != null &&
      reducedMaxTokens < maxTokensOverride
    ) {
      log(
        `Backend rejected max_tokens=${maxTokensOverride}; retrying plain completion with ${reducedMaxTokens}`,
      );
      return createPlainCompletion(messages, reducedMaxTokens);
    }
    throw new Error(`OpenAI request failed (${response.status}): ${truncate(errorText, 1000)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
      };
    }>;
  };
  return payload.choices?.[0]?.message?.content || '';
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function shouldClose(): boolean {
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }
  return true;
}

function drainIpcInput(): string[] {
  ensureRuntimeDirs();
  try {
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          type?: string;
          text?: string;
        };
        if (parsed.type === 'message' && typeof parsed.text === 'string') {
          messages.push(parsed.text);
        }
      } finally {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

function resolveWorkspacePath(inputPath: string): string {
  const resolved = inputPath.startsWith('/')
    ? path.resolve(inputPath)
    : path.resolve(GROUP_DIR, inputPath);
  const allowedRoots = [
    GROUP_DIR,
    '/workspace/global',
    '/workspace/project',
    STATE_DIR,
    '/workspace/extra',
    IPC_DIR,
  ];
  if (
    !allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(`${root}/`),
    )
  ) {
    throw new Error(`Path is outside the allowed workspace roots: ${inputPath}`);
  }
  return resolved;
}

function isProbablyText(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

function collectFiles(basePath: string, recursive: boolean, limit: number): string[] {
  const results: string[] = [];
  const stack = [basePath];

  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop()!;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      results.push(current);
      continue;
    }

    const entries = fs.readdirSync(current);
    for (const entry of entries) {
      if (results.length >= limit) break;
      const fullPath = path.join(current, entry);
      const entryStat = fs.statSync(fullPath);
      if (entryStat.isDirectory()) {
        if (recursive) stack.push(fullPath);
      } else if (entryStat.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function formatTaskList(tasks: TaskRow[]): string {
  if (tasks.length === 0) return 'No scheduled tasks found.';
  return tasks
    .map(
      (task) =>
        `- [${task.id}] ${task.prompt.slice(0, 60)} (${task.schedule_type}: ${task.schedule_value}) status=${task.status} next=${task.next_run || 'n/a'}`,
    )
    .join('\n');
}

async function runShellCommand(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-lc', command],
      {
        cwd: GROUP_DIR,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout.trim()) parts.push(`stdout:\n${truncate(stdout.trim())}`);
        if (stderr.trim()) parts.push(`stderr:\n${truncate(stderr.trim())}`);
        if (error) {
          parts.push(`exit: ${'code' in error && typeof error.code === 'number' ? error.code : 'non-zero'}`);
        } else {
          parts.push('exit: 0');
        }
        resolve(parts.join('\n\n') || 'Command produced no output.');
      },
    );
  });
}

const TOOL_REGISTRY: Record<string, ToolSpec> = {
  send_message: {
    description:
      'Send a chat message immediately while you continue working in the current run.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send now.' },
        sender: {
          type: 'string',
          description: 'Optional sender/role label for the outbound message.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('send_message requires non-empty text');
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid: ctx.containerInput.chatJid,
        text,
        sender: typeof args.sender === 'string' ? args.sender : undefined,
        groupFolder: ctx.containerInput.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return 'Message sent.';
    },
  },
  shell: {
    description:
      'Run a bash command inside the container sandbox with the group workspace as cwd.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    execute: async (args) =>
      runShellCommand(
        String(args.command || ''),
        Math.max(1000, Number(args.timeout_ms) || 20_000),
      ),
  },
  read_file: {
    description: 'Read a text file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const filePath = resolveWorkspacePath(String(args.path || ''));
      const content = fs.readFileSync(filePath, 'utf-8');
      const startLine = Math.max(1, Number(args.start_line) || 1);
      const endLine = Math.max(startLine, Number(args.end_line) || startLine + 199);
      const lines = content.split('\n').slice(startLine - 1, endLine);
      return lines.join('\n');
    },
  },
  write_file: {
    description:
      'Write or append a text file in the workspace. Creates parent directories when needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const filePath = resolveWorkspacePath(String(args.path || ''));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (args.append === true) {
        fs.appendFileSync(filePath, String(args.content));
      } else {
        fs.writeFileSync(filePath, String(args.content));
      }
      return `Wrote ${filePath}`;
    },
  },
  edit_file: {
    description: 'Replace text inside a workspace file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const filePath = resolveWorkspacePath(String(args.path || ''));
      const oldText = String(args.old_text);
      const newText = String(args.new_text);
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes(oldText)) {
        throw new Error('old_text was not found in the file');
      }
      const nextContent =
        args.replace_all === true
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText);
      fs.writeFileSync(filePath, nextContent);
      return `Updated ${filePath}`;
    },
  },
  list_files: {
    description: 'List files under a path in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const basePath = resolveWorkspacePath(String(args.path || '.'));
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
      const files = collectFiles(basePath, args.recursive !== false, limit);
      return files.map((file) => path.relative(GROUP_DIR, file) || '.').join('\n');
    },
  },
  grep_files: {
    description: 'Search for text in workspace files.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        case_sensitive: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const pattern = String(args.pattern || '');
      const basePath = resolveWorkspacePath(String(args.path || '.'));
      const caseSensitive = args.case_sensitive === true;
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      const matches: string[] = [];

      for (const filePath of collectFiles(basePath, true, 500)) {
        if (matches.length >= limit) break;
        const buffer = fs.readFileSync(filePath);
        if (!isProbablyText(buffer)) continue;
        const content = buffer.toString('utf-8');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
          if (haystack.includes(needle)) {
            matches.push(
              `${path.relative(GROUP_DIR, filePath) || filePath}:${index + 1}:${truncate(lines[index], 240)}`,
            );
            if (matches.length >= limit) break;
          }
        }
      }

      return matches.length > 0 ? matches.join('\n') : 'No matches found.';
    },
  },
  web_fetch: {
    description: 'Fetch a URL and return the response body as text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'integer' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const url = String(args.url || '');
      const maxChars = Math.max(500, Math.min(30_000, Number(args.max_chars) || 10_000));
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'NanoClaw/1.0',
        },
      });
      const text = truncate(await response.text(), maxChars);
      return `status: ${response.status}\nurl: ${response.url}\n\n${text}`;
    },
  },
  web_search: {
    description: 'Search the web and return a short list of results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query is required');
      const maxResults = Math.max(1, Math.min(10, Number(args.max_results) || 5));
      const response = await fetch(
        `${WEB_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent': 'NanoClaw/1.0',
          },
        },
      );
      const html = await response.text();
      const results: string[] = [];
      const anchorPattern =
        /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
      let match: RegExpExecArray | null;
      while ((match = anchorPattern.exec(html)) && results.length < maxResults) {
        const href = match[1]
          .replace(/&amp;/g, '&')
          .replace(/^\/l\/\?kh=-1&uddg=/, '');
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (!title) continue;
        results.push(`${results.length + 1}. ${title}\n${decodeURIComponent(href)}`);
      }
      if (results.length === 0) {
        return truncate(html.replace(/<[^>]+>/g, ' '), 4000);
      }
      return results.join('\n\n');
    },
  },
  schedule_task: {
    description: 'Schedule a recurring or one-time NanoClaw task.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
        schedule_value: { type: 'string' },
        context_mode: { type: 'string', enum: ['group', 'isolated'] },
        target_group_jid: { type: 'string' },
        script: { type: 'string' },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const scheduleType = String(args.schedule_type);
      const scheduleValue = String(args.schedule_value);
      if (scheduleType === 'cron') {
        CronExpressionParser.parse(scheduleValue);
      } else if (scheduleType === 'interval') {
        const intervalMs = parseInt(scheduleValue, 10);
        if (!intervalMs || intervalMs <= 0) {
          throw new Error('interval schedule_value must be positive milliseconds');
        }
      } else if (scheduleType === 'once') {
        const date = new Date(scheduleValue);
        if (Number.isNaN(date.getTime())) {
          throw new Error('once schedule_value must be a valid local timestamp');
        }
      }

      const targetJid =
        ctx.containerInput.isMain && typeof args.target_group_jid === 'string'
          ? args.target_group_jid
          : ctx.containerInput.chatJid;
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'schedule_task',
        taskId,
        prompt: String(args.prompt),
        script:
          typeof args.script === 'string' && args.script.length > 0
            ? args.script
            : undefined,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        context_mode:
          args.context_mode === 'isolated' ? 'isolated' : 'group',
        targetJid,
        createdBy: ctx.containerInput.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return `Task ${taskId} scheduled.`;
    },
  },
  list_tasks: {
    description: 'List scheduled tasks visible to the current group.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
      if (!fs.existsSync(tasksFile)) return 'No scheduled tasks found.';
      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as TaskRow[];
      const visibleTasks = ctx.containerInput.isMain
        ? allTasks
        : allTasks.filter(
            (task) => task.groupFolder === ctx.containerInput.groupFolder,
          );
      return formatTaskList(visibleTasks);
    },
  },
  pause_task: {
    description: 'Pause a scheduled task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      writeIpcFile(TASKS_DIR, {
        type: 'pause_task',
        taskId: String(args.task_id),
        groupFolder: ctx.containerInput.groupFolder,
        isMain: ctx.containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${String(args.task_id)} pause requested.`;
    },
  },
  resume_task: {
    description: 'Resume a paused scheduled task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      writeIpcFile(TASKS_DIR, {
        type: 'resume_task',
        taskId: String(args.task_id),
        groupFolder: ctx.containerInput.groupFolder,
        isMain: ctx.containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${String(args.task_id)} resume requested.`;
    },
  },
  cancel_task: {
    description: 'Cancel a scheduled task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      writeIpcFile(TASKS_DIR, {
        type: 'cancel_task',
        taskId: String(args.task_id),
        groupFolder: ctx.containerInput.groupFolder,
        isMain: ctx.containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${String(args.task_id)} cancellation requested.`;
    },
  },
  update_task: {
    description: 'Update an existing scheduled task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        prompt: { type: 'string' },
        schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
        schedule_value: { type: 'string' },
        script: { type: 'string' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (
        args.schedule_type === 'cron' ||
        (!args.schedule_type && typeof args.schedule_value === 'string')
      ) {
        if (typeof args.schedule_value === 'string') {
          CronExpressionParser.parse(args.schedule_value);
        }
      }
      if (
        args.schedule_type === 'interval' &&
        typeof args.schedule_value === 'string'
      ) {
        const intervalMs = parseInt(args.schedule_value, 10);
        if (!intervalMs || intervalMs <= 0) {
          throw new Error('interval schedule_value must be positive milliseconds');
        }
      }

      writeIpcFile(TASKS_DIR, {
        type: 'update_task',
        taskId: String(args.task_id),
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        script: typeof args.script === 'string' ? args.script : undefined,
        schedule_type:
          typeof args.schedule_type === 'string' ? args.schedule_type : undefined,
        schedule_value:
          typeof args.schedule_value === 'string' ? args.schedule_value : undefined,
        groupFolder: ctx.containerInput.groupFolder,
        isMain: ctx.containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${String(args.task_id)} update requested.`;
    },
  },
  register_group: {
    description: 'Register a new chat/group so NanoClaw responds there.',
    parameters: {
      type: 'object',
      properties: {
        jid: { type: 'string' },
        name: { type: 'string' },
        folder: { type: 'string' },
        trigger: { type: 'string' },
        requiresTrigger: { type: 'boolean' },
      },
      required: ['jid', 'name', 'folder', 'trigger'],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.containerInput.isMain) {
        throw new Error('Only the main group can register new groups');
      }
      writeIpcFile(TASKS_DIR, {
        type: 'register_group',
        jid: String(args.jid),
        name: String(args.name),
        folder: String(args.folder),
        trigger: String(args.trigger),
        requiresTrigger: args.requiresTrigger === true,
        timestamp: new Date().toISOString(),
      });
      return `Group "${String(args.name)}" registration requested.`;
    },
  },
  delegate_task: {
    description:
      'Run a focused nested model call for a bounded research or drafting subtask.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const response = await createPlainCompletion([
        {
          role: 'system',
          content:
            'You are a focused NanoClaw sub-agent. Solve only the delegated task and return the answer directly.',
        },
        {
          role: 'user',
          content: [
            `Task:\n${String(args.task)}`,
            typeof args.context === 'string' && args.context
              ? `Context:\n${args.context}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ]);
      return response.trim() || 'Delegate task completed with no text output.';
    },
  },
};

function buildOpenAITools(): Array<Record<string, unknown>> {
  return Object.entries(TOOL_REGISTRY).map(([name, spec]) => ({
    type: 'function',
    function: {
      name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));
}

async function executeToolCall(
  call: OpenAIToolCall,
  ctx: ToolContext,
): Promise<OpenAIMessage> {
  const tool = TOOL_REGISTRY[call.function.name];
  if (!tool) {
    return {
      role: 'tool',
      name: call.function.name,
      tool_call_id: call.id,
      content: `Unknown tool: ${call.function.name}`,
    };
  }

  let parsedArgs: Record<string, unknown> = {};
  try {
    parsedArgs = call.function.arguments
      ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
      : {};
  } catch (err) {
    return {
      role: 'tool',
      name: call.function.name,
      tool_call_id: call.id,
      content: `Tool argument parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const result = await tool.execute(parsedArgs, ctx);
    return {
      role: 'tool',
      name: call.function.name,
      tool_call_id: call.id,
      content: truncate(result),
    };
  } catch (err) {
    return {
      role: 'tool',
      name: call.function.name,
      tool_call_id: call.id,
      content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runConversationTurn(
  prompt: string,
  containerInput: ContainerInput,
  systemPrompt: string,
): Promise<string | null> {
  const history = loadHistory();
  const workingHistory: OpenAIMessage[] = [...history, { role: 'user', content: prompt }];
  const ctx: ToolContext = { containerInput };
  const tools = buildOpenAITools();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: ChatCompletionResult;
    while (true) {
      const messages = buildConversationMessages(systemPrompt, workingHistory);
      try {
        response = await createChatCompletion(messages, tools);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const limit = parseContextLimitError(message);
        if (!limit) throw err;

        const trimmedHistory = trimHistoryToFitContext(
          systemPrompt,
          workingHistory,
          limit.maxContextTokens,
        );
        if (!trimmedHistory) throw err;

        log(
          `Context too large (${limit.inputTokens}/${limit.maxContextTokens}); trimming history from ${workingHistory.length} to ${trimmedHistory.length} messages and retrying`,
        );
        workingHistory.splice(0, workingHistory.length, ...trimmedHistory);
      }
    }

    const assistantMessage: OpenAIMessage = {
      role: 'assistant',
      content: response.content,
      ...(response.toolCalls.length > 0
        ? { tool_calls: response.toolCalls }
        : {}),
    };
    workingHistory.push(assistantMessage);

    if (response.toolCalls.length === 0) {
      saveHistory(workingHistory);
      await archiveAndCompactHistory(systemPrompt);
      return response.content?.trim() || null;
    }

    for (const toolCall of response.toolCalls) {
      const toolMessage = await executeToolCall(toolCall, ctx);
      workingHistory.push(toolMessage);
    }
  }

  const fallback =
    'I hit the tool-call limit for this turn. Please ask me to continue if you want me to keep going.';
  workingHistory.push({ role: 'assistant', content: fallback });
  saveHistory(workingHistory);
  await archiveAndCompactHistory(systemPrompt);
  return fallback;
}

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${truncate(stderr.slice(0, 500))}`);
        }
        if (error) {
          log(`Script error: ${error.message}`);
          resolve(null);
          return;
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          resolve(null);
          return;
        }

        try {
          const parsed = JSON.parse(lastLine) as ScriptResult;
          if (typeof parsed.wakeAgent !== 'boolean') {
            resolve(null);
            return;
          }
          resolve(parsed);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  ensureRuntimeDirs();

  let containerInput: ContainerInput;
  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore stale sentinel
  }

  const systemPrompt = buildSystemPrompt(containerInput);
  let prompt = containerInput.prompt;

  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  if (containerInput.script && containerInput.isScheduledTask) {
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      writeOutput({ status: 'success', result: null });
      return;
    }
    prompt = [
      '[SCHEDULED TASK]',
      '',
      `Script output:\n${JSON.stringify(scriptResult.data, null, 2)}`,
      '',
      `Instructions:\n${containerInput.prompt}`,
    ].join('\n');
  }

  try {
    while (true) {
      const finalText = await runConversationTurn(prompt, containerInput, systemPrompt);
      writeOutput({ status: 'success', result: finalText });

      if (shouldClose()) {
        log('Close sentinel received, exiting');
        break;
      }

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received while waiting for input, exiting');
        break;
      }
      prompt = nextMessage;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${message}`);
    writeOutput({
      status: 'error',
      result: null,
      error: message,
    });
    process.exit(1);
  }
}

main();
