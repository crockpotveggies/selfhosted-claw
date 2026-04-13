<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

---

## Why I Built Self-Hosted Claw

Nanoclaw is cool, but I want to self-host as much as possible.

## Quick Start

```bash
gh repo fork crockpotveggies/selfhosted-claw --clone
cd selfhosted-claw
npm install
cp .env.example .env
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [crockpotveggies/selfhosted-claw](https://github.com/crockpotveggies/selfhosted-claw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/selfhosted-claw.git`
3. `cd selfhosted-claw`
4. `npm install`
5. `cp .env.example .env`

</details>

## First-Run Setup

Self-Hosted Claw now has a local-first admin UI wizard for secure onboarding, but the environment still needs a few host-level prerequisites before the wizard can finish.

### 1. Install the prerequisites

- Node.js 20+
- Docker or Apple Container
- An OpenAI-compatible backend such as vLLM

### 2. Start your OpenAI-compatible backend

Make sure your model backend is reachable from the host, for example:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_MODEL=local-model
```

If your backend requires an API key, keep it ready for the setup wizard or put it in `.env`.

### 3. Prepare the assistant's Signal identity

- Create or choose a dedicated Signal account for the assistant
- Decide which Signal conversation will be your control chat
- Keep the assistant number ready for Signal registration or device linking

### 4. Populate the baseline `.env`

You can pre-fill these values in `.env` or enter them in the wizard. At minimum, make sure the core values below exist by the time you finish setup:

```bash
OPENAI_BASE_URL="http://127.0.0.1:8000/v1"
OPENAI_MODEL="local-model"
SIGNAL_ACCOUNT="+15555550123"
SIGNAL_RPC_URL="http://127.0.0.1:8080"
CONTROL_SIGNAL_JID="signal:user:+15555550123"
ADMIN_BIND_HOST="127.0.0.1"
ADMIN_PORT="3030"
INBOUND_GUARD_SCRIPT="scripts/inbound-message-guard.mjs"
```

Optional but recommended:

```bash
OPENAI_API_KEY=""
ADMIN_UI_TOKEN="choose-a-local-admin-token"
ONECLI_URL="http://localhost:10254"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
```

### 5. Build and start Self-Hosted Claw

Build and start via PM2 (recommended — auto-restarts on crash, survives reboots):

```bash
npm run build
npm run service:start
```

To persist the process across reboots, run once after first start:

```bash
npm run service:save     # save current process list
npm run service:startup  # install OS-level auto-start hook
```

**Service management commands:**

| Command | Action |
|---------|--------|
| `npm run service:start` | Start (safe to re-run) |
| `npm run service:stop` | Graceful stop |
| `npm run service:restart` | Restart (e.g. after `npm run build`) |
| `npm run service:logs` | Tail live logs |
| `npm run service:status` | Process table with PID, uptime, restart count |

Logs are written to `logs/nanoclaw.log` and `logs/nanoclaw-error.log`.

Development run (no PM2):

```bash
# terminal 1
npm run dev

# terminal 2
npm run dev:ui
```

### 6. Open the admin UI wizard

- Production build: open `http://127.0.0.1:3030`
- Vite dev UI: open `http://127.0.0.1:4173`

The setup wizard walks through:

1. Secure local admin settings
2. OpenAI-compatible model backend
3. Signal bridge and control chat
4. Signal account linking or registration
5. Verified owner identities
6. Final review and restart checklist

Security behavior:

- The admin API only binds to `127.0.0.1` by default
- `ADMIN_UI_TOKEN` is optional but recommended
- sensitive values such as `OPENAI_API_KEY` and `ADMIN_UI_TOKEN` are write-only in the UI and are not returned by the API afterward

During the Signal step, the wizard now writes `scripts/signal-cli/.env` and starts the managed Signal bridge with:

```bash
docker compose -f scripts/signal-cli/docker-compose.yml --env-file scripts/signal-cli/.env up -d
```

The managed bridge:

- binds only to `127.0.0.1`
- stores Signal state under the host admin data directory, not in the repo
- uses the compose file in [scripts/signal-cli/docker-compose.yml](/Users/justin/Projects/selfhosted-claw/scripts/signal-cli/docker-compose.yml)

If the assistant Signal account has not been registered or linked yet, complete that Signal-side step after the container starts. The compose stack gets the bridge online for you, but it does not bypass Signal's own account registration/link flow.

The wizard can now drive both supported Signal onboarding paths:

