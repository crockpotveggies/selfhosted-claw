import { PolicyEngine, type PolicyContext } from '../policy/engine.js';
import type { SkillAccessContext, SkillDefinition } from './types.js';

function toPolicyContext(access: SkillAccessContext): PolicyContext {
  return {
    principal: {
      id: 'agent-visible-principal',
      type: access.principalType,
      trust_tier: access.trustTier,
      status: 'active',
    },
    runnerPool: access.runnerPool,
    permissionGroups: access.permissionGroups,
  };
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  registerMany(skills: SkillDefinition[]): void {
    for (const skill of skills) this.register(skill);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  listAll(): SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  listAgentVisible(
    access: SkillAccessContext,
    policy = new PolicyEngine(),
  ): SkillDefinition[] {
    const context = toPolicyContext(access);
    return this.listAll().filter((skill) =>
      policy.canViewSkill(skill, context),
    );
  }

  describeAgentVisible(
    name: string,
    access: SkillAccessContext,
    policy = new PolicyEngine(),
  ): SkillDefinition | undefined {
    const skill = this.skills.get(name);
    if (!skill) return undefined;
    return policy.canViewSkill(skill, toPolicyContext(access))
      ? skill
      : undefined;
  }
}
