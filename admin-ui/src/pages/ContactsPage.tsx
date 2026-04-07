import { useAdminDashboardContext } from '../admin/context';

export function ContactsPage() {
  const dashboard = useAdminDashboardContext();

  return (
    <>
      <section className="panelGrid">
        <div className="panel">
          <div className="panelHeader">
            <h2>Contacts</h2>
            <select
              value={dashboard.contactStatusFilter}
              onChange={(event) => dashboard.setContactStatusFilter(event.target.value)}
            >
              <option value="">All</option>
              <option value="trusted">Trusted</option>
              <option value="unknown">Unknown</option>
              <option value="abuse">Abuse</option>
            </select>
          </div>
          <div className="contactList">
            {dashboard.contacts.map((contact) => (
              <button
                key={contact.identity}
                className={
                  dashboard.selectedContactId === contact.identity
                    ? 'contactRow selected'
                    : 'contactRow'
                }
                onClick={() => dashboard.setSelectedContactId(contact.identity)}
              >
                <span>{contact.displayName}</span>
                <span className={`status ${contact.status}`}>{contact.status}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panelHeader">
            <h2>Contact Detail</h2>
            {dashboard.selectedContact ? (
              <div className="buttonRow">
                <button
                  onClick={() =>
                    void dashboard.mutate('contact.trust', {
                      identity: dashboard.selectedContact?.identity,
                    })
                  }
                >
                  Trust
                </button>
                <button
                  onClick={() =>
                    void dashboard.mutate('contact.abuse', {
                      identity: dashboard.selectedContact?.identity,
                    })
                  }
                >
                  Abuse
                </button>
                <button
                  onClick={() =>
                    void dashboard.mutate('contact.reset', {
                      identity: dashboard.selectedContact?.identity,
                    })
                  }
                >
                  Reset
                </button>
                <button
                  onClick={() =>
                    void dashboard.mutate('contact.reclassify', {
                      identity: dashboard.selectedContact?.identity,
                    })
                  }
                >
                  Re-classify
                </button>
              </div>
            ) : null}
          </div>
          {dashboard.selectedContact ? (
            <>
              <p>
                <strong>{dashboard.selectedContact.displayName}</strong> (
                {dashboard.selectedContact.identity})
              </p>
              <p>
                Status:{' '}
                <span className={`status ${dashboard.selectedContact.status}`}>
                  {dashboard.selectedContact.status}
                </span>
              </p>
              <p>
                {dashboard.selectedContact.classificationSummary ||
                  'No classification summary yet.'}
              </p>
              <h3>History</h3>
              <div className="historyList">
                {dashboard.selectedContact.history.map((entry) => (
                  <article key={entry.id} className="historyCard">
                    <div className="historyMeta">
                      <strong>{entry.senderName}</strong>
                      <span>{entry.timestamp}</span>
                    </div>
                    <p>{entry.content}</p>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p>Select a contact to inspect its history.</p>
          )}
        </div>
      </section>

      <section className="panel googleContactsPanel">
        <div className="panelHeader">
          <h2>Google Contacts Setup</h2>
          <span className="setupBadge">
            {dashboard.providers.googleContactsAvailable ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <p>
          Use this when you want the agent to resolve people like “Elyssa” from
          Google Contacts before starting a new Signal, SMS, or email thread.
        </p>
        <div className="hintBox">
          <p>
            Enable the <strong>People API</strong> in Google Cloud, then create an
            OAuth client.
          </p>
          <p>
            Application type: <strong>Web application</strong>
          </p>
          <p>Authorized JavaScript origin:</p>
          <code className="inlineBlock">{dashboard.googleContactsSetup.origin}</code>
          <p>Authorized redirect URI:</p>
          <code className="inlineBlock">{dashboard.googleContactsSetup.callbackUri}</code>
          <p>Scope to request:</p>
          <code className="inlineBlock">
            {dashboard.googleContactsSetup.scopes.join(' ')}
          </code>
          <p>
            Current status: client ID{' '}
            {dashboard.googleContactsSetup.configured.clientId ? 'saved' : 'missing'},
            client secret{' '}
            {dashboard.googleContactsSetup.configured.clientSecret
              ? 'saved'
              : 'missing'}
            , access token{' '}
            {dashboard.googleContactsSetup.configured.accessToken ? 'present' : 'missing'}.
          </p>
        </div>
        <div className="wizardGrid">
          <label>
            Google client ID
            <input
              value={dashboard.googleClientId}
              onChange={(event) => dashboard.setGoogleClientId(event.target.value)}
              placeholder="Google OAuth web client ID"
            />
          </label>
          <label>
            Google client secret
            <input
              type="password"
              value={dashboard.googleClientSecret}
              onChange={(event) => dashboard.setGoogleClientSecret(event.target.value)}
              placeholder="Google OAuth client secret"
            />
          </label>
        </div>
        <div className="buttonRow">
          <button onClick={() => void dashboard.saveGoogleContactsCredentials()}>
            Save Google OAuth settings
          </button>
          <button
            onClick={() => void dashboard.connectGoogleContacts()}
            disabled={
              !dashboard.googleContactsSetup.configured.clientId ||
              !dashboard.googleContactsSetup.configured.clientSecret
            }
          >
            Connect Google Contacts
          </button>
        </div>
        <p className="mutedNote">
          After saving the client ID and secret, use Connect Google Contacts to
          complete the consent flow in your browser.
        </p>
      </section>
    </>
  );
}
