import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCol,
  CRow,
} from '@coreui/react';
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

function statusLightColor(intg: IntegrationView): string {
  if (!intg.enabled) return 'var(--cui-secondary)';       // gray — disabled
  if (intg.status.state === 'online') return 'var(--cui-success)';  // green
  if (intg.status.state === 'degraded') return 'var(--cui-warning)'; // yellow
  if (intg.status.state === 'offline') return 'var(--cui-danger)';   // red
  return 'var(--cui-secondary)';                           // gray — unconfigured
}

export function IntegrationsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data, loading, error, refresh } = useJson<IntegrationView[]>(
    'integrations',
    () => apiFetch('/api/admin/integrations'),
  );

  // Read selected integration from URL search param
  const params = new URLSearchParams(location.search);
  const selected = params.get('select');

  const selectIntegration = (name: string) => {
    navigate(`/integrations?select=${encodeURIComponent(name)}`, { replace: false });
  };

  const deselectIntegration = () => {
    navigate('/integrations', { replace: false });
    void refresh();
  };

  // Auto-refresh every 30 seconds so status changes appear
  useEffect(() => {
    if (selected) return;
    const interval = setInterval(() => void refresh(), 30000);
    return () => clearInterval(interval);
  }, [selected]);

  if (selected) {
    return (
      <IntegrationDetailPage
        name={selected}
        onBack={deselectIntegration}
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
                  onClick={() => selectIntegration(intg.name)}
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
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            backgroundColor: statusLightColor(intg),
                            display: 'inline-block',
                            flexShrink: 0,
                          }}
                        />
                        {intg.core ? (
                          <CBadge color="primary" size="sm">
                            Core
                          </CBadge>
                        ) : intg.enabled ? (
                          <CBadge
                            color="success"
                            size="sm"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`Disable "${intg.name}"?`)) {
                                void handleToggle(intg.name, false);
                              }
                            }}
                          >
                            Enabled
                          </CBadge>
                        ) : (
                          <CBadge
                            color="secondary"
                            size="sm"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`Enable "${intg.name}"?`)) {
                                void handleToggle(intg.name, true);
                              }
                            }}
                          >
                            Disabled
                          </CBadge>
                        )}
                      </div>
                    </div>

                    <div className="small text-body-secondary mb-2">
                      {intg.status.message}
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
