import { useState } from 'react';
import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCol,
  CFormSwitch,
  CRow,
} from '@coreui/react';
import {
  CheckCircleFill,
  ExclamationTriangleFill,
  XCircleFill,
  QuestionCircleFill,
} from 'react-bootstrap-icons';

import { apiFetch, useJson } from '../admin/api';
import { IntegrationDetailPage } from './IntegrationDetailPage';

interface IntegrationView {
  name: string;
  description: string;
  version: string;
  core: boolean;
  category: string;
  icon: string;
  enabled: boolean;
  status: { state: string; message: string };
  service?: { running: boolean; lastError?: string; circuitOpen?: boolean };
  capabilities: {
    hasChannel: boolean;
    toolCount: number;
    hasSkills: boolean;
    hasMemory: boolean;
    hasSetup: boolean;
  };
}

function StatusIcon({ state }: { state: string }) {
  switch (state) {
    case 'online':
      return <CheckCircleFill size={14} className="text-success" />;
    case 'degraded':
      return <ExclamationTriangleFill size={14} className="text-warning" />;
    case 'offline':
      return <XCircleFill size={14} className="text-danger" />;
    default:
      return <QuestionCircleFill size={14} className="text-body-tertiary" />;
  }
}

export function IntegrationsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, loading, error, refresh } = useJson<IntegrationView[]>(
    'integrations',
    () => apiFetch('/api/admin/integrations'),
  );

  if (selected) {
    return (
      <IntegrationDetailPage
        name={selected}
        onBack={() => {
          setSelected(null);
          void refresh();
        }}
      />
    );
  }

  const integrations = data || [];
  const grouped = new Map<string, IntegrationView[]>();
  for (const i of integrations) {
    const cat = i.category || 'utility';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(i);
  }

  const handleToggle = async (name: string, enabled: boolean) => {
    await apiFetch(`/api/admin/integrations/${name}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    void refresh();
  };

  return (
    <>
      <section className="panel">
        <div className="panelHeader">
          <h2>Integrations</h2>
          <CButton
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </CButton>
        </div>
        <p className="mutedNote">
          Installed integrations and their connection status. Click a card to
          configure settings, run setup, or view logs.
        </p>
      </section>

      {error && (
        <section className="panel">
          <p className="text-danger">{error}</p>
        </section>
      )}

      {[...grouped.entries()].map(([category, items]) => (
        <section key={category} className="mb-4">
          <h3 className="text-body-secondary text-uppercase small mb-3">
            {category}
          </h3>
          <CRow className="g-3">
            {items.map((intg) => (
              <CCol key={intg.name} sm={6} xl={4}>
                <CCard
                  className="integrationCard"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(intg.name)}
                >
                  <CCardBody>
                    <div className="d-flex justify-content-between align-items-start mb-2">
                      <div>
                        <h5 className="mb-1">{intg.name}</h5>
                        <p className="small text-body-secondary mb-0">
                          {intg.description}
                        </p>
                      </div>
                      <div className="d-flex align-items-center gap-2">
                        {intg.core ? (
                          <CBadge color="primary" size="sm">
                            Core
                          </CBadge>
                        ) : (
                          <CBadge color="secondary" size="sm" className="me-2">
                            Plugin
                          </CBadge>
                        )}
                        {!intg.core && (
                          <CFormSwitch
                            checked={intg.enabled}
                            onChange={(e) => {
                              e.stopPropagation();
                              void handleToggle(
                                intg.name,
                                e.target.checked,
                              );
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </div>
                    </div>

                    <div className="d-flex align-items-center gap-2 mb-2">
                      <StatusIcon state={intg.status.state} />
                      <span className="small">{intg.status.message}</span>
                    </div>

                    {intg.service && (
                      <div className="small text-body-secondary mb-2">
                        Service:{' '}
                        <span
                          className={
                            intg.service.running
                              ? 'text-success'
                              : 'text-danger'
                          }
                        >
                          {intg.service.running ? 'Running' : 'Stopped'}
                        </span>
                        {intg.service.circuitOpen && (
                          <CBadge color="danger" size="sm" className="ms-1">
                            Circuit Open
                          </CBadge>
                        )}
                      </div>
                    )}

                    <div className="d-flex gap-1 flex-wrap">
                      {intg.capabilities.hasChannel && (
                        <CBadge color="dark" size="sm">
                          Channel
                        </CBadge>
                      )}
                      {intg.capabilities.toolCount > 0 && (
                        <CBadge color="dark" size="sm">
                          {intg.capabilities.toolCount} Tools
                        </CBadge>
                      )}
                      {intg.capabilities.hasSkills && (
                        <CBadge color="dark" size="sm">
                          Skill
                        </CBadge>
                      )}
                      {intg.capabilities.hasMemory && (
                        <CBadge color="dark" size="sm">
                          Memory
                        </CBadge>
                      )}
                    </div>
                  </CCardBody>
                </CCard>
              </CCol>
            ))}
          </CRow>
        </section>
      ))}

      {!loading && integrations.length === 0 && (
        <section className="panel">
          <p>No integrations registered yet.</p>
        </section>
      )}
    </>
  );
}
