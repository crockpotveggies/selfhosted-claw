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
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  execFileSync(invocation.command, invocation.args, {
    stdio: 'inherit',
    windowsHide: true,
  });
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
