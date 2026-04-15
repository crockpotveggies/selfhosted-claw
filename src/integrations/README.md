# Integration System

The integration system provides a unified abstraction for adding capabilities to NanoClaw. Each integration is a self-contained package that declares what it provides (channel, tools, skills, settings, memory, setup flow, Docker services).

## Quick Start

### Creating a new integration

Create a file in `src/integrations/` that calls `registerIntegration()`:

```typescript
// src/integrations/my-service.ts
import { registerIntegration } from './registry.js';

registerIntegration({
  name: 'my-service',
  description: 'My custom service integration',
  core: false,
  version: '1.0.0',
  credentials: [
    { key: 'MY_API_KEY', label: 'API Key', type: 'api_key', envVar: 'MY_API_KEY', required: true },
  ],
  settings: {
    schema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', title: 'Max Results', default: 10, minimum: 1, maximum: 100 },
      },
    },
    defaults: { maxResults: 10 },
  },
  tools: [
    {
      name: 'my_service_search',
      description: 'Search my service',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      location: 'host',
      execute: async (args, ctx) => {
        // Access settings via ctx.settings
        return JSON.stringify({ results: [] });
      },
    },
  ],
  adminPage: {
    icon: 'cilSearch',
    category: 'productivity',
    getStatus: async (ctx) => ({
      state: ctx.hasCredential('MY_API_KEY') ? 'online' : 'unconfigured',
      message: ctx.hasCredential('MY_API_KEY') ? 'Connected' : 'API key not set',
    }),
  },
});
```

Then add the import to `src/integrations/index.ts`:

```typescript
import './my-service.js';
```

### Example: Google Contacts

`google-contacts` is a good reference integration when you need:

- An OAuth2 setup step with an explicit callback URL
- A host-side tool implemented with `execute()`
- Backward-compatible migration logic that still writes a legacy settings file
- Admin status and notification handling for expired OAuth tokens

See `src/integrations/google-contacts.ts` for a concrete example.

### Example: SMS Socket

`sms-socket` is a good reference integration when you need:

- A channel implemented directly inside the integration instead of the legacy channel registry
- A `credential_input` setup step with a `helpUrl` that sends users to an external download page
- A WebSocket-backed messaging transport with reconnect and history rehydration
- Host-side messaging tools that operate on a live channel instance

See `src/integrations/sms-socket.ts` for a concrete example.

### Wrapping an existing channel

If you have a channel registered via the legacy `registerChannel()` pattern:

```typescript
import { channelAsIntegration } from '../integrations/adapter.js';

// After your existing registerChannel() call:
channelAsIntegration({
  name: 'whatsapp',
  description: 'WhatsApp via Baileys',
  credentials: [{ key: 'WHATSAPP_AUTH', label: 'Auth', type: 'secret', required: true }],
  category: 'messaging',
  getStatus: async () => ({ state: 'online', message: 'Connected' }),
});
```

## Core vs Installable

- **Core** (`core: true`): Always enabled, cannot be disabled. Signal is core.
- **Installable** (`core: false`): Can be enabled/disabled via admin UI. Calendar, WhatsApp, etc.

## Capabilities

An integration can provide any combination of:

| Capability | Property | Description |
|---|---|---|
| Channel | `channel` | Messaging transport (receive/send) |
| Tools | `tools[]` | Functions exposed to the agent inside containers |
| Skills | `skills[]` | Prompt instructions injected into agent system prompt |
| Service | `service` | Docker Compose service lifecycle (start/stop/health) |
| Memory | `memory` | Per-integration agent memory with in-context injection |
| Setup | `setup` | Multi-step setup wizard (OAuth, QR, credentials, forms) |

## Settings (JSON Schema)

Settings are defined via JSON Schema and auto-rendered as forms in the admin UI:

```typescript
settings: {
  schema: {
    type: 'object',
    properties: {
      apiUrl: { type: 'string', title: 'API URL', format: 'url' },
      enabled: { type: 'boolean', title: 'Feature Flag', default: false },
      tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
    },
  },
  defaults: { apiUrl: 'https://api.example.com', enabled: false, tags: [] },
  perGroup: true, // Allow per-group overrides
}
```

Supported types: `string`, `number`, `integer`, `boolean`, `array` (of strings).
Format hints: `url`, `email`, `textarea`, `cron`, `path`.
Special: `sensitive: true` masks the field, `dependsOn` for conditional visibility.

