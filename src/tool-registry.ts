import fs from 'fs';
import path from 'path';

import { ControlActionService } from './control-actions.js';
import { ControlStore } from './control-store.js';
import { ToolAccessPolicy } from './control-types.js';
import { getRegisteredIntegrations } from './integrations/registry.js';
import { isIntegrationEnabled } from './integrations/settings-store.js';

export interface EffectiveToolRegistryEntry {
  name: string;
  description: string;
  source: string;
  sourceKind: 'core-runner' | 'integration' | 'control-action';
  location: 'container' | 'host' | 'control-plane';
  agentVisible: boolean;
  controllerOnly: boolean;
  commandableAction?: boolean;
  interactiveView?: boolean;
  previewable?: boolean;
  toolType?: string;
  iconKey?: string;
  enabled: boolean;
  internalEnabled: boolean;
  externalEnabled: boolean;
}

export interface SessionToolRegistrySnapshot {
  tools: EffectiveToolRegistryEntry[];
  allowedToolNames: string[];
  integrationManifest: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    integration: string;
    controllerOnly?: boolean;
  }>;
}

interface CoreRunnerToolDefinition {
  name: string;
  description: string;
  controllerOnly: boolean;
}

const DEFAULT_TOOL_ACCESS_POLICY: ToolAccessPolicy = {
  internalToolsEnabled: true,
  externalToolsEnabled: true,
  tools: {},
  updatedAt: new Date(0).toISOString(),
};

let coreRunnerToolCache: CoreRunnerToolDefinition[] | null = null;

