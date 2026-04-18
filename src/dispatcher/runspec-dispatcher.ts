import { randomUUID } from 'crypto';

import {
  createAuditLogRecord,
  createRunRecord,
  getActionRecord,
  getCoreTask,
  getPrincipal,
  updateActionRecordStatus,
  updateRunRecord,
} from '../db.js';
import { ArtifactStore } from '../core/artifacts/store.js';
import type { ActionRecord, RunRecord } from '../core/state/types.js';
import type { RunResult, RunSpec } from '../protocol/types.js';
import { RestrictedRunnerPool } from '../runner/restricted/pool.js';
import { TrustedRunnerPool } from '../runner/trusted/pool.js';

export interface RunSpecDispatcherDeps {
  artifactStore?: ArtifactStore;
  trustedPool?: TrustedRunnerPool;
  restrictedPool?: RestrictedRunnerPool;
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'text/markdown':
      return '.md';
    case 'text/html':
      return '.html';
    case 'application/json':
      return '.json';
    case 'application/pdf':
      return '.pdf';
    default:
      return '.txt';
  }
}

export class RunSpecDispatcher {
  private readonly artifactStore: ArtifactStore;
  private readonly trustedPool: TrustedRunnerPool;
  private readonly restrictedPool: RestrictedRunnerPool;

  constructor(deps?: RunSpecDispatcherDeps) {
    this.artifactStore = deps?.artifactStore ?? new ArtifactStore();
    this.trustedPool = deps?.trustedPool ?? new TrustedRunnerPool();
    this.restrictedPool = deps?.restrictedPool ?? new RestrictedRunnerPool();
  }

  async prewarm(): Promise<void> {
    await Promise.all([
      this.trustedPool.prewarm(),
      this.restrictedPool.prewarm(),
    ]);
  }

  async close(): Promise<void> {
    await Promise.all([this.trustedPool.close(), this.restrictedPool.close()]);
  }

  getPoolSnapshots() {
    return {
      trusted: this.trustedPool.getSnapshot(),
      restricted: this.restrictedPool.getSnapshot(),
    };
  }

  async compileRunSpec(actionId: string, runId?: string): Promise<RunSpec> {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown action ${actionId}`);
    const task = getCoreTask(action.task_id);
    if (!task) throw new Error(`Unknown task ${action.task_id}`);
    const principal = getPrincipal(task.principal_id);
    if (!principal) throw new Error(`Unknown principal ${task.principal_id}`);

    const artifacts = this.artifactStore.listTaskArtifacts(task.id);
    const env: Record<string, string> = {};
    for (const artifact of artifacts) {
      env[`ARTIFACT_${artifact.id}`] =
        this.artifactStore.readArtifact(artifact);
    }

    const progress = action.progress_json ? JSON.parse(action.progress_json) as {
      prompt?: string;
      topicSlug?: string;
      groupFolder?: string;
      chatJid?: string;
    } : null;
    const isDeepResearch = action.type === 'deep_research';
    return {
      run_id: runId ?? randomUUID(),
      action_id: action.id,
      runner_pool: action.runner_pool,
      template: isDeepResearch ? 'deep_research' : 'draft_reply_from_thread',
      template_args: {
        prompt: progress?.prompt || task.summary,
        thread_summary: task.summary,
        principal_display_name: principal.display_name,
        topic_slug: progress?.topicSlug || 'research-report',
      },
      workspace: {
        input_artifact_ids: artifacts.map((artifact) => artifact.id),
        expected_outputs: isDeepResearch
          ? ['/workspace/out/research-plan.json']
          : ['/workspace/out/draft-reply.md'],
        metadata: {
          task_id: task.id,
          principal_id: principal.id,
          ...(progress?.groupFolder ? { group_folder: progress.groupFolder } : {}),
          ...(progress?.chatJid ? { chat_jid: progress.chatJid } : {}),
        },
      },
      env,
      capabilities:
        action.runner_pool === 'trusted'
          ? ['draft', 'project_read']
          : ['draft'],
      limits: {
        timeout_ms: isDeepResearch ? 20 * 60_000 : 10_000,
        max_output_bytes: isDeepResearch ? 1_048_576 : 128_000,
      },
    };
  }

  async dispatch(
    actionId: string,
    runId?: string,
  ): Promise<{
    runRecord: RunRecord;
    result: RunResult;
  }> {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown action ${actionId}`);