## Setup Flow

Declare ordered setup steps. The admin UI renders the right component for each:

| Step Type | Use Case | UI Renders |
|---|---|---|
| `oauth2` | OAuth2 flows (Google, Slack, GitHub) | Connect button + callback URL display |
| `credential_input` | API keys, tokens, app-generated secrets | Form fields + validate |
| `form` | Arbitrary config | SchemaForm (same as settings) |
| `qr_code` | Device pairing (Signal, WhatsApp) | QR image + polling |
| `verification_code` | Phone/email verification | Send code + verify |
| `webhook_url` | External webhook config | Copyable URL + test button |
| `custom` | Complex flows | Custom routes + optional component |

**OAuth callback URLs**: The `callbackPath` on OAuth steps is displayed prominently in the setup wizard so users can register it with their OAuth provider.

**Setup help links**: `credential_input` and `webhook_url` steps can provide a `helpUrl`, which the admin UI renders as a "Where to find these credentials" link. This is useful for integrations like `sms-socket`, where the user must first install a companion app.

For a concrete OAuth example, see `google-contacts`, which stores tokens in both the integration settings store and the legacy `google-contacts-oauth.json` file during migration.

## Docker Service Lifecycle

Integrations can declare Docker Compose services:

```typescript
service: {
  composeFile: 'scripts/my-service/docker-compose.yml',
  envFile: 'scripts/my-service/.env',
  serviceName: 'my-service',
  buildEnv: (settings) => ({ API_KEY: settings.apiKey as string }),
  healthCheck: { url: 'http://localhost:9090/health', intervalMs: 30000 },
}
```

The service manager handles:
- **Bootstrap mode**: First-time setup with explicit input
- **Steady-state**: Auto-start from saved settings at boot
- **Health monitoring**: Periodic checks with exponential backoff
- **Circuit breaker**: Stops retry after 10 consecutive failures

## Memory

Integrations declare memory for per-integration agent context:

```typescript
memory: {
  contextChars: 300,
  contextTags: ['scheduling', 'meeting'],
}
```

Memory is scoped in 3 dimensions: entity (person/group/global) x integration x group.
Files use YAML frontmatter with tags for cross-cutting queries.

## Notifications

Integrations can report health issues to the admin UI notification bell:

```typescript
adminPage: {
  getNotifications: async (ctx) => {
    if (!ctx.hasCredential('MY_KEY')) {
      return [{
        id: 'my-service:no-key',
        integration: 'my-service',
        severity: 'warning',
        title: 'API Key Missing',
        message: 'Configure in integration settings.',
      }];
    }
    return [];
  },
}
```

Notifications appear in the header bell icon with a red badge count. Clicking navigates to the integration's detail page. Notifications auto-clear when the issue resolves (e.g., token refreshed, service restarted).

## Credential Handling

- Credentials with `envVar` are checked in `.env` (via `readEnvFile`), `process.env`, and settings store
- Integration settings (`~/.config/self-hosted-claw/integrations/`) are **never mounted into containers**
- `.env` is shadowed with `/dev/null` in containers
- Credentials reach containers only via OneCLI gateway or host-side IPC tool execution

## Tool Injection

Host-side tools are injected into containers via `integration_tools.json` manifest:
1. Host writes manifest to IPC before container start
2. Agent-runner reads manifest, registers dynamic IPC-backed tool stubs
3. Tool calls go through IPC to host, where the integration's `execute()` runs

## Logging

Each integration gets a scoped child logger:

```typescript
import { createChildLogger } from '../logger.js';
const log = createChildLogger({ integration: 'my-service' });
log.info({ group: 'team' }, 'Operation completed');
// Automatically tagged with integration='my-service' in SQLite logs
```

## File Structure

```
src/integrations/
  types.ts              — All TypeScript interfaces
  registry.ts           — registerIntegration(), getIntegration(), etc.
  settings-store.ts     — JSON file persistence for settings
  service-manager.ts    — Docker Compose lifecycle + health monitor
  setup-router.ts       — Auto-registers admin API routes for setup flows
  adapter.ts            — channelAsIntegration() helper for legacy channels
  index.ts              — Barrel file (import all integrations)
  signal.ts             — Signal (core)
  calendar.ts           — Google Calendar (installable)
  google-contacts.ts    — Google Contacts (installable tool integration)
```
