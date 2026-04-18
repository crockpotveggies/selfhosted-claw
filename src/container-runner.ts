/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MOUNT_ROOT,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_CONTEXT_WINDOW,
  OPENAI_MAX_TOKENS,
  OPENAI_MODEL,
  OPENAI_TEMPERATURE,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { resolveHostPath } from './host-paths.js';
import { logger } from './logger.js';
import { buildSessionToolRegistrySnapshot } from './tool-registry.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  runtimeStateKey?: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  controlSignalJid?: string;
  /** True when the controller sent the message(s) that triggered this container. */
  controllerTriggered?: boolean;
  /** Folder name of the main (controller) group â€” mounted read-only so non-main groups can read controller notes/memory. */
  mainGroupFolder?: string;
  /** Calendar availability policy injected from admin settings. */
  calendarAvailability?: {
    timezone: string;
    windows: { days: number[]; startTime: string; endTime: string }[];
    notes: string;
  };
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function ensureWritableFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '');
  }
  try {
    fs.chmodSync(filePath, 0o666);
  } catch {
    // Best-effort on platforms/filesystems that ignore chmod (e.g. Windows bind mounts).
  }
}

function shouldMountCustomAgentRunnerSource(
  groupAgentRunnerDir: string,
): boolean {
  const customizationMarker = path.join(groupAgentRunnerDir, '.customized');
  return fs.existsSync(customizationMarker);
}

