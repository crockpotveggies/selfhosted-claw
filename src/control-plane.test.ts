import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactView, ControlActionService } from './control-actions.js';
import { SignalControlCommandParser } from './control-commands.js';
import { canonicalizeIdentity, identitiesMatch } from './control-identities.js';
import { ControlStore } from './control-store.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import { setComposeRunner } from './integrations/service-manager.js';
import './integrations/index.js'; // Register signal integration for tests
import { NewMessage, RegisteredGroup } from './types.js';

function makeMessage(sender: string, content: string): NewMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: 'signal:user:+15550009999',
    sender,
    sender_name: sender,
    content,
    timestamp: new Date().toISOString(),
  };
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-'));
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const groupsDir = path.join(root, 'groups');
  fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
  fs.mkdirSync(path.join(groupsDir, 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(groupsDir, 'global', 'AGENT.md'),
    '# Base global\n',
  );
  fs.writeFileSync(path.join(groupsDir, 'main', 'AGENT.md'), '# Base main\n');
  process.env.SELF_HOSTED_CLAW_GROUPS_DIR = groupsDir;

  _initTestDatabase();
  const store = new ControlStore(configDir, dataDir);
  // Mock the Docker compose runner for the integration service manager
  setComposeRunner((args) => {
    if (args.includes('ps')) {
      return { stdout: 'signal-cli\n', stderr: '', status: 0 };
    }
    return { stdout: 'started\n', stderr: '', status: 0 };
  });
  const service = new ControlActionService(store);
  const sent: Array<{ jid: string; text: string }> = [];
  const parser = new SignalControlCommandParser({
    service,
    sendMessage: async (jid, text) => {
      sent.push({ jid, text });
    },
    registeredGroups: () =>
      ({
        'signal:user:+15550009999': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          isMain: true,
        },
      }) satisfies Record<string, RegisteredGroup>,
  });

  return { root, configDir, dataDir, groupsDir, store, service, parser, sent };
}

afterEach(() => {
  delete process.env.SELF_HOSTED_CLAW_GROUPS_DIR;
  vi.unstubAllGlobals();
  _closeDatabase();
});

