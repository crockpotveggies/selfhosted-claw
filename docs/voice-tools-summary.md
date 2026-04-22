# Voice-agent tool calling — session summary

Landed Option B cleanly. Voice LLM now has real OpenAI-compatible tool calling
against OpenArc, with at least one useful tool wired end-to-end. Verified live
against the running `phone-voice-qwen3-4b` model.

## TL;DR

**Ask the browser tester something like "What is the current weather in
Toronto?"** and the agent will:

1. Say "Let me check that for you." (canned ack, while the tool runs)
2. Call `web_search` via DuckDuckGo (~1 s)
3. Re-prompt OpenArc with the search results
4. Say the final answer in a natural conversational sentence

Observed end-to-end latency: **1550 ms**. Small-talk turns (no tool): **238 ms**.
All 38 voice-related tests pass. Backend + UI typecheck clean.

## Why Option B (not C)

The research initially worried that OpenArc's Qwen3-4B split-pipeline patch
would silently drop the `tools` parameter. **Not true in practice** — I tested
OpenArc directly and both streaming and non-streaming tool calls work. The
patch still routes inputs through `apply_chat_template(tools=...)` correctly,
and the downstream `parse_tool_calls` reads Hermes-style `<tool_call>` tags
from Qwen3's output. No patch modification was needed.

Option C stays available as a fallback if we ever need to offload to the big
container agent for heavier tool flows — the architecture doesn't preclude it.

## Architecture landed

### Voice-side tool registry (`src/voice-runner/voice-tools.ts`)

Dedicated registry, separate from `src/tool-registry.ts` (which targets the
container agent). Why dedicated:

- Container tools (~30 of them) include long-horizon things like scheduling
  and research-start that aren't latency-appropriate for a phone call.
- Voice tools live inside the host process, share fetch semantics with
  admin-server, zero Docker round-trips.

Default tools:

| Tool | Purpose |
|---|---|
| `web_search(query, max_results?)` | DuckDuckGo search via the existing `src/research/providers.ts` `DuckDuckGoProvider`. Returns a compact `1. Title — snippet (url)` formatted string. 8-second timeout. |
| `get_current_time()` | Wall-clock for "what day is it" / "what time is it". Synchronous. |

The registry is injectable into `VoiceRunnerService` via the new
`options.tools` constructor arg so tests don't hit the real internet.

### Tool-call loop (`src/voice-runner/live-runner.ts`)

The existing `OpenAiVoiceBackend.generateTurn` was refactored into:

- `streamOnce(...)` — consumes one SSE or JSON LLM response, returns
  `{ text, toolCalls, finishReason, rawText }`. Preserves **all existing
  behavior**: `<think>` filtering, phrase chunking, TTS emission on
  `content` deltas.
- A loop in `generateTurn()` that:
  - Builds messages with a new tool-aware system block
  - Calls `streamOnce(...)`
  - On `finish_reason: tool_calls`: emits a canned ack (only if nothing was
    streamed yet), executes each tool sequentially, appends
    assistant-with-tool_calls + tool-result messages, loops
  - On normal completion: breaks
  - Caps at `MAX_TOOL_ITERATIONS = 3` and strips `tools` from the final
    forced turn so the model MUST produce a spoken answer

Ack phrases rotate through `TOOL_ACK_PHRASES` = "Let me check that for you.",
"One moment while I look that up.", "Give me a second."

### Observability

Tool invocations are emitted as `VoiceActionRequest` events with the new
`tool_use` action name. The browser-session path forwards them to the
transcript; the admin UI renders them as:

```
Tool: web_search({"query":"toronto weather","max_results":1})
```

…instead of the generic "Action: tool_use" that would have shown up
otherwise.

### Prompt hygiene

The default instruction `"What you cannot do mid-call: browse the web, read
files, run code, or look things up in real time."` is now **stripped
automatically** when tools are available, via `stripNoLookupClause()`. Both
the exact string (fast-path) and near-rephrasings (regex fallback) are
handled. Without this, the model saw a contradiction — "you can't look
things up in real time" AND "here's a web_search tool" — and was more likely
to hallucinate instead of calling the tool.

## Files changed / added

**Backend**
- `src/voice-runner/voice-tools.ts` — new module, registry + two default tools
- `src/voice-runner/voice-tools.test.ts` — new, 8 tests
- `src/voice-runner/live-runner.ts` — refactored LLM call into tool loop,
  added `stripNoLookupClause`, `TOOL_ACK_PHRASES`, `MAX_TOOL_ITERATIONS`,
  `VoiceRunnerServiceOptions` (with `tools` injection point)
- `src/voice-runner/live-runner.test.ts` — 5 new tests covering tool
  execution, error paths, unknown tools, no-tool turn unchanged, and
  iteration cap
- `src/voice-runner/protocol.ts` — added `tool_use` to `VoiceTinyActionName`
- `src/integrations/phone-voice.ts` — forwards `args` on action events,
  extends `BrowserVoiceSessionEvent.args`
- `src/integrations/phone-voice.test.ts` — updated greeting assertion to
  match the earlier "no browser-test greeting" change

