import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('SkillVisibilityService', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('writes a permission-filtered visible-skill snapshot', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-skill-vis-'),
    );

    const { SkillVisibilityService } = await import('./visibility-service.js');
    const service = new SkillVisibilityService(tempRoot);
    const snapshotPath = service.writeVisibleSkillSnapshot({
      groupFolder: 'client',
      principal: {
        type: 'external',
        trust_tier: 'restricted',
      },
      runnerPool: 'restricted',
      permissionGroups: ['drafting', 'scheduling'],
    });

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
      skills: Array<{ name: string }>;
    };
    expect(
      snapshot.skills.some((skill) => skill.name === 'executive-assistant'),
    ).toBe(true);
    expect(snapshot.skills.some((skill) => skill.name === 'status')).toBe(
      false,
    );
    const detailPath = path.join(
      tempRoot,
      'client',
      'visible-skill-details',
      'executive-assistant.json',
    );
    const detail = JSON.parse(fs.readFileSync(detailPath, 'utf-8')) as {
      name: string;
      requiredContext: string[];
    };
    expect(detail.name).toBe('executive-assistant');
    expect(detail.requiredContext).toContain('thread_summary');
  });

  it('describes only skills visible to the current principal', async () => {
    const { SkillVisibilityService } = await import('./visibility-service.js');
    const service = new SkillVisibilityService();

    const allowed = service.describeVisibleSkill({
      principal: {
        type: 'external',
        trust_tier: 'restricted',
      },
      runnerPool: 'restricted',
      permissionGroups: ['drafting', 'scheduling'],
      skillName: 'executive-assistant',
    });
    const blocked = service.describeVisibleSkill({
      principal: {
        type: 'external',
        trust_tier: 'restricted',
      },
      runnerPool: 'restricted',
      permissionGroups: ['drafting', 'scheduling'],
      skillName: 'status',
    });

    expect(allowed?.name).toBe('executive-assistant');
    expect(blocked).toBeUndefined();
  });
});
