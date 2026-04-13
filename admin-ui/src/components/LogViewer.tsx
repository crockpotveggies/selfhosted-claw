import { useEffect, useState } from 'react';
import {
  CBadge,
  CButton,
  CFormInput,
  CFormSelect,
  CTable,
  CTableBody,
  CTableDataCell,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from '@coreui/react';
import { apiFetch } from '../admin/api';
import { PaginatedTable } from './PaginatedTable';

interface LogEntry {
  id: number;
  time: string;
  level: number;
  level_label: string;
  msg: string;
  integration: string | null;
  channel: string | null;
  group_folder: string | null;
  entity: string | null;
  run_id: string | null;
  data: string | null;
}

const LEVEL_COLORS: Record<string, string> = {
  debug: 'secondary',
  info: 'info',
  warn: 'warning',
  error: 'danger',
  fatal: 'danger',
};

interface LogViewerProps {
  /** Pre-filter to a specific integration. */
  integration?: string;
  /** Pre-filter to a specific group. */
  group?: string;
  /** Max entries to show. Default: 50. */
  limit?: number;
}

export function LogViewer({
  integration,
  group,
  limit = 50,
}: LogViewerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState('info');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (levelFilter) params.set('level', levelFilter);
      if (integration) params.set('integration', integration);
      if (group) params.set('group', group);
      if (searchQuery) params.set('q', searchQuery);

      const data = await apiFetch<LogEntry[]>(
        `/api/admin/logs?${params.toString()}`,
      );
      setLogs(data);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchLogs();
  }, [integration, group, levelFilter]);

  const handleSearch = () => {
    void fetchLogs();
  };

  return (
    <div>
      <div className="d-flex gap-2 mb-3 flex-wrap">
        <CFormSelect
          size="sm"
          style={{ width: 120 }}
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
        >
          <option value="debug">Debug+</option>
          <option value="info">Info+</option>
          <option value="warn">Warn+</option>
          <option value="error">Error+</option>
        </CFormSelect>
        <CFormInput
          size="sm"
          placeholder="Search logs..."
          style={{ maxWidth: 250 }}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <CButton
          color="secondary"
          variant="outline"
          size="sm"
          onClick={handleSearch}
        >
          Search
        </CButton>
        <CButton
          color="secondary"
          variant="outline"
          size="sm"
          onClick={fetchLogs}
        >
          Refresh
        </CButton>
      </div>

      {loading ? (
        <p className="text-body-secondary">Loading logs...</p>
      ) : logs.length === 0 ? (
        <p className="text-body-secondary">No log entries found.</p>
      ) : (
        <PaginatedTable
          items={logs}
          defaultPageSize={50}
          renderTable={(pageItems) => (
            <CTable small striped hover responsive className="logTable mb-0">
              <CTableHead>
                <CTableRow>
                  <CTableHeaderCell style={{ width: 80 }}>Level</CTableHeaderCell>
                  <CTableHeaderCell style={{ width: 180 }}>Time</CTableHeaderCell>
                  {!integration && (
                    <CTableHeaderCell style={{ width: 120 }}>Integration</CTableHeaderCell>
                  )}
                  <CTableHeaderCell>Message</CTableHeaderCell>
                </CTableRow>
              </CTableHead>
              <CTableBody>
                {pageItems.map((log) => (
                  <>
                    <CTableRow
                      key={log.id}
                      onClick={() => setExpandedRow(expandedRow === log.id ? null : log.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <CTableDataCell>
                        <CBadge size="sm" color={LEVEL_COLORS[log.level_label] || 'secondary'}>{log.level_label}</CBadge>
                      </CTableDataCell>
                      <CTableDataCell className="text-body-secondary small">
                        {new Date(log.time).toLocaleString()}
                      </CTableDataCell>
                      {!integration && (
                        <CTableDataCell className="small">{log.integration || '-'}</CTableDataCell>
                      )}
                      <CTableDataCell className="small">
                        {log.msg}
                        {log.group_folder && <CBadge color="dark" className="ms-1" size="sm">{log.group_folder}</CBadge>}
                      </CTableDataCell>
                    </CTableRow>
                    {expandedRow === log.id && log.data && (
                      <CTableRow key={`${log.id}-detail`}>
                        <CTableDataCell colSpan={integration ? 3 : 4} className="bg-body-tertiary">
                          <pre className="small mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                            {JSON.stringify(JSON.parse(log.data), null, 2)}
                          </pre>
                        </CTableDataCell>
                      </CTableRow>
                    )}
                  </>
                ))}
              </CTableBody>
            </CTable>
          )}
        />
      )}
    </div>
  );
}
