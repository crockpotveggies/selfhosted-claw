import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock config to use temp directory
vi.mock('../config.js', () => {
  const p = require('path');
  const o = require('os');
  return {
    DATA_DIR: p.join(o.tmpdir(), 'nanoclaw-memory-test'),
  };
});

import { FileSystemMemoryProvider } from './filesystem-provider.js';
import type { MemoryEntry } from './types.js';

const tmpDir = path.join(os.tmpdir(), 'nanoclaw-memory-test');

describe('FileSystemMemoryProvider', () => {
  let provider: FileSystemMemoryProvider;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    provider = new FileSystemMemoryProvider();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores a memory and returns its path', async () => {
    const entry: MemoryEntry = {
      entity: 'person:justin',
      integration: 'calendar',
      tags: ['scheduling', 'preference'],
      content: 'Justin prefers morning meetings',
      confidence: 'high',
      source: 'agent',
    };

    const filePath = await provider.store(entry);
    expect(filePath).toContain('person/justin/calendar/');
    expect(filePath.endsWith('.md')).toBe(true);

    // File should exist on disk
    const fullPath = path.join(tmpDir, 'memory', filePath);
    expect(fs.existsSync(fullPath)).toBe(true);

    // Content should have frontmatter
    const raw = fs.readFileSync(fullPath, 'utf-8');
    expect(raw).toContain('tags: [scheduling, preference]');
    expect(raw).toContain('Justin prefers morning meetings');
  });

  it('searches by tags', async () => {
    await provider.store({
      entity: 'global',
      integration: '_core',
      tags: ['preference'],
      content: 'Memory A',
      confidence: 'high',
      source: 'agent',
    });
    await provider.store({
      entity: 'global',
      integration: '_core',
      tags: ['other'],
      content: 'Memory B',
      confidence: 'medium',
      source: 'agent',
    });

    const results = await provider.search({ tags: ['preference'] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Memory A');
  });

  it('searches by text content', async () => {
    await provider.store({
      entity: 'global',
      integration: '_core',
      tags: [],
      content: 'The sky is blue',
      confidence: 'high',
      source: 'agent',
    });
    await provider.store({
      entity: 'global',
      integration: '_core',
      tags: [],
      content: 'Grass is green',
      confidence: 'high',
      source: 'agent',
    });

    const results = await provider.search({ text: 'sky' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('The sky is blue');
  });

  it('searches by entity', async () => {
    await provider.store({
      entity: 'person:alice',
      integration: '_core',
      tags: [],
      content: 'About Alice',
      confidence: 'high',
      source: 'agent',
    });
    await provider.store({
      entity: 'person:bob',
      integration: '_core',
      tags: [],
      content: 'About Bob',
      confidence: 'high',
      source: 'agent',
    });

    const results = await provider.search({
      entity: 'person:alice',
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('About Alice');
  });

  it('searches by integration', async () => {
    await provider.store({
      entity: 'global',
      integration: 'calendar',
      tags: [],
      content: 'Calendar memory',
      confidence: 'high',
      source: 'agent',
    });
    await provider.store({
      entity: 'global',
      integration: 'slack',
      tags: [],
      content: 'Slack memory',
      confidence: 'high',
      source: 'agent',
    });

    const results = await provider.search({
      integration: 'calendar',
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Calendar memory');
  });

  it('forgets a memory', async () => {
    const filePath = await provider.store({
      entity: 'global',
      integration: '_core',
      tags: ['temp'],
      content: 'Temporary memory',
      confidence: 'low',
      source: 'agent',
    });

    await provider.forget(filePath);

    const fullPath = path.join(tmpDir, 'memory', filePath);
    expect(fs.existsSync(fullPath)).toBe(false);

    const results = await provider.search({ tags: ['temp'] });
    expect(results).toHaveLength(0);
  });

  it('uses custom filename when provided', async () => {
    const filePath = await provider.store({
      entity: 'group:team',
      integration: '_core',
      tags: [],
      content: 'Team info',
      confidence: 'high',
      source: 'admin',
      file: 'team-context.md',
    });

    expect(filePath).toContain('team-context.md');
  });

  it('getContext builds in-context memory within budget', async () => {
    await provider.store({
      entity: 'global',
      integration: 'calendar',
      tags: [],
      content: 'Default calendar is primary',
      confidence: 'high',
      source: 'system',
    });
    await provider.store({
      entity: 'group:team',
      integration: '_core',
      tags: [],
      content: 'This is the project team',
      confidence: 'high',
      source: 'agent',
    });

    const budgets = new Map([
      ['_core', 500],
      ['calendar', 300],
    ]);
    const context = await provider.getContext('team', budgets);

    expect(context).toContain('## Active Memory');
    expect(context).toContain('### calendar');
    expect(context).toContain('Default calendar is primary');
    expect(context).toContain('### Core');
    expect(context).toContain('This is the project team');
  });
});
