import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/**
 * Derive a valid group folder name from a display name.
 * Sanitizes to [A-Za-z0-9_-], lowercases, and truncates to 64 chars.
 */
export function deriveGroupFolder(displayName: string): string {
  let folder = displayName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  // Must start with alphanumeric
  folder = folder.replace(/^[^a-z0-9]+/, '');
  if (!folder || !isValidGroupFolder(folder)) {
    // Fallback: use a hash-based name
    const hash = Array.from(displayName).reduce(
      (acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0,
      0,
    );
    folder = `group-${Math.abs(hash).toString(36)}`;
  }
  return folder;
}

function sanitizeFolderHint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveUniqueGroupFolder(
  displayName: string,
  existingFolders: Iterable<string>,
  uniquenessHint?: string,
): string {
  const used = new Set(
    Array.from(existingFolders, (folder) => folder.trim().toLowerCase()),
  );
  const base = deriveGroupFolder(displayName);
  if (!used.has(base.toLowerCase())) return base;

  const hint = sanitizeFolderHint(uniquenessHint || '');
  if (hint) {
    const hinted = deriveGroupFolder(`${displayName}-${hint}`);
    if (!used.has(hinted.toLowerCase())) return hinted;
  }

  for (let i = 2; i <= 999; i++) {
    const candidate = deriveGroupFolder(`${displayName}-${hint || 'chat'}-${i}`);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  return deriveGroupFolder(
    `${displayName}-${hint || 'chat'}-${Date.now().toString(36)}`,
  );
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
