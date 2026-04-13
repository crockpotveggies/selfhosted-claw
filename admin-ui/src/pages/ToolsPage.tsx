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

import { apiFetch, useJson } from '../admin/api';
import { useAdminDashboardContext } from '../admin/context';
import { PaginatedTable } from '../components/PaginatedTable';

interface IntegrationToolView {
  name: string;
  description: string;
  controllerOnly?: boolean;
  location: string;
  integration: string;
}

export function ToolsPage() {
  const dashboard = useAdminDashboardContext();
  const refreshKey = 'tools-refresh';

  // Fetch integration tools
  const [integrationTools, setIntegrationTools] = useState<IntegrationToolView[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const integrations = await apiFetch<Array<{
          name: string;
          capabilities: { tools?: IntegrationToolView[] };
        }>>('/api/admin/integrations');
        const tools: IntegrationToolView[] = [];
        for (const intg of integrations) {
          if (intg.capabilities.tools) {
            for (const tool of intg.capabilities.tools) {
              tools.push({ ...tool, integration: intg.name });
            }
          }
        }
        setIntegrationTools(tools);
      } catch {
        // ignore
      }
    })();
  }, []);

  // Combine control actions + integration tools
  const controlActions = dashboard.tools.map((t) => ({
    name: t.name,
    description: '',
    source: t.toolType || 'system',
    type: 'control-action' as const,
    commandable: t.commandableAction,
  }));

  const intgTools = integrationTools.map((t) => ({
    name: t.name,
    description: t.description,
    source: t.integration,
    type: 'integration-tool' as const,
    commandable: false,
    controllerOnly: t.controllerOnly,
    location: t.location,
  }));

  // Group all tools by source
  const allTools = [...intgTools, ...controlActions];
  const grouped = new Map<string, typeof allTools>();
  for (const tool of allTools) {
    const key = tool.source;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(tool);
  }

  return (
    <>
      <CCard className="mb-3">
        <CCardHeader className="d-flex justify-content-between align-items-center">
          <strong>Tool Registry</strong>
          <CButton
            size="sm"
            color="secondary"
            variant="outline"
            disabled={dashboard.isPending(refreshKey)}
            onClick={() =>
              void dashboard.runWithUiState(refreshKey, () =>
                dashboard.toolsState.refresh(),
              )
            }
          >
            <ArrowClockwise size={14} className="me-1" />
            {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
          </CButton>
        </CCardHeader>
        <CCardBody className="p-0">
          {dashboard.toolsState.loading ? (
            <p className="p-3 text-body-secondary">Loading...</p>
          ) : (
            <PaginatedTable
              items={allTools}
              renderTable={(pageItems) => (
                <CTable hover responsive align="middle" small className="mb-0">
                  <CTableHead>
                    <CTableRow>
                      <CTableHeaderCell className="bg-body-tertiary">Tool</CTableHeaderCell>
                      <CTableHeaderCell className="bg-body-tertiary">Source</CTableHeaderCell>
                      <CTableHeaderCell className="bg-body-tertiary text-center">Type</CTableHeaderCell>
                      <CTableHeaderCell className="bg-body-tertiary">Description</CTableHeaderCell>
                    </CTableRow>
                  </CTableHead>
                  <CTableBody>
                    {pageItems.length === 0 ? (
                      <CTableRow>
                        <CTableDataCell colSpan={4} className="text-center text-body-secondary py-4">
                          No tools registered
                        </CTableDataCell>
                      </CTableRow>
                    ) : (
                      pageItems.map((tool) => (
                        <CTableRow key={`${tool.type}-${tool.name}`}>
                          <CTableDataCell>
                            <code className="small">{tool.name}</code>
                          </CTableDataCell>
                          <CTableDataCell>
                            <CBadge
                              color={tool.type === 'integration-tool' ? 'info' : 'secondary'}
                              size="sm"
                            >
                              {tool.source}
                            </CBadge>
                          </CTableDataCell>
                          <CTableDataCell className="text-center">
                            {tool.type === 'integration-tool' ? (
                              <CBadge color="primary" size="sm">Agent Tool</CBadge>
                            ) : (
                              <CBadge color="dark" size="sm">
                                {tool.commandable ? 'Command' : 'Action'}
                              </CBadge>
                            )}
                          </CTableDataCell>
                          <CTableDataCell>
                            <div className="small text-body-secondary text-truncate" style={{ maxWidth: 350 }}>
                              {tool.description || '—'}
                            </div>
                          </CTableDataCell>
                        </CTableRow>
                      ))
                    )}
                  </CTableBody>
                </CTable>
              )}
            />
          )}
        </CCardBody>
      </CCard>

      {/* Group summary cards */}
      <CCard>
        <CCardHeader>
          <strong>By Source</strong>
        </CCardHeader>
        <CCardBody className="p-0">
          <CTable small responsive align="middle" className="mb-0">
            <CTableHead>
              <CTableRow>
                <CTableHeaderCell className="bg-body-tertiary">Source</CTableHeaderCell>
                <CTableHeaderCell className="bg-body-tertiary text-center">Agent Tools</CTableHeaderCell>
                <CTableHeaderCell className="bg-body-tertiary text-center">Control Actions</CTableHeaderCell>
                <CTableHeaderCell className="bg-body-tertiary text-center">Total</CTableHeaderCell>
              </CTableRow>
            </CTableHead>
            <CTableBody>
              {[...grouped.entries()].map(([source, tools]) => {
                const agentTools = tools.filter((t) => t.type === 'integration-tool').length;
                const actions = tools.filter((t) => t.type === 'control-action').length;
                return (
                  <CTableRow key={source}>
                    <CTableDataCell>
                      <CBadge color="info" size="sm">{source}</CBadge>
                    </CTableDataCell>
                    <CTableDataCell className="text-center small">{agentTools || '—'}</CTableDataCell>
                    <CTableDataCell className="text-center small">{actions || '—'}</CTableDataCell>
                    <CTableDataCell className="text-center small fw-semibold">{tools.length}</CTableDataCell>
                  </CTableRow>
                );
              })}
            </CTableBody>
          </CTable>
        </CCardBody>
      </CCard>
    </>
  );
}
