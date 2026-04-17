import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  ensureControlPlaneEnvFile,
  getControlPlaneServiceCommand,
  getRunnerImageBuildCommand,
  getRunnerLogCommand,
  parseRunnerContainerNames,
} from './control-plane-service.js';
import { getControlPlaneStatePaths } from './control-plane-state.js';

describe('control plane compose service commands', () => {
  it('builds the control plane image for install', () => {
    expect(getControlPlaneServiceCommand('install')).toEqual({
      command: 'docker',
      args: [
        'compose',
        '-f',
        'docker-compose.control-plane.yml',
        'build',
        'control-plane',
      ],
    });
  });

  it('starts the control plane with compose up and build', () => {
    expect(getControlPlaneServiceCommand('start')).toEqual({
      command: 'docker',
      args: [
        'compose',
        '-f',
        'docker-compose.control-plane.yml',
        'up',
        '-d',
        '--build',
        'control-plane',
      ],
    });
  });

  it('stops the control plane service only', () => {
    expect(getControlPlaneServiceCommand('stop')).toEqual({
      command: 'docker',
      args: [
        'compose',
        '-f',
        'docker-compose.control-plane.yml',
        'stop',
        'control-plane',
      ],
    });
  });

  it('shows compose status for the control plane service', () => {
    expect(getControlPlaneServiceCommand('status')).toEqual({
      command: 'docker',
      args: [
        'compose',
        '-f',
        'docker-compose.control-plane.yml',
        'ps',
        'control-plane',
      ],
    });
  });

  it('tails compose logs for the control plane service', () => {
    expect(getControlPlaneServiceCommand('logs')).toEqual({
      command: 'docker',
      args: [
        'compose',
        '-f',
        'docker-compose.control-plane.yml',
        'logs',
        '-f',
        'control-plane',
      ],
    });
  });

  it('builds a docker logs follower command for runner containers', () => {
    expect(getRunnerLogCommand('nanoclaw-main-123')).toEqual({
      command: 'docker',
      args: ['logs', '-f', '--tail', '100', 'nanoclaw-main-123'],
    });
  });

  it('builds the runner image from the container directory', () => {
    expect(getRunnerImageBuildCommand()).toEqual({
      command: 'docker',
      args: ['build', '-t', 'nanoclaw-agent:latest', '.'],
    });
  });

  it('extracts active runner container names from docker ps output', () => {
    expect(
      parseRunnerContainerNames(
        [
          'nanoclaw-main-123',
          'selfhosted-claw-control-plane-1',
          'nanoclaw-sms18337750707-456',
          '',
        ].join('\n'),
      ),
    ).toEqual(['nanoclaw-main-123', 'nanoclaw-sms18337750707-456']);
  });

  it('exposes a cleanup-state utility action', () => {
    expect(getControlPlaneServiceCommand('cleanup-state')).toEqual({
      command: 'docker',
      args: [
        'compose',
        '-f',
        'docker-compose.control-plane.yml',
        'ps',
        'control-plane',
      ],
    });
  });

  it('targets repo-mounted admin state directories for migration', () => {
    const paths = getControlPlaneStatePaths('C:\\repo', 'C:\\Users\\me');
    expect(paths.repoAdminConfigDir).toBe('C:\\repo\\admin-config');
    expect(paths.repoAdminDataDir).toBe('C:\\repo\\admin-data');
    expect(paths.legacyAdminConfigDir).toBe(
      'C:\\Users\\me\\.config\\self-hosted-claw',
    );
    expect(paths.legacyAdminDataDir).toBe(
      'C:\\Users\\me\\.local\\share\\self-hosted-claw',
    );
  });

  it('creates .env from .env.example before compose startup', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-env-'));
    const examplePath = path.join(tmpDir, '.env.example');
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(examplePath, 'OPENAI_MODEL="local-model"\n');

    expect(ensureControlPlaneEnvFile(tmpDir)).toBe(envPath);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(
      'OPENAI_MODEL="local-model"\n',
    );
  });
});
