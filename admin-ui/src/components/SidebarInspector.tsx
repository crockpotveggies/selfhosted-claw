import type { CSSProperties } from 'react';
import { CBadge, CCard, CCardBody, CCardHeader } from '@coreui/react';

import { useAdminDashboardContext } from '../admin/context';
import { getToolVisual } from '../admin/toolRegistry';
import type { AdminTab } from '../admin/types';

export function SidebarInspector(props: { activeTab: AdminTab }) {
  const dashboard = useAdminDashboardContext();

  if (props.activeTab === 'contacts') {
    return (
      <CCard className="sidebarCard">
        <CCardHeader className="sidebarCardHeader">
          <h2>Selected contact</h2>
          {dashboard.selectedContact ? (
            <CBadge className={`status ${dashboard.selectedContact.status}`}>
              {dashboard.selectedContact.status}
            </CBadge>
          ) : null}
        </CCardHeader>
        <CCardBody>
          {dashboard.selectedContact ? (
            <>
              <p>
                <strong>{dashboard.selectedContact.displayName}</strong>
              </p>
              <p className="mutedNote">{dashboard.selectedContact.identity}</p>
              <p>{dashboard.selectedContact.classificationSummary || 'No summary yet.'}</p>
            </>
          ) : (
            <p className="mutedNote">
              Pick a contact to inspect message history and trust state.
            </p>
          )}
        </CCardBody>
      </CCard>
    );
  }

  if (props.activeTab === 'personality') {
    return (
      <CCard className="sidebarCard">
        <CCardHeader className="sidebarCardHeader">
          <h2>Preview scope</h2>
          <span className="mutedMeta">{dashboard.scope}</span>
        </CCardHeader>
        <CCardBody>
          <p className="mutedNote">Role: {dashboard.personalityForm.role || 'Unset'}</p>
          <p className="mutedNote">Tone: {dashboard.personalityForm.tone || 'Unset'}</p>
          <p className="mutedNote">
            Initiative: {dashboard.personalityForm.initiative || 'Unset'}
          </p>
        </CCardBody>
      </CCard>
    );
  }

  if (props.activeTab === 'policy') {
    return (
      <CCard className="sidebarCard">
        <CCardHeader className="sidebarCardHeader">
          <h2>Trust ledger</h2>
        </CCardHeader>
        <CCardBody>
          <p className="mutedNote">
            Verified identities: {dashboard.verifiedIdentities.length}
          </p>
          <p className="mutedNote">
            Paused providers:{' '}
            {dashboard.policy.pausedProviders.length
              ? dashboard.policy.pausedProviders.join(', ')
              : 'none'}
          </p>
          <p className="mutedNote">
            Contact resolution:{' '}
            {dashboard.providers.contactResolutionAvailable ? 'available' : 'offline'}
          </p>
        </CCardBody>
      </CCard>
    );
  }

  if (props.activeTab === 'approvals') {
    return (
      <CCard className="sidebarCard">
        <CCardHeader className="sidebarCardHeader">
          <h2>Queue focus</h2>
        </CCardHeader>
        <CCardBody>
          {dashboard.pendingActions[0] ? (
            <>
              <p>
                <strong>{dashboard.pendingActions[0].summary}</strong>
              </p>
              <p className="mutedNote">
                Requested by {dashboard.pendingActions[0].actorIdentity}
              </p>
              <p className="mutedNote">Expires {dashboard.pendingActions[0].expiresAt}</p>
            </>
          ) : (
            <p className="mutedNote">No approvals are waiting right now.</p>
          )}
        </CCardBody>
      </CCard>
    );
  }

  if (props.activeTab === 'tools') {
    return (
      <CCard className="sidebarCard">
        <CCardHeader className="sidebarCardHeader">
          <h2>Registry summary</h2>
        </CCardHeader>
        <CCardBody>
          <p className="mutedNote">Registered tools: {dashboard.tools.length}</p>
          <p className="mutedNote">Tool families: {dashboard.groupedTools.length}</p>
          <div className="toolLegendList">
            {dashboard.groupedTools.map(([groupKey]) => {
              const visual = getToolVisual({
                name: groupKey,
                commandableAction: false,
                toolType: groupKey,
              });
              return (
                <span
                  key={groupKey}
                  className="toolLegendPill"
                  style={
                    {
                      '--tool-accent': visual.accent,
                      '--tool-accent-soft': visual.accentSoft,
                    } as CSSProperties
                  }
                >
                  {visual.icon}
                  {visual.label}
                </span>
              );
            })}
          </div>
        </CCardBody>
      </CCard>
    );
  }

  if (props.activeTab === 'connections') {
    return (
      <CCard className="sidebarCard">
        <CCardHeader className="sidebarCardHeader">
          <h2>Connection summary</h2>
        </CCardHeader>
        <CCardBody>
          <p className="mutedNote">OneCLI URL: {dashboard.setupDraft.ONECLI_URL || 'Unset'}</p>
          <p className="mutedNote">
            Signal RPC: {dashboard.setupDraft.SIGNAL_RPC_URL || 'Unset'}
          </p>
          <p className="mutedNote">
            Google Contacts source:{' '}
            {dashboard.providers.googleContactsAvailable
              ? dashboard.providers.googleContactsSource
              : 'offline'}
          </p>
        </CCardBody>
      </CCard>
    );
  }

  return (
    <CCard className="sidebarCard">
      <CCardHeader className="sidebarCardHeader">
        <h2>Latest event</h2>
      </CCardHeader>
      <CCardBody>
        {dashboard.auditRecords[0] ? (
          <>
            <p>
              <strong>{dashboard.auditRecords[0].actionName}</strong>
            </p>
            <p className="mutedNote">{dashboard.auditRecords[0].payloadSummary}</p>
            <p className="mutedNote">
              {dashboard.auditRecords[0].actorIdentity} | {dashboard.auditRecords[0].status}
            </p>
          </>
        ) : (
          <p className="mutedNote">No audit events recorded yet.</p>
        )}
      </CCardBody>
    </CCard>
  );
}
