import { useState } from 'react';
import { CButton, CCallout, CFormInput, CFormLabel } from '@coreui/react';
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
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [captchaUrl, setCaptchaUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const sendCode = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<{
        message: string;
        captchaRequired?: boolean;
        captchaUrl?: string;
      }>(
        `/api/admin/integrations/${integrationName}/setup/verify/send`,
        { method: 'POST', body: JSON.stringify(inputs) },
      );
      setMessage(data.message);
      if (data.captchaRequired && data.captchaUrl) {
        setCaptchaUrl(data.captchaUrl);
      } else {
        setCodeSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<{ message: string }>(
        `/api/admin/integrations/${integrationName}/setup/verify/check`,
        { method: 'POST', body: JSON.stringify({ code }) },
      );
      setMessage(data.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  if (completed) {
    return <CCallout color="success">Verified.</CCallout>;
  }

  return (
    <div>
      {!codeSent ? (
        <>
          <div className="mb-3">
            <CFormLabel>Phone Number</CFormLabel>
            <CFormInput
              type="text"
              placeholder="+15551234567"
              value={inputs.account || ''}
              onChange={(e) =>
                setInputs({ ...inputs, account: e.target.value })
              }
            />
          </div>
          {captchaUrl && (
            <CCallout color="warning" className="py-2 px-3 mb-3">
              <a href={captchaUrl} target="_blank" rel="noopener noreferrer">
                Complete CAPTCHA
              </a>
              , then paste the token and retry.
            </CCallout>
          )}
          <CButton color="primary" onClick={sendCode} disabled={loading}>
            {loading ? 'Sending...' : 'Send Code'}
          </CButton>
        </>
      ) : (
        <>
          <div className="mb-3">
            <CFormLabel>Verification Code</CFormLabel>
            <CFormInput
              value={code}
              placeholder="123456"
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <CButton color="primary" onClick={verifyCode} disabled={loading}>
            {loading ? 'Verifying...' : 'Verify'}
          </CButton>
        </>
      )}
      {message && (
        <CCallout color="info" className="mt-2 py-1 px-2 small">
          {message}
        </CCallout>
      )}
      {error && (
        <CCallout color="danger" className="mt-2 py-1 px-2 small">
          {error}
        </CCallout>
      )}
    </div>
  );
}
