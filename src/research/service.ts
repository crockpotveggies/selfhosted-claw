import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import {
  createActionRecord,
  createArtifactRecord,
  createAuditLogRecord,
  createCoreTask,
  createPrincipal,
  createRunRecord,
  getActionRecord,
  getCoreTask,
  getLatestActionForThreadByType,
  getPrincipal,
  listActionsByType,
  listArtifactsForAction,
  setChatPendingFollowupActionId,
  updateActionRecordStatus,
  updateActionResearchState,
  updateRunRecord,
} from '../db.js';
import { logger } from '../logger.js';
import { findChannel } from '../router.js';
import type { Channel } from '../types.js';
import { getIntegrationSettings } from '../integrations/settings-store.js';
import type { RunSpecDispatcher } from '../dispatcher/runspec-dispatcher.js';
import { createSimplePdf } from './pdf.js';
import { callJsonChatCompletion } from './openai.js';
import {
  BraveProvider,
  FixtureProvider,
  type FixtureProviderFixture,
  type ResearchFetchResult,
  type ResearchProvider,
} from './providers.js';
import { deterministicTopicSlug, ensureTopicSlug } from './slug.js';

const SYSTEM_RESEARCH_PRINCIPAL_ID = 'principal-system-deep-research';
const DEFAULT_ATTACHMENT_CAP_BYTES = 25_000_000;
let activeResearchRuns = 0;

interface ResearchPlan {
  topic_slug: string;
  objectives: string[];
  subqueries: string[];
  needs_followup: boolean;
  followup_questions: string[];
}

interface ResearchProgress {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  followupAnswers?: string[];
  requestedByPrincipalId?: string | null;
  requestedBySender?: string | null;
  requestedBySenderName?: string | null;
  topicSlug?: string;
  plan?: ResearchPlan;
  sources?: Array<{
    url: string;
    title: string;
    fetched_at: string;
    content_hash: string;
  }>;
  summaryBullets?: string[];
  reportPath?: string;
  startedAt?: string;
  completedAt?: string;
  searchCalls?: number;
  fetchCalls?: number;
  statusMessage?: string;
  deadlineAt?: string;
}

export interface DeepResearchStartInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  principalId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
}

interface DeepResearchRuntime {
  sendMessage: (jid: string, text: string) => Promise<void>;
  channels: () => Channel[];
  runSpecDispatcher?: RunSpecDispatcher;
}

function ensureSystemResearchPrincipal(): string {
  if (!getPrincipal(SYSTEM_RESEARCH_PRINCIPAL_ID)) {
    createPrincipal({
      id: SYSTEM_RESEARCH_PRINCIPAL_ID,
      type: 'system',
      display_name: 'Deep Research',
      trust_tier: 'trusted',
      status: 'active',
      created_at: new Date().toISOString(),
    });
  }
  return SYSTEM_RESEARCH_PRINCIPAL_ID;
}

function getResearchSettings() {
  const settings = getIntegrationSettings('deep-research');
  return {
    defaultProvider: String(settings.defaultProvider || 'brave'),
    braveApiKey: String(settings.braveApiKey || process.env.BRAVE_API_KEY || ''),
    maxRuntimeMs: Math.max(
      60_000,
      Number(settings.maxRuntimeMs) || 20 * 60 * 1000,
    ),
    maxConcurrency: Math.max(1, Number(settings.maxConcurrency) || 2),
    maxSearchCallsPerJob: Math.max(1, Number(settings.maxSearchCallsPerJob) || 30),
    maxFetchesPerJob: Math.max(1, Number(settings.maxFetchesPerJob) || 40),
    dailyProviderQuota: Math.max(1, Number(settings.dailyProviderQuota) || 250),
    maxFollowups: Math.max(0, Number(settings.maxFollowups) || 2),
    progressPingIntervalMs: Math.max(
      10_000,
      Number(settings.progressPingIntervalMs) || 60_000,
    ),
    attachmentSizeCapBytes: Math.max(
      1_000_000,
      Number(settings.attachmentSizeCapBytes) || DEFAULT_ATTACHMENT_CAP_BYTES,
    ),
    allowedPrincipalTypes: Array.isArray(settings.allowedPrincipalTypes)
      ? settings.allowedPrincipalTypes.map(String)
      : ['controller'],
    domainAllowlist: Array.isArray(settings.domainAllowlist)
      ? settings.domainAllowlist.map(String).filter(Boolean)
      : [],
    domainBlocklist: Array.isArray(settings.domainBlocklist)
      ? settings.domainBlocklist.map(String).filter(Boolean)
      : [],
    fixturePath: String(settings.fixturePath || ''),
  };
}

