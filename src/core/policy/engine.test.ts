import { describe, expect, it } from 'vitest';

import { PolicyEngine } from './engine.js';
import type { SkillDefinition } from '../skills/types.js';

const trustedSkill: SkillDefinition = {
  name: 'prepare_meeting_brief',
  description: 'Prepare a meeting brief.',
  category: 'briefing',
  kind: 'agent',
  visibility: {
    principalTypes: ['controller'],
    trustTiers: ['trusted'],
    permissionGroups: ['briefing'],
  },
  allowedRunnerPools: ['trusted'],
  sideEffectLevel: 'draft',
  requiredContext: ['task_summary'],
  requiredArtifacts: [],
  preconditions: [],
  outputs: ['brief.md'],
  tags: ['meeting'],
};

describe('PolicyEngine', () => {
  it('prevents external principals from accessing trusted-only skills', () => {
    const policy = new PolicyEngine();

    const visible = policy.canViewSkill(trustedSkill, {
      principal: {
        id: 'principal-external',
        type: 'external',
        trust_tier: 'restricted',
        status: 'active',
      },
      runnerPool: 'restricted',
      permissionGroups: ['briefing'],
    });

    expect(visible).toBe(false);
  });

  it('allows controllers to access trusted skills when policy allows', () => {
    const policy = new PolicyEngine();

    const visible = policy.canViewSkill(trustedSkill, {
      principal: {
        id: 'principal-controller',
        type: 'controller',
        trust_tier: 'trusted',
        status: 'active',
      },
      runnerPool: 'trusted',
      permissionGroups: ['briefing'],
    });

    expect(visible).toBe(true);
    expect(
      policy.canUseRunnerPool('trusted', {
        principal: {
          id: 'principal-controller',
          type: 'controller',
          trust_tier: 'trusted',
          status: 'active',
        },
        runnerPool: 'trusted',
        permissionGroups: ['briefing'],
      }).allowed,
    ).toBe(true);
  });
});
