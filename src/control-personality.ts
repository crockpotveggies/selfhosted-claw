import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import { PersonalityProfile, PersonalityScope } from './control-types.js';

const MANAGED_BEGIN = '<!-- SELF_HOSTED_CLAW_PERSONALITY:BEGIN -->';
const MANAGED_END = '<!-- SELF_HOSTED_CLAW_PERSONALITY:END -->';

const DEFAULT_GLOBAL_PROFILE: PersonalityProfile = {
  scope: 'global',
  displayName: ASSISTANT_NAME,
  role: 'Personal assistant',
  tone: 'Warm, concise, and practical.',
  communicationStyle:
    'Use clear short paragraphs and only use lists when helpful.',
  initiative: 'Be proactive when useful, but confirm sensitive actions.',
  aboutMe: '',
  customInstructions: '',
  updatedAt: new Date(0).toISOString(),
};

const DEFAULT_MAIN_PROFILE: PersonalityProfile = {
  ...DEFAULT_GLOBAL_PROFILE,
  scope: 'main',
  role: 'Main control assistant',
  initiative:
    'Operate carefully in the control chat and summarize important changes clearly.',
};

export function getDefaultProfile(scope: PersonalityScope): PersonalityProfile {
  if (scope === 'main') return { ...DEFAULT_MAIN_PROFILE };
  return { ...DEFAULT_GLOBAL_PROFILE, scope };
}

export function resolveProfile(
  scope: PersonalityScope,
  profiles: Record<string, PersonalityProfile>,
): PersonalityProfile {
  if (scope.startsWith('group:')) {
    const groupProfile = profiles[scope];
    if (groupProfile) return groupProfile;
  }
  if (scope === 'main') {
    return profiles.main || getDefaultProfile('main');
  }
  return profiles.global || getDefaultProfile('global');
}

export function renderManagedPersonality(profile: PersonalityProfile): string {
  const parts = [
    MANAGED_BEGIN,
    `# ${profile.displayName || ASSISTANT_NAME}`,
    '',
    `You are ${profile.displayName || ASSISTANT_NAME}, ${profile.role}.`,
    '',
    '## Personality',
    `- Tone: ${profile.tone}`,
    `- Communication: ${profile.communicationStyle}`,
    `- Initiative: ${profile.initiative}`,
  ];

  const aboutMe = profile.aboutMe?.trim();
  if (aboutMe) {
    parts.push(
      '',
      '## About the Controller',
      'The following facts describe the person you work for. Use these to answer personal questions on their behalf, personalize conversations, and provide context when relevant.',
      aboutMe,
    );
  }

  parts.push(
    '',
    '## Control Plane',
    '- Respect host-side control actions, approvals, and Signal control-chat commands.',
    '- Sensitive actions should be routed through verified-owner controls when required.',
  );

  const custom = profile.customInstructions.trim();
  if (custom) {
    parts.push('', '## Custom Instructions', custom);
  }
  parts.push(MANAGED_END);
  return parts.join('\n');
}

export function applyManagedPersonality(
  existingContent: string,
  profile: PersonalityProfile,
): string {
  const managed = renderManagedPersonality(profile);
  const pattern = new RegExp(
    `${MANAGED_BEGIN}[\\s\\S]*?${MANAGED_END}\\n?`,
    'm',
  );
  if (pattern.test(existingContent)) {
    return existingContent.replace(pattern, `${managed}\n\n`);
  }
  return `${managed}\n\n${existingContent.trim()}\n`;
}

export function personalityScopePath(scope: PersonalityScope): string {
  const groupsDir = process.env.SELF_HOSTED_CLAW_GROUPS_DIR || GROUPS_DIR;
  if (scope === 'global') return path.join(groupsDir, 'global', 'AGENT.md');
  if (scope === 'main') return path.join(groupsDir, 'main', 'AGENT.md');
  const folder = scope.slice('group:'.length);
  return path.join(groupsDir, folder, 'AGENT.md');
}

export function writePersonalityProfile(profile: PersonalityProfile): string {
  const targetPath = personalityScopePath(profile.scope);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const existing = fs.existsSync(targetPath)
    ? fs.readFileSync(targetPath, 'utf-8')
    : '';
  const next = applyManagedPersonality(existing, profile);
  fs.writeFileSync(targetPath, next);
  return targetPath;
}

export function previewPersonalityProfile(
  scope: PersonalityScope,
  profiles: Record<string, PersonalityProfile>,
): string {
  const targetPath = personalityScopePath(scope);
  const existing = fs.existsSync(targetPath)
    ? fs.readFileSync(targetPath, 'utf-8')
    : '';
  return applyManagedPersonality(existing, resolveProfile(scope, profiles));
}
