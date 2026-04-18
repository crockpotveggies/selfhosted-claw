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
- `signal` â€” Channel + Docker service (signal-cli) + setup wizard

**Installable integrations** (optional, enabled via admin UI):
- `google-calendar` â€” 6 calendar tools + OAuth setup + memory

Creating a new integration: add a file to `src/integrations/`, call `registerIntegration()`, import it from `src/integrations/index.ts`.

Deep research is an installable integration that adds `/research`, `deep_research_start`, workspace-scoped research artifacts, and PDF report delivery.

## Admin UI

React + CoreUI dashboard at `http://localhost:3030` with pages:
- **Dashboard** â€” metric cards, recent activity table, audit log
- **Contacts** â€” identity trust management, message history
- **Personality** â€” agent personality profiles, Signal profile, rendered preview
- **Policy** â€” verified identities, provider controls, contact resolution
- **Availability** â€” calendar availability windows, timezone, scheduling preferences
- **Integrations** â€” card grid of all integrations with setup wizards, settings, logs
- **Tools** â€” registry of control actions grouped by type
- **Skills** â€” container skill editor (CRUD for markdown skill files)
- **Tasks** â€” scheduled/recurring agent tasks
- **Approvals** â€” pending control actions requiring human decision
- **Audit** â€” immutable action history log
- **Logs** â€” structured log viewer with filtering (level, integration, group, text search)

Notification bell in header shows integration health alerts (expired tokens, offline services, circuit breakers).

The admin UI also includes **Research** and **Files** pages for long-running research jobs, quota visibility, workspace mount inventory, and generated report artifacts.

## Deep Research Notes

- Deep research reuses the existing `ActionRecord` + `RunSpec` infrastructure instead of introducing a parallel queue.
- Reports are written under `groups/<workspace>/research/<topic-slug>/`.
- Only `<topic-slug>-report.pdf` is sent back to the originating channel; markdown, HTML, plan, and sources files remain local-only workspace artifacts.

## Structured Logging

Pino-based logger with dual output: console (pino-pretty) + SQLite (`store/logs.db`). Child loggers for per-integration scoping. Queryable via admin API and UI. Log retention: 30-day default, 200MB cap, configurable.

## Memory System

File-based with YAML frontmatter tags, 3D scoping:
- **Entity**: `person:<id>` | `group:<folder>` | `global`
- **Integration**: `calendar` | `slack` | `_core`
- **Group**: per-group or `_all`

Storage: `data/memory/{entity-type}/{id}/{integration}/*.md`
Agent tools: `memory_search`, `memory_store`, `memory_forget` (container-local).

## Secrets / Credentials / Proxy

API keys, secret keys, OAuth tokens, and auth credentials are managed from host-side environment and persisted integration settings. Containers only receive the narrow runtime values they need. Integration settings (`~/.config/self-hosted-claw/integrations/`) are never mounted into containers.

## Skills

Four types of skills exist in Self-Hosted Claw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** â€” merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** â€” ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** â€” instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** â€” loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream Self-Hosted Claw updates into a customized install |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist.

## Development

Run commands directlyâ€”don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript + admin UI
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# Build or refresh the control plane image
npm run service:install

# Start / restart / inspect the compose-managed control plane
npm run service:start
npm run service:restart
npm run service:status
npm run service:logs
```

## Container Performance

The container entrypoint skips TypeScript recompilation when the mounted source matches the pre-built image (checksum comparison). This saves 1-3 seconds per container start. Containers stay alive between messages via IPC keep-alive (30-minute idle timeout).

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` to install it. Existing auth credentials and groups are preserved.

**Setup overlay flashing on page load:** The setup status API must return before the UI decides whether to show the overlay. If `getProviderAvailability()` throws (e.g., expired OAuth token), the endpoint is protected by a try-catch so it won't crash.

**Container build cache:** The buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a clean rebuild, prune the builder then re-run `./container/build.sh`.