function parseProgress(actionId: string): ResearchProgress {
  const action = getActionRecord(actionId);
  if (!action?.progress_json) {
    throw new Error(`Missing research progress for action ${actionId}`);
  }
  return JSON.parse(action.progress_json) as ResearchProgress;
}

function stringifyProgress(progress: ResearchProgress): string {
  return JSON.stringify(progress);
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8" /><title>Deep Research Report</title>',
    '<style>body{font-family:Georgia,serif;line-height:1.5;margin:48px auto;max-width:780px;color:#111}h1,h2,h3{font-family:Arial,sans-serif}code{background:#f3f3f3;padding:2px 4px;border-radius:4px}ul{padding-left:24px}blockquote{border-left:4px solid #ddd;padding-left:12px;color:#555}</style>',
    '</head><body>',
  ];

  let inList = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      continue;
    }
    if (trimmed.startsWith('# ')) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      html.push(`<h1>${trimmed.slice(2)}</h1>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      html.push(`<h2>${trimmed.slice(3)}</h2>`);
      continue;
    }
    if (trimmed.startsWith('### ')) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      html.push(`<h3>${trimmed.slice(4)}</h3>`);
      continue;
    }
    if (trimmed.startsWith('- ')) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${trimmed.slice(2)}</li>`);
      continue;
    }
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    html.push(`<p>${trimmed}</p>`);
  }
  if (inList) {
    html.push('</ul>');
  }
  html.push('</body></html>');
  return html.join('\n');
}

function recordWorkspaceArtifact(input: {
  actionId: string;
  taskId: string;
  kind: string;
  mediaType: string;
  filePath: string;
}): void {
  const buffer = fs.readFileSync(input.filePath);
  createArtifactRecord({
    id: randomUUID(),
    task_id: input.taskId,
    action_id: input.actionId,
    kind: input.kind,
    path: input.filePath,
    media_type: input.mediaType,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size_bytes: buffer.byteLength,
    created_by_run_id: null,
    created_at: new Date().toISOString(),
  });
}

function buildProvider(): ResearchProvider {
  const settings = getResearchSettings();
  if (settings.fixturePath) {
    const fixture = JSON.parse(
      fs.readFileSync(settings.fixturePath, 'utf-8'),
    ) as FixtureProviderFixture;
    return new FixtureProvider(fixture);
  }
  if (settings.defaultProvider === 'openai') {
    throw new Error('OpenAI web search provider is not implemented in v1');
  }
  return new BraveProvider(settings.braveApiKey);
}

type DailyUsageAction = {
  created_at: string;
  spend_json?: string | null;
};

export function calculateDailyResearchUsage(
  actions: DailyUsageAction[],
  day: string,
): number {
  return actions
    .filter((candidate) => candidate.created_at.startsWith(day))
    .reduce((total, candidate) => {
      const spend = candidate.spend_json
        ? (JSON.parse(candidate.spend_json) as {
            searchCalls?: number;
            fetchCalls?: number;
          })
        : null;
      return total + (spend?.searchCalls || 0) + (spend?.fetchCalls || 0);
    }, 0);
}

