import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CFormSelect,
  CRow,
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
    case 'trusted':
      return 'success';
    case 'abuse':
      return 'danger';
    default:
      return 'secondary';
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

export function ContactsPage() {
  const dashboard = useAdminDashboardContext();
  const trustKey = 'contact-trust';
  const abuseKey = 'contact-abuse';
  const resetKey = 'contact-reset';
  const reclassifyKey = 'contact-reclassify';

  return (
    <>
      <CRow className="g-3 mb-4">
        {/* Contact list */}
        <CCol lg={5}>
          <CCard>
            <CCardHeader className="d-flex justify-content-between align-items-center">
              <strong>Contacts</strong>
              <CFormSelect
                size="sm"
                style={{ width: 120 }}
                value={dashboard.contactStatusFilter}
                onChange={(e) =>
                  dashboard.setContactStatusFilter(e.target.value)
                }
              >
                <option value="">All</option>
                <option value="trusted">Trusted</option>
                <option value="unknown">Unknown</option>
                <option value="abuse">Abuse</option>
              </CFormSelect>
            </CCardHeader>
            <CCardBody className="p-0">
              <PaginatedTable
                items={dashboard.contacts}
                defaultPageSize={50}
                renderTable={(pageItems) => (
                  <CTable hover responsive align="middle" className="mb-0">
                    <CTableHead className="text-nowrap">
                      <CTableRow>
                        <CTableHeaderCell className="bg-body-tertiary">Name</CTableHeaderCell>
                        <CTableHeaderCell className="bg-body-tertiary text-center">Status</CTableHeaderCell>
                        <CTableHeaderCell className="bg-body-tertiary text-end">Messages</CTableHeaderCell>
                      </CTableRow>
                    </CTableHead>
                    <CTableBody>
                      {pageItems.length === 0 ? (
                        <CTableRow>
                          <CTableDataCell colSpan={3} className="text-center text-body-secondary py-4">
                            No contacts found
                          </CTableDataCell>
                        </CTableRow>
                      ) : (
                        pageItems.map((contact) => (
                          <CTableRow
                            key={contact.identity}
                            active={dashboard.selectedContactId === contact.identity}
                            onClick={() => dashboard.setSelectedContactId(contact.identity)}
                            style={{ cursor: 'pointer' }}
                          >
                            <CTableDataCell>
                              <div className="fw-semibold small">{contact.displayName}</div>
                              <div className="small text-body-tertiary text-truncate" style={{ maxWidth: 200 }}>{contact.identity}</div>
                            </CTableDataCell>
                            <CTableDataCell className="text-center">
                              <CBadge size="sm" color={statusColor(contact.status)}>{contact.status}</CBadge>
                            </CTableDataCell>
                            <CTableDataCell className="text-end">
                              <span className="small text-body-secondary">{contact.messageCount}</span>
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
        </CCol>

        {/* Contact detail */}
        <CCol lg={7}>
          <CCard>
            <CCardHeader className="d-flex justify-content-between align-items-center">
              <strong>Contact Detail</strong>
              {dashboard.selectedContact && (
                <div className="d-flex gap-1">
                  <CButton
                    size="sm"
                    color="success"
                    variant="outline"
                    disabled={dashboard.isPending(trustKey)}
                    onClick={() =>
                      void dashboard.runWithUiState(trustKey, () =>
                        dashboard.mutate('contact.trust', {
                          identity: dashboard.selectedContact?.identity,
                        }),
                      )
                    }
                  >
                    {dashboard.isPending(trustKey) ? '...' : 'Trust'}
                  </CButton>
                  <CButton
                    size="sm"
                    color="danger"
                    variant="outline"
                    disabled={dashboard.isPending(abuseKey)}
                    onClick={() => {
                      if (!window.confirm('Mark this contact as abuse?'))
                        return;
                      void dashboard.runWithUiState(abuseKey, () =>
                        dashboard.mutate('contact.abuse', {
                          identity: dashboard.selectedContact?.identity,
                        }),
                      );
                    }}
                  >
                    {dashboard.isPending(abuseKey) ? '...' : 'Abuse'}
                  </CButton>
                  <CButton
                    size="sm"
                    color="secondary"
                    variant="outline"
                    disabled={dashboard.isPending(resetKey)}
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Reset this contact back to unknown?',
                        )
                      )
                        return;
                      void dashboard.runWithUiState(resetKey, () =>
                        dashboard.mutate('contact.reset', {
                          identity: dashboard.selectedContact?.identity,
                        }),
                      );
                    }}
                  >
                    {dashboard.isPending(resetKey) ? '...' : 'Reset'}
                  </CButton>
                  <CButton
                    size="sm"
                    color="info"
                    variant="outline"
                    disabled={dashboard.isPending(reclassifyKey)}
                    onClick={() =>
                      void dashboard.runWithUiState(reclassifyKey, () =>
                        dashboard.mutate('contact.reclassify', {
                          identity: dashboard.selectedContact?.identity,
                        }),
                      )
                    }
                  >
                    {dashboard.isPending(reclassifyKey)
                      ? '...'
                      : 'Re-classify'}
                  </CButton>
                </div>
              )}
            </CCardHeader>
            <CCardBody>
              {dashboard.selectedContact ? (
                <>
                  <div className="mb-3">
                    <div className="fw-semibold">
                      {dashboard.selectedContact.displayName}
                    </div>
                    <div className="small text-body-secondary">
                      {dashboard.selectedContact.identity}
                    </div>
                    <CBadge
                      color={statusColor(dashboard.selectedContact.status)}
                      className="mt-1"
                    >
                      {dashboard.selectedContact.status}
                    </CBadge>
                    {dashboard.selectedContact.classificationSummary && (
                      <p className="small text-body-secondary mt-2 mb-0">
                        {dashboard.selectedContact.classificationSummary}
                      </p>
                    )}
                  </div>

                  <h6 className="text-body-secondary text-uppercase small mb-2">
                    Message History
                  </h6>
                  <PaginatedTable
                    items={dashboard.selectedContact.history}
                    defaultPageSize={50}
                    renderTable={(pageItems) => (
                      <CTable hover responsive align="middle" small className="mb-0">
                        <CTableHead className="text-nowrap">
                          <CTableRow>
                            <CTableHeaderCell className="bg-body-tertiary">Sender</CTableHeaderCell>
                            <CTableHeaderCell className="bg-body-tertiary">Message</CTableHeaderCell>
                            <CTableHeaderCell className="bg-body-tertiary">When</CTableHeaderCell>
                          </CTableRow>
                        </CTableHead>
                        <CTableBody>
                          {pageItems.length === 0 ? (
                            <CTableRow>
                              <CTableDataCell colSpan={3} className="text-center text-body-secondary py-3">
                                No message history
                              </CTableDataCell>
                            </CTableRow>
                          ) : (
                            pageItems.map((entry) => (
                              <CTableRow key={entry.id}>
                                <CTableDataCell><div className="small fw-semibold">{entry.senderName}</div></CTableDataCell>
                                <CTableDataCell>
                                  <div className="small text-truncate" style={{ maxWidth: 350 }}>{entry.content}</div>
                                </CTableDataCell>
                                <CTableDataCell>
                                  <div className="small text-body-secondary text-nowrap">{timeAgo(entry.timestamp)}</div>
                                </CTableDataCell>
                              </CTableRow>
                            ))
                          )}
                        </CTableBody>
                      </CTable>
                    )}
                  />
                </>
              ) : (
                <p className="text-body-secondary mb-0">
                  Select a contact to inspect its history.
                </p>
              )}
            </CCardBody>
          </CCard>
        </CCol>
      </CRow>

    </>
  );
}
