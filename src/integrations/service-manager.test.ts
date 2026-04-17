import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

// Mock dependencies
vi.mock('../config.js', () => ({
  ADMIN_CONFIG_DIR: '/tmp/nanoclaw-test-config',
}));

const mockRegistry = new Map<string, unknown>();
vi.mock('./registry.js', () => ({
  getIntegration: (name: string) => mockRegistry.get(name),
  getIntegrationsWithService: () =>
    [...mockRegistry.values()].filter((d: any) => d.service != null),
  registerChannel: vi.fn(),
}));

const mockSettings = new Map<string, Record<string, unknown>>();
vi.mock('./settings-store.js', () => ({
  getIntegrationSettings: (name: string) => mockSettings.get(name) || {},
  isIntegrationEnabled: () => true,
}));

import {
  startService,
  stopService,
  getServiceStatus,
  setComposeRunner,
  resetCircuitBreaker,
} from './service-manager.js';

import type { ComposeRunner } from './service-manager.js';
import type { IntegrationDefinition } from './types.js';

function makeServiceDef(
  name: string,
  overrides: Partial<IntegrationDefinition['service']> = {},
): IntegrationDefinition {
  return {
    name,
    description: 'Test',
    core: false,
    version: '1.0.0',
    credentials: [],
    service: {
      composeFile: '/tmp/docker-compose.yml',
      envFile: '/tmp/.env',
      serviceName: 'test-svc',
      buildEnv: (s) => ({
        ACCOUNT: (s.account as string) || '',
        URL: (s.url as string) || '',
      }),
      healthCheck: { url: 'http://localhost:8080' },
      ...overrides,
    },
  } as IntegrationDefinition;
}

describe('Service Manager', () => {
  let runnerMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRegistry.clear();
    mockSettings.clear();
    runnerMock = vi.fn().mockReturnValue({
      stdout: 'test-svc\n',
      stderr: '',
      status: 0,
    });
    setComposeRunner(runnerMock as unknown as ComposeRunner);
  });

  it('starts a service with bootstrap input', () => {
    const def = makeServiceDef('test');
    mockRegistry.set('test', def);

    const status = startService('test', {
      account: '+1555',
      url: 'http://localhost:8080',
    });

    expect(runnerMock).toHaveBeenCalled();
    // Verify docker compose up was called
    const args = runnerMock.mock.calls[0][0] as string[];
    expect(args).toContain('up');
    expect(args).toContain('-d');
  });

  it('starts a service with saved settings', () => {
    const def = makeServiceDef('test');
    mockRegistry.set('test', def);
    mockSettings.set('test', {
      account: '+1555',
      url: 'http://localhost:8080',
    });

    startService('test');
    expect(runnerMock).toHaveBeenCalled();
  });

  it('throws when service start fails', () => {
    const def = makeServiceDef('test');
    mockRegistry.set('test', def);
    runnerMock.mockReturnValue({
      stdout: '',
      stderr: 'container failed',
      status: 1,
    });

    expect(() => startService('test')).toThrow('container failed');
  });

  it('recreates compose resources when docker requests a down/up cycle', () => {
    const def = makeServiceDef('test');
    mockRegistry.set('test', def);
    runnerMock
      .mockReturnValueOnce({
        stdout: '',
        stderr:
          'Network "signal-cli_default" needs to be recreated - option "com.docker.network.enable_ipv4" has changed',
        status: 1,
      })
      .mockReturnValueOnce({
        stdout: '',
        stderr: '',
        status: 0,
      })
      .mockReturnValue({
        stdout: 'test-svc\n',
        stderr: '',
        status: 0,
      });

    startService('test');

    expect(runnerMock).toHaveBeenNthCalledWith(
      1,
      [
        '-f',
        'C:\\tmp\\docker-compose.yml',
        '--env-file',
        'C:\\tmp\\.env',
        'up',
        '-d',
      ],
      'C:\\tmp',
    );
    expect(runnerMock).toHaveBeenNthCalledWith(
      2,
      [
        '-f',
        'C:\\tmp\\docker-compose.yml',
        '--env-file',
        'C:\\tmp\\.env',
        'down',
      ],
      'C:\\tmp',
    );
    expect(runnerMock).toHaveBeenNthCalledWith(
      3,
      [
        '-f',
        'C:\\tmp\\docker-compose.yml',
        '--env-file',
        'C:\\tmp\\.env',
        'up',
        '-d',
      ],
      'C:\\tmp',
    );
  });

  it('throws for integration without service', () => {
    mockRegistry.set('no-svc', {
      name: 'no-svc',
      description: 'Test',
      core: false,
      version: '1.0.0',
      credentials: [],
    });

    expect(() => startService('no-svc')).toThrow('has no service');
  });

  it('getServiceStatus returns status', () => {
    const def = makeServiceDef('test');
    mockRegistry.set('test', def);

    const status = getServiceStatus('test');
    // Status depends on file existence, but we can verify shape
    expect(status).toHaveProperty('integrationName', 'test');
    expect(status).toHaveProperty('serviceName', 'test-svc');
    expect(typeof status.running).toBe('boolean');
    expect(typeof status.circuitOpen).toBe('boolean');
  });

  it('uses compose ps -q for cross-version running checks', () => {
    const def = makeServiceDef('test');
    mockRegistry.set('test', def);
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    getServiceStatus('test');

    expect(runnerMock).toHaveBeenCalledWith(
      [
        '-f',
        'C:\\tmp\\docker-compose.yml',
        '--env-file',
        'C:\\tmp\\.env',
        'ps',
        '-q',
        'test-svc',
      ],
      'C:\\tmp',
    );
    existsSpy.mockRestore();
  });

  it('resetCircuitBreaker clears failure state', () => {
    const def = makeServiceDef('test');
    mockRegistry.set('test', def);

    // This should not throw
    resetCircuitBreaker('test');
  });
});
