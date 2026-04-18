import { useEffect, useState } from 'react';
import {
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CFormInput,
  CFormLabel,
  CRow,
} from '@coreui/react';
import {
  ExclamationTriangleFill,
  InfoCircleFill,
  BugFill,
} from 'react-bootstrap-icons';

import { apiFetch } from '../admin/api';
import { LogViewer } from '../components/LogViewer';

interface LogStats {
  total: number;
  byLevel: Record<string, number>;
  byIntegration: Record<string, number>;
}

interface LogSettings {
  retentionDays: number;
  maxSizeMb: number;
  pruneIntervalMinutes: number;
  minLevel: string;
}

export function LogsPage() {
  const [stats, setStats] = useState<LogStats | null>(null);
  const [settings, setSettings] = useState<LogSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const loadStats = async () => {
    try {
      setStats(await apiFetch<LogStats>('/api/admin/logs/stats'));
    } catch {
      // Ignore
    }
  };

  const loadSettings = async () => {
    try {
      setSettings(
        await apiFetch<LogSettings>('/api/admin/logs/settings'),
      );
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    void loadStats();
    void loadSettings();
  }, []);

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const result = await apiFetch<LogSettings>(
        '/api/admin/logs/settings',
        { method: 'POST', body: JSON.stringify(settings) },
      );
      setSettings(result);
    } catch {
      // Error
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panelHeader">
          <h2>Logs</h2>
          <CButton size="sm" onClick={() => void loadStats()}>
            Refresh Stats
          </CButton>
        </div>
        <p className="mutedNote">
          Structured logs from all integrations. Filter by level,
          integration, group, or search text.
        </p>
      </section>

      {/* Stats */}
      {stats && (
        <CRow className="g-3 mb-4">
          <CCol sm={4}>
            <CCard className="text-center py-3">
              <CCardBody>
                <InfoCircleFill size={24} className="text-info mb-1" />
                <div className="fs-4 fw-bold">{stats.total}</div>
                <div className="small text-body-secondary">Total Entries</div>
              </CCardBody>
            </CCard>
          </CCol>
          <CCol sm={4}>
            <CCard className="text-center py-3">
              <CCardBody>
                <ExclamationTriangleFill size={24} className="text-warning mb-1" />
                <div className="fs-4 fw-bold">
                  {(stats.byLevel.warn || 0) +
                    (stats.byLevel.error || 0) +
                    (stats.byLevel.fatal || 0)}
                </div>
                <div className="small text-body-secondary">Warnings+</div>
              </CCardBody>
            </CCard>
          </CCol>
          <CCol sm={4}>
            <CCard className="text-center py-3">
              <CCardBody>
                <BugFill size={24} className="text-danger mb-1" />
                <div className="fs-4 fw-bold">
                  {(stats.byLevel.error || 0) + (stats.byLevel.fatal || 0)}
                </div>
                <div className="small text-body-secondary">Errors+</div>
              </CCardBody>
            </CCard>
          </CCol>
        </CRow>
      )}

      {/* Retention settings */}
      {settings && (
        <CCard className="mb-4">
          <CCardHeader>
            <strong>Retention Settings</strong>
          </CCardHeader>
          <CCardBody>
            <CRow className="g-3">
              <CCol sm={3}>
                <CFormLabel>Retention (days)</CFormLabel>
                <CFormInput
                  type="number"
                  min={1}
                  max={365}
                  value={settings.retentionDays}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      retentionDays: Number(e.target.value),
                    })
                  }
                />
              </CCol>
              <CCol sm={3}>
                <CFormLabel>Max size (MB)</CFormLabel>
                <CFormInput
                  type="number"
                  min={10}
                  max={2000}
                  value={settings.maxSizeMb}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      maxSizeMb: Number(e.target.value),
                    })
                  }
                />
              </CCol>
              <CCol sm={3}>
                <CFormLabel>Prune interval (min)</CFormLabel>
                <CFormInput
                  type="number"
                  min={5}
                  max={1440}
                  value={settings.pruneIntervalMinutes}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      pruneIntervalMinutes: Number(e.target.value),
                    })
                  }
                />
              </CCol>
              <CCol sm={3} className="d-flex align-items-end">
                <CButton
                  color="primary"
                  size="sm"
                  onClick={saveSettings}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : 'Save'}
                </CButton>
              </CCol>
            </CRow>
          </CCardBody>
        </CCard>
      )}

      {/* Log viewer */}
      <CCard>
        <CCardHeader>
          <strong>All Logs</strong>
        </CCardHeader>
        <CCardBody>
          <LogViewer limit={100} />
        </CCardBody>
      </CCard>
    </>
  );
}