function syncControllerAccessFlag(
  groupFolder: string,
  isMain: boolean,
  controllerTriggered: boolean,
): void {
  if (isMain) return;
  const flagDir = resolveGroupIpcPath(groupFolder);
  const flagPath = path.join(flagDir, 'controller_access');
  if (controllerTriggered) {
    fs.mkdirSync(flagDir, { recursive: true });
    fs.writeFileSync(flagPath, '');
    return;
  }
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

export function resolveContainerOpenAIBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]'
    ) {
      parsed.hostname = 'host.docker.internal';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // If the URL is invalid, pass it through unchanged and let the agent surface the real error.
  }
  return baseUrl;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  runtimeStateKey: string,
  isMain: boolean,
  mainGroupFolder?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const mountRoot = MOUNT_ROOT;
  const hostProjectRoot = resolveHostPath(mountRoot);
  const groupDir = resolveGroupFolderPath(group.folder);
  const hostGroupDir = resolveHostPath(
    path.join(mountRoot, 'groups', group.folder),
  );

  if (isMain) {
    // We intentionally do NOT bind-mount the entire project root. Two
    // earlier attempts failed:
    //   1. project:ro + shadow .env via /dev/null → runc cannot create a
    //      mountpoint inside an already-RO parent bind.
    //   2. Pre-staging via fs.cpSync → the recursive synchronous copy ran
    //      on first message after restart and blocked the event loop,
    //      freezing the admin API and agent processing.
    //
    // The agent only needs a handful of subpaths (store, global, controller
    // notes, the group folder). Those are mounted individually below. Code
    // that referenced "/workspace/project/groups/global" falls back to
    // "/workspace/global" — see container/agent-runner/src/index.ts ~L496.
    //
    // Main still gets writable store at the legacy nested path. With no RO
    // parent bind, runc is free to create /workspace/project in the
    // container's writable rootfs and nest /workspace/project/store under
    // it without issue.
    void projectRoot;
    mounts.push({
      hostPath: resolveHostPath(path.join(mountRoot, 'store')),
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: hostGroupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
    // Other groups only get their own folder
    mounts.push({
      hostPath: hostGroupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: resolveHostPath(path.join(mountRoot, 'groups', 'global')),
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    // Controller notes: main group's folder mounted read-only so this group
    // can access facts the controller stored (e.g. contacts, addresses, preferences).
    if (mainGroupFolder && mainGroupFolder !== group.folder) {
      const mainDir = path.join(GROUPS_DIR, mainGroupFolder);
      if (fs.existsSync(mainDir)) {
        mounts.push({
          hostPath: resolveHostPath(
            path.join(mountRoot, 'groups', mainGroupFolder),
          ),
          containerPath: '/workspace/controller-notes',
          readonly: true,
        });
      }
    }
  }

  // Per-group runtime state (history, summaries, archives, ephemeral data).
  const groupRuntimeStateDir = path.join(DATA_DIR, 'sessions', runtimeStateKey);
  fs.mkdirSync(groupRuntimeStateDir, { recursive: true });
  try {
    fs.chmodSync(groupRuntimeStateDir, 0o777);
  } catch {
    // Best-effort on platforms/filesystems that ignore chmod.
  }
  const historyFile = path.join(groupRuntimeStateDir, 'history.jsonl');
  const summaryFile = path.join(groupRuntimeStateDir, 'summary.md');
  ensureWritableFile(historyFile);
  ensureWritableFile(summaryFile);
  mounts.push({
    hostPath: resolveHostPath(
      path.join(mountRoot, 'data', 'sessions', runtimeStateKey),
    ),
    containerPath: '/workspace/state',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'responses'), { recursive: true });
  mounts.push({
    hostPath: resolveHostPath(
      path.join(mountRoot, 'data', 'ipc', group.folder),
    ),
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  // Mount per-group runner source only when explicitly opted in.
  // Legacy session snapshots are often just stale copies of the default
  // runner, and mounting them forces an unnecessary checksum/recompile path
  // on every container start. Creating `agent-runner-src/.customized`
  // preserves the old override behavior for the rare group that truly needs it.
  if (shouldMountCustomAgentRunnerSource(groupAgentRunnerDir)) {
    mounts.push({
      hostPath: resolveHostPath(
        path.join(
          mountRoot,
          'data',
          'sessions',
          group.folder,
          'agent-runner-src',
        ),
      ),
      containerPath: '/app/src',
      readonly: false,
    });
  }

  // Container skills (read-only behavioral instructions loaded into system prompt)
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsDir)) {
    mounts.push({
      hostPath: resolveHostPath(path.join(mountRoot, 'container', 'skills')),
      containerPath: '/workspace/skills',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const containerOpenAIBaseUrl = resolveContainerOpenAIBaseUrl(OPENAI_BASE_URL);

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `OPENAI_BASE_URL=${containerOpenAIBaseUrl}`);
  args.push('-e', `OPENAI_MODEL=${OPENAI_MODEL}`);
  args.push('-e', `OPENAI_MAX_TOKENS=${OPENAI_MAX_TOKENS}`);
  args.push('-e', `OPENAI_TEMPERATURE=${OPENAI_TEMPERATURE}`);
  args.push('-e', `OPENAI_CONTEXT_WINDOW=${OPENAI_CONTEXT_WINDOW}`);
  if (OPENAI_API_KEY) {
    args.push('-e', `OPENAI_API_KEY=${OPENAI_API_KEY}`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  syncControllerAccessFlag(
    group.folder,
    input.isMain,
    input.controllerTriggered === true,
  );
  const runtimeStateKey = input.runtimeStateKey || group.folder;

  const mounts = buildVolumeMounts(
    group,
    runtimeStateKey,
    input.isMain,
    input.mainGroupFolder,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = await buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected â€” reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    // Cache the level check — avoids re-evaluating per data event. If debug
    // isn't enabled, we skip the per-line split/emit entirely, which otherwise
    // burns ~5–20ms per turn on a chatty SDK.
    const debugEnabled =
      typeof (logger as { isLevelEnabled?: (l: string) => boolean })
        .isLevelEnabled === 'function'
        ? (logger as { isLevelEnabled: (l: string) => boolean }).isLevelEnabled(
            'debug',
          )
        : (logger as { level?: string }).level === 'debug' ||
          (logger as { level?: string }).level === 'trace';

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (debugEnabled) {
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line) logger.debug({ container: group.folder }, line);
        }
      }
      // Don't reset timeout on stderr â€” SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only â€” not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      // Async write — log file is for post-hoc debugging, no caller waits on
      // it. Blocking here adds 10–50ms to every turn on the hot path.
      fs.writeFile(logFile, logLines.join('\n'), (err) => {
        if (err) {
          logger.warn(
            { logFile, err: String(err) },
            'Deferred container log write failed',
          );
        } else {
          logger.debug(
            { logFile, verbose: isVerbose },
            'Container log written',
          );
        }
      });

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * Write integration tools manifest for the container agent-runner.
 * Only includes host-side tools from enabled integrations.
 * The agent-runner reads this and registers dynamic IPC-backed tool stubs.
 */
export function writeIntegrationToolsManifest(
  groupFolder: string,
  isMain: boolean,
  controllerTriggered: boolean = false,
  options?: {
    scheduledTaskMode?: boolean;
  },
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const snapshot = buildSessionToolRegistrySnapshot({
    groupFolder,
    isMain,
    controllerTriggered,
    scheduledTaskMode: options?.scheduledTaskMode,
  });

  const manifestFile = path.join(groupIpcDir, 'integration_tools.json');
  fs.writeFileSync(
    manifestFile,
    JSON.stringify(snapshot.integrationManifest, null, 2),
  );

  const allowedToolsFile = path.join(groupIpcDir, 'allowed_tools.json');
  fs.writeFileSync(
    allowedToolsFile,
    JSON.stringify(
      {
        internal: isMain || controllerTriggered,
        allowedToolNames: snapshot.allowedToolNames,
      },
      null,
      2,
    ),
  );
}

export function refreshIntegrationToolsManifests(
  groups: Array<{ folder: string; isMain?: boolean }>,
): void {
  for (const group of groups) {
    writeIntegrationToolsManifest(group.folder, group.isMain === true);
  }
}
