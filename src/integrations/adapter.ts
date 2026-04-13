/**
 * Migration adapter for existing channel-based integrations.
 *
 * Feature branches (WhatsApp, Telegram, Slack, etc.) that use the legacy
 * registerChannel() pattern can call channelAsIntegration() to gain:
 *   - Admin UI presence (card in Integrations page)
 *   - Status checks
 *   - Settings via JSON Schema
 *   - Setup flow wizards
 *   - Memory integration
 *   - Docker service lifecycle
 *   - Scoped logging
 *
 * The channel continues to be registered via registerChannel() — this
 * adapter does NOT set the channel property to avoid double-registration.
 *
 * @example
 * ```typescript
 * // In src/channels/whatsapp.ts (after existing registerChannel call):
 * import { channelAsIntegration } from '../integrations/adapter.js';
 *
 * channelAsIntegration({
 *   name: 'whatsapp',
 *   description: 'WhatsApp via Baileys',
 *   credentials: [
 *     { key: 'WHATSAPP_AUTH', label: 'Auth Token', type: 'secret', required: true },
 *   ],
 *   category: 'messaging',
 *   getStatus: async () => ({
 *     state: 'online',
 *     message: 'Connected via QR',
 *   }),
 * });
 * ```
 */

import { registerIntegration } from './registry.js';
import type {
  CredentialRequirement,
  IntegrationAdminPage,
  IntegrationMemory,
  IntegrationService,
  IntegrationSettings,
  IntegrationSetupFlow,
  IntegrationStatus,
  IntegrationTool,
} from './types.js';

export interface ChannelAsIntegrationOptions {
  name: string;
  description: string;
  credentials: CredentialRequirement[];
  category: IntegrationAdminPage['category'];
  getStatus: () => Promise<IntegrationStatus>;
  icon?: string;
  settings?: IntegrationSettings;
  tools?: IntegrationTool[];
  service?: IntegrationService;
  memory?: IntegrationMemory;
  setup?: IntegrationSetupFlow;
}

/**
 * Register an existing channel as an integration for admin UI visibility.
 *
 * NOTE: Does NOT set the `channel` property — the channel is already
 * registered via the legacy registerChannel() call. This avoids
 * double-registration in the channel startup loop.
 */
export function channelAsIntegration(opts: ChannelAsIntegrationOptions): void {
  registerIntegration({
    name: opts.name,
    description: opts.description,
    core: false,
    version: '1.0.0',
    credentials: opts.credentials,
    settings: opts.settings,
    adminPage: {
      icon:
        opts.icon ||
        `cil${opts.name.charAt(0).toUpperCase() + opts.name.slice(1)}`,
      category: opts.category,
      getStatus: async (ctx) => opts.getStatus(),
    },
    tools: opts.tools,
    service: opts.service,
    memory: opts.memory,
    setup: opts.setup,
  });
}
