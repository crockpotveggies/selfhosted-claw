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
import { useAdminDashboardContext } from '../admin/context';
import type {
  EffectiveToolRegistryItem,
  ToolAccessPolicy,
} from '../admin/types';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { PaginatedTable } from '../components/PaginatedTable';

function summarizeSource(tool: EffectiveToolRegistryItem): string {
  if (tool.sourceKind === 'core-runner') return 'Runner Core';
  if (tool.sourceKind === 'control-action') return 'Control Plane';
  return tool.source;
}

function sortTools(tools: EffectiveToolRegistryItem[]) {
  return [...tools].sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
}

function withToolPolicy(
  policy: ToolAccessPolicy,
  toolName: string,
  patch: { enabled?: boolean; controllerOnly?: boolean },
): ToolAccessPolicy {
  return {
    ...policy,
    tools: {
      ...policy.tools,
      [toolName]: {
        ...(policy.tools[toolName] || {}),
        ...patch,
      },
    },
  };
}

export function ToolsPage() {
  const dashboard = useAdminDashboardContext();
  const refreshKey = 'tools-refresh';
  const saveKey = 'tools-save-policy';
  const tools = sortTools(dashboard.effectiveTools);
  const policy = dashboard.toolAccessPolicy;

  const savePolicy = async (nextPolicy: ToolAccessPolicy) => {
    await dashboard.runWithUiState(saveKey, async () => {
      await apiFetch('/api/admin/tool-registry/policy', {
        method: 'POST',
        body: JSON.stringify(nextPolicy),
      });
      await dashboard.effectiveToolRegistryState.refresh();
    });
  };

  const agentTools = tools.filter((tool) => tool.agentVisible);
  const controlActions = tools.filter((tool) => !tool.agentVisible);

  return (
    <>
      <CCard className="mb-3">
        <CCardHeader className="d-flex justify-content-between align-items-center">
          <strong>Effective Agent Tool Registry</strong>
          <CButton
            size="sm"
            color="secondary"
            variant="outline"
            disabled={dashboard.isPending(refreshKey)}
            onClick={() =>
              void dashboard.runWithUiState(refreshKey, () =>
                Promise.all([
                  dashboard.toolsState.refresh(),
                  dashboard.effectiveToolRegistryState.refresh(),
                ]),
              )
            }
          >
            <ArrowClockwise size={14} className="me-1" />
            {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
          </CButton>
        </CCardHeader>
        <CCardBody className="p-0">
          <PaginatedTable
            items={agentTools}
            defaultPageSize={100}
            renderTable={(pageItems) => (
              <CTable hover responsive align="middle" small className="mb-0">
                <CTableHead>
                  <CTableRow>
                    <CTableHeaderCell className="bg-body-tertiary">Tool</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary">Source</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary">Description</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary text-center">Controller Only</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary text-center">Enabled</CTableHeaderCell>
                  </CTableRow>
                </CTableHead>
                <CTableBody>
                  {pageItems.length === 0 ? (
                    <CTableRow>
                      <CTableDataCell colSpan={5} className="text-center text-body-secondary py-4">
                        No agent tools registered
                      </CTableDataCell>
                    </CTableRow>
                  ) : (
                    pageItems.map((tool) => (
                      <CTableRow
                        key={tool.name}
                        className={tool.enabled ? '' : 'tool-row-disabled'}
                      >
                        <CTableDataCell>
                          <code className="small">{tool.name}</code>
                        </CTableDataCell>
                        <CTableDataCell>
                          <CBadge
                            color={tool.sourceKind === 'integration' ? 'info' : 'secondary'}
                            size="sm"
                          >
                            {summarizeSource(tool)}
                          </CBadge>
                        </CTableDataCell>
                        <CTableDataCell>
                          <div
                            className="small text-body-secondary tool-description"
                            title={tool.description || '—'}
                          >
                            {tool.description || '—'}
                          </div>
                        </CTableDataCell>
                        <CTableDataCell className="text-center">
                          <ToggleSwitch
                            checked={tool.controllerOnly}
                            disabled={!tool.enabled || dashboard.isPending(saveKey)}
                            ariaLabel={`Restrict ${tool.name} to controller only`}
                            onChange={(checked) =>
                              void savePolicy(
                                withToolPolicy(policy, tool.name, {
                                  controllerOnly: checked,
                                }),
                              )
                            }
                          />
                        </CTableDataCell>
                        <CTableDataCell className="text-center">
                          <ToggleSwitch
                            checked={tool.enabled}
                            disabled={dashboard.isPending(saveKey)}
                            ariaLabel={`Enable ${tool.name}`}
                            onChange={(checked) =>
                              void savePolicy(
                                withToolPolicy(policy, tool.name, {
                                  enabled: checked,
                                }),
                              )
                            }
                          />
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

      <CCard>
        <CCardHeader>
          <strong>Control Actions</strong>
        </CCardHeader>
        <CCardBody className="p-0">
          <CTable small responsive align="middle" className="mb-0">
            <CTableHead>
              <CTableRow>
                <CTableHeaderCell className="bg-body-tertiary">Action</CTableHeaderCell>
                <CTableHeaderCell className="bg-body-tertiary">Type</CTableHeaderCell>
                <CTableHeaderCell className="bg-body-tertiary">Source</CTableHeaderCell>
              </CTableRow>
            </CTableHead>
            <CTableBody>
              {sortTools(controlActions).map((tool) => (
                <CTableRow key={tool.name}>
                  <CTableDataCell>
                    <code className="small">{tool.name}</code>
                  </CTableDataCell>
                  <CTableDataCell>
                    <CBadge color="dark" size="sm">
                      {tool.commandableAction ? 'Command' : 'Action'}
                    </CBadge>
                  </CTableDataCell>
                  <CTableDataCell>
                    <span className="small text-body-secondary">{tool.source}</span>
                  </CTableDataCell>
                </CTableRow>
              ))}
            </CTableBody>
          </CTable>
        </CCardBody>
      </CCard>
    </>
  );
}
