import type { ReactNode } from 'react';
import { CBadge, CButton, CCard } from '@coreui/react';
import { Wizard, useWizard } from 'react-use-wizard';

import { useAdminDashboardContext } from '../admin/context';

function WizardFrame(props: {
  title: string;
  lead: string;
  children: ReactNode;
  primaryLabel?: string;
  onPrimary?: () => void | Promise<void>;
  secondaryLabel?: string;
  onSecondary?: () => void;
  tertiary?: ReactNode;
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

function SecurityStep() {
  const dashboard = useAdminDashboardContext();

  const save = async () => {
    const envUpdate: Record<string, string> = {
      ADMIN_BIND_HOST: dashboard.setupDraft.ADMIN_BIND_HOST,
      ADMIN_PORT: dashboard.setupDraft.ADMIN_PORT,
      INBOUND_GUARD_SCRIPT: dashboard.setupDraft.INBOUND_GUARD_SCRIPT,
    };
    if (dashboard.setupDraft.ADMIN_UI_TOKEN.trim()) {
      window.localStorage.setItem(
        'admin-ui-token',
        dashboard.setupDraft.ADMIN_UI_TOKEN,
      );
      envUpdate.ADMIN_UI_TOKEN = dashboard.setupDraft.ADMIN_UI_TOKEN.trim();
    }
    await dashboard.saveEnvironment(envUpdate);
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
            dashboard.setSetupDraft((current) => ({
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
          value={dashboard.setupDraft.ADMIN_BIND_HOST}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              ADMIN_BIND_HOST: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Admin port
        <input
          value={dashboard.setupDraft.ADMIN_PORT}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
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
          value={dashboard.setupDraft.ADMIN_UI_TOKEN}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              ADMIN_UI_TOKEN: event.target.value,
            }))
          }
          placeholder={
            dashboard.setupState.data?.env.ADMIN_UI_TOKEN_SET
              ? 'Already set; enter a new token to rotate it'
              : 'Optional but recommended'
          }
        />
      </label>
      <label>
        Inbound guard script
        <input
          value={dashboard.setupDraft.INBOUND_GUARD_SCRIPT}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
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

function ModelStep() {
  const dashboard = useAdminDashboardContext();

  return (
    <WizardFrame
      title="Model backend"
      lead="Point Self-Hosted Claw at an OpenAI-compatible backend. For local models this is typically vLLM or another chat-completions-compatible endpoint."
      onPrimary={() =>
        dashboard.saveEnvironment({
          ASSISTANT_NAME: dashboard.setupDraft.ASSISTANT_NAME,
          OPENAI_BASE_URL: dashboard.setupDraft.OPENAI_BASE_URL,
          OPENAI_MODEL: dashboard.setupDraft.OPENAI_MODEL,
          OPENAI_MAX_TOKENS: dashboard.setupDraft.OPENAI_MAX_TOKENS,
          OPENAI_TEMPERATURE: dashboard.setupDraft.OPENAI_TEMPERATURE,
          ONECLI_URL: dashboard.setupDraft.ONECLI_URL,
          ...(dashboard.setupDraft.OPENAI_API_KEY.trim()
            ? { OPENAI_API_KEY: dashboard.setupDraft.OPENAI_API_KEY.trim() }
            : {}),
        })
      }
    >
      <label>
        Assistant name
        <input
          value={dashboard.setupDraft.ASSISTANT_NAME}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              ASSISTANT_NAME: event.target.value,
            }))
          }
        />
      </label>
      <label>
        OpenAI-compatible base URL
        <input
          value={dashboard.setupDraft.OPENAI_BASE_URL}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              OPENAI_BASE_URL: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Model name
        <input
          value={dashboard.setupDraft.OPENAI_MODEL}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
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
          value={dashboard.setupDraft.OPENAI_API_KEY}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              OPENAI_API_KEY: event.target.value,
            }))
          }
          placeholder={
            dashboard.setupState.data?.env.OPENAI_API_KEY_SET
              ? 'Already set; enter a new key to rotate it'
              : 'Optional for local unauthenticated backends'
          }
        />
      </label>
      <div className="wizardGrid">
        <label>
          Max tokens
          <input
            value={dashboard.setupDraft.OPENAI_MAX_TOKENS}
            onChange={(event) =>
              dashboard.setSetupDraft((current) => ({
                ...current,
                OPENAI_MAX_TOKENS: event.target.value,
              }))
            }
          />
        </label>
        <label>
          Temperature
          <input
            value={dashboard.setupDraft.OPENAI_TEMPERATURE}
            onChange={(event) =>
              dashboard.setSetupDraft((current) => ({
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
          value={dashboard.setupDraft.ONECLI_URL}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              ONECLI_URL: event.target.value,
            }))
          }
        />
      </label>
      <div className="hintBox">
        <strong>Status</strong>
        <p>
          OpenAI backend configured: {dashboard.setupChecks.openAIConfigured ? 'yes' : 'not yet'}
          <br />
          OneCLI configured: {dashboard.setupChecks.onecliConfigured ? 'yes' : 'not yet'}
          <br />
          OneCLI reachable: {dashboard.setupChecks.onecliReachable ? 'yes' : 'not yet'}
          <br />
          Google Contacts available: {dashboard.setupChecks.googleContactsAvailable ? 'yes' : 'not yet'}
          {dashboard.setupChecks.googleContactsAvailable
            ? ` (${dashboard.setupChecks.googleContactsSource})`
            : ''}
        </p>
      </div>
    </WizardFrame>
  );
}

