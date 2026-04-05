import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Wizard, useWizard } from 'react-use-wizard';

type ContactStatus = 'trusted' | 'unknown' | 'abuse';
type PersonalityScope = 'global' | 'main' | `group:${string}`;
type Tab = 'setup' | 'contacts' | 'personality' | 'policy' | 'audit';

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

interface SetupStatusResponse {
  env: {
    ASSISTANT_NAME: string;
    OPENAI_BASE_URL: string;
    OPENAI_MODEL: string;
    OPENAI_MAX_TOKENS: string;
    OPENAI_TEMPERATURE: string;
    SIGNAL_ACCOUNT: string;
    SIGNAL_RPC_URL: string;
    SIGNAL_RECEIVE_TIMEOUT_SEC: string;
    CONTROL_SIGNAL_JID: string;
    ONECLI_URL: string;
    ADMIN_BIND_HOST: string;
    ADMIN_PORT: string;
    INBOUND_GUARD_SCRIPT: string;
    OPENAI_API_KEY_SET: boolean;
    ADMIN_UI_TOKEN_SET: boolean;
  };
  checks: {
    openAIConfigured: boolean;
    signalConfigured: boolean;
    signalReachable: boolean;
    controlChatConfigured: boolean;
    verifiedIdentityCount: number;
    assistantSignalConfigured: boolean;
    wizardComplete: boolean;
  };
}

interface SetupDraft {
  ASSISTANT_NAME: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  OPENAI_API_KEY: string;
  OPENAI_MAX_TOKENS: string;
  OPENAI_TEMPERATURE: string;
  SIGNAL_ACCOUNT: string;
  SIGNAL_RPC_URL: string;
  SIGNAL_RECEIVE_TIMEOUT_SEC: string;
  CONTROL_SIGNAL_JID: string;
  ONECLI_URL: string;
  ADMIN_BIND_HOST: string;
  ADMIN_PORT: string;
  ADMIN_UI_TOKEN: string;
  INBOUND_GUARD_SCRIPT: string;
  assistantSignalIdentity: string;
}

