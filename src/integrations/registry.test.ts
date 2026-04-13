import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  registerIntegration,
  getIntegration,
  getRegisteredIntegrations,
  getCoreIntegrations,
  getInstallableIntegrations,
  getIntegrationTools,
  getIntegrationsWithService,
  getIntegrationsWithMemory,
  getIntegrationsWithSetup,
  _clearRegistryForTesting,
} from './registry.js';
import type { IntegrationDefinition, IntegrationTool } from './types.js';

// Mock channel registry to verify delegation
vi.mock('../channels/registry.js', () => ({
  registerChannel: vi.fn(),
}));

import { registerChannel } from '../channels/registry.js';

function makeDef(
  overrides: Partial<IntegrationDefinition> = {},
): IntegrationDefinition {
  return {
    name: 'test-integration',
    description: 'Test',
    core: false,
    version: '1.0.0',
    credentials: [],
    ...overrides,
  };
}

describe('Integration Registry', () => {
  beforeEach(() => {
    _clearRegistryForTesting();
    vi.clearAllMocks();
  });

  it('registers and retrieves an integration', () => {
    const def = makeDef({ name: 'foo' });
    registerIntegration(def);
    expect(getIntegration('foo')).toBe(def);
  });

  it('returns undefined for unknown integration', () => {
    expect(getIntegration('nope')).toBeUndefined();
  });

  it('lists all registered integrations', () => {
    registerIntegration(makeDef({ name: 'a' }));
    registerIntegration(makeDef({ name: 'b' }));
    expect(getRegisteredIntegrations()).toHaveLength(2);
  });

  it('filters core vs installable', () => {
    registerIntegration(makeDef({ name: 'core1', core: true }));
    registerIntegration(makeDef({ name: 'opt1', core: false }));
    registerIntegration(makeDef({ name: 'opt2', core: false }));

    expect(getCoreIntegrations()).toHaveLength(1);
    expect(getCoreIntegrations()[0].name).toBe('core1');
    expect(getInstallableIntegrations()).toHaveLength(2);
  });

  it('delegates channel registration when channel is provided', () => {
    const factory = vi.fn();
    registerIntegration(makeDef({ name: 'ch1', channel: factory }));
    expect(registerChannel).toHaveBeenCalledWith('ch1', factory);
  });

  it('does not delegate channel registration when channel is absent', () => {
    registerIntegration(makeDef({ name: 'no-ch' }));
    expect(registerChannel).not.toHaveBeenCalled();
  });

  it('aggregates tools from multiple integrations', () => {
    const t1: IntegrationTool = {
      name: 'tool_a',
      description: 'A',
      parameters: {},
      location: 'host',
    };
    const t2: IntegrationTool = {
      name: 'tool_b',
      description: 'B',
      parameters: {},
      location: 'container',
    };
    registerIntegration(makeDef({ name: 'i1', tools: [t1] }));
    registerIntegration(makeDef({ name: 'i2', tools: [t2] }));

    const tools = getIntegrationTools();
    expect(tools).toHaveLength(2);
    expect(tools!.map((t) => t.name)).toEqual(['tool_a', 'tool_b']);
  });

  it('filters integrations with service', () => {
    registerIntegration(
      makeDef({
        name: 'svc',
        service: {
          composeFile: 'docker-compose.yml',
          serviceName: 'test',
          buildEnv: () => ({}),
          healthCheck: { url: 'http://localhost:8080' },
        },
      }),
    );
    registerIntegration(makeDef({ name: 'no-svc' }));

    expect(getIntegrationsWithService()).toHaveLength(1);
    expect(getIntegrationsWithService()[0].name).toBe('svc');
  });

  it('filters integrations with memory', () => {
    registerIntegration(
      makeDef({ name: 'mem', memory: { contextChars: 200 } }),
    );
    registerIntegration(makeDef({ name: 'no-mem' }));

    expect(getIntegrationsWithMemory()).toHaveLength(1);
  });

  it('filters integrations with setup', () => {
    registerIntegration(
      makeDef({
        name: 'with-setup',
        setup: {
          steps: [],
          getStatus: async () => ({
            completed: false,
            currentStep: 0,
            steps: [],
          }),
        },
      }),
    );
    registerIntegration(makeDef({ name: 'no-setup' }));

    expect(getIntegrationsWithSetup()).toHaveLength(1);
  });
});
