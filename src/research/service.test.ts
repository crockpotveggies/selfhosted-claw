import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();

describe('deep research service', () => {
  let tempRoot: string;
  let completionQueue: unknown[];
  let settings: Record<string, unknown>;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-test-'));
    fs.mkdirSync(path.join(tempRoot, 'groups', 'test-group'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tempRoot, 'store'), { recursive: true });
    completionQueue = [];
    settings = {
      defaultProvider: 'brave',
      fixturePath: '',
      maxRuntimeMs: 120_000,
      maxConcurrency: 2,
      maxSearchCallsPerJob: 5,
      maxFetchesPerJob: 5,
      dailyProviderQuota: 100,
      maxFollowups: 2,
      progressPingIntervalMs: 10_000,
      attachmentSizeCapBytes: 25_000_000,
      domainAllowlist: [],
      domainBlocklist: [],
      allowedPrincipalTypes: ['controller'],
    };
    process.chdir(tempRoot);
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const db = await import('../db.js');
      db._closeDatabase();
    } catch {
      // ignored
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    process.chdir(repoRoot);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function loadHarness() {
    vi.doMock('../integrations/settings-store.js', () => ({
      getIntegrationSettings: vi.fn(() => settings),
    }));
    vi.doMock('../logger.js', () => {
      const stub = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      return {
        logger: stub,
        createChildLogger: vi.fn(() => stub),
      };
    });
    vi.doMock('./openai.js', () => ({
      callJsonChatCompletion: vi.fn(async () => {
        const next = completionQueue.shift();
        if (next === undefined) {
          throw new Error('No mocked chat completion response queued');
        }
        return next;
      }),
    }));

    const db = await import('../db.js');
    db._initTestDatabase();
    const serviceModule = await import('./service.js');
    return { db, ...serviceModule };
  }

  function writeFixture(fixture: unknown): string {
    const fixturePath = path.join(tempRoot, 'fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), 'utf-8');
    settings.fixturePath = fixturePath;
    return fixturePath;
  }

  it('runs end-to-end, writes workspace artifacts, and sends only the PDF attachment', async () => {
    writeFixture({
      searches: {
        'life in canada': [
          { title: 'Life in Canada', url: 'https://example.com/canada-life' },
        ],
      },
      fetches: {
        'https://example.com/canada-life': {
          url: 'https://example.com/canada-life',
          title: 'Life in Canada',
          contentType: 'text/plain',
          textContent: 'Canada has strong healthcare and high living costs.',
          fetchedAt: '2026-04-18T00:00:00.000Z',
        },
      },
    });
    completionQueue.push(
      {
        topic_slug: 'canada-life',
        objectives: ['Understand daily life in Canada'],
        sections: [
          {
            title: 'Findings',
            angle: 'Summarize life in Canada.',
            key_questions: ['What is notable?'],
          },
        ],
        subqueries: ['life in canada'],
        needs_followup: false,
        followup_questions: [],
      },
      {
        key_points: ['Public services are strong.'],
        notable_quotes: [],
        relevance_notes: 'Directly relevant.',
      },
      {
        section_markdown: [
          '## Findings',
          '',
          'Public services are strong [1].',
        ].join('\n'),
      },
      {
        summary_bullets: [
          'High quality of life',
          'Public healthcare is a major factor',
          'Housing costs vary sharply by region',
        ],
      },
    );

    const sentMessages: string[] = [];
    const sentAttachments: Array<{ filePath: string; mimeType: string }> = [];
    const { initializeDeepResearchService } = await loadHarness();
    const service = initializeDeepResearchService({
      sendMessage: async (_jid, text) => {
        sentMessages.push(text);
      },
      channels: () => [
        {
          name: 'signal',
          capabilities: { attachments: { pdf: true, maxBytes: 25_000_000 } },
          connect: async () => {},
          sendMessage: async () => {},
          sendAttachment: async (input) => {
            sentAttachments.push({
              filePath: input.filePath,
              mimeType: input.mimeType,
            });
          },
          isConnected: () => true,
          ownsJid: (jid) => jid.startsWith('signal:'),
          disconnect: async () => {},
        },
      ],
    });

    const result = await service.start({
      prompt: 'Life in Canada',
      groupFolder: 'test-group',
      chatJid: 'signal:user:+15550001111',
      senderId: 'signal:user:+15550001111',
      senderName: 'Alex',
    });

    await vi.waitFor(() => {
      expect(service.getStatus(result.actionId).action.status).toBe(
        'succeeded',
      );
    });

    const reportDir = path.join(
      tempRoot,
      'groups',
      'test-group',
      'research',
      'canada-life',
    );
    expect(fs.existsSync(path.join(reportDir, 'canada-life-report.pdf'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(reportDir, 'canada-life-report.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(reportDir, 'canada-life-report.html'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(reportDir, 'canada-life-sources.json')),
    ).toBe(true);
    expect(sentAttachments).toHaveLength(1);
    expect(sentAttachments[0]).toMatchObject({
      mimeType: 'application/pdf',
      filePath: path.join(reportDir, 'canada-life-report.pdf'),
    });
    expect(sentMessages.some((message) => message.includes('.md'))).toBe(false);
    expect(sentMessages.some((message) => message.includes('.json'))).toBe(
      false,
    );
  });

  it('stages deep research through the shared RunSpec dispatcher before execution', async () => {
    writeFixture({
      searches: {
        'life in canada': [
          { title: 'Life in Canada', url: 'https://example.com/canada-life' },
        ],
      },
      fetches: {
        'https://example.com/canada-life': {
          url: 'https://example.com/canada-life',
          title: 'Life in Canada',
          contentType: 'text/plain',
          textContent: 'Canada has strong healthcare and high living costs.',
          fetchedAt: '2026-04-18T00:00:00.000Z',
        },
      },
    });
    completionQueue.push(
      {
        topic_slug: 'canada-life',
        objectives: ['Understand daily life in Canada'],
        sections: [
          {
            title: 'Findings',
            angle: 'Summarize life in Canada.',
            key_questions: ['What is notable?'],
          },
        ],
        subqueries: ['life in canada'],
        needs_followup: false,
        followup_questions: [],
      },
      {
        key_points: ['Point one'],
        notable_quotes: [],
        relevance_notes: '',
      },
      {
        section_markdown: '## Findings\n\nBody [1].',
      },
      {
        summary_bullets: ['One', 'Two', 'Three'],
      },
    );

    const stage = vi.fn(async () => ({
      runRecord: {
        id: 'stage-run',
        action_id: 'unused',
        runner_pool: 'trusted',
        status: 'succeeded' as const,
        attempt_no: 1,
        started_at: '2026-04-18T00:00:00.000Z',
        finished_at: '2026-04-18T00:00:01.000Z',
        exit_code: 0,
        error_class: null,
      },
      result: {
        run_id: 'stage-run',
        status: 'succeeded' as const,
        exit_code: 0,
        artifacts: [],
        stdout_tail: 'ok',
        stderr_tail: '',
      },
    }));

    const { initializeDeepResearchService } = await loadHarness();
    const service = initializeDeepResearchService({
      sendMessage: async () => {},
      channels: () => [],
      runSpecDispatcher: { stage } as never,
    });

    const result = await service.start({
      prompt: 'Life in Canada',
      groupFolder: 'test-group',
      chatJid: 'signal:user:+15550001111',
    });

    await vi.waitFor(() => {
      expect(service.getStatus(result.actionId).action.status).toBe(
        'succeeded',
      );
    });
    expect(stage).toHaveBeenCalledWith(result.actionId);
  });

  it('falls back to a text message when the channel cannot receive PDFs', async () => {
    writeFixture({
      searches: {
        'life in canada': [
          { title: 'Life in Canada', url: 'https://example.com/canada-life' },
        ],
      },
      fetches: {
        'https://example.com/canada-life': {
          url: 'https://example.com/canada-life',
          title: 'Life in Canada',
          contentType: 'text/plain',
          textContent: 'Canada has strong healthcare and high living costs.',
          fetchedAt: '2026-04-18T00:00:00.000Z',
        },
      },
    });
    completionQueue.push(
      {
        topic_slug: 'canada-life',
        objectives: ['Understand daily life in Canada'],
        sections: [
          {
            title: 'Findings',
            angle: 'Summarize life in Canada.',
            key_questions: ['What is notable?'],
          },
        ],
        subqueries: ['life in canada'],
        needs_followup: false,
        followup_questions: [],
      },
      {
        key_points: ['Point one'],
        notable_quotes: [],
        relevance_notes: '',
      },
      {
        section_markdown: '## Findings\n\nBody [1].',
      },
      {
        summary_bullets: ['Summary one', 'Summary two', 'Summary three'],
      },
    );

    const sentMessages: string[] = [];
    const sendAttachment = vi.fn();
    const { initializeDeepResearchService } = await loadHarness();
    const service = initializeDeepResearchService({
      sendMessage: async (_jid, text) => {
        sentMessages.push(text);
      },
      channels: () => [
        {
          name: 'sms',
          connect: async () => {},
          sendMessage: async () => {},
          sendAttachment,
          isConnected: () => true,
          ownsJid: (jid) => jid.startsWith('sms:'),
          disconnect: async () => {},
        },
      ],
    });

    const result = await service.start({
      prompt: 'Life in Canada',
      groupFolder: 'test-group',
      chatJid: 'sms:+15550001111',
    });

    await vi.waitFor(() => {
      expect(service.getStatus(result.actionId).action.status).toBe(
        'succeeded',
      );
    });

    expect(sendAttachment).not.toHaveBeenCalled();
    expect(
      sentMessages.some((message) =>
        message.includes('cannot receive PDF attachments'),
      ),
    ).toBe(true);
  });

  it('waits for follow-up, persists the marker, and resumes only for the original sender', async () => {
    writeFixture({
      searches: {
        'life in canada for newcomers': [
          { title: 'Newcomers', url: 'https://example.com/newcomers' },
        ],
      },
      fetches: {
        'https://example.com/newcomers': {
          url: 'https://example.com/newcomers',
          title: 'Newcomers',
          contentType: 'text/plain',
          textContent: 'Newcomers often compare housing, jobs, and healthcare.',
          fetchedAt: '2026-04-18T00:00:00.000Z',
        },
      },
    });
    completionQueue.push(
      {
        topic_slug: 'canada-life',
        objectives: ['Clarify the audience'],
        sections: [],
        subqueries: ['life in canada'],
        needs_followup: true,
        followup_questions: ['Should this focus on newcomers or retirees?'],
      },
      {
        topic_slug: 'canada-life',
        objectives: ['Focus on newcomers'],
        sections: [
          {
            title: 'Findings',
            angle: 'Newcomer perspective.',
            key_questions: ['What matters most to newcomers?'],
          },
        ],
        subqueries: ['life in canada for newcomers'],
        needs_followup: false,
        followup_questions: [],
      },
      {
        key_points: ['Point one'],
        notable_quotes: [],
        relevance_notes: '',
      },
      {
        section_markdown: '## Findings\n\nBody [1].',
      },
      {
        summary_bullets: ['Summary one', 'Summary two', 'Summary three'],
      },
    );

    const { db, initializeDeepResearchService } = await loadHarness();
    const service = initializeDeepResearchService({
      sendMessage: async () => {},
      channels: () => [],
    });

    const result = await service.start({
      prompt: 'Life in Canada',
      groupFolder: 'test-group',
      chatJid: 'signal:user:+15550001111',
      senderId: 'signal:user:+15550001111',
    });

    await vi.waitFor(() => {
      expect(service.getStatus(result.actionId).action.research_substate).toBe(
        'waiting_for_user',
      );
    });
    expect(db.getChatPendingFollowupActionId('signal:user:+15550001111')).toBe(
      result.actionId,
    );

    const restartedService = initializeDeepResearchService({
      sendMessage: async () => {},
      channels: () => [],
    });

    await expect(
      restartedService.answerFollowup(
        result.actionId,
        'Focus on newcomers',
        'signal:user:+15550002222',
      ),
    ).rejects.toThrow(/original sender/);

    await restartedService.answerFollowup(
      result.actionId,
      'Focus on newcomers',
      'signal:user:+15550001111',
    );

    await vi.waitFor(() => {
      expect(restartedService.getStatus(result.actionId).action.status).toBe(
        'succeeded',
      );
    });
  });
});