interface WizardSharedProps {
  setupDraft: SetupDraft;
  setSetupDraft: Dispatch<SetStateAction<SetupDraft>>;
  verifiedIdentityInput: string;
  setVerifiedIdentityInput: Dispatch<SetStateAction<string>>;
  verifiedLabelInput: string;
  setVerifiedLabelInput: Dispatch<SetStateAction<string>>;
  verifiedIdentities: VerifiedIdentity[];
  checks: SetupStatusResponse['checks'];
  setupStatus: SetupStatusResponse | null;
  saveEnvironment: (values: Record<string, string>) => Promise<void>;
  saveSettings: (values: Partial<ControlSettings>) => Promise<void>;
  addVerifiedIdentity: () => Promise<void>;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
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
    const error = await response
      .json()
      .catch(() => ({ error: response.statusText }));
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

function WizardFrame(props: {
  title: string;
  lead: string;
  children: ReactNode;
  primaryLabel?: string;
  onPrimary?: () => void | Promise<void>;
  secondaryLabel?: string;
  onSecondary?: () => void;
  tertiary?: React.ReactNode;
}) {
  const { nextStep, previousStep, activeStep, stepCount, isLastStep } =
    useWizard();

  const handlePrimary = async () => {
    if (props.onPrimary) await props.onPrimary();
    if (!isLastStep) nextStep();
  };

  return (
    <div className="wizardCard">
      <div className="wizardProgress">
        Step {activeStep + 1} of {stepCount}
      </div>
      <h2>{props.title}</h2>
      <p className="wizardLead">{props.lead}</p>
      <div className="wizardBody">{props.children}</div>
      <div className="wizardActions">
        {activeStep > 0 ? (
          <button type="button" onClick={props.onSecondary || previousStep}>
            {props.secondaryLabel || 'Back'}
          </button>
        ) : (
          <span />
        )}
        <div className="buttonRow">
          {props.tertiary}
          <button type="button" onClick={() => void handlePrimary()}>
            {props.primaryLabel || (isLastStep ? 'Finish' : 'Save and continue')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecurityStep(props: WizardSharedProps) {
  const save = async () => {
    const envUpdate: Record<string, string> = {
      ADMIN_BIND_HOST: props.setupDraft.ADMIN_BIND_HOST,
      ADMIN_PORT: props.setupDraft.ADMIN_PORT,
      INBOUND_GUARD_SCRIPT: props.setupDraft.INBOUND_GUARD_SCRIPT,
    };
    if (props.setupDraft.ADMIN_UI_TOKEN.trim()) {
      window.localStorage.setItem('admin-ui-token', props.setupDraft.ADMIN_UI_TOKEN);
      envUpdate.ADMIN_UI_TOKEN = props.setupDraft.ADMIN_UI_TOKEN.trim();
    }
    await props.saveEnvironment(envUpdate);
  };

  return (
    <WizardFrame
      title="Secure local admin access"
      lead="The admin UI should stay on localhost and use an admin token if you want browser-level protection on top of local-only binding."
      onPrimary={save}
      tertiary={
        <button
          type="button"
          onClick={() => {
            props.setSetupDraft((current) => ({
              ...current,
              ADMIN_BIND_HOST: '127.0.0.1',
              ADMIN_PORT: '3030',
            }));
          }}
        >
          Use safe defaults
        </button>
      }
    >
      <label>
        Admin bind host
        <input
          value={props.setupDraft.ADMIN_BIND_HOST}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              ADMIN_BIND_HOST: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Admin port
        <input
          value={props.setupDraft.ADMIN_PORT}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              ADMIN_PORT: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Admin UI token
        <input
          type="password"
          value={props.setupDraft.ADMIN_UI_TOKEN}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              ADMIN_UI_TOKEN: event.target.value,
            }))
          }
          placeholder={
            props.setupStatus?.env.ADMIN_UI_TOKEN_SET
              ? 'Already set; enter a new token to rotate it'
              : 'Optional but recommended'
          }
        />
      </label>
      <label>
        Inbound guard script
        <input
          value={props.setupDraft.INBOUND_GUARD_SCRIPT}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              INBOUND_GUARD_SCRIPT: event.target.value,
            }))
          }
        />
      </label>
      <div className="hintBox">
        <strong>Security notes</strong>
        <p>
          Secrets are written locally on the host and are not returned by the API
          afterward. Keep the admin server on `127.0.0.1` unless you are putting it
          behind your own secure access layer.
        </p>
      </div>
    </WizardFrame>
  );
}