- Device linking: it requests a QR code from the managed bridge and shows it in the browser so you can scan it from Signal on your phone
- Direct registration: it can start SMS or voice verification and then submit the verification code you receive

Signal still requires a human to complete the trust ceremony by scanning the QR code or entering the verification code.

### Optional: connect Google Contacts

If you want host-side contact resolution for outbound messaging, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, then open the admin UI and connect the `google-contacts` integration.

The Google Contacts integration provides:

- An OAuth setup flow in the Integrations page
- A host-side `google_contacts.search` tool for the agent
- Contact lookup for outbound `signal`, `whatsapp`, `sms`, and `email` routing

The OAuth callback URL is shown directly in the integration setup wizard so you can register it in Google Cloud without guessing.

### 7. Restart after wizard changes

If the wizard updated `.env`, restart the main service so the Node process picks up the new values:

```bash
npm run service:restart
```

### 8. Run the setup checks

Run the built-in setup verification steps:

```bash
npm run setup -- --step environment
npm run setup -- --step signal
npm run setup -- --step service
npm run setup -- --step verify
```

### 9. Verify the Signal control plane

From your verified control Signal chat, try:

```text
/settings show
/policy show
/contacts list
/audit recent
/signal-compose status
```

### 10. Review the inbound guard

Inbound messages are sanitized by the host before they are stored or forwarded. The default script is:

```bash
scripts/inbound-message-guard.mjs
```

Point `INBOUND_GUARD_SCRIPT` at your own script if you want to customize the injection-defense heuristics.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** Self-Hosted Claw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, Self-Hosted Claw is designed to be bespoke. You make your own fork and tailor it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- The admin UI handles secure first-run onboarding, but the setup steps remain simple and local.
- No heavyweight monitoring dashboard; inspect logs and ask your assistant what happened.
- No debugging tools; the codebase is small enough to trace directly.

**Skills over features.** Instead of adding every possible integration to the codebase, contributors can still keep their forks specialized and minimal.

**Open backend by default.** Self-Hosted Claw now runs against an OpenAI-compatible chat completions backend such as vLLM, with Self-Hosted Claw's own tool loop and history management.

## What It Supports

- **Signal-first messaging** - Signal is the built-in default channel, with support for other channels still available through the channel registry model.
- **Unified control plane** - The admin UI and the verified Signal control chat use the same host-side control actions and audit log.
- **Isolated group context** - Each group has its own `AGENT.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run the Self-Hosted Claw agent and can message you back
- **Google Contacts integration** - Optional OAuth-backed contact search and outbound recipient resolution across supported channels
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Docker (macOS/Linux), [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Credential security** - Agents can use [OneCLI's Agent Vault](https://github.com/onecli/onecli) for proxied credential injection, or connect directly to a local backend when you do not need proxying.
- **Native tool loop** - Shell, files, web fetch/search, task controls, and nested delegation are handled by Self-Hosted Claw itself instead of a provider SDK
- **Inbound guard hook** - A host-side script sanitizes inbound messages before storage to reduce prompt-injection risk

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

From the verified Signal control chat, you can also use deterministic host commands:

```text
/contacts list status=abuse
/contact trust +15555550123
/personality show global
/policy pause-outbound sms
/settings show
/audit recent
```

## Customizing

Self-Hosted Claw doesn't use large configuration surfaces. To make changes, edit the small codebase directly:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

The codebase is small enough to customize safely.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork Self-Hosted Claw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- A Signal bridge backed by `signal-cli`
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Self-Hosted Claw OpenAI-compatible runtime) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see the [documentation site](https://docs.nanoclaw.dev/concepts/architecture).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, router state)
- `groups/*/AGENT.md` - Per-group memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize Self-Hosted Claw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. Self-Hosted Claw supports OpenAI-compatible chat completions endpoints such as vLLM. Set these environment variables in your `.env` file:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_API_KEY=
OPENAI_MODEL=local-model
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments that expose the OpenAI chat completions API

Note: the backend must support OpenAI-style tool calling for best compatibility.

**How do I debug issues?**

Inspect the logs with `npm run service:logs`, use the setup verification steps, or ask your assistant in the main Signal chat to inspect recent state. For onboarding problems, open the local setup wizard and compare it with `npm run setup -- --step verify`.

**Why isn't the setup working for me?**

If setup fails, run the individual setup steps directly and inspect their structured output. The codebase is intentionally small enough that debugging is usually local and direct.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
