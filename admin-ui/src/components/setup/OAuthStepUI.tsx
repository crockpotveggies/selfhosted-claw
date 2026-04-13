import { useState } from 'react';
import { CButton, CCallout, CFormInput, CInputGroup, CInputGroupText } from '@coreui/react';
import { BoxArrowUpRight, Clipboard } from 'react-bootstrap-icons';
import { apiFetch } from '../../admin/api';

interface OAuthStepUIProps {
  integrationName: string;
  completed: boolean;
}

export function OAuthStepUI({ integrationName, completed }: OAuthStepUIProps) {
  const [loading, setLoading] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const loadCallbackUrl = async () => {
    try {
      const data = await apiFetch<{ callbackUrl: string }>(
        `/api/admin/integrations/${integrationName}/setup/oauth/callback-url`,
      );
      setCallbackUrl(data.callbackUrl);
    } catch {
      // Ignore
    }
  };

  const startOAuth = async () => {
    setLoading(true);
    try {
      await loadCallbackUrl();
      const data = await apiFetch<{ url: string }>(
        `/api/admin/integrations/${integrationName}/setup/oauth/start`,
      );
      window.open(data.url, '_blank');
    } catch (err) {
      // Error handling
    } finally {
      setLoading(false);
    }
  };

  const copyCallback = () => {
    void navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (completed) {
    return (
      <CCallout color="success">
        Connected. You can re-authenticate by clicking the button below.
        <br />
        <CButton color="link" size="sm" onClick={startOAuth} className="mt-1 p-0">
          Re-connect
        </CButton>
      </CCallout>
    );
  }

  return (
    <div>
      {callbackUrl && (
        <div className="mb-3">
          <label className="form-label small text-body-secondary">
            Callback URL (add this to your OAuth provider's allowed redirect URIs):
          </label>
          <CInputGroup size="sm">
            <CFormInput value={callbackUrl} readOnly />
            <CButton color="secondary" variant="outline" onClick={copyCallback}>
              <Clipboard size={14} />
              {copied ? ' Copied!' : ' Copy'}
            </CButton>
          </CInputGroup>
        </div>
      )}
      <CButton
        color="primary"
        onClick={startOAuth}
        disabled={loading}
      >
        <BoxArrowUpRight size={14} className="me-1" />
        {loading ? 'Connecting...' : 'Connect Account'}
      </CButton>
      {!callbackUrl && (
        <CButton
          color="link"
          size="sm"
          onClick={loadCallbackUrl}
          className="ms-2"
        >
          Show callback URL
        </CButton>
      )}
    </div>
  );
}
