import { describe, expect, it } from 'vitest';

import {
  buildSetupChecks,
  buildSignalReachabilityProbeUrl,
  isAllowedAdminRemoteAddress,
  requiresAdminAuth,
} from './admin-server.js';

describe('isAllowedAdminRemoteAddress', () => {
  it('allows loopback addresses everywhere', () => {
    expect(isAllowedAdminRemoteAddress('127.0.0.1', false)).toBe(true);
    expect(isAllowedAdminRemoteAddress('::1', false)).toBe(true);
    expect(isAllowedAdminRemoteAddress('::ffff:127.0.0.1', false)).toBe(true);
  });

  it('allows docker bridge private IPv4 addresses only in containers', () => {
    expect(isAllowedAdminRemoteAddress('172.18.0.1', true)).toBe(true);
    expect(isAllowedAdminRemoteAddress('::ffff:172.18.0.1', true)).toBe(true);
    expect(isAllowedAdminRemoteAddress('192.168.65.1', true)).toBe(true);
    expect(isAllowedAdminRemoteAddress('10.0.75.1', true)).toBe(true);
    expect(isAllowedAdminRemoteAddress('172.18.0.1', false)).toBe(false);
  });

  it('rejects non-local public addresses', () => {
    expect(isAllowedAdminRemoteAddress('8.8.8.8', true)).toBe(false);
    expect(isAllowedAdminRemoteAddress('203.0.113.10', false)).toBe(false);
  });

  it('requires auth for admin API routes but not static UI assets', () => {
    expect(requiresAdminAuth('/api/admin/health')).toBe(true);
    expect(requiresAdminAuth('/api/admin/dashboard')).toBe(true);
    expect(requiresAdminAuth('/')).toBe(false);
    expect(requiresAdminAuth('/assets/index.js')).toBe(false);
    expect(requiresAdminAuth('/dashboard')).toBe(false);
  });

  it('treats non-core integrations as non-blocking for setup completion', () => {
    const checks = buildSetupChecks({
      openAIConfigured: true,
      signalConfigured: true,
      signalReachable: true,
      signalComposeConfigured: true,
      signalComposeRunning: true,
      controlChatConfigured: true,
      verifiedIdentityCount: 1,
      assistantSignalConfigured: true,
      setupWizardReviewed: false,
    });

    expect(checks.wizardComplete).toBe(true);
    expect(checks.googleContactsAvailable).toBe(false);
    expect(checks.googleContactsSource).toBe('none');
  });

  it('normalizes the Signal reachability probe for containerized control planes', () => {
    const url = buildSignalReachabilityProbeUrl(
      'http://127.0.0.1:8073',
      '+12369995414',
      true,
    );

    expect(url.toString()).toBe(
      'http://host.docker.internal:8073/v1/groups/%2B12369995414',
    );
  });
});
