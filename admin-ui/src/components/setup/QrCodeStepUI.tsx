import { useEffect, useState, useRef } from 'react';
import { CButton, CCallout, CFormInput, CFormLabel, CSpinner } from '@coreui/react';
import { apiFetch } from '../../admin/api';

interface QrCodeStepUIProps {
  integrationName: string;
  completed: boolean;
}

export function QrCodeStepUI({
  integrationName,
  completed,
}: QrCodeStepUIProps) {
  const [inputFields, setInputFields] = useState<
    Array<{ key: string; label: string; placeholder?: string; required?: boolean }>
  >([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [polling, setPolling] = useState(false);
  const [pollMessage, setPollMessage] = useState('');
  const [error, setError] = useState('');
  const [pollInterval, setPollInterval] = useState(3000);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void apiFetch<{
      inputFields?: typeof inputFields;
      pollIntervalMs?: number;
    }>(
      `/api/admin/integrations/${integrationName}/setup/qr/fields`,
    ).then((data) => {
      if (data.inputFields) setInputFields(data.inputFields);
      if (data.pollIntervalMs) setPollInterval(data.pollIntervalMs);
    });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [integrationName]);

  const generateQr = async () => {
    setError('');
    try {
      const data = await apiFetch<{ dataUrl: string }>(
        `/api/admin/integrations/${integrationName}/setup/qr/generate`,
        { method: 'POST', body: JSON.stringify(inputs) },
      );
      setQrDataUrl(data.dataUrl);
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'QR generation failed');
    }
  };

  const startPolling = () => {
    setPolling(true);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const data = await apiFetch<{ done: boolean; message?: string }>(
          `/api/admin/integrations/${integrationName}/setup/qr/poll`,
        );
        if (data.message) setPollMessage(data.message);
        if (data.done) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPolling(false);
          setPollMessage(data.message || 'Paired!');
        }
      } catch {
        // Continue polling
      }
    }, pollInterval);
  };

  if (completed) {
    return <CCallout color="success">Device linked.</CCallout>;
  }

  return (
    <div>
      {inputFields.map((f) => (
        <div key={f.key} className="mb-3">
          <CFormLabel>
            {f.label}
            {f.required && <span className="text-danger ms-1">*</span>}
          </CFormLabel>
          <CFormInput
            placeholder={f.placeholder}
            value={inputs[f.key] || ''}
            onChange={(e) =>
              setInputs({ ...inputs, [f.key]: e.target.value })
            }
          />
        </div>
      ))}

      {!qrDataUrl ? (
        <CButton color="primary" onClick={generateQr}>
          Generate QR Code
        </CButton>
      ) : (
        <div className="text-center">
          <img
            src={qrDataUrl}
            alt="QR Code"
            style={{ maxWidth: 280, background: '#fff', padding: 8, borderRadius: 8 }}
          />
          {polling && (
            <div className="mt-2 d-flex align-items-center justify-content-center gap-2">
              <CSpinner size="sm" />
              <span className="text-body-secondary small">
                Waiting for pairing...
              </span>
            </div>
          )}
          {pollMessage && (
            <CCallout color="success" className="mt-2 py-1 px-2 small">
              {pollMessage}
            </CCallout>
          )}
        </div>
      )}

      {error && (
        <CCallout color="danger" className="mt-2 py-1 px-2 small">
          {error}
        </CCallout>
      )}
    </div>
  );
}
