import { useEffect, useState } from 'react';
import { CAlert, CButton, CFormInput, CFormLabel, CSpinner } from '@coreui/react';

import { apiFetch } from '../admin/api';

interface OutboundCallTestResponse {
  sessionId?: string;
  callId?: string;
  error?: string;
}

interface SuccessState {
  phoneNumber: string;
  receivingPerson: string;
}

interface PhoneCallControlsProps {
  // Shared fields come from the parent so both testers use the same inputs.
  reason: string;
  receivingPerson: string;
}

const DTMF_KEYS: string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
// 10 minutes — safe upper bound so controls don't stay enabled forever after a call drops.
const ACTIVE_CALL_TIMEOUT_MS = 10 * 60 * 1000;

export function PhoneVoicePhoneCallTester({
  reason,
  receivingPerson,
}: PhoneCallControlsProps) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<SuccessState | null>(null);

  const [activeCallPlacedAt, setActiveCallPlacedAt] = useState<number | null>(
    null,
  );
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [controlError, setControlError] = useState('');
  const [controlNotice, setControlNotice] = useState('');
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [endingCall, setEndingCall] = useState(false);

  const callActive = activeCallPlacedAt !== null;

  useEffect(() => {
    if (activeCallPlacedAt === null) return;
    const remaining =
      ACTIVE_CALL_TIMEOUT_MS - (Date.now() - activeCallPlacedAt);
    if (remaining <= 0) {
      setActiveCallPlacedAt(null);
      setActiveCallId(null);
      return;
    }
    const timer = setTimeout(() => {
      setActiveCallPlacedAt(null);
      setActiveCallId(null);
    }, remaining);
    return () => clearTimeout(timer);
  }, [activeCallPlacedAt]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setSuccess(null);
    setControlError('');
    setControlNotice('');
    try {
      const response = await apiFetch<OutboundCallTestResponse>(
        '/api/admin/integrations/phone-voice/outbound-call-test',
        {
          method: 'POST',
          body: JSON.stringify({
            phoneNumber: phoneNumber.trim(),
            reason: reason.trim(),
            receivingPerson: receivingPerson.trim(),
          }),
        },
      );
      if (response.error) {
        setError(response.error);
      } else {
        setSuccess({
          phoneNumber: phoneNumber.trim(),
          receivingPerson: receivingPerson.trim(),
        });
        setActiveCallPlacedAt(Date.now());
        setActiveCallId(response.callId ?? null);
        setMuted(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Call failed');
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    phoneNumber.trim().length > 0 && receivingPerson.trim().length > 0;

  const endCall = async () => {
    if (!callActive) return;
    setEndingCall(true);
    setControlError('');
    setControlNotice('');
    try {
      const resp = await apiFetch<{ ok?: boolean; error?: string }>(
        '/api/admin/integrations/phone-voice/call/end',
        {
          method: 'POST',
          body: JSON.stringify(activeCallId ? { callId: activeCallId } : {}),
        },
      );
      if (resp.error) {
        setControlError(resp.error);
      } else {
        setControlNotice('Call ended.');
        setActiveCallPlacedAt(null);
        setActiveCallId(null);
        setMuted(false);
      }
    } catch (err) {
      setControlError(err instanceof Error ? err.message : 'End call failed');
    } finally {
      setEndingCall(false);
    }
  };

  const sendDtmf = (digit: string) => {
    if (!callActive) return;
    setPressedKey(digit);
    setControlError('');
    setControlNotice('');
    // Fire-and-forget: keypad feedback should feel instant. Errors still surface.
    void apiFetch<{ ok?: boolean; error?: string }>(
      '/api/admin/integrations/phone-voice/call/dtmf',
      {
        method: 'POST',
        body: JSON.stringify(
          activeCallId ? { digit, callId: activeCallId } : { digit },
        ),
      },
    )
      .then((resp) => {
        if (resp.error) setControlError(resp.error);
      })
      .catch((err) => {
        setControlError(err instanceof Error ? err.message : 'DTMF failed');
      });
    setTimeout(() => {
      setPressedKey((current) => (current === digit ? null : current));
    }, 180);
  };

  const toggleMute = async () => {
    if (!callActive) return;
    const next = !muted;
    setControlError('');
    setControlNotice('');
    try {
      const resp = await apiFetch<{ ok?: boolean; error?: string }>(
        '/api/admin/integrations/phone-voice/call/mute',
        {
          method: 'POST',
          body: JSON.stringify(
            activeCallId
              ? { muted: next, callId: activeCallId }
              : { muted: next },
          ),
        },
      );
      if (resp.error) {
        setControlError(resp.error);
      } else {
        setMuted(next);
      }
    } catch (err) {
      setControlError(err instanceof Error ? err.message : 'Mute failed');
    }
  };

  return (
    <div className="d-flex flex-column gap-3">
      <form onSubmit={(event) => void submit(event)}>
        <CFormLabel htmlFor="phone-voice-call-number">Phone number</CFormLabel>
        <CFormInput
          id="phone-voice-call-number"
          type="tel"
          placeholder="+15551234567"
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value)}
          disabled={submitting}
          required
        />
        <div className="d-flex align-items-center gap-2 mt-2">
          <CButton
            type="submit"
            color="primary"
            disabled={submitting || !canSubmit}
          >
            {submitting ? 'Placing call...' : 'Place test call'}
          </CButton>
          {submitting && <CSpinner size="sm" />}
        </div>
        {error && (
          <CAlert color="danger" className="mt-2 py-2 px-3 small mb-0">
            {error}
          </CAlert>
        )}
        {success && (
          <CAlert color="success" className="mt-2 py-2 px-3 small mb-0">
            Call placed to {success.phoneNumber}. Agent will wait for{' '}
            {success.receivingPerson}, then introduce itself.
          </CAlert>
        )}
      </form>

      <div className="border rounded p-3">
        <div className="fw-semibold mb-2">Call controls</div>

        <CButton
          color="danger"
          className="w-100 mb-3"
          onClick={() => void endCall()}
          disabled={!callActive || endingCall}
        >
          {endingCall ? 'Ending...' : 'End Call'}
        </CButton>

        <div className="small text-body-secondary mb-2">DTMF keypad</div>
        <div
          className="d-grid gap-2 mb-3"
          style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}
        >
          {DTMF_KEYS.map((key) => (
            <CButton
              key={key}
              color={pressedKey === key ? 'primary' : 'secondary'}
              variant={pressedKey === key ? undefined : 'outline'}
              onClick={() => sendDtmf(key)}
              disabled={!callActive}
              style={{ fontSize: '1.25rem', padding: '0.75rem 0' }}
            >
              {key}
            </CButton>
          ))}
        </div>

        <CButton
          color={muted ? 'warning' : 'secondary'}
          variant={muted ? undefined : 'outline'}
          className="w-100 mb-2"
          onClick={() => void toggleMute()}
          disabled={!callActive}
        >
          {muted ? 'Unmute' : 'Mute'}
        </CButton>

        {controlError && (
          <CAlert color="danger" className="py-2 px-3 small mb-2 mt-2">
            {controlError}
          </CAlert>
        )}
        {controlNotice && !controlError && (
          <CAlert color="success" className="py-2 px-3 small mb-2 mt-2">
            {controlNotice}
          </CAlert>
        )}

        <div className="form-text small mt-2">
          Controls are active while you've placed a test call here.
        </div>
      </div>
    </div>
  );
}
