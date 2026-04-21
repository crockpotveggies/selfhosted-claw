import { useEffect, useRef, useState } from 'react';
import { CButton, CCallout, CFormInput, CInputGroup, CSpinner } from '@coreui/react';
import { BoxArrowUpRight, Clipboard, CheckLg } from 'react-bootstrap-icons';
import { apiFetch } from '../../admin/api';

interface OAuthStepUIProps {
  integrationName: string;
  completed: boolean;
  actionLabel?: string;
  onSetupComplete?: () => void;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mb-2">
      <label className="form-label small text-body-secondary mb-1">
        {label}
      </label>
      <CInputGroup size="sm">
        <CFormInput value={value} readOnly style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} />
        <CButton color="secondary" variant="outline" onClick={copy} style={{ minWidth: 70 }}>
          {copied ? <><CheckLg size={14} /> Done</> : <><Clipboard size={14} /> Copy</>}
        </CButton>
      </CInputGroup>
    </div>
  );
}

export function OAuthStepUI({
  integrationName,
  completed,
  actionLabel,
  onSetupComplete,
}: OAuthStepUIProps) {
  const [loading, setLoading] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [originUrl, setOriginUrl] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [justConnected, setJustConnected] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load callback URL on mount
  useEffect(() => {
    void (async () => {
      try {
        const data = await apiFetch<{ callbackUrl: string; callbackPath: string }>(
          `/api/admin/integrations/${integrationName}/setup/oauth/callback-url`,
        );
        setCallbackUrl(data.callbackUrl);
        try {
          const url = new URL(data.callbackUrl);
          setOriginUrl(url.origin);
        } catch {
          setOriginUrl(window.location.origin);
        }
      } catch {
        setOriginUrl(window.location.origin);
      }
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [integrationName]);

  // Pre-fetch the OAuth URL so we can open it synchronously (avoids popup blocker)
  const prefetchAuthUrl = async () => {
    try {
      const data = await apiFetch<{ url: string }>(
        `/api/admin/integrations/${integrationName}/setup/oauth/start`,
      );
      setAuthUrl(data.url);
      return data.url;
    } catch {
      return '';
    }
  };

  const startOAuth = () => {
    setLoading(true);
    setJustConnected(false);

    // Open popup SYNCHRONOUSLY on click — must happen in the click handler
    // stack frame or browsers block it as a popup.
    const w = 500;
    const h = 650;
    const left = window.screenX + (window.innerWidth - w) / 2;
    const top = window.screenY + (window.innerHeight - h) / 2;
    const popup = window.open(
      'about:blank',
      `oauth-${integrationName}`,
      `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`,
    );
    popupRef.current = popup;

    // Now fetch the OAuth URL and navigate the already-open popup to it
    void (async () => {
      try {
        let url = authUrl;
        if (!url) {
          url = (await prefetchAuthUrl()) || '';
        }
        if (url && popup && !popup.closed) {
          popup.location.href = url;
        } else {
          popup?.close();
          setLoading(false);
          return;
        }
      } catch {
        popup?.close();
        setLoading(false);
        return;
      }

      // Poll for popup close
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (!popupRef.current || popupRef.current.closed) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          popupRef.current = null;
          setLoading(false);
          setJustConnected(true);
          setAuthUrl('');
          void apiFetch<{ completed: boolean }>(
            `/api/admin/integrations/${integrationName}/setup/status`,
          )
            .then((status) => {
              if (status.completed) {
                onSetupComplete?.();
              }
            })
            .catch(() => undefined);
        }
      }, 500);
    })();
  };

  return (
    <div>
      {/* Always show the OAuth configuration URLs */}
      <div className="p-3 rounded mb-3" style={{ background: 'var(--cui-tertiary-bg)' }}>
        <div className="small fw-semibold mb-2">
          Add these to your Google Cloud Console OAuth credentials:
        </div>
        {originUrl && (
          <CopyField
            label="Authorized JavaScript origin"
            value={originUrl}
          />
        )}
        {callbackUrl && (
          <CopyField
            label="Authorized redirect URI"
            value={callbackUrl}
          />
        )}
        {!callbackUrl && !originUrl && (
          <p className="small text-body-tertiary mb-0">Loading URLs...</p>
        )}
      </div>

      {justConnected && (
        <CCallout color="success" className="mb-3 py-2 px-3">
          OAuth flow completed. Credentials have been updated.
        </CCallout>
      )}

      {completed && !justConnected ? (
        <CCallout color="success" className="mb-0">
          Connected.
          <br />
          <CButton
            color="link"
            size="sm"
            onClick={() => void startOAuth()}
            disabled={loading}
            className="mt-1 p-0"
          >
            {loading ? (
              <><CSpinner size="sm" className="me-1" /> Waiting for OAuth...</>
            ) : (
              'Re-connect'
            )}
          </CButton>
        </CCallout>
      ) : (
        <CButton
          color="primary"
          onClick={() => void startOAuth()}
          disabled={loading}
        >
          {loading ? (
            <><CSpinner size="sm" className="me-1" /> Waiting for OAuth...</>
          ) : (
            <>
              <BoxArrowUpRight size={14} className="me-1" />
              {actionLabel || 'Connect Account'}
            </>
          )}
        </CButton>
      )}
    </div>
  );
}
