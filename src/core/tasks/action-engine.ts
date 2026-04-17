import { randomUUID } from 'crypto';

import {
  listArtifactsForTask,
  createActionRecord,
  createAuditLogRecord,
  createCoreTask,
  createPrincipal,
  createRunRecord,
  findActionByIdempotencyKey,
  findSucceededActionBySemanticKey,
  findIdentity,
  getActionRecord,
  getPrincipal,
  getCoreTask,
  updateCoreTaskSummary,
  updateActionRecordStatus,
  updateRunRecord,
  upsertIdentity,
} from '../../db.js';
import type { ContainerOutput } from '../../container-runner.js';
import type { NewMessage, RegisteredGroup } from '../../types.js';
import { featureFlags } from '../feature-flags.js';
import { ActionLeaseManager } from '../actions/lease-manager.js';
import { ArtifactStore } from '../artifacts/store.js';
import { RollingTaskSummarizer } from '../context/assembler.js';
import { SkillVisibilityService } from '../skills/visibility-service.js';
import { InboundDedupeStore } from '../dedupe/store.js';
import { RunSpecDispatcher } from '../../dispatcher/runspec-dispatcher.js';
import { PolicyEngine } from '../policy/engine.js';
import { IdentityDirectory } from '../identity/directory.js';
import type {
  ActionRecord,
  PrincipalRecord,
  RunnerPool,
} from '../state/types.js';

export interface LegacyExecutionAdapter {
  run(input: {
    group: RegisteredGroup;
    prompt: string;
    chatJid: string;
    controllerTriggered: boolean;
    onOutput?: (output: ContainerOutput) => Promise<void>;
  }): Promise<'success' | 'error'>;
}

export interface ProcessInboundRequest {
  group: RegisteredGroup;
  chatJid: string;
  prompt: string;
  missedMessages: NewMessage[];
  controllerTriggered: boolean;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

export interface ProcessInboundResult {
  outcome: 'success' | 'error' | 'duplicate';
  principalId?: string;
  taskId?: string;
  actionId?: string;
  runId?: string;
}

function runnerPoolForPrincipal(
  principal: Pick<PrincipalRecord, 'trust_tier'>,
): RunnerPool {
  return principal.trust_tier === 'trusted' ? 'trusted' : 'restricted';
}

function derivePrincipalType(
  group: RegisteredGroup,
  controllerTriggered: boolean,
): PrincipalRecord['type'] {
  return group.isMain || controllerTriggered ? 'controller' : 'external';
}

function derivePermissionProfile(principal: PrincipalRecord): string {
  return principal.type === 'controller' ? 'trusted-ops' : 'external-default';
}

function summarizeMessages(messages: NewMessage[]): string {
  return messages
    .slice(-3)
    .map((message) => `${message.sender_name}: ${message.content}`)
    .join('\n')
    .slice(0, 500);
}

export class LegacyWrappedActionEngine {
  private readonly dedupeStore: InboundDedupeStore;
  private readonly policyEngine: PolicyEngine;
  private readonly runSpecDispatcher?: RunSpecDispatcher;
  private readonly artifactStore: ArtifactStore;
  private readonly leaseManager: ActionLeaseManager;
  private readonly skillVisibilityService: SkillVisibilityService;
  private readonly taskSummarizer: RollingTaskSummarizer;

  constructor(
    private readonly executor: LegacyExecutionAdapter,
    deps?: {
      dedupeStore?: InboundDedupeStore;
      policyEngine?: PolicyEngine;
      runSpecDispatcher?: RunSpecDispatcher;
      artifactStore?: ArtifactStore;
      leaseManager?: ActionLeaseManager;
      skillVisibilityService?: SkillVisibilityService;
      taskSummarizer?: RollingTaskSummarizer;
    },
  ) {
    this.dedupeStore = deps?.dedupeStore ?? new InboundDedupeStore();
    this.policyEngine = deps?.policyEngine ?? new PolicyEngine();
    this.runSpecDispatcher = deps?.runSpecDispatcher;
    this.artifactStore = deps?.artifactStore ?? new ArtifactStore();
    this.leaseManager = deps?.leaseManager ?? new ActionLeaseManager();
    this.skillVisibilityService =
      deps?.skillVisibilityService ?? new SkillVisibilityService();
    this.taskSummarizer = deps?.taskSummarizer ?? new RollingTaskSummarizer();
  }

