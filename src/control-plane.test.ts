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

  it('supports approval-gated outbound sends for new conversations', async () => {
    const harness = createHarness();
    const sendSignalMessage = vi.fn().mockResolvedValue(undefined);
    harness.service.setOutboundHandlers({ sendSignalMessage });

    const pending = harness.service.previewAction(
      'outbound.send',
      {
        channel: 'signal',
        target: '+15552223333',
        message: 'Hello there',
        resolvedSignalJid: 'signal:user:+15552223333',
        requiresConfirmation: true,
      },
      { actorIdentity: 'agent:nanoclaw', source: 'agent' },
    );

    expect(pending.summary).toContain('Start a new signal conversation');

    await harness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const approval = await harness.service.approvePending(pending.id, {
      actorIdentity: '+15550001111',
      source: 'signal_control',
    });

    expect(approval.message).toContain('Approved');
    expect(sendSignalMessage).toHaveBeenCalledWith(
      'signal:user:+15552223333',
      'Hello there',
    );
  });

  it('supports approval-gated Signal group creation', async () => {
    const harness = createHarness();
    const createSignalGroup = vi.fn().mockResolvedValue({
      jid: 'signal:group:lunch123',
      title: 'Lunch plans',
    });
    harness.service.setOutboundHandlers({ createSignalGroup });

    const pending = harness.service.previewAction(
      'outbound.createGroup',
      {
        channel: 'signal',
        title: 'Lunch plans',
        message: 'Can we do lunch next Monday?',
        members: ['Elyssa'],
        resolvedMemberTargets: ['+15552223333'],
        resolvedMemberDisplayNames: ['Elyssa'],
      },
      { actorIdentity: 'agent:nanoclaw', source: 'agent' },
    );

    await harness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const approval = await harness.service.approvePending(pending.id, {
      actorIdentity: '+15550001111',
      source: 'signal_control',
    });

    expect(approval.message).toContain('Approved');
    expect(createSignalGroup).toHaveBeenCalledWith({
      title: 'Lunch plans',
      members: ['+15552223333'],
      message: 'Can we do lunch next Monday?',
    });
  });

  it('lists pending approvals through the shared service and signal command surface', async () => {
    const harness = createHarness();
    harness.service.previewAction(
      'outbound.delete',
      {
        channel: 'email',
        target: 'Draft to Sam',
        reason: 'duplicate draft',
      },
      { actorIdentity: 'agent:nanoclaw', source: 'agent' },
    );

    expect(harness.service.listPendingActions(10)).toHaveLength(1);

    await harness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const result = await harness.parser.handle(
      'signal:user:+15550009999',
      makeMessage('+15550001111', '/pending list 5'),
    );

    expect(result.handled).toBe(true);
    expect(harness.sent.at(-1)?.text).toContain('Draft to Sam');
  });

  it('approves a single pending action from a natural yes reply in the same chat', async () => {
    const harness = createHarness();
    const sendSignalMessage = vi.fn().mockResolvedValue(undefined);
    harness.service.setOutboundHandlers({ sendSignalMessage });
    harness.service.setApprovalReplyClassifier(async () => ({
      decision: 'approve',
      reason: 'The user clearly approved sending it.',
    }));

    const pending = harness.service.previewAction(
      'outbound.send',
      {
        channel: 'signal',
        target: '+15552223333',
        message: 'Hello there',
        resolvedSignalJid: 'signal:user:+15552223333',
        requiresConfirmation: true,
      },
      { actorIdentity: 'agent:nanoclaw', source: 'agent' },
      { chatJid: 'signal:user:+15550009999' },
    );

    await harness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const result = await harness.service.handleNaturalApprovalReply(
      'signal:user:+15550009999',
      'yeah, go ahead and send that',
      { actorIdentity: '+15550001111', source: 'signal_control' },
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain(`Approved ${pending.summary}`);
    expect(sendSignalMessage).toHaveBeenCalledWith(
      'signal:user:+15552223333',
      'Hello there',
    );
  });

  it('keeps a pending action open when the follow-up reply asks for revisions', async () => {
    const harness = createHarness();
    const sendSignalMessage = vi.fn().mockResolvedValue(undefined);
    harness.service.setOutboundHandlers({ sendSignalMessage });
    harness.service.setApprovalReplyClassifier(async () => ({
      decision: 'revise',
      reason: 'The user asked to make it friendlier before sending.',
    }));

    const pending = harness.service.previewAction(
      'outbound.send',
      {
        channel: 'signal',
        target: '+15552223333',
        message: 'Hello there',
        resolvedSignalJid: 'signal:user:+15552223333',
        requiresConfirmation: true,
      },
      { actorIdentity: 'agent:nanoclaw', source: 'agent' },
      { chatJid: 'signal:user:+15550009999' },
    );

    await harness.service.executeAction(
      'verified.add',
      { identity: '+15550001111', label: 'Owner' },
      { actorIdentity: 'ui:local-admin', source: 'ui' },
    );

    const result = await harness.service.handleNaturalApprovalReply(
      'signal:user:+15550009999',
      'make it a bit friendlier first',
      { actorIdentity: '+15550001111', source: 'signal_control' },
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('I kept that pending');
    expect(sendSignalMessage).not.toHaveBeenCalled();
    expect(
      harness.service
        .listPendingActions()
        .find((item) => item.id === pending.id)?.status,
    ).toBe('pending');
  });

  it('treats Signal UUID identities consistently across raw and signal:user forms', () => {
    const uuid = '5396f050-7ac2-4610-8c5f-c8f1be353fec';

    expect(canonicalizeIdentity(uuid)).toBe(`signal-user:${uuid}`);
    expect(canonicalizeIdentity(`signal:user:${uuid}`)).toBe(
      `signal-user:${uuid}`,
    );
    expect(identitiesMatch(uuid, `signal:user:${uuid}`)).toBe(true);
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
});