    const runSpec = await this.compileRunSpec(actionId, runId);
    const now = new Date().toISOString();
    if (!runId) {
      createRunRecord({
        id: runSpec.run_id,
        action_id: action.id,
        runner_pool: action.runner_pool,
        status: 'executing',
        attempt_no: 1,
        started_at: now,
        finished_at: null,
        exit_code: null,
        error_class: null,
      });
    } else {
      updateRunRecord(runSpec.run_id, {
        status: 'executing',
        started_at: now,
      });
    }
    updateActionRecordStatus(action.id, 'executing', { updatedAt: now });

    const result =
      runSpec.runner_pool === 'trusted'
        ? await this.trustedPool.execute(runSpec)
        : await this.restrictedPool.execute(runSpec);

    const finishedAt = new Date().toISOString();
    const task = getCoreTask(action.task_id);
    if (!task) throw new Error(`Unknown task ${action.task_id}`);
    for (const artifact of result.artifacts) {
      this.artifactStore.writeArtifact({
        taskId: task.id,
        kind: 'document',
        mediaType: artifact.media_type,
        content: this.artifactStore.readArtifact({ path: artifact.path }),
        createdByRunId: runSpec.run_id,
        extension: extensionForMediaType(artifact.media_type),
      });
    }

    updateRunRecord(runSpec.run_id, {
      status: result.status,
      finished_at: finishedAt,
      exit_code: result.exit_code,
      error_class: result.status === 'succeeded' ? null : result.status,
    });
    updateActionRecordStatus(
      action.id,
      result.status === 'succeeded' ? 'succeeded' : 'failed_terminal',
      { updatedAt: finishedAt },
    );
    createAuditLogRecord({
      id: randomUUID(),
      principal_id: task.principal_id,
      task_id: task.id,
      action_id: action.id,
      event_type: 'runspec.dispatched',
      payload_json: JSON.stringify({
        runnerPool: runSpec.runner_pool,
        template: runSpec.template,
        resultStatus: result.status,
      }),
      created_at: finishedAt,
    });

    return {
      runRecord: {
        id: runSpec.run_id,
        action_id: action.id,
        runner_pool: action.runner_pool,
        status: result.status,
        attempt_no: 1,
        started_at: now,
        finished_at: finishedAt,
        exit_code: result.exit_code,
        error_class: result.status === 'succeeded' ? null : result.status,
      },
      result,
    };
  }

  async stage(
    actionId: string,
    runId?: string,
  ): Promise<{
    runRecord: RunRecord;
    result: RunResult;
  }> {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown action ${actionId}`);

    const runSpec = await this.compileRunSpec(actionId, runId);
    const now = new Date().toISOString();
    if (!runId) {
      createRunRecord({
        id: runSpec.run_id,
        action_id: action.id,
        runner_pool: action.runner_pool,
        status: 'executing',
        attempt_no: 1,
        started_at: now,
        finished_at: null,
        exit_code: null,
        error_class: null,
      });
    } else {
      updateRunRecord(runSpec.run_id, {
        status: 'executing',
        started_at: now,
      });
    }
    updateActionRecordStatus(action.id, 'executing', { updatedAt: now });

    const result =
      runSpec.runner_pool === 'trusted'
        ? await this.trustedPool.execute(runSpec)
        : await this.restrictedPool.execute(runSpec);

    const finishedAt = new Date().toISOString();
    const task = getCoreTask(action.task_id);
    if (!task) throw new Error(`Unknown task ${action.task_id}`);
    for (const artifact of result.artifacts) {
      this.artifactStore.writeArtifact({
        taskId: task.id,
        kind: 'document',
        mediaType: artifact.media_type,
        content: this.artifactStore.readArtifact({ path: artifact.path }),
        createdByRunId: runSpec.run_id,
        extension: extensionForMediaType(artifact.media_type),
      });
    }

    updateRunRecord(runSpec.run_id, {
      status: result.status,
      finished_at: finishedAt,
      exit_code: result.exit_code,
      error_class: result.status === 'succeeded' ? null : result.status,
    });
    if (result.status !== 'succeeded') {
      updateActionRecordStatus(action.id, 'failed_terminal', {
        updatedAt: finishedAt,
      });
    }
    createAuditLogRecord({
      id: randomUUID(),
      principal_id: task.principal_id,
      task_id: task.id,
      action_id: action.id,
      event_type: 'runspec.staged',
      payload_json: JSON.stringify({
        runnerPool: runSpec.runner_pool,
        template: runSpec.template,
        resultStatus: result.status,
      }),
      created_at: finishedAt,
    });

    return {
      runRecord: {
        id: runSpec.run_id,
        action_id: action.id,
        runner_pool: action.runner_pool,
        status: result.status,
        attempt_no: 1,
        started_at: now,
        finished_at: finishedAt,
        exit_code: result.exit_code,
        error_class: result.status === 'succeeded' ? null : result.status,
      },
      result,
    };
  }
}
