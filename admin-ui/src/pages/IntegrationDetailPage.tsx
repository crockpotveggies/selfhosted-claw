import { useEffect, useState } from 'react';
import {
  CBadge,
  CButton,
  CCallout,
  CCard,
  CCardBody,
  CCardHeader,
} from '@coreui/react';
import {
  ArrowLeft,
  CheckCircleFill,
  XCircleFill,
} from 'react-bootstrap-icons';

import { apiFetch } from '../admin/api';
import { SchemaForm } from '../components/SchemaForm';
import { LogViewer } from '../components/LogViewer';
import { SetupWizard } from '../components/setup/SetupWizard';
import { OAuthStepUI } from '../components/setup/OAuthStepUI';
import { CredentialInputStepUI } from '../components/setup/CredentialInputStepUI';
import { FormStepUI } from '../components/setup/FormStepUI';
import { QrCodeStepUI } from '../components/setup/QrCodeStepUI';
import { VerificationCodeStepUI } from '../components/setup/VerificationCodeStepUI';
import { WebhookUrlStepUI } from '../components/setup/WebhookUrlStepUI';
import { PhoneVoiceBrowserTester } from '../components/PhoneVoiceBrowserTester';

interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumLabels?: string[];
  minimum?: number;
  maximum?: number;
  items?: { type: string };
  format?: string;
  sensitive?: boolean;
  dependsOn?: { field: string; value: unknown };
}

interface IntegrationDetail {
  name: string;
  description: string;
  version: string;
  core: boolean;
  category: string;
  enabled: boolean;
  status: { state: string; message: string };
  service?: {
    integrationName: string;
    serviceName: string;
    configured: boolean;
    running: boolean;
    lastError: string;
    circuitOpen: boolean;
  };
  settings: {
    schema: Record<string, unknown> | null;
    values: Record<string, unknown>;
  };
  credentials: Array<{
    key: string;
    label: string;
    type: string;
    configured: boolean;
  }>;
  capabilities: {
    hasChannel: boolean;
    tools?: Array<{
      name: string;
      description: string;
      controllerOnly?: boolean;
      location: string;
    }>;
    skills?: string[];
    hasMemory: boolean;
    hasSetup: boolean;
  };
}

interface SetupStatusResponse {
  completed: boolean;
  currentStep: number;
  steps: Array<{
    type: string;
    label: string;
    description?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    error?: string;
  }>;
}

interface IntegrationDetailPageProps {
  name: string;
  onBack: () => void;
}

function buildSchemaSubset(
  schema:
    | {
        type: 'object';
        properties: Record<string, JsonSchemaProperty>;
        required?: string[];
      }
    | null,
  keys: readonly string[],
) {
  if (!schema) return null;
  const properties = keys.reduce<Record<string, JsonSchemaProperty>>(
    (acc, key) => {
      const prop = schema.properties[key];
      if (prop) {
        acc[key] = prop;
      }
      return acc;
    },
    {},
  );
  if (Object.keys(properties).length === 0) {
    return null;
  }
  return {
    type: 'object' as const,
    properties,
    required: schema.required?.filter((key) => key in properties),
  };
}

