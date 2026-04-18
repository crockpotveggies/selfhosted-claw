import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  resolveProfile,
  syncPersonalityFiles,
} from './control-personality.js';
import type { PersonalityProfile } from './control-types.js';

describe('control personality', () => {
  it('lets main inherit global personality fields while preserving main role defaults', () => {
    const profiles: Record<string, PersonalityProfile> = {
      global: {
        scope: 'global',
        displayName: 'Lena',
        role: 'Personal assistant',
        tone: 'Calm and dry',
        communicationStyle: 'No emojis.',
        initiative: 'Be proactive.',
        aboutAgent: 'From Vancouver.',
        aboutController: 'Very mysterious.',
        customInstructions: 'Keep replies short.',
        updatedAt: new Date().toISOString(),
      },
    };

    const main = resolveProfile('main', profiles);
    expect(main.tone).toBe('Calm and dry');
    expect(main.communicationStyle).toBe('No emojis.');
    expect(main.customInstructions).toBe('Keep replies short.');
    expect(main.role).toBe('Main control assistant');
  });

  it('syncs the main AGENT file when global personality changes', () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-personality-'),
    );
    process.env.SELF_HOSTED_CLAW_GROUPS_DIR = tempRoot;

    try {
      const mainDir = path.join(tempRoot, 'main');
      fs.mkdirSync(mainDir, { recursive: true });
      fs.writeFileSync(
        path.join(mainDir, 'AGENT.md'),
        '# Legacy main prompt\n\nOld behavior.\n',
      );

      const profiles: Record<string, PersonalityProfile> = {
        global: {
          scope: 'global',
          displayName: 'Lena',
          role: 'Personal assistant',
          tone: 'Direct',
          communicationStyle: 'Do not use emojis.',
          initiative: 'Act when possible.',
          aboutAgent: '',
          aboutController: '',
          customInstructions: 'Never be bubbly.',
          updatedAt: new Date().toISOString(),
        },
      };

      syncPersonalityFiles(profiles, 'global');

      const mainAgent = fs.readFileSync(path.join(mainDir, 'AGENT.md'), 'utf-8');
      expect(mainAgent).toContain('Tone: Direct');
      expect(mainAgent).toContain('Communication: Do not use emojis.');
      expect(mainAgent).toContain('Never be bubbly.');
      expect(mainAgent).toContain('SELF_HOSTED_CLAW_PERSONALITY');
    } finally {
      delete process.env.SELF_HOSTED_CLAW_GROUPS_DIR;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
