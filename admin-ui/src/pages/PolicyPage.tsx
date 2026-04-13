import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CFormInput,
  CFormSelect,
  CRow,
  CTable,
  CTableBody,
  CTableDataCell,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from '@coreui/react';
import {
  ShieldCheck,
  PlusCircle,
  TrashFill,
  Search,
} from 'react-bootstrap-icons';

import { useAdminDashboardContext } from '../admin/context';

export function PolicyPage() {
  const dashboard = useAdminDashboardContext();
  const pauseKey = 'policy-pause';
  const resumeKey = 'policy-resume';
  const resolveKey = 'contact-resolve';
  const addVerifiedKey = 'verified-add';
  const saveSettingsKey = 'settings-save';

  return (
    <CRow className="g-3">
      {/* Left column */}
      <CCol lg={7}>
        {/* Verified Identities */}
        <CCard className="mb-3">
          <CCardHeader className="d-flex justify-content-between align-items-center">
            <div className="d-flex align-items-center gap-2">
              <ShieldCheck size={16} />
              <strong>Verified Identities</strong>
              <CBadge color="success" size="sm">
                {dashboard.verifiedIdentities.length}
              </CBadge>
            </div>
          </CCardHeader>
          <CCardBody>
            <p className="small text-body-secondary mb-3">
              Trusted operator identities that can issue control commands via Signal.
            </p>
            <CRow className="g-2 mb-3">
              <CCol sm={5}>
                <CFormInput
                  size="sm"
                  value={dashboard.verifiedIdentityInput}
                  onChange={(e) => dashboard.setVerifiedIdentityInput(e.target.value)}
                  placeholder="phone:+15555550123"
                />
              </CCol>
              <CCol sm={4}>
                <CFormInput
                  size="sm"
                  value={dashboard.verifiedLabelInput}
                  onChange={(e) => dashboard.setVerifiedLabelInput(e.target.value)}
                  placeholder="Label (e.g. Justin)"
                />
              </CCol>
              <CCol sm={3}>
                <CButton
                  size="sm"
                  color="primary"
                  className="w-100"
                  disabled={dashboard.isPending(addVerifiedKey)}
                  onClick={() =>
                    void dashboard.runWithUiState(addVerifiedKey, () =>
                      dashboard.addVerifiedIdentity(),
                    )
                  }
                >
                  <PlusCircle size={12} className="me-1" />
                  {dashboard.isPending(addVerifiedKey) ? 'Adding...' : 'Add'}
                </CButton>
              </CCol>
            </CRow>

            <CTable hover responsive align="middle" small className="mb-0">
              <CTableHead>
                <CTableRow>
                  <CTableHeaderCell className="bg-body-tertiary">Label</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">Identity</CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary text-end" style={{ width: 80 }}></CTableHeaderCell>
                </CTableRow>
              </CTableHead>
              <CTableBody>
                {dashboard.verifiedIdentities.length === 0 ? (
                  <CTableRow>
                    <CTableDataCell colSpan={3} className="text-center text-body-secondary py-3">
                      No verified identities yet
                    </CTableDataCell>
                  </CTableRow>
                ) : (
                  dashboard.verifiedIdentities.map((item) => (
                    <CTableRow key={item.identity}>
                      <CTableDataCell>
                        <div className="fw-semibold small">{item.label}</div>
                      </CTableDataCell>
                      <CTableDataCell>
                        <code className="small">{item.identity}</code>
                      </CTableDataCell>
                      <CTableDataCell className="text-end">
                        <CButton
                          size="sm"
                          color="danger"
                          variant="ghost"
                          disabled={dashboard.isPending(`verified-remove:${item.identity}`)}
                          onClick={() => {
                            if (!window.confirm(`Remove "${item.label}" from trusted identities?`)) return;
                            void dashboard.runWithUiState(`verified-remove:${item.identity}`, () =>
                              dashboard.mutate('verified.remove', { identity: item.identity }),
                            );
                          }}
                        >
                          <TrashFill size={12} />
                        </CButton>
                      </CTableDataCell>
                    </CTableRow>
                  ))
                )}
              </CTableBody>
            </CTable>
          </CCardBody>
        </CCard>

        {/* Provider Controls */}
        <CCard>
          <CCardHeader>
            <strong>Provider Controls</strong>
          </CCardHeader>
          <CCardBody>
            <p className="small text-body-secondary mb-3">
              Pause or resume outbound messaging providers. Paused providers will not deliver messages.
            </p>
            <div className="small mb-3">
              <strong>Currently paused: </strong>
              {dashboard.policy.pausedProviders.length
                ? dashboard.policy.pausedProviders.map((p) => (
                    <CBadge key={p} color="warning" size="sm" className="me-1">{p}</CBadge>
                  ))
                : <span className="text-body-secondary">none</span>}
            </div>
            <CRow className="g-2">
              <CCol sm={6}>
                <CFormInput
                  size="sm"
                  value={dashboard.providerInput}
                  onChange={(e) => dashboard.setProviderInput(e.target.value)}
                  placeholder="signal, sms, email"
                />
              </CCol>
              <CCol sm={3}>
                <CButton
                  size="sm"
                  color="warning"
                  variant="outline"
                  className="w-100"
                  disabled={dashboard.isPending(pauseKey)}
                  onClick={() =>
                    void dashboard.runWithUiState(pauseKey, () =>
                      dashboard.mutate('policy.pauseProvider', { provider: dashboard.providerInput }),
                    )
                  }
                >
                  {dashboard.isPending(pauseKey) ? '...' : 'Pause'}
                </CButton>
              </CCol>
              <CCol sm={3}>
                <CButton
                  size="sm"
                  color="success"
                  variant="outline"
                  className="w-100"
                  disabled={dashboard.isPending(resumeKey)}
                  onClick={() =>
                    void dashboard.runWithUiState(resumeKey, () =>
                      dashboard.mutate('policy.resumeProvider', { provider: dashboard.providerInput }),
                    )
                  }
                >
                  {dashboard.isPending(resumeKey) ? '...' : 'Resume'}
                </CButton>
              </CCol>
            </CRow>
          </CCardBody>
        </CCard>
      </CCol>

      {/* Right column */}
      <CCol lg={5}>
        {/* Control Settings */}
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Control Settings</strong>
          </CCardHeader>
          <CCardBody>
            <div className="d-flex flex-column gap-3">
              <div>
                <label className="form-label small fw-semibold">Control Signal chat JID</label>
                <CFormInput
                  size="sm"
                  value={dashboard.settingsDraft.controlSignalJid}
                  onChange={(e) =>
                    dashboard.setSettingsDraft({
                      ...dashboard.settingsDraft,
                      controlSignalJid: e.target.value,
                    })
                  }
                  placeholder="signal:user:+15555550123"
                />
              </div>
              <div>
                <label className="form-label small fw-semibold">Assistant Signal identity</label>
                <CFormInput
                  size="sm"
                  value={dashboard.settingsDraft.assistantSignalIdentity}
                  onChange={(e) =>
                    dashboard.setSettingsDraft({
                      ...dashboard.settingsDraft,
                      assistantSignalIdentity: e.target.value,
                    })
                  }
                  placeholder="+15555550123"
                />
              </div>
              <CButton
                size="sm"
                color="primary"
                disabled={dashboard.isPending(saveSettingsKey)}
                onClick={() =>
                  void dashboard.runWithUiState(saveSettingsKey, () =>
                    dashboard.saveSettings(dashboard.settingsDraft),
                  )
                }
              >
                {dashboard.isPending(saveSettingsKey) ? 'Saving...' : 'Save Settings'}
              </CButton>
            </div>
          </CCardBody>
        </CCard>

        {/* Contact Resolution */}
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Contact Resolution Preview</strong>
          </CCardHeader>
          <CCardBody>
            <p className="small text-body-secondary mb-3">
              Test how the agent resolves a name to a messaging target.
            </p>
            <CRow className="g-2 mb-3">
              <CCol sm={4}>
                <CFormSelect
                  size="sm"
                  value={dashboard.resolutionChannel}
                  onChange={(e) =>
                    dashboard.setResolutionChannel(e.target.value as 'signal' | 'sms' | 'email')
                  }
                >
                  <option value="signal">Signal</option>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                </CFormSelect>
              </CCol>
              <CCol sm={5}>
                <CFormInput
                  size="sm"
                  value={dashboard.resolutionQuery}
                  onChange={(e) => dashboard.setResolutionQuery(e.target.value)}
                  placeholder="Sam, sam@example.com"
                />
              </CCol>
              <CCol sm={3}>
                <CButton
                  size="sm"
                  color="info"
                  variant="outline"
                  className="w-100"
                  disabled={dashboard.isPending(resolveKey)}
                  onClick={() =>
                    void dashboard.runWithUiState(resolveKey, () =>
                      dashboard.previewResolution(),
                    )
                  }
                >
                  <Search size={12} className="me-1" />
                  {dashboard.isPending(resolveKey) ? '...' : 'Test'}
                </CButton>
              </CCol>
            </CRow>
            {dashboard.resolutionPreview ? (
              <div className="small p-2 rounded" style={{ background: 'var(--cui-tertiary-bg)' }}>
                <div><strong>{dashboard.resolutionPreview.displayName}</strong></div>
                <div className="text-body-secondary">
                  {dashboard.resolutionPreview.resolvedTarget} via {dashboard.resolutionPreview.source}
                  {dashboard.resolutionPreview.existingConversation && (
                    <CBadge color="info" size="sm" className="ms-1">existing</CBadge>
                  )}
                </div>
              </div>
            ) : (
              <p className="small text-body-tertiary mb-0">
                Resolve a name to verify your contact resolution chain.
              </p>
            )}
          </CCardBody>
        </CCard>

      </CCol>
    </CRow>
  );
}
