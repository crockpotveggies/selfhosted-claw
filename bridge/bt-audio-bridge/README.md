# bt-audio-bridge

Windows user-mode daemon that bridges a paired **Bluetooth HFP** phone to the
Self-Hosted Claw phone-voice backend. Captures the remote party's voice from
the HFP mic endpoint, ships PCM frames to the streaming STT WebSocket, and
renders agent TTS audio back to the HFP speaker endpoint so the other end
hears the agent.

Phase 1 (enumerate endpoints) + Phase 2 (capture) + Phase 3 (render) +
Phase 4 (auto-attach to pending outbound sessions) are all implemented.

## Toolchain — READ THIS FIRST

You **must** use `rustup` with the `x86_64-pc-windows-msvc` target. The
MSYS2 / Cygwin Rust builds will not work — the `windows` crate exposes its
`Win32::*` and `core::*` modules only on real Windows targets, and produces
cryptic "could not find `Win32` in `windows`" errors on Cygwin.

If `rustc -vV` shows `host: x86_64-pc-cygwin`, install rustup instead:

```powershell
# Install rustup (the official installer)
Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile rustup-init.exe
.\rustup-init.exe --default-host x86_64-pc-windows-msvc --default-toolchain stable -y

# Close + reopen the shell so PATH picks up ~/.cargo/bin
rustup default stable
rustup target add x86_64-pc-windows-msvc
rustc -vV   # should now show host: x86_64-pc-windows-msvc
```

MSVC target additionally needs the "Visual Studio Build Tools 2022" with the
"Desktop development with C++" workload, for the MSVC linker. If you already
have Visual Studio installed, you're done.

## Build & run

```powershell
cd bridge\bt-audio-bridge
cargo build --release
```

### Phase 1 — enumerate audio endpoints (diagnostic)

```powershell
cargo run --release -- enumerate
```

Expected output if HFP is live:

```
=== Active audio endpoints ===

[HFP?] Capture  Galaxy A15 5G Hands-Free HF Audio
       State:   ACTIVE
       Format:  16000 Hz, 1 ch, 16-bit PCM
       ID:      {0.0.1.00000000}.{...}

[HFP?] Render   Galaxy A15 5G Hands-Free HF Audio
       State:   ACTIVE
       Format:  16000 Hz, 1 ch, 16-bit PCM
       ID:      {0.0.0.00000000}.{...}
```

If you only see A2DP (44100 / 48000 Hz stereo), start a voice call on the
phone so Windows brings up the HFP link.

### Auto-bridge mode (default)

```powershell
cargo run --release -- `
  --backend-url http://localhost:3030 `
  --admin-token $env:ADMIN_UI_TOKEN
```

The bridge polls `GET /api/admin/integrations/phone-voice/bridge/pending-session`
every 2s. When the admin UI places an outbound test call, the backend stashes
a pending session id; the bridge picks it up, opens a WebSocket to
`ws://localhost:3030/api/admin/integrations/phone-voice/browser/<sid>/stream`,
and starts streaming.

### Manual single-shot

```powershell
cargo run --release -- `
  --session-id <sid> `
  --admin-token $env:ADMIN_UI_TOKEN `
  --backend-url http://localhost:3030
```

## CLI

```
Options:
  --capture-name <STR>   Default "Hands-Free"  (env: BTBRIDGE_CAPTURE)
  --render-name <STR>    Default "Hands-Free"  (env: BTBRIDGE_RENDER)
  --backend-url <URL>    Default http://localhost:3030 (env: BTBRIDGE_BACKEND_URL)
  --backend-ws <URL>     Full WS URL override (env: BTBRIDGE_BACKEND_WS)
  --session-id <ID>      Skip polling, attach directly (env: BTBRIDGE_SESSION_ID)
  --admin-token <TOK>    (env: BTBRIDGE_ADMIN_TOKEN)
  --poll-secs <N>        Default 2 (env: BTBRIDGE_POLL_SECS)
  --sample-rate-hz <N>   Default 16000 (env: BTBRIDGE_SAMPLE_RATE)

Subcommands:
  enumerate              Phase-1 diagnostic; prints active endpoints and exits
```

## Troubleshooting

- **HFP endpoint doesn't appear in Phase 1 output**. Open Control Panel →
  Devices and Printers → right-click phone → Properties → Services, and
  tick "Handsfree Telephony". Also on the phone, in Bluetooth settings for
  the paired PC, ensure "Phone audio" is on.
- **Bridge polls but never attaches**. Check the admin token is correct.
  `GET /api/admin/integrations/phone-voice/bridge/pending-session` with
  `X-Admin-Token: <yours>` should return JSON; 401 means token mismatch.
- **Audio is one-way (agent speaks but remote can't hear it)**. The render
  endpoint match is wrong. Pass `--render-name "Galaxy"` or similar to
  narrow it. Verify with `enumerate` which endpoint has `Render`.

## Architecture

- `main.rs` — clap CLI, tokio runtime bootstrap.
- `endpoints.rs` — WASAPI endpoint enumeration + substring match.
- `capture.rs` — WASAPI capture thread (shared mode, auto-convert to 16kHz
  mono 16-bit), frames → `mpsc::Sender<Bytes>`.
- `render.rs` — event-driven WASAPI render thread, consumes
  `mpsc::Receiver<Bytes>`, drops oldest frames when >2s backlog.
- `ws.rs` — `tokio-tungstenite` client. Binary sends = captured PCM. Text
  frames = session events; `assistant_audio` events decoded (WAV header
  stripped, optional resample to 16kHz) and pushed to render queue.
- `session.rs` — polls the backend for a pending outbound session.
