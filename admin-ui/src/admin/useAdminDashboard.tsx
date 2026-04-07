import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';

import { apiFetch, useJson } from './api';
import { cropAndResizeAvatar } from './avatar';
import { getToolTypeKey } from './toolRegistry';
import type {
  AuditRecord,
  AvailabilityWindow,
  ContactDetailView,
  ContactView,
  ControlPolicy,
  ControlSettings,
  GoogleContactsSetup,
  GoogleOAuthStartResponse,
  PendingControlAction,
  PersonalityProfile,
  PersonalityScope,
  ProviderAvailability,
  ResolvedContactTarget,
  SetupDraft,
  SetupStatusResponse,
  SignalProfileSettings,
  SignalProvisionMode,
  ToastMessage,
  ToolRegistryItem,
  VerifiedIdentity,
} from './types';

export function useAdminDashboard() {
  const [actionError, setActionError] = useState('');
  const [contactStatusFilter, setContactStatusFilter] = useState('');
  const [selectedContactId, setSelectedContactId] = useState('');
  const [scope, setScope] = useState<PersonalityScope>('global');
  const [personalityForm, setPersonalityForm] = useState<PersonalityProfile>({
    scope: 'global',
    displayName: '',
    role: '',
    tone: '',
    communicationStyle: '',
    initiative: '',
    aboutMe: '',
    customInstructions: '',
  });
  const [providerInput, setProviderInput] = useState('signal');
  const [verifiedIdentityInput, setVerifiedIdentityInput] = useState('');
  const [verifiedLabelInput, setVerifiedLabelInput] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [resolutionQuery, setResolutionQuery] = useState('');
  const [resolutionChannel, setResolutionChannel] = useState<
    'signal' | 'sms' | 'email'
  >('signal');
  const [resolutionPreview, setResolutionPreview] =
    useState<ResolvedContactTarget | null>(null);
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
  const [calAvailTimezone, setCalAvailTimezone] = useState('America/New_York');
  const [calAvailWindows, setCalAvailWindows] = useState<AvailabilityWindow[]>([
    { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
  ]);
  const [calAvailNotes, setCalAvailNotes] = useState('');
  const [calAvailLoaded, setCalAvailLoaded] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
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

  const contactsState = useJson(`contacts:${contactStatusFilter}`, async () => {
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
      setPersonalityForm({
        ...personalityState.data.profile,
        // Backfill for profiles saved before aboutMe existed
        aboutMe: personalityState.data.profile.aboutMe ?? '',
      });
    }
  }, [personalityState.data?.profile]);

  useEffect(() => {
    if (calAvailLoaded) return;
    apiFetch<{
      calendarAvailability: {
        timezone: string;
        windows: AvailabilityWindow[];
        notes: string;
      } | null;
    }>('/api/admin/policy/calendar-availability')
      .then((result) => {
        if (result.calendarAvailability) {
          setCalAvailTimezone(result.calendarAvailability.timezone);
          setCalAvailWindows(
            result.calendarAvailability.windows.length > 0
              ? result.calendarAvailability.windows
              : [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }],
          );
          setCalAvailNotes(result.calendarAvailability.notes);
        }
        setCalAvailLoaded(true);
      })
      .catch(() => setCalAvailLoaded(true));
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
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

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
  const setupBlocked = !setupChecks.wizardComplete;

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
    toolsState.error,
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

  const saveEnvironment = async (values: Record<string, string>) => {
    const cleaned = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    );
    if (cleaned.ADMIN_UI_TOKEN) {
      window.localStorage.setItem('admin-ui-token', cleaned.ADMIN_UI_TOKEN);
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

  const startSignalRegistration = async (
    useVoice: boolean,
    captchaToken?: string,
  ) => {
    setActionError('');
    setSignalCaptchaRequired(false);
    try {
      const result = await apiFetch<{
        message: string;
        captchaRequired?: boolean;
      }>('/api/admin/signal/register/start', {
        method: 'POST',
        body: JSON.stringify({
          account: setupDraft.SIGNAL_ACCOUNT,
          useVoice,
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });
      if (result.captchaRequired) {
        setSignalCaptchaRequired(true);
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

  const decidePending = async (id: string, decision: 'approve' | 'reject') => {
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
      ...(googleClientId.trim() ? { GOOGLE_CLIENT_ID: googleClientId.trim() } : {}),
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

  const saveCalendarAvailability = async () => {
    try {
      await apiFetch('/api/admin/policy/calendar-availability', {
        method: 'POST',
        body: JSON.stringify({
          timezone: calAvailTimezone,
          windows: calAvailWindows,
          notes: calAvailNotes,
        }),
      });
      setToast({ kind: 'success', text: 'Calendar availability saved.' });
    } catch (err) {
      setToast({
        kind: 'error',
        text: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  return {
    actionError,
    auditRecords,
    auditState,
    calAvailNotes,
    calAvailTimezone,
    calAvailWindows,
    connectGoogleContacts,
    contactDetailState,
    contactStatusFilter,
    contacts,
    contactsState,
    decidePending,
    errorBanner,
    fetchSignalExistingAccounts,
    googleClientId,
    googleClientSecret,
    googleContactsSetup,
    googleContactsSetupState,
    groupedTools,
    handleSignalAvatarSelected,
    mutate,
    pendingActions,
    pendingState,
    personalityForm,
    personalityState,
    policy,
    policyState,
    preview,
    previewResolution,
    previewState,
    providerInput,
    providers,
    providerState,
    refreshAll,
    requestSignalLinkQr,
    resolutionChannel,
    resolutionPreview,
    resolutionQuery,
    saveCalendarAvailability,
    saveEnvironment,
    saveGoogleContactsCredentials,
    saveSettings,
    saveSignalProfile,
    scope,
    selectedContact,
    selectedContactId,
    settingsDraft,
    settingsState,
    setActionError,
    setCalAvailNotes,
    setCalAvailTimezone,
    setCalAvailWindows,
    setContactStatusFilter,
    setGoogleClientId,
    setGoogleClientSecret,
    setPersonalityForm,
    setProviderInput,
    setResolutionChannel,
    setResolutionQuery,
    setScope,
    setSelectedContactId,
    setSettingsDraft,
    setSetupDraft,
    setSignalCaptchaToken,
    setSignalDeviceName,
    setSignalProfileDraft,
    setSignalProvisionMessage,
    setSignalProvisionMode,
    setSignalQrDataUrl,
    setSignalUseVoice,
    setSignalVerificationCode,
    setToast,
    setVerifiedIdentityInput,
    setVerifiedLabelInput,
    setupBlocked,
    setupChecks,
    setupDraft,
    setupState,
    signalCaptchaRequired,
    signalCaptchaToken,
    signalDeviceName,
    signalExistingAccounts,
    signalProfileDraft,
    signalProfileState,
    signalProvisionMessage,
    signalProvisionMode,
    signalQrDataUrl,
    signalUseVoice,
    signalVerificationCode,
    startSignalCompose,
    startSignalRegistration,
    tools,
    toolsState,
    toast,
    verifiedIdentities,
    verifiedIdentityInput,
    verifiedLabelInput,
    verifiedState,
    addVerifiedIdentity,
    verifySignalRegistration,
  };
}

export type AdminDashboardState = ReturnType<typeof useAdminDashboard>;
