import { useEffect, useState } from 'react';
import { CButton, CCallout, CFormInput, CInputGroup } from '@coreui/react';
import { Clipboard } from 'react-bootstrap-icons';
import { apiFetch } from '../../admin/api';

interface WebhookUrlStepUIProps {
  integrationName: string;
  completed: boolean;
  onSetupComplete?: () => void;
}

export function WebhookUrlStepUI({
  integrationName,
  completed,
  onSetupComplete,
}: WebhookUrlStepUIProps) {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [helpUrl, setHelpUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    received: boolean;
    message?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void apiFetch<{ url: string; helpUrl?: string }>(
      `/api/admin/integrations/${integrationName}/setup/webhook/url`,
    ).then((data) => {
      setWebhookUrl(data.url);
      if (data.helpUrl) setHelpUrl(data.helpUrl);
    });
  }, [integrationName]);

  const testWebhook = async () => {
    setTesting(true);
    try {
      const data = await apiFetch<{ received: boolean; message?: string }>(
        `/api/admin/integrations/${integrationName}/setup/webhook/test`,
        { method: 'POST' },
      );
      setTestResult(data);
      if (data.received) {
        const status = await apiFetch<{ completed: boolean }>(
          `/api/admin/integrations/${integrationName}/setup/status`,
        );
        if (status.completed) {
          onSetupComplete?.();
        }
      }
    } catch {
      setTestResult({ received: false, message: 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (completed) {
    return <CCallout color="success">Webhook configured and receiving.</CCallout>;
  }

  return (
    <div>
      <label className="form-label small text-body-secondary">
        Add this webhook URL to your external service:
      </label>
      <CInputGroup className="mb-3">
        <CFormInput value={webhookUrl} readOnly />
        <CButton color="secondary" variant="outline" onClick={copy}>
          <Clipboard size={14} /> {copied ? 'Copied!' : 'Copy'}
        </CButton>
      </CInputGroup>
      {helpUrl && (
        <p className="small">
          <a href={helpUrl} target="_blank" rel="noopener noreferrer">
            Setup instructions
          </a>
        </p>
      )}
      <CButton color="primary" onClick={testWebhook} disabled={testing}>
        {testing ? 'Testing...' : 'Test Connection'}
      </CButton>
      {testResult && (
        <CCallout
          color={testResult.received ? 'success' : 'warning'}
          className="mt-2 py-1 px-2 small"
        >
          {testResult.message ||
            (testResult.received ? 'Webhook received!' : 'No webhook received yet')}
        </CCallout>
      )}
    </div>
  );
}
