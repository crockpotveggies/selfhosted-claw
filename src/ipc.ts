import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Dedup recent IPC messages — suppress identical (jid+text) within a short window. */
const DEDUP_WINDOW_MS = 30_000;
const recentIpcMessages = new Map<string, number>();

function isDuplicateIpcMessage(chatJid: string, text: string): boolean {
  const key = `${chatJid}\0${text}`;
  const now = Date.now();
  const prev = recentIpcMessages.get(key);
  if (prev && now - prev < DEDUP_WINDOW_MS) return true;
  recentIpcMessages.set(key, now);
  // Prune old entries periodically
  if (recentIpcMessages.size > 200) {
    for (const [k, ts] of recentIpcMessages) {
      if (now - ts > DEDUP_WINDOW_MS) recentIpcMessages.delete(k);
    }
  }
  return false;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  resolveRecipient: (name: string) => Promise<string>;
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
  signalListGroups?: () => Promise<
    { name: string; id: string; members: string[] }[]
  >;
}

/** Resolve a list of member identifiers (names, phone numbers, JIDs) to Signal-ready targets. */
async function resolveMembers(
  members: string[],
  resolveRecipient: (name: string) => Promise<string>,
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
      const jid = await resolveRecipient(trimmed);
      // Extract phone number from signal:user:+15551234567 format
      const phoneMatch = jid.match(/^signal:user:(\+\d+)$/);
      resolved.push(phoneMatch ? phoneMatch[1] : jid);
    } catch (err) {
      logger.warn(
        { member: trimmed, err: String(err) },
        'Failed to resolve member — skipping',
      );
    }
  }
  return resolved;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
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
                    chatJid = await deps.resolveRecipient(data.to);
                  } catch (err) {
                    logger.warn(
                      { to: data.to, sourceGroup, err: String(err) },
                      'IPC message recipient resolution failed',
                    );
                  }
                  // Fallback: try Signal group lookup via RPC if standard resolution failed
                  if (!chatJid && deps.signalFindGroup) {
                    try {
                      const group = await deps.signalFindGroup(data.to);
                      if (group) {
                        chatJid = `signal:group:${group.id}`;
                        logger.info(
                          { to: data.to, resolvedJid: chatJid },
                          'IPC message recipient resolved via Signal group RPC',
                        );
                      }
                    } catch (err) {
                      logger.warn(
                        { to: data.to, err: String(err) },
                        'Signal group RPC fallback failed',
                      );
                    }
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
                  if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    if (isDuplicateIpcMessage(chatJid, data.text)) {
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
              await processTaskIpc(data, sourceGroup, isMain, deps);
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
    // For signal_add_group_members / signal_create_group
    groupName?: string;
    members?: string[];
    title?: string;
    message?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
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
          data.members,
          deps.resolveRecipient,
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
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to list groups: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;

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
          data.members,
          deps.resolveRecipient,
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
        logger.info(
          { title: result.title, jid: result.jid, members: data.members },
          'Signal group created via IPC',
        );

        // Auto-register the new group so inbound messages get routed to the agent
        const groupJid = result.jid.startsWith('signal:group:')
          ? result.jid
          : `signal:group:${result.jid}`;
        deps.registerGroup(groupJid, {
          name: result.title,
          folder: sourceGroup,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
        logger.info(
          { jid: groupJid, folder: sourceGroup },
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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