function SignalStep() {
  const dashboard = useAdminDashboardContext();

  return (
    <WizardFrame
      title="Signal bridge and control chat"
      lead="Capture the assistant Signal identity, then let the wizard launch the managed localhost-only Signal bridge from `scripts/signal-cli/docker-compose.yml`."
      onPrimary={async () => {
        await dashboard.saveEnvironment({
          SIGNAL_ACCOUNT: dashboard.setupDraft.SIGNAL_ACCOUNT,
          SIGNAL_RPC_URL: dashboard.setupDraft.SIGNAL_RPC_URL,
          SIGNAL_RECEIVE_TIMEOUT_SEC: dashboard.setupDraft.SIGNAL_RECEIVE_TIMEOUT_SEC,
          CONTROL_SIGNAL_JID: dashboard.setupDraft.CONTROL_SIGNAL_JID,
        });
        await dashboard.saveSettings({
          controlSignalJid: dashboard.setupDraft.CONTROL_SIGNAL_JID,
          assistantSignalIdentity: dashboard.setupDraft.assistantSignalIdentity,
        });
        await dashboard.startSignalCompose();
      }}
      primaryLabel="Save and start Signal bridge"
    >
      <label>
        Assistant Signal account
        <input
          value={dashboard.setupDraft.SIGNAL_ACCOUNT}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
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
          value={dashboard.setupDraft.SIGNAL_RPC_URL}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              SIGNAL_RPC_URL: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Receive timeout (seconds)
        <input
          value={dashboard.setupDraft.SIGNAL_RECEIVE_TIMEOUT_SEC}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              SIGNAL_RECEIVE_TIMEOUT_SEC: event.target.value,
            }))
          }
        />
      </label>
      <label>
        Control Signal JID
        <input
          value={dashboard.setupDraft.CONTROL_SIGNAL_JID}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
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
          value={dashboard.setupDraft.assistantSignalIdentity}
          onChange={(event) =>
            dashboard.setSetupDraft((current) => ({
              ...current,
              assistantSignalIdentity: event.target.value,
            }))
          }
        />
      </label>
      <div className="hintBox">
        <strong>Managed bridge status</strong>
        <p>
          Signal configured: {dashboard.setupChecks.signalConfigured ? 'yes' : 'not yet'}
          <br />
          Signal reachable: {dashboard.setupChecks.signalReachable ? 'yes' : 'not yet'}
          <br />
          Managed compose configured: {dashboard.setupChecks.signalComposeConfigured ? 'yes' : 'not yet'}
          <br />
          Managed compose running: {dashboard.setupChecks.signalComposeRunning ? 'yes' : 'not yet'}
          <br />
          Control chat configured: {dashboard.setupChecks.controlChatConfigured ? 'yes' : 'not yet'}
        </p>
        <p>
          Compose file: {dashboard.setupState.data?.signalCompose.composeFile || 'n/a'}
          <br />
          Managed env: {dashboard.setupState.data?.signalCompose.envFile || 'n/a'}
          <br />
          Managed data dir: {dashboard.setupState.data?.signalCompose.dataDir || 'n/a'}
        </p>
        {dashboard.setupState.data?.signalCompose.lastError ? (
          <p>Last docker compose error: {dashboard.setupState.data.signalCompose.lastError}</p>
        ) : null}
      </div>
    </WizardFrame>
  );
}

