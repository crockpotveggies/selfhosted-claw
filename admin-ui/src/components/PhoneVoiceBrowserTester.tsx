import { useEffect, useRef, useState } from 'react';
import {
  CButton,
  CButtonGroup,
  CCallout,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CFormLabel,
  CFormInput,
  CFormTextarea,
  CRow,
  CSpinner,
} from '@coreui/react';

import { apiFetch } from '../admin/api';
import { PhoneVoicePhoneCallTester } from './PhoneVoicePhoneCallTester';

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
  // `action` events produced by the voice runner carry a free-form args
  // payload. For `tool_use` in particular we want to render the tool name +
  // arguments inline in the transcript.
  args?: Record<string, unknown>;
}

interface BrowserVoiceSessionStartResponse {
  sessionId: string;
  events: BrowserVoiceSessionEvent[];
}

interface BrowserVoicePrepareResponse {
  ok: true;
  health?: {
    ready?: boolean;
  };
}

interface TranscriptEntry {
  role: 'caller' | 'assistant' | 'system';
  text: string;
  timestamp: string;
}

type TesterMode = 'browser' | 'phone';

const TARGET_SAMPLE_RATE = 16000;
const VAD_RMS_THRESHOLD = 0.018;
const END_OF_TURN_SILENCE_MS = 700;

async function playAudioEvents(
  events: BrowserVoiceSessionEvent[],
): Promise<boolean> {
  let playedAudio = false;
  for (const event of events) {
    if (
      event.type !== 'assistant_audio' ||
      !event.dataBase64 ||
      !event.contentType?.startsWith('audio/')
    ) {
      continue;
    }
    const audio = new Audio(
      `data:${event.contentType};base64,${event.dataBase64}`,
    );
    playedAudio = true;
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      void audio.play().catch(() => resolve());
    });
  }
  return playedAudio;
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
      // Special-case tool_use so the transcript shows
      //   Tool: web_search({"query":"toronto weather"})
      // instead of the generic
      //   Action: tool_use (LLM invoked tool web_search)
      if (event.action === 'tool_use' && event.args) {
        const toolName =
          typeof event.args.tool === 'string' ? event.args.tool : 'unknown';
        const toolArgs =
          event.args.arguments !== undefined
            ? JSON.stringify(event.args.arguments)
            : '';
        next.push({
          role: 'system',
          text: `Tool: ${toolName}(${toolArgs})`,
          timestamp: event.timestamp,
        });
      } else {
        next.push({
          role: 'system',
          text: `Action: ${event.action}${event.text ? ` (${event.text})` : ''}`,
          timestamp: event.timestamp,
        });
      }
    }
  }
  return next;
}

