import { registerChannel } from '../channels/registry.js';
import { logger } from '../logger.js';

import type { IntegrationDefinition } from './types.js';

const registry = new Map<string, IntegrationDefinition>();

/**
 * Register an integration. If it provides a channel factory, the channel
 * is also registered via the legacy channel registry so the existing
 * startup loop in src/index.ts continues to work unchanged.
 */
export function registerIntegration(def: IntegrationDefinition): void {
  registry.set(def.name, def);

  if (def.channel) {
    registerChannel(def.name, def.channel);
  }

  logger.debug({ integration: def.name, core: def.core }, 'Integration registered');
}

export function getIntegration(
  name: string,
): IntegrationDefinition | undefined {
  return registry.get(name);
}

export function getRegisteredIntegrations(): IntegrationDefinition[] {
  return [...registry.values()];
}

export function getCoreIntegrations(): IntegrationDefinition[] {
  return getRegisteredIntegrations().filter((i) => i.core);
}

export function getInstallableIntegrations(): IntegrationDefinition[] {
  return getRegisteredIntegrations().filter((i) => !i.core);
}

export function getIntegrationTools(): IntegrationDefinition['tools'] {
  return getRegisteredIntegrations().flatMap((i) => i.tools ?? []);
}

export function getIntegrationsWithService(): IntegrationDefinition[] {
  return getRegisteredIntegrations().filter((i) => i.service != null);
}

export function getIntegrationsWithMemory(): IntegrationDefinition[] {
  return getRegisteredIntegrations().filter((i) => i.memory != null);
}

export function getIntegrationsWithSetup(): IntegrationDefinition[] {
  return getRegisteredIntegrations().filter((i) => i.setup != null);
}

/** Get names of all registered integrations. Useful for iteration. */
export function getRegisteredIntegrationNames(): string[] {
  return [...registry.keys()];
}

/**
 * Clear the registry. Only used in tests.
 * @internal
 */
export function _clearRegistryForTesting(): void {
  registry.clear();
}