function raceWithTimeout<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(message));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void factory()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export class DeepResearchExecutor {
  constructor(private readonly runtime: DeepResearchRuntime) {}

  async executeAction(actionId: string, runId: string): Promise<void> {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown deep research action ${actionId}`);
    const task = getCoreTask(action.task_id);
    if (!task) throw new Error(`Unknown deep research task ${action.task_id}`);
    const settings = getResearchSettings();
    const provider = buildProvider();
    const progress = parseProgress(actionId);
    const deadlineAtMs = Date.now() + settings.maxRuntimeMs;
    progress.deadlineAt = new Date(deadlineAtMs).toISOString();

    const ensureWithinRuntime = () => {
      if (Date.now() > deadlineAtMs) {
        throw new Error(
          `Deep research exceeded the configured runtime limit of ${Math.round(
            settings.maxRuntimeMs / 1000,
          )} seconds`,
        );
      }
    };
    const remainingRuntimeMs = () => Math.max(1, deadlineAtMs - Date.now());

    if (activeResearchRuns >= settings.maxConcurrency) {
      throw new Error('Deep research concurrency limit reached');
    }
    activeResearchRuns += 1;

    updateActionRecordStatus(actionId, 'executing');
    updateRunRecord(runId, {
      status: 'executing',
      started_at: new Date().toISOString(),
    });

    let lastPingAt = Date.now();
    const maybePing = async (message: string) => {
      if (Date.now() - lastPingAt < settings.progressPingIntervalMs) return;
      lastPingAt = Date.now();
      await this.runtime.sendMessage(progress.chatJid, message);
      progress.statusMessage = message;
      updateActionResearchState(actionId, {
        progressJson: stringifyProgress(progress),
      });
    };

    try {
      updateActionResearchState(actionId, {
        researchSubstate: 'scoping',
        progressJson: stringifyProgress(progress),
      });

      const today = new Date().toISOString().slice(0, 10);
      const dailyUsage = calculateDailyResearchUsage(
        listActionsByType('deep_research', 500),
        today,
      );
      if (dailyUsage >= settings.dailyProviderQuota) {
        throw new Error('Daily deep research provider quota has been exhausted');
      }

      ensureWithinRuntime();
      const scopedPlan = await raceWithTimeout(
        () => this.buildPlan(progress),
        remainingRuntimeMs(),
        'Deep research timed out while preparing the research plan',
      );
      progress.plan = scopedPlan;
      progress.topicSlug = ensureTopicSlug(scopedPlan.topic_slug, progress.prompt);
      updateActionResearchState(actionId, {
        researchSubstate: 'scoping',
        progressJson: stringifyProgress(progress),
      });

      const followupAnswers = progress.followupAnswers || [];
      if (
        scopedPlan.needs_followup &&
        followupAnswers.length === 0 &&
        (action.followup_count ?? 0) < settings.maxFollowups
      ) {
        updateActionRecordStatus(actionId, 'queued');
        updateActionResearchState(actionId, {
          researchSubstate: 'waiting_for_user',
          progressJson: stringifyProgress(progress),
          followupCount: (action.followup_count ?? 0) + 1,
        });
        setChatPendingFollowupActionId(progress.chatJid, actionId);
        await this.runtime.sendMessage(
          progress.chatJid,
          [
            `Deep research needs one clarification before I start ${progress.topicSlug}-report.pdf:`,
            ...scopedPlan.followup_questions.map((question, index) => `${index + 1}. ${question}`),
          ].join('\n'),
        );
        updateRunRecord(runId, {
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          exit_code: 0,
        });
        return;
      }

      updateActionResearchState(actionId, {
        researchSubstate: 'running',
      });

      const citations: Array<{
        url: string;
        title: string;
        fetched_at: string;
        content_hash: string;
      }> = [];
      const sourcePayloads: ResearchFetchResult[] = [];
      const includeDomains = settings.domainAllowlist;
      const excludeDomains = settings.domainBlocklist;
      progress.searchCalls = 0;
      progress.fetchCalls = 0;
      ensureWithinRuntime();
      await this.runtime.sendMessage(
        progress.chatJid,
        `Starting deep research on "${progress.prompt}". I’ll send back ${progress.topicSlug}-report.pdf when it’s ready.`,
      );

      for (const query of scopedPlan.subqueries.slice(
        0,
        settings.maxSearchCallsPerJob,
      )) {
        ensureWithinRuntime();
        progress.searchCalls += 1;
        const results = await raceWithTimeout(
          () =>
            provider.search(query, {
              maxResults: 5,
              includeDomains,
              excludeDomains,
            }),
          remainingRuntimeMs(),
          'Deep research timed out while searching for sources',
        );
        for (const result of results.slice(0, 2)) {
          if (progress.fetchCalls >= settings.maxFetchesPerJob) break;
          ensureWithinRuntime();
          progress.fetchCalls += 1;
          const fetched = await raceWithTimeout(
            () => provider.fetch(result.url),
            remainingRuntimeMs(),
            `Deep research timed out while fetching ${result.url}`,
          );
          sourcePayloads.push({
            ...fetched,
            title: result.title || fetched.title,
          });
          citations.push({
            url: fetched.url,
            title: result.title || fetched.title,
            fetched_at: fetched.fetchedAt,
            content_hash: fetched.contentHash,
          });
          progress.sources = citations;
          updateActionResearchState(actionId, {
            progressJson: stringifyProgress(progress),
            spendJson: JSON.stringify({
              searchCalls: progress.searchCalls,
              fetchCalls: progress.fetchCalls,
            }),
          });
          await maybePing(
            `Still working on the research report — ${progress.fetchCalls} sources processed so far.`,
          );
        }
        if (progress.fetchCalls >= settings.maxFetchesPerJob) break;
      }

      const reportDir = path.join(
        GROUPS_DIR,
        progress.groupFolder,
        'research',
        progress.topicSlug,
      );
      fs.mkdirSync(reportDir, { recursive: true });
      const basePath = path.join(reportDir, `${progress.topicSlug}-report`);
      const sourcesPath = path.join(reportDir, `${progress.topicSlug}-sources.json`);
      const planPath = path.join(reportDir, `${progress.topicSlug}-plan.json`);
      const markdownPath = `${basePath}.md`;
      const htmlPath = `${basePath}.html`;
      const pdfPath = `${basePath}.pdf`;

      fs.writeFileSync(planPath, JSON.stringify(scopedPlan, null, 2), 'utf-8');
      fs.writeFileSync(sourcesPath, JSON.stringify(citations, null, 2), 'utf-8');

      updateActionResearchState(actionId, {
        researchSubstate: 'rendering',
      });

      ensureWithinRuntime();
      const reportPayload = await raceWithTimeout(
        () => this.buildReport(progress, sourcePayloads),
        remainingRuntimeMs(),
        'Deep research timed out while writing the report',
      );
      progress.summaryBullets = reportPayload.summary_bullets;
      const markdown = reportPayload.report_markdown.trim();
      const html = markdownToHtml(markdown);
      const pdf = createSimplePdf(
        [
          progress.prompt,
          '',
          ...reportPayload.summary_bullets.map((bullet) => `- ${bullet}`),
          '',
          markdown,
        ].join('\n'),
      );

      fs.writeFileSync(markdownPath, markdown, 'utf-8');
      fs.writeFileSync(htmlPath, html, 'utf-8');
      fs.writeFileSync(pdfPath, pdf);

      recordWorkspaceArtifact({
        actionId,
        taskId: task.id,
        kind: 'document',
        mediaType: 'text/markdown',
        filePath: markdownPath,
      });
      recordWorkspaceArtifact({
        actionId,
        taskId: task.id,
        kind: 'document',
        mediaType: 'text/html',
        filePath: htmlPath,
      });
      recordWorkspaceArtifact({
        actionId,
        taskId: task.id,
        kind: 'document',
        mediaType: 'application/json',
        filePath: sourcesPath,
      });
      recordWorkspaceArtifact({
        actionId,
        taskId: task.id,
        kind: 'document',
        mediaType: 'application/json',
        filePath: planPath,
      });
      recordWorkspaceArtifact({
        actionId,
        taskId: task.id,
        kind: 'document',
        mediaType: 'application/pdf',
        filePath: pdfPath,
      });

      progress.reportPath = pdfPath;
      progress.completedAt = new Date().toISOString();
      updateActionResearchState(actionId, {
        researchSubstate: 'delivering',
        progressJson: stringifyProgress(progress),
        artifactPathsJson: JSON.stringify({
          report: pdfPath,
          markdown: markdownPath,
          html: htmlPath,
          sources: sourcesPath,
          plan: planPath,
        }),
      });
      setChatPendingFollowupActionId(progress.chatJid, null);

      const channel = findChannel(this.runtime.channels(), progress.chatJid);
      const attachmentCap = Math.min(
        settings.attachmentSizeCapBytes,
        channel?.capabilities?.attachments?.maxBytes ?? settings.attachmentSizeCapBytes,
      );
      const pdfSize = fs.statSync(pdfPath).size;
      const summaryLines = (progress.summaryBullets || [])
        .slice(0, 3)
        .map((line) => `- ${line}`);
      const coverMessage = [
        `Deep research report ready: ${path.basename(pdfPath)}`,
        ...summaryLines,
      ].join('\n');

      if (
        !channel?.sendAttachment ||
        !channel.capabilities?.attachments?.pdf
      ) {
        await this.runtime.sendMessage(
          progress.chatJid,
          `${coverMessage}\n\nThis channel cannot receive PDF attachments. The report is saved at ${pdfPath}.`,
        );
      } else if (pdfSize > attachmentCap) {
        await this.runtime.sendMessage(
          progress.chatJid,
          `${coverMessage}\n\nThe PDF is larger than this channel's attachment limit. It was saved at ${pdfPath}.`,
        );
      } else {
        await this.runtime.sendMessage(progress.chatJid, coverMessage);
        await channel.sendAttachment({
          jid: progress.chatJid,
          filePath: pdfPath,
          mimeType: 'application/pdf',
          fileName: path.basename(pdfPath),
          caption: path.basename(pdfPath),
        });
      }

      updateActionRecordStatus(actionId, 'succeeded');
      updateActionResearchState(actionId, {
        researchSubstate: null,
        progressJson: stringifyProgress(progress),
        spendJson: JSON.stringify({
          searchCalls: progress.searchCalls,
          fetchCalls: progress.fetchCalls,
        }),
      });
      updateRunRecord(runId, {
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        exit_code: 0,
      });
    } catch (error) {
      setChatPendingFollowupActionId(progress.chatJid, null);
      updateActionRecordStatus(actionId, 'failed_terminal');
      updateRunRecord(runId, {
        status: 'failed_terminal',
        finished_at: new Date().toISOString(),
        exit_code: 1,
        error_class: error instanceof Error ? error.name : 'deep_research_error',
      });
      createAuditLogRecord({
        id: randomUUID(),
        principal_id: action.requested_by_principal_id,
        task_id: action.task_id,
        action_id: action.id,
        event_type: 'deep_research.failed',
        payload_json: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        created_at: new Date().toISOString(),
      });
      await this.runtime.sendMessage(
        progress.chatJid,
        `Deep research failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      activeResearchRuns = Math.max(0, activeResearchRuns - 1);
    }
  }

  private async buildPlan(progress: ResearchProgress): Promise<ResearchPlan> {
    const followupContext = (progress.followupAnswers || []).join('\n');
    try {
      const result = await callJsonChatCompletion<ResearchPlan>(
        [
          {
            role: 'system',
            content:
              'You are planning a deep research run. Return JSON with keys topic_slug, objectives, subqueries, needs_followup, and followup_questions. topic_slug must be 1-3 lowercase ASCII words joined by hyphens.',
          },
          {
            role: 'user',
            content: `Research request:\n${progress.prompt}\n\nExisting follow-up answers:\n${followupContext || 'None'}`,
          },
        ],
        { maxTokens: 1200, temperature: 0.2 },
      );
      return {
        topic_slug: ensureTopicSlug(result.topic_slug || '', progress.prompt),
        objectives: Array.isArray(result.objectives)
          ? result.objectives.map(String).filter(Boolean)
          : [],
        subqueries: Array.isArray(result.subqueries)
          ? result.subqueries.map(String).filter(Boolean)
          : [progress.prompt],
        needs_followup: Boolean(result.needs_followup),
        followup_questions: Array.isArray(result.followup_questions)
          ? result.followup_questions.map(String).filter(Boolean).slice(0, 2)
          : [],
      };
    } catch {
      return {
        topic_slug: deterministicTopicSlug(progress.prompt),
        objectives: [progress.prompt],
        subqueries: [progress.prompt],
        needs_followup: false,
        followup_questions: [],
      };
    }
  }

  private async buildReport(
    progress: ResearchProgress,
    sources: ResearchFetchResult[],
  ): Promise<{ summary_bullets: string[]; report_markdown: string }> {
    const serializedSources = sources
      .slice(0, 8)
      .map(
        (source, index) =>
          `Source ${index + 1}: ${source.title}\nURL: ${source.url}\nFetched: ${source.fetchedAt}\n${source.textContent}`,
      )
      .join('\n\n');

    try {
      const result = await callJsonChatCompletion<{
        summary_bullets: string[];
        report_markdown: string;
      }>(
        [
          {
            role: 'system',
            content:
              'Write a research report as JSON with keys summary_bullets and report_markdown. summary_bullets must contain 3 concise bullets. report_markdown should include only sections that have content.',
          },
          {
            role: 'user',
            content:
              `Research request:\n${progress.prompt}\n\n` +
              `Objectives:\n${(progress.plan?.objectives || []).join('\n')}\n\n` +
              `Sources:\n${serializedSources}`,
          },
        ],
        { maxTokens: 3200, temperature: 0.2 },
      );
      return {
        summary_bullets: Array.isArray(result.summary_bullets)
          ? result.summary_bullets.map(String).filter(Boolean).slice(0, 3)
          : ['Research completed.', 'Sources reviewed.', 'Report generated.'],
        report_markdown: String(result.report_markdown || '').trim(),
      };
    } catch {
      const fallbackMarkdown = [
        `# ${progress.prompt}`,
        '',
        '## Findings',
        '',
        ...sources.slice(0, 5).map((source) => `- ${source.title}: ${source.url}`),
        '',
        '## Methodology',
        '',
        `- Reviewed ${sources.length} sources`,
      ].join('\n');
      return {
        summary_bullets: [
          'Research completed',
          `Reviewed ${sources.length} sources`,
          'Report generated successfully',
        ],
        report_markdown: fallbackMarkdown,
      };
    }
  }
}