function buildStreamUrl(sessionId: string): string {
  const loc = window.location;
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = window.localStorage.getItem('admin-ui-token') || '';
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${loc.host}/api/admin/integrations/phone-voice/browser/${encodeURIComponent(sessionId)}/stream${tokenParam}`;
}

interface TranscriptPanelProps {
  transcript: TranscriptEntry[];
  emptyMessage: string;
}

function TranscriptPanel({ transcript, emptyMessage }: TranscriptPanelProps) {
  return (
    <div
      className="border rounded p-3"
      style={{ maxHeight: 280, overflowY: 'auto' }}
    >
      {transcript.length === 0 ? (
        <p className="text-body-secondary small mb-0">{emptyMessage}</p>
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
  );
}

interface BrowserControlsProps {
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptEntry[]>>;
  // Shared fields lifted to parent so both testers use the same inputs.
  receivingPerson: string;
  reason: string;
}

function BrowserControls({
  setTranscript,
  receivingPerson,
  reason,
}: BrowserControlsProps) {
  const [sessionId, setSessionId] = useState('');
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [connectingAudio, setConnectingAudio] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [error, setError] = useState('');

  const sessionIdRef = useRef('');
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserBufferRef = useRef<Float32Array | null>(null);
  const analyserFrameRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReadyRef = useRef(false);
  const hasSpeechInTurnRef = useRef(false);
  const lastSpeechAtRef = useRef<number | null>(null);
  const endOfTurnQueuedRef = useRef(false);
  const audioPlaybackRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const handleEvents = (events: BrowserVoiceSessionEvent[]) => {
    if (!events.length) return;
    setTranscript((current) => appendTranscriptEvents(current, events));
    // Only F5-TTS audio from the server is played. The older
    // `window.speechSynthesis` fallback was racing with F5 audio on
    // assistant_turn text events, producing two overlapping voices.
    audioPlaybackRef.current = audioPlaybackRef.current
      .then(async () => {
        await playAudioEvents(events);
      })
      .catch(() => undefined);
  };

  const sendWsJson = (payload: unknown): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  };

  const queueEndOfTurn = (): void => {
    if (!wsReadyRef.current) return;
    hasSpeechInTurnRef.current = false;
    lastSpeechAtRef.current = null;
    endOfTurnQueuedRef.current = true;
    sendWsJson({ type: 'end_of_turn' });
    endOfTurnQueuedRef.current = false;
  };

  const openStreamSocket = (targetSessionId: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(buildStreamUrl(targetSessionId));
      ws.binaryType = 'arraybuffer';
      let settled = false;
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        ws.send(
          JSON.stringify({ type: 'start', sampleRateHz: TARGET_SAMPLE_RATE }),
        );
        wsReadyRef.current = true;
        resolve(ws);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        reject(new Error('voice_ws_failed'));
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const parsed = JSON.parse(event.data) as
            | BrowserVoiceSessionEvent
            | { type: 'error'; message?: string };
          if ((parsed as { type: string }).type === 'error') {
            setError(
              (parsed as { message?: string }).message || 'Voice stream error',
            );
            return;
          }
          handleEvents([parsed as BrowserVoiceSessionEvent]);
        } catch {
          // ignore malformed server frame
        }
      };
      ws.onclose = () => {
        wsReadyRef.current = false;
      };
    });

  const stopStreamingAudio = async (): Promise<void> => {
    if (analyserFrameRef.current !== null) {
      cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }

    const worklet = workletRef.current;
    workletRef.current = null;
    if (worklet) {
      worklet.port.onmessage = null;
      try {
        worklet.disconnect();
      } catch {
        // ignore
      }
    }

    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current = null;
    analyserBufferRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (audioContextRef.current) {
      await audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }

    hasSpeechInTurnRef.current = false;
    lastSpeechAtRef.current = null;
    endOfTurnQueuedRef.current = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setStreaming(false);
  };

  const closeSocket = (reason: 'end' | 'abort'): void => {
    const ws = wsRef.current;
    wsRef.current = null;
    wsReadyRef.current = false;
    if (!ws) return;
    if (reason === 'end' && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'end' }));
      } catch {
        // ignore
      }
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    return () => {
      closeSocket('abort');
      void stopStreamingAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      setPreparing(true);
      try {
        const response = await apiFetch<BrowserVoicePrepareResponse>(
          '/api/admin/integrations/phone-voice/browser-session/prepare',
          { method: 'POST' },
        );
        if (cancelled) return;
        setPrepared(response.health?.ready !== false);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : 'Browser voice runtime preparation failed',
        );
      } finally {
        if (!cancelled) {
          setPreparing(false);
        }
      }
    };
    void prepare();
    return () => {
      cancelled = true;
    };
  }, []);

  const startStreamingAudio = async (
    targetSessionId: string,
  ): Promise<void> => {
    if (streaming || connectingAudio) return;
    setConnectingAudio(true);
    setError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule('/audio/pcm-worklet.js');

      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioContext, 'pcm-worklet', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      const analyserBuffer = new Float32Array(analyser.fftSize);
      source.connect(analyser);
      source.connect(worklet);

      const ws = await openStreamSocket(targetSessionId);
      wsRef.current = ws;

      worklet.port.onmessage = (event) => {
        const buffer = event.data as ArrayBuffer;
        if (!buffer || !wsReadyRef.current) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(buffer);
        } catch {
          // ignore
        }
      };

      const tick = () => {
        const nextAnalyser = analyserRef.current;
        const nextBuffer = analyserBufferRef.current;
        if (!nextAnalyser || !nextBuffer) return;
        nextAnalyser.getFloatTimeDomainData(
          nextBuffer as Float32Array<ArrayBuffer>,
        );
        let sumSquares = 0;
        for (const sample of nextBuffer) {
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / Math.max(nextBuffer.length, 1));
        const now = Date.now();

        if (rms >= VAD_RMS_THRESHOLD) {
          hasSpeechInTurnRef.current = true;
          lastSpeechAtRef.current = now;
          if (
            typeof window !== 'undefined' &&
            'speechSynthesis' in window &&
            window.speechSynthesis.speaking
          ) {
            window.speechSynthesis.cancel();
          }
        } else if (
          hasSpeechInTurnRef.current &&
          lastSpeechAtRef.current &&
          now - lastSpeechAtRef.current >= END_OF_TURN_SILENCE_MS &&
          !endOfTurnQueuedRef.current
        ) {
          queueEndOfTurn();
        }

        analyserFrameRef.current = requestAnimationFrame(tick);
      };

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      analyserRef.current = analyser;
      analyserBufferRef.current = analyserBuffer;
      workletRef.current = worklet;

      analyserFrameRef.current = requestAnimationFrame(tick);

      setStreaming(true);
    } catch (err) {
      await stopStreamingAudio();
      closeSocket('abort');
      setError(err instanceof Error ? err.message : 'Microphone access failed');
    } finally {
      setConnectingAudio(false);
    }
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
          body: JSON.stringify({
            // Treat the receiving-person field as the caller's display name
            // so the agent sees "Hi, I'm <person>" in its system prompt.
            displayName: receivingPerson.trim() || 'Browser Tester',
            reason: reason.trim() || undefined,
            receivingPerson: receivingPerson.trim() || undefined,
          }),
        },
      );
      sessionIdRef.current = started.sessionId;
      setSessionId(started.sessionId);
      setPrepared(true);
      // Any events produced synchronously during startBrowserVoiceSession
      // (e.g. the initial greeting) were already drained into the HTTP
      // response. Render them here; the WS subscription only receives
      // events produced after the socket opens.
      handleEvents(started.events);
      await startStreamingAudio(started.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Start failed');
    } finally {
      setStarting(false);
    }
  };

  const endSession = async () => {
    if (!sessionIdRef.current) return;
    setEnding(true);
    setError('');
    try {
      queueEndOfTurn();
      closeSocket('end');
      await apiFetch<{ ok: true }>(
        `/api/admin/integrations/phone-voice/browser-session/${encodeURIComponent(
          sessionIdRef.current,
        )}/end`,
        { method: 'POST' },
      );
      sessionIdRef.current = '';
      setSessionId('');
      await stopStreamingAudio();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'End failed');
    } finally {
      setEnding(false);
    }
  };

  const browserSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window !== 'undefined' &&
    typeof window.AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebSocket !== 'undefined';

  return (
    <div>
      {!browserSupported && (
        <CCallout color="warning" className="py-2 px-3 small">
          This browser does not expose the microphone APIs (AudioWorklet,
          WebSocket, MediaDevices) needed for live duplex voice testing.
        </CCallout>
      )}
      <div className="d-flex flex-wrap gap-2 mb-2">
        {!sessionId ? (
          <CButton
            color="primary"
            onClick={() => void startSession()}
            disabled={starting || preparing || !prepared || !browserSupported}
          >
            {starting ? 'Starting...' : 'Start Browser Call'}
          </CButton>
        ) : (
          <CButton
            color="secondary"
            variant="outline"
            onClick={() => void endSession()}
            disabled={ending}
          >
            {ending ? 'Ending...' : 'End Call'}
          </CButton>
        )}
        {(connectingAudio || starting || preparing) && (
          <span className="small text-body-secondary d-inline-flex align-items-center gap-2">
            <CSpinner size="sm" />
            {preparing
              ? 'Prewarming runtime...'
              : 'Bringing voice path online...'}
          </span>
        )}
      </div>
      {!sessionId && prepared && !preparing && (
        <CCallout color="success" className="py-2 px-3 small">
          Browser voice runtime is hot. Starting the call should be near-instant.
        </CCallout>
      )}
      {sessionId && (
        <CCallout
          color={streaming ? 'success' : 'warning'}
          className="py-2 px-3 small"
        >
          {streaming
            ? 'Live duplex call active. Speak naturally.'
            : 'Session up, microphone not yet streaming.'}
        </CCallout>
      )}
      {error && (
        <CCallout color="danger" className="py-2 px-3 small">
          {error}
        </CCallout>
      )}
      {sessionId && (
        <p className="small text-body-secondary mb-0">
          Session: <code>{sessionId}</code>
        </p>
      )}
    </div>
  );
}

export function PhoneVoiceBrowserTester() {
  const [mode, setMode] = useState<TesterMode>('browser');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  // Shared context fields — identical across Browser and Phone-Call testers.
  const [reason, setReason] = useState('');
  const [receivingPerson, setReceivingPerson] = useState('');

  const transcriptEmpty =
    mode === 'browser'
      ? 'No voice turns yet.'
      : 'Transcript will appear here when a browser test session is running.';

  return (
    <CCard className="mb-3">
      <CCardHeader>
        <strong>Voice Test</strong>
      </CCardHeader>
      <CCardBody>
        <div className="mb-3">
          <TranscriptPanel
            transcript={transcript}
            emptyMessage={transcriptEmpty}
          />
        </div>

        <div className="mb-3">
          <CButtonGroup role="group" aria-label="Voice test mode">
            <CButton
              color="primary"
              variant={mode === 'browser' ? undefined : 'outline'}
              onClick={() => setMode('browser')}
            >
              Browser Test
            </CButton>
            <CButton
              color="primary"
              variant={mode === 'phone' ? undefined : 'outline'}
              onClick={() => setMode('phone')}
            >
              Phone Call Test
            </CButton>
          </CButtonGroup>
        </div>

        <CRow className="g-3">
          <CCol xs={12} md={4}>
            <CFormLabel htmlFor="phone-voice-shared-reason">
              Reason for calling
            </CFormLabel>
            <CFormTextarea
              id="phone-voice-shared-reason"
              rows={6}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. dog bath appointment; asking about the quote you sent"
            />
            <div className="form-text small">
              Added to the agent's context so it can explain why it's calling.
              Applies to both test modes.
            </div>
          </CCol>

          <CCol xs={12} md={4}>
            <CFormLabel htmlFor="phone-voice-shared-person">
              Name of person
            </CFormLabel>
            <CFormInput
              id="phone-voice-shared-person"
              type="text"
              value={receivingPerson}
              onChange={(event) => setReceivingPerson(event.target.value)}
              placeholder="Alice Smith"
            />
            <div className="form-text small">
              Who the agent is calling (phone mode) or who's calling in (browser
              mode).
            </div>
          </CCol>

          <CCol xs={12} md={4}>
            {mode === 'browser' ? (
              <BrowserControls
                setTranscript={setTranscript}
                receivingPerson={receivingPerson}
                reason={reason}
              />
            ) : (
              <PhoneVoicePhoneCallTester
                reason={reason}
                receivingPerson={receivingPerson}
              />
            )}
          </CCol>
        </CRow>
      </CCardBody>
    </CCard>
  );
}
