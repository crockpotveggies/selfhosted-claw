import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  CONTROL_SIGNAL_JID,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { ensureAgentMemoryFile } from './agent-memory.js';
import { startAdminServer } from './admin-server.js';
import './channels/index.js';
import './integrations/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ensureServicesRunning,
  startHealthMonitor,
} from './integrations/service-manager.js';
import { startLogPruner } from './logger/pruner.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeIntegrationToolsManifest,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  startContainerReaper,
  stopContainerReaper,
} from './container-runtime.js';
import {
  deleteRegisteredGroup,
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { ControlActionService } from './control-actions.js';
import type { ApprovalReplyDecision } from './control-actions.js';
import { SignalControlCommandParser } from './control-commands.js';
import {
  deriveUniqueGroupFolder,
  deriveGroupFolder,
  isValidGroupFolder,
  resolveGroupFolderPath,
} from './group-folder.js';
import { consumeIpcSideEffect, startIpcWatcher } from './ipc.js';
import { sanitizeInboundMessage } from './inbound-guard.js';
import { parseAgentOutput } from './outbound-directives.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let executeAgentDirective: (
  directive: ReturnType<typeof parseAgentOutput>['directives'][number],
  sourceChatJid: string,
) => Promise<string> = async () => {
  throw new Error('Outbound directives are not initialized yet');
};

const channels: Channel[] = [];
const queue = new GroupQueue();
let controlServiceRef: ControlActionService | null = null;

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  ensureAgentMemoryFile(
    groupDir,
    path.join(GROUPS_DIR, group.isMain ? 'main' : 'global'),
    ASSISTANT_NAME,
  );

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function inferGroupFolderHint(chatJid: string): string {
  if (chatJid.startsWith('signal:')) {
    return chatJid.slice('signal:'.length);
  }
  if (chatJid.includes('@')) {
    return chatJid.replace(/@/g, '-');
  }
  return chatJid;
}

function buildConfiguredMainGroup(
  controlSignalJid: string,
  groups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  const normalizedJid = controlSignalJid.trim();
  if (!normalizedJid.startsWith('signal:user:')) return null;

  const existingMain = Object.entries(groups).find(([, group]) => group.isMain);
  if (existingMain) return null;

  return {
    jid: normalizedJid,
    group: {
      name: 'Main',
      folder: 'main',
      trigger: DEFAULT_TRIGGER,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
    },
  };
}