**Admin UI**
- `admin-ui/src/components/PhoneVoiceBrowserTester.tsx` — renders tool_use
  actions as `Tool: name({...})` in the transcript

**Scripts / docs**
- `scripts/voice-tools-smoke.mjs` — one-shot end-to-end verification script
  (requires `npm run build` first; uses the compiled dist)
- `docs/voice-tools-summary.md` — this file

## Test coverage

```
voice-tools.test.ts        8 passed
controller.test.ts         3 passed
phone-voice.test.ts        9 passed
live-runner.test.ts       18 passed (13 existing + 5 new)
                       ----------
                          38 passed
```

New live-runner tests specifically covering the tool path:

1. `executes tool_calls from the LLM and re-prompts with the tool result`
2. `surfaces tool execution errors to the LLM (not the caller) so it can recover`
3. `rejects unknown tool names as an error result instead of throwing`
4. `no-tool turn behaves exactly as before (no extra LLM round-trip)`
5. `caps consecutive tool calls at MAX_TOOL_ITERATIONS and strips tools on the final turn`

## Smoke test evidence

```
$ node scripts/voice-tools-smoke.mjs
[smoke] Prompt : What is the current weather in Toronto?
[transcript.final] ...
[response.audio.delta] Let me check that for you.
[response.audio.delta] The current weather in Toronto is 12°C with partly cloudy conditions.
[action] tool_use web_search({"query":"current weather in toronto","max_results":1})
[finalized.agent.turn] Let me check that for you. The current weather in Toronto is 12°C with partly cloudy conditions.
[smoke] Turn completed in 1550ms
```

```
$ VOICE_SMOKE_PROMPT="Hi there, just calling to say hello." node scripts/voice-tools-smoke.mjs
[smoke] Prompt : Hi there, just calling to say hello.
[response.audio.delta] Hello!
[response.audio.delta] How can I assist you today?
[smoke] Turn completed in 238ms
[smoke] Tool invocations: 0
```

## Pre-existing test failures (not our problem)

Full `vitest run` shows 6 failures in 5 files that existed before my changes
(verified by `git stash` test run):

- `src/container-runner.test.ts` (whole file fails, setup error)
- `src/ipc-auth.test.ts` — 3 WhatsApp IPC tests
- `src/core/tasks/action-engine.test.ts` — 1 skill snapshot test
- `src/core/skills/visibility-service.test.ts` — 1 permission filter test

All have `ENOENT` errors on temp directories or WhatsApp-specific setup
issues. Unrelated to voice / tool calling.

## Worth knowing before you touch it

1. **Tool latency dominates turn latency.** A full tool-using turn runs
   ~1.5 s vs ~0.2 s for a plain turn. Most of that is DuckDuckGo. The canned
   ack ("Let me check…") is spoken immediately so the caller doesn't hear
   dead air.

2. **Qwen3-4B's tool decisions are pretty sensible.** In the smoke tests it
   calls `web_search` for weather and NOT for greetings, without any
   fine-tuning. The system prompt plus Hermes chat-template is doing real
   work.

3. **Adding a new tool is ~20 lines.** Define `{ schema, execute }` in
   `voice-tools.ts`, append it to the `VOICE_TOOLS` array. Tests pick it up
   automatically.

4. **`tool_choice` is NOT supported by OpenArc.** We can't force the model
   to call a specific tool, or force it to not call tools at all — only
   through prompt engineering. If we ever need that, it needs an OpenArc
   patch.

5. **Multiple tool calls per turn work.** If the model emits
   `tool_calls: [a, b, c]`, we execute all three sequentially and feed all
   three results back in one follow-up turn. Tested in the registry tests.

6. **The Pi Zero 1 W BT bridge path is still untouched.** Everything here
   is orthogonal to the BT audio problem — tool calling works on the
   browser tester today, and will Just Work over BT HFP when the UB500
   arrives or the Pi appliance is stood up.

## Suggested follow-ups (nice-to-haves, not blockers)

- **Stream tool output back as a spoken progress message** for slow tools.
  Right now the caller hears silence between "Let me check" and the final
  answer; for a 1.5 s turn that's fine, but a 5 s tool would get awkward.
  A periodic "still looking..." every 2 s would be trivial to add.
- **Add more tools.** Obvious next candidates: `get_weather` (via a
  dedicated weather API, shorter than web search), calendar lookup (we
  already have the Google Calendar integration), memory lookups.
- **Integration tests against live OpenArc.** Right now only
  `scripts/voice-tools-smoke.mjs` exercises the real model. Add a tagged
  integration test that's skipped in CI but runnable locally.
- **Replace the non-streaming tool path with streaming.** The initial
  `streamOnce` call already handles streamed tool_calls deltas correctly,
  but the follow-up turn (content response) could start streaming to TTS
  earlier instead of waiting for the full response. Currently it does
  stream, but the first phrase is dispatched via `emitPhrase` which means
  a brief pause at phrase boundaries. The existing phrase chunker handles
  this already, so this is marginal.

---

Built 23:08 → 23:35, all green. Sleep well.
