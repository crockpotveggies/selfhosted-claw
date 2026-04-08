import { useAdminDashboardContext } from '../admin/context';

export function ApprovalsPage() {
  const dashboard = useAdminDashboardContext();
  const refreshKey = 'approvals-refresh';

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Pending Approvals</h2>
        <button
          disabled={dashboard.isPending(refreshKey)}
          onClick={() =>
            void dashboard.runWithUiState(refreshKey, () =>
              dashboard.pendingState.refresh(),
            )
          }
        >
          {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
        </button>
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
                <button
                  disabled={dashboard.isPending(`approve:${item.id}`)}
                  onClick={() =>
                    void dashboard.runWithUiState(`approve:${item.id}`, () =>
                      dashboard.decidePending(item.id, 'approve'),
                    )
                  }
                >
                  {dashboard.isPending(`approve:${item.id}`)
                    ? 'Approving...'
                    : 'Approve'}
                </button>
                <button
                  disabled={dashboard.isPending(`reject:${item.id}`)}
                  onClick={() => {
                    if (!window.confirm('Reject this pending action?')) return;
                    void dashboard.runWithUiState(`reject:${item.id}`, () =>
                      dashboard.decidePending(item.id, 'reject'),
                    );
                  }}
                >
                  {dashboard.isPending(`reject:${item.id}`)
                    ? 'Rejecting...'
                    : 'Reject'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
