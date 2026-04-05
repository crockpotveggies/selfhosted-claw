import { useEffect, useMemo, useState } from 'react';

type ContactStatus = 'trusted' | 'unknown' | 'abuse';
type PersonalityScope = 'global' | 'main' | `group:${string}`;

interface ContactView {
  identity: string;
  displayName: string;
  status: ContactStatus;
  messageCount: number;
  lastMessageTime: string;
  classificationSummary: string;
}

interface ContactDetailView extends ContactView {
  history: Array<{
    id: string;
    chatJid: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
  }>;
}

interface PersonalityProfile {
  scope: PersonalityScope;
  displayName: string;
  role: string;
  tone: string;
  communicationStyle: string;
  initiative: string;
  customInstructions: string;
}

interface ControlPolicy {
  pausedProviders: string[];
}

interface VerifiedIdentity {
  identity: string;
  label: string;
}

interface ControlSettings {
  controlSignalJid: string;
  assistantSignalIdentity: string;
}

interface AuditRecord {
  id: string;
  actorIdentity: string;
  actionName: string;
  status: string;
  createdAt: string;
  payloadSummary: string;
}

async function apiFetch<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const token = window.localStorage.getItem('admin-ui-token') || '';
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
      ...(options?.headers || {}),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return (await response.json()) as T;
}

function useJson<T>(key: string, loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loader());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [key]);

  return { data, error, loading, refresh };
}

