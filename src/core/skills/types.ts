import type { PrincipalType, RunnerPool, TrustTier } from '../state/types.js';

export type SkillKind = 'system' | 'agent';
export type SideEffectLevel = 'none' | 'draft' | 'sensitive';

export interface SkillDefinition {
  name: string;
  description: string;
  category: string;
  kind: SkillKind;
  visibility: {
    principalTypes: PrincipalType[];
    trustTiers?: TrustTier[];
    permissionGroups: string[];
  };
  allowedRunnerPools: RunnerPool[];
  sideEffectLevel: SideEffectLevel;
  requiredContext: string[];
  requiredArtifacts: string[];
  preconditions: string[];
  outputs: string[];
  tags: string[];
}

export interface SkillAccessContext {
  principalType: PrincipalType;
  trustTier: TrustTier;
  runnerPool: RunnerPool;
  permissionGroups: string[];
}
