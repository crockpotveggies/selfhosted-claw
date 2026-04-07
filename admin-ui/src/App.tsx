import type {
  ChangeEvent,
  CSSProperties,
  Dispatch,
  ReactNode,
  SetStateAction,
} from 'react';
import { useEffect, useState } from 'react';
import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCloseButton,
  CCol,
  CContainer,
  CFormInput,
  CFormSelect,
  CHeader,
  CHeaderBrand,
  CHeaderNav,
  CHeaderToggler,
  CModal,
  CModalBody,
  CNavItem,
  CNavLink,
  CRow,
  CSidebar,
  CSidebarBrand,
  CSidebarFooter,
  CSidebarHeader,
  CSidebarNav,
  CSidebarToggler,
  CTooltip,
  CWidgetStatsE,
  useColorModes,
} from '@coreui/react';
import CIcon from '@coreui/icons-react';
import {
  cilBell,
  cilCheckCircle,
  cilContact,
  cilDescription,
  cilList,
  cilMenu,
  cilMoon,
  cilNotes,
  cilPeople,
  cilSettings,
  cilShieldAlt,
  cilSpeech,
  cilUser,
} from '@coreui/icons';
import {
  Calendar3,
  ChatDotsFill,
  GearFill,
  Google,
  PeopleFill,
  PersonBadgeFill,
  Robot,
  SendFill,
  ShieldLockFill,
} from 'react-bootstrap-icons';
import { Wizard, useWizard } from 'react-use-wizard';

type ContactStatus = 'trusted' | 'unknown' | 'abuse';
type PersonalityScope = 'global' | 'main' | `group:${string}`;
type Tab =
  | 'contacts'
  | 'personality'
  | 'policy'
  | 'tools'
  | 'approvals'
  | 'audit';
type SignalProvisionMode = 'link' | 'register';

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

interface SignalProfileSettings {
  account: string;
  name: string;
  about: string;
  avatarDataUrl: string;
}

interface ToastMessage {
  kind: 'success' | 'error';
  text: string;
}

interface AuditRecord {
  id: string;
  actorIdentity: string;
  actionName: string;
  status: string;
  createdAt: string;
  payloadSummary: string;
}

interface ToolRegistryItem {
  name: string;
  commandableAction: boolean;
  interactiveView?: boolean;
  previewable?: boolean;
  toolType?: string;
  iconKey?: string;
}

interface ToolVisual {
  label: string;
  accent: string;
  accentSoft: string;
  icon: ReactNode;
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
    GOOGLE_CLIENT_ID: string;
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
    signalComposeConfigured: boolean;
    signalComposeRunning: boolean;
    onecliConfigured: boolean;
    onecliReachable: boolean;
    googleContactsAvailable: boolean;
    googleContactsSource: 'env' | 'onecli' | 'oauth' | 'none';
    controlChatConfigured: boolean;
    verifiedIdentityCount: number;
    assistantSignalConfigured: boolean;
    wizardComplete: boolean;
  };
  signalCompose: {
    account: string;
    localRpcUrl: string;
    composeFile: string;
    envFile: string;
    dataDir: string;
    configured: boolean;
    running: boolean;
    lastError: string;
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
  startSignalCompose: () => Promise<void>;
  refreshSetupStatus: () => Promise<void>;
  requestSignalLinkQr: (deviceName: string) => Promise<string>;
  startSignalRegistration: (useVoice: boolean, captchaToken?: string) => Promise<string>;
  verifySignalRegistration: (code: string) => Promise<string>;
  signalCaptchaRequired: boolean;
  signalCaptchaToken: string;
  setSignalCaptchaToken: Dispatch<SetStateAction<string>>;
  signalExistingAccounts: string[];
  fetchSignalExistingAccounts: (rpcUrl?: string) => Promise<void>;
  signalProvisionMode: SignalProvisionMode;
  setSignalProvisionMode: Dispatch<SetStateAction<SignalProvisionMode>>;
  signalDeviceName: string;
  setSignalDeviceName: Dispatch<SetStateAction<string>>;
  signalQrDataUrl: string;
  setSignalQrDataUrl: Dispatch<SetStateAction<string>>;
  signalProvisionMessage: string;
  setSignalProvisionMessage: Dispatch<SetStateAction<string>>;
  signalVerificationCode: string;
  setSignalVerificationCode: Dispatch<SetStateAction<string>>;
  signalUseVoice: boolean;
  setSignalUseVoice: Dispatch<SetStateAction<boolean>>;
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

function formatRegistryName(name: string): string {
  return name
    .split(/[._-]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function getToolTypeKey(tool: ToolRegistryItem): string {
  return (tool.toolType || 'unknown').toLowerCase();
}

function getToolVisual(tool: ToolRegistryItem): ToolVisual {
  const iconKey = (tool.iconKey || tool.toolType || 'unknown').toLowerCase();

  switch (iconKey) {
    case 'google_calendar':
    case 'calendar':
      return {
        label: 'Google Calendar',
        accent: '#f6c343',
        accentSoft: 'rgba(246, 195, 67, 0.16)',
        icon: <Calendar3 size={18} />,
      };
    case 'google_contacts':
    case 'google':
      return {
        label: 'Google Contacts',
        accent: '#4f9cff',
        accentSoft: 'rgba(79, 156, 255, 0.16)',
        icon: <Google size={18} />,
      };
    case 'signal':
      return {
        label: 'Signal',
        accent: '#5c7cfa',
        accentSoft: 'rgba(92, 124, 250, 0.16)',
        icon: <ChatDotsFill size={18} />,
      };
    case 'contacts':
    case 'people':
      return {
        label: 'Contacts',
        accent: '#2fb75d',
        accentSoft: 'rgba(47, 183, 93, 0.16)',
        icon: <PeopleFill size={18} />,
      };
    case 'personality':
      return {
        label: 'Personality',
        accent: '#8b5cf6',
        accentSoft: 'rgba(139, 92, 246, 0.16)',
        icon: <PersonBadgeFill size={18} />,
      };
    case 'policy':
      return {
        label: 'Policy',
        accent: '#f87171',
        accentSoft: 'rgba(248, 113, 113, 0.16)',
        icon: <ShieldLockFill size={18} />,
      };
    case 'settings':
      return {
        label: 'Settings',
        accent: '#94a3b8',
        accentSoft: 'rgba(148, 163, 184, 0.16)',
        icon: <GearFill size={18} />,
      };
    case 'outbound':
    case 'send':
      return {
        label: 'Outbound',
        accent: '#fb7185',
        accentSoft: 'rgba(251, 113, 133, 0.16)',
        icon: <SendFill size={18} />,
      };
    default:
      return {
        label: formatRegistryName(getToolTypeKey(tool)),
        accent: '#8892a6',
        accentSoft: 'rgba(136, 146, 166, 0.18)',
        icon: <Robot size={18} />,
      };
  }
}

function getToolCapabilities(tool: ToolRegistryItem): string[] {
  return [
    tool.commandableAction ? 'Commandable' : 'UI only',
    tool.previewable ? 'Preview' : 'Direct',
    tool.interactiveView ? 'Interactive' : 'Action',
  ];
}

interface PendingControlAction {
  id: string;
  actionName: string;
  summary: string;
  actorIdentity: string;
  source: 'ui' | 'signal_control' | 'agent';
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

interface ProviderAvailability {
  onecliConfigured: boolean;
  onecliReachable: boolean;
  googleContactsAvailable: boolean;
  googleContactsSource: 'env' | 'onecli' | 'oauth' | 'none';
  signalOutboundAvailable: boolean;
  smsOutboundAvailable: boolean;
  emailOutboundAvailable: boolean;
  contactResolutionAvailable: boolean;
}

interface ResolvedContactTarget {
  channel: 'signal' | 'sms' | 'email';
  query: string;
  resolvedTarget: string;
  displayName: string;
  source: 'literal' | 'signal_history' | 'google_contacts';
  existingConversation: boolean;
}

interface GoogleContactsSetup {
  origin: string;
  callbackUri: string;
  scopes: string[];
  configured: {
    clientId: boolean;
    clientSecret: boolean;
    accessToken: boolean;
  };
}

interface GoogleOAuthStartResponse {
  url: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Image file could not be decoded'));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load selected image'));
    image.src = src;
  });
}

