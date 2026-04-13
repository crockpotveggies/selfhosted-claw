import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CTable,
  CTableBody,
  CTableDataCell,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from '@coreui/react';

import { useAdminDashboardContext } from '../admin/context';
import { PaginatedTable } from '../components/PaginatedTable';

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sourceBadgeColor(source: string): string {
  switch (source) {
    case 'ui':
      return 'info';
    case 'signal_control':
      return 'primary';
    case 'agent':
      return 'warning';
    default:
      return 'secondary';
  }
}

export function ApprovalsPage() {
  const dashboard = useAdminDashboardContext();
  const refreshKey = 'approvals-refresh';

  return (
    <CCard>
      <CCardHeader className="d-flex justify-content-between align-items-center">
        <strong>Pending Approvals</strong>
        <CButton
          size="sm"
          color="secondary"
          variant="outline"
          disabled={dashboard.isPending(refreshKey)}
          onClick={() =>
            void dashboard.runWithUiState(refreshKey, () =>
              dashboard.pendingState.refresh(),
            )
          }
        >
          {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
        </CButton>
      </CCardHeader>
      <CCardBody className="p-0">
        <PaginatedTable
          items={dashboard.pendingActions}
          renderTable={(pageItems) => (
            <CTable hover responsive align="middle" className="mb-0">
              <CTableHead className="text-nowrap">
                <CTableRow>
                  <CTableHeaderCell className="bg-body-tertiary">Action</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary text-center">Source</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">Actor</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">Expires</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary text-end">Actions</CTableHeaderCell>
                </CTableRow>
              </CTableHead>
              <CTableBody>
                {pageItems.length === 0 ? (
                  <CTableRow>
                    <CTableDataCell colSpan={5} className="text-center text-body-secondary py-4">
                      No pending approvals
                    </CTableDataCell>
                  </CTableRow>
                ) : (
                  pageItems.map((item) => (
                    <CTableRow key={item.id}>
                      <CTableDataCell>
                        <div className="fw-semibold small">{item.summary}</div>
                        <div className="small text-body-tertiary">{item.actionName}</div>
                      </CTableDataCell>
                      <CTableDataCell className="text-center">
                        <CBadge size="sm" color={sourceBadgeColor(item.source)}>{item.source}</CBadge>
                      </CTableDataCell>
                      <CTableDataCell><div className="small">{item.actorIdentity || '—'}</div></CTableDataCell>
                      <CTableDataCell>
                        <div className="small text-body-secondary text-nowrap">{timeAgo(item.expiresAt)}</div>
                      </CTableDataCell>
                      <CTableDataCell className="text-end">
                        <div className="d-flex gap-1 justify-content-end">
                          <CButton size="sm" color="success"
                            disabled={dashboard.isPending(`approve:${item.id}`)}
                            onClick={() => void dashboard.runWithUiState(`approve:${item.id}`, () => dashboard.decidePending(item.id, 'approve'))}
                          >
                            {dashboard.isPending(`approve:${item.id}`) ? '...' : 'Approve'}
                          </CButton>
                          <CButton size="sm" color="danger" variant="outline"
                            disabled={dashboard.isPending(`reject:${item.id}`)}
                            onClick={() => { if (!window.confirm('Reject this pending action?')) return; void dashboard.runWithUiState(`reject:${item.id}`, () => dashboard.decidePending(item.id, 'reject')); }}
                          >
                            {dashboard.isPending(`reject:${item.id}`) ? '...' : 'Reject'}
                          </CButton>
                        </div>
                      </CTableDataCell>
                    </CTableRow>
                  ))
                )}
              </CTableBody>
            </CTable>
          )}
        />
      </CCardBody>
    </CCard>
  );
}
