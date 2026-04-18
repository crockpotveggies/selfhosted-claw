import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  archiveLegacyControlPlaneState,
  getControlPlaneStatePaths,
  migrateControlPlaneState,
} from './control-plane-state.js';

export type ControlPlaneServiceAction =
  | 'install'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'logs'
  | 'cleanup-state';

export interface ControlPlaneServiceCommand {
  command: string;
  args: string[];
}

const COMPOSE_FILE = 'docker-compose.control-plane.yml';
const SERVICE_NAME = 'control-plane';
const RUNNER_CONTAINER_PREFIX = 'nanoclaw-';
const RUNNER_LOG_POLL_INTERVAL_MS = 2_000;
const RUNNER_IMAGE_NAME = 'nanoclaw-agent:latest';

export function ensureControlPlaneEnvFile(
  projectRoot: string = process.cwd(),
): string {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) return envPath;

  const examplePath = path.join(projectRoot, '.env.example');
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
  } else {
    fs.writeFileSync(envPath, '');
  }
  return envPath;
}

export function getControlPlaneServiceCommand(
  action: ControlPlaneServiceAction,
): ControlPlaneServiceCommand {
  const baseArgs = ['compose', '-f', COMPOSE_FILE];

  switch (action) {
    case 'install':
      return {
        command: 'docker',
        args: [...baseArgs, 'build', SERVICE_NAME],
      };
    case 'start':
      return {
        command: 'docker',
        args: [...baseArgs, 'up', '-d', '--build', SERVICE_NAME],
      };
    case 'stop':
      return {
        command: 'docker',
        args: [...baseArgs, 'stop', SERVICE_NAME],
      };
    case 'restart':
      return {
        command: 'docker',
        args: [...baseArgs, 'up', '-d', '--build', SERVICE_NAME],
      };
    case 'status':
      return {
        command: 'docker',
        args: [...baseArgs, 'ps', SERVICE_NAME],
      };
    case 'logs':
      return {
        command: 'docker',
        args: [...baseArgs, 'logs', '-f', SERVICE_NAME],
      };
    case 'cleanup-state':
      return {
        command: 'docker',
        args: [...baseArgs, 'ps', SERVICE_NAME],
      };
  }
}

export function getRunnerImageBuildCommand(): ControlPlaneServiceCommand {
  return {
    command: 'docker',
    args: ['build', '-t', RUNNER_IMAGE_NAME, '.'],
  };
}

export function getRunnerListCommand(): ControlPlaneServiceCommand {
  return {
    command: 'docker',
    args: [
      'ps',
      '--filter',
      `name=${RUNNER_CONTAINER_PREFIX}`,
      '--format',
      '{{.Names}}',
    ],
  };
}

export function parseRunnerContainerNames(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RUNNER_CONTAINER_PREFIX));
}

export function getRunnerStopCommand(
  containerNames: string[],
): ControlPlaneServiceCommand | null {
  if (containerNames.length === 0) return null;
  return {
    command: 'docker',
    args: ['stop', ...containerNames],
  };
}

export function getRunnerLogCommand(
  containerName: string,
): ControlPlaneServiceCommand {
  return {
    command: 'docker',
    args: ['logs', '-f', '--tail', '100', containerName],
  };
}

function pipePrefixedStream(
  stream: NodeJS.ReadableStream | null,
  target: NodeJS.WriteStream,
  prefix: string,
): void {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      target.write(`${prefix}${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffer) {
      target.write(`${prefix}${buffer}\n`);
      buffer = '';
    }
  });
}

function listRunnerContainers(): string[] {
  const listCommand = getRunnerListCommand();
  const output = execFileSync(listCommand.command, listCommand.args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return parseRunnerContainerNames(output);
}

function stopRunnerContainers(): void {
  const runnerNames = listRunnerContainers();
  const stopCommand = getRunnerStopCommand(runnerNames);
  if (!stopCommand) return;

  execFileSync(stopCommand.command, stopCommand.args, {
    stdio: 'inherit',
    windowsHide: true,
  });
}

function followLogs(): void {
  const composeLogs = getControlPlaneServiceCommand('logs');
  const children = new Map<string, ReturnType<typeof spawn>>();
  let shuttingDown = false;
  let runnerPollTimer: ReturnType<typeof setInterval> | null = null;

  const stopAll = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (runnerPollTimer) {
      clearInterval(runnerPollTimer);
      runnerPollTimer = null;
    }
    for (const child of children.values()) {
      child.kill();
    }
    setTimeout(() => process.exit(0), 50);
  };

  const attachFollower = (label: string, command: ControlPlaneServiceCommand) => {
    if (children.has(label)) return;
    const child = spawn(command.command, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.set(label, child);
    pipePrefixedStream(child.stdout, process.stdout, `[${label}] `);
    pipePrefixedStream(child.stderr, process.stderr, `[${label}] `);
    child.on('exit', () => {
      children.delete(label);
      if (!shuttingDown && label === SERVICE_NAME) {
        stopAll();
        process.exit(0);
      }
    });
  };

  const refreshRunnerFollowers = () => {
    if (shuttingDown) return;
    let runnerNames: string[] = [];
    try {
      runnerNames = listRunnerContainers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[runner-discovery] ${message}\n`);
      return;
    }
    for (const runnerName of runnerNames) {
      attachFollower(runnerName, getRunnerLogCommand(runnerName));
    }
  };

  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  attachFollower(SERVICE_NAME, composeLogs);
  refreshRunnerFollowers();
  runnerPollTimer = setInterval(
    refreshRunnerFollowers,
    RUNNER_LOG_POLL_INTERVAL_MS,
  );
}

export function runControlPlaneServiceAction(
  action: ControlPlaneServiceAction,
): void {
  if (action === 'install' || action === 'start' || action === 'restart') {
    ensureControlPlaneEnvFile();
    const migration = migrateControlPlaneState(getControlPlaneStatePaths());
    if (
      migration.copiedFiles.length > 0 ||
      migration.createdDirs.length > 0
    ) {
      console.log(
        `Prepared control-plane state: copied ${migration.copiedFiles.length} files, created ${migration.createdDirs.length} directories.`,
      );
    }
    const runnerBuild = getRunnerImageBuildCommand();
    execFileSync(runnerBuild.command, runnerBuild.args, {
      cwd: path.join(process.cwd(), 'container'),
      stdio: 'inherit',
      windowsHide: true,
    });
  }
  if (action === 'cleanup-state') {
    const archived = archiveLegacyControlPlaneState(getControlPlaneStatePaths());
    console.log(
      `Archived legacy state: ${archived.archivedPaths.length} archived, ${archived.skippedPaths.length} skipped.`,
    );
    return;
  }

  const invocation = getControlPlaneServiceCommand(action);
  if (action === 'logs') {
    followLogs();
    return;
  }

  execFileSync(invocation.command, invocation.args, {
    stdio: 'inherit',
    windowsHide: true,
  });

  if (action === 'stop') {
    stopRunnerContainers();
  }
}

function main(): void {
  const action = process.argv[2] as ControlPlaneServiceAction | undefined;
  if (
    action !== 'install' &&
    action !== 'start' &&
    action !== 'stop' &&
    action !== 'restart' &&
    action !== 'status' &&
    action !== 'logs' &&
    action !== 'cleanup-state'
  ) {
    console.error(
      'Usage: tsx setup/control-plane-service.ts <install|start|stop|restart|status|logs|cleanup-state>',
    );
    process.exit(1);
  }
  runControlPlaneServiceAction(action);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  main();
}
