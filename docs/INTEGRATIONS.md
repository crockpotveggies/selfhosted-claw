# Creating Integrations

This guide covers how to create, configure, and extend integrations in Self-Hosted Claw.

## Overview

An integration is a self-contained package that declares its capabilities. The system auto-generates admin UI pages, API routes, and setup wizards from the declaration.

```typescript
registerIntegration({
  name: 'my-service',
  description: 'Description shown in admin UI',
  core: false,              // true = always on; false = can be toggled
  version: '1.0.0',
  credentials: [...],       // What secrets are needed
  settings: {...},           // JSON Schema → auto-generated settings form
  adminPage: {...},          // Icon, category, status check, notifications
  channel: factory,          // Optional: messaging transport
  tools: [...],              // Optional: tools exposed to the agent
  skills: [...],             // Optional: prompt instructions
  service: {...},            // Optional: Docker Compose lifecycle
  memory: {...},             // Optional: per-integration agent memory
  setup: {...},              // Optional: multi-step setup wizard
});
```

## Quick Start

### 1. Create the integration file

```typescript
// src/integrations/my-service.ts
import { registerIntegration } from './registry.js';
import type { IntegrationDefinition } from './types.js';

const def: IntegrationDefinition = {
  name: 'my-service',
  description: 'My custom service',
  core: false,
  version: '1.0.0',
  credentials: [
    {
      key: 'MY_API_KEY',
      label: 'API Key',
      type: 'api_key',
      envVar: 'MY_API_KEY',       // Checked in .env via readEnvFile
      required: true,
    },
  ],
  adminPage: {
    icon: 'cilSearch',
    category: 'productivity',     // messaging | productivity | utility | developer
    getStatus: async (ctx) => ({
      state: ctx.hasCredential('MY_API_KEY') ? 'online' : 'unconfigured',
      message: ctx.hasCredential('MY_API_KEY') ? 'Connected' : 'API key not set',
    }),
  },
};

registerIntegration(def);
```

### 2. Register it

Add the import to `src/integrations/index.ts`:

```typescript
import './my-service.js';
```

### 3. Rebuild and restart

```bash
npm run build:server
npx pm2 restart nanoclaw
```

The integration now appears in the admin UI Integrations page.

## Capabilities

### Settings (JSON Schema)

Auto-generates a form in the admin UI:

```typescript
settings: {
  schema: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'integer',
        title: 'Max Results',
        description: 'Maximum items per query',
        default: 25,
        minimum: 1,
        maximum: 100,
      },
      apiUrl: {
        type: 'string',
        title: 'API URL',
        format: 'url',
      },
      enableFeature: {
        type: 'boolean',
        title: 'Enable Feature X',
        default: false,
      },
      tags: {
        type: 'array',
        title: 'Tags',
        items: { type: 'string' },
        default: [],
      },
    },
  },
  defaults: { maxResults: 25, enableFeature: false, tags: [] },
  perGroup: true,     // Allow per-group overrides
}
```

**Supported types**: `string`, `number`, `integer`, `boolean`, `array` (of strings).
**Format hints**: `url`, `email`, `textarea`, `cron`, `path`.
**Special**: `sensitive: true` masks the field, `dependsOn: { field, value }` for conditional visibility.

Settings are stored in `~/.config/self-hosted-claw/integrations/{name}/settings.json`.

### Tools (Agent Capabilities)

Tools are functions the agent can call inside containers:

```typescript
tools: [
  {
    name: 'my_search',
    description: 'Search my service',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    location: 'host',        // 'host' = runs on host via IPC; 'container' = runs locally
    controllerOnly: true,    // Only available when main group triggers
    execute: async (args, ctx) => {
      // ctx.settings has the integration settings
      return JSON.stringify({ results: [] });
    },
  },
],
```

Host tools execute on the host side (where credentials live) and return results via IPC. Container tools run locally inside the Docker container.

### Setup Wizard

Declare ordered steps for first-time configuration:

```typescript
setup: {
  steps: [
    {
      type: 'oauth2',
      label: 'Connect Account',
      provider: 'google',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      callbackPath: '/api/admin/integrations/my-service/setup/oauth/callback',
      startAuth: async (origin) => ({ url: '...', state: '...' }),
      completeAuth: async ({ code, state, origin }) => { /* save token */ },
      isComplete: async () => true,
    },
  ],
  getStatus: async () => ({
    completed: true,
    currentStep: 0,
    steps: [{ type: 'oauth2', label: 'Connect Account', status: 'completed' }],
  }),
}
```

