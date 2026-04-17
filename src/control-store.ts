import fs from 'fs';
import path from 'path';

import {
  ADMIN_CONFIG_DIR,
  ADMIN_DATA_DIR,
  ADMIN_PENDING_ACTION_TTL_MS,
} from './config.js';
import {
  CalendarAvailabilitySettings,
  ControlAuditRecord,
  ControlContact,
  ControlPolicy,
  ControlSettings,
  GoogleContactsOAuthState,
  PendingControlAction,
  PersonalityProfile,
  SignalProfileSettings,
  VerifiedIdentity,
} from './control-types.js';

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export class ControlStore {
  private readonly contactsFile: string;
  private readonly verifiedFile: string;
  private readonly personalityFile: string;
  private readonly policyFile: string;
  private readonly settingsFile: string;
  private readonly signalProfileFile: string;
  private readonly googleContactsOAuthFile: string;
  private readonly pendingFile: string;
  private readonly auditFile: string;

  constructor(
    configDir: string = ADMIN_CONFIG_DIR,
    dataDir: string = ADMIN_DATA_DIR,
  ) {
    ensureDir(configDir);
    ensureDir(dataDir);
    this.contactsFile = path.join(configDir, 'contacts.json');
    this.verifiedFile = path.join(configDir, 'verified-identities.json');
    this.personalityFile = path.join(configDir, 'personality.json');
    this.policyFile = path.join(configDir, 'policy.json');
    this.settingsFile = path.join(configDir, 'settings.json');
    this.signalProfileFile = path.join(configDir, 'signal-profile.json');
    this.googleContactsOAuthFile = path.join(
      configDir,
      'google-contacts-oauth.json',
    );
    this.pendingFile = path.join(dataDir, 'pending-actions.json');
    this.auditFile = path.join(dataDir, 'audit-log.jsonl');
  }

  getContacts(): Record<string, ControlContact> {
    return readJsonFile<Record<string, ControlContact>>(this.contactsFile, {});
  }

  saveContacts(contacts: Record<string, ControlContact>): void {
    writeJsonFile(this.contactsFile, contacts);
  }

  getVerifiedIdentities(): VerifiedIdentity[] {
    return readJsonFile<VerifiedIdentity[]>(this.verifiedFile, []);
  }

  saveVerifiedIdentities(identities: VerifiedIdentity[]): void {
    writeJsonFile(this.verifiedFile, identities);
  }

  getPersonalityProfiles(): Record<string, PersonalityProfile> {
    return readJsonFile<Record<string, PersonalityProfile>>(
      this.personalityFile,
      {},
    );
  }

  savePersonalityProfiles(profiles: Record<string, PersonalityProfile>): void {
    writeJsonFile(this.personalityFile, profiles);
  }

  getPolicy(): ControlPolicy {
    return readJsonFile<ControlPolicy>(this.policyFile, {
      pausedProviders: [],
      updatedAt: new Date(0).toISOString(),
    });
  }

  savePolicy(policy: ControlPolicy): void {
    writeJsonFile(this.policyFile, policy);
  }

  getCalendarAvailability(): CalendarAvailabilitySettings | undefined {
    return this.getPolicy().calendarAvailability;
  }

  saveCalendarAvailability(availability: CalendarAvailabilitySettings): void {
    const policy = this.getPolicy();
    policy.calendarAvailability = availability;
    policy.updatedAt = new Date().toISOString();
    this.savePolicy(policy);
  }

  getSettings(): ControlSettings {
    return readJsonFile<ControlSettings>(this.settingsFile, {
      controlSignalJid: '',
      assistantSignalIdentity: '',
      setupWizardReviewed: false,
      updatedAt: new Date(0).toISOString(),
    });
  }

  saveSettings(settings: ControlSettings): void {
    writeJsonFile(this.settingsFile, settings);
  }

  getSignalProfile(): SignalProfileSettings {
    return readJsonFile<SignalProfileSettings>(this.signalProfileFile, {
      account: '',
      name: '',
      about: '',
      avatarDataUrl: '',
      updatedAt: new Date(0).toISOString(),
    });
  }

  saveSignalProfile(profile: SignalProfileSettings): void {
    writeJsonFile(this.signalProfileFile, profile);
  }

  getGoogleContactsOAuth(): GoogleContactsOAuthState {
    return readJsonFile<GoogleContactsOAuthState>(
      this.googleContactsOAuthFile,
      {
        accessToken: '',
        refreshToken: '',
        expiryDate: new Date(0).toISOString(),
        scope: '',
        tokenType: '',
        connectedAt: '',
        oauthState: '',
        oauthStateCreatedAt: '',
      },
    );
  }

  saveGoogleContactsOAuth(state: GoogleContactsOAuthState): void {
    writeJsonFile(this.googleContactsOAuthFile, state);
  }

  getPendingActions(): PendingControlAction[] {
    const now = Date.now();
    const pending = readJsonFile<PendingControlAction[]>(this.pendingFile, []);
    const retained = pending.filter((item) => {
      if (item.status !== 'pending') return true;
      return new Date(item.expiresAt).getTime() > now;
    });
    if (retained.length !== pending.length) this.savePendingActions(retained);
    return retained;
  }

  savePendingActions(actions: PendingControlAction[]): void {
    writeJsonFile(this.pendingFile, actions);
  }

  createPendingAction(
    partial: Omit<
      PendingControlAction,
      'id' | 'createdAt' | 'expiresAt' | 'status'
    >,
  ): PendingControlAction {
    const now = new Date();
    const pending: PendingControlAction = {
      id: `pending-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + ADMIN_PENDING_ACTION_TTL_MS,
      ).toISOString(),
      status: 'pending',
      ...partial,
    };
    const actions = this.getPendingActions();
    actions.unshift(pending);
    this.savePendingActions(actions);
    return pending;
  }

  updatePendingAction(
    id: string,
    status: 'approved' | 'rejected',
  ): PendingControlAction | undefined {
    const actions = this.getPendingActions();
    const action = actions.find((item) => item.id === id);
    if (!action) return undefined;
    action.status = status;
    this.savePendingActions(actions);
    return action;
  }

  appendAuditRecord(record: ControlAuditRecord): void {
    ensureDir(path.dirname(this.auditFile));
    fs.appendFileSync(this.auditFile, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
  }

  getAuditRecords(limit: number = 100): ControlAuditRecord[] {
    try {
      const lines = fs
        .readFileSync(this.auditFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      return lines
        .slice(-limit)
        .reverse()
        .map((line) => JSON.parse(line) as ControlAuditRecord);
    } catch {
      return [];
    }
  }
}