  async processInbound(
    request: ProcessInboundRequest,
  ): Promise<ProcessInboundResult> {
    const latestMessage =
      request.missedMessages[request.missedMessages.length - 1];
    const principal = this.resolvePrincipal(
      request.group,
      latestMessage,
      request.controllerTriggered,
    );
    const sourceSystem = `${request.group.folder}:${request.chatJid}`;
    const newEventIds = request.missedMessages.filter((message) =>
      this.dedupeStore.registerEvent({
        sourceSystem,
        sourceEventId: message.id,
        messageParts: [
          message.chat_jid,
          message.sender,
          message.timestamp,
          message.content,
        ],
        principalId: principal.id,
      }),
    );

    if (newEventIds.length === 0) {
      return { outcome: 'duplicate', principalId: principal.id };
    }

    const now = new Date().toISOString();
    const idempotencyKey = `${sourceSystem}:${request.missedMessages.map((message) => message.id).join(',')}`;
    const existingAction = findActionByIdempotencyKey(idempotencyKey);
    if (existingAction) {
      return {
        outcome:
          existingAction.status === 'succeeded' ? 'duplicate' : 'success',
        principalId: principal.id,
        taskId: existingAction.task_id,
        actionId: existingAction.id,
      };
    }

    const taskId = randomUUID();
    createCoreTask({
      id: taskId,
      principal_id: principal.id,
      source_channel: this.detectSourceChannel(request.chatJid),
      source_thread_id: request.chatJid,
      status: 'open',
      summary: summarizeMessages(request.missedMessages),
      created_at: now,
      updated_at: now,
    });

    const runnerPool = runnerPoolForPrincipal(principal);
    const permissionProfile = derivePermissionProfile(principal);
    const permissionGroups = [
      permissionProfile,
      principal.type === 'controller' ? 'briefing' : 'drafting',
      principal.type === 'controller' ? 'trusted-ops' : 'scheduling',
    ];
    const policyContext = {
      principal: {
        id: principal.id,
        type: principal.type,
        trust_tier: principal.trust_tier,
        status: principal.status,
      },
      runnerPool,
      permissionGroups,
    };
    this.skillVisibilityService.writeVisibleSkillSnapshot({
      groupFolder: request.group.folder,
      principal: {
        type: principal.type,
        trust_tier: principal.trust_tier,
      },
      runnerPool,
      permissionGroups,
    });
    const actionType =
      featureFlags.enableRunspecRunners &&
      this.runSpecDispatcher &&
      !request.controllerTriggered
        ? 'draft_reply_from_thread'
        : 'legacy.prompt_session';
    const actionId = randomUUID();
    const semanticDedupeKey = `${request.chatJid}:${actionType}:${request.prompt.trim().toLowerCase()}`;
    const completedAction = findSucceededActionBySemanticKey(semanticDedupeKey);
    if (completedAction) {
      return {
        outcome: 'duplicate',
        principalId: principal.id,
        taskId: completedAction.task_id,
        actionId: completedAction.id,
      };
    }

    const decision = this.policyEngine.canPerformAction(
      {
        runnerPool,
        permissionProfile,
        sideEffectLevel: 'draft',
      },
      policyContext,
    );
    if (!decision.allowed) {
      createActionRecord({
        id: actionId,
        task_id: taskId,
        type: actionType,
        status: 'failed_terminal',
        runner_pool: runnerPool,
        permission_profile: permissionProfile,
        idempotency_key: idempotencyKey,
        semantic_dedupe_key: semanticDedupeKey,
        requested_by_principal_id: principal.id,
        approved_by_principal_id: null,
        created_at: now,
        updated_at: now,
      });
      createAuditLogRecord({
        id: randomUUID(),
        principal_id: principal.id,
        task_id: taskId,
        action_id: actionId,
        event_type: 'action.denied',
        payload_json: JSON.stringify({ reason: decision.reason }),
        created_at: now,
      });
      return { outcome: 'error', principalId: principal.id, taskId, actionId };
    }

    createActionRecord({
      id: actionId,
      task_id: taskId,
      type: actionType,
      status: 'approved',
      runner_pool: runnerPool,
      permission_profile: permissionProfile,
      idempotency_key: idempotencyKey,
      semantic_dedupe_key: semanticDedupeKey,
      requested_by_principal_id: principal.id,
      approved_by_principal_id:
        principal.type === 'controller' ? principal.id : null,
      created_at: now,
      updated_at: now,
    });
    updateActionRecordStatus(actionId, 'queued', { updatedAt: now });
    this.appendTaskSummary(
      taskId,
      `Queued action ${actionType} on ${runnerPool} lane`,
      now,
    );

    const runId = randomUUID();
    createRunRecord({
      id: runId,
      action_id: actionId,
      runner_pool: runnerPool,
      status: 'queued',
      attempt_no: 1,
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_class: null,
    });

    updateActionRecordStatus(actionId, 'executing');
    updateRunRecord(runId, {
      status: 'executing',
      started_at: new Date().toISOString(),
    });
    this.appendTaskSummary(
      taskId,
      `Executing action ${actionType}`,
      new Date().toISOString(),
    );
    const lease = this.leaseManager.claim(actionId, `worker:${runnerPool}`);
    if (!lease) {
      updateActionRecordStatus(actionId, 'failed_retryable');
      updateRunRecord(runId, {
        status: 'failed_retryable',
        error_class: 'lease_unavailable',
      });
      return {
        outcome: 'error',
        principalId: principal.id,
        taskId,
        actionId,
        runId,
      };
    }

    try {
      const outcome =
        actionType === 'draft_reply_from_thread'
          ? await this.executeRunSpecAction({
              taskId,
              actionId,
              runId,
              request,
            })
          : await this.executor.run({
              group: request.group,
              prompt: request.prompt,
              chatJid: request.chatJid,
              controllerTriggered: request.controllerTriggered,
              onOutput: request.onOutput,
            });
      const finishedAt = new Date().toISOString();
      if (outcome === 'success') {
        updateActionRecordStatus(actionId, 'succeeded', {
          updatedAt: finishedAt,
          approvedByPrincipalId:
            principal.type === 'controller' ? principal.id : undefined,
        });
        updateRunRecord(runId, {
          status: 'succeeded',
          finished_at: finishedAt,
          exit_code: 0,
        });
        this.appendTaskSummary(
          taskId,
          `Action ${actionType} succeeded`,
          finishedAt,
        );
      } else {
        updateActionRecordStatus(actionId, 'failed_retryable', {
          updatedAt: finishedAt,
        });
        updateRunRecord(runId, {
          status: 'failed_retryable',
          finished_at: finishedAt,
          exit_code: 1,
          error_class: 'legacy_runner_error',
        });
        this.appendTaskSummary(
          taskId,
          `Action ${actionType} failed and can retry`,
          finishedAt,
        );
      }
      createAuditLogRecord({
        id: randomUUID(),
        principal_id: principal.id,
        task_id: taskId,
        action_id: actionId,
        event_type: `action.${outcome}`,
        payload_json: JSON.stringify({
          runnerPool,
          messageCount: request.missedMessages.length,
        }),
        created_at: finishedAt,
      });
      return {
        outcome,
        principalId: principal.id,
        taskId,
        actionId,
        runId,
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      updateActionRecordStatus(actionId, 'outcome_unknown', {
        updatedAt: finishedAt,
      });
      updateRunRecord(runId, {
        status: 'outcome_unknown',
        finished_at: finishedAt,
        exit_code: null,
        error_class: error instanceof Error ? error.name : 'unknown_error',
      });
      this.appendTaskSummary(
        taskId,
        `Action ${actionType} ended with unknown outcome`,
        finishedAt,
      );
      createAuditLogRecord({
        id: randomUUID(),
        principal_id: principal.id,
        task_id: taskId,
        action_id: actionId,
        event_type: 'action.outcome_unknown',
        payload_json: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        created_at: finishedAt,
      });
      return {
        outcome: 'error',
        principalId: principal.id,
        taskId,
        actionId,
        runId,
      };
    } finally {
      this.leaseManager.release(lease);
    }
  }

  private async executeRunSpecAction(input: {
    taskId: string;
    actionId: string;
    runId: string;
    request: ProcessInboundRequest;
  }): Promise<'success' | 'error'> {
    if (!this.runSpecDispatcher) {
      throw new Error('RunSpec dispatcher not configured');
    }

    this.artifactStore.writeArtifact({
      taskId: input.taskId,
      kind: 'document',
      mediaType: 'text/plain',
      content: input.request.prompt,
      createdByRunId: input.runId,
      extension: '.txt',
    });
    const dispatched = await this.runSpecDispatcher.dispatch(
      input.actionId,
      input.runId,
    );
    const generatedArtifacts = listArtifactsForTask(input.taskId).filter(
      (artifact) => artifact.created_by_run_id === dispatched.runRecord.id,
    );
    const primaryArtifact = generatedArtifacts.at(-1);
    if (primaryArtifact && input.request.onOutput) {
      await input.request.onOutput({
        status: dispatched.result.status === 'succeeded' ? 'success' : 'error',
        result: this.artifactStore.readArtifact(primaryArtifact),
      });
    }
    return dispatched.result.status === 'succeeded' ? 'success' : 'error';
  }

  private appendTaskSummary(
    taskId: string,
    event: string,
    updatedAt: string,
  ): void {
    const task = getCoreTask(taskId);
    if (!task) return;
    const nextSummary = this.taskSummarizer.updateSummary(task.summary, event);
    updateCoreTaskSummary(taskId, nextSummary, updatedAt);
  }

  private detectSourceChannel(chatJid: string): string {
    const [prefix] = chatJid.split(':', 1);
    return prefix || 'unknown';
  }

  private resolvePrincipal(
    group: RegisteredGroup,
    message: NewMessage,
    controllerTriggered: boolean,
  ): PrincipalRecord {
    const existingIdentity = findIdentity(
      this.detectSourceChannel(message.chat_jid),
      message.sender,
    );
    if (existingIdentity) {
      const principal = getPrincipal(existingIdentity.principal_id);
      if (principal) return principal;
    }

    const directory = new IdentityDirectory();
    const resolved = directory.resolveInboundIdentity({
      channelType: this.detectSourceChannel(message.chat_jid),
      externalId: message.sender,
      externalHandle: message.sender_name,
      displayName: message.sender_name || message.sender,
      principalType: derivePrincipalType(group, controllerTriggered),
      verified: group.isMain || controllerTriggered,
    });
    createPrincipal(resolved.principal);
    upsertIdentity(resolved.identity);
    return resolved.principal;
  }
}

export function getWrappedActionRecord(id: string): ActionRecord | undefined {
  return getActionRecord(id);
}