describe('control plane parity', () => {
  it('rejects Signal control commands from unverified identities', async () => {
    const harness = createHarness();

    const result = await harness.parser.handle(
      'signal:user:+15550009999',
      makeMessage('+15551112222', '/policy show'),
    );

    expect(result.handled).toBe(true);
    expect(harness.sent.at(-1)?.text).toContain('not owner-verified');
  });

  it('produces the same contact state through UI and Signal surfaces', async () => {
    const uiHarness = createHarness();
    const signalHarness = createHarness();

    await signalHarness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const uiContact = await uiHarness.service.executeAction<
      { identity: string },
      ContactView
    >(
      'contact.trust',
      { identity: '+15552223333' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const signalResult = await signalHarness.parser.handle(
      'signal:user:+15550009999',
      makeMessage('+15550001111', '/contact trust +15552223333'),
    );

    expect(signalResult.handled).toBe(true);
    const signalContact = signalHarness.service.getContact('+15552223333');
    expect(signalContact).toBeTruthy();
    expect(signalContact?.status).toBe(uiContact.status);
    expect(signalContact?.trustSource).toBe(uiContact.trustSource);
    expect(signalContact?.manualOverride).toBe(uiContact.manualOverride);
  });

  it('supports preview plus approval for Signal personality changes and updates AGENT.md', async () => {
    const harness = createHarness();
    await harness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    await harness.parser.handle(
      'signal:user:+15550009999',
      makeMessage(
        '+15550001111',
        '/personality set global tone calm and careful',
      ),
    );

    const pendingMessage = harness.sent.at(-1)?.text || '';
    const pendingId = pendingMessage.match(/ID: (\S+)/)?.[1];
    expect(pendingId).toBeTruthy();

    await harness.parser.handle(
      'signal:user:+15550009999',
      makeMessage('+15550001111', `/approve ${pendingId}`),
    );

    const agentPath = path.join(harness.groupsDir, 'global', 'AGENT.md');
    const content = fs.readFileSync(agentPath, 'utf-8');
    expect(content).toContain('Tone: calm and careful');
    expect(content).toContain('SELF_HOSTED_CLAW_PERSONALITY');
  });

  it('records audit source separately for UI and Signal actions', async () => {
    const harness = createHarness();
    await harness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );
    await harness.service.executeAction(
      'policy.pauseProvider',
      { provider: 'sms' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );
    await harness.parser.handle(
      'signal:user:+15550009999',
      makeMessage('+15550001111', '/policy pause-outbound signal'),
    );

    const audit = harness.service.getAuditRecords(10);
    expect(audit.some((record) => record.source === 'ui')).toBe(true);
    expect(audit.some((record) => record.source === 'signal_control')).toBe(
      true,
    );
  });

  it('starts managed Signal compose through the shared control action surface', async () => {
    const harness = createHarness();

    const result = await harness.service.executeAction<
      { account: string; rpcUrl: string },
      { running: boolean }
    >(
      'signal.composeUp',
      {
        account: '+15551112222',
        rpcUrl: 'http://127.0.0.1:8080',
      },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    expect(result.running).toBe(true);
  });

  it('updates the Signal profile through the shared control action surface', async () => {
    const harness = createHarness();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 204,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await harness.service.executeAction<
      {
        account: string;
        name: string;
        about: string;
        avatarDataUrl: string;
      },
      { account: string; name: string; about: string; avatarDataUrl: string }
    >(
      'signal.profile.update',
      {
        account: '+15551112222',
        name: 'Lena',
        about: 'Helping from home',
        avatarDataUrl: 'data:image/png;base64,abc123',
      },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(requestInit?.body)).base64_avatar).toBe('abc123');
    expect(result.name).toBe('Lena');
    expect(result.about).toBe('Helping from home');
    expect(result.avatarDataUrl).toBe('data:image/png;base64,abc123');
    expect(harness.service.getSignalProfile().name).toBe('Lena');
  });

  // Outbound action tests removed — outbound.send, outbound.createGroup,
  // outbound.updateGroup, outbound.delete replaced by channel-specific
  // integration tools (signal.send_message, whatsapp.send_message, etc.)

  it('treats Signal UUID identities consistently across raw and signal:user forms', () => {
    const uuid = '5396f050-7ac2-4610-8c5f-c8f1be353fec';

    expect(canonicalizeIdentity(uuid)).toBe(`signal-user:${uuid}`);
    expect(canonicalizeIdentity(`signal:user:${uuid}`)).toBe(
      `signal-user:${uuid}`,
    );
    expect(identitiesMatch(uuid, `signal:user:${uuid}`)).toBe(true);
  });

  it('treats Slack identities consistently across slack:user and slack-user forms', () => {
    expect(canonicalizeIdentity('slack:user:U123ABC456')).toBe(
      'slack-user:U123ABC456',
    );
    expect(canonicalizeIdentity('slack-user:u123abc456')).toBe(
      'slack-user:U123ABC456',
    );
    expect(
      identitiesMatch('slack:user:U123ABC456', 'slack-user:u123abc456'),
    ).toBe(true);
  });

  it('accepts control commands when the configured control chat uses a Signal UUID jid', async () => {
    const harness = createHarness();
    await harness.service.executeAction(
      'verified.add',
      {
        identity: '5396f050-7ac2-4610-8c5f-c8f1be353fec',
        label: 'Owner UUID',
      },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );
    await harness.service.executeAction(
      'settings.update',
      {
        controlSignalJid: 'signal:user:5396f050-7ac2-4610-8c5f-c8f1be353fec',
      },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const result = await harness.parser.handle(
      'signal:user:5396f050-7ac2-4610-8c5f-c8f1be353fec',
      makeMessage('5396f050-7ac2-4610-8c5f-c8f1be353fec', '/policy show'),
    );

    expect(result.handled).toBe(true);
    expect(harness.sent.at(-1)?.text).toContain('No providers are paused.');
  });

  it('accepts legacy stored verified identities that use compact signal uuids', async () => {
    const harness = createHarness();
    harness.store.saveVerifiedIdentities([
      {
        identity: 'signal-user:5396f0507ac246108c5fc8f1be353fec',
        label: 'Owner UUID',
        addedAt: new Date().toISOString(),
      },
    ]);
    await harness.service.executeAction(
      'settings.update',
      {
        controlSignalJid: 'signal:user:5396f0507ac246108c5fc8f1be353fec',
      },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const result = await harness.parser.handle(
      'signal:user:5396f050-7ac2-4610-8c5f-c8f1be353fec',
      makeMessage('5396f050-7ac2-4610-8c5f-c8f1be353fec', '/policy show'),
    );

    expect(result.handled).toBe(true);
    expect(harness.sent.at(-1)?.text).toContain('No providers are paused.');
  });

  it('accepts verified owner commands from direct Signal chats even when the chat jid form changes', async () => {
    const harness = createHarness();
    harness.store.saveVerifiedIdentities([
      {
        identity: 'phone:+15550001111',
        label: 'Owner phone',
        addedAt: new Date().toISOString(),
      },
    ]);
    await harness.service.executeAction(
      'settings.update',
      {
        controlSignalJid: 'signal:user:5396f0507ac246108c5fc8f1be353fec',
      },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const result = await harness.parser.handle(
      'signal:user:+15550001111',
      makeMessage('+15550001111', '/policy show'),
    );

    expect(result.handled).toBe(true);
    expect(harness.sent.at(-1)?.text).toContain('No providers are paused.');
  });

  it('refreshes the stored Google token and retries calendar requests after a 401', async () => {
    const harness = createHarness();
    harness.store.saveGoogleContactsOAuth({
      accessToken: 'expired-stored-token',
      refreshToken: 'refresh-token',
      expiryDate: new Date(0).toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar.events',
      tokenType: 'Bearer',
      connectedAt: new Date().toISOString(),
      oauthState: '',
      oauthStateCreatedAt: '',
    });

    vi.spyOn(
      harness.service as any,
      'loadProviderEnvironment',
    ).mockResolvedValue({
      GOOGLE_CALENDAR_ACCESS_TOKEN: 'stale-direct-token',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/calendar.events',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [{ id: 'evt-1' }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = (await harness.service.calendarListEvents({
      calendarId: 'primary',
      timeMin: '2026-04-13T09:00:00Z',
      timeMax: '2026-04-13T17:00:00Z',
      maxResults: 10,
    })) as { items: Array<{ id: string }> };

    expect(result.items[0].id).toBe('evt-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer stale-direct-token',
    });
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer refreshed-token',
    });
    expect(harness.store.getGoogleContactsOAuth().accessToken).toBe(
      'refreshed-token',
    );
  });
});
