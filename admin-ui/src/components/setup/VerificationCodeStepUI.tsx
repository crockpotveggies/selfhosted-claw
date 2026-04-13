import { useEffect, useRef, useState } from 'react';
import { CButton, CCallout, CFormInput, CFormLabel, CSpinner } from '@coreui/react';
import { apiFetch } from '../../admin/api';

interface VerificationCodeStepUIProps {
  integrationName: string;
  completed: boolean;
}

export function VerificationCodeStepUI({
  integrationName,
  completed,
}: VerificationCodeStepUIProps) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [codeSent, setCodeSent] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState('');
  const pollRef = useRef(false);

  // Poll setup status after code is sent — checks every 3 seconds
  useEffect(() => {
    if (!codeSent || verifyResult) return;
    setVerifying(true);
    pollRef.current = true;

    const interval = setInterval(async () => {
      if (!pollRef.current) return;
      try {
        const status = await apiFetch<{
          completed: boolean;
          steps: Array<{ status: string }>;
        }>(`/api/admin/integrations/${integrationName}/setup/status`);
        if (status.completed || status.steps?.[0]?.status === 'completed') {
          pollRef.current = false;
          clearInterval(interval);
          setVerifying(false);
          setVerifyResult('WhatsApp linked successfully!');
        }
      } catch {
        // Keep polling
      }
    }, 3000);

    // Also start the long-poll verify call as a backup
    void (async () => {
      try {
        const data = await apiFetch<{ message: string }>(
          `/api/admin/integrations/${integrationName}/setup/verify/check`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        if (pollRef.current) {
          pollRef.current = false;
          clearInterval(interval);
          setVerifying(false);
          setVerifyResult(data.message);
        }
      } catch {
        // Status polling will catch it
      }
    })();

    return () => {
      pollRef.current = false;
      clearInterval(interval);
    };
  }, [codeSent, integrationName, verifyResult]);

  const sendCode = async () => {
    setLoading(true);
    setError('');
    setMessage('');
    setVerifyResult('');
    try {
      const data = await apiFetch<{ message: string }>(
        `/api/admin/integrations/${integrationName}/setup/verify/send`,
        { method: 'POST', body: JSON.stringify(inputs) },
      );
      setMessage(data.message);
      setCodeSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };

  if (completed) {
    return <CCallout color="success">Linked.</CCallout>;
  }

  return (
    <div>
      {!codeSent ? (
        <>
          <div className="mb-3">
            <CFormLabel>Phone number (with country code, no + or spaces)</CFormLabel>
            <CFormInput
              type="text"
              placeholder="14155551234"
              value={inputs.phone || ''}
              onChange={(e) =>
                setInputs({ ...inputs, phone: e.target.value })
              }
            />
          </div>
          <CButton color="primary" onClick={sendCode} disabled={loading}>
            {loading ? (
              <><CSpinner size="sm" className="me-1" /> Requesting code...</>
            ) : (
              'Get Pairing Code'
            )}
          </CButton>
        </>
      ) : (
        <div>
          {verifyResult ? (
            <CCallout color="success">{verifyResult}</CCallout>
          ) : verifying ? (
            <div className="d-flex align-items-center gap-2 my-3">
              <CSpinner size="sm" />
              <span className="small">
                Waiting for you to enter the code on your phone...
              </span>
            </div>
          ) : null}
        </div>
      )}
      {message && (
        <CCallout color="info" className="mt-2 py-2 px-3 small" style={{ whiteSpace: 'pre-wrap' }}>
          {message.replace(/\*\*/g, '')}
        </CCallout>
      )}
      {error && (
        <CCallout color="danger" className="mt-2 py-1 px-2 small">
          {error}
          <br />
          <CButton
            color="link"
            size="sm"
            className="p-0 mt-1"
            onClick={() => {
              setCodeSent(false);
              setError('');
              setMessage('');
              setVerifyResult('');
            }}
          >
            Try again
          </CButton>
        </CCallout>
      )}
    </div>
  );
}
