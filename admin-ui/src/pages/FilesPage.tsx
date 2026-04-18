import { useEffect, useState } from 'react';
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
import { ArrowClockwise } from 'react-bootstrap-icons';

import { apiFetch } from '../admin/api';

interface WorkspaceVisibility {
  jid: string;
  name: string;
  folder: string;
  mounts: Array<{
    kind: string;
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>;
  artifacts: Array<{
    name: string;
    path: string;
    sizeBytes: number;
    updatedAt: string;
  }>;
}

export function FilesPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceVisibility[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const result = await apiFetch<{ workspaces: WorkspaceVisibility[] }>(
        '/api/admin/files/visibility',
      );
      setWorkspaces(result.workspaces);
    } catch {
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <CCard>
      <CCardHeader className="d-flex justify-content-between align-items-center">
        <strong>Workspace Files and Visibility</strong>
        <CButton
          size="sm"
          color="secondary"
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <ArrowClockwise size={14} className="me-1" />
          {loading ? 'Loading...' : 'Refresh'}
        </CButton>
      </CCardHeader>
      <CCardBody className="p-0">
        <CTable hover responsive className="mb-0">
          <CTableHead>
            <CTableRow>
              <CTableHeaderCell className="bg-body-tertiary">Workspace</CTableHeaderCell>
              <CTableHeaderCell className="bg-body-tertiary">Mounts</CTableHeaderCell>
              <CTableHeaderCell className="bg-body-tertiary">Artifacts</CTableHeaderCell>
            </CTableRow>
          </CTableHead>
          <CTableBody>
            {workspaces.map((workspace) => (
              <CTableRow key={workspace.jid}>
                <CTableDataCell>
                  <div className="fw-semibold">{workspace.name}</div>
                  <div className="small text-body-secondary">
                    {workspace.folder}
                  </div>
                </CTableDataCell>
                <CTableDataCell>
                  {workspace.mounts.map((mount) => (
                    <div key={`${mount.kind}:${mount.hostPath}`} className="small mb-2">
                      <CBadge color="info" className="me-2">
                        {mount.kind}
                      </CBadge>
                      <code>{mount.hostPath}</code>
                      <div className="text-body-secondary">
                        {mount.containerPath} · {mount.readonly ? 'ro' : 'rw'}
                      </div>
                    </div>
                  ))}
                </CTableDataCell>
                <CTableDataCell>
                  {workspace.artifacts.length === 0 ? (
                    <span className="small text-body-secondary">No research artifacts yet</span>
                  ) : (
                    workspace.artifacts.slice(0, 8).map((artifact) => (
                      <div key={artifact.path} className="small mb-2">
                        <div className="fw-semibold">{artifact.name}</div>
                        <div className="text-body-secondary">{artifact.path}</div>
                      </div>
                    ))
                  )}
                </CTableDataCell>
              </CTableRow>
            ))}
          </CTableBody>
        </CTable>
      </CCardBody>
    </CCard>
  );
}
