import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  CONTROL_SIGNAL_JID,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAllChats,
  getRecentMessages,
  getTaskById,
  updateTask,
} from './db.js';
import { deriveGroupFolder, isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { getIntegration } from './integrations/registry.js';
import { getIntegrationSettings } from './integrations/settings-store.js';
import { RegisteredGroup } from './types.js';

/**
 * Dedup recent agent-originated outbound messages — suppress identical
 * (jid+text) within a short window. Shared across IPC tool sends (e.g.
 * notify_controller) and the final-text response path in handleAgentOutput,
 * so a tool send followed by an echoed final text response is collapsed.
 */
const DEDUP_WINDOW_MS = 30_000;
const recentOutboundMessages = new Map<string, number>();

export function isDuplicateAgentOutbound(
  chatJid: string,
  text: string,
): boolean {
  const key = `${chatJid}\0${text}`;
  const now = Date.now();
  const prev = recentOutboundMessages.get(key);
  if (prev && now - prev < DEDUP_WINDOW_MS) return true;
  recentOutboundMessages.set(key, now);
  if (recentOutboundMessages.size > 200) {
    for (const [k, ts] of recentOutboundMessages) {
      if (now - ts > DEDUP_WINDOW_MS) recentOutboundMessages.delete(k);
    }
  }
  return false;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  resolveRecipient: (name: string) => Promise<string>;
  resolveMessageRecipient?: (
    sourceGroup: string,
    name: string,
  ) => Promise<string>;
  resolveRecipientForChannel?: (
    channel: 'signal' | 'whatsapp' | 'sms' | 'email',
    name: string,
  ) => Promise<string>;
  /** All connected channel instances (for integration tool dispatch). */
  channels?: () => import('./types.js').Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  signalFindGroup?: (
    name: string,
  ) => Promise<{ id: string; name: string; members: string[] } | null>;
  signalAddMembers?: (groupId: string, members: string[]) => Promise<void>;
  signalCreateGroup?: (input: {
    title: string;
    members: string[];
    message?: string;
  }) => Promise<{ jid: string; title: string }>;
  signalLeaveGroup?: (groupId: string) => Promise<void>;
  unregisterGroup?: (jid: string) => void;
  signalListGroups?: () => Promise<
    { name: string; id: string; members: string[] }[]
  >;
  whatsappFindGroup?: (
    name: string,
  ) => Promise<{ id: string; name: string; members: string[] } | null>;
  whatsappAddMembers?: (groupId: string, members: string[]) => Promise<void>;
  whatsappCreateGroup?: (input: {
    title: string;
    members: string[];
    message?: string;
  }) => Promise<{ jid: string; title: string }>;
  whatsappLeaveGroup?: (groupId: string) => Promise<void>;
  whatsappListGroups?: () => Promise<
    { name: string; id: string; members: string[] }[]
  >;
  calendarListEvents?: (params: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    maxResults: number;
    query?: string;
  }) => Promise<unknown>;
  calendarCheckAvailability?: (params: {
    timeMin: string;
    timeMax: string;
    calendarIds: string[];
  }) => Promise<unknown>;
  calendarGetEvent?: (params: {
    calendarId: string;
    eventId: string;
  }) => Promise<unknown>;
  calendarCreateEvent?: (params: {
    calendarId: string;
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
  }) => Promise<unknown>;
  calendarUpdateEvent?: (params: {
    calendarId: string;
    eventId: string;
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
  }) => Promise<unknown>;
  calendarDeleteEvent?: (params: {
    calendarId: string;
    eventId: string;
  }) => Promise<unknown>;
}

