import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  archiveLegacyControlPlaneState,
  getControlPlaneStatePaths,
  migrateControlPlaneState,
} from './control-plane-state.js';

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

describe('control plane state migration', () => {
  it('copies legacy config/data into repo-mounted directories', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-project-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-home-'));
    const paths = getControlPlaneStatePaths(projectRoot, homeDir);

    writeFile(
      path.join(paths.legacyAdminConfigDir, 'contacts.json'),
      '{"contact":true}',
    );
    writeFile(
      path.join(paths.legacyAdminConfigDir, 'integrations', 'signal.json'),
      '{"enabled":true}',
    );
    writeFile(
      path.join(paths.legacyAdminDataDir, 'pending-actions.json'),
      '[]',
    );
    writeFile(
      path.join(paths.legacyAdminDataDir, 'signal-cli-managed', 'state.txt'),
      'linked',
    );

    const result = migrateControlPlaneState(paths);

    expect(
      fs.readFileSync(
        path.join(paths.repoAdminConfigDir, 'contacts.json'),
        'utf-8',
      ),
    ).toBe('{"contact":true}');
    expect(
      fs.readFileSync(
        path.join(paths.repoAdminConfigDir, 'integrations', 'signal.json'),
        'utf-8',
      ),
    ).toBe('{"enabled":true}');
    expect(
      fs.readFileSync(
        path.join(paths.repoAdminDataDir, 'pending-actions.json'),
        'utf-8',
      ),
    ).toBe('[]');
    expect(
      fs.readFileSync(
        path.join(paths.repoDataDir, 'signal-cli-managed', 'state.txt'),
        'utf-8',
      ),
    ).toBe('linked');
    expect(result.copiedFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('does not overwrite repo-owned state that already exists', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-project-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-home-'));
    const paths = getControlPlaneStatePaths(projectRoot, homeDir);

    writeFile(
      path.join(paths.legacyAdminConfigDir, 'contacts.json'),
      '{"legacy":true}',
    );
    writeFile(
      path.join(paths.repoAdminConfigDir, 'contacts.json'),
      '{"repo":true}',
    );

    const result = migrateControlPlaneState(paths);

    expect(
      fs.readFileSync(
        path.join(paths.repoAdminConfigDir, 'contacts.json'),
        'utf-8',
      ),
    ).toBe('{"repo":true}');
    expect(result.skippedFiles).toContain(
      path.join(paths.repoAdminConfigDir, 'contacts.json'),
    );
  });

  it('archives the legacy host directories after migration cleanup', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-project-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-home-'));
    const paths = getControlPlaneStatePaths(projectRoot, homeDir);

    writeFile(path.join(paths.legacyAdminConfigDir, 'contacts.json'), '{}');
    writeFile(path.join(paths.legacyAdminDataDir, 'audit-log.jsonl'), '');

    const result = archiveLegacyControlPlaneState(paths);

    expect(fs.existsSync(paths.legacyAdminConfigDir)).toBe(false);
    expect(fs.existsSync(paths.legacyAdminDataDir)).toBe(false);
    expect(result.archivedPaths).toHaveLength(2);
    expect(
      result.archivedPaths.some((item) => item.startsWith(paths.legacyAdminConfigDir)),
    ).toBe(true);
    expect(
      result.archivedPaths.some((item) => item.startsWith(paths.legacyAdminDataDir)),
    ).toBe(true);
  });
});
