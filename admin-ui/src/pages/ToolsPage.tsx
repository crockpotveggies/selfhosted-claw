import type { CSSProperties } from 'react';
import { CCol, CRow, CWidgetStatsE } from '@coreui/react';

import { useAdminDashboardContext } from '../admin/context';
import {
  formatRegistryName,
  getToolCapabilities,
  getToolVisual,
} from '../admin/toolRegistry';

export function ToolsPage() {
  const dashboard = useAdminDashboardContext();
  const refreshKey = 'tools-refresh';

  return (
    <>
      <section className="panel">
        <div className="panelHeader">
          <h2>Tool Registry</h2>
          <button
            disabled={dashboard.isPending(refreshKey)}
            onClick={() =>
              void dashboard.runWithUiState(refreshKey, () =>
                dashboard.toolsState.refresh(),
              )
            }
          >
            {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <p className="mutedNote">
          These cards come directly from the registered control-action definitions on
          the server, grouped by integration or capability family.
        </p>
      </section>

      {dashboard.toolsState.loading ? (
        <section className="panel">
          <p>Loading tool registry...</p>
        </section>
      ) : dashboard.toolsState.error ? (
        <section className="panel">
          <p>Tool registry could not be loaded.</p>
          <p className="mutedNote">{dashboard.toolsState.error}</p>
        </section>
      ) : dashboard.groupedTools.length === 0 ? (
        <section className="panel">
          <p>No tools are registered yet.</p>
        </section>
      ) : (
        dashboard.groupedTools.map(([groupKey, groupTools]) => {
          const groupVisual = getToolVisual({
            name: groupKey,
            commandableAction: false,
            toolType: groupKey,
          });

          return (
            <section key={groupKey} className="toolGroupSection">
              <div className="panel toolGroupPanel">
                <div className="panelHeader toolGroupHeader">
                  <div>
                    <h2>{groupVisual.label}</h2>
                    <p className="mutedNote">
                      {groupTools.length} registered tool
                      {groupTools.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span
                    className="toolLegendPill"
                    style={
                      {
                        '--tool-accent': groupVisual.accent,
                        '--tool-accent-soft': groupVisual.accentSoft,
                      } as CSSProperties
                    }
                  >
                    {groupVisual.icon}
                    {groupVisual.label}
                  </span>
                </div>
              </div>
              <CRow className="g-4">
                {groupTools.map((tool) => {
                  const visual = getToolVisual(tool);
                  return (
                    <CCol md={6} xxl={4} key={tool.name}>
                      <CWidgetStatsE
                        className="toolWidget"
                        style={
                          {
                            '--tool-accent': visual.accent,
                            '--tool-accent-soft': visual.accentSoft,
                          } as CSSProperties
                        }
                        title={formatRegistryName(tool.name)}
                        value={
                          <div className="toolWidgetValue">
                            <span className="toolColorPill">{visual.label}</span>
                            <span className="toolIconWrap">{visual.icon}</span>
                          </div>
                        }
                        chart={
                          <div className="toolWidgetMeta">
                            <code>{tool.name}</code>
                            <div className="toolCapabilityRow">
                              {getToolCapabilities(tool).map((capability) => (
                                <span key={capability} className="toolCapability">
                                  {capability}
                                </span>
                              ))}
                            </div>
                          </div>
                        }
                      />
                    </CCol>
                  );
                })}
              </CRow>
            </section>
          );
        })
      )}
    </>
  );
}
