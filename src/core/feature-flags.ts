import {
  ENABLE_CONTEXT_ASSEMBLER,
  ENABLE_DEDUPE_V2,
  ENABLE_NEW_ACTION_ENGINE,
  ENABLE_PRINCIPAL_POLICY,
  ENABLE_RUNSPEC_RUNNERS,
  ENABLE_SKILL_REGISTRY_V2,
  ENABLE_HOT_RUNNER_CONTAINERS,
} from '../config.js';

export interface FeatureFlags {
  enableNewActionEngine: boolean;
  enableRunspecRunners: boolean;
  enablePrincipalPolicy: boolean;
  enableSkillRegistryV2: boolean;
  enableContextAssembler: boolean;
  enableDedupeV2: boolean;
  enableHotRunnerContainers: boolean;
}

export const featureFlags: FeatureFlags = Object.freeze({
  enableNewActionEngine: ENABLE_NEW_ACTION_ENGINE,
  enableRunspecRunners: ENABLE_RUNSPEC_RUNNERS,
  enablePrincipalPolicy: ENABLE_PRINCIPAL_POLICY,
  enableSkillRegistryV2: ENABLE_SKILL_REGISTRY_V2,
  enableContextAssembler: ENABLE_CONTEXT_ASSEMBLER,
  enableDedupeV2: ENABLE_DEDUPE_V2,
  enableHotRunnerContainers: ENABLE_HOT_RUNNER_CONTAINERS,
});
