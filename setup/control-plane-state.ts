import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ControlPlaneStatePaths {
  projectRoot: string;
  repoAdminConfigDir: string;
  repoAdminDataDir: string;
  repoDataDir: string;
  legacyAdminConfigDir: string;
  legacyAdminDataDir: string;
}

export interface ControlPlaneStateMigrationResult {
  copiedFiles: string[];
  skippedFiles: string[];
  createdDirs: string[];
}

export interface ControlPlaneStateArchiveResult {
  archivedPaths: string[];
  skippedPaths: string[];
}

export function getControlPlaneStatePaths(
  projectRoot: string = process.cwd(),
  homeDir: string = os.homedir(),
): ControlPlaneStatePaths {
  return {
    projectRoot,
    repoAdminConfigDir: path.join(projectRoot, 'admin-config'),
    repoAdminDataDir: path.join(projectRoot, 'admin-data'),
    repoDataDir: path.join(projectRoot, 'data'),
    legacyAdminConfigDir: path.join(homeDir, '.config', 'self-hosted-claw'),
    legacyAdminDataDir: path.join(homeDir, '.local', 'share', 'self-hosted-claw'),
  };
}

function ensureDir(dirPath: string, result: ControlPlaneStateMigrationResult): void {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
  result.createdDirs.push(dirPath);
}

function copyMissingRecursive(
  sourceDir: string,
  targetDir: string,
  result: ControlPlaneStateMigrationResult,
): void {
  if (!fs.existsSync(sourceDir)) return;
  ensureDir(targetDir, result);

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, targetPath, result);
      continue;
    }

    if (fs.existsSync(targetPath)) {
      result.skippedFiles.push(targetPath);
      continue;
    }

    ensureDir(path.dirname(targetPath), result);
    fs.copyFileSync(sourcePath, targetPath);
    result.copiedFiles.push(targetPath);
  }
}

export function migrateControlPlaneState(
  paths: ControlPlaneStatePaths = getControlPlaneStatePaths(),
): ControlPlaneStateMigrationResult {
  const result: ControlPlaneStateMigrationResult = {
    copiedFiles: [],
    skippedFiles: [],
    createdDirs: [],
  };

  ensureDir(paths.repoAdminConfigDir, result);
  ensureDir(paths.repoAdminDataDir, result);
  ensureDir(paths.repoDataDir, result);

  copyMissingRecursive(
    paths.legacyAdminConfigDir,
    paths.repoAdminConfigDir,
    result,
  );
  copyMissingRecursive(paths.legacyAdminDataDir, paths.repoAdminDataDir, result);

  copyMissingRecursive(
    path.join(paths.legacyAdminDataDir, 'signal-cli-managed'),
    path.join(paths.repoDataDir, 'signal-cli-managed'),
    result,
  );

  return result;
}

function nextArchivePath(sourcePath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  return `${sourcePath}.migrated-${timestamp}`;
}

export function archiveLegacyControlPlaneState(
  paths: ControlPlaneStatePaths = getControlPlaneStatePaths(),
): ControlPlaneStateArchiveResult {
  const result: ControlPlaneStateArchiveResult = {
    archivedPaths: [],
    skippedPaths: [],
  };

  for (const sourcePath of [
    paths.legacyAdminConfigDir,
    paths.legacyAdminDataDir,
  ]) {
    if (!fs.existsSync(sourcePath)) {
      result.skippedPaths.push(sourcePath);
      continue;
    }
    const archivedPath = nextArchivePath(sourcePath);
    fs.renameSync(sourcePath, archivedPath);
    result.archivedPaths.push(archivedPath);
  }

  return result;
}
