import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../feature-flags.js', () => ({
  featureFlags: {
    enableNewActionEngine: true,
    enableRunspecRunners: true,
    enablePrincipalPolicy: true,
    enableSkillRegistryV2: true,
    enableContextAssembler: true,
    enableDedupeV2: true,
  },
}));

import {
  _closeDatabase,
  _initTestDatabase,
  getActionRecord,
  listArtifactsForTask,
} from '../../db.js';
import type { NewMessage, RegisteredGroup } from '../../types.js';
import { ArtifactStore } from '../artifacts/store.js';
import { RunSpecDispatcher } from '../../dispatcher/runspec-dispatcher.js';
import { LegacyWrappedActionEngine } from './action-engine.js';

function makeMessage(): NewMessage {
  return {
    id: 'msg-runspec',
    chat_jid: 'signal:user:+15559990000',
    sender: '+15559990000',
    sender_name: 'External User',
    content: 'Can you draft a follow-up?',
    timestamp: '2026-04-16T00:00:00.000Z',
  };
}

const externalGroup: RegisteredGroup = {
  name: 'Client',
  folder: 'client',
  trigger: '@Andy',
  added_at: '2026-04-16T00:00:00.000Z',
  requiresTrigger: true,
};

describe('LegacyWrappedActionEngine RunSpec path', () => {
  afterEach(() => {
    try {
      _closeDatabase();
    } catch {
      // ignored
    }
  });

  it('routes a safe compute-only action through RunSpec runners and stores artifacts', async () => {
    _initTestDatabase();
    const artifactRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-runspec-engine-'),
    );
    const artifactStore = new ArtifactStore(artifactRoot);
    const dispatcher = new RunSpecDispatcher({ artifactStore });
    const onOutput = vi.fn(async () => {});
    const engine = new LegacyWrappedActionEngine(
      {
        run: vi.fn().mockResolvedValue('success' as const),
      },
      {
        artifactStore,
        runSpecDispatcher: dispatcher,
      },
    );

    const result = await engine.processInbound({
      group: externalGroup,
      chatJid: 'signal:user:+15559990000',
      prompt: 'Draft a concise follow-up about the proposal.',
      missedMessages: [makeMessage()],
      controllerTriggered: false,
      onOutput,
    });

    expect(result.outcome).toBe('success');
    expect(getActionRecord(result.actionId || '')?.type).toBe(
      'draft_reply_from_thread',
    );
    expect(onOutput).toHaveBeenCalledOnce();
    const artifacts = listArtifactsForTask(result.taskId || '');
    expect(artifacts.length).toBeGreaterThan(1);
    const generated = artifacts.find(
      (artifact) => artifact.media_type === 'text/markdown',
    );
    expect(generated).toBeTruthy();
    expect(generated && artifactStore.readArtifact(generated)).toContain(
      'Draft Reply',
    );
  });
});
