import fs from 'fs';
import path from 'path';

import { SkillRegistry } from './registry.js';
import type { SkillDefinition } from './types.js';

interface RawRegistryMetadata {
  skills: Array<Omit<SkillDefinition, 'description'>>;
}

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
} {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  const frontmatter = raw.slice(3, end).trim();
  const result: { name?: string; description?: string } = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const [key, ...rest] = line.split(':');
    if (!key || rest.length === 0) continue;
    const value = rest.join(':').trim();
    if (key.trim() === 'name') result.name = value;
    if (key.trim() === 'description') result.description = value;
  }
  return result;
}

export function loadSkillCatalog(
  projectRoot = process.cwd(),
  registryRelativePath = path.join('container', 'skills', 'registry.v2.json'),
): SkillRegistry {
  const registryPath = path.join(projectRoot, registryRelativePath);
  const skillsRoot = path.join(projectRoot, 'container', 'skills');
  const raw = JSON.parse(
    fs.readFileSync(registryPath, 'utf-8'),
  ) as RawRegistryMetadata;
  const registry = new SkillRegistry();

  for (const entry of raw.skills) {
    const skillDir = path.join(skillsRoot, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const frontmatter = fs.existsSync(skillFile)
      ? parseFrontmatter(fs.readFileSync(skillFile, 'utf-8'))
      : {};

    registry.register({
      ...entry,
      name: frontmatter.name || entry.name,
      description: frontmatter.description || `${entry.name} skill`,
    });
  }

  return registry;
}
