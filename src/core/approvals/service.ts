import {
  createApprovalRecord,
  getActionRecord,
  listApprovalsForAction,
  updateActionRecordStatus,
} from '../../db.js';

export class ApprovalService {
  requireApproval(input: {
    approvalId: string;
    actionId: string;
    principalId: string;
    reason: string;
  }): void {
    createApprovalRecord({
      id: input.approvalId,
      action_id: input.actionId,
      required_from_principal_id: input.principalId,
      status: 'pending',
      reason: input.reason,
    });
  }

  markApproved(actionId: string, principalId: string): void {
    const approvals = listApprovalsForAction(actionId);
    const approval = approvals.find(
      (entry) => entry.required_from_principal_id === principalId,
    );
    if (!approval) {
      throw new Error(`No approval requirement for principal ${principalId}`);
    }
    createApprovalRecord({
      ...approval,
      status: 'approved',
    });
  }

  canFinalize(actionId: string): boolean {
    const action = getActionRecord(actionId);
    if (!action) throw new Error(`Unknown action ${actionId}`);
    const approvals = listApprovalsForAction(actionId);
    if (approvals.length === 0) return true;
    return approvals.every((approval) => approval.status === 'approved');
  }

  finalize(actionId: string): void {
    if (!this.canFinalize(actionId)) {
      throw new Error(`Action ${actionId} cannot finalize without approval`);
    }
    updateActionRecordStatus(actionId, 'succeeded');
  }
}
