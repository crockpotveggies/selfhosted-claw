import type { SkillDefinition } from '../skills/types.js';
import type { PrincipalRecord, RunnerPool, TrustTier } from '../state/types.js';

export interface PolicyContext {
  principal: Pick<PrincipalRecord, 'id' | 'type' | 'trust_tier' | 'status'>;
  runnerPool: RunnerPool;
  permissionGroups: string[];
}

export interface ActionPolicyRequest {
  runnerPool: RunnerPool;
  permissionProfile: string;
  sideEffectLevel?: 'none' | 'draft' | 'sensitive';
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

function trustAllowsRunner(
  trustTier: TrustTier,
  runnerPool: RunnerPool,
): boolean {
  if (trustTier === 'trusted') return true;
  return runnerPool === 'restricted';
}

function hasPermissionGroup(granted: string[], required: string[]): boolean {
  if (required.length === 0) return true;
  return required.some((group) => granted.includes(group));
}

export class PolicyEngine {
  canViewSkill(skill: SkillDefinition, context: PolicyContext): boolean {
    if (skill.kind !== 'agent') return false;
    if (context.principal.status !== 'active') return false;
    if (!skill.visibility.principalTypes.includes(context.principal.type)) {
      return false;
    }
    if (
      skill.visibility.trustTiers &&
      !skill.visibility.trustTiers.includes(context.principal.trust_tier)
    ) {
      return false;
    }
    if (!skill.allowedRunnerPools.includes(context.runnerPool)) return false;
    if (!trustAllowsRunner(context.principal.trust_tier, context.runnerPool)) {
      return false;
    }
    return hasPermissionGroup(
      context.permissionGroups,
      skill.visibility.permissionGroups,
    );
  }

  canUseRunnerPool(
    runnerPool: RunnerPool,
    context: PolicyContext,
  ): PolicyDecision {
    if (context.principal.status !== 'active') {
      return { allowed: false, reason: 'principal_inactive' };
    }
    if (!trustAllowsRunner(context.principal.trust_tier, runnerPool)) {
      return { allowed: false, reason: 'runner_pool_not_allowed' };
    }
    return { allowed: true };
  }

  canPerformAction(
    request: ActionPolicyRequest,
    context: PolicyContext,
  ): PolicyDecision {
    const runnerDecision = this.canUseRunnerPool(request.runnerPool, context);
    if (!runnerDecision.allowed) return runnerDecision;

    if (
      request.permissionProfile !== 'open' &&
      !context.permissionGroups.includes(request.permissionProfile)
    ) {
      return { allowed: false, reason: 'permission_profile_not_granted' };
    }
    if (
      request.sideEffectLevel === 'sensitive' &&
      context.principal.type !== 'controller'
    ) {
      return { allowed: false, reason: 'approval_required' };
    }
    return { allowed: true };
  }

  isApprovalRequired(
    request: ActionPolicyRequest,
    context: PolicyContext,
  ): boolean {
    return (
      request.sideEffectLevel === 'sensitive' &&
      context.principal.type !== 'controller'
    );
  }
}
