import { useAdminDashboardContext } from '../admin/context';

export function AuditPage() {
  const dashboard = useAdminDashboardContext();

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Audit Log</h2>
        <button onClick={() => void dashboard.auditState.refresh()}>Refresh</button>
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
