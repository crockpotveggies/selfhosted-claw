/**
 * FileSystemMemoryProvider — default memory backend.
 *
 * Stores memories as .md files with YAML frontmatter in:
 *   data/memory/{entity-type}/{id}/{integration}/*.md
 *
 * Index is maintained in data/memory/index.json for fast tag lookups,
 * updated on every store() call. search() also scans filesystem for
 * text queries to stay up-to-date.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import type {
  MemoryEntry,
  MemoryQuery,
  MemoryResult,
  MemoryIndex,
  MemoryProvider,
} from './types.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const INDEX_PATH = path.join(MEMORY_DIR, 'index.json');

// ---------------------------------------------------------------------------
// YAML frontmatter helpers
// ---------------------------------------------------------------------------

function buildFrontmatter(entry: MemoryEntry): string {
  const now = new Date().toISOString();
  const lines = [
    '---',
    `tags: [${entry.tags.join(', ')}]`,
    `created: ${now}`,
    `updated: ${now}`,
    `source: ${entry.source}`,
    `confidence: ${entry.confidence}`,
    '---',
  ];
  return lines.join('\n');
}

function parseFrontmatter(raw: string): {
  tags: string[];
  created: string;
  updated: string;
  source: string;
  confidence: string;
  content: string;
} {
  const defaults = {
    tags: [] as string[],
    created: '',
    updated: '',
    source: 'agent',
    confidence: 'medium',
    content: raw,
  };

  if (!raw.startsWith('---')) return defaults;
  const endIdx = raw.indexOf('---', 3);
  if (endIdx === -1) return defaults;

  const frontmatter = raw.slice(3, endIdx);
  const content = raw.slice(endIdx + 3).trim();

  let tags: string[] = [];
  let created = '';
  let updated = '';
  let source = 'agent';
  let confidence = 'medium';

  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case 'tags': {
        const tagMatch = value.match(/\[(.+)]/);
        if (tagMatch) {
          tags = tagMatch[1].split(',').map((t) => t.trim()).filter(Boolean);
        }
        break;
      }
      case 'created':
        created = value.trim();
        break;
      case 'updated':
        updated = value.trim();
        break;
      case 'source':
        source = value.trim();
        break;
      case 'confidence':
        confidence = value.trim();
        break;
    }
  }

  return { tags, created, updated, source, confidence, content };
}

// ---------------------------------------------------------------------------
// File path resolution
// ---------------------------------------------------------------------------

function entityToPath(entity: string): string {
  if (entity === 'global') return path.join(MEMORY_DIR, 'global');
  if (entity.startsWith('person:')) {
    const id = entity.slice('person:'.length);
    return path.join(MEMORY_DIR, 'person', id);
  }
  if (entity.startsWith('group:')) {
    const folder = entity.slice('group:'.length);
    return path.join(MEMORY_DIR, 'group', folder);
  }
  return path.join(MEMORY_DIR, 'global');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function generateFilename(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  const slug = slugify(firstLine) || 'memory';
  return `${slug}.md`;
}

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

function readIndex(): MemoryIndex {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')) as MemoryIndex;
  } catch {
    return { entries: [] };
  }
}

function writeIndex(index: MemoryIndex): void {
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  const tmpPath = `${INDEX_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2));
  fs.renameSync(tmpPath, INDEX_PATH);
}

function addToIndex(
  relativePath: string,
  entity: string,
  integration: string,
  tags: string[],
): void {
  const index = readIndex();
  // Remove existing entry for same file
  index.entries = index.entries.filter((e) => e.file !== relativePath);
  index.entries.push({ file: relativePath, entity, integration, tags });
  writeIndex(index);
}

function removeFromIndex(relativePath: string): void {
  const index = readIndex();
  index.entries = index.entries.filter((e) => e.file !== relativePath);
  writeIndex(index);
}

// ---------------------------------------------------------------------------
// Scan filesystem for memories
// ---------------------------------------------------------------------------

function scanDirectory(
  dirPath: string,
  baseDir: string,
): MemoryResult[] {
  const results: MemoryResult[] = [];
  if (!fs.existsSync(dirPath)) return results;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          const raw = fs.readFileSync(fullPath, 'utf-8');
          const parsed = parseFrontmatter(raw);
          const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

          // Derive entity and integration from path
          const parts = relativePath.split('/');
          let entity = 'global';
          let integration = '_core';
          if (parts[0] === 'global') {
            entity = 'global';
            integration = parts[1] || '_core';
          } else if (parts[0] === 'person') {
            entity = `person:${parts[1]}`;
            integration = parts[2] || '_core';
          } else if (parts[0] === 'group') {
            entity = `group:${parts[1]}`;
            integration = parts[2] || '_core';
          }

          results.push({
            file: relativePath,
            entity,
            integration,
            tags: parsed.tags,
            content: parsed.content,
            confidence: parsed.confidence,
            source: parsed.source,
            created: parsed.created,
            updated: parsed.updated,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  };

  walk(dirPath);
  return results;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class FileSystemMemoryProvider implements MemoryProvider {
  async search(query: MemoryQuery): Promise<MemoryResult[]> {
    let results: MemoryResult[];

    // If tag-only query, use index for speed
    if (query.tags && !query.text && !query.entity && !query.integration) {
      const index = readIndex();
      const matchingFiles = index.entries.filter((e) =>
        query.tags!.every((t) => e.tags.includes(t)),
      );
      results = [];
      for (const entry of matchingFiles) {
        const fullPath = path.join(MEMORY_DIR, entry.file);
        if (!fs.existsSync(fullPath)) continue;
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        results.push({
          file: entry.file,
          entity: entry.entity,
          integration: entry.integration,
          tags: parsed.tags,
          content: parsed.content,
          confidence: parsed.confidence,
          source: parsed.source,
          created: parsed.created,
          updated: parsed.updated,
        });
      }
    } else {
      // Full scan
      results = scanDirectory(MEMORY_DIR, MEMORY_DIR);
    }

    // Apply filters
    if (query.entity) {
      results = results.filter((r) => r.entity === query.entity);
    }
    if (query.integration) {
      results = results.filter((r) => r.integration === query.integration);
    }
    if (query.tags) {
      results = results.filter((r) =>
        query.tags!.every((t) => r.tags.includes(t)),
      );
    }
    if (query.text) {
      const lower = query.text.toLowerCase();
      results = results.filter(
        (r) =>
          r.content.toLowerCase().includes(lower) ||
          r.tags.some((t) => t.toLowerCase().includes(lower)),
      );
    }

    // Sort by updated desc
    results.sort(
      (a, b) =>
        new Date(b.updated || b.created).getTime() -
        new Date(a.updated || a.created).getTime(),
    );

    return results;
  }

  async store(entry: MemoryEntry): Promise<string> {
    const entityDir = entityToPath(entry.entity);
    const integrationDir = path.join(entityDir, entry.integration);
    fs.mkdirSync(integrationDir, { recursive: true });

    const filename = entry.file || generateFilename(entry.content);
    const fullPath = path.join(integrationDir, filename);
    const relativePath = path.relative(MEMORY_DIR, fullPath).replace(/\\/g, '/');

    // If file exists, update the 'updated' timestamp
    const frontmatter = buildFrontmatter(entry);
    const fileContent = `${frontmatter}\n\n${entry.content}\n`;
    fs.writeFileSync(fullPath, fileContent, 'utf-8');

    // Update index
    addToIndex(relativePath, entry.entity, entry.integration, entry.tags);

    logger.debug(
      { file: relativePath, entity: entry.entity, integration: entry.integration },
      'Memory stored',
    );

    return relativePath;
  }

  async forget(id: string): Promise<void> {
    const fullPath = path.join(MEMORY_DIR, id);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      removeFromIndex(id);
      logger.debug({ file: id }, 'Memory forgotten');
    }
  }

  async getContext(
    groupFolder: string,
    budgets: Map<string, number>,
  ): Promise<string> {
    const sections: string[] = [];

    for (const [integration, budget] of budgets) {
      // Collect memories relevant to this group + integration
      const results = await this.search({ integration });

      // Filter to memories accessible by this group:
      // - global memories
      // - this group's memories
      // - person memories (all, since we don't know members here)
      const relevant = results.filter(
        (r) =>
          r.entity === 'global' ||
          r.entity === `group:${groupFolder}` ||
          r.entity.startsWith('person:'),
      );

      if (relevant.length === 0) continue;

      // Build content within budget
      let chars = 0;
      const lines: string[] = [];
      for (const r of relevant) {
        const line = r.content.trim();
        if (chars + line.length > budget) break;
        lines.push(line);
        chars += line.length;
      }

      if (lines.length > 0) {
        const label = integration === '_core' ? 'Core' : integration;
        sections.push(`### ${label}\n${lines.join('\n')}`);
      }
    }

    if (sections.length === 0) return '';
    return `## Active Memory\n\n${sections.join('\n\n')}`;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let provider: MemoryProvider | null = null;

export function getMemoryProvider(): MemoryProvider {
  if (!provider) {
    provider = new FileSystemMemoryProvider();
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Mount helpers (called by container-runner)
// ---------------------------------------------------------------------------

export interface MemoryMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function buildMemoryMounts(
  groupFolder: string,
  groupMembers: string[],
): MemoryMount[] {
  const mounts: MemoryMount[] = [];

  // Global memory (read-only)
  const globalDir = path.join(MEMORY_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/memory/global',
      readonly: true,
    });
  }

  // Group memory (read-write)
  const groupDir = path.join(MEMORY_DIR, 'group', groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  mounts.push({
    hostPath: groupDir,
    containerPath: '/workspace/memory/group',
    readonly: false,
  });

  // Person memories for group members (read-write)
  for (const member of groupMembers) {
    const personDir = path.join(MEMORY_DIR, 'person', member);
    if (fs.existsSync(personDir)) {
      mounts.push({
        hostPath: personDir,
        containerPath: `/workspace/memory/people/${member}`,
        readonly: false,
      });
    }
  }

  return mounts;
}

/**
 * Build the memory index for a specific group's container.
 * Written to IPC before container start.
 */
export function buildMemoryIndex(
  groupFolder: string,
  groupMembers: string[],
): MemoryIndex {
  const index = readIndex();

  // Filter to entries visible to this group
  const visible = index.entries.filter((e) => {
    if (e.entity === 'global') return true;
    if (e.entity === `group:${groupFolder}`) return true;
    if (e.entity.startsWith('person:')) {
      const personId = e.entity.slice('person:'.length);
      return groupMembers.includes(personId);
    }
    return false;
  });

  return { entries: visible };
}