function ModelStep(props: WizardSharedProps) {
  return (
    <WizardFrame
      title="Model backend"
      lead="Point Self-Hosted Claw at an OpenAI-compatible backend. For local models this is typically vLLM or another chat-completions-compatible endpoint."
      onPrimary={() =>
        props.saveEnvironment({
          ASSISTANT_NAME: props.setupDraft.ASSISTANT_NAME,
          OPENAI_BASE_URL: props.setupDraft.OPENAI_BASE_URL,
          OPENAI_MODEL: props.setupDraft.OPENAI_MODEL,
          OPENAI_MAX_TOKENS: props.setupDraft.OPENAI_MAX_TOKENS,
          OPENAI_TEMPERATURE: props.setupDraft.OPENAI_TEMPERATURE,
          ONECLI_URL: props.setupDraft.ONECLI_URL,
          ...(props.setupDraft.OPENAI_API_KEY.trim()
            ? { OPENAI_API_KEY: props.setupDraft.OPENAI_API_KEY.trim() }
            : {}),
        })
      }
    >
      <label>
        Assistant name
        <input
          value={props.setupDraft.ASSISTANT_NAME}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              ASSISTANT_NAME: event.target.value,
            }))
          }
        />
      </label>
      <label>
        OpenAI-compatible base URL
        <input
          value={props.setupDraft.OPENAI_BASE_URL}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              OPENAI_BASE_URL: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Model name
        <input
          value={props.setupDraft.OPENAI_MODEL}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              OPENAI_MODEL: event.target.value,
            }))
          }
        />
      </label>
      <label>
        API key
        <input
          type="password"
          value={props.setupDraft.OPENAI_API_KEY}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              OPENAI_API_KEY: event.target.value,
            }))
          }
          placeholder={
            props.setupStatus?.env.OPENAI_API_KEY_SET
              ? 'Already set; enter a new key to rotate it'
              : 'Optional for local unauthenticated backends'
          }
        />
      </label>
      <div className="wizardGrid">
        <label>
          Max tokens
          <input
            value={props.setupDraft.OPENAI_MAX_TOKENS}
            onChange={(event) =>
              props.setSetupDraft((current) => ({
                ...current,
                OPENAI_MAX_TOKENS: event.target.value,
              }))
            }
          />
        </label>
        <label>
          Temperature
          <input
            value={props.setupDraft.OPENAI_TEMPERATURE}
            onChange={(event) =>
              props.setSetupDraft((current) => ({
                ...current,
                OPENAI_TEMPERATURE: event.target.value,
              }))
            }
          />
        </label>
      </div>
      <label>
        OneCLI URL
        <input
          value={props.setupDraft.ONECLI_URL}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              ONECLI_URL: event.target.value,
            }))
          }
        />
      </label>
      <div className="hintBox">
        <strong>Status</strong>
        <p>
          OpenAI backend configured:{' '}
          {props.checks.openAIConfigured ? 'yes' : 'not yet'}
        </p>
      </div>
    </WizardFrame>
  );
}

function SignalStep(props: WizardSharedProps) {
  return (
    <WizardFrame
      title="Signal bridge and control chat"
      lead="Connect the assistant’s own Signal account through `signal-cli`, then tell Self-Hosted Claw which Signal conversation is your verified control surface."
      onPrimary={async () => {
        await props.saveEnvironment({
          SIGNAL_ACCOUNT: props.setupDraft.SIGNAL_ACCOUNT,
          SIGNAL_RPC_URL: props.setupDraft.SIGNAL_RPC_URL,
          SIGNAL_RECEIVE_TIMEOUT_SEC: props.setupDraft.SIGNAL_RECEIVE_TIMEOUT_SEC,
          CONTROL_SIGNAL_JID: props.setupDraft.CONTROL_SIGNAL_JID,
        });
        await props.saveSettings({
          controlSignalJid: props.setupDraft.CONTROL_SIGNAL_JID,
          assistantSignalIdentity: props.setupDraft.assistantSignalIdentity,
        });
      }}
    >
      <label>
        Assistant Signal account
        <input
          value={props.setupDraft.SIGNAL_ACCOUNT}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              SIGNAL_ACCOUNT: event.target.value,
              assistantSignalIdentity:
                current.assistantSignalIdentity || event.target.value,
            }))
          }
          placeholder="+15555550123"
        />
      </label>
      <label>
        Signal RPC URL
        <input
          value={props.setupDraft.SIGNAL_RPC_URL}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              SIGNAL_RPC_URL: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Receive timeout (seconds)
        <input
          value={props.setupDraft.SIGNAL_RECEIVE_TIMEOUT_SEC}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              SIGNAL_RECEIVE_TIMEOUT_SEC: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Control Signal JID
        <input
          value={props.setupDraft.CONTROL_SIGNAL_JID}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              CONTROL_SIGNAL_JID: event.target.value,
            }))
          }
          placeholder="signal:user:+15555550123"
        />
      </label>
      <label>
        Assistant Signal identity override
        <input
          value={props.setupDraft.assistantSignalIdentity}
          onChange={(event) =>
            props.setSetupDraft((current) => ({
              ...current,
              assistantSignalIdentity: event.target.value,
            }))
          }
        />
      </label>
      <div className="hintBox">
        <strong>Status</strong>
        <p>
          Signal configured: {props.checks.signalConfigured ? 'yes' : 'not yet'}
          <br />
          Signal reachable: {props.checks.signalReachable ? 'yes' : 'not yet'}
          <br />
          Control chat configured:{' '}
          {props.checks.controlChatConfigured ? 'yes' : 'not yet'}
        </p>
      </div>
    </WizardFrame>
  );
}

