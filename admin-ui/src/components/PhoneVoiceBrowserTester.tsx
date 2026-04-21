import { useEffect, useRef, useState } from 'react';
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

function speakText(text: string): Promise<void> {
  if (
    typeof window === 'undefined' ||
    !('speechSynthesis' in window) ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
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

function buildStreamUrl(sessionId: string): string {
  const loc = window.location;
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = window.localStorage.getItem('admin-ui-token') || '';
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${loc.host}/api/admin/integrations/phone-voice/browser/${encodeURIComponent(sessionId)}/stream${tokenParam}`;
}

export function PhoneVoiceBrowserTester() {
  const [displayName, setDisplayName] = useState('Browser Tester');
  const [sessionId, setSessionId] = useState('');
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [connectingAudio, setConnectingAudio] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

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
          body: JSON.stringify({ displayName }),
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
    <CCard className="mb-3">
      <CCardHeader>
        <strong>Browser Voice Test</strong>
      </CCardHeader>
      <CCardBody>
        <p className="text-body-secondary small mb-3">
          Start a live browser call against the voice runner. Audio streams as
          raw PCM16 over a WebSocket to the streaming STT server; end-of-turn
          is detected from silence, and the same socket receives transcript
          and TTS events in real time.
        </p>
        {!browserSupported && (
          <CCallout color="warning" className="py-2 px-3 small">
            This browser does not expose the microphone APIs (AudioWorklet,
            WebSocket, MediaDevices) needed for live duplex voice testing.
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
                ? 'Prewarming the browser voice runtime...'
                : 'Bringing the live voice path online...'}
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
              ? 'Live duplex call active. Speak naturally; PCM16 is streaming over the socket.'
              : 'Session is up, but the microphone stream is not active yet.'}
          </CCallout>
        )}
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
