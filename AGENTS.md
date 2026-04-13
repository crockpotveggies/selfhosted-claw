# Self-Hosted Claw

Personal assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

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
| `src/integrations/signal.ts` | Signal integration (core, channel + Docker service) |
| `src/integrations/calendar.ts` | Google Calendar integration (installable, 6 tools) |
| `src/integrations/adapter.ts` | Helper for wrapping legacy channels as integrations |
| `src/channels/registry.ts` | Legacy channel registry (delegated to by integration registry) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/logger.ts` | Pino logger with SQLite transport |
| `src/memory/` | File-based agent memory with 3D scoping |
| `src/admin-server.ts` | Admin UI HTTP server + API endpoints |
| `groups/{name}/AGENTS.md` | Per-group personality (legacy, coexists with memory system) |
| `data/memory/` | Structured agent memory |
| `container/skills/` | Skills loaded inside agent containers at runtime |

## Integration System

Integrations are the primary extension mechanism. Each integration declares capabilities (channel, tools, skills, Docker services, memory, setup wizards). See [src/integrations/README.md](src/integrations/README.md).

## Admin UI

React + CoreUI dashboard at `http://localhost:3030` — Dashboard, Contacts, Personality, Policy, Availability, Integrations, Tools, Skills, Tasks, Approvals, Audit, Logs.

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript + admin UI
./container/build.sh # Rebuild agent container
```

## Secrets / Credentials

Managed by OneCLI gateway. Integration settings in `~/.config/self-hosted-claw/integrations/` are never mounted into containers.
