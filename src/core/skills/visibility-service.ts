import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { loadSkillCatalog } from './catalog.js';
import type { SkillDefinition } from './types.js';
import type { PrincipalRecord, RunnerPool } from '../state/types.js';

export class SkillVisibilityService {
  // Fingerprint of the last snapshot inputs per group — if the inputs haven't
  // changed, we skip the (sync, multi-file) write entirely.
  private readonly snapshotFingerprints = new Map<string, string>();

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
    const snapshotPath = path.join(snapshotDir, 'visible-skills.v2.json');

    // Fingerprint over inputs that actually affect output — principal type +
    // trust tier + runner pool + sorted permission groups + resolved skill
    // identity list. Skip rewriting if unchanged since last call.
    const fingerprint = crypto
      .createHash('sha1')
      .update(
        JSON.stringify({
          p: input.principal,
          r: input.runnerPool,
          g: [...input.permissionGroups].sort(),
          s: skills.map((s) => s.name).sort(),
        }),
      )
      .digest('hex');
    const prev = this.snapshotFingerprints.get(input.groupFolder);
    if (prev === fingerprint && fs.existsSync(snapshotPath)) {
      return snapshotPath;
    }

    // Run the actual multi-file write asynchronously — the agent doesn't
    // need the snapshot to be on disk before it starts thinking, and the
    // files are only read for debugging / next-turn context.
    this.snapshotFingerprints.set(input.groupFolder, fingerprint);
    setImmediate(() => {
      try {
        fs.mkdirSync(snapshotDir, { recursive: true });
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
      } catch (err) {
        // Roll back fingerprint so the next call retries the write.
        this.snapshotFingerprints.delete(input.groupFolder);
        logger.warn(
          { err: String(err), groupFolder: input.groupFolder },
          'Deferred skill snapshot write failed',
        );
      }
    });
    return snapshotPath;
  }
}