/** Resolve a list of member identifiers (names, phone numbers, JIDs) to Signal-ready targets. */
async function resolveMembers(
  channel: 'signal' | 'whatsapp' | 'sms' | 'email',
  members: string[],
  resolveRecipient: (
    channel: 'signal' | 'whatsapp' | 'sms' | 'email',
    name: string,
  ) => Promise<string>,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const member of members) {
    const trimmed = member.trim();
    if (!trimmed) continue;
    // Already a phone number or JID — pass through
    if (trimmed.startsWith('+') || trimmed.startsWith('signal:')) {
      resolved.push(trimmed);
      continue;
    }
    // Bare digits (e.g. "15551234567") — normalize with + prefix
    if (/^\d{7,15}$/.test(trimmed)) {
      resolved.push(`+${trimmed}`);
      continue;
    }
    // Name — resolve via contact resolution chain
    try {
      const jid = await resolveRecipient(channel, trimmed);
      if (channel === 'signal') {
        const phoneMatch = jid.match(/^signal:user:(\+\d+)$/);
        resolved.push(phoneMatch ? phoneMatch[1] : jid);
        continue;
      }
      resolved.push(jid);
    } catch (err) {
      logger.warn(
        { member: trimmed, channel, err: String(err) },
        'Failed to resolve member — skipping',
      );
    }
  }
  return resolved;
}

