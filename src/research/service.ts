import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MAX_TOKENS,
  OPENAI_MODEL,
} from '../config.js';
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
import { createChildLogger } from '../logger.js';

// Tag every log in this module with `integration: deep-research` so the Logs
// UI can filter for the research pipeline. Previously this module used the
// untagged root logger and the single error call never surfaced in the UI's
// per-integration view.
const log = createChildLogger({ integration: 'deep-research' });
import { findChannel } from '../router.js';
import type { Channel } from '../types.js';
import { getIntegrationSettings } from '../integrations/settings-store.js';
import type { RunSpecDispatcher } from '../dispatcher/runspec-dispatcher.js';
import { createSimplePdf, type PdfImage } from './pdf.js';
import { callJsonChatCompletion } from './openai.js';
import {
  BraveProvider,
  ChainProvider,
  DuckDuckGoProvider,
  ExaProvider,
  FixtureProvider,
  type FixtureProviderFixture,
  type NamedProvider,
  type ResearchCategory,
  type ResearchFetchResult,
  type ResearchProvider,
} from './providers.js';
import { processFirstUsableImage, type ProcessedImage } from './images.js';
import {
  describeImage,
  type ImageDescription,
  type VisionConfig,
} from './vision.js';
import { deterministicTopicSlug, ensureTopicSlug } from './slug.js';

const SYSTEM_RESEARCH_PRINCIPAL_ID = 'principal-system-deep-research';
const DEFAULT_ATTACHMENT_CAP_BYTES = 25_000_000;
let activeResearchRuns = 0;

interface ResearchSection {
  title: string;
  angle: string;
  key_questions: string[];
}

interface PlannedSubquery {
  query: string;
  category?: ResearchCategory;
}

interface ResearchPlan {
  topic_slug: string;
  objectives: string[];
  sections: ResearchSection[];
  subqueries: PlannedSubquery[];
  needs_followup: boolean;
  followup_questions: string[];
}

const VALID_RESEARCH_CATEGORIES = new Set<ResearchCategory>([
  'research paper',
  'news',
  'pdf',
  'company',
  'financial report',
  'github',
  'personal site',
  'tweet',
  'linkedin profile',
]);

function normalizePlannedSubqueries(raw: unknown): PlannedSubquery[] {
  if (!Array.isArray(raw)) return [];
  const out: PlannedSubquery[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const query = item.trim();
      if (query) out.push({ query });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as { query?: unknown; category?: unknown };
      const query = String(obj.query || '').trim();
      if (!query) continue;
      const rawCategory = String(obj.category || '')
        .trim()
        .toLowerCase();
      const category = VALID_RESEARCH_CATEGORIES.has(
        rawCategory as ResearchCategory,
      )
        ? (rawCategory as ResearchCategory)
        : undefined;
      out.push({ query, category });
    }
  }
  return out;
}

interface SourceSummary {
  index: number;
  url: string;
  title: string;
  key_points: string[];
  notable_quotes: string[];
  relevance_notes: string;
  image?: ProcessedImage;
  imageDescription?: ImageDescription;
}

// Total images embedded per report. Each image is capped at ~120 KB so six
// images + ~40 KB of text + PDF overhead stays comfortably under 1 MB.
const MAX_IMAGES_PER_REPORT = 6;

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
    defaultProvider: String(settings.defaultProvider || 'exa'),
    braveApiKey: String(
      settings.braveApiKey || process.env.BRAVE_API_KEY || '',
    ),
    exaApiKey: String(settings.exaApiKey || process.env.EXA_API_KEY || ''),
    maxRuntimeMs: Math.max(
      60_000,
      Number(settings.maxRuntimeMs) || 20 * 60 * 1000,
    ),
    maxConcurrency: Math.max(1, Number(settings.maxConcurrency) || 2),
    maxSearchCallsPerJob: Math.max(
      1,
      Number(settings.maxSearchCallsPerJob) || 30,
    ),
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
    sectionsMin: clampInt(settings.sectionsMin, 5, 1, 20),
    sectionsMax: clampInt(settings.sectionsMax, 8, 1, 20),
    wordsPerSectionMin: clampInt(settings.wordsPerSectionMin, 600, 100, 4000),
    wordsPerSectionMax: clampInt(settings.wordsPerSectionMax, 1200, 100, 4000),
    visionEnabled: settings.visionEnabled !== false,
    visionBaseUrl: String(settings.visionBaseUrl || '').trim(),
    visionApiKey: String(settings.visionApiKey || '').trim(),
    visionModel: String(settings.visionModel || '').trim(),
  };
}