/** @internal - exported for testing */
export function _buildConfiguredMainGroup(
  controlSignalJid: string,
  groups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  return buildConfiguredMainGroup(controlSignalJid, groups);
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Determine if the controller triggered this container session.
  // Used for: (1) IPC calendar access flag, (2) container tool gating.
  const controllerSender = CONTROL_SIGNAL_JID
    ? CONTROL_SIGNAL_JID.replace(/^signal:user:/, '').trim()
    : '';
  const controllerTriggered =
    isMainGroup ||
    (!!controllerSender &&
      missedMessages.some((m) => m.sender === controllerSender));

  // Grant calendar access when the controller is the one who sent messages
  // in this group. The IPC handler checks for this flag file.
  if (!isMainGroup && CONTROL_SIGNAL_JID) {
    const flagDir = path.join(DATA_DIR, 'ipc', group.folder);
    const flagPath = path.join(flagDir, 'controller_access');
    try {
      if (controllerTriggered) {
        fs.mkdirSync(flagDir, { recursive: true });
        fs.writeFileSync(flagPath, '');
      } else {
        // Remove stale flag if controller didn't send the triggering messages
        if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
      }
    } catch {
      // best-effort
    }
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    controllerTriggered,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const cleaned = raw
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        const parsed = parseAgentOutput(cleaned);
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        const statusLines: string[] = [];
        for (const directive of parsed.directives) {
          try {
            statusLines.push(await executeAgentDirective(directive, chatJid));
          } catch (err) {
            statusLines.push(
              err instanceof Error
                ? `Send failed: ${err.message}`
                : `Send failed: ${String(err)}`,
            );
          }
        }
        // For non-main (external) chats, route directive status messages
        // (approval requests, send confirmations) to the controller, not the
        // external contact.
        const isExternalChat = !group.isMain;
        const statusText = statusLines.filter(Boolean).join('\n\n').trim();
        if (isExternalChat && statusText && CONTROL_SIGNAL_JID) {
          const controlChannel = findChannel(channels, CONTROL_SIGNAL_JID);
          if (controlChannel) {
            await controlChannel.sendMessage(
              CONTROL_SIGNAL_JID,
              `[${group.name}] ${statusText}`,
            );
          }
        }

        let text = isExternalChat
          ? (parsed.visibleText || '').trim()
          : [parsed.visibleText, ...statusLines]
              .filter(Boolean)
              .join('\n\n')
              .trim();

        // Hard guard: detect operational/controller-facing content that the
        // agent accidentally put into its visible text response for a group
        // chat.  If the entire response looks operational, redirect it to the
        // controller and suppress it from the group.
        if (isExternalChat && text && CONTROL_SIGNAL_JID) {
          const OPERATIONAL_PATTERNS = [
            /\bcross-check\b.*\bcalendar\b/i,
            /\bcheck\b.*\b(your|the)\s+calendar\b/i,
            /\bconfirm\b.*\btime\s*slot\b/i,
            /\bwhat(?:'s| is) the meeting context\b/i,
            /\bwho else is attending\b/i,
            /\bwhat are we scheduling\b/i,
            /\bescalat(e|ing) to\b/i,
            /\bfor your confirmation\b/i,
            /\bpropose a.*time\b.*\bconfirmation\b/i,
            /\bneed to verify\b.*\bwith you\b/i,
            /\bcontroller\b/i,
          ];
          const looksOperational = OPERATIONAL_PATTERNS.some((p) =>
            p.test(text),
          );
          if (looksOperational) {
            const controlChannel = findChannel(channels, CONTROL_SIGNAL_JID);
            if (controlChannel) {
              logger.warn(
                { group: group.name },
                'Redirected operational text response from group to controller',
              );
              await controlChannel.sendMessage(
                CONTROL_SIGNAL_JID,
                `[${group.name}] (redirected from group) ${text}`,
              );
            }
            text = '';
          }
        }

        if (text) {
          // Brief typing indicator so the reply feels natural
          await channel.setTyping?.(chatJid, true);
          await new Promise((r) => setTimeout(r, 1000));
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      consumeIpcSideEffect(group.folder);
      return true;
    }
    // If the agent performed mutating IPC side effects (calendar writes,
    // group creation, etc.) before crashing, don't retry — retrying would
    // duplicate the side effects.
    if (consumeIpcSideEffect(group.folder)) {
      logger.warn(
        { group: group.name },
        'Agent error after IPC side effects, skipping cursor rollback to prevent duplicate actions',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  controllerTriggered: boolean,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Write integration tools manifest so the agent-runner can register dynamic tools
  writeIntegrationToolsManifest(group.folder, isMain);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        controlSignalJid: CONTROL_SIGNAL_JID || undefined,
        controllerTriggered,
        calendarAvailability:
          controlServiceRef?.getCalendarAvailability() || undefined,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      onOutput,
    );

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Skip waking the agent for acknowledgment-only messages
          // (emojis, "ok", "thanks", thumbs-up, etc.).  These are
          // conversation closers that don't need a response and cause
          // reply loops.  The messages still accumulate in the DB and
          // will be included as context if a real message arrives later.
          {
            const ACK_PATTERN =
              /^(?:ok(?:ay)?|k|got it|thanks?|thx|ty|sure|yep|yeah|yea|yup|np|no\s*problem|sounds?\s*good|cool|nice|great|perfect|bet|word|aight|alright|will do|noted|yes|yea+h*|👍|👌|🤙|🙏|✅|💯|🔥|😊|😂|🤣|❤️|💪|🎯|👋|✌️|🫡|💜|🥰|😎|🤝|😁|💙|🤗|😇|🙌|😄|👏|💛|🧡|💚|😉)$/i;
            const allAcks = groupMessages.every((m) =>
              ACK_PATTERN.test(m.content.trim()),
            );
            if (allAcks) {
              logger.debug(
                { chatJid, count: groupMessages.length },
                'Skipping acknowledgment-only messages',
              );
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              continue;
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();
  const controlService = new ControlActionService();
  controlServiceRef = controlService;
  controlService.setApprovalReplyClassifier(
    async ({ reply, pendingSummary }) => {
      const response = await fetch(
        `${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(OPENAI_API_KEY
              ? { Authorization: `Bearer ${OPENAI_API_KEY}` }
              : {}),
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            temperature: 0,
            max_tokens: 80,
            messages: [
              {
                role: 'system',
                content:
                  'Classify whether a short follow-up reply about a pending action means approve, reject, revise, or unclear. ' +
                  'Only choose approve or reject when the user intent is clear. ' +
                  'Choose revise if the user wants changes before acting. ' +
                  'Reply with compact JSON only, such as {"decision":"approve","reason":"..."}',
              },
              {
                role: 'user',
                content:
                  `Pending action: ${pendingSummary}\n` +
                  `User reply: ${reply}\n\n` +
                  'Return JSON with keys decision and reason.',
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Approval reply classification failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | Array<{ text?: string }>;
          };
        }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .map((part) =>
                  typeof part?.text === 'string' ? part.text : '',
                )
                .join('')
            : '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw) as {
        decision?: string;
        reason?: string;
      };
      const decision = parsed.decision as ApprovalReplyDecision | undefined;
      if (
        decision !== 'approve' &&
        decision !== 'reject' &&
        decision !== 'revise' &&
        decision !== 'unclear'
      ) {
        throw new Error(`Invalid approval reply decision: ${raw}`);
      }
      return {
        decision,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      };
    },
  );
  const configuredMain = buildConfiguredMainGroup(
    controlService.getSettings().controlSignalJid,
    registeredGroups,
  );
  if (configuredMain) {
    registerGroup(configuredMain.jid, configuredMain.group);
  }

  const sendHostMessage = async (
    jid: string,
    rawText: string,
    options?: { bypassPause?: boolean },
  ): Promise<void> => {
    const channel = findChannel(channels, jid);
    if (!channel) {
      logger.warn({ jid }, 'No channel owns JID, cannot send message');
      return;
    }
    if (
      !options?.bypassPause &&
      controlService.isProviderPaused(channel.name)
    ) {
      logger.warn(
        { jid, provider: channel.name },
        'Outbound message blocked because provider is paused',
      );
      return;
    }
    const text = formatOutbound(rawText);
    if (text) await channel.sendMessage(jid, text);
  };
  executeAgentDirective = async (
    directive: ReturnType<typeof parseAgentOutput>['directives'][number],
    sourceChatJid: string,
  ): Promise<string> => {
    const agentContext = {
      actorIdentity: 'agent:nanoclaw',
      source: 'agent' as const,
    };
    if (directive.kind === 'send_message') {
      if (directive.channel === 'signal') {
        const target = await controlService.resolveOutboundTarget(
          'signal',
          directive.to,
        );
        const input: Record<string, unknown> = {
          channel: 'signal',
          target: directive.to,
          message: directive.message,
          resolvedSignalJid: target.resolvedTarget,
          resolvedTarget: target.resolvedTarget,
          resolvedDisplayName: target.displayName,
          resolutionSource: target.source,
          requiresConfirmation: !target.existingConversation,
          confirmationReason: target.existingConversation
            ? undefined
            : 'Starting a new Signal conversation requires approval.',
        };
        if (input.requiresConfirmation) {
          const pending = controlService.previewAction(
            'outbound.send',
            input,
            agentContext,
            { chatJid: sourceChatJid },
          );
          return `Confirmation required before starting a new Signal conversation with ${target.displayName} (${target.resolvedTarget}).\nPending ID: ${pending.id}\nReply naturally to approve, reject, or request changes. You can also use /approve ${pending.id} or /reject ${pending.id}.`;
        }
        await controlService.executeAction(
          'outbound.send' as string,
          input,
          agentContext,
        );
        return `Sent via Signal to ${target.displayName} (${target.resolvedTarget}).`;
      }
      if (directive.channel === 'email') {
        const target = await controlService.resolveOutboundTarget(
          'email',
          directive.to,
        );
        const pending = controlService.previewAction(
          'outbound.send',
          {
            channel: directive.channel,
            target: directive.to,
            message: directive.message,
            resolvedTarget: target.resolvedTarget,
            resolvedDisplayName: target.displayName,
            resolutionSource: target.source,
            requiresConfirmation: true,
            confirmationReason:
              'Starting a new email thread requires approval.',
          },
          agentContext,
          { chatJid: sourceChatJid },
        );
        return `Confirmation required before starting a new email thread with ${target.displayName} (${target.resolvedTarget}).\nPending ID: ${pending.id}\nReply naturally to approve, reject, or request changes. You can also use /approve ${pending.id} or /reject ${pending.id}.`;
      }
      const target = await controlService.resolveOutboundTarget(
        'sms',
        directive.to,
      );
      const pending = controlService.previewAction(
        'outbound.send',
        {
          channel: directive.channel,
          target: directive.to,
          message: directive.message,
          resolvedTarget: target.resolvedTarget,
          resolvedDisplayName: target.displayName,
          resolutionSource: target.source,
          requiresConfirmation: true,
          confirmationReason:
            'Starting a new SMS conversation requires approval.',
        },
        agentContext,
        { chatJid: sourceChatJid },
      );
      return `Confirmation required before starting a new SMS conversation with ${target.displayName} (${target.resolvedTarget}).\nPending ID: ${pending.id}\nReply naturally to approve, reject, or request changes. You can also use /approve ${pending.id} or /reject ${pending.id}.`;
    }
    if (directive.kind === 'create_group') {
      const SELF_REFS = new Set(['me', 'myself', 'i']);
      const rawMembers = directive.members.map((m) =>
        SELF_REFS.has(m.toLowerCase().trim()) ? sourceChatJid : m,
      );
      const members = await controlService.resolveOutboundTargets(
        'signal',
        rawMembers,
      );
      if (
        sourceChatJid.startsWith('signal:user:') &&
        !members.some((m) => m.resolvedTarget === sourceChatJid)
      ) {
        members.push({
          channel: 'signal',
          query: sourceChatJid,
          resolvedTarget: sourceChatJid,
          displayName: sourceChatJid,
          source: 'literal',
          existingConversation: true,
        });
      }
      const pending = controlService.previewAction(
        'outbound.createGroup',
        {
          channel: 'signal',
          title: directive.title,
          message: directive.message,
          members: directive.members,
          resolvedMemberTargets: members.map((member) => member.resolvedTarget),
          resolvedMemberDisplayNames: members.map(
            (member) => member.displayName,
          ),
        },
        agentContext,
        { chatJid: sourceChatJid },
      );
      return `Confirmation required before creating a new Signal group with ${members
        .map((member) => `${member.displayName} (${member.resolvedTarget})`)
        .join(
          ', ',
        )}.\nPending ID: ${pending.id}\nReply naturally to approve, reject, or request changes. You can also use /approve ${pending.id} or /reject ${pending.id}.`;
    }
    if (directive.kind === 'update_group') {
      const signalChannel = channels.find((c) => c.name === 'signal') as
        | (Channel & {
            findGroupByName?: (name: string) => Promise<{
              id: string;
              name: string;
              members: string[];
            } | null>;
          })
        | undefined;
      if (!signalChannel?.findGroupByName) {
        return 'Signal is not configured.';
      }
      const group = await signalChannel.findGroupByName(directive.groupName);
      if (!group) {
        return `No Signal group found matching "${directive.groupName}".`;
      }
      if (directive.action === 'rename') {
        if (!directive.newName) {
          return 'A new name is required for the rename action.';
        }
        const pending = controlService.previewAction(
          'outbound.updateGroup',
          {
            channel: 'signal',
            groupName: group.name,
            groupId: group.id,
            action: 'rename',
            resolvedMemberTargets: [],
            resolvedMemberDisplayNames: [],
            newName: directive.newName,
          },
          agentContext,
          { chatJid: sourceChatJid },
        );
        return `Confirmation required before renaming group "${group.name}" to "${directive.newName}".\nPending ID: ${pending.id}\nReply naturally to approve, reject, or request changes. You can also use /approve ${pending.id} or /reject ${pending.id}.`;
      }
      const SELF_REFS = new Set(['me', 'myself', 'i']);
      const rawMembers = directive.members.map((m) =>
        SELF_REFS.has(m.toLowerCase().trim()) ? sourceChatJid : m,
      );
      const members = await controlService.resolveOutboundTargets(
        'signal',
        rawMembers,
      );
      const verb = directive.action === 'add_member' ? 'adding' : 'removing';
      const prep = directive.action === 'add_member' ? 'to' : 'from';
      const pending = controlService.previewAction(
        'outbound.updateGroup',
        {
          channel: 'signal',
          groupName: group.name,
          groupId: group.id,
          action: directive.action,
          resolvedMemberTargets: members.map((m) => m.resolvedTarget),
          resolvedMemberDisplayNames: members.map((m) => m.displayName),
        },
        agentContext,
        { chatJid: sourceChatJid },
      );
      const memberList = members
        .map((m) => `${m.displayName} (${m.resolvedTarget})`)
        .join(', ');
      return `Confirmation required before ${verb} ${memberList} ${prep} "${group.name}".\nPending ID: ${pending.id}\nReply naturally to approve, reject, or request changes. You can also use /approve ${pending.id} or /reject ${pending.id}.`;
    }
    if (directive.kind === 'inspect_group') {
      const signalChannel = channels.find((c) => c.name === 'signal') as
        | Channel
        | undefined;
      if (!signalChannel?.getGroups) {
        return 'Signal is not configured.';
      }
      const groups = await signalChannel.getGroups();
      if (!directive.groupName) {
        if (groups.length === 0) return 'You are not in any Signal groups.';
        const list = groups
          .map((g) => {
            const name = String(g.name || 'Unnamed');
            return `• ${name} (${g.members.length} members)`;
          })
          .join('\n');
        return `Signal groups (${groups.length}):\n${list}`;
      }
      const normalized = directive.groupName.toLowerCase().trim();
      const group = groups.find((g) => {
        const name = g.name.toLowerCase();
        return name === normalized || name.includes(normalized);
      });
      if (!group) {
        return `No Signal group found matching "${directive.groupName}".`;
      }
      const admins = Array.isArray((group as { admins?: string[] }).admins)
        ? ((group as { admins?: string[] }).admins as string[])
        : [];
      return `Group: ${group.name}\nMembers (${group.members.length}): ${group.members.join(', ')}\nAdmins: ${admins.join(', ')}`;
    }
    const pending = controlService.previewAction(
      'outbound.delete',
      {
        channel: directive.channel,
        target: directive.target,
        reason: directive.reason,
      },
      agentContext,
      { chatJid: sourceChatJid },
    );
    return `Confirmation required before deleting ${directive.channel} item "${directive.target}".\nPending ID: ${pending.id}\nReply naturally to approve, reject, or request changes. You can also use /approve ${pending.id} or /reject ${pending.id}.`;
  };

  const controlCommandParser = new SignalControlCommandParser({
    service: controlService,
    sendMessage: (jid, text) =>
      sendHostMessage(jid, text, { bypassPause: true }),
    registeredGroups: () => registeredGroups,
  });

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopContainerReaper();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const storeInboundMessage = async (
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> => {
    // Sender allowlist drop mode: discard messages from denied senders before storing
    if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
      const cfg = loadSenderAllowlist();
      if (
        shouldDropMessage(chatJid, cfg) &&
        !isSenderAllowed(chatJid, msg.sender, cfg)
      ) {
        if (cfg.logDenied) {
          logger.debug(
            { chatJid, sender: msg.sender },
            'sender-allowlist: dropping message (drop mode)',
          );
        }
        return;
      }
    }

    const sanitized = await sanitizeInboundMessage(msg);
    if (sanitized.blocked) {
      logger.warn(
        { chatJid, sender: msg.sender, reason: sanitized.reason },
        'Inbound message blocked by guard script',
      );
      return;
    }
    if (sanitized.reason) {
      logger.info(
        { chatJid, sender: msg.sender, reason: sanitized.reason },
        'Inbound message sanitized by guard script',
      );
    }
    storeMessage(sanitized.message);
  };

  const channelOpts = {
    onMessage: (incomingJid: string, msg: NewMessage) => {
      // Normalize Signal DM JIDs: if a UUID-based JID doesn't match any
      // registered group, re-route to the main group (same person, different
      // identifier format — Signal sometimes sends UUID instead of phone).
      let chatJid = incomingJid;
      if (
        chatJid.startsWith('signal:user:') &&
        !chatJid.startsWith('signal:user:+') &&
        !registeredGroups[chatJid]
      ) {
        const mainEntry = Object.entries(registeredGroups).find(
          ([jid, g]) => g.isMain && jid.startsWith('signal:user:+'),
        );
        if (mainEntry) {
          chatJid = mainEntry[0];
          msg = { ...msg, chat_jid: chatJid };
        }
      }

      // Auto-register unregistered chats so the agent can receive and respond.
      // This makes the agent accessible to anyone who messages the Signal account.
      // Security is enforced downstream: non-main groups cannot perform sensitive
      // actions (calendar writes, email) without controller approval.
      if (
        !registeredGroups[chatJid] &&
        !msg.is_from_me &&
        !msg.is_bot_message
      ) {
        const displayName =
          msg.sender_name && msg.sender_name !== msg.sender
            ? msg.sender_name
            : chatJid;
        const folder = deriveUniqueGroupFolder(
          displayName,
          Object.values(registeredGroups).map((g) => g.folder),
          inferGroupFolderHint(chatJid),
        );
        registerGroup(chatJid, {
          name: displayName,
          folder,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
        logger.info(
          { jid: chatJid, folder, displayName },
          'Auto-registered chat on first inbound message',
        );
      }

      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      if (trimmed.startsWith('/')) {
        controlCommandParser.handle(chatJid, msg).then(
          ({ handled }) => {
            if (handled) return;
            storeInboundMessage(chatJid, msg).catch((err) =>
              logger.error({ err, chatJid }, 'Inbound message guard error'),
            );
          },
          (err) =>
            logger.error({ err, chatJid }, 'Control command handling error'),
        );
        return;
      }

      // Natural approval replies only apply to the control chat (main group).
      // Non-main chats skip this entirely and go straight to storage.
      const isControlChat = registeredGroups[chatJid]?.isMain === true;
      if (isControlChat) {
        controlService
          .handleNaturalApprovalReply(chatJid, trimmed, {
            actorIdentity: msg.sender,
            source: 'signal_control',
          })
          .then(({ handled, message }) => {
            if (handled) {
              if (message) {
                sendHostMessage(chatJid, message, {
                  bypassPause: true,
                }).catch((err) =>
                  logger.error(
                    { err, chatJid },
                    'Natural approval response send failed',
                  ),
                );
              }
              return;
            }
            storeInboundMessage(chatJid, msg).catch((err) =>
              logger.error({ err, chatJid }, 'Inbound message guard error'),
            );
          })
          .catch((err) => {
            logger.error({ err, chatJid }, 'Natural approval handling error');
            // Still store the message even if approval handling fails
            storeInboundMessage(chatJid, msg).catch((storeErr) =>
              logger.error(
                { err: storeErr, chatJid },
                'Inbound message guard error after approval failure',
              ),
            );
          });
      } else {
        storeInboundMessage(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Inbound message guard error'),
        );
      }
      return;
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Ensure integration Docker services (signal-cli, etc.) are running before connecting channels.
  await ensureServicesRunning();

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    try {
      await channel.connect();
      channels.push(channel);
    } catch (err) {
      logger.error(
        { channel: channelName, err },
        'Channel failed to connect at startup',
      );
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  startAdminServer({ service: controlService });

  // Start integration health monitor and log pruner
  startHealthMonitor();
  startLogPruner();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: (jid, rawText) => sendHostMessage(jid, rawText),
  });
  const getChannelByName = (name: string): Channel | undefined =>
    channels.find((c) => c.name === name);
  const findLiveGroupByName = async (
    channelName: string,
    name: string,
  ): Promise<string | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const channel = getChannelByName(channelName);
    const group = await channel?.findGroupByName?.(trimmed);
    return group ? group.jid || group.id : null;
  };
  const findLiveGroupAcrossChannels = async (
    name: string,
    preferredChannelName?: string | null,
  ): Promise<{
    jid: string;
    channelName: string;
    displayName: string;
  } | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const candidateChannels = channels.filter(
      (channel) => channel.findGroupByName,
    );
    const orderedChannels = preferredChannelName
      ? [
          ...candidateChannels.filter(
            (channel) => channel.name === preferredChannelName,
          ),
          ...candidateChannels.filter(
            (channel) => channel.name !== preferredChannelName,
          ),
        ]
      : candidateChannels;
    const matches: Array<{
      channelName: string;
      jid: string;
      displayName: string;
    }> = [];
    for (const channel of orderedChannels) {
      const group = await channel.findGroupByName?.(trimmed);
      if (!group) continue;
      matches.push({
        channelName: channel.name,
        jid: group.jid || group.id,
        displayName: group.name,
      });
    }
    if (matches.length === 0) return null;
    if (preferredChannelName) {
      const preferredMatch = matches.find(
        (match) => match.channelName === preferredChannelName,
      );
      if (preferredMatch) return preferredMatch;
    }
    const uniqueJids = [...new Set(matches.map((match) => match.jid))];
    if (uniqueJids.length === 1) return matches[0];
    throw new Error(
      `Recipient "${name}" matches multiple live groups across channels.`,
    );
  };
  const inferSourceChannel = (sourceGroupFolder: string): string | null => {
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (group.folder !== sourceGroupFolder) continue;
      const channel = findChannel(channels, jid);
      if (channel?.name) return channel.name;
    }
    return null;
  };
  const resolveIpcRecipientForChannel = async (
    channelName: string,
    name: string,
  ): Promise<string> => {
    const trimmed = name.trim();
    const channel = getChannelByName(channelName);
    if (channel?.resolveRecipient) {
      return channel.resolveRecipient(trimmed);
    }
    if (channelName === 'whatsapp') {
      if (
        trimmed.endsWith('@s.whatsapp.net') ||
        trimmed.endsWith('@lid') ||
        trimmed.endsWith('@g.us')
      ) {
        return trimmed;
      }
      const digits = trimmed.replace(/[^\d]/g, '');
      if (digits.length >= 7) {
        return `${digits}@s.whatsapp.net`;
      }
      const target = await controlService.resolveOutboundTarget('sms', trimmed);
      const resolvedDigits = target.resolvedTarget.replace(/[^\d]/g, '');
      if (resolvedDigits.length < 7) {
        throw new Error(`Could not resolve WhatsApp recipient "${name}"`);
      }
      return `${resolvedDigits}@s.whatsapp.net`;
    }
    const target = await controlService.resolveOutboundTarget(
      'signal',
      trimmed,
    );
    return target.resolvedTarget;
  };
  const resolveIpcMessageRecipient = async (
    sourceGroupFolder: string,
    name: string,
  ): Promise<string> => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Recipient cannot be empty');
    const literalChannel = findChannel(channels, trimmed);
    if (literalChannel) {
      return trimmed;
    }

    const exactMatches = Object.entries(registeredGroups).filter(
      ([, group]) => group.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    const sourceChannel = inferSourceChannel(sourceGroupFolder);
    if (sourceChannel) {
      const sameChannelMatch = exactMatches.find(([jid]) => {
        const channel = findChannel(channels, jid);
        return channel?.name === sourceChannel;
      });
      if (sameChannelMatch) return sameChannelMatch[0];
    }
    if (exactMatches.length === 1) return exactMatches[0][0];
    if (exactMatches.length > 1) {
      throw new Error(
        `Recipient "${name}" matches multiple registered chats across channels.`,
      );
    }

    if (sourceChannel) {
      const liveGroupMatch = await findLiveGroupAcrossChannels(
        trimmed,
        sourceChannel,
      );
      if (liveGroupMatch) {
        const existingChat = getAllChats().find(
          (chat) =>
            chat.jid === liveGroupMatch.jid &&
            chat.name.trim().toLowerCase() ===
              liveGroupMatch.displayName.trim().toLowerCase(),
        );
        if (!existingChat) {
          throw new Error(
            `Recipient "${name}" resolved to an unverified ${liveGroupMatch.channelName} group (${liveGroupMatch.jid}). Ask the user to register or message that group first.`,
          );
        }
        return liveGroupMatch.jid;
      }
      return resolveIpcRecipientForChannel(sourceChannel, trimmed);
    }
    const crossChannelLiveGroupMatch =
      await findLiveGroupAcrossChannels(trimmed);
    if (crossChannelLiveGroupMatch) {
      const existingChat = getAllChats().find(
        (chat) =>
          chat.jid === crossChannelLiveGroupMatch.jid &&
          chat.name.trim().toLowerCase() ===
            crossChannelLiveGroupMatch.displayName.trim().toLowerCase(),
      );
      if (!existingChat) {
        throw new Error(
          `Recipient "${name}" resolved to an unverified ${crossChannelLiveGroupMatch.channelName} group (${crossChannelLiveGroupMatch.jid}). Ask the user to register or message that group first.`,
        );
      }
      return crossChannelLiveGroupMatch.jid;
    }
    return controlService
      .resolveOutboundTarget('signal', trimmed)
      .then((target) => target.resolvedTarget);
  };

  startIpcWatcher({
    sendMessage: (jid, text) => sendHostMessage(jid, text),
    channels: () => channels,
    resolveRecipient: async (name: string) => {
      const target = await controlService.resolveOutboundTarget('signal', name);
      return target.resolvedTarget;
    },
    resolveMessageRecipient: (sourceGroup, name) =>
      resolveIpcMessageRecipient(sourceGroup, name),
    resolveRecipientForChannel: async (channel, name: string) => {
      if (channel === 'signal' || channel === 'whatsapp') {
        return resolveIpcRecipientForChannel(channel, name);
      }
      const target = await controlService.resolveOutboundTarget(
        channel,
        name.trim(),
      );
      return target.resolvedTarget;
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    signalFindGroup: async (name) => {
      const ch = getChannelByName('signal');
      return ch?.findGroupByName ? ch.findGroupByName(name) : null;
    },
    signalAddMembers: async (groupId, members) => {
      const ch = getChannelByName('signal');
      if (!ch?.addMembers) throw new Error('Signal addMembers not available');
      await ch.addMembers(groupId, members);
    },
    signalCreateGroup: async (input) => {
      const ch = getChannelByName('signal');
      if (!ch?.createGroup) throw new Error('Signal createGroup not available');
      return ch.createGroup(input);
    },
    signalLeaveGroup: async (groupId) => {
      const ch = getChannelByName('signal');
      if (!ch?.leaveGroup) throw new Error('Signal leaveGroup not available');
      await ch.leaveGroup(groupId);
    },
    unregisterGroup: (jid) => {
      delete registeredGroups[jid];
      deleteRegisteredGroup(jid);
      logger.info({ jid }, 'Group unregistered');
    },
    signalListGroups: async () => {
      const ch = getChannelByName('signal');
      if (!ch?.getGroups) throw new Error('Signal getGroups not available');
      return ch.getGroups();
    },
    whatsappFindGroup: async (name) => {
      const ch = getChannelByName('whatsapp');
      return ch?.findGroupByName ? ch.findGroupByName(name) : null;
    },
    whatsappAddMembers: async (groupId, members) => {
      const ch = getChannelByName('whatsapp');
      if (!ch?.addMembers) throw new Error('WhatsApp addMembers not available');
      await ch.addMembers(groupId, members);
    },
    whatsappCreateGroup: async (input) => {
      const ch = getChannelByName('whatsapp');
      if (!ch?.createGroup)
        throw new Error('WhatsApp createGroup not available');
      return ch.createGroup(input);
    },
    whatsappLeaveGroup: async (groupId) => {
      const ch = getChannelByName('whatsapp');
      if (!ch?.leaveGroup) throw new Error('WhatsApp leaveGroup not available');
      await ch.leaveGroup(groupId);
    },
    whatsappListGroups: async () => {
      const ch = getChannelByName('whatsapp');
      if (!ch?.getGroups) throw new Error('WhatsApp getGroups not available');
      return ch.getGroups();
    },
    calendarListEvents: (params) => controlService.calendarListEvents(params),
    calendarCheckAvailability: (params) =>
      controlService.calendarCheckAvailability(params),
    calendarGetEvent: (params) => controlService.calendarGetEvent(params),
    calendarCreateEvent: (params) => controlService.calendarCreateEvent(params),
    calendarUpdateEvent: (params) => controlService.calendarUpdateEvent(params),
    calendarDeleteEvent: (params) => controlService.calendarDeleteEvent(params),
  });
  startSessionCleanup();
  startContainerReaper(() => queue.getActiveContainerNames());
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests.
// PM2 sets pm_exec_path to the real script; argv[1] is PM2's fork container.
// Use pathToFileURL for Windows backslash path compatibility.
import { pathToFileURL } from 'url';
const _scriptPath = process.env.pm_exec_path || process.argv[1];
const isDirectRun =
  Boolean(_scriptPath) &&
  pathToFileURL(_scriptPath!).pathname === new URL(import.meta.url).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