/** Write a response file for request-response IPC (calendar tools, etc.). */
function writeIpcResponse(
  sourceGroup: string,
  requestId: string,
  data: unknown,
): void {
  const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const filepath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${filepath}.tmp`;
  // Compact JSON — these files are consumed by the container runtime, not
  // read by humans on the hot path. Pretty-printing roughly doubles the
  // serialize cost for large calendar payloads.
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, filepath);
}

let ipcWatcherRunning = false;

/**
 * Track groups that have performed mutating IPC side effects (calendar writes,
 * group creation, sends, etc.) during the current container run.  The
 * orchestrator checks this before rolling back the message cursor so that
 * retries don't duplicate side effects.
 */
const groupsWithSideEffects = new Set<string>();

/** Mark a group as having performed a mutating IPC side effect. */
export function markIpcSideEffect(group: string): void {
  groupsWithSideEffects.add(group);
}

/** Check and clear the side-effect flag for a group. Returns true if
 *  the group performed at least one mutating action since the last clear. */
export function consumeIpcSideEffect(group: string): boolean {
  const had = groupsWithSideEffects.has(group);
  groupsWithSideEffects.delete(group);
  return had;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Watch-driven dirty flag: set true when fs.watch fires on any ipc subtree,
  // or when registration changes (new group). We still fall back to a slow
  // periodic sweep to recover from missed events (Docker volume + SMB quirks).
  let dirty = true;
  const markDirty = () => {
    dirty = true;
  };
  const watchedDirs = new Map<string, fs.FSWatcher>();
  const watchDir = (dir: string) => {
    if (watchedDirs.has(dir)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, { persistent: true }, markDirty);
      w.on('error', () => {
        watchedDirs.delete(dir);
      });
      watchedDirs.set(dir, w);
    } catch {
      /* watch failed — slow-path sweep will cover it */
    }
  };
  watchDir(ipcBaseDir);

  // Cached group folder list; refreshed when the base dir notifies us of a
  // change (or by the slow-path sweep).
  let cachedGroupFolders: string[] | null = null;
  const SLOW_SWEEP_INTERVAL = 15_000; // recover from missed watch events
  let lastSlowSweep = 0;

  const processIpcFiles = async () => {
    const now = Date.now();
    const slowSweep = now - lastSlowSweep >= SLOW_SWEEP_INTERVAL;
    if (!dirty && !slowSweep) {
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }
    dirty = false;
    if (slowSweep) lastSlowSweep = now;

    // Scan all group IPC directories (identity determined by directory).
    // withFileTypes avoids N stat() syscalls per tick.
    let groupFolders: string[];
    if (cachedGroupFolders && !slowSweep) {
      groupFolders = cachedGroupFolders;
    } else {
      try {
        groupFolders = fs
          .readdirSync(ipcBaseDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name !== 'errors')
          .map((d) => d.name);
        cachedGroupFolders = groupFolders;
        // Attach watches to each group's messages/ and tasks/ so future
        // writes trigger an immediate sweep instead of waiting for the tick.
        for (const folder of groupFolders) {
          watchDir(path.join(ipcBaseDir, folder, 'messages'));
          watchDir(path.join(ipcBaseDir, folder, 'tasks'));
        }
      } catch (err) {
        logger.error({ err }, 'Error reading IPC base directory');
        setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
        return;
      }
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain and folder→calendarAccess lookups from registered groups.
    // Calendar access is granted to main groups AND groups where the controller
    // triggered the current container session (flag file written by host).
    const folderIsMain = new Map<string, boolean>();
    const folderCalendarAccess = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) {
        folderIsMain.set(group.folder, true);
        folderCalendarAccess.set(group.folder, true);
      }
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      // Check for controller-access flag written by the host when spawning the container
      if (
        !folderCalendarAccess.has(sourceGroup) &&
        fs.existsSync(path.join(ipcBaseDir, sourceGroup, 'controller_access'))
      ) {
        folderCalendarAccess.set(sourceGroup, true);
      }
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.text) {
                // Resolve target: either an explicit chatJid or a "to" name to resolve
                let chatJid: string = data.chatJid || '';
                if (!chatJid && data.to) {
                  try {
                    chatJid = deps.resolveMessageRecipient
                      ? await deps.resolveMessageRecipient(sourceGroup, data.to)
                      : await deps.resolveRecipient(data.to);
                  } catch (err) {
                    logger.warn(
                      { to: data.to, sourceGroup, err: String(err) },
                      'IPC message recipient resolution failed',
                    );
                  }
                }
                if (!chatJid) {
                  logger.warn(
                    { sourceGroup, to: data.to },
                    'IPC message has no resolvable target',
                  );
                } else {
                  // Authorization: verify this group can send to this chatJid
                  const targetGroup = registeredGroups[chatJid];
                  const isControllerDm =
                    CONTROL_SIGNAL_JID && chatJid === CONTROL_SIGNAL_JID;
                  if (
                    isMain ||
                    isControllerDm ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    if (isDuplicateAgentOutbound(chatJid, data.text)) {
                      logger.warn(
                        { chatJid, sourceGroup },
                        'Duplicate IPC message suppressed',
                      );
                    } else {
                      await deps.sendMessage(chatJid, data.text);
                      logger.info({ chatJid, sourceGroup }, 'IPC message sent');
                    }
                  } else {
                    logger.warn(
                      { chatJid, sourceGroup },
                      'Unauthorized IPC message attempt blocked',
                    );
                  }
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              const hasCalendarAccess =
                folderCalendarAccess.get(sourceGroup) === true;
              await processTaskIpc(
                data,
                sourceGroup,
                isMain,
                deps,
                hasCalendarAccess,
              );
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For signal_* / whatsapp_* group operations
    groupName?: string;
    members?: string[];
    title?: string;
    message?: string;
    // For integration_tool dispatch
    integration?: string;
    tool?: string;
    args?: Record<string, unknown>;
    // For request-response IPC (calendar tools, etc.)
    requestId?: string;
    // For calendar tools
    calendarId?: string;
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
    query?: string;
    calendarIds?: string[];
    eventId?: string;
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
    // For chat history tools
    target?: string;
    limit?: number;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
  calendarAccess: boolean = isMain, // Defaults to isMain; set true when controller triggered
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        markIpcSideEffect(sourceGroup);
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'signal_add_group_members':
      if (!data.groupName || !data.members || data.members.length === 0) {
        logger.warn(
          { data },
          'Invalid signal_add_group_members request - missing groupName or members',
        );
        break;
      }
      if (!deps.signalFindGroup || !deps.signalAddMembers) {
        logger.warn(
          { sourceGroup },
          'signal_add_group_members: Signal channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'Signal is not configured — cannot add group members.',
          );
        }
        break;
      }
      try {
        const group = await deps.signalFindGroup(data.groupName);
        if (!group) {
          logger.warn(
            { groupName: data.groupName },
            'signal_add_group_members: group not found',
          );
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              `No Signal group found matching "${data.groupName}".`,
            );
          }
          break;
        }
        const resolvedAddMembers = await resolveMembers(
          'signal',
          data.members,
          deps.resolveRecipientForChannel ||
            (async (_channel, name) => deps.resolveRecipient(name)),
        );
        if (resolvedAddMembers.length === 0) {
          logger.warn(
            { members: data.members },
            'signal_add_group_members: no members resolved',
          );
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              `Could not resolve any of the specified members.`,
            );
          }
          break;
        }
        await deps.signalAddMembers(group.id, resolvedAddMembers);
        logger.info(
          { groupName: group.name, groupId: group.id, members: data.members },
          'Members added to Signal group via IPC',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Added ${data.members.length} member(s) to Signal group "${group.name}".`,
          );
        }
      } catch (err) {
        logger.error(
          { err, groupName: data.groupName },
          'Failed to add members to Signal group',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to add members to group "${data.groupName}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'signal_list_groups':
      if (!deps.signalListGroups) {
        if (data.requestId) {
          writeIpcResponse(sourceGroup, data.requestId, {
            error: 'Signal is not configured.',
          });
          break;
        }
        logger.warn(
          { sourceGroup },
          'signal_list_groups: Signal channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'Signal is not configured — cannot list groups.',
          );
        }
        break;
      }
      try {
        const groups = await deps.signalListGroups();
        if (data.requestId) {
          writeIpcResponse(sourceGroup, data.requestId, { groups });
          break;
        }
        const summary =
          groups.length === 0
            ? 'No Signal groups found.'
            : groups
                .map(
                  (g) =>
                    `• ${g.name} (${g.members.length} members: ${g.members.join(', ')})`,
                )
                .join('\n');
        if (data.chatJid) {
          await deps.sendMessage(data.chatJid, `Signal groups:\n${summary}`);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to list Signal groups');
        if (data.requestId) {
          writeIpcResponse(sourceGroup, data.requestId, {
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to list groups: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'signal_leave_group': {
      const groupName = String(data.groupName || '').trim();
      if (!groupName) {
        logger.warn(
          { data },
          'Invalid signal_leave_group request - missing groupName',
        );
        break;
      }
      if (!deps.signalFindGroup || !deps.signalLeaveGroup) {
        logger.warn(
          { sourceGroup },
          'signal_leave_group: Signal channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'Signal is not configured — cannot leave group.',
          );
        }
        break;
      }
      try {
        const group = await deps.signalFindGroup(groupName);
        if (!group) {
          logger.warn({ groupName }, 'signal_leave_group: group not found');
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              `No Signal group found matching "${groupName}".`,
            );
          }
          break;
        }
        await deps.signalLeaveGroup(group.id);
        markIpcSideEffect(sourceGroup);
        logger.info(
          { groupName: group.name, groupId: group.id },
          'Left Signal group via IPC',
        );

        // Unregister the group so NanoClaw stops polling for messages
        const groupJid = `signal:group:${group.id}`;
        if (deps.unregisterGroup) {
          deps.unregisterGroup(groupJid);
          logger.info({ jid: groupJid }, 'Unregistered group after leaving');
        }

        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Left Signal group "${group.name}".`,
          );
        }
      } catch (err) {
        logger.error({ err, groupName }, 'Failed to leave Signal group');
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to leave group "${groupName}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'signal_create_group':
      if (!data.title || !data.members || data.members.length === 0) {
        logger.warn(
          { data },
          'Invalid signal_create_group request - missing title or members',
        );
        break;
      }
      if (!deps.signalCreateGroup) {
        logger.warn(
          { sourceGroup },
          'signal_create_group: Signal channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'Signal is not configured — cannot create group.',
          );
        }
        break;
      }
      try {
        const resolvedCreateMembers = await resolveMembers(
          'signal',
          data.members,
          deps.resolveRecipientForChannel ||
            (async (_channel, name) => deps.resolveRecipient(name)),
        );
        if (resolvedCreateMembers.length === 0) {
          logger.warn(
            { members: data.members },
            'signal_create_group: no members resolved',
          );
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              `Could not resolve any of the specified members for group "${data.title}".`,
            );
          }
          break;
        }
        const result = await deps.signalCreateGroup({
          title: data.title,
          members: resolvedCreateMembers,
          message: data.message,
        });
        markIpcSideEffect(sourceGroup);
        logger.info(
          { title: result.title, jid: result.jid, members: data.members },
          'Signal group created via IPC',
        );

        // Auto-register the new group so inbound messages get routed to the agent.
        // Derive an isolated folder from the group title — do NOT reuse the
        // source group's folder, otherwise messages would land in the wrong context.
        const groupJid = result.jid.startsWith('signal:group:')
          ? result.jid
          : `signal:group:${result.jid}`;
        const newGroupFolder = deriveGroupFolder(result.title);
        deps.registerGroup(groupJid, {
          name: result.title,
          folder: newGroupFolder,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
        logger.info(
          { jid: groupJid, folder: newGroupFolder },
          'Auto-registered Signal group created via IPC',
        );

        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Created Signal group "${result.title}".`,
          );
        }
      } catch (err) {
        logger.error(
          { err, title: data.title },
          'Failed to create Signal group',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to create group "${data.title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'whatsapp_add_group_members':
      if (!data.groupName || !data.members || data.members.length === 0) {
        logger.warn(
          { data },
          'Invalid whatsapp_add_group_members request - missing groupName or members',
        );
        break;
      }
      if (
        !deps.whatsappFindGroup ||
        !deps.whatsappAddMembers ||
        !deps.resolveRecipientForChannel
      ) {
        logger.warn(
          { sourceGroup },
          'whatsapp_add_group_members: WhatsApp channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'WhatsApp is not configured — cannot add group members.',
          );
        }
        break;
      }
      try {
        const group = await deps.whatsappFindGroup(data.groupName);
        if (!group) {
          logger.warn(
            { groupName: data.groupName },
            'whatsapp_add_group_members: group not found',
          );
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              `No WhatsApp group found matching "${data.groupName}".`,
            );
          }
          break;
        }
        const resolvedAddMembers = await resolveMembers(
          'whatsapp',
          data.members,
          deps.resolveRecipientForChannel,
        );
        if (resolvedAddMembers.length === 0) {
          logger.warn(
            { members: data.members },
            'whatsapp_add_group_members: no members resolved',
          );
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              'Could not resolve any of the specified members.',
            );
          }
          break;
        }
        await deps.whatsappAddMembers(group.id, resolvedAddMembers);
        logger.info(
          { groupName: group.name, groupId: group.id, members: data.members },
          'Members added to WhatsApp group via IPC',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Added ${data.members.length} member(s) to WhatsApp group "${group.name}".`,
          );
        }
      } catch (err) {
        logger.error(
          { err, groupName: data.groupName },
          'Failed to add members to WhatsApp group',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to add members to group "${data.groupName}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'whatsapp_list_groups':
      if (!deps.whatsappListGroups) {
        if (data.requestId) {
          writeIpcResponse(sourceGroup, data.requestId, {
            error: 'WhatsApp is not configured.',
          });
          break;
        }
        logger.warn(
          { sourceGroup },
          'whatsapp_list_groups: WhatsApp channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'WhatsApp is not configured — cannot list groups.',
          );
        }
        break;
      }
      try {
        const groups = await deps.whatsappListGroups();
        if (data.requestId) {
          writeIpcResponse(sourceGroup, data.requestId, { groups });
          break;
        }
        const summary =
          groups.length === 0
            ? 'No WhatsApp groups found.'
            : groups
                .map(
                  (g) =>
                    `• ${g.name} (${g.members.length} members: ${g.members.join(', ')})`,
                )
                .join('\n');
        if (data.chatJid) {
          await deps.sendMessage(data.chatJid, `WhatsApp groups:\n${summary}`);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to list WhatsApp groups');
        if (data.requestId) {
          writeIpcResponse(sourceGroup, data.requestId, {
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to list groups: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    case 'whatsapp_leave_group': {
      const groupName = String(data.groupName || '').trim();
      if (!groupName) {
        logger.warn(
          { data },
          'Invalid whatsapp_leave_group request - missing groupName',
        );
        break;
      }
      if (!deps.whatsappFindGroup || !deps.whatsappLeaveGroup) {
        logger.warn(
          { sourceGroup },
          'whatsapp_leave_group: WhatsApp channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'WhatsApp is not configured — cannot leave group.',
          );
        }
        break;
      }
      try {
        const group = await deps.whatsappFindGroup(groupName);
        if (!group) {
          logger.warn({ groupName }, 'whatsapp_leave_group: group not found');
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              `No WhatsApp group found matching "${groupName}".`,
            );
          }
          break;
        }
        await deps.whatsappLeaveGroup(group.id);
        markIpcSideEffect(sourceGroup);
        logger.info(
          { groupName: group.name, groupId: group.id },
          'Left WhatsApp group via IPC',
        );
        if (deps.unregisterGroup) {
          deps.unregisterGroup(group.id);
          logger.info(
            { jid: group.id },
            'Unregistered WhatsApp group after leaving',
          );
        }
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Left WhatsApp group "${group.name}".`,
          );
        }
      } catch (err) {
        logger.error({ err, groupName }, 'Failed to leave WhatsApp group');
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to leave group "${groupName}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'whatsapp_create_group':
      if (!data.title || !data.members || data.members.length === 0) {
        logger.warn(
          { data },
          'Invalid whatsapp_create_group request - missing title or members',
        );
        break;
      }
      if (!deps.whatsappCreateGroup || !deps.resolveRecipientForChannel) {
        logger.warn(
          { sourceGroup },
          'whatsapp_create_group: WhatsApp channel not available',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'WhatsApp is not configured — cannot create group.',
          );
        }
        break;
      }
      try {
        const resolvedCreateMembers = await resolveMembers(
          'whatsapp',
          data.members,
          deps.resolveRecipientForChannel,
        );
        if (resolvedCreateMembers.length === 0) {
          logger.warn(
            { members: data.members },
            'whatsapp_create_group: no members resolved',
          );
          if (data.chatJid) {
            await deps.sendMessage(
              data.chatJid,
              `Could not resolve any of the specified members for group "${data.title}".`,
            );
          }
          break;
        }
        const result = await deps.whatsappCreateGroup({
          title: data.title,
          members: resolvedCreateMembers,
          message: data.message,
        });
        markIpcSideEffect(sourceGroup);
        logger.info(
          { title: result.title, jid: result.jid, members: data.members },
          'WhatsApp group created via IPC',
        );

        const newGroupFolder = deriveGroupFolder(result.title);
        deps.registerGroup(result.jid, {
          name: result.title,
          folder: newGroupFolder,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
        logger.info(
          { jid: result.jid, folder: newGroupFolder },
          'Auto-registered WhatsApp group created via IPC',
        );

        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Created WhatsApp group "${result.title}".`,
          );
        }
      } catch (err) {
        logger.error(
          { err, title: data.title },
          'Failed to create WhatsApp group',
        );
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to create group "${data.title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

    // ── Google Calendar tools (request-response IPC) ──────────────
    case 'calendar_list_events': {
      if (!data.requestId) break;
      if (!deps.calendarListEvents) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Google Calendar is not configured.',
        });
        break;
      }
      try {
        const result = (await deps.calendarListEvents({
          calendarId: data.calendarId || 'primary',
          timeMin: data.timeMin || '',
          timeMax: data.timeMax || '',
          maxResults: data.maxResults || 25,
          query: data.query,
        })) as {
          items?: {
            start?: unknown;
            end?: unknown;
            summary?: string;
            status?: string;
          }[];
        };
        // Privacy: groups without calendar access only see free/busy, not event details
        if (!calendarAccess && result && Array.isArray(result.items)) {
          result.items = result.items.map((item) => ({
            start: item.start,
            end: item.end,
            status: item.status || 'confirmed',
            summary: '(busy)',
          }));
        }
        writeIpcResponse(sourceGroup, data.requestId, result);
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'calendar_check_availability': {
      if (!data.requestId) break;
      if (!deps.calendarCheckAvailability) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Google Calendar is not configured.',
        });
        break;
      }
      try {
        const result = await deps.calendarCheckAvailability({
          timeMin: data.timeMin || '',
          timeMax: data.timeMax || '',
          calendarIds: data.calendarIds || ['primary'],
        });
        writeIpcResponse(sourceGroup, data.requestId, result);
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'calendar_get_event': {
      if (!data.requestId) break;
      if (!calendarAccess) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error:
            'Calendar event details are only available from the control chat.',
        });
        break;
      }
      if (!deps.calendarGetEvent) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Google Calendar is not configured.',
        });
        break;
      }
      try {
        const result = await deps.calendarGetEvent({
          calendarId: data.calendarId || 'primary',
          eventId: data.eventId || '',
        });
        writeIpcResponse(sourceGroup, data.requestId, result);
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'calendar_create_event': {
      if (!data.requestId) break;
      if (!calendarAccess) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Calendar events can only be created from the control chat.',
        });
        logger.warn(
          { sourceGroup },
          'Unauthorized calendar_create_event attempt blocked',
        );
        break;
      }
      if (!deps.calendarCreateEvent) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Google Calendar is not configured.',
        });
        break;
      }
      try {
        const result = await deps.calendarCreateEvent({
          calendarId: data.calendarId || 'primary',
          summary: data.summary || '',
          start: data.start || '',
          end: data.end || '',
          description: data.description,
          location: data.location,
          attendees: data.attendees,
        });
        writeIpcResponse(sourceGroup, data.requestId, result);
        markIpcSideEffect(sourceGroup);
        logger.info(
          { summary: data.summary, sourceGroup },
          'Calendar event created via IPC',
        );
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'calendar_update_event': {
      if (!data.requestId) break;
      if (!calendarAccess) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Calendar events can only be modified from the control chat.',
        });
        logger.warn(
          { sourceGroup },
          'Unauthorized calendar_update_event attempt blocked',
        );
        break;
      }
      if (!deps.calendarUpdateEvent) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Google Calendar is not configured.',
        });
        break;
      }
      try {
        const result = await deps.calendarUpdateEvent({
          calendarId: data.calendarId || 'primary',
          eventId: data.eventId || '',
          summary: data.summary,
          start: data.start,
          end: data.end,
          description: data.description,
          location: data.location,
          attendees: data.attendees,
        });
        writeIpcResponse(sourceGroup, data.requestId, result);
        markIpcSideEffect(sourceGroup);
        logger.info(
          { eventId: data.eventId, sourceGroup },
          'Calendar event updated via IPC',
        );
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'calendar_delete_event': {
      if (!data.requestId) break;
      if (!calendarAccess) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Calendar events can only be deleted from the control chat.',
        });
        logger.warn(
          { sourceGroup },
          'Unauthorized calendar_delete_event attempt blocked',
        );
        break;
      }
      if (!deps.calendarDeleteEvent) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'Google Calendar is not configured.',
        });
        break;
      }
      try {
        const result = await deps.calendarDeleteEvent({
          calendarId: data.calendarId || 'primary',
          eventId: data.eventId || '',
        });
        writeIpcResponse(sourceGroup, data.requestId, result);
        markIpcSideEffect(sourceGroup);
        logger.info(
          { eventId: data.eventId, sourceGroup },
          'Calendar event deleted via IPC',
        );
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'integration_tool': {
      if (!data.requestId || !data.integration || !data.tool) {
        logger.warn(
          { type: data.type, integration: data.integration, tool: data.tool },
          'integration_tool missing required fields',
        );
        break;
      }
      const intDef = getIntegration(data.integration);
      const toolDef = intDef?.tools?.find((t) => t.name === data.tool);
      if (!toolDef?.execute) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: `Tool ${data.tool} not found on integration ${data.integration}`,
        });
        break;
      }
      try {
        const settings = getIntegrationSettings(data.integration);
        logger.info(
          {
            integration: data.integration,
            tool: data.tool,
            group_folder: sourceGroup,
          },
          `Integration tool called: ${data.tool}`,
        );
        const result = await toolDef.execute(data.args || {}, {
          settings,
          sourceGroup,
          isMain,
          calendarAccess,
          chatJid: data.chatJid,
          sendMessage: deps.sendMessage,
          resolveRecipient: deps.resolveRecipient,
          channels: deps.channels?.() || [],
        });
        writeIpcResponse(sourceGroup, data.requestId, {
          ok: true,
          result,
        });
        markIpcSideEffect(sourceGroup);
        logger.info(
          {
            integration: data.integration,
            tool: data.tool,
            group_folder: sourceGroup,
          },
          `Integration tool completed: ${data.tool}`,
        );
      } catch (err) {
        logger.error(
          {
            integration: data.integration,
            tool: data.tool,
            group_folder: sourceGroup,
            err: String(err),
          },
          `Integration tool failed: ${data.tool}`,
        );
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'list_chats': {
      if (!data.requestId) break;
      // Controller-only: only the main group (or an explicitly
      // controller-triggered session) can enumerate all chats.
      if (!isMain && !calendarAccess) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'list_chats is restricted to the controller.',
        });
        break;
      }
      try {
        const chats = getAllChats().slice(0, data.limit || 100);
        writeIpcResponse(sourceGroup, data.requestId, {
          chats: chats.map((c) => ({
            jid: c.jid,
            name: c.name,
            channel: c.channel,
            is_group: c.is_group,
            last_message_time: c.last_message_time,
          })),
        });
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'read_chat_history': {
      if (!data.requestId) break;
      if (!isMain && !calendarAccess) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: 'read_chat_history is restricted to the controller.',
        });
        break;
      }
      const target = (data.target || '').trim();
      if (!target) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error:
            'read_chat_history requires a target (chat JID, name, or phone).',
        });
        break;
      }
      try {
        let chatJid = target;
        const chats = getAllChats();
        const knownByJid = chats.find((c) => c.jid === target);
        if (!knownByJid) {
          const lower = target.toLowerCase();
          const byName = chats.find(
            (c) => (c.name || '').toLowerCase() === lower,
          );
          if (byName) {
            chatJid = byName.jid;
          } else {
            const partial = chats.find((c) =>
              (c.name || '').toLowerCase().includes(lower),
            );
            if (partial) {
              chatJid = partial.jid;
            } else {
              // Fall back to channel-specific recipient resolution (names
              // -> phone -> JID) for SMS/Signal/WhatsApp lookups.
              try {
                chatJid = await deps.resolveRecipient(target);
              } catch {
                writeIpcResponse(sourceGroup, data.requestId, {
                  error: `No chat matched "${target}".`,
                });
                break;
              }
            }
          }
        }
        const chatMeta = chats.find((c) => c.jid === chatJid);
        const messages = getRecentMessages(chatJid, data.limit || 25);
        writeIpcResponse(sourceGroup, data.requestId, {
          chatJid,
          name: chatMeta?.name,
          channel: chatMeta?.channel,
          messages: messages.map((m) => ({
            sender_name: m.sender_name || m.sender,
            is_from_me: m.is_from_me ? true : false,
            content: m.content,
            timestamp: m.timestamp,
          })),
        });
      } catch (err) {
        writeIpcResponse(sourceGroup, data.requestId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
