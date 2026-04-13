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

function statusColor(status: string): string {
  switch (status) {
    case 'success':
      return 'success';
    case 'error':
      return 'danger';
    case 'pending':
      return 'warning';
    case 'rejected':
      return 'secondary';
    default:
      return 'info';
  }
}

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

export function AuditPage() {
  const dashboard = useAdminDashboardContext();
  const refreshKey = 'audit-refresh';

  return (
    <CCard>
      <CCardHeader className="d-flex justify-content-between align-items-center">
        <strong>Audit Log</strong>
        <CButton
          size="sm"
          color="secondary"
          variant="outline"
          disabled={dashboard.isPending(refreshKey)}
          onClick={() =>
            void dashboard.runWithUiState(refreshKey, () =>
              dashboard.auditState.refresh(),
            )
          }
        >
          {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
        </CButton>
      </CCardHeader>
      <CCardBody className="p-0">
        <PaginatedTable
          items={dashboard.auditRecords}
          renderTable={(pageItems) => (
            <CTable hover responsive align="middle" className="mb-0">
              <CTableHead className="text-nowrap">
                <CTableRow>
                  <CTableHeaderCell className="bg-body-tertiary">Action</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">Actor</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary text-center">Status</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">Summary</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">When</CTableHeaderCell>
                </CTableRow>
              </CTableHead>
              <CTableBody>
                {pageItems.length === 0 ? (
                  <CTableRow>
                    <CTableDataCell colSpan={5} className="text-center text-body-secondary py-4">
                      No audit records yet
                    </CTableDataCell>
                  </CTableRow>
                ) : (
                  pageItems.map((record) => (
                    <CTableRow key={record.id}>
                      <CTableDataCell><code className="small">{record.actionName}</code></CTableDataCell>
                      <CTableDataCell><div className="small">{record.actorIdentity || '—'}</div></CTableDataCell>
                      <CTableDataCell className="text-center">
                        <CBadge size="sm" color={statusColor(record.status)}>{record.status}</CBadge>
                      </CTableDataCell>
                      <CTableDataCell>
                        <div className="small text-truncate" style={{ maxWidth: 300 }}>{record.payloadSummary}</div>
                      </CTableDataCell>
                      <CTableDataCell>
                        <div className="small text-body-secondary text-nowrap">{timeAgo(record.createdAt)}</div>
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
