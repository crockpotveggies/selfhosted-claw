import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Must use a factory that doesn't reference outer variables (hoisting)
vi.mock('../config.js', () => {
  const p = require('path');
  const o = require('os');
  return {
    ADMIN_CONFIG_DIR: p.join(o.tmpdir(), 'nanoclaw-settings-test'),
  };
});

// Mock registry to return integration definitions
const mockDefs = new Map<
  string,
  {
    core: boolean;
    settings?: {
      defaults: Record<string, unknown>;
      validate?: (v: Record<string, unknown>) => Record<string, string> | null;
    };
  }
>();
vi.mock('./registry.js', () => ({
  getIntegration: (name: string) => mockDefs.get(name),
  registerChannel: vi.fn(),
}));

// Derive tmpDir from the same path the mock uses
const tmpDir = path.join(os.tmpdir(), 'nanoclaw-settings-test');

import {
  getIntegrationSettings,
  saveIntegrationSettings,
  getIntegrationGroupSettings,
  saveIntegrationGroupSettings,
  isIntegrationEnabled,
  setIntegrationEnabled,
} from './settings-store.js';

describe('Integration Settings Store', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    mockDefs.clear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no settings saved', () => {
    mockDefs.set('test', {
      core: false,
      settings: { defaults: { color: 'blue', count: 5 } },
    });
    const settings = getIntegrationSettings('test');
    expect(settings.color).toBe('blue');
    expect(settings.count).toBe(5);
  });

  it('merges saved settings with defaults', () => {
    mockDefs.set('test', {
      core: false,
      settings: { defaults: { color: 'blue', count: 5 } },
    });
    saveIntegrationSettings('test', { color: 'red' });
    const settings = getIntegrationSettings('test');
    expect(settings.color).toBe('red');
    expect(settings.count).toBe(5); // Default preserved
  });

  it('saves and reads round-trip', () => {
    mockDefs.set('test', { core: false });
    saveIntegrationSettings('test', { key: 'value', num: 42 });
    const settings = getIntegrationSettings('test');
    expect(settings.key).toBe('value');
    expect(settings.num).toBe(42);
  });

  it('group settings cascade from global', () => {
    mockDefs.set('test', {
      core: false,
      settings: { defaults: { color: 'blue', size: 'large' } },
    });
    saveIntegrationSettings('test', { color: 'red' });
    saveIntegrationGroupSettings('test', 'group-a', { size: 'small' });

    const groupSettings = getIntegrationGroupSettings('test', 'group-a');
    expect(groupSettings.color).toBe('red'); // From global
    expect(groupSettings.size).toBe('small'); // Group override
  });

  it('core integrations are always enabled', () => {
    mockDefs.set('signal', { core: true });
    expect(isIntegrationEnabled('signal')).toBe(true);
  });

  it('installable integrations default to disabled', () => {
    mockDefs.set('calendar', { core: false });
    expect(isIntegrationEnabled('calendar')).toBe(false);
  });

  it('setEnabled works for installable integrations', () => {
    mockDefs.set('calendar', { core: false });
    setIntegrationEnabled('calendar', true);
    expect(isIntegrationEnabled('calendar')).toBe(true);
    setIntegrationEnabled('calendar', false);
    expect(isIntegrationEnabled('calendar')).toBe(false);
  });

  it('setEnabled throws for core integrations', () => {
    mockDefs.set('signal', { core: true });
    expect(() => setIntegrationEnabled('signal', false)).toThrow(
      'Cannot disable core integration',
    );
  });

  it('validates settings via integration schema validator', () => {
    mockDefs.set('strict', {
      core: false,
      settings: {
        defaults: {},
        validate: (v) => {
          if (!v.name) return { name: 'required' };
          return null;
        },
      },
    });
    expect(() => saveIntegrationSettings('strict', { name: '' })).toThrow(
      'Validation failed',
    );
  });

  it('writes atomically via temp file', () => {
    mockDefs.set('test', { core: false });
    saveIntegrationSettings('test', { data: 'safe' });
    // The .tmp file should not exist after save
    const settingsDir = path.join(tmpDir, 'integrations', 'test');
    const tmpFile = path.join(settingsDir, 'settings.json.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
    // But the actual file should exist
    expect(fs.existsSync(path.join(settingsDir, 'settings.json'))).toBe(true);
  });
});