export function App() {
  const [tab, setTab] = useState<'contacts' | 'personality' | 'policy' | 'audit'>('contacts');
  const [contactStatusFilter, setContactStatusFilter] = useState<string>('');
  const [selectedContactId, setSelectedContactId] = useState('');
  const [scope, setScope] = useState<PersonalityScope>('global');
  const [personalityForm, setPersonalityForm] = useState<PersonalityProfile>({
    scope: 'global',
    displayName: '',
    role: '',
    tone: '',
    communicationStyle: '',
    initiative: '',
    customInstructions: '',
  });
  const [providerInput, setProviderInput] = useState('signal');
  const [verifiedIdentityInput, setVerifiedIdentityInput] = useState('');
  const [verifiedLabelInput, setVerifiedLabelInput] = useState('');
  const [settingsDraft, setSettingsDraft] = useState<ControlSettings>({
    controlSignalJid: '',
    assistantSignalIdentity: '',
  });
  const [tokenDraft, setTokenDraft] = useState(
    window.localStorage.getItem('admin-ui-token') || '',
  );
  const contactsKey = `contacts:${contactStatusFilter}`;
  const contactsState = useJson(contactsKey, async () => {
    const query = contactStatusFilter ? `?status=${contactStatusFilter}` : '';
    return apiFetch<{ contacts: ContactView[] }>(`/api/admin/contacts${query}`);
  });
  const contactDetailState = useJson(
    `contact:${selectedContactId}`,
    async () =>
      selectedContactId
        ? apiFetch<{ contact: ContactDetailView }>(
            `/api/admin/contacts/${encodeURIComponent(selectedContactId)}`,
          )
        : ({ contact: null } as unknown as { contact: ContactDetailView }),
  );
  const personalityState = useJson(`personality:${scope}`, () =>
    apiFetch<{ profile: PersonalityProfile }>(
      `/api/admin/personality?scope=${encodeURIComponent(scope)}`,
    ),
  );
  const previewState = useJson(`preview:${scope}:${JSON.stringify(personalityForm)}`, () =>
    apiFetch<{ preview: string }>(
      `/api/admin/personality/preview?scope=${encodeURIComponent(scope)}`,
    ),
  );
  const policyState = useJson('policy', () =>
    apiFetch<{ policy: ControlPolicy }>('/api/admin/policy'),
  );
  const verifiedState = useJson('verified', () =>
    apiFetch<{ verifiedIdentities: VerifiedIdentity[] }>(
      '/api/admin/verified-identities',
    ),
  );
  const settingsState = useJson('settings', () =>
    apiFetch<{ settings: ControlSettings }>('/api/admin/settings'),
  );
  const auditState = useJson('audit', () =>
    apiFetch<{ audit: AuditRecord[] }>('/api/admin/audit?limit=50'),
  );

  useEffect(() => {
    if (contactsState.data?.contacts.length && !selectedContactId) {
      setSelectedContactId(contactsState.data.contacts[0].identity);
    }
  }, [contactsState.data?.contacts, selectedContactId]);

  useEffect(() => {
    if (personalityState.data?.profile) {
      setPersonalityForm(personalityState.data.profile);
    }
  }, [personalityState.data?.profile]);

  useEffect(() => {
    if (settingsState.data?.settings) {
      setSettingsDraft(settingsState.data.settings);
    }
  }, [settingsState.data?.settings]);

  const contacts = contactsState.data?.contacts || [];
  const selectedContact = contactDetailState.data?.contact || null;
  const preview = previewState.data?.preview || '';
  const policy = policyState.data?.policy || { pausedProviders: [] };
  const verifiedIdentities = verifiedState.data?.verifiedIdentities || [];
  const auditRecords = auditState.data?.audit || [];

  const errorBanner = [
    contactsState.error,
    contactDetailState.error,
    personalityState.error,
    previewState.error,
    policyState.error,
    verifiedState.error,
    settingsState.error,
    auditState.error,
  ]
    .filter(Boolean)
    .join(' | ');

  const mutate = async (action: string, input: unknown) => {
    await apiFetch('/api/admin/actions', {
      method: 'POST',
      body: JSON.stringify({ action, input }),
    });
    await Promise.all([
      contactsState.refresh(),
      contactDetailState.refresh(),
      personalityState.refresh(),
      previewState.refresh(),
      policyState.refresh(),
      verifiedState.refresh(),
      settingsState.refresh(),
      auditState.refresh(),
    ]);
  };

  const tabs = useMemo(
    () => [
      ['contacts', 'Contacts'],
      ['personality', 'Personality'],
      ['policy', 'Policy'],
      ['audit', 'Audit'],
    ] as const,
    [],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Self-Hosted Claw Control Plane</h1>
          <p>UI and Signal control chat share the same host-side actions.</p>
        </div>
        <label className="tokenBox">
          Admin token
          <input
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            onBlur={() =>
              window.localStorage.setItem('admin-ui-token', tokenDraft)
            }
            placeholder="Optional X-Admin-Token"
          />
        </label>
      </header>

      <nav className="tabs">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {errorBanner ? <div className="banner error">{errorBanner}</div> : null}

      {tab === 'contacts' ? (
        <section className="panelGrid">
          <div className="panel">
            <div className="panelHeader">
              <h2>Contacts</h2>
              <select
                value={contactStatusFilter}
                onChange={(event) => setContactStatusFilter(event.target.value)}
              >
                <option value="">All</option>
                <option value="trusted">Trusted</option>
                <option value="unknown">Unknown</option>
                <option value="abuse">Abuse</option>
              </select>
            </div>
            <div className="contactList">
              {contacts.map((contact) => (
                <button
                  key={contact.identity}
                  className={
                    selectedContactId === contact.identity
                      ? 'contactRow selected'
                      : 'contactRow'
                  }
                  onClick={() => setSelectedContactId(contact.identity)}
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
              {selectedContact ? (
                <div className="buttonRow">
                  <button
                    onClick={() =>
                      void mutate('contact.trust', {
                        identity: selectedContact.identity,
                      })
                    }
                  >
                    Trust
                  </button>
                  <button
                    onClick={() =>
                      void mutate('contact.abuse', {
                        identity: selectedContact.identity,
                      })
                    }
                  >
                    Abuse
                  </button>
                  <button
                    onClick={() =>
                      void mutate('contact.reset', {
                        identity: selectedContact.identity,
                      })
                    }
                  >
                    Reset
                  </button>
                  <button
                    onClick={() =>
                      void mutate('contact.reclassify', {
                        identity: selectedContact.identity,
                      })
                    }
                  >
                    Re-classify
                  </button>
                </div>
              ) : null}
            </div>
            {selectedContact ? (
              <>
                <p>
                  <strong>{selectedContact.displayName}</strong> ({selectedContact.identity})
                </p>
                <p>Status: <span className={`status ${selectedContact.status}`}>{selectedContact.status}</span></p>
                <p>{selectedContact.classificationSummary || 'No classification summary yet.'}</p>
                <h3>History</h3>
                <div className="historyList">
                  {selectedContact.history.map((entry) => (
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
      ) : null}

      {tab === 'personality' ? (
        <section className="panelGrid">
          <div className="panel">
            <div className="panelHeader">
              <h2>Personality</h2>
              <input
                value={scope}
                onChange={(event) => setScope(event.target.value as PersonalityScope)}
                placeholder="global, main, or group:folder"
              />
            </div>
            <label>
              Display name
              <input
                value={personalityForm.displayName}
                onChange={(event) =>
                  setPersonalityForm({ ...personalityForm, displayName: event.target.value, scope })
                }
              />
            </label>
            <label>
              Role
              <input
                value={personalityForm.role}
                onChange={(event) =>
                  setPersonalityForm({ ...personalityForm, role: event.target.value, scope })
                }
              />
            </label>
            <label>
              Tone
              <input
                value={personalityForm.tone}
                onChange={(event) =>
                  setPersonalityForm({ ...personalityForm, tone: event.target.value, scope })
                }
              />
            </label>
            <label>
              Communication style
              <input
                value={personalityForm.communicationStyle}
                onChange={(event) =>
                  setPersonalityForm({
                    ...personalityForm,
                    communicationStyle: event.target.value,
                    scope,
                  })
                }
              />
            </label>
            <label>
              Initiative
              <input
                value={personalityForm.initiative}
                onChange={(event) =>
                  setPersonalityForm({ ...personalityForm, initiative: event.target.value, scope })
                }
              />
            </label>
            <label>
              Custom instructions
              <textarea
                rows={10}
                value={personalityForm.customInstructions}
                onChange={(event) =>
                  setPersonalityForm({
                    ...personalityForm,
                    customInstructions: event.target.value,
                    scope,
                  })
                }
              />
            </label>
            <div className="buttonRow">
              <button
                onClick={() =>
                  void mutate('personality.upsert', {
                    ...personalityForm,
                    scope,
                  })
                }
              >
                Save
              </button>
              <button
                onClick={() =>
                  void mutate('personality.reset', {
                    scope,
                  })
                }
              >
                Reset scope
              </button>
            </div>
          </div>
          <div className="panel">
            <h2>Rendered Preview</h2>
            <pre>{preview}</pre>
          </div>
        </section>
      ) : null}

      {tab === 'policy' ? (
        <section className="panelGrid">
          <div className="panel">
            <h2>Provider Controls</h2>
            <p>
              Paused providers:{' '}
              {policy.pausedProviders.length
                ? policy.pausedProviders.join(', ')
                : 'none'}
            </p>
            <div className="buttonRow">
              <input
                value={providerInput}
                onChange={(event) => setProviderInput(event.target.value)}
                placeholder="signal, sms, email"
              />
              <button
                onClick={() =>
                  void mutate('policy.pauseProvider', { provider: providerInput })
                }
              >
                Pause
              </button>
              <button
                onClick={() =>
                  void mutate('policy.resumeProvider', { provider: providerInput })
                }
              >
                Resume
              </button>
            </div>

            <h3>Verified identities</h3>
            <div className="buttonRow">
              <input
                value={verifiedIdentityInput}
                onChange={(event) => setVerifiedIdentityInput(event.target.value)}
                placeholder="phone:+15555550123"
              />
              <input
                value={verifiedLabelInput}
                onChange={(event) => setVerifiedLabelInput(event.target.value)}
                placeholder="Label"
              />
              <button
                onClick={() =>
                  void mutate('verified.add', {
                    identity: verifiedIdentityInput,
                    label: verifiedLabelInput,
                  })
                }
              >
                Add
              </button>
            </div>
            <ul className="plainList">
              {verifiedIdentities.map((item) => (
                <li key={item.identity}>
                  <span>{item.label}: {item.identity}</span>
                  <button
                    onClick={() =>
                      void mutate('verified.remove', { identity: item.identity })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <h2>Control Settings</h2>
            <label>
              Control Signal chat JID
              <input
                value={settingsDraft.controlSignalJid}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    controlSignalJid: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Assistant Signal identity
              <input
                value={settingsDraft.assistantSignalIdentity}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    assistantSignalIdentity: event.target.value,
                  })
                }
              />
            </label>
            <button onClick={() => void mutate('settings.update', settingsDraft)}>
              Save settings
            </button>
          </div>
        </section>
      ) : null}

      {tab === 'audit' ? (
        <section className="panel">
          <div className="panelHeader">
            <h2>Audit Log</h2>
            <button onClick={() => void auditState.refresh()}>Refresh</button>
          </div>
          <div className="historyList">
            {auditRecords.map((record) => (
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
      ) : null}
    </div>
  );
}
