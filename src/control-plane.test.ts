import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactView, ControlActionService } from './control-actions.js';
import { SignalControlCommandParser } from './control-commands.js';
import { canonicalizeIdentity } from './control-identities.js';
import { ControlStore } from './control-store.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import { SignalComposeManager } from './signal-compose.js';
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
  const composeManager = new SignalComposeManager({
    composeDir: path.join(root, 'signal-compose'),
    dataDir: path.join(dataDir, 'signal-compose'),
    runner: (args) => {
      if (args.includes('ps')) {
        return {
          stdout: 'signal-cli\n',
          stderr: '',
          status: 0,
        };
      }
      return {
        stdout: 'started\n',
        stderr: '',
        status: 0,
      };
    },
  });
  fs.mkdirSync(composeManager.composeDir, { recursive: true });
  fs.writeFileSync(
    path.join(composeManager.composeDir, 'docker-compose.yml'),
    'services:\n  signal-cli:\n    image: example\n',
  );
  const service = new ControlActionService(store, composeManager);
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
    expect(
      fs.existsSync(path.join(harness.root, 'signal-compose', '.env')),
    ).toBe(true);
  });
});