function SignalProvisionStep() {
  const dashboard = useAdminDashboardContext();

  return (
    <WizardFrame
      title="Link or register the assistant account"
      lead="Use QR linking if this Signal account already exists on a phone. Use SMS or voice verification only if you are registering a brand-new Signal account for the assistant."
      onPrimary={dashboard.setupState.refresh}
      primaryLabel="Refresh Signal status"
      tertiary={
        <div className="buttonRow noMargin">
          <button
            type="button"
            onClick={() =>
              void dashboard
                .setupState
                .refresh()
                .then(() => {
                  dashboard.setSignalProvisionMessage(
                    'Signal status refreshed. The readiness result is shown above.',
                  );
                })
                .catch(() => undefined)
            }
          >
            Re-check readiness
          </button>
        </div>
      }
    >
      {dashboard.signalExistingAccounts.length > 0 ? (
        <div className="hintBox">
          <strong>Existing Signal identity detected</strong>
          <p>
            signal-cli already has {dashboard.signalExistingAccounts.join(', ')} registered.
            If this is the account you want to use, no provisioning step is needed,
            just click “Refresh Signal status” above to confirm readiness.
          </p>
        </div>
      ) : (
        <div className="buttonRow noMargin">
          <button
            type="button"
            onClick={() =>
              void dashboard.fetchSignalExistingAccounts(
                dashboard.setupDraft.SIGNAL_RPC_URL,
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
          className={dashboard.signalProvisionMode === 'link' ? 'active' : ''}
          onClick={() => dashboard.setSignalProvisionMode('link')}
        >
          Link existing account
        </button>
        <button
          type="button"
          className={dashboard.signalProvisionMode === 'register' ? 'active' : ''}
          onClick={() => dashboard.setSignalProvisionMode('register')}
        >
          Register by code
        </button>
      </div>

      {dashboard.signalProvisionMode === 'link' ? (
        <div className="provisionCard">
          <label>
            Linked device name
            <input
              value={dashboard.signalDeviceName}
              onChange={(event) => dashboard.setSignalDeviceName(event.target.value)}
              placeholder="Self-Hosted Claw"
            />
          </label>
          <div className="buttonRow noMargin">
            <button
              type="button"
              onClick={() =>
                void dashboard
                  .requestSignalLinkQr(dashboard.signalDeviceName)
                  .then((dataUrl) => {
                    dashboard.setSignalQrDataUrl(dataUrl);
                    dashboard.setSignalProvisionMessage(
                      'QR code generated. In Signal on your phone, open Settings > Linked Devices and scan it.',
                    );
                  })
                  .catch(() => undefined)
              }
            >
              Generate QR code
            </button>
          </div>
          {dashboard.signalQrDataUrl ? (
            <div className="qrPanel">
              <img
                src={dashboard.signalQrDataUrl}
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
              checked={dashboard.signalUseVoice}
              onChange={(event) => dashboard.setSignalUseVoice(event.target.checked)}
            />
            Use voice verification instead of SMS
          </label>
          <div className="buttonRow noMargin">
            <button
              type="button"
              onClick={() =>
                void dashboard
                  .startSignalRegistration(
                    dashboard.signalUseVoice,
                    dashboard.signalCaptchaToken || undefined,
                  )
                  .then((message) => dashboard.setSignalProvisionMessage(message))
                  .catch(() => undefined)
              }
            >
              Start registration
            </button>
          </div>
          <label>
            Captcha token
            <span style={{ fontWeight: 'normal', opacity: 0.7 }}>
              {' '} (optional - only needed if Signal asks for one)
            </span>
            <input
              value={dashboard.signalCaptchaToken}
              onChange={(event) => dashboard.setSignalCaptchaToken(event.target.value)}
              placeholder="signalcaptcha://03AFY_..."
            />
          </label>
          {dashboard.signalCaptchaToken ? (
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
                “Open Signal” button and copy the link. Paste the full
                <code> signalcaptcha://...</code> URL above, then click
                “Start registration”.
              </p>
            </div>
          ) : null}
          <label>
            Verification code
            <input
              value={dashboard.signalVerificationCode}
              onChange={(event) =>
                dashboard.setSignalVerificationCode(event.target.value)
              }
              placeholder="123-456"
            />
          </label>
          <div className="buttonRow noMargin">
            <button
              type="button"
              onClick={() =>
                void dashboard
                  .verifySignalRegistration(dashboard.signalVerificationCode)
                  .then((message) => dashboard.setSignalProvisionMessage(message))
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
        <p>Signal reachable: {dashboard.setupChecks.signalReachable ? 'yes' : 'not yet'}</p>
        {dashboard.signalProvisionMessage ? (
          <p>{dashboard.signalProvisionMessage}</p>
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

function OwnershipStep() {
  const dashboard = useAdminDashboardContext();

  return (
    <WizardFrame
      title="Verified owner identities"
      lead="Only owner-verified identities can use the full Signal control plane. Add at least your primary Signal identity before completing setup."
      primaryLabel="Save and continue"
      onPrimary={dashboard.addVerifiedIdentity}
      tertiary={
        <button type="button" onClick={() => void dashboard.addVerifiedIdentity()}>
          Add identity
        </button>
      }
    >
      <label>
        Verified identity
        <input
          value={dashboard.verifiedIdentityInput}
          onChange={(event) => dashboard.setVerifiedIdentityInput(event.target.value)}
          placeholder="signal:user:+15555550123 or +15555550123"
        />
      </label>
      <label>
        Label
        <input
          value={dashboard.verifiedLabelInput}
          onChange={(event) => dashboard.setVerifiedLabelInput(event.target.value)}
          placeholder="Justin"
        />
      </label>
      <ul className="plainList">
        {dashboard.verifiedIdentities.map((item) => (
          <li key={item.identity}>
            <span>
              {item.label}: {item.identity}
            </span>
          </li>
        ))}
      </ul>
      <div className="hintBox">
        <strong>Status</strong>
        <p>Verified identities configured: {dashboard.setupChecks.verifiedIdentityCount}</p>
      </div>
    </WizardFrame>
  );
}

function ReviewStep() {
  const dashboard = useAdminDashboardContext();
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
        <div className={dashboard.setupChecks.openAIConfigured ? 'ok' : 'warn'}>
          OpenAI backend configured
        </div>
        <div className={dashboard.setupChecks.signalConfigured ? 'ok' : 'warn'}>
          Signal bridge configured
        </div>
        <div className={dashboard.setupChecks.signalReachable ? 'ok' : 'warn'}>
          Signal bridge reachable
        </div>
        <div className={dashboard.setupChecks.signalComposeRunning ? 'ok' : 'warn'}>
          Managed Signal compose running
        </div>
        <div className={dashboard.setupChecks.controlChatConfigured ? 'ok' : 'warn'}>
          Control Signal chat configured
        </div>
        <div
          className={dashboard.setupChecks.verifiedIdentityCount > 0 ? 'ok' : 'warn'}
        >
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

export function SetupWizard() {
  return (
    <div className="panel">
      <div className="panelHeader">
        <h2>First-run setup wizard</h2>
        <span className="setupBadge">react-use-wizard</span>
      </div>
      <Wizard>
        <SecurityStep />
        <ModelStep />
        <SignalStep />
        <SignalProvisionStep />
        <OwnershipStep />
        <ReviewStep />
      </Wizard>
    </div>
  );
}