export class DeepResearchService {
  private readonly executor: DeepResearchExecutor;

  constructor(private readonly runtime: DeepResearchRuntime) {
    this.executor = new DeepResearchExecutor(runtime);
  }

  private kickOff(actionId: string, executionRunId: string): void {
    void (async () => {
      if (this.runtime.runSpecDispatcher) {
        const staged = await this.runtime.runSpecDispatcher.stage(actionId);
        if (staged.result.status !== 'succeeded') {
          throw new Error('Deep research staging failed before execution');
        }
      }
      await this.executor.executeAction(actionId, executionRunId);
    })().catch((error) => {
      const finishedAt = new Date().toISOString();
      updateRunRecord(executionRunId, {
        status: 'failed_terminal',
        finished_at: finishedAt,
        exit_code: 1,
        error_class:
          error instanceof Error ? error.name : 'deep_research_error',
      });
      const action = getActionRecord(actionId);
      if (
        action &&
        (action.status === 'queued' || action.status === 'executing')
      ) {
        updateActionRecordStatus(actionId, 'failed_terminal', {
          updatedAt: finishedAt,
        });
      }
      try {
        const progress = parseProgress(actionId);
        void this.runtime.sendMessage(
          progress.chatJid,
          `Deep research failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // ignored
      }
      logger.error(
        { actionId, err: String(error) },
        'Deep research execution failed',
      );
    });
  }

  async start(input: DeepResearchStartInput): Promise<{
    taskId: string;
    actionId: string;
    runId: string;
  }> {
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const actionId = randomUUID();
    const runId = randomUUID();
    const principalId = input.principalId || ensureSystemResearchPrincipal();

    createCoreTask({
      id: taskId,
      principal_id: principalId,
      source_channel: input.chatJid.split(':', 1)[0] || 'unknown',
      source_thread_id: input.chatJid,
      status: 'open',
      summary: `Deep research: ${input.prompt}`.slice(0, 400),
      created_at: now,
      updated_at: now,
    });
    createActionRecord({
      id: actionId,
      task_id: taskId,
      type: 'deep_research',
      status: 'queued',
      runner_pool: 'trusted',
      permission_profile: 'trusted-ops',
      idempotency_key: null,
      semantic_dedupe_key: null,
      requested_by_principal_id: principalId,
      approved_by_principal_id: principalId,
      research_substate: 'scoping',
      progress_json: stringifyProgress({
        prompt: input.prompt,
        groupFolder: input.groupFolder,
        chatJid: input.chatJid,
        followupAnswers: [],
        requestedByPrincipalId: principalId,
        requestedBySender: input.senderId ?? null,
        requestedBySenderName: input.senderName ?? null,
        startedAt: now,
      }),
      artifact_paths_json: null,
      followup_count: 0,
      spend_json: JSON.stringify({ searchCalls: 0, fetchCalls: 0 }),
      created_at: now,
      updated_at: now,
    });
    createRunRecord({
      id: runId,
      action_id: actionId,
      runner_pool: 'trusted',
      status: 'queued',
      attempt_no: 1,
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_class: null,
    });
    this.kickOff(actionId, runId);
    return { taskId, actionId, runId };
  }

  async answerFollowup(
    actionId: string,
    answer: string,
    senderId?: string | null,
  ): Promise<void> {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown deep research action ${actionId}`);
    const progress = parseProgress(actionId);
    if (
      progress.requestedBySender &&
      senderId &&
      progress.requestedBySender !== senderId
    ) {
      throw new Error('This deep research follow-up must come from the original sender');
    }
    const followupAnswers = [...(progress.followupAnswers || []), answer.trim()];
    progress.followupAnswers = followupAnswers;
    updateActionRecordStatus(actionId, 'queued');
    updateActionResearchState(actionId, {
      researchSubstate: 'scoping',
      progressJson: stringifyProgress(progress),
    });
    setChatPendingFollowupActionId(progress.chatJid, null);
    const runId = randomUUID();
    createRunRecord({
      id: runId,
      action_id: actionId,
      runner_pool: 'trusted',
      status: 'queued',
      attempt_no: 1,
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_class: null,
    });
    this.kickOff(actionId, runId);
  }

  getStatus(actionId: string) {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown deep research action ${actionId}`);
    return {
      action,
      artifacts: listArtifactsForAction(actionId),
      progress: action.progress_json ? JSON.parse(action.progress_json) : null,
    };
  }

  cancel(actionId: string): void {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown deep research action ${actionId}`);
    updateActionRecordStatus(actionId, 'failed_terminal');
    updateActionResearchState(actionId, {
      researchSubstate: null,
    });
    const progress = action.progress_json
      ? (JSON.parse(action.progress_json) as ResearchProgress)
      : null;
    if (progress?.chatJid) {
      setChatPendingFollowupActionId(progress.chatJid, null);
    }
  }

  listJobs(limit = 100) {
    return listActionsByType('deep_research', limit);
  }

  getLatestJobForChat(chatJid: string) {
    return getLatestActionForThreadByType(chatJid, 'deep_research');
  }

  getQuotaSummary() {
    const settings = getResearchSettings();
    const today = new Date().toISOString().slice(0, 10);
    const actions = listActionsByType('deep_research', 500);
    const usedCalls = calculateDailyResearchUsage(actions, today);
    return {
      date: today,
      dailyQuota: settings.dailyProviderQuota,
      usedCalls,
      remainingCalls: Math.max(0, settings.dailyProviderQuota - usedCalls),
      activeRuns: activeResearchRuns,
    };
  }
}

let deepResearchService: DeepResearchService | null = null;

export function initializeDeepResearchService(runtime: DeepResearchRuntime): DeepResearchService {
  deepResearchService = new DeepResearchService(runtime);
  return deepResearchService;
}

export function getDeepResearchService(): DeepResearchService {
  if (!deepResearchService) {
    throw new Error('Deep research service not initialized');
  }
  return deepResearchService;
}
