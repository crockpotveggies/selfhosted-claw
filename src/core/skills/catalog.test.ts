import { describe, expect, it } from 'vitest';

import { loadSkillCatalog } from './catalog.js';

describe('loadSkillCatalog', () => {
  it('loads existing container skills with permission metadata', () => {
    const catalog = loadSkillCatalog();

    const executiveAssistant = catalog.get('executive-assistant');
    expect(executiveAssistant?.description).toContain(
      'Conversational choreography',
    );
    expect(executiveAssistant?.visibility.permissionGroups).toContain(
      'scheduling',
    );

    const visibleToExternal = catalog.listAgentVisible({
      principalType: 'external',
      trustTier: 'restricted',
      runnerPool: 'restricted',
      permissionGroups: ['drafting', 'scheduling'],
    });
    expect(
      visibleToExternal.some((skill) => skill.name === 'executive-assistant'),
    ).toBe(true);
    expect(visibleToExternal.some((skill) => skill.name === 'status')).toBe(
      false,
    );
  });
});