export function IntegrationDetailPage({
  name,
  onBack,
}: IntegrationDetailPageProps) {
  const [detail, setDetail] = useState<IntegrationDetail | null>(null);
  const [setupStatus, setSetupStatus] =
    useState<SetupStatusResponse | null>(null);
  const [settingsValues, setSettingsValues] = useState<
    Record<string, unknown>
  >({});
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);

  const loadDetail = async () => {
    try {
      const data = await apiFetch<IntegrationDetail>(
        `/api/admin/integrations/${name}`,
      );
      setDetail(data);
      setSettingsValues(data.settings.values);
    } catch {
      // Error
    }
  };

  const loadSetupStatus = async () => {
    try {
      const data = await apiFetch<SetupStatusResponse>(
        `/api/admin/integrations/${name}/setup/status`,
      );
      setSetupStatus(data);
    } catch {
      // No setup flow
    }
  };

  useEffect(() => {
    void loadDetail();
    void loadSetupStatus();
  }, [name]);

  const saveSettings = async () => {
    setSaving(true);
    setSettingsError('');
    setSettingsSaved(false);
    try {
      await apiFetch(`/api/admin/integrations/${name}/settings`, {
        method: 'POST',
        body: JSON.stringify(settingsValues),
      });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : 'Save failed',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleServiceAction = async (
    action: 'start' | 'stop',
  ) => {
    try {
      await apiFetch(
        `/api/admin/integrations/${name}/service/${action}`,
        { method: 'POST' },
      );
      void loadDetail();
    } catch {
      // Error
    }
  };

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await apiFetch(`/api/admin/integrations/${name}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      await Promise.all([loadDetail(), loadSetupStatus()]);
    } catch {
      // Error
    } finally {
      setToggling(false);
    }
  };

  const handleReconnect = async () => {
    setReconnecting(true);
    try {
      await apiFetch(`/api/admin/integrations/${name}/reconnect`, {
        method: 'POST',
      });
      await Promise.all([loadDetail(), loadSetupStatus()]);
    } catch {
      // Error
    } finally {
      setReconnecting(false);
    }
  };

  const handleSetupComplete = () => {
    window.location.reload();
  };

  if (!detail) {
    return <p>Loading...</p>;
  }

  const voiceRunnerProvider = String(
    settingsValues.voiceRunnerProvider ?? 'heuristic',
  );
  const voiceRunnerModel = String(settingsValues.voiceRunnerModel ?? '').trim();
  const voiceSttProvider = String(settingsValues.voiceSttProvider ?? 'mock');
  const voiceSttModel = String(settingsValues.voiceSttModel ?? '').trim();
  const voiceTtsProvider = String(settingsValues.voiceTtsProvider ?? 'mock');
  const voiceRunnerMode = String(settingsValues.voiceRunnerMode ?? 'sidecar');
  const defaultVoice = String(settingsValues.defaultVoice ?? '').trim();
  const phoneVoiceSchema = detail.settings.schema as
    | {
        type: 'object';
        properties: Record<string, JsonSchemaProperty>;
        required?: string[];
      }
    | null;
  const llmFieldOrder = [
    'voiceRunnerProvider',
    'voiceRunnerMode',
    'voiceRunnerBaseUrl',
    'voiceRunnerApiKey',
    'voiceRunnerModel',
    'voiceRunnerSystemPrompt',
    'voiceRunnerInstructions',
    'voiceRunnerFillersEnabled',
    'voiceRunnerFillers',
  ] as const;
  const sttFieldOrder = [
    'voiceSttProvider',
    'voiceSttTargetDevice',
    'voiceSttQuantization',
    'voiceSttBaseUrl',
    'voiceSttApiKey',
    'voiceSttModel',
  ] as const;
  const ttsFieldOrder = [
    'voiceTtsProvider',
    'voiceTtsDeviceTarget',
    'voiceTtsBaseUrl',
    'voiceTtsApiKey',
    'voiceTtsModel',
    'voiceTtsResponseFormat',
    'defaultVoice',
  ] as const;
  const voiceFieldSet = new Set<string>([
    ...llmFieldOrder,
    ...sttFieldOrder,
    ...ttsFieldOrder,
  ]);
  const llmSchema =
    name === 'phone-voice'
      ? buildSchemaSubset(phoneVoiceSchema, llmFieldOrder)
      : null;
  const sttSchema =
    name === 'phone-voice'
      ? buildSchemaSubset(phoneVoiceSchema, sttFieldOrder)
      : null;
  const ttsSchema =
    name === 'phone-voice'
      ? buildSchemaSubset(phoneVoiceSchema, ttsFieldOrder)
      : null;
  const genericSettingsSchema =
    name === 'phone-voice' && phoneVoiceSchema
      ? buildSchemaSubset(
          phoneVoiceSchema,
          Object.keys(phoneVoiceSchema.properties).filter(
            (key) => !voiceFieldSet.has(key),
          ),
        )
      : detail.settings.schema;

  return (
    <div>
      {/* Header */}
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <div className="d-flex flex-wrap align-items-center gap-2">
          <CButton
            color="link"
            className="p-0"
            onClick={onBack}
          >
            <ArrowLeft size={18} />
          </CButton>
          <h2 className="mb-0">{detail.name}</h2>
          {detail.core && (
            <CBadge color="primary" size="sm">
              Core
            </CBadge>
          )}
          <CBadge
            color={
              detail.status.state === 'online'
                ? 'success'
                : detail.status.state === 'degraded'
                  ? 'warning'
                  : detail.status.state === 'offline'
                    ? 'danger'
                    : 'secondary'
            }
            size="sm"
          >
            {detail.status.state}
          </CBadge>
        </div>
        {!detail.core && (
          <div className="d-flex flex-wrap gap-2">
            {detail.enabled && detail.status.state === 'offline' && (
              <CButton
                color="warning"
                size="sm"
                variant="outline"
                disabled={reconnecting}
                onClick={() => void handleReconnect()}
              >
                {reconnecting ? 'Reconnecting...' : 'Reconnect'}
              </CButton>
            )}
            <CButton
              color={detail.enabled ? 'danger' : 'success'}
              size="sm"
              variant={detail.enabled ? 'outline' : undefined}
              disabled={toggling || reconnecting}
              onClick={() => {
                const nextEnabled = !detail.enabled;
                const action = nextEnabled ? 'Enable' : 'Disable';
                if (window.confirm(`${action} "${detail.name}"?`)) {
                  void handleToggle(nextEnabled);
                }
              }}
            >
              {toggling
                ? detail.enabled
                  ? 'Disabling...'
                  : 'Enabling...'
                : detail.enabled
                  ? 'Disable Integration'
                  : 'Enable Integration'}
            </CButton>
          </div>
        )}
      </div>
      <p className="text-body-secondary mb-4">
        {detail.description} (v{detail.version})
      </p>

      {/* Service management */}
      {detail.service && (
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Service</strong>
          </CCardHeader>
          <CCardBody>
            <div className="d-flex align-items-center gap-3 mb-2">
              <span>
                {detail.service.running ? (
                  <CheckCircleFill
                    size={16}
                    className="text-success me-1"
                  />
                ) : (
                  <XCircleFill
                    size={16}
                    className="text-danger me-1"
                  />
                )}
                {detail.service.serviceName}:{' '}
                {detail.service.running ? 'Running' : 'Stopped'}
              </span>
              {detail.service.circuitOpen && (
                <CBadge color="danger" size="sm">
                  Circuit Breaker Open
                </CBadge>
              )}
            </div>
            {detail.service.lastError && (
              <CCallout color="warning" className="py-1 px-2 small mb-2">
                {detail.service.lastError}
              </CCallout>
            )}
            <div className="d-flex gap-2">
              <CButton
                color="success"
                size="sm"
                onClick={() => handleServiceAction('start')}
              >
                Start
              </CButton>
              <CButton
                color="danger"
                size="sm"
                variant="outline"
                onClick={() => handleServiceAction('stop')}
              >
                Stop
              </CButton>
            </div>
          </CCardBody>
        </CCard>
      )}

      {/* Setup wizard */}
      {detail.capabilities.hasSetup && setupStatus && (
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Setup</strong>
            {setupStatus.completed && (
              <CBadge color="success" size="sm" className="ms-2">
                Complete
              </CBadge>
            )}
          </CCardHeader>
          <CCardBody>
            <SetupWizard
              steps={setupStatus.steps}
              currentStep={setupStatus.currentStep}
            >
              {setupStatus.steps.map((step, i) => {
                const isCompleted = step.status === 'completed';
                switch (step.type) {
                  case 'oauth2':
                    return (
                      <OAuthStepUI
                        key={i}
                        integrationName={name}
                        completed={isCompleted}
                        actionLabel={
                          step.status === 'error'
                            ? 'Re-authenticate'
                            : undefined
                        }
                        onSetupComplete={handleSetupComplete}
                      />
                    );
                  case 'credential_input':
                    return (
                      <CredentialInputStepUI
                        key={i}
                        integrationName={name}
                        completed={isCompleted}
                        onSetupComplete={handleSetupComplete}
                      />
                    );
                  case 'form':
                    return (
                      <FormStepUI
                        key={i}
                        integrationName={name}
                        stepIndex={i}
                        completed={isCompleted}
                        onSetupComplete={handleSetupComplete}
                      />
                    );
                  case 'qr_code':
                    return (
                      <QrCodeStepUI
                        key={i}
                        integrationName={name}
                        completed={isCompleted}
                        onSetupComplete={handleSetupComplete}
                      />
                    );
                  case 'verification_code':
                    return (
                      <VerificationCodeStepUI
                        key={i}
                        integrationName={name}
                        completed={isCompleted}
                        onSetupComplete={handleSetupComplete}
                      />
                    );
                  case 'webhook_url':
                    return (
                      <WebhookUrlStepUI
                        key={i}
                        integrationName={name}
                        completed={isCompleted}
                        onSetupComplete={handleSetupComplete}
                      />
                    );
                  default:
                    return (
                      <p key={i} className="text-body-secondary">
                        Custom step: {step.label}
                      </p>
                    );
                }
              })}
            </SetupWizard>
          </CCardBody>
        </CCard>
      )}

      {/* Credentials */}
      {detail.credentials.length > 0 && (
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Credentials</strong>
          </CCardHeader>
          <CCardBody>
            {detail.credentials.map((cred) => (
              <div
                key={cred.key}
                className="d-flex align-items-center gap-2 mb-1"
              >
                {cred.configured ? (
                  <CheckCircleFill
                    size={12}
                    className="text-success"
                  />
                ) : (
                  <XCircleFill
                    size={12}
                    className="text-danger"
                  />
                )}
                <span className="small">
                  {cred.label} ({cred.key})
                </span>
              </div>
            ))}
          </CCardBody>
        </CCard>
      )}

      {/* Settings */}
      {name === 'phone-voice' && (
        <CCard className="mb-3">
          <CCardHeader>
            <strong>LLM</strong>
          </CCardHeader>
          <CCardBody>
            <div className="small mb-2">
              <strong>Conversation Brain:</strong>{' '}
              <code>{voiceRunnerProvider}</code>
              {(voiceRunnerProvider === 'openai' ||
                voiceRunnerProvider === 'managed_openarc') &&
                voiceRunnerModel && (
                <>
                  {' '}
                  using <code>{voiceRunnerModel}</code>
                </>
              )}
            </div>
            <div className="small mb-0">
              <strong>Runtime:</strong>{' '}
              <code>{voiceRunnerMode}</code>
            </div>
            {llmSchema && (
              <div className="mt-3">
                <SchemaForm
                  schema={llmSchema}
                  values={settingsValues}
                  onChange={setSettingsValues}
                />
              </div>
            )}
          </CCardBody>
        </CCard>
      )}

      {name === 'phone-voice' && (
        <CCard className="mb-3">
          <CCardHeader>
            <strong>STT</strong>
          </CCardHeader>
          <CCardBody>
            <div className="small mb-2">
              <strong>Speech to Text:</strong>{' '}
              <code>{voiceSttProvider}</code>
              {voiceSttModel && (
                <>
                  {' '}
                  with <code>{voiceSttModel}</code>
                </>
              )}
            </div>
            {sttSchema && (
              <div className="mt-3">
                <SchemaForm
                  schema={sttSchema}
                  values={settingsValues}
                  onChange={setSettingsValues}
                />
              </div>
            )}
          </CCardBody>
        </CCard>
      )}

      {name === 'phone-voice' && (
        <CCard className="mb-3">
          <CCardHeader>
            <strong>TTS</strong>
          </CCardHeader>
          <CCardBody>
            <div className="small mb-2">
              <strong>Text to Speech:</strong>{' '}
              <code>{voiceTtsProvider}</code>
              {voiceTtsProvider === 'mock' && (
                <> via browser/mock fallback</>
              )}
              {(voiceTtsProvider === 'managed_f5_tts' ||
                voiceTtsProvider === 'managed_openvino_tts') && (
                <> via F5-TTS XPU</>
              )}
            </div>
            {defaultVoice && (
              <div className="small mb-0">
                <strong>Voice:</strong>{' '}
                <code>{defaultVoice}</code>
              </div>
            )}
            {ttsSchema && (
              <div className="mt-3">
                <SchemaForm
                  schema={ttsSchema}
                  values={settingsValues}
                  onChange={setSettingsValues}
                />
              </div>
            )}
            {voiceTtsProvider === 'mock' && (
              <CCallout color="warning" className="py-2 px-3 small mb-0">
                TTS is currently using the mock/browser fallback path instead of the
                managed F5-TTS XPU service.
              </CCallout>
            )}
          </CCardBody>
        </CCard>
      )}

      {genericSettingsSchema && (
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Settings</strong>
          </CCardHeader>
          <CCardBody>
            <SchemaForm
              schema={genericSettingsSchema as any}
              values={settingsValues}
              onChange={setSettingsValues}
            />
            {settingsError && (
              <CCallout
                color="danger"
                className="mt-2 py-1 px-2 small"
              >
                {settingsError}
              </CCallout>
            )}
            {settingsSaved && (
              <CCallout
                color="success"
                className="mt-2 py-1 px-2 small"
              >
                Settings saved.
              </CCallout>
            )}
            <CButton
              color="primary"
              size="sm"
              className="mt-2"
              onClick={saveSettings}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </CButton>
          </CCardBody>
        </CCard>
      )}

      {name === 'phone-voice' && <PhoneVoiceBrowserTester />}

      {/* Capabilities */}
      <CCard className="mb-3">
        <CCardHeader>
          <strong>Capabilities</strong>
        </CCardHeader>
        <CCardBody>
          <div className="d-flex gap-2 flex-wrap mb-2">
            {detail.capabilities.hasChannel && (
              <CBadge color="info">Channel</CBadge>
            )}
            {detail.capabilities.hasMemory && (
              <CBadge color="info">Memory</CBadge>
            )}
          </div>
          {detail.capabilities.tools &&
            detail.capabilities.tools.length > 0 && (
              <div className="mb-2">
                <strong className="small">
                  Tools ({detail.capabilities.tools.length}):
                </strong>
                <ul className="small mb-0 mt-1">
                  {detail.capabilities.tools.map((t) => (
                    <li key={t.name}>
                      <code>{t.name}</code> — {t.description}
                      {t.controllerOnly && (
                        <CBadge
                          color="warning"
                          size="sm"
                          className="ms-1"
                        >
                          controller-only
                        </CBadge>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
        </CCardBody>
      </CCard>

      {/* Logs */}
      <CCard className="mb-3">
        <CCardHeader>
          <strong>Recent Logs</strong>
        </CCardHeader>
        <CCardBody>
          <LogViewer integration={name} limit={25} />
        </CCardBody>
      </CCard>
    </div>
  );
}
