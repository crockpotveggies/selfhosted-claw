import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRegisteredIntegrations, isIntegrationEnabled } = vi.hoisted(() => ({
  getRegisteredIntegrations: vi.fn(),
  isIntegrationEnabled: vi.fn(),
}));

vi.mock('./integrations/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./integrations/registry.js')>();
  return {
    ...actual,
    getRegisteredIntegrations,
  };
});

vi.mock('./integrations/settings-store.js', () => ({
  isIntegrationEnabled,
}));

import { ControlStore } from './control-store.js';
import {
  buildEffectiveToolRegistry,
  buildSessionToolRegistrySnapshot,
} from './tool-registry.js';

describe('tool registry policy', () => {
  let tempDir: string;
  let store: ControlStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tool-policy-'));
    store = new ControlStore(
      path.join(tempDir, 'config'),
      path.join(tempDir, 'data'),
    );
    getRegisteredIntegrations.mockReturnValue([
      {
        name: 'signal',
        tools: [
          {
            name: 'signal.reply',
            description: 'Reply in the current thread',
            parameters: { type: 'object', properties: {} },
            location: 'host',
          },
          {
            name: 'signal.send_message',
            description: 'Send to another contact',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
          },
          {
            name: 'signal.create_group',
            description: 'Create a Signal group',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
          },
          {
            name: 'signal.list_groups',
            description: 'List Signal groups',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
          },
          {
            name: 'signal.leave_group',
            description: 'Leave a Signal group',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
          },
        ],
      },
      {
        name: 'google-calendar',
        tools: [
          {
            name: 'calendar_list_events',
            description: 'List calendar events',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
            sideEffecting: false,
          },
          {
            name: 'calendar_check_availability',
            description: 'Check availability',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: false,
            sideEffecting: false,
          },
        ],
      },
      {
        name: 'whatsapp',
        tools: [
          {
            name: 'whatsapp.create_group',
            description: 'Create a WhatsApp group',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
          },
          {
            name: 'whatsapp.list_groups',
            description: 'List WhatsApp groups',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
          },
          {
            name: 'whatsapp.leave_group',
            description: 'Leave a WhatsApp group',
            parameters: { type: 'object', properties: {} },
            location: 'host',
            controllerOnly: true,
          },
        ],
      },
    ]);
    isIntegrationEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('includes core runner tools in the effective registry', () => {
    const tools = buildEffectiveToolRegistry({ store });
    expect(tools.some((tool) => tool.name === 'schedule_task')).toBe(true);
    expect(tools.some((tool) => tool.name === 'web_search')).toBe(true);
  });

  it('does not expose legacy Signal or WhatsApp group tools as runner core', () => {
    const tools = buildEffectiveToolRegistry({ store });
    expect(tools.some((tool) => tool.name === 'signal_create_group')).toBe(
      false,
    );
    expect(tools.some((tool) => tool.name === 'signal_add_group_members')).toBe(
      false,
    );
    expect(tools.some((tool) => tool.name === 'signal_list_groups')).toBe(
      false,
    );
    expect(tools.some((tool) => tool.name === 'signal_leave_group')).toBe(
      false,
    );
    expect(tools.some((tool) => tool.name === 'whatsapp_create_group')).toBe(
      false,
    );
    expect(
      tools.some((tool) => tool.name === 'whatsapp_add_group_members'),
    ).toBe(false);
    expect(tools.some((tool) => tool.name === 'whatsapp_list_groups')).toBe(
      false,
    );
    expect(tools.some((tool) => tool.name === 'whatsapp_leave_group')).toBe(
      false,
    );

    expect(
      tools.find((tool) => tool.name === 'signal.create_group')?.sourceKind,
    ).toBe('integration');
    expect(
      tools.find((tool) => tool.name === 'whatsapp.create_group')?.sourceKind,
    ).toBe('integration');
  });

  it('surfaces calendar tools from the integration registry instead of runner core', () => {
    const tools = buildEffectiveToolRegistry({ store });
    expect(tools.some((tool) => tool.name === 'calendar_list_events')).toBe(
      true,
    );
    expect(
      tools.find((tool) => tool.name === 'calendar_list_events')?.sourceKind,
    ).toBe('integration');
    expect(
      tools.find((tool) => tool.name === 'calendar_check_availability')
        ?.sourceKind,
    ).toBe('integration');
  });

  it('allows disabling external access for a specific tool', () => {
    const policy = store.getPolicy();
    policy.toolAccess = {
      internalToolsEnabled: true,
      externalToolsEnabled: true,
      updatedAt: new Date().toISOString(),
      tools: {
        web_search: { enabled: false },
      },
    };
    store.savePolicy(policy);

    const tools = buildEffectiveToolRegistry({ store });
    const webSearch = tools.find((tool) => tool.name === 'web_search');
    expect(webSearch?.enabled).toBe(false);
    expect(webSearch?.internalEnabled).toBe(false);
    expect(webSearch?.externalEnabled).toBe(false);
  });

  it('writes a session snapshot filtered by lane and scheduled-task policy', () => {
    const snapshot = buildSessionToolRegistrySnapshot({
      groupFolder: 'main',
      isMain: true,
      controllerTriggered: true,
      scheduledTaskMode: true,
      store,
    });

    expect(snapshot.allowedToolNames).toContain('schedule_task');
    expect(snapshot.allowedToolNames).toContain('web_search');
    expect(snapshot.allowedToolNames).toContain('calendar_list_events');
    expect(snapshot.allowedToolNames).toContain('calendar_check_availability');
    expect(snapshot.allowedToolNames).not.toContain('signal.send_message');
    expect(snapshot.allowedToolNames).toContain('signal.create_group');
    expect(snapshot.allowedToolNames).toContain('whatsapp.create_group');
    expect(snapshot.allowedToolNames).not.toContain('signal_create_group');
    expect(snapshot.allowedToolNames).not.toContain('whatsapp_create_group');
    expect(snapshot.integrationManifest.map((tool) => tool.name)).toEqual([
      'signal.reply',
      'signal.create_group',
      'signal.list_groups',
      'signal.leave_group',
      'calendar_list_events',
      'calendar_check_availability',
      'whatsapp.create_group',
      'whatsapp.list_groups',
      'whatsapp.leave_group',
    ]);
  });
});