function OwnershipStep(props: WizardSharedProps) {
  return (
    <WizardFrame
      title="Verified owner identities"
      lead="Only owner-verified identities can use the full Signal control plane. Add at least your primary Signal identity before completing setup."
      primaryLabel="Save and continue"
      onPrimary={props.addVerifiedIdentity}
      tertiary={
        <button type="button" onClick={() => void props.addVerifiedIdentity()}>
          Add identity
        </button>
      }
    >
      <label>
        Verified identity
        <input
          value={props.verifiedIdentityInput}
          onChange={(event) => props.setVerifiedIdentityInput(event.target.value)}
          placeholder="signal:user:+15555550123 or +15555550123"
        />
      </label>
      <label>
        Label
        <input
          value={props.verifiedLabelInput}
          onChange={(event) => props.setVerifiedLabelInput(event.target.value)}
          placeholder="Justin"
        />
      </label>
      <ul className="plainList">
        {props.verifiedIdentities.map((item) => (
          <li key={item.identity}>
            <span>
              {item.label}: {item.identity}
            </span>
          </li>
        ))}
      </ul>
      <div className="hintBox">
        <strong>Status</strong>
        <p>
          Verified identities configured: {props.checks.verifiedIdentityCount}
        </p>
      </div>
    </WizardFrame>
  );
}

function ReviewStep(props: WizardSharedProps) {
  const checks = props.checks;
  const setupCommands = `npm run setup -- --step environment
npm run setup -- --step signal
npm run setup -- --step service
npm run setup -- --step verify`;

  return (
    <WizardFrame
      title="Review and finish"
      lead="The wizard writes local host configuration safely, but the service still needs to be restarted so the Node process picks up any new `.env` values."
      primaryLabel="Setup reviewed"
    >
      <div className="checklist">
        <div className={checks.openAIConfigured ? 'ok' : 'warn'}>
          OpenAI backend configured
        </div>
        <div className={checks.signalConfigured ? 'ok' : 'warn'}>
          Signal bridge configured
        </div>
        <div className={checks.signalReachable ? 'ok' : 'warn'}>
          Signal bridge reachable
        </div>
        <div className={checks.controlChatConfigured ? 'ok' : 'warn'}>
          Control Signal chat configured
        </div>
        <div className={checks.verifiedIdentityCount > 0 ? 'ok' : 'warn'}>
          Verified control identity added
        </div>
      </div>
      <div className="hintBox">
        <strong>Next steps</strong>
        <p>
          Restart the service after changing `.env`, then run the setup checks:
        </p>
        <pre className="smallPre">{setupCommands}</pre>
        <p>
          Once the service is back up, use the Signal control chat for commands
          like `/contacts list`, `/policy show`, `/settings show`, or `/audit recent`.
        </p>
      </div>
    </WizardFrame>
  );
}

