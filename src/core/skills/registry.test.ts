import { describe, expect, it } from 'vitest';

import { SkillRegistry } from './registry.js';

describe('SkillRegistry', () => {
  it('only exposes permission-allowed agent-facing skills and allows metadata lookup', () => {
    const registry = new SkillRegistry();

    registry.registerMany([
      {
        name: 'draft_reply_from_thread',
        description: 'Draft a reply using thread context.',
        category: 'messaging',
        kind: 'agent',
        visibility: {
          principalTypes: ['controller', 'external'],
          trustTiers: ['restricted', 'trusted'],
          permissionGroups: ['drafting'],
        },
        allowedRunnerPools: ['restricted', 'trusted'],
        sideEffectLevel: 'draft',
        requiredContext: ['thread_summary'],
        requiredArtifacts: [],
        preconditions: [],
        outputs: ['draft.txt'],
        tags: ['reply'],
      },
      {
        name: 'send_email_now',
        description: 'Send an email immediately.',
        category: 'messaging',
        kind: 'agent',
        visibility: {
          principalTypes: ['controller'],
          trustTiers: ['trusted'],
          permissionGroups: ['trusted-ops'],
        },
        allowedRunnerPools: ['trusted'],
        sideEffectLevel: 'sensitive',
        requiredContext: ['thread_summary'],
        requiredArtifacts: [],
        preconditions: [],
        outputs: ['delivery_receipt.json'],
        tags: ['email'],
      },
      {
        name: 'resolve_identity',
        description: 'Internal identity resolution.',
        category: 'system',
        kind: 'system',
        visibility: {
          principalTypes: ['controller', 'external', 'system'],
          permissionGroups: ['internal'],
        },
        allowedRunnerPools: ['restricted', 'trusted'],
        sideEffectLevel: 'none',
        requiredContext: [],
        requiredArtifacts: [],
        preconditions: [],
        outputs: [],
        tags: ['internal'],
      },
    ]);

    const visible = registry.listAgentVisible({
      principalType: 'external',
      trustTier: 'restricted',
      runnerPool: 'restricted',
      permissionGroups: ['drafting'],
    });

    expect(visible.map((skill) => skill.name)).toEqual([
      'draft_reply_from_thread',
    ]);
    expect(
      registry.describeAgentVisible('resolve_identity', {
        principalType: 'external',
        trustTier: 'restricted',
        runnerPool: 'restricted',
        permissionGroups: ['drafting'],
      }),
    ).toBeUndefined();

    const detail = registry.describeAgentVisible('draft_reply_from_thread', {
      principalType: 'external',
      trustTier: 'restricted',
      runnerPool: 'restricted',
      permissionGroups: ['drafting'],
    });

    expect(detail?.description).toContain('Draft a reply');
    expect(detail?.requiredContext).toContain('thread_summary');
  });
});