// Resolve the effective vision endpoint, falling through to the main agent
// OPENAI_* configuration when the integration-level overrides are blank.
// Keeps the default zero-config behavior while allowing a user to point
// image classification at a different (e.g. multimodal-capable) endpoint.
function getVisionConfig(
  settings: ReturnType<typeof getResearchSettings>,
): VisionConfig {
  return {
    enabled: settings.visionEnabled,
    baseUrl: settings.visionBaseUrl || OPENAI_BASE_URL,
    apiKey: settings.visionApiKey || OPENAI_API_KEY,
    model: settings.visionModel || OPENAI_MODEL,
  };
}

// Coerce a setting that may be missing, a string, or out of range. Mirrors
// the schema bounds in integrations/deep-research.ts so a malformed
// settings file can't push the prompts into nonsense territory.
function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
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

  // Assemble a chain of every configured provider, with the user's chosen
  // default first. If the primary runs out of quota mid-job or its API key
  // is rejected, the chain falls back to any other provider with a key
  // before giving up. Providers without API keys are skipped entirely so
  // we don't burn latency on guaranteed failures.
  const candidates: NamedProvider[] = [];
  const addExa = () => {
    if (settings.exaApiKey) {
      candidates.push({
        name: 'exa',
        provider: new ExaProvider(settings.exaApiKey),
      });
    }
  };
  const addBrave = () => {
    if (settings.braveApiKey) {
      candidates.push({
        name: 'brave',
        provider: new BraveProvider(settings.braveApiKey),
      });
    }
  };
  if (settings.defaultProvider === 'brave') {
    addBrave();
    addExa();
  } else {
    addExa();
    addBrave();
  }

  // DuckDuckGo is always appended as the final no-key fallback. When both
  // Exa and Brave are unavailable (quota exhausted, keys missing, or their
  // breakers open), the job still completes with DDG-sourced citations.
  candidates.push({
    name: 'duckduckgo',
    provider: new DuckDuckGoProvider(),
  });

  if (candidates.length === 1) {
    return candidates[0].provider;
  }

  return new ChainProvider(candidates, {
    onFailure: (providerName, op, err, breaker) => {
      log.warn(
        {
          provider: providerName,
          op,
          err: err.message,
          consecutiveFailures: breaker.consecutiveFailures,
          circuitOpenedUntil: breaker.openUntil || undefined,
          fallbackOrder: candidates.map((c) => c.name),
        },
        breaker.openUntil > Date.now() &&
          breaker.openedAt &&
          Date.now() - breaker.openedAt < 2000
          ? 'Research provider failed, circuit opened'
          : 'Research provider failed, falling back to next in chain',
      );
    },
    onSkip: (providerName, op, reason) => {
      log.info(
        { provider: providerName, op, reason },
        'Research provider skipped by circuit breaker',
      );
    },
  });
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
      log.info(
        { actionId, chatJid: progress.chatJid, prompt: progress.prompt },
        'Deep research scoping started',
      );
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
        throw new Error(
          'Daily deep research provider quota has been exhausted',
        );
      }

      ensureWithinRuntime();
      const scopedPlan = await raceWithTimeout(
        () => this.buildPlan(progress),
        remainingRuntimeMs(),
        'Deep research timed out while preparing the research plan',
      );
      progress.plan = scopedPlan;
      progress.topicSlug = ensureTopicSlug(
        scopedPlan.topic_slug,
        progress.prompt,
      );
      const categoryCounts: Record<string, number> = {};
      for (const sq of scopedPlan.subqueries) {
        const key = sq.category || '(general)';
        categoryCounts[key] = (categoryCounts[key] || 0) + 1;
      }
      log.info(
        {
          actionId,
          topicSlug: progress.topicSlug,
          sections: scopedPlan.sections.length,
          subqueries: scopedPlan.subqueries.length,
          categoryCounts,
        },
        'Deep research plan ready',
      );
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
        log.info(
          {
            actionId,
            chatJid: progress.chatJid,
            questions: scopedPlan.followup_questions.length,
          },
          'Deep research paused for user clarification',
        );
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
            ...scopedPlan.followup_questions.map(
              (question, index) => `${index + 1}. ${question}`,
            ),
          ].join('\n'),
        );
        updateRunRecord(runId, {
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          exit_code: 0,
        });
        return;
      }

      log.info(
        {
          actionId,
          topicSlug: progress.topicSlug,
          subqueries: scopedPlan.subqueries.length,
          maxSearchCalls: settings.maxSearchCallsPerJob,
          maxFetches: settings.maxFetchesPerJob,
        },
        'Deep research entering running phase',
      );
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
      // NOTE: the "Starting deep research..." acknowledgement is no longer
      // sent from the service. It used to race the agent's own final-text
      // reply within the same turn and caused duplicate user-facing messages
      // (one from here, one from the agent summarising the tool result).
      // The tool itself (deep_research_start) now returns the ack text and
      // instructs the agent to relay it verbatim — single source of truth.
      // Progress pings and final PDF delivery still come from this service
      // because those fire after the turn closes and cannot race.

      for (const subquery of scopedPlan.subqueries.slice(
        0,
        settings.maxSearchCallsPerJob,
      )) {
        ensureWithinRuntime();
        progress.searchCalls += 1;
        const results = await raceWithTimeout(
          () =>
            provider.search(subquery.query, {
              maxResults: 5,
              includeDomains,
              excludeDomains,
              category: subquery.category,
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
      const sourcesPath = path.join(
        reportDir,
        `${progress.topicSlug}-sources.json`,
      );
      const planPath = path.join(reportDir, `${progress.topicSlug}-plan.json`);
      const markdownPath = `${basePath}.md`;
      const htmlPath = `${basePath}.html`;
      const pdfPath = `${basePath}.pdf`;

      fs.writeFileSync(planPath, JSON.stringify(scopedPlan, null, 2), 'utf-8');
      fs.writeFileSync(
        sourcesPath,
        JSON.stringify(citations, null, 2),
        'utf-8',
      );

      log.info(
        {
          actionId,
          topicSlug: progress.topicSlug,
          sources: citations.length,
          searchCalls: progress.searchCalls,
          fetchCalls: progress.fetchCalls,
        },
        'Deep research rendering report',
      );
      updateActionResearchState(actionId, {
        researchSubstate: 'rendering',
      });

      ensureWithinRuntime();
      const reportPayload = await raceWithTimeout(
        () =>
          this.buildReport(progress, sourcePayloads, () => {
            ensureWithinRuntime();
            return remainingRuntimeMs();
          }),
        remainingRuntimeMs(),
        'Deep research timed out while writing the report',
      );
      progress.summaryBullets = reportPayload.summary_bullets;
      const markdown = reportPayload.report_markdown.trim();
      const html = markdownToHtml(markdown);
      const pdf = createSimplePdf(markdown, {
        images: reportPayload.images,
        maxSizeBytes: 1_048_576,
      });

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
      log.info(
        {
          actionId,
          topicSlug: progress.topicSlug,
          pdfPath,
          pdfBytes: fs.statSync(pdfPath).size,
        },
        'Deep research delivering report',
      );
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
        channel?.capabilities?.attachments?.maxBytes ??
          settings.attachmentSizeCapBytes,
      );
      const pdfSize = fs.statSync(pdfPath).size;
      const summaryLines = (progress.summaryBullets || [])
        .slice(0, 3)
        .map((line) => `- ${line}`);
      const coverMessage = [
        `Deep research report ready: ${path.basename(pdfPath)}`,
        ...summaryLines,
      ].join('\n');

      if (!channel?.sendAttachment || !channel.capabilities?.attachments?.pdf) {
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
      log.info(
        {
          actionId,
          runId,
          topicSlug: progress.topicSlug,
          searchCalls: progress.searchCalls,
          fetchCalls: progress.fetchCalls,
          sources: (progress.sources || []).length,
        },
        'Deep research succeeded',
      );
    } catch (error) {
      log.error(
        {
          actionId,
          runId,
          topicSlug: progress.topicSlug,
          err: error instanceof Error ? error.message : String(error),
        },
        'Deep research failed',
      );
      setChatPendingFollowupActionId(progress.chatJid, null);
      updateActionRecordStatus(actionId, 'failed_terminal');
      updateRunRecord(runId, {
        status: 'failed_terminal',
        finished_at: new Date().toISOString(),
        exit_code: 1,
        error_class:
          error instanceof Error ? error.name : 'deep_research_error',
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

  private planBudget(): number {
    return Math.min(2000, Math.max(800, OPENAI_MAX_TOKENS - 200));
  }

  private sectionBudget(): number {
    // Section drafts are the bulk of output length.
    return Math.min(3500, Math.max(1200, OPENAI_MAX_TOKENS - 400));
  }

  private smallBudget(): number {
    return Math.min(800, Math.max(400, OPENAI_MAX_TOKENS - 200));
  }

  private truncateForPrompt(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated]`;
  }

  // Strip the <web_content source="..."> framing added by providers.ts. The
  // deep research flow passes URL/title separately, so the wrapper is pure
  // noise and previously leaked verbatim into model output.
  private stripSourceFraming(text: string): string {
    return text
      .replace(/<web_content\b[^>]*>/gi, '')
      .replace(/<\/web_content>/gi, '')
      .replace(/\[truncated source content\]/gi, '')
      .trim();
  }

  // Scrub residual XML-like tags and collapse whitespace in strings returned
  // by the summarizer. If a fallback dumps raw text, this limits the blast
  // radius in the final report.
  private sanitizeSummaryLine(text: string, maxChars = 320): string {
    const cleaned = text
      .replace(/<web_content\b[^>]*>/gi, '')
      .replace(/<\/web_content>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';
    return cleaned.length > maxChars
      ? `${cleaned.slice(0, maxChars)}...`
      : cleaned;
  }

  private async buildPlan(progress: ResearchProgress): Promise<ResearchPlan> {
    const followupContext = (progress.followupAnswers || []).join('\n');
    const settings = getResearchSettings();
    const sectionsMin = Math.min(settings.sectionsMin, settings.sectionsMax);
    const sectionsMax = Math.max(settings.sectionsMin, settings.sectionsMax);
    try {
      const result = await callJsonChatCompletion<ResearchPlan>(
        [
          {
            role: 'system',
            content: [
              'You are planning a deep, long-form research report.',
              'Return JSON with keys: topic_slug, objectives, sections, subqueries, needs_followup, followup_questions.',
              '- topic_slug: 1-3 lowercase ASCII words joined by hyphens.',
              '- objectives: 3-6 concrete research goals.',
              `- sections: ${sectionsMin}-${sectionsMax} report sections. Each section has {title, angle, key_questions}. \`angle\` is a 1-2 sentence thesis for what this section argues or explores. \`key_questions\` is 2-4 questions the section should answer.`,
              '- subqueries: 8-15 diverse web search queries. Each entry is {query, category}, where `query` is the search string and `category` optionally restricts source type. Valid categories: "research paper" (academic / peer-reviewed), "news" (current events), "pdf" (whitepapers, reports), "company", "financial report", "github", or omit for general web search. Choose categories deliberately — use "research paper" for foundational / technical claims, "news" for recent developments, general (no category) for broad context. Mix broad framing, specific entities, counter-arguments, and recent developments.',
              '- needs_followup: only true if the prompt is genuinely ambiguous. Prefer false.',
              'Aim for richness: favor more sections over fewer, and queries that will surface contrasting viewpoints.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Research request:\n${progress.prompt}\n\nExisting follow-up answers:\n${followupContext || 'None'}`,
          },
        ],
        { maxTokens: this.planBudget(), temperature: 0.3 },
      );
      const sections: ResearchSection[] = Array.isArray(result.sections)
        ? result.sections
            .map((raw) => {
              const section = raw as Partial<ResearchSection>;
              return {
                title: String(section.title || '').trim(),
                angle: String(section.angle || '').trim(),
                key_questions: Array.isArray(section.key_questions)
                  ? section.key_questions.map(String).filter(Boolean)
                  : [],
              };
            })
            .filter((section) => section.title)
        : [];
      return {
        topic_slug: ensureTopicSlug(result.topic_slug || '', progress.prompt),
        objectives: Array.isArray(result.objectives)
          ? result.objectives.map(String).filter(Boolean)
          : [],
        sections:
          sections.length > 0
            ? sections
            : this.defaultSections(progress.prompt),
        subqueries: (() => {
          const normalized = normalizePlannedSubqueries(result.subqueries);
          return normalized.length > 0
            ? normalized
            : [{ query: progress.prompt }];
        })(),
        needs_followup: Boolean(result.needs_followup),
        followup_questions: Array.isArray(result.followup_questions)
          ? result.followup_questions.map(String).filter(Boolean).slice(0, 2)
          : [],
      };
    } catch {
      return {
        topic_slug: deterministicTopicSlug(progress.prompt),
        objectives: [progress.prompt],
        sections: this.defaultSections(progress.prompt),
        subqueries: [{ query: progress.prompt }],
        needs_followup: false,
        followup_questions: [],
      };
    }
  }

  private defaultSections(prompt: string): ResearchSection[] {
    return [
      {
        title: 'Background & Context',
        angle: `Establish what ${prompt} is and why it matters.`,
        key_questions: ['What is the origin?', 'Who are the key actors?'],
      },
      {
        title: 'Current State',
        angle: 'Summarize the present landscape and most recent developments.',
        key_questions: [
          'What is happening right now?',
          'What has changed recently?',
        ],
      },
      {
        title: 'Key Debates & Tradeoffs',
        angle: 'Surface disagreements, open questions, and competing views.',
        key_questions: [
          'Where do experts disagree?',
          'What are the main tradeoffs?',
        ],
      },
      {
        title: 'Implications & Outlook',
        angle: 'Discuss what is likely next and who is affected.',
        key_questions: ['What comes next?', 'Who wins and who loses?'],
      },
    ];
  }

  private async summarizeSource(
    progress: ResearchProgress,
    source: ResearchFetchResult,
    index: number,
    options?: { allowImage?: boolean },
  ): Promise<SourceSummary> {
    const unframed = this.stripSourceFraming(source.textContent);
    const truncated = this.truncateForPrompt(unframed, 12000);
    // Fire image download in parallel with the summary call so we don't pay
    // serial latency. Tries each candidate URL until one succeeds (Exa
    // returns og:image plus several in-page imageLinks per result).
    const imageCandidates = (() => {
      if (!options?.allowImage) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      const push = (u?: string) => {
        if (!u) return;
        if (seen.has(u)) return;
        seen.add(u);
        out.push(u);
      };
      push(source.imageUrl);
      for (const candidate of source.imageCandidates ?? []) push(candidate);
      return out;
    })();
    // Chain: download + heuristic-filter best candidate, then describe it
    // with the vision model. If vision says "logo" or "not informative", we
    // drop the image entirely so the drafter has nothing to reference.
    const imageClassification: Promise<{
      image?: ProcessedImage;
      imageDescription?: ImageDescription;
    }> = (async () => {
      if (!imageCandidates.length) return {};
      const image = await processFirstUsableImage(imageCandidates).catch(
        () => null,
      );
      if (!image) return {};
      const visionConfig = getVisionConfig(getResearchSettings());
      const description = await describeImage(
        image.buffer,
        {
          topic: progress.prompt,
          sourceTitle: source.title,
          sourceUrl: image.sourceUrl,
        },
        visionConfig,
      );
      if (description) {
        if (!description.is_informative || description.kind === 'logo') {
          log.info(
            {
              sourceIndex: index,
              url: image.sourceUrl,
              kind: description.kind,
              description: description.description,
            },
            'Vision dropped image as uninformative',
          );
          return {};
        }
        return { image, imageDescription: description };
      }
      // Vision disabled or failed — keep the image from heuristic selection.
      return { image };
    })();
    try {
      const result = await callJsonChatCompletion<{
        key_points: string[];
        notable_quotes: string[];
        relevance_notes: string;
      }>(
        [
          {
            role: 'system',
            content: [
              'Extract research notes from a single source. Return JSON with keys key_points, notable_quotes, relevance_notes.',
              '- key_points: 4-8 specific factual bullets (numbers, dates, names when present). No fluff.',
              '- notable_quotes: 0-3 short direct quotes worth citing verbatim (under 40 words each).',
              '- relevance_notes: 1-2 sentences on how this source applies to the research topic.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Research topic: ${progress.prompt}`,
              `Source title: ${source.title}`,
              `Source URL: ${source.url}`,
              '',
              'Source content:',
              truncated,
            ].join('\n'),
          },
        ],
        { maxTokens: this.smallBudget(), temperature: 0.2 },
      );
      return {
        index,
        url: source.url,
        title: source.title,
        key_points: Array.isArray(result.key_points)
          ? result.key_points
              .map((raw) => this.sanitizeSummaryLine(String(raw)))
              .filter(Boolean)
          : [],
        notable_quotes: Array.isArray(result.notable_quotes)
          ? result.notable_quotes
              .map((raw) => this.sanitizeSummaryLine(String(raw)))
              .filter(Boolean)
          : [],
        relevance_notes: this.sanitizeSummaryLine(
          String(result.relevance_notes || ''),
        ),
        ...(await imageClassification),
      };
    } catch {
      // Summarizer failed or emitted unparseable output. Skip the source
      // entirely rather than dumping raw framed text as a "key point" — that
      // was the cause of the wrapper leakage. The section drafter can work
      // from fewer sources.
      return {
        index,
        url: source.url,
        title: source.title,
        key_points: [],
        notable_quotes: [],
        relevance_notes: '',
        ...(await imageClassification),
      };
    }
  }

  private formatSummariesForPrompt(summaries: SourceSummary[]): string {
    return summaries
      .map((summary) => {
        let header = `[${summary.index}] ${summary.title} — ${summary.url}`;
        if (summary.image) {
          if (summary.imageDescription) {
            const kind = summary.imageDescription.kind;
            const desc = summary.imageDescription.description;
            header += `  (image available: ${kind} — ${desc})`;
          } else {
            header += '  (image available)';
          }
        }
        const lines = [
          header,
          ...summary.key_points.map((point) => `  - ${point}`),
        ];
        if (summary.notable_quotes.length) {
          lines.push('  Quotes:');
          for (const quote of summary.notable_quotes) {
            lines.push(`    • "${quote}"`);
          }
        }
        if (summary.relevance_notes) {
          lines.push(`  Relevance: ${summary.relevance_notes}`);
        }
        return lines.join('\n');
      })
      .join('\n\n');
  }

  private async draftSection(
    progress: ResearchProgress,
    section: ResearchSection,
    summaries: SourceSummary[],
  ): Promise<string> {
    const serializedSummaries = this.formatSummariesForPrompt(summaries);
    const settings = getResearchSettings();
    const wordsMin = Math.min(
      settings.wordsPerSectionMin,
      settings.wordsPerSectionMax,
    );
    const wordsMax = Math.max(
      settings.wordsPerSectionMin,
      settings.wordsPerSectionMax,
    );
    try {
      const result = await callJsonChatCompletion<{
        section_markdown: string;
      }>(
        [
          {
            role: 'system',
            content: [
              'Write one section of a long-form research report as JSON with key section_markdown.',
              'Requirements:',
              '- Begin with "## <section title>" exactly as given.',
              `- ${wordsMin}-${wordsMax} words. Multiple paragraphs. Use ### subheadings where it helps structure, and bullets where enumeration is natural.`,
              '- Ground every non-obvious claim in the provided sources. Cite inline using [n] where n is the source number. You may cite multiple sources per claim, e.g. [1][3].',
              '- Do not fabricate facts that are not in the source summaries. If the sources are thin on this section, say so briefly and focus on what can be supported.',
              '- Do not include a "Sources" list in this section — that appears elsewhere in the report.',
              '- Avoid hedging throat-clearing like "In this section we will...". Get to substance immediately.',
              'Images: sources marked "(image available: ...)" have an accompanying picture. The parenthetical tells you what kind (chart, diagram, screenshot, etc.) and a short description of what it shows. Use this exact markdown syntax on its own line to include one: ![short descriptive caption](source-N-image) where N is the source number. Pick the image whose description most directly supports a claim in THIS section; do not reuse an image another section would use better. Aim for ZERO or ONE image per section — never more. Skip the image when no available image is a clear fit for this section\'s substance. Never invent images for sources not marked "(image available: ...)".',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Overall research topic: ${progress.prompt}`,
              '',
              `Section title: ${section.title}`,
              `Section angle: ${section.angle}`,
              `Key questions to address:\n${section.key_questions.map((q) => `- ${q}`).join('\n')}`,
              '',
              'Source summaries (cite by number):',
              serializedSummaries || '(no sources available)',
            ].join('\n'),
          },
        ],
        { maxTokens: this.sectionBudget(), temperature: 0.3 },
      );
      const markdown = String(result.section_markdown || '').trim();
      if (!markdown) throw new Error('empty section');
      return markdown;
    } catch {
      const bulletized = summaries
        .flatMap((summary) =>
          summary.key_points
            .slice(0, 3)
            .map((point) => `- ${point} [${summary.index}]`),
        )
        .slice(0, 12);
      return [`## ${section.title}`, '', section.angle || '', '', ...bulletized]
        .filter(Boolean)
        .join('\n');
    }
  }

  private async writeExecutiveSummary(
    progress: ResearchProgress,
    sectionsMarkdown: string,
  ): Promise<string[]> {
    try {
      const result = await callJsonChatCompletion<{
        summary_bullets: string[];
      }>(
        [
          {
            role: 'system',
            content: [
              'You are writing the executive summary for a long-form research report.',
              'Return JSON with key summary_bullets: 5-7 bullets, each 1-2 sentences.',
              "The bullets should capture the report's main findings and tensions, not restate the prompt. Specific, quantitative where possible.",
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Research topic: ${progress.prompt}`,
              '',
              'Full report body:',
              this.truncateForPrompt(sectionsMarkdown, 16000),
            ].join('\n'),
          },
        ],
        { maxTokens: this.smallBudget(), temperature: 0.2 },
      );
      const bullets = Array.isArray(result.summary_bullets)
        ? result.summary_bullets.map(String).filter(Boolean)
        : [];
      return bullets.length > 0
        ? bullets.slice(0, 7)
        : ['Research completed.', 'See full report below for findings.'];
    } catch {
      return ['Research completed.', 'See full report below for findings.'];
    }
  }

  private async buildReport(
    progress: ResearchProgress,
    sources: ResearchFetchResult[],
    checkpoint: () => number,
  ): Promise<{
    summary_bullets: string[];
    report_markdown: string;
    images: Map<string, PdfImage>;
  }> {
    const plan = progress.plan;
    if (!plan) {
      throw new Error('Cannot build report without a research plan');
    }

    // 1. Per-source summarization (bounded by fetch count; each call is small).
    //    We also kick off an image fetch for up to MAX_IMAGES_PER_REPORT
    //    sources so the section drafter can optionally embed them.
    const perSourceBudget = Math.min(sources.length, 16);
    const summaries: SourceSummary[] = [];
    for (let index = 0; index < perSourceBudget; index++) {
      checkpoint();
      const summary = await this.summarizeSource(
        progress,
        sources[index],
        index + 1,
        { allowImage: index < MAX_IMAGES_PER_REPORT },
      );
      summaries.push(summary);
    }

    const sourcesWithImageUrl = sources
      .slice(0, perSourceBudget)
      .filter((source) => source.imageUrl).length;
    const summariesWithImage = summaries.filter((s) => s.image).length;
    log.info(
      {
        topicSlug: progress.topicSlug,
        totalSources: sources.length,
        summarized: summaries.length,
        sourcesWithImageUrl,
        summariesWithImage,
      },
      'Source summarization complete',
    );

    // 2. Draft each section with all source summaries in context.
    const sectionMarkdowns: string[] = [];
    for (const section of plan.sections) {
      checkpoint();
      const drafted = await this.draftSection(progress, section, summaries);
      sectionMarkdowns.push(drafted);
    }
    const rawSectionsJoined = sectionMarkdowns.join('\n\n');

    // Drafters occasionally reach for the same image across multiple
    // sections even though they're told not to. Strip any repeat image
    // reference (by name), keeping the first occurrence only, so the PDF
    // never embeds duplicates.
    const seenImageRefs = new Set<string>();
    let droppedDuplicateRefs = 0;
    const sectionsJoined = rawSectionsJoined.replace(
      /^!\[([^\]]*)\]\((source-\d+-image)\)$/gm,
      (full, _caption, name) => {
        if (seenImageRefs.has(name)) {
          droppedDuplicateRefs += 1;
          return '';
        }
        seenImageRefs.add(name);
        return full;
      },
    );

    const emittedImageRefs = seenImageRefs.size;
    log.info(
      {
        topicSlug: progress.topicSlug,
        sections: plan.sections.length,
        availableImages: summariesWithImage,
        emittedImageRefs,
        droppedDuplicateRefs,
      },
      'Section drafts complete',
    );

    // 3. Executive summary written last, seeing the full body.
    checkpoint();
    const summaryBullets = await this.writeExecutiveSummary(
      progress,
      sectionsJoined,
    );

    // 4. Assemble final markdown.
    const sourcesList = summaries.length
      ? [
          '## Sources',
          '',
          ...summaries.map(
            (summary) => `${summary.index}. [${summary.title}](${summary.url})`,
          ),
        ].join('\n')
      : '';
    const objectivesBlock = plan.objectives.length
      ? [
          '## Research Objectives',
          '',
          ...plan.objectives.map((o) => `- ${o}`),
        ].join('\n')
      : '';

    const report = [
      `# ${progress.prompt}`,
      '',
      '## Executive Summary',
      '',
      ...summaryBullets.map((bullet) => `- ${bullet}`),
      '',
      objectivesBlock,
      objectivesBlock ? '' : null,
      sectionsJoined,
      '',
      sourcesList,
    ]
      .filter((line) => line !== null)
      .join('\n');

    // Build the image map keyed by the markdown reference names the section
    // drafter was told to emit: `source-N-image`. The PDF renderer drops any
    // that overflow the size budget.
    const images = new Map<string, PdfImage>();
    for (const summary of summaries) {
      if (!summary.image) continue;
      images.set(`source-${summary.index}-image`, {
        buffer: summary.image.buffer,
        width: summary.image.width,
        height: summary.image.height,
      });
    }

    return {
      summary_bullets: summaryBullets.slice(0, 3),
      report_markdown: report.trim(),
      images,
    };
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
      log.error(
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
    log.info(
      {
        actionId,
        taskId,
        runId,
        chatJid: input.chatJid,
        groupFolder: input.groupFolder,
        prompt: input.prompt,
      },
      'Deep research job queued',
    );
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
      throw new Error(
        'This deep research follow-up must come from the original sender',
      );
    }
    const followupAnswers = [
      ...(progress.followupAnswers || []),
      answer.trim(),
    ];
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
    log.info(
      {
        actionId,
        chatJid: progress?.chatJid,
        topicSlug: progress?.topicSlug,
      },
      'Deep research cancelled',
    );
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

export function initializeDeepResearchService(
  runtime: DeepResearchRuntime,
): DeepResearchService {
  deepResearchService = new DeepResearchService(runtime);
  return deepResearchService;
}

export function getDeepResearchService(): DeepResearchService {
  if (!deepResearchService) {
    throw new Error('Deep research service not initialized');
  }
  return deepResearchService;
}
