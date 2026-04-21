export type VoiceTinyActionName =
  | 'end_call'
  | 'set_mute'
  | 'send_dtmf'
  | 'mark_followup'
  | 'place_call';

export type VoiceHandoffKind =
  | 'followup_summary'
  | 'task_request'
  | 'send_message_later'
  | 'create_note'
  | 'needs_controller_attention';

export interface VoiceCaller {
  phoneNumber: string;
  displayName: string;
  profileSummary?: string;
  relationshipHint?: string;
  reasonForCall?: string;
  expectedRecipient?: string;
}

export interface VoiceCallMetadata {
  callId: string;
  direction?: 'incoming' | 'outgoing' | 'unknown';
  state?: string;
  startedAt: string;
}

export interface VoiceRunnerSessionStart {
  sessionId: string;
  chatJid: string;
  caller: VoiceCaller;
  metadata: VoiceCallMetadata;
  greeting?: string;
}

export interface VoiceRunnerSessionUpdate {
  sessionId: string;
  metadata?: Partial<VoiceCallMetadata>;
  caller?: Partial<VoiceCaller>;
}

export interface VoiceTranscriptPartial {
  sessionId: string;
  text: string;
  timestamp: string;
}

export interface VoiceTranscriptFinal {
  sessionId: string;
  text: string;
  timestamp: string;
  confidence?: number;
  source?: 'gateway' | 'stt';
}

export interface VoiceAudioInputChunk {
  sessionId: string;
  dataBase64: string;
  contentType: string;
  timestamp: string;
  sampleRateHz?: number;
  channels?: number;
  endOfTurn?: boolean;
}

export interface VoiceResponseTextDelta {
  sessionId: string;
  text: string;
  timestamp: string;
}

export interface VoiceResponseAudioDelta {
  sessionId: string;
  dataBase64: string;
  contentType: string;
  timestamp: string;
  text?: string;
}

export interface VoiceResponseCancel {
  sessionId: string;
  reason: 'barge_in' | 'session_end' | 'manual' | 'restart';
  timestamp: string;
}

export interface VoiceActionRequest {
  sessionId: string;
  action: VoiceTinyActionName;
  args?: Record<string, unknown>;
  reason?: string;
  timestamp: string;
}

export interface VoiceHandoffRequest {
  id: string;
  kind: VoiceHandoffKind;
  caller: VoiceCaller;
  sessionId: string;
  summary: string;
  requestedAction?: string;
  priority: 'low' | 'normal' | 'high';
  contextSnippet?: string;
  createdAt: string;
}

export interface VoiceLatencySample {
  sessionId: string;
  speechDetectedAt?: string;
  responseCancelledAt?: string;
  userSpeechFinalAt?: string;
  firstModelTextAt?: string;
  firstAudioOutAt?: string;
  responseCompletedAt?: string;
}

export interface VoiceRunnerCallbacks {
  onTranscriptPartial?: (event: VoiceTranscriptPartial) => void;
  onTranscriptFinal?: (event: VoiceTranscriptFinal) => Promise<void> | void;
  onResponseTextDelta?: (event: VoiceResponseTextDelta) => void;
  onResponseAudioDelta?: (event: VoiceResponseAudioDelta) => void;
  onResponseCancel?: (event: VoiceResponseCancel) => void;
  onActionRequest?: (event: VoiceActionRequest) => Promise<void> | void;
  onHandoffEnqueue?: (event: VoiceHandoffRequest) => Promise<void> | void;
  onFinalizedAgentTurn?: (event: {
    sessionId: string;
    text: string;
    timestamp: string;
  }) => Promise<void> | void;
  onLatencySample?: (sample: VoiceLatencySample) => void;
}

export interface VoiceRunnerHealth {
  ready: boolean;
  sessions: number;
  backend: string;
  mode?: 'sidecar' | 'in_process';
  pid?: number;
  warmedAt?: string;
  lastError?: string;
}

export type VoiceRunnerSidecarAction =
  | 'configure'
  | 'warm'
  | 'health'
  | 'session.start'
  | 'session.update'
  | 'session.idle'
  | 'audio.input'
  | 'transcript.partial'
  | 'transcript.final'
  | 'session.end'
  | 'shutdown';

export interface VoiceRunnerSidecarRequest {
  kind: 'request';
  id: string;
  action: VoiceRunnerSidecarAction;
  payload?: Record<string, unknown>;
}

export interface VoiceRunnerSidecarResponse {
  kind: 'response';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

export type VoiceRunnerSidecarEventName =
  | 'transcript.partial'
  | 'transcript.final'
  | 'response.text.delta'
  | 'response.audio.delta'
  | 'response.cancel'
  | 'action.request'
  | 'handoff.enqueue'
  | 'finalized.agent.turn'
  | 'latency.sample';

export interface VoiceRunnerSidecarEvent {
  kind: 'event';
  event: VoiceRunnerSidecarEventName;
  payload: Record<string, unknown>;
}