async function cropAndResizeAvatar(file: File, size: number = 512): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file for the avatar');
  }

  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const cropSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = Math.floor((image.naturalWidth - cropSize) / 2);
  const sy = Math.floor((image.naturalHeight - cropSize) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Browser could not prepare the avatar image');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    sx,
    sy,
    cropSize,
    cropSize,
    0,
    0,
    size,
    size,
  );

  return canvas.toDataURL('image/png');
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
    <CCard className="wizardCard border-0">
      <CBadge className="wizardProgress">
        Step {activeStep + 1} of {stepCount}
      </CBadge>
      <h2>{props.title}</h2>
      <p className="wizardLead">{props.lead}</p>
      <div className="wizardBody">{props.children}</div>
      <div className="wizardActions">
        {activeStep > 0 ? (
          <CButton
            type="button"
            color="secondary"
            variant="ghost"
            onClick={props.onSecondary || previousStep}
          >
            {props.secondaryLabel || 'Back'}
          </CButton>
        ) : (
          <span />
        )}
        <div className="buttonRow noMargin">
          {props.tertiary}
          <CButton type="button" color="primary" onClick={() => void handlePrimary()}>
            {props.primaryLabel || (isLastStep ? 'Finish' : 'Save and continue')}
          </CButton>
        </div>
      </div>
    </CCard>
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
        <CButton
          type="button"
          color="secondary"
          variant="ghost"
          onClick={() => {
            props.setSetupDraft((current) => ({
              ...current,
              ADMIN_BIND_HOST: '127.0.0.1',
              ADMIN_PORT: '3030',
            }));
          }}
        >
          Use safe defaults
        </CButton>
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
          <br />
          OneCLI configured: {props.checks.onecliConfigured ? 'yes' : 'not yet'}
          <br />
          OneCLI reachable: {props.checks.onecliReachable ? 'yes' : 'not yet'}
          <br />
          Google Contacts available: {props.checks.googleContactsAvailable ? 'yes' : 'not yet'}
          {props.checks.googleContactsAvailable
            ? ` (${props.checks.googleContactsSource})`
            : ''}
        </p>
      </div>
    </WizardFrame>
  );
}

function SignalStep(props: WizardSharedProps) {
  return (
    <WizardFrame
      title="Signal bridge and control chat"
      lead="Capture the assistant Signal identity, then let the wizard launch the managed localhost-only Signal bridge from `scripts/signal-cli/docker-compose.yml`."
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
        await props.startSignalCompose();
      }}
      primaryLabel="Save and start Signal bridge"
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
        <strong>Managed bridge status</strong>
        <p>
          Signal configured: {props.checks.signalConfigured ? 'yes' : 'not yet'}
          <br />
          Signal reachable: {props.checks.signalReachable ? 'yes' : 'not yet'}
          <br />
          Managed compose configured:{' '}
          {props.checks.signalComposeConfigured ? 'yes' : 'not yet'}
          <br />
          Managed compose running:{' '}
          {props.checks.signalComposeRunning ? 'yes' : 'not yet'}
          <br />
          Control chat configured:{' '}
          {props.checks.controlChatConfigured ? 'yes' : 'not yet'}
        </p>
        <p>
          Compose file: {props.setupStatus?.signalCompose.composeFile || 'n/a'}
          <br />
          Managed env: {props.setupStatus?.signalCompose.envFile || 'n/a'}
          <br />
          Managed data dir: {props.setupStatus?.signalCompose.dataDir || 'n/a'}
        </p>
        {props.setupStatus?.signalCompose.lastError ? (
          <p>Last docker compose error: {props.setupStatus.signalCompose.lastError}</p>
        ) : null}
      </div>
    </WizardFrame>
  );
}

