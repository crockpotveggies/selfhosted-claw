import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { loadSkillCatalog } from './catalog.js';
import type { SkillDefinition } from './types.js';
import type { PrincipalRecord, RunnerPool } from '../state/types.js';

export class SkillVisibilityService {
  constructor(
    private readonly sessionsRoot = path.join(DATA_DIR, 'sessions'),
  ) {}

  getVisibleSkills(input: {
    principal: Pick<PrincipalRecord, 'type' | 'trust_tier'>;
    runnerPool: RunnerPool;
    permissionGroups: string[];
  }): SkillDefinition[] {
    const catalog = loadSkillCatalog();
    return catalog.listAgentVisible({
      principalType: input.principal.type,
      trustTier: input.principal.trust_tier,
      runnerPool: input.runnerPool,
      permissionGroups: input.permissionGroups,
    });
  }

  describeVisibleSkill(input: {
    principal: Pick<PrincipalRecord, 'type' | 'trust_tier'>;
    runnerPool: RunnerPool;
    permissionGroups: string[];
    skillName: string;
  }): SkillDefinition | undefined {
    const catalog = loadSkillCatalog();
    return catalog.describeAgentVisible(input.skillName, {
      principalType: input.principal.type,
      trustTier: input.principal.trust_tier,
      runnerPool: input.runnerPool,
      permissionGroups: input.permissionGroups,
    });
  }

  writeVisibleSkillSnapshot(input: {
    groupFolder: string;
    principal: Pick<PrincipalRecord, 'type' | 'trust_tier'>;
    runnerPool: RunnerPool;
    permissionGroups: string[];
  }): string {
    const skills = this.getVisibleSkills({
      principal: input.principal,
      runnerPool: input.runnerPool,
      permissionGroups: input.permissionGroups,
    });
    const snapshotDir = path.join(this.sessionsRoot, input.groupFolder);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, 'visible-skills.v2.json');
    const detailsDir = path.join(snapshotDir, 'visible-skill-details');
    fs.mkdirSync(detailsDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          runner_pool: input.runnerPool,
          skills: skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            category: skill.category,
            sideEffectLevel: skill.sideEffectLevel,
            requiredContext: skill.requiredContext,
            outputs: skill.outputs,
            tags: skill.tags,
          })),
        },
        null,
        2,
      ),
      'utf-8',
    );
    for (const skill of skills) {
      fs.writeFileSync(
        path.join(detailsDir, `${skill.name}.json`),
        JSON.stringify(skill, null, 2),
        'utf-8',
      );
    }
    return snapshotPath;
  }
}