function normalizeDescription(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .join(' ')
    .replace(/^['"`]/, '')
    .replace(/['"`],?$/, '')
    .replace(/\\'/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCoreRunnerToolsFromSource(): CoreRunnerToolDefinition[] {
  const runnerSourcePath = path.resolve(
    process.cwd(),
    'container',
    'agent-runner',
    'src',
    'index.ts',
  );
  const source = fs.readFileSync(runnerSourcePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const tools: CoreRunnerToolDefinition[] = [];

  let inRegistry = false;
  let current: CoreRunnerToolDefinition | null = null;
  let readingDescription = false;
  let descriptionLines: string[] = [];

  for (const line of lines) {
    if (!inRegistry) {
      if (line.includes('const TOOL_REGISTRY: Record<string, ToolSpec> = {')) {
        inRegistry = true;
      }
      continue;
    }

    if (line.startsWith('};')) {
      break;
    }

    const toolStart = line.match(/^  ([a-zA-Z0-9_.-]+): \{$/);
    if (toolStart) {
      current = {
        name: toolStart[1],
        description: '',
        controllerOnly: false,
      };
      readingDescription = false;
      descriptionLines = [];
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.includes('controllerOnly: true')) {
      current.controllerOnly = true;
    }

    if (line.trim() === 'description:') {
      readingDescription = true;
      descriptionLines = [];
      continue;
    }

    if (readingDescription) {
      if (line.trim().startsWith('parameters:')) {
        current.description = normalizeDescription(descriptionLines);
        readingDescription = false;
        continue;
      }
      descriptionLines.push(line);
    }

    if (line.trim() === '},') {
      current.description =
        current.description || normalizeDescription(descriptionLines);
      tools.push(current);
      current = null;
      readingDescription = false;
      descriptionLines = [];
    }
  }

  return tools.filter((tool) => tool.name !== 'function');
}

export function getCoreRunnerToolDefinitions(): CoreRunnerToolDefinition[] {
  if (!coreRunnerToolCache) {
    coreRunnerToolCache = parseCoreRunnerToolsFromSource();
  }
  return coreRunnerToolCache;
}

export function getNormalizedToolAccessPolicy(
  policy?: ToolAccessPolicy,
): ToolAccessPolicy {
  return {
    internalToolsEnabled: policy?.internalToolsEnabled !== false,
    externalToolsEnabled: policy?.externalToolsEnabled !== false,
    tools: policy?.tools || {},
    updatedAt: policy?.updatedAt || DEFAULT_TOOL_ACCESS_POLICY.updatedAt,
  };
}

function resolveToolEnabled(
  toolName: string,
  policy: ToolAccessPolicy,
): boolean {
  return policy.tools[toolName]?.enabled !== false;
}

function resolveControllerOnly(
  toolName: string,
  defaultControllerOnly: boolean,
  policy: ToolAccessPolicy,
): boolean {
  const override = policy.tools[toolName]?.controllerOnly;
  return override === undefined ? defaultControllerOnly : override === true;
}

function resolveLaneEnabled(
  isInternal: boolean,
  enabled: boolean,
  controllerOnly: boolean,
  policy: ToolAccessPolicy,
): boolean {
  const globalEnabled = isInternal
    ? policy.internalToolsEnabled
    : policy.externalToolsEnabled;
  if (!globalEnabled || !enabled) {
    return false;
  }
  if (!isInternal && controllerOnly) {
    return false;
  }
  return true;
}

export function buildEffectiveToolRegistry(options?: {
  store?: ControlStore;
  service?: ControlActionService;
}): EffectiveToolRegistryEntry[] {
  const store = options?.store || new ControlStore();
  const service = options?.service || new ControlActionService(store);
  const toolPolicy = getNormalizedToolAccessPolicy(
    store.getPolicy().toolAccess,
  );

  const coreTools = getCoreRunnerToolDefinitions().map((tool) => {
    const enabled = resolveToolEnabled(tool.name, toolPolicy);
    const controllerOnly = resolveControllerOnly(
      tool.name,
      tool.controllerOnly,
      toolPolicy,
    );
    return {
      name: tool.name,
      description: tool.description,
      source: 'runner',
      sourceKind: 'core-runner' as const,
      location: 'container' as const,
      agentVisible: true,
      controllerOnly,
      enabled,
      internalEnabled: resolveLaneEnabled(
        true,
        enabled,
        controllerOnly,
        toolPolicy,
      ),
      externalEnabled: resolveLaneEnabled(
        false,
        enabled,
        controllerOnly,
        toolPolicy,
      ),
    };
  });

  const integrationTools = getRegisteredIntegrations().flatMap(
    (integration) => {
      if (!isIntegrationEnabled(integration.name) || !integration.tools) {
        return [];
      }
      return integration.tools
        .filter((tool) => tool.location === 'host')
        .map((tool) => {
          const enabled = resolveToolEnabled(tool.name, toolPolicy);
          const controllerOnly = resolveControllerOnly(
            tool.name,
            tool.controllerOnly === true,
            toolPolicy,
          );
          return {
            name: tool.name,
            description: tool.description,
            source: integration.name,
            sourceKind: 'integration' as const,
            location: tool.location,
            agentVisible: true,
            controllerOnly,
            enabled,
            internalEnabled: resolveLaneEnabled(
              true,
              enabled,
              controllerOnly,
              toolPolicy,
            ),
            externalEnabled: resolveLaneEnabled(
              false,
              enabled,
              controllerOnly,
              toolPolicy,
            ),
          };
        });
    },
  );

  const controlActions = service.listToolDefinitions().map((tool) => ({
    name: tool.name,
    description: '',
    source: 'control-plane',
    sourceKind: 'control-action' as const,
    location: 'control-plane' as const,
    agentVisible: false,
    controllerOnly: true,
    commandableAction: tool.commandableAction,
    interactiveView: tool.interactiveView,
    previewable: tool.previewable,
    toolType: tool.toolType,
    iconKey: tool.iconKey,
    enabled: false,
    internalEnabled: false,
    externalEnabled: false,
  }));

  return [...coreTools, ...integrationTools, ...controlActions].sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
}

export function buildSessionToolRegistrySnapshot(options: {
  groupFolder: string;
  isMain: boolean;
  controllerTriggered?: boolean;
  scheduledTaskMode?: boolean;
  store?: ControlStore;
  service?: ControlActionService;
}): SessionToolRegistrySnapshot {
  const effective = buildEffectiveToolRegistry({
    store: options.store,
    service: options.service,
  });
  const isInternal = options.isMain || options.controllerTriggered === true;

  const allowedToolNames = effective
    .filter((tool) => tool.agentVisible)
    .filter((tool) =>
      isInternal ? tool.internalEnabled : tool.externalEnabled,
    )
    .map((tool) => tool.name);

  const allowedSet = new Set(allowedToolNames);
  const integrationManifest = getRegisteredIntegrations().flatMap(
    (integration) => {
      if (!isIntegrationEnabled(integration.name) || !integration.tools) {
        return [];
      }
      return integration.tools
        .filter((tool) => tool.location === 'host')
        .filter((tool) => allowedSet.has(tool.name))
        .filter((tool) => {
          if (
            options.scheduledTaskMode &&
            tool.name.endsWith('.send_message')
          ) {
            return false;
          }
          return true;
        })
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          integration: integration.name,
          controllerOnly: tool.controllerOnly,
        }));
    },
  );

  const sessionAllowedNames = allowedToolNames.filter((toolName) =>
    options.scheduledTaskMode ? !toolName.endsWith('.send_message') : true,
  );

  return {
    tools: effective,
    allowedToolNames: sessionAllowedNames,
    integrationManifest,
  };
}