function SetupWizard(props: WizardSharedProps) {
  return (
    <div className="panel">
      <div className="panelHeader">
        <h2>First-run setup wizard</h2>
        <span className="setupBadge">react-use-wizard</span>
      </div>
      <Wizard>
        <SecurityStep {...props} />
        <ModelStep {...props} />
        <SignalStep {...props} />
        <OwnershipStep {...props} />
        <ReviewStep {...props} />
      </Wizard>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>('contacts');
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
  const [setupDraft, setSetupDraft] = useState<SetupDraft>({
    ASSISTANT_NAME: 'Andy',
    OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1',
    OPENAI_MODEL: 'local-model',
    OPENAI_API_KEY: '',
    OPENAI_MAX_TOKENS: '4096',
    OPENAI_TEMPERATURE: '0.2',
    SIGNAL_ACCOUNT: '',
    SIGNAL_RPC_URL: 'http://127.0.0.1:8080',
    SIGNAL_RECEIVE_TIMEOUT_SEC: '5',
    CONTROL_SIGNAL_JID: '',
    ONECLI_URL: 'http://localhost:10254',
    ADMIN_BIND_HOST: '127.0.0.1',
    ADMIN_PORT: '3030',
    ADMIN_UI_TOKEN: '',
    INBOUND_GUARD_SCRIPT: 'scripts/inbound-message-guard.mjs',
    assistantSignalIdentity: '',
  });
  const contactsKey = `contacts:${contactStatusFilter}`;
  const contactsState = useJson(contactsKey, async () => {
    const query = contactStatusFilter ? `?status=${contactStatusFilter}` : '';
    return apiFetch<{ contacts: ContactView[] }>(`/api/admin/contacts${query}`);
  });
  const setupState = useJson('setup-status', () =>
    apiFetch<SetupStatusResponse>('/api/admin/setup-status'),
  );
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
  const previewState = useJson(
    `preview:${scope}:${JSON.stringify(personalityForm)}`,
    () =>
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
      setSetupDraft((current) => ({
        ...current,
        assistantSignalIdentity:
          settingsState.data?.settings.assistantSignalIdentity ||
          current.assistantSignalIdentity,
      }));
    }
  }, [settingsState.data?.settings]);

  useEffect(() => {
    if (setupState.data) {
      setSetupDraft((current) => ({
        ...current,
        ASSISTANT_NAME: setupState.data?.env.ASSISTANT_NAME || current.ASSISTANT_NAME,
        OPENAI_BASE_URL:
          setupState.data?.env.OPENAI_BASE_URL || current.OPENAI_BASE_URL,
        OPENAI_MODEL: setupState.data?.env.OPENAI_MODEL || current.OPENAI_MODEL,
        OPENAI_MAX_TOKENS:
          setupState.data?.env.OPENAI_MAX_TOKENS || current.OPENAI_MAX_TOKENS,
        OPENAI_TEMPERATURE:
          setupState.data?.env.OPENAI_TEMPERATURE ||
          current.OPENAI_TEMPERATURE,
        SIGNAL_ACCOUNT: setupState.data?.env.SIGNAL_ACCOUNT || current.SIGNAL_ACCOUNT,
        SIGNAL_RPC_URL:
          setupState.data?.env.SIGNAL_RPC_URL || current.SIGNAL_RPC_URL,
        SIGNAL_RECEIVE_TIMEOUT_SEC:
          setupState.data?.env.SIGNAL_RECEIVE_TIMEOUT_SEC ||
          current.SIGNAL_RECEIVE_TIMEOUT_SEC,
        CONTROL_SIGNAL_JID:
          setupState.data?.env.CONTROL_SIGNAL_JID || current.CONTROL_SIGNAL_JID,
        ONECLI_URL: setupState.data?.env.ONECLI_URL || current.ONECLI_URL,
        ADMIN_BIND_HOST:
          setupState.data?.env.ADMIN_BIND_HOST || current.ADMIN_BIND_HOST,
        ADMIN_PORT: setupState.data?.env.ADMIN_PORT || current.ADMIN_PORT,
        INBOUND_GUARD_SCRIPT:
          setupState.data?.env.INBOUND_GUARD_SCRIPT ||
          current.INBOUND_GUARD_SCRIPT,
      }));
      if (!setupState.data.checks.wizardComplete) {
        setTab('setup');
      }
    }
  }, [setupState.data]);

  const contacts = contactsState.data?.contacts || [];
  const selectedContact = contactDetailState.data?.contact || null;
  const preview = previewState.data?.preview || '';
  const policy = policyState.data?.policy || { pausedProviders: [] };
  const verifiedIdentities = verifiedState.data?.verifiedIdentities || [];
  const auditRecords = auditState.data?.audit || [];
  const setupChecks = setupState.data?.checks || {
    openAIConfigured: false,
    signalConfigured: false,
    signalReachable: false,
    controlChatConfigured: false,
    verifiedIdentityCount: 0,
    assistantSignalConfigured: false,
    wizardComplete: false,
  };

  const errorBanner = [
    setupState.error,
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

  const refreshAll = async () => {
    await Promise.all([
      setupState.refresh(),
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

  const mutate = async (action: string, input: unknown) => {
    await apiFetch('/api/admin/actions', {
      method: 'POST',
      body: JSON.stringify({ action, input }),
    });
    await refreshAll();
  };

  const saveEnvironment = async (values: Record<string, string>) => {
    const cleaned = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    );
    if (cleaned.ADMIN_UI_TOKEN) {
      window.localStorage.setItem('admin-ui-token', cleaned.ADMIN_UI_TOKEN);
      setTokenDraft(cleaned.ADMIN_UI_TOKEN);
      setSetupDraft((current) => ({ ...current, ADMIN_UI_TOKEN: '' }));
    }
    if (cleaned.OPENAI_API_KEY) {
      setSetupDraft((current) => ({ ...current, OPENAI_API_KEY: '' }));
    }
    await mutate('settings.updateEnv', { values: cleaned });
  };

  const saveSettings = async (values: Partial<ControlSettings>) => {
    await mutate('settings.update', values);
  };

  const addVerifiedIdentity = async () => {
    if (!verifiedIdentityInput.trim()) return;
    await mutate('verified.add', {
      identity: verifiedIdentityInput,
      label: verifiedLabelInput.trim(),
    });
    setVerifiedIdentityInput('');
    setVerifiedLabelInput('');
  };

  const tabs = useMemo(
    () =>
      [
        ['setup', 'Setup'],
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
          <p>
            The admin UI and Signal control chat use the same host-side actions.
            The first-run wizard keeps setup local and security-sensitive.
          </p>
        </div>
        <label className="tokenBox">
          Admin token
          <input
            type="password"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            onBlur={() =>
              window.localStorage.setItem('admin-ui-token', tokenDraft)
            }
            placeholder="Local X-Admin-Token"
          />
        </label>
      </header>

      {!setupChecks.wizardComplete ? (
        <div className="banner warn">
          First-run setup is not complete. The UI is staying on the Setup tab
          until the core checks are configured.
        </div>
      ) : null}

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

      {tab === 'setup' ? (
        <SetupWizard
          setupDraft={setupDraft}
          setSetupDraft={setSetupDraft}
          verifiedIdentityInput={verifiedIdentityInput}
          setVerifiedIdentityInput={setVerifiedIdentityInput}
          verifiedLabelInput={verifiedLabelInput}
          setVerifiedLabelInput={setVerifiedLabelInput}
          verifiedIdentities={verifiedIdentities}
          checks={setupChecks}
          setupStatus={setupState.data}
          saveEnvironment={saveEnvironment}
          saveSettings={saveSettings}
          addVerifiedIdentity={addVerifiedIdentity}
        />
      ) : null}

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
                <p>
                  Status:{' '}
                  <span className={`status ${selectedContact.status}`}>
                    {selectedContact.status}
                  </span>
                </p>
                <p>
                  {selectedContact.classificationSummary ||
                    'No classification summary yet.'}
                </p>
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
                  setPersonalityForm({
                    ...personalityForm,
                    displayName: event.target.value,
                    scope,
                  })
                }
              />
            </label>
            <label>
              Role
              <input
                value={personalityForm.role}
                onChange={(event) =>
                  setPersonalityForm({
                    ...personalityForm,
                    role: event.target.value,
                    scope,
                  })
                }
              />
            </label>
            <label>
              Tone
              <input
                value={personalityForm.tone}
                onChange={(event) =>
                  setPersonalityForm({
                    ...personalityForm,
                    tone: event.target.value,
                    scope,
                  })
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
                  setPersonalityForm({
                    ...personalityForm,
                    initiative: event.target.value,
                    scope,
                  })
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
              <button onClick={() => void addVerifiedIdentity()}>Add</button>
            </div>
            <ul className="plainList">
              {verifiedIdentities.map((item) => (
                <li key={item.identity}>
                  <span>
                    {item.label}: {item.identity}
                  </span>
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
            <button onClick={() => void saveSettings(settingsDraft)}>
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
