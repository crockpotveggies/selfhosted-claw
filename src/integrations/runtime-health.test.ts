import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => {
  const p = require('path');
  const o = require('os');
  return {
    ADMIN_CONFIG_DIR: p.join(o.tmpdir(), 'nanoclaw-runtime-health-test'),
  };
});

import {
  applyIntegrationRuntimeFaultToStatus,
  buildIntegrationRuntimeFaultNotification,
  clearIntegrationRuntimeFault,
  getIntegrationRuntimeFault,
  recordIntegrationRuntimeFault,
} from './runtime-health.js';

const tmpDir = path.join(os.tmpdir(), 'nanoclaw-runtime-health-test');

describe('integration runtime health', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records and classifies auth failures from integration tool calls', () => {
    recordIntegrationRuntimeFault('google-calendar', {
      tool: 'calendar_check_availability',
      message: 'Calendar API 401: {"error":{"message":"Invalid Credentials"}}',
    });

    expect(getIntegrationRuntimeFault('google-calendar')).toMatchObject({
      tool: 'calendar_check_availability',
      category: 'auth',
    });
  });

  it('clears recorded runtime faults', () => {
    recordIntegrationRuntimeFault('google-calendar', {
      tool: 'calendar_check_availability',
      message: 'Calendar API 401: invalid_grant',
    });

    clearIntegrationRuntimeFault('google-calendar');

    expect(getIntegrationRuntimeFault('google-calendar')).toBeNull();
  });

  it('degrades otherwise-online integrations when auth failed during tool execution', () => {
    recordIntegrationRuntimeFault('google-calendar', {
      tool: 'calendar_create_event',
      message: 'Calendar API 401: invalid credentials',
    });
    const fault = getIntegrationRuntimeFault('google-calendar');

    expect(
      applyIntegrationRuntimeFaultToStatus(
        { state: 'online', message: 'Connected' },
        fault,
      ),
    ).toEqual({
      state: 'degraded',
      message:
        'Authentication failed during the last tool call. Reconnect the integration.',
    });
  });

  it('builds a reconnect-focused notification for auth failures', () => {
    recordIntegrationRuntimeFault('google-calendar', {
      tool: 'calendar_list_events',
      message: 'Calendar API 401: UNAUTHENTICATED',
    });
    const fault = getIntegrationRuntimeFault('google-calendar');

    expect(
      buildIntegrationRuntimeFaultNotification('google-calendar', fault!),
    ).toMatchObject({
      integration: 'google-calendar',
      severity: 'error',
      title: 'Google Calendar authorization expired',
    });
  });
});
