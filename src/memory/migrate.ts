/**
 * Migration script: converts existing AGENT.md files into the new memory system.
 *
 * Usage: npx tsx src/memory/migrate.ts
 *
 * For each group folder with an AGENT.md, creates:
 *   data/memory/group/{folder}/_core/identity.md
 *
 * The original AGENT.md is preserved. The agent-runner will use the new
 * memory system if /workspace/memory/ exists, falling back to AGENT.md.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function buildFrontmatter(source: string): string {
  const now = new Date().toISOString();
  return [
    '---',
    'tags: [identity, personality, migrated]',
    `created: ${now}`,
    `updated: ${now}`,
    'source: system',
    'confidence: high',
    '---',
  ].join('\n');
}

function migrate(): void {
  if (!fs.existsSync(GROUPS_DIR)) {
    console.log('No groups directory found. Nothing to migrate.');
    return;
  }

  const groupFolders = fs.readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let migrated = 0;
  let skipped = 0;

  for (const folder of groupFolders) {
    // Try AGENT.md, then CLAUDE.md
    let agentFile = path.join(GROUPS_DIR, folder, 'AGENT.md');
    if (!fs.existsSync(agentFile)) {
      agentFile = path.join(GROUPS_DIR, folder, 'CLAUDE.md');
    }
    if (!fs.existsSync(agentFile)) {
      skipped++;
      continue;
    }

    const content = fs.readFileSync(agentFile, 'utf-8').trim();
    if (!content) {
      skipped++;
      continue;
    }

    // Determine target directory
    const entityType = folder === 'global' ? 'global' : 'group';
    const targetDir =
      entityType === 'global'
        ? path.join(MEMORY_DIR, 'global', '_core')
        : path.join(MEMORY_DIR, 'group', folder, '_core');

    const targetFile = path.join(targetDir, 'identity.md');

    // Skip if already migrated
    if (fs.existsSync(targetFile)) {
      console.log(`  Skip ${folder}: already migrated`);
      skipped++;
      continue;
    }

    // Write memory file
    fs.mkdirSync(targetDir, { recursive: true });
    const fileContent = `${buildFrontmatter(folder)}\n\n${content}\n`;
    fs.writeFileSync(targetFile, fileContent, 'utf-8');

    console.log(`  Migrated ${folder}: ${agentFile} → ${targetFile}`);
    migrated++;
  }

  console.log(
    `\nMigration complete: ${migrated} migrated, ${skipped} skipped.`,
  );
  console.log(
    'Original AGENT.md files are preserved. The agent-runner will use the new memory system.',
  );
}

migrate();
