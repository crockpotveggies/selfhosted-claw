import { useAdminDashboardContext } from '../admin/context';

export function ApprovalsPage() {
  const dashboard = useAdminDashboardContext();

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Pending Approvals</h2>
        <button onClick={() => void dashboard.pendingState.refresh()}>Refresh</button>
      </div>
      {dashboard.pendingActions.length === 0 ? (
        <p>No pending approvals.</p>
      ) : (
        <div className="historyList">
          {dashboard.pendingActions.map((item) => (
            <article key={item.id} className="historyCard">
              <div className="historyMeta">
                <strong>{item.summary}</strong>
                <span>{item.status}</span>
              </div>
              <p>ID: {item.id}</p>
              <p>
                Source: {item.source} | Actor: {item.actorIdentity}
              </p>
              <p>
                Created: {item.createdAt}
                <br />
                Expires: {item.expiresAt}
              </p>
              <div className="buttonRow">
                <button onClick={() => void dashboard.decidePending(item.id, 'approve')}>
                  Approve
                </button>
                <button onClick={() => void dashboard.decidePending(item.id, 'reject')}>
                  Reject
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