**Step types**:

| Type | Use case | Admin UI renders |
|------|----------|-----------------|
| `oauth2` | OAuth2 flows | Connect button + callback URL display + popup window |
| `credential_input` | API keys, tokens | Form fields with validation |
| `form` | Arbitrary config | SchemaForm (same as settings) |
| `qr_code` | Device pairing | QR image + polling spinner |
| `verification_code` | Phone/email verification | Send code + verify input |
| `webhook_url` | External webhook config | Copyable URL + test button |
| `custom` | Complex flows | Custom routes |

The admin server auto-registers API routes for each step type under `/api/admin/integrations/:name/setup/`.

### Docker Service

Manage a companion Docker Compose service:

```typescript
service: {
  composeFile: 'scripts/my-service/docker-compose.yml',
  envFile: 'scripts/my-service/.env',
  serviceName: 'my-service',
  buildEnv: (settings) => ({
    API_KEY: settings.apiKey as string,
    PORT: '9090',
  }),
  healthCheck: {
    url: 'http://localhost:9090/health',
    intervalMs: 30000,
  },
}
```

The service manager handles:
- **Bootstrap mode**: First-time start with explicit input from setup wizard
- **Steady-state**: Auto-start from saved settings at boot (`ensureServicesRunning()`)
- **Health monitoring**: Periodic checks with exponential backoff (30s → 15min cap)
- **Circuit breaker**: Stops retrying after 10 consecutive failures; manual reset from admin UI

### Memory

Declare per-integration agent memory:

```typescript
memory: {
  contextChars: 300,                    // Max chars in system prompt
  contextTags: ['scheduling', 'meeting'], // Only inject memories with these tags
}
```

The agent uses `memory_store`, `memory_search`, `memory_forget` tools to manage memories scoped by entity (person/group/global) × integration × group.

### Notifications

Report health issues to the admin UI bell icon:

```typescript
adminPage: {
  // ...
  getNotifications: async (ctx) => {
    const notifications = [];
    if (!ctx.hasCredential('MY_API_KEY')) {
      notifications.push({
        id: 'my-service:no-key',
        integration: 'my-service',
        severity: 'warning',         // error | warning | info
        title: 'API Key Missing',
        message: 'Configure your API key in the integration settings.',
      });
    }
    return notifications;
  },
}
```

Notifications appear in the header bell icon. Clicking navigates to the integration's detail page.

## Wrapping an Existing Channel

If you have a channel using the legacy `registerChannel()` pattern:

```typescript
import { channelAsIntegration } from '../integrations/adapter.js';

// After your existing registerChannel() call:
channelAsIntegration({
  name: 'whatsapp',
  description: 'WhatsApp via Baileys',
  credentials: [{ key: 'WHATSAPP_AUTH', label: 'Auth', type: 'secret', required: true }],
  category: 'messaging',
  getStatus: async () => ({ state: 'online', message: 'Connected' }),
  settings: { /* optional */ },
  setup: { /* optional wizard */ },
});
```

This gives the channel admin UI presence without modifying the channel registration.

## Core vs Installable

- **Core** (`core: true`): Always enabled, no disable toggle. Signal is the only core integration.
- **Installable** (`core: false`): Toggleable via admin UI. Default disabled until enabled.

## Credential Handling

- Credentials declared with `envVar` are checked in `.env` (via `readEnvFile`), `process.env`, and integration settings
- Integration settings files (`~/.config/self-hosted-claw/integrations/`) are **never mounted into containers**
- `.env` is shadowed with `/dev/null` in containers
- Real credentials reach containers only via OneCLI gateway or host-side IPC tool execution

## File Structure

```
src/integrations/
  types.ts              — All TypeScript interfaces
  registry.ts           — registerIntegration(), getIntegration(), etc.
  settings-store.ts     — JSON file persistence
  service-manager.ts    — Docker Compose lifecycle + health monitor
  setup-router.ts       — Auto-registers admin API routes
  adapter.ts            — channelAsIntegration() helper
  index.ts              — Barrel (import all integrations here)
  signal.ts             — Signal (core)
  calendar.ts           — Google Calendar (installable)
```

## Logging

Each integration gets a scoped child logger:

```typescript
import { createChildLogger } from '../logger.js';
const log = createChildLogger({ integration: 'my-service' });
log.info({ group: 'team' }, 'Operation completed');
// → tagged with integration='my-service' in SQLite logs, filterable in admin UI
```
