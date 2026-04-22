#!/usr/bin/env node
// End-to-end smoke test for voice-runner tool calling against a live OpenArc.
// Fires a prompt that should trigger the web_search tool, prints the full turn
// cycle to stdout. Run after `npm run build` so the compiled JS is available.
//
//   node scripts/voice-tools-smoke.mjs
//
// Environment:
//   VOICE_SMOKE_PROMPT    override the user prompt (default: weather query)
//   VOICE_SMOKE_BASE_URL  override the OpenArc base URL
//   VOICE_SMOKE_API_KEY   override the OpenArc bearer token

import { VoiceRunnerService } from '../dist/voice-runner/live-runner.js';

const prompt =
  process.env.VOICE_SMOKE_PROMPT ||
  'What is the current weather in Toronto? I want a short answer.';

const baseUrl =
  process.env.VOICE_SMOKE_BASE_URL || 'http://127.0.0.1:8793/v1';
const apiKey =
  process.env.VOICE_SMOKE_API_KEY || 'phone-voice-local-openarc';

console.log(`[smoke] OpenArc: ${baseUrl}`);
console.log(`[smoke] Prompt : ${prompt}`);
console.log('');

const runner = new VoiceRunnerService({
  voiceRunnerProvider: 'managed_openarc',
  voiceRunnerBaseUrl: baseUrl,
  voiceRunnerApiKey: apiKey,
  voiceRunnerModel: 'phone-voice-qwen3-4b',
  voiceSttProvider: 'mock',
  voiceTtsProvider: 'mock',
});

const timeline = [];
const record = (label, payload) => {
  timeline.push({ at: new Date().toISOString(), label, payload });
  console.log(`[${label}]`, JSON.stringify(payload));
};

await runner.startSession(
  {
    sessionId: 'smoke-1',
    chatJid: 'voice:+15550000000',
    caller: { phoneNumber: '+15550000000', displayName: 'Smoke Tester' },
    metadata: {
      callId: 'smoke-call-1',
      startedAt: new Date().toISOString(),
      state: 'active',
      direction: 'incoming',
    },
  },
  {
    onTranscriptFinal: async (event) => record('transcript.final', event),
    onResponseAudioDelta: (event) =>
      record('response.audio.delta', {
        textPreview: (event.text || '').slice(0, 120),
        contentType: event.contentType,
      }),
    onActionRequest: async (event) => record('action', event),
    onFinalizedAgentTurn: async (event) =>
      record('finalized.agent.turn', event),
  },
);

const started = Date.now();
await runner.handleTranscriptFinal({
  sessionId: 'smoke-1',
  text: prompt,
  timestamp: new Date().toISOString(),
});
const elapsed = Date.now() - started;

console.log('');
console.log(`[smoke] Turn completed in ${elapsed}ms`);
console.log(`[smoke] Events: ${timeline.length}`);
const toolInvocations = timeline.filter(
  (e) => e.label === 'action' && e.payload.action === 'tool_use',
);
console.log(`[smoke] Tool invocations: ${toolInvocations.length}`);
for (const t of toolInvocations) {
  console.log(`[smoke]   -> ${t.payload.args?.tool}(${JSON.stringify(t.payload.args?.arguments)})`);
}
const finalTurn = timeline.filter((e) => e.label === 'finalized.agent.turn');
console.log(
  `[smoke] Final spoken reply: ${finalTurn[0]?.payload?.text || '(none)'}`,
);

process.exit(toolInvocations.length > 0 && finalTurn.length > 0 ? 0 : 2);
