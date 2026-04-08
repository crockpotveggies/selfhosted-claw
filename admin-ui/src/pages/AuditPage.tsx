import { useAdminDashboardContext } from '../admin/context';

export function AuditPage() {
  const dashboard = useAdminDashboardContext();
  const refreshKey = 'audit-refresh';

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Audit Log</h2>
        <button
          disabled={dashboard.isPending(refreshKey)}
          onClick={() =>
            void dashboard.runWithUiState(refreshKey, () =>
              dashboard.auditState.refresh(),
            )
          }
        >
          {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      <div className="historyList">
        {dashboard.auditRecords.map((record) => (
          <article key={record.id} className="historyCard">
            <div className="historyMeta">
              <strong>{record.actionName}</strong>
              <span>{record.createdAt}</span>
            </div>
            <p>{record.payloadSummary}</p>
            <p>
              Actor: {record.actorIdentity} | Status: {record.status}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
