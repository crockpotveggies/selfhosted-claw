import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CButton,
  CCallout,
  CCard,
  CCardBody,
  CCardHeader,
  CFormInput,
  CFormLabel,
  CSpinner,
} from '@coreui/react';

import { apiFetch } from '../admin/api';

interface BrowserVoiceSessionEvent {
  type:
    | 'caller_turn'
    | 'assistant_turn'
    | 'assistant_audio'
    | 'handoff'
    | 'action';
  text?: string;
  contentType?: string;
  dataBase64?: string;
  timestamp: string;
  action?: string;
  summary?: string;
}

interface BrowserVoiceSessionStartResponse {
  sessionId: string;
  events: BrowserVoiceSessionEvent[];
}

interface BrowserVoiceSessionTurnResponse {
  events: BrowserVoiceSessionEvent[];
}

interface TranscriptEntry {
  role: 'caller' | 'assistant' | 'system';
  text: string;
  timestamp: string;
}

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  return (
    candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ||
    ''
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read_failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

async function playAudioEvents(events: BrowserVoiceSessionEvent[]): Promise<void> {
  for (const event of events) {
    if (
      event.type !== 'assistant_audio' ||
      !event.dataBase64 ||
      !event.contentType?.startsWith('audio/')
    ) {
      continue;
    }
    const audio = new Audio(`data:${event.contentType};base64,${event.dataBase64}`);
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      void audio.play().catch(() => resolve());
    });
  }
}

function appendTranscriptEvents(
  current: TranscriptEntry[],
  events: BrowserVoiceSessionEvent[],
): TranscriptEntry[] {
  const next = [...current];
  for (const event of events) {
    if (event.type === 'caller_turn' && event.text) {
      next.push({
        role: 'caller',
        text: event.text,
        timestamp: event.timestamp,
      });
    } else if (event.type === 'assistant_turn' && event.text) {
      next.push({
        role: 'assistant',
        text: event.text,
        timestamp: event.timestamp,
      });
    } else if (event.type === 'handoff' && (event.summary || event.text)) {
      next.push({
        role: 'system',
        text: `Deferred: ${event.summary || event.text}`,
        timestamp: event.timestamp,
      });
    } else if (event.type === 'action' && event.action) {
      next.push({
        role: 'system',
        text: `Action: ${event.action}${event.text ? ` (${event.text})` : ''}`,
        timestamp: event.timestamp,
      });
    }
  }
  return next;
}

export function PhoneVoiceBrowserTester() {
  const [displayName, setDisplayName] = useState('Browser Tester');
  const [sessionId, setSessionId] = useState('');
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recorderMimeType = useMemo(() => pickRecorderMimeType(), []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const handleEvents = async (events: BrowserVoiceSessionEvent[]) => {
    setTranscript((current) => appendTranscriptEvents(current, events));
    await playAudioEvents(events);
  };

  const startSession = async () => {
    setStarting(true);
    setError('');
    setTranscript([]);
    try {
      const started = await apiFetch<BrowserVoiceSessionStartResponse>(
        '/api/admin/integrations/phone-voice/browser-session/start',
        {
          method: 'POST',
          body: JSON.stringify({ displayName }),
        },
      );
      setSessionId(started.sessionId);
      await handleEvents(started.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Start failed');
    } finally {
      setStarting(false);
    }
  };

  const endSession = async () => {
    if (!sessionId) return;
    setEnding(true);
    setError('');
    try {
      await apiFetch<{ ok: true }>(
        `/api/admin/integrations/phone-voice/browser-session/${encodeURIComponent(sessionId)}/end`,
        { method: 'POST' },
      );
      setSessionId('');
      setRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'End failed');
    } finally {
      setEnding(false);
    }
  };

  const startRecording = async () => {
    if (!sessionId || recording || sending) return;
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = recorderMimeType
        ? new MediaRecorder(stream, { mimeType: recorderMimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        void sendRecording(blob);
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Microphone access failed',
      );
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    setRecording(false);
    recorder.stop();
  };

  const sendRecording = async (blob: Blob) => {
    if (!sessionId || blob.size === 0) return;
    setSending(true);
    setError('');
    try {
      const dataBase64 = await blobToBase64(blob);
      const response = await apiFetch<BrowserVoiceSessionTurnResponse>(
        `/api/admin/integrations/phone-voice/browser-session/${encodeURIComponent(sessionId)}/audio`,
        {
          method: 'POST',
          body: JSON.stringify({
            dataBase64,
            contentType: blob.type || 'audio/webm',
          }),
        },
      );
      await handleEvents(response.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice turn failed');
    } finally {
      setSending(false);
    }
  };

  const browserSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';

  return (
    <CCard className="mb-3">
      <CCardHeader>
        <strong>Browser Voice Test</strong>
      </CCardHeader>
      <CCardBody>
        <p className="text-body-secondary small mb-3">
          Start a local push-to-talk voice session against the live runner. This
          stays in the browser and sidecar, which makes it great for testing and
          terrible for pretending you made a phone call.
        </p>
        {!browserSupported && (
          <CCallout color="warning" className="py-2 px-3 small">
            This browser does not expose the microphone recording APIs needed for
            local voice testing.
          </CCallout>
        )}
        <div className="mb-3">
          <CFormLabel htmlFor="phone-voice-browser-display-name">
            Caller Display Name
          </CFormLabel>
          <CFormInput
            id="phone-voice-browser-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={Boolean(sessionId) || starting}
          />
        </div>
        <div className="d-flex flex-wrap gap-2 mb-3">
          {!sessionId ? (
            <CButton
              color="primary"
              onClick={() => void startSession()}
              disabled={starting || !browserSupported}
            >
              {starting ? 'Starting...' : 'Start Browser Session'}
            </CButton>
          ) : (
            <>
              <CButton
                color={recording ? 'danger' : 'success'}
                onClick={() =>
                  recording ? stopRecording() : void startRecording()
                }
                disabled={sending || ending}
              >
                {recording ? 'Stop Recording' : 'Record Voice Turn'}
              </CButton>
              <CButton
                color="secondary"
                variant="outline"
                onClick={() => void endSession()}
                disabled={ending || sending}
              >
                {ending ? 'Ending...' : 'End Session'}
              </CButton>
            </>
          )}
          {sending && (
            <span className="small text-body-secondary d-inline-flex align-items-center gap-2">
              <CSpinner size="sm" />
              Sending audio to the runner...
            </span>
          )}
        </div>
        {error && (
          <CCallout color="danger" className="py-2 px-3 small">
            {error}
          </CCallout>
        )}
        {sessionId && (
          <p className="small text-body-secondary mb-2">
            Session: <code>{sessionId}</code>
          </p>
        )}
        <div
          className="border rounded p-3"
          style={{ maxHeight: 280, overflowY: 'auto' }}
        >
          {transcript.length === 0 ? (
            <p className="text-body-secondary small mb-0">
              No voice turns yet.
            </p>
          ) : (
            transcript.map((entry, index) => (
              <div key={`${entry.timestamp}:${index}`} className="mb-2">
                <div className="small fw-semibold text-body-secondary">
                  {entry.role === 'caller'
                    ? 'You'
                    : entry.role === 'assistant'
                      ? 'Agent'
                      : 'System'}
                </div>
                <div>{entry.text}</div>
              </div>
            ))
          )}
        </div>
      </CCardBody>
    </CCard>
  );
}