function SignalProvisionStep(props: WizardSharedProps) {
  return (
    <WizardFrame
      title="Link or register the assistant account"
      lead="Use QR linking if this Signal account already exists on a phone. Use SMS or voice verification only if you are registering a brand-new Signal account for the assistant."
      onPrimary={props.refreshSetupStatus}
      primaryLabel="Refresh Signal status"
      tertiary={
        <div className="buttonRow noMargin">
          <button
            type="button"
            onClick={() =>
              void props.refreshSetupStatus().then(() => {
                props.setSignalProvisionMessage(
                  'Signal status refreshed. The readiness result is shown above.',
                );
              }).catch(() => undefined)
            }
          >
            Re-check readiness
          </button>
        </div>
      }
    >
      {props.signalExistingAccounts.length > 0 ? (
        <div className="hintBox">
          <strong>Existing Signal identity detected</strong>
          <p>
            signal-cli already has{' '}
            {props.signalExistingAccounts.join(', ')} registered. If this is
            the account you want to use, no provisioning step is needed — just
            click &ldquo;Refresh Signal status&rdquo; above to confirm
            readiness.
          </p>
        </div>
      ) : (
        <div className="buttonRow noMargin">
          <button
            type="button"
            onClick={() =>
              void props.fetchSignalExistingAccounts(
                props.setupDraft.SIGNAL_RPC_URL,
              )
            }
          >
            Check for existing Signal identity
          </button>
        </div>
      )}

      <div className="segmented">
        <button
          type="button"
          className={props.signalProvisionMode === 'link' ? 'active' : ''}
          onClick={() => props.setSignalProvisionMode('link')}
        >
          Link existing account
        </button>
        <button
          type="button"
          className={props.signalProvisionMode === 'register' ? 'active' : ''}
          onClick={() => props.setSignalProvisionMode('register')}
        >
          Register by code
        </button>
      </div>

      {props.signalProvisionMode === 'link' ? (
        <div className="provisionCard">
          <label>
            Linked device name
            <input
              value={props.signalDeviceName}
              onChange={(event) => props.setSignalDeviceName(event.target.value)}
              placeholder="Self-Hosted Claw"
            />
          </label>
          <div className="buttonRow noMargin">
            <button
              type="button"
              onClick={() =>
                void props
                  .requestSignalLinkQr(props.signalDeviceName)
                  .then((dataUrl) => {
                    props.setSignalQrDataUrl(dataUrl);
                    props.setSignalProvisionMessage(
                      'QR code generated. In Signal on your phone, open Settings > Linked Devices and scan it.',
                    );
                  })
                  .catch(() => undefined)
              }
            >
              Generate QR code
            </button>
          </div>
          {props.signalQrDataUrl ? (
            <div className="qrPanel">
              <img
                src={props.signalQrDataUrl}
                alt="Signal device link QR code"
                className="qrImage"
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="provisionCard">
          <label className="checkboxRow">
            <input
              type="checkbox"
              checked={props.signalUseVoice}
              onChange={(event) => props.setSignalUseVoice(event.target.checked)}
            />
            Use voice verification instead of SMS
          </label>
          <div className="buttonRow noMargin">
            <button
              type="button"
              onClick={() =>
                void props
                  .startSignalRegistration(
                    props.signalUseVoice,
                    props.signalCaptchaToken || undefined,
                  )
                  .then((message) => props.setSignalProvisionMessage(message))
                  .catch(() => undefined)
              }
            >
              Start registration
            </button>
          </div>
          <label>
            Captcha token{' '}
            <span style={{ fontWeight: 'normal', opacity: 0.7 }}>
              (optional — only needed if Signal asks for one)
            </span>
            <input
              value={props.signalCaptchaToken}
              onChange={(event) =>
                props.setSignalCaptchaToken(event.target.value)
              }
              placeholder="signalcaptcha://03AFY_..."
            />
          </label>
          {props.signalCaptchaToken ? (
            <div className="hintBox">
              <p>
                To get this token: open{' '}
                <a
                  href="https://signalcaptchas.org/registration/generate.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  signalcaptchas.org
                </a>{' '}
                in your browser, complete the captcha, then right-click the
                &ldquo;Open Signal&rdquo; button and copy the link. Paste the
                full <code>signalcaptcha://…</code> URL above, then click
                &ldquo;Start registration&rdquo;.
              </p>
            </div>
          ) : null}
          <label>
            Verification code
            <input
              value={props.signalVerificationCode}
              onChange={(event) =>
                props.setSignalVerificationCode(event.target.value)
              }
              placeholder="123-456"
            />
          </label>
          <div className="buttonRow noMargin">
            <button
              type="button"
              onClick={() =>
                void props
                  .verifySignalRegistration(props.signalVerificationCode)
                  .then((message) => props.setSignalProvisionMessage(message))
                  .catch(() => undefined)
              }
            >
              Verify code
            </button>
          </div>
        </div>
      )}

      <div className="hintBox">
        <strong>Status</strong>
        <p>
          Signal reachable: {props.checks.signalReachable ? 'yes' : 'not yet'}
        </p>
        {props.signalProvisionMessage ? (
          <p>{props.signalProvisionMessage}</p>
        ) : (
          <p>
            The wizard can orchestrate linking and registration, but Signal still
            requires you to scan the QR code or enter the verification code yourself.
          </p>
        )}
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
        <div className={checks.signalComposeRunning ? 'ok' : 'warn'}>
          Managed Signal compose running
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
          The wizard writes `.env`, starts the managed Signal bridge, and keeps
          Signal state in a host-only data folder. Restart the main service after
          changing `.env`, then run the setup checks:
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
        <SignalProvisionStep {...props} />
        <OwnershipStep {...props} />
        <ReviewStep {...props} />
      </Wizard>
    </div>
  );
}

export function App() {
  const { setColorMode } = useColorModes('selfhosted-claw-admin-theme');
  const [actionError, setActionError] = useState('');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarUnfoldable, setSidebarUnfoldable] = useState(false);
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
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [resolutionQuery, setResolutionQuery] = useState('');
  const [resolutionChannel, setResolutionChannel] = useState<'signal' | 'sms' | 'email'>(
    'signal',
  );
  const [resolutionPreview, setResolutionPreview] = useState<ResolvedContactTarget | null>(
    null,
  );
  const [settingsDraft, setSettingsDraft] = useState<ControlSettings>({
    controlSignalJid: '',
    assistantSignalIdentity: '',
  });
  const [signalProfileDraft, setSignalProfileDraft] =
    useState<SignalProfileSettings>({
      account: '',
      name: '',
      about: '',
      avatarDataUrl: '',
    });
  const [signalProvisionMode, setSignalProvisionMode] =
    useState<SignalProvisionMode>('link');
  const [signalDeviceName, setSignalDeviceName] = useState('Self-Hosted Claw');
  const [signalQrDataUrl, setSignalQrDataUrl] = useState('');
  const [signalProvisionMessage, setSignalProvisionMessage] = useState('');
  const [signalVerificationCode, setSignalVerificationCode] = useState('');
  const [signalUseVoice, setSignalUseVoice] = useState(false);
  const [signalCaptchaRequired, setSignalCaptchaRequired] = useState(false);
  const [signalCaptchaToken, setSignalCaptchaToken] = useState('');
  const [signalExistingAccounts, setSignalExistingAccounts] = useState<string[]>([]);
  // Calendar availability state
  interface AvailabilityWindow {
    days: number[];
    startTime: string;
    endTime: string;
  }
  const [calAvailTimezone, setCalAvailTimezone] = useState('America/New_York');
  const [calAvailWindows, setCalAvailWindows] = useState<AvailabilityWindow[]>([
    { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
  ]);
  const [calAvailNotes, setCalAvailNotes] = useState('');
  const [calAvailLoaded, setCalAvailLoaded] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
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
  const toolsState = useJson('tools', () =>
    apiFetch<{ tools: ToolRegistryItem[] }>('/api/admin/tools'),
  );
  const signalProfileState = useJson('signal-profile', () =>
    apiFetch<{ profile: SignalProfileSettings }>('/api/admin/signal/profile'),
  );
  const googleContactsSetupState = useJson('google-contacts-setup', () =>
    apiFetch<GoogleContactsSetup>('/api/admin/google-contacts/setup'),
  );
  const providerState = useJson('providers', () =>
    apiFetch<{ providers: ProviderAvailability }>('/api/admin/providers'),
  );
  const pendingState = useJson('pending', () =>
    apiFetch<{ pending: PendingControlAction[] }>('/api/admin/pending?limit=50'),
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
    setColorMode('dark');
  }, [setColorMode]);

  // Load calendar availability settings
  useEffect(() => {
    if (calAvailLoaded) return;
    apiFetch<{ calendarAvailability: { timezone: string; windows: AvailabilityWindow[]; notes: string } | null }>(
      '/api/admin/policy/calendar-availability',
    ).then((res) => {
      if (res.calendarAvailability) {
        setCalAvailTimezone(res.calendarAvailability.timezone);
        setCalAvailWindows(res.calendarAvailability.windows.length > 0 ? res.calendarAvailability.windows : [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }]);
        setCalAvailNotes(res.calendarAvailability.notes);
      }
      setCalAvailLoaded(true);
    }).catch(() => setCalAvailLoaded(true));
  }, [calAvailLoaded]);

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
    if (signalProfileState.data?.profile) {
      setSignalProfileDraft(signalProfileState.data.profile);
    }
  }, [signalProfileState.data?.profile]);

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
      setGoogleClientId(setupState.data.env.GOOGLE_CLIENT_ID || '');
    }
  }, [setupState.data]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const tabParam = url.searchParams.get('tab');
    const googleStatus = url.searchParams.get('google_contacts');
    const message = url.searchParams.get('message');

    if (
      tabParam === 'contacts' ||
      tabParam === 'personality' ||
      tabParam === 'policy' ||
      tabParam === 'tools' ||
      tabParam === 'approvals' ||
      tabParam === 'audit'
    ) {
      setTab(tabParam);
    }
    if (googleStatus === 'connected') {
      setToast({
        kind: 'success',
        text: message || 'Google Contacts connected.',
      });
      void refreshAll();
    } else if (googleStatus === 'error') {
      setToast({
        kind: 'error',
        text: message || 'Google Contacts connection failed.',
      });
    }

    if (tabParam || googleStatus || message) {
      url.searchParams.delete('tab');
      url.searchParams.delete('google_contacts');
      url.searchParams.delete('message');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const contacts = contactsState.data?.contacts || [];
  const selectedContact = contactDetailState.data?.contact || null;
  const preview = previewState.data?.preview || '';
  const policy = policyState.data?.policy || { pausedProviders: [] };
  const verifiedIdentities = verifiedState.data?.verifiedIdentities || [];
  const tools = toolsState.data?.tools || [];
  const pendingActions = pendingState.data?.pending || [];
  const providers = providerState.data?.providers || {
    onecliConfigured: false,
    onecliReachable: false,
    googleContactsAvailable: false,
    googleContactsSource: 'none' as const,
    signalOutboundAvailable: false,
    smsOutboundAvailable: false,
    emailOutboundAvailable: false,
    contactResolutionAvailable: false,
  };
  const googleContactsSetup = googleContactsSetupState.data || {
    origin: `http://${setupDraft.ADMIN_BIND_HOST || '127.0.0.1'}:${setupDraft.ADMIN_PORT || '3030'}`,
    callbackUri: `http://${setupDraft.ADMIN_BIND_HOST || '127.0.0.1'}:${setupDraft.ADMIN_PORT || '3030'}/api/admin/google/oauth/callback`,
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
    configured: {
      clientId: false,
      clientSecret: false,
      accessToken: false,
    },
  };
  const auditRecords = auditState.data?.audit || [];
  const groupedTools = Object.entries(
    tools.reduce<Record<string, ToolRegistryItem[]>>((groups, tool) => {
      const key = getToolTypeKey(tool);
      groups[key] = [...(groups[key] || []), tool];
      return groups;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));
  const setupChecks = setupState.data?.checks || {
    openAIConfigured: false,
    signalConfigured: false,
    signalReachable: false,
    signalComposeConfigured: false,
    signalComposeRunning: false,
    onecliConfigured: false,
    onecliReachable: false,
    googleContactsAvailable: false,
    googleContactsSource: 'none' as const,
    controlChatConfigured: false,
    verifiedIdentityCount: 0,
    assistantSignalConfigured: false,
    wizardComplete: false,
  };

  const errorBanner = [
    actionError,
    setupState.error,
    contactsState.error,
    contactDetailState.error,
    personalityState.error,
    previewState.error,
    policyState.error,
    verifiedState.error,
    settingsState.error,
    signalProfileState.error,
    googleContactsSetupState.error,
    providerState.error,
    pendingState.error,
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
      toolsState.refresh(),
      signalProfileState.refresh(),
      googleContactsSetupState.refresh(),
      providerState.refresh(),
      pendingState.refresh(),
      auditState.refresh(),
    ]);
  };

  const mutate = async (action: string, input: unknown) => {
    setActionError('');
    try {
      await apiFetch('/api/admin/actions', {
        method: 'POST',
        body: JSON.stringify({ action, input }),
      });
      await refreshAll();
      setToast({ kind: 'success', text: 'Saved successfully.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      setActionError(message);
      setToast({ kind: 'error', text: message });
      throw err;
    }
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

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

  const startSignalCompose = async () => {
    await mutate('signal.composeUp', {
      account: setupDraft.SIGNAL_ACCOUNT,
      rpcUrl: setupDraft.SIGNAL_RPC_URL,
    });
  };

  const requestSignalLinkQr = async (deviceName: string) => {
    setActionError('');
    try {
      const result = await apiFetch<{ dataUrl: string }>('/api/admin/signal/link', {
        method: 'POST',
        body: JSON.stringify({ deviceName }),
      });
      return result.dataUrl;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Signal link failed');
      throw err;
    }
  };

  const startSignalRegistration = async (useVoice: boolean, captchaToken?: string) => {
    setActionError('');
    setSignalCaptchaRequired(false);
    try {
      const result = await apiFetch<{ message: string; captchaRequired?: boolean; captchaUrl?: string }>(
        '/api/admin/signal/register/start',
        {
          method: 'POST',
          body: JSON.stringify({
            account: setupDraft.SIGNAL_ACCOUNT,
            useVoice,
            ...(captchaToken ? { captchaToken } : {}),
          }),
        },
      );
      if (result.captchaRequired) {
        setSignalCaptchaRequired(true);
        return result.message;
      }
      return result.message;
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Signal registration failed',
      );
      throw err;
    }
  };

  const fetchSignalExistingAccounts = async (rpcUrl?: string) => {
    try {
      const query = rpcUrl ? `?rpcUrl=${encodeURIComponent(rpcUrl)}` : '';
      const result = await apiFetch<{ accounts: string[] }>(
        `/api/admin/signal/accounts${query}`,
      );
      setSignalExistingAccounts(result.accounts || []);
    } catch {
      setSignalExistingAccounts([]);
    }
  };

  const verifySignalRegistration = async (code: string) => {
    setActionError('');
    try {
      const result = await apiFetch<{ message: string }>(
        '/api/admin/signal/register/verify',
        {
          method: 'POST',
          body: JSON.stringify({
            account: setupDraft.SIGNAL_ACCOUNT,
            code,
          }),
        },
      );
      await refreshAll();
      return result.message;
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Signal verification failed',
      );
      throw err;
    }
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

  const saveSignalProfile = async () => {
    await mutate('signal.profile.update', signalProfileDraft);
  };

  const handleSignalAvatarSelected = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const avatarDataUrl = await cropAndResizeAvatar(file, 512);
      setSignalProfileDraft((current) => ({
        ...current,
        avatarDataUrl,
      }));
      setToast({
        kind: 'success',
        text: 'Avatar cropped and resized to 512x512.',
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to prepare avatar image';
      setActionError(message);
      setToast({ kind: 'error', text: message });
    } finally {
      event.target.value = '';
    }
  };

  const decidePending = async (
    id: string,
    decision: 'approve' | 'reject',
  ) => {
    setActionError('');
    try {
      const response = await apiFetch<{ result: { message: string } }>(
        `/api/admin/pending/${encodeURIComponent(id)}/${decision}`,
        { method: 'POST' },
      );
      await refreshAll();
      setToast({ kind: 'success', text: response.result.message });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Failed to ${decision} pending action`;
      setActionError(message);
      setToast({ kind: 'error', text: message });
      throw err;
    }
  };

  const previewResolution = async () => {
    setActionError('');
    try {
      const response = await apiFetch<{ result: ResolvedContactTarget }>(
        `/api/admin/resolve-contact?channel=${encodeURIComponent(
          resolutionChannel,
        )}&query=${encodeURIComponent(resolutionQuery)}`,
      );
      setResolutionPreview(response.result);
      setToast({
        kind: 'success',
        text: `Resolved ${response.result.displayName} on ${response.result.channel}.`,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Contact resolution failed';
      setResolutionPreview(null);
      setActionError(message);
      setToast({ kind: 'error', text: message });
    }
  };

  const saveGoogleContactsCredentials = async () => {
    await saveEnvironment({
      ...(googleClientId.trim()
        ? { GOOGLE_CLIENT_ID: googleClientId.trim() }
        : {}),
      ...(googleClientSecret.trim()
        ? { GOOGLE_CLIENT_SECRET: googleClientSecret.trim() }
        : {}),
    });
    setGoogleClientSecret('');
    setToast({
      kind: 'success',
      text: 'Google Contacts OAuth client settings saved.',
    });
    await googleContactsSetupState.refresh();
  };

  const connectGoogleContacts = async () => {
    setActionError('');
    try {
      const response = await apiFetch<GoogleOAuthStartResponse>(
        '/api/admin/google/oauth/start',
      );
      window.location.assign(response.url);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start Google OAuth';
      setActionError(message);
      setToast({ kind: 'error', text: message });
    }
  };

  const tabs = [
    ['contacts', 'Contacts', 'People and identity control', cilPeople],
    ['personality', 'Personality', 'Voice, role, and prompt shaping', cilUser],
    ['policy', 'Policy', 'Provider switches and trust settings', cilShieldAlt],
    ['tools', 'Tools', 'Registry-backed control actions and integrations', cilNotes],
    ['approvals', 'Approvals', 'Pending actions that need a human', cilCheckCircle],
    ['audit', 'Audit', 'Action history and accountability', cilDescription],
  ] as const;
  const setupBlocked = !setupChecks.wizardComplete;
  const activeTab = tabs.find(([value]) => value === tab) || tabs[0];
  const systemChecks = [
    ['Model backend', setupChecks.openAIConfigured],
    ['Signal account', setupChecks.signalConfigured],
    ['Signal bridge', setupChecks.signalComposeRunning],
    ['Control chat', setupChecks.controlChatConfigured],
    ['Verified identities', setupChecks.verifiedIdentityCount > 0],
  ] as const;

  return (
    <div className="adminCoreui">
      {toast ? (
        <div className={`toast ${toast.kind}`}>{toast.text}</div>
      ) : null}

      <CSidebar
        className="border-end adminSidebar"
        colorScheme="dark"
        position="fixed"
        unfoldable={sidebarUnfoldable}
        visible={sidebarVisible}
        onVisibleChange={setSidebarVisible}
      >
        <CSidebarHeader className="border-bottom">
          <CSidebarBrand className="adminSidebarBrand" href="#">
            <div className="brandMark">
              <CIcon icon={cilSpeech} size="lg" />
            </div>
            <div className="brandCopy">
              <span>Self-Hosted Claw</span>
              <small>Admin control plane</small>
            </div>
          </CSidebarBrand>
          <CCloseButton className="d-lg-none" dark onClick={() => setSidebarVisible(false)} />
        </CSidebarHeader>
        <CSidebarNav className="adminSidebarNav">
          {tabs.map(([value, label, description, icon]) => (
            <CNavItem key={value}>
              <CTooltip
                content={description}
                placement="right"
                trigger={['hover', 'focus']}
              >
                <CNavLink
                  href="#"
                  active={tab === value}
                  className="navItem"
                  onClick={(event) => {
                    event.preventDefault();
                    setTab(value);
                  }}
                >
                  <CIcon className="navIcon" icon={icon} />
                  <span>{label}</span>
                </CNavLink>
              </CTooltip>
            </CNavItem>
          ))}
        </CSidebarNav>
        <CSidebarFooter className="border-top d-none d-lg-flex justify-content-between align-items-center">
          <CBadge className={`setupBadge ${setupBlocked ? 'warn' : 'ok'}`}>
            {setupBlocked ? 'Setup required' : 'Ready'}
          </CBadge>
          <CSidebarToggler onClick={() => setSidebarUnfoldable((current) => !current)} />
        </CSidebarFooter>
      </CSidebar>

      <div className="wrapper d-flex flex-column min-vh-100 adminWrapper">
        <CHeader position="sticky" className="mb-4 p-0 adminHeader">
          <CContainer fluid className="border-bottom px-4">
            <CHeaderToggler
              onClick={() => setSidebarVisible((current) => !current)}
              style={{ marginInlineStart: '-14px' }}
            >
              <CIcon icon={cilMenu} size="lg" />
            </CHeaderToggler>
            <CHeaderBrand className="d-md-none" href="#">
              Claw Admin
            </CHeaderBrand>
            <CHeaderNav className="d-none d-md-flex">
              <CNavItem>
                <CNavLink href="#" active>
                  Dashboard
                </CNavLink>
              </CNavItem>
              <CNavItem>
                <CNavLink href="#">Operations</CNavLink>
              </CNavItem>
              <CNavItem>
                <CNavLink href="#">Security</CNavLink>
              </CNavItem>
            </CHeaderNav>
            <CHeaderNav className="ms-auto">
              <CNavItem>
                <CNavLink href="#">
                  <CIcon icon={cilBell} size="lg" />
                </CNavLink>
              </CNavItem>
              <CNavItem>
                <CNavLink href="#">
                  <CIcon icon={cilList} size="lg" />
                </CNavLink>
              </CNavItem>
              <CNavItem>
                <CNavLink href="#">
                  <CIcon icon={cilSettings} size="lg" />
                </CNavLink>
              </CNavItem>
            </CHeaderNav>
          </CContainer>
          <CContainer fluid className="px-4 py-3 adminHeaderDetails">
            <div>
              <div className="heroEyebrow">{activeTab[1]}</div>
              <h1 className="adminPageTitle">{activeTab[2]}</h1>
              <p className="adminPageLead">
                The admin UI and Signal control chat call the same host-side actions,
                so everything here reflects the real control plane.
              </p>
            </div>
            <div className="heroChips">
              <CBadge className={`heroChip ${setupBlocked ? 'warn' : 'ok'}`}>
                {setupBlocked ? 'Setup overlay active' : 'Setup complete'}
              </CBadge>
              <CBadge className="heroChip">
                {providers.googleContactsAvailable
                  ? `Google Contacts ${providers.googleContactsSource}`
                  : 'Google Contacts offline'}
              </CBadge>
              <CBadge className="heroChip">
                {providers.onecliReachable ? 'OneCLI reachable' : 'OneCLI pending'}
              </CBadge>
            </div>
          </CContainer>
        </CHeader>

        <div className="body flex-grow-1 adminBody">
          <CContainer fluid className="px-4">
            <CRow className="g-4 mb-4">
              <CCol sm={6} xl={3}>
                <CCard className="metricCard">
                  <CCardBody>
                    <div className="text-body-secondary small text-uppercase">Contacts</div>
                    <div className="metricValue">{contacts.length}</div>
                    <div className="metricMeta">Known identities in review</div>
                  </CCardBody>
                </CCard>
              </CCol>
              <CCol sm={6} xl={3}>
                <CCard className="metricCard">
                  <CCardBody>
                    <div className="text-body-secondary small text-uppercase">Approvals</div>
                    <div className="metricValue">{pendingActions.length}</div>
                    <div className="metricMeta">Pending human decisions</div>
                  </CCardBody>
                </CCard>
              </CCol>
              <CCol sm={6} xl={3}>
                <CCard className="metricCard">
                  <CCardBody>
                    <div className="text-body-secondary small text-uppercase">Audit log</div>
                    <div className="metricValue">{auditRecords.length}</div>
                    <div className="metricMeta">Recent control-plane events</div>
                  </CCardBody>
                </CCard>
              </CCol>
              <CCol sm={6} xl={3}>
                <CCard className="metricCard">
                  <CCardBody>
                    <div className="text-body-secondary small text-uppercase">Verified</div>
                    <div className="metricValue">{verifiedIdentities.length}</div>
                    <div className="metricMeta">Trusted human identities</div>
                  </CCardBody>
                </CCard>
              </CCol>
            </CRow>

            <CRow className="g-4">
              <CCol xl={9} className="workspace">
                {errorBanner ? <div className="banner error">{errorBanner}</div> : null}

                <div className="contentDeck">
          {tab === 'contacts' ? (
        <>
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

          <section className="panel googleContactsPanel">
            <div className="panelHeader">
              <h2>Google Contacts Setup</h2>
              <span className="setupBadge">
                {providers.googleContactsAvailable ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <p>
              Use this when you want the agent to resolve people like “Elyssa”
              from Google Contacts before starting a new Signal, SMS, or email thread.
            </p>
            <div className="hintBox">
              <p>
                Enable the <strong>People API</strong> in Google Cloud, then create an
                OAuth client.
              </p>
              <p>
                Application type: <strong>Web application</strong>
              </p>
              <p>
                Authorized JavaScript origin:
              </p>
              <code className="inlineBlock">{googleContactsSetup.origin}</code>
              <p>
                Authorized redirect URI:
              </p>
              <code className="inlineBlock">{googleContactsSetup.callbackUri}</code>
              <p>
                Scope to request:
              </p>
              <code className="inlineBlock">{googleContactsSetup.scopes.join(' ')}</code>
              <p>
                Current status: client ID {googleContactsSetup.configured.clientId ? 'saved' : 'missing'},
                client secret {googleContactsSetup.configured.clientSecret ? 'saved' : 'missing'},
                access token {googleContactsSetup.configured.accessToken ? 'present' : 'missing'}.
              </p>
            </div>
            <div className="wizardGrid">
              <label>
                Google client ID
                <input
                  value={googleClientId}
                  onChange={(event) => setGoogleClientId(event.target.value)}
                  placeholder="Google OAuth web client ID"
                />
              </label>
              <label>
                Google client secret
                <input
                  type="password"
                  value={googleClientSecret}
                  onChange={(event) => setGoogleClientSecret(event.target.value)}
                  placeholder="Google OAuth client secret"
                />
              </label>
            </div>
            <div className="buttonRow">
              <button onClick={() => void saveGoogleContactsCredentials()}>
                Save Google OAuth settings
              </button>
              <button
                onClick={() => void connectGoogleContacts()}
                disabled={
                  !googleContactsSetup.configured.clientId ||
                  !googleContactsSetup.configured.clientSecret
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

            <h3>Availability</h3>
            <ul className="plainList">
              <li>OneCLI gateway: {providers.onecliReachable ? 'reachable' : providers.onecliConfigured ? 'configured but unreachable' : 'not configured'}</li>
              <li>
                Google Contacts: {providers.googleContactsAvailable ? 'available' : 'not available'}
                {providers.googleContactsAvailable
                  ? ` (${providers.googleContactsSource})`
                  : ''}
              </li>
              <li>Signal outbound: {providers.signalOutboundAvailable ? 'available' : 'not available'}</li>
              <li>SMS outbound: {providers.smsOutboundAvailable ? 'available' : 'not available'}</li>
              <li>Email outbound: {providers.emailOutboundAvailable ? 'available' : 'not available'}</li>
            </ul>

            <h3>Contact Resolution Preview</h3>
            <div className="buttonRow">
              <select
                value={resolutionChannel}
                onChange={(event) =>
                  setResolutionChannel(
                    event.target.value as 'signal' | 'sms' | 'email',
                  )
                }
              >
                <option value="signal">Signal</option>
                <option value="sms">SMS</option>
                <option value="email">Email</option>
              </select>
              <input
                value={resolutionQuery}
                onChange={(event) => setResolutionQuery(event.target.value)}
                placeholder="Sam, sam@example.com, +15555550123"
              />
              <button onClick={() => void previewResolution()}>
                Resolve
              </button>
            </div>
            {resolutionPreview ? (
              <p>
                {resolutionPreview.displayName} → {resolutionPreview.resolvedTarget}{' '}
                via {resolutionPreview.source}
                {resolutionPreview.existingConversation
                  ? ' (existing conversation)'
                  : ''}
              </p>
            ) : (
              <p>
                Resolve a name before trusting the agent with your social life.
              </p>
            )}

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
            <h2>Calendar Availability</h2>
            <p className="mutedNote">
              Set your general availability. The agent will only propose meeting times within these windows.
            </p>
            <label>
              Timezone
              <input
                value={calAvailTimezone}
                onChange={(e) => setCalAvailTimezone(e.target.value)}
                placeholder="America/New_York"
              />
            </label>

            <h3>Availability Windows</h3>
            {calAvailWindows.map((w, idx) => {
              const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
              return (
                <div key={idx} style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {dayNames.map((name, dayIdx) => (
                    <label key={dayIdx} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.85rem' }}>
                      <input
                        type="checkbox"
                        checked={w.days.includes(dayIdx)}
                        onChange={(e) => {
                          const updated = [...calAvailWindows];
                          updated[idx] = {
                            ...w,
                            days: e.target.checked
                              ? [...w.days, dayIdx].sort()
                              : w.days.filter((d) => d !== dayIdx),
                          };
                          setCalAvailWindows(updated);
                        }}
                      />
                      {name}
                    </label>
                  ))}
                  <input
                    type="time"
                    value={w.startTime}
                    onChange={(e) => {
                      const updated = [...calAvailWindows];
                      updated[idx] = { ...w, startTime: e.target.value };
                      setCalAvailWindows(updated);
                    }}
                    style={{ width: '7rem' }}
                  />
                  <span>to</span>
                  <input
                    type="time"
                    value={w.endTime}
                    onChange={(e) => {
                      const updated = [...calAvailWindows];
                      updated[idx] = { ...w, endTime: e.target.value };
                      setCalAvailWindows(updated);
                    }}
                    style={{ width: '7rem' }}
                  />
                  <button
                    onClick={() =>
                      setCalAvailWindows(calAvailWindows.filter((_, i) => i !== idx))
                    }
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            <div className="buttonRow">
              <button
                onClick={() =>
                  setCalAvailWindows([
                    ...calAvailWindows,
                    { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
                  ])
                }
              >
                Add window
              </button>
            </div>

            <label>
              Additional notes
              <textarea
                value={calAvailNotes}
                onChange={(e) => setCalAvailNotes(e.target.value)}
                placeholder="e.g. No meetings before 10am on Mondays. Prefer afternoons."
                rows={3}
                style={{ width: '100%' }}
              />
            </label>
            <button
              onClick={() => {
                apiFetch('/api/admin/policy/calendar-availability', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    timezone: calAvailTimezone,
                    windows: calAvailWindows,
                    notes: calAvailNotes,
                  }),
                })
                  .then(() =>
                    setToast({ color: 'success', message: 'Calendar availability saved.' }),
                  )
                  .catch((err) =>
                    setToast({
                      color: 'danger',
                      message: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                  );
              }}
            >
              Save availability
            </button>
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

            <h2>Signal Profile</h2>
            <label>
              Signal account
              <input
                value={signalProfileDraft.account}
                onChange={(event) =>
                  setSignalProfileDraft({
                    ...signalProfileDraft,
                    account: event.target.value,
                  })
                }
                placeholder="+15555550123"
              />
            </label>
            <label>
              Profile name
              <input
                value={signalProfileDraft.name}
                onChange={(event) =>
                  setSignalProfileDraft({
                    ...signalProfileDraft,
                    name: event.target.value,
                  })
                }
              />
            </label>
            <label>
              About
              <input
                value={signalProfileDraft.about}
                onChange={(event) =>
                  setSignalProfileDraft({
                    ...signalProfileDraft,
                    about: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Avatar image
              <input
                type="file"
                accept="image/*"
                onChange={(event) => void handleSignalAvatarSelected(event)}
              />
            </label>
            <p>
              Uploaded images are center-cropped and resized to 512x512 PNG
              before being sent to Signal.
            </p>
            {signalProfileDraft.avatarDataUrl ? (
              <div className="hintBox">
                <strong>Avatar preview</strong>
                <img
                  src={signalProfileDraft.avatarDataUrl}
                  alt="Signal avatar preview"
                  style={{
                    width: '96px',
                    height: '96px',
                    objectFit: 'cover',
                    borderRadius: '16px',
                    display: 'block',
                    marginTop: '0.75rem',
                  }}
                />
                <div className="buttonRow">
                  <button
                    type="button"
                    onClick={() =>
                      setSignalProfileDraft((current) => ({
                        ...current,
                        avatarDataUrl: '',
                      }))
                    }
                  >
                    Remove avatar
                  </button>
                </div>
              </div>
            ) : null}
            <button onClick={() => void saveSignalProfile()}>
              Save Signal profile
            </button>
          </div>
        </section>
      ) : null}

          {tab === 'tools' ? (
        <>
          <section className="panel">
            <div className="panelHeader">
              <h2>Tool Registry</h2>
              <button onClick={() => void toolsState.refresh()}>Refresh</button>
            </div>
            <p className="mutedNote">
              These cards come directly from the registered control-action definitions on
              the server, grouped by integration or capability family.
            </p>
          </section>

          {groupedTools.length === 0 ? (
            <section className="panel">
              <p>No tools are registered yet.</p>
            </section>
          ) : (
            groupedTools.map(([groupKey, groupTools]) => {
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
      ) : null}

          {tab === 'approvals' ? (
        <section className="panel">
          <div className="panelHeader">
            <h2>Pending Approvals</h2>
            <button onClick={() => void pendingState.refresh()}>Refresh</button>
          </div>
          {pendingActions.length === 0 ? (
            <p>No pending approvals.</p>
          ) : (
            <div className="historyList">
              {pendingActions.map((item) => (
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
                      onClick={() => void decidePending(item.id, 'approve')}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => void decidePending(item.id, 'reject')}
                    >
                      Reject
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
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
              </CCol>

              <CCol xl={3} className="inspector">
                <CCard className="sidebarCard">
                  <CCardHeader className="sidebarCardHeader">
                    <h2>System checks</h2>
                    <span className="mutedMeta">
                      {systemChecks.filter(([, ok]) => ok).length}/{systemChecks.length}
                    </span>
                  </CCardHeader>
                  <CCardBody>
                    <div className="checklist">
                      {systemChecks.map(([label, ok]) => (
                        <div key={label} className={ok ? 'ok' : 'warn'}>
                          {label}: {ok ? 'ready' : 'needs attention'}
                        </div>
                      ))}
                    </div>
                  </CCardBody>
                </CCard>

                {tab === 'contacts' ? (
                  <CCard className="sidebarCard">
                    <CCardHeader className="sidebarCardHeader">
                      <h2>Selected contact</h2>
                      {selectedContact ? (
                        <CBadge className={`status ${selectedContact.status}`}>
                          {selectedContact.status}
                        </CBadge>
                      ) : null}
                    </CCardHeader>
                    <CCardBody>
                      {selectedContact ? (
                        <>
                          <p>
                            <strong>{selectedContact.displayName}</strong>
                          </p>
                          <p className="mutedNote">{selectedContact.identity}</p>
                          <p>{selectedContact.classificationSummary || 'No summary yet.'}</p>
                        </>
                      ) : (
                        <p className="mutedNote">
                          Pick a contact to inspect message history and trust state.
                        </p>
                      )}
                    </CCardBody>
                  </CCard>
                ) : null}

                {tab === 'personality' ? (
                  <CCard className="sidebarCard">
                    <CCardHeader className="sidebarCardHeader">
                      <h2>Preview scope</h2>
                      <span className="mutedMeta">{scope}</span>
                    </CCardHeader>
                    <CCardBody>
                      <p className="mutedNote">Role: {personalityForm.role || 'Unset'}</p>
                      <p className="mutedNote">Tone: {personalityForm.tone || 'Unset'}</p>
                      <p className="mutedNote">Initiative: {personalityForm.initiative || 'Unset'}</p>
                    </CCardBody>
                  </CCard>
                ) : null}

                {tab === 'policy' ? (
                  <CCard className="sidebarCard">
                    <CCardHeader className="sidebarCardHeader">
                      <h2>Trust ledger</h2>
                    </CCardHeader>
                    <CCardBody>
                      <p className="mutedNote">Verified identities: {verifiedIdentities.length}</p>
                      <p className="mutedNote">
                        Paused providers:{' '}
                        {policy.pausedProviders.length ? policy.pausedProviders.join(', ') : 'none'}
                      </p>
                      <p className="mutedNote">
                        Contact resolution:{' '}
                        {providers.contactResolutionAvailable ? 'available' : 'offline'}
                      </p>
                    </CCardBody>
                  </CCard>
                ) : null}

                {tab === 'approvals' ? (
                  <CCard className="sidebarCard">
                    <CCardHeader className="sidebarCardHeader">
                      <h2>Queue focus</h2>
                    </CCardHeader>
                    <CCardBody>
                      {pendingActions[0] ? (
                        <>
                          <p>
                            <strong>{pendingActions[0].summary}</strong>
                          </p>
                          <p className="mutedNote">Requested by {pendingActions[0].actorIdentity}</p>
                          <p className="mutedNote">Expires {pendingActions[0].expiresAt}</p>
                        </>
                      ) : (
                        <p className="mutedNote">No approvals are waiting right now.</p>
                      )}
                    </CCardBody>
                  </CCard>
                ) : null}

                {tab === 'tools' ? (
                  <CCard className="sidebarCard">
                    <CCardHeader className="sidebarCardHeader">
                      <h2>Registry summary</h2>
                    </CCardHeader>
                    <CCardBody>
                      <p className="mutedNote">Registered tools: {tools.length}</p>
                      <p className="mutedNote">Tool families: {groupedTools.length}</p>
                      <div className="toolLegendList">
                        {groupedTools.map(([groupKey]) => {
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
                ) : null}

                {tab === 'audit' ? (
                  <CCard className="sidebarCard">
                    <CCardHeader className="sidebarCardHeader">
                      <h2>Latest event</h2>
                    </CCardHeader>
                    <CCardBody>
                      {auditRecords[0] ? (
                        <>
                          <p>
                            <strong>{auditRecords[0].actionName}</strong>
                          </p>
                          <p className="mutedNote">{auditRecords[0].payloadSummary}</p>
                          <p className="mutedNote">
                            {auditRecords[0].actorIdentity} | {auditRecords[0].status}
                          </p>
                        </>
                      ) : (
                        <p className="mutedNote">No audit events recorded yet.</p>
                      )}
                    </CCardBody>
                  </CCard>
                ) : null}
              </CCol>
            </CRow>
          </CContainer>
        </div>
      </div>

      {setupBlocked ? (
        <CModal
          visible={setupBlocked}
          backdrop="static"
          alignment="center"
          className="setupOverlayDialog"
        >
          <CModalBody className="setupOverlayPanel">
            <div className="setupOverlayHeader">
              <span className="heroEyebrow">First-run setup</span>
              <h2>Finish setup before the control plane unlocks</h2>
              <p>
                This stays on top until the core model, Signal bridge, and trust
                controls are configured.
              </p>
            </div>
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
              startSignalCompose={startSignalCompose}
              refreshSetupStatus={setupState.refresh}
              requestSignalLinkQr={requestSignalLinkQr}
              startSignalRegistration={startSignalRegistration}
              verifySignalRegistration={verifySignalRegistration}
              signalProvisionMode={signalProvisionMode}
              setSignalProvisionMode={setSignalProvisionMode}
              signalDeviceName={signalDeviceName}
              setSignalDeviceName={setSignalDeviceName}
              signalQrDataUrl={signalQrDataUrl}
              setSignalQrDataUrl={setSignalQrDataUrl}
              signalProvisionMessage={signalProvisionMessage}
              setSignalProvisionMessage={setSignalProvisionMessage}
              signalVerificationCode={signalVerificationCode}
              setSignalVerificationCode={setSignalVerificationCode}
              signalUseVoice={signalUseVoice}
              setSignalUseVoice={setSignalUseVoice}
              signalCaptchaRequired={signalCaptchaRequired}
              signalCaptchaToken={signalCaptchaToken}
              setSignalCaptchaToken={setSignalCaptchaToken}
              signalExistingAccounts={signalExistingAccounts}
              fetchSignalExistingAccounts={fetchSignalExistingAccounts}
              addVerifiedIdentity={addVerifiedIdentity}
            />
          </CModalBody>
        </CModal>
      ) : null}
    </div>
  );
}
