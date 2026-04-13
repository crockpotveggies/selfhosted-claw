# Self-Hosted Claw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with a unified integration system. Integrations (Signal, Google Calendar, WhatsApp, Telegram, Slack, etc.) self-register at startup and can provide channels, tools, skills, Docker services, memory, and setup wizards. Messages route to an OpenAI-compatible model backend running in isolated Docker containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/integrations/types.ts` | Integration type system (capabilities, settings, setup flows) |
| `src/integrations/registry.ts` | Integration registry (self-registration at startup) |
| `src/integrations/settings-store.ts` | Per-integration JSON settings persistence |
| `src/integrations/service-manager.ts` | Docker service lifecycle, health monitor, circuit breaker |
| `src/integrations/setup-router.ts` | Auto-registers admin API routes for setup wizards |
| `src/integrations/signal.ts` | Signal integration (core, channel + Docker service) |
| `src/integrations/calendar.ts` | Google Calendar integration (installable, 6 tools) |
| `src/integrations/adapter.ts` | Helper for wrapping legacy channels as integrations |
| `src/channels/registry.ts` | Legacy channel registry (delegated to by integration registry) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations (messages, chats, groups, tasks) |
| `src/logger.ts` | Pino logger with SQLite transport (queryable structured logs) |
| `src/logger/sqlite-transport.ts` | Log persistence to `store/logs.db` |
| `src/logger/pruner.ts` | Log retention (30-day default, 200MB cap) |
| `src/memory/` | File-based agent memory with 3D scoping (person x integration x group) |
| `src/admin-server.ts` | Admin UI HTTP server + all API endpoints |
| `src/control-actions.ts` | Control action definitions and execution |
| `groups/{name}/CLAUDE.md` | Per-group personality (legacy, coexists with memory system) |
| `data/memory/` | Structured agent memory (tags, frontmatter, per-entity) |
| `container/skills/` | Skills loaded inside agent containers at runtime |
| `container/entrypoint.sh` | Container startup (skips TS recompile when source unchanged) |

## Integration System

Integrations are the primary extension mechanism. Each integration is a self-contained package that declares its capabilities. See [src/integrations/README.md](src/integrations/README.md) for the full developer guide.

**Core integrations** (always on, cannot be disabled):
- `signal` — Channel + Docker service (signal-cli) + setup wizard

**Installable integrations** (optional, enabled via admin UI):
- `google-calendar` — 6 calendar tools + OAuth setup + memory

Creating a new integration: add a file to `src/integrations/`, call `registerIntegration()`, import it from `src/integrations/index.ts`.

## Admin UI

React + CoreUI dashboard at `http://localhost:3030` with pages:
- **Dashboard** — metric cards, recent activity table, audit log
- **Contacts** — identity trust management, message history
- **Personality** — agent personality profiles, Signal profile, rendered preview
- **Policy** — verified identities, provider controls, contact resolution
- **Availability** — calendar availability windows, timezone, scheduling preferences
- **Integrations** — card grid of all integrations with setup wizards, settings, logs
- **Tools** — registry of control actions grouped by type
- **Skills** — container skill editor (CRUD for markdown skill files)
- **Tasks** — scheduled/recurring agent tasks
- **Approvals** — pending control actions requiring human decision
- **Audit** — immutable action history log
- **Logs** — structured log viewer with filtering (level, integration, group, text search)

Notification bell in header shows integration health alerts (expired tokens, offline services, circuit breakers).

## Structured Logging

Pino-based logger with dual output: console (pino-pretty) + SQLite (`store/logs.db`). Child loggers for per-integration scoping. Queryable via admin API and UI. Log retention: 30-day default, 200MB cap, configurable.

## Memory System

File-based with YAML frontmatter tags, 3D scoping:
- **Entity**: `person:<id>` | `group:<folder>` | `global`
- **Integration**: `calendar` | `slack` | `_core`
- **Group**: per-group or `_all`

Storage: `data/memory/{entity-type}/{id}/{integration}/*.md`
Agent tools: `memory_search`, `memory_store`, `memory_forget` (container-local).

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Integration settings (`~/.config/self-hosted-claw/integrations/`) are never mounted into containers. Run `onecli --help`.

## Skills

Four types of skills exist in Self-Hosted Claw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream Self-Hosted Claw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript + admin UI
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# PM2 (Windows / cross-platform)
npx pm2 restart nanoclaw
npx pm2 logs nanoclaw
npx pm2 status

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

## Container Performance

The container entrypoint skips TypeScript recompilation when the mounted source matches the pre-built image (checksum comparison). This saves 1-3 seconds per container start. Containers stay alive between messages via IPC keep-alive (30-minute idle timeout).

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` to install it. Existing auth credentials and groups are preserved.

**Setup overlay flashing on page load:** The setup status API must return before the UI decides whether to show the overlay. If `getProviderAvailability()` throws (e.g., expired OAuth token), the endpoint is protected by a try-catch so it won't crash.

**Container build cache:** The buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a clean rebuild, prune the builder then re-run `./container/build.sh`.
