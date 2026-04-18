import fs from 'fs';
import path from 'path';

import {
  getActionRecord,
  getChatPendingFollowupActionId,
  getRecentMessages,
} from '../db.js';
import { createChildLogger } from '../logger.js';
import { getDeepResearchService } from '../research/service.js';
import {
  BraveProvider,
  ExaProvider,
  type ResearchCategory,
  type ResearchProvider,
} from '../research/providers.js';

import { registerIntegration } from './registry.js';
import type { IntegrationDefinition } from './types.js';

const log = createChildLogger({ integration: 'deep-research' });

function getProvider(settings: Record<string, unknown>): ResearchProvider {
  const provider = String(settings.defaultProvider || 'exa');
  if (provider === 'exa') {
    const exaApiKey = String(
      settings.exaApiKey || process.env.EXA_API_KEY || '',
    );
    return new ExaProvider(exaApiKey);
  }
  const braveApiKey = String(
    settings.braveApiKey || process.env.BRAVE_API_KEY || '',
  );
  return new BraveProvider(braveApiKey);
}

function getLatestInboundSender(chatJid?: string): {
  senderId?: string;
  senderName?: string;
} {
  if (!chatJid) return {};
  const latestInbound = getRecentMessages(chatJid, 10)
    .filter((message) => !message.is_from_me)
    .at(-1);
  return latestInbound
    ? {
        senderId: latestInbound.sender,
        senderName: latestInbound.sender_name,
      }
    : {};
}

const deepResearchIntegration: IntegrationDefinition = {
  name: 'deep-research',
  description: 'Long-form deep research reports with PDF delivery',
  core: false,
  version: '1.0.0',
  credentials: [
    {
      key: 'EXA_API_KEY',
      label: 'Exa Search API Key',
      type: 'api_key',
      envVar: 'EXA_API_KEY',
      required: false,
    },
    {
      key: 'BRAVE_API_KEY',
      label: 'Brave Search API Key',
      type: 'api_key',
      envVar: 'BRAVE_API_KEY',
      required: false,
    },
  ],
  settings: {
    schema: {
      type: 'object',
      properties: {
        defaultProvider: {
          type: 'string',
          title: 'Default Provider',
          default: 'exa',
          enum: ['exa', 'brave'],
        },
        exaApiKey: {
          type: 'string',
          title: 'Exa API Key',
          sensitive: true,
        },
        braveApiKey: {
          type: 'string',
          title: 'Brave API Key',
          sensitive: true,
        },
        maxRuntimeMs: {
          type: 'integer',
          title: 'Max Runtime (ms)',
          default: 1200000,
          minimum: 60000,
          maximum: 3600000,
        },
        maxConcurrency: {
          type: 'integer',
          title: 'Max Concurrency',
          default: 2,
          minimum: 1,
          maximum: 10,
        },
        maxSearchCallsPerJob: {
          type: 'integer',
          title: 'Max Search Calls Per Job',
          default: 30,
          minimum: 1,
          maximum: 100,
        },
        maxFetchesPerJob: {
          type: 'integer',
          title: 'Max Fetches Per Job',
          default: 40,
          minimum: 1,
          maximum: 100,
        },
        dailyProviderQuota: {
          type: 'integer',
          title: 'Daily Provider Quota',
          default: 250,
          minimum: 1,
          maximum: 100000,
        },
        maxFollowups: {
          type: 'integer',
          title: 'Max Follow-ups',
          default: 2,
          minimum: 0,
          maximum: 5,
        },
        progressPingIntervalMs: {
          type: 'integer',
          title: 'Progress Ping Interval (ms)',
          default: 60000,
          minimum: 10000,
          maximum: 300000,
        },
        attachmentSizeCapBytes: {
          type: 'integer',
          title: 'Attachment Size Cap (bytes)',
          default: 25000000,
          minimum: 1000000,
          maximum: 100000000,
        },
        allowedPrincipalTypes: {
          type: 'array',
          title: 'Allowed Principal Types',
          items: { type: 'string' },
          default: ['controller'],
        },
        domainAllowlist: {
          type: 'array',
          title: 'Domain Allowlist',
          items: { type: 'string' },
          default: [],
        },
        domainBlocklist: {
          type: 'array',
          title: 'Domain Blocklist',
          items: { type: 'string' },
          default: [],
        },
      },
    },
    defaults: {
      defaultProvider: 'exa',
      maxRuntimeMs: 1200000,
      maxConcurrency: 2,
      maxSearchCallsPerJob: 30,
      maxFetchesPerJob: 40,
      dailyProviderQuota: 250,
      maxFollowups: 2,
      progressPingIntervalMs: 60000,
      attachmentSizeCapBytes: 25000000,
      allowedPrincipalTypes: ['controller'],
      domainAllowlist: [],
      domainBlocklist: [],
    },
  },
  adminPage: {
    icon: 'cilDescription',
    category: 'utility',
    getStatus: async (ctx) => {
      const provider = String(ctx.settings.defaultProvider || 'exa');
      const exaKey = String(
        ctx.settings.exaApiKey || process.env.EXA_API_KEY || '',
      );
      const braveKey = String(
        ctx.settings.braveApiKey || process.env.BRAVE_API_KEY || '',
      );
      const missing =
        (provider === 'exa' && !exaKey) || (provider === 'brave' && !braveKey);
      return {
        state: missing ? 'unconfigured' : 'online',
        message: missing
          ? `Configure a ${provider === 'exa' ? 'Exa' : 'Brave'} API key to enable deep research`
          : 'Deep research ready',
      };
    },
  },
  tools: [
    {
      name: 'deep_research_start',
      description:
        'Start a background deep research report for broad, comparative, source-heavy, or explicitly comprehensive requests. Do not use this for simple factual lookups. The tool result includes an "ack_text" field — after calling this tool, your final reply to the user MUST be exactly that ack_text with no additions, no emoji, no task IDs, and no rephrasing. Progress updates and the final PDF are delivered automatically; do not repeat or summarise them.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Research topic or brief' },
        },
        required: ['prompt'],
      },
      location: 'host',
      controllerOnly: true,
      execute: async (args, ctx) => {
        if (!ctx.chatJid) throw new Error('Chat context not available');
        const sender = getLatestInboundSender(ctx.chatJid);
        const prompt = String(args.prompt || '').trim();
        log.info(
          {
            chatJid: ctx.chatJid,
            groupFolder: ctx.sourceGroup,
            promptLength: prompt.length,
          },
          'deep_research_start tool invoked',
        );
        const result = await getDeepResearchService().start({
          prompt,
          groupFolder: ctx.sourceGroup,
          chatJid: ctx.chatJid,
          senderId: sender.senderId,
          senderName: sender.senderName,
        });
        const ackText = `Starting deep research on "${prompt}". I'll send the PDF report when it's ready.`;
        return JSON.stringify({
          ...result,
          ack_text: ackText,
          agent_instruction:
            'Reply to the user with ack_text verbatim. Do not add commentary, do not include task or run IDs, do not add emoji, do not rephrase.',
        });
      },
    },
    {
      name: 'deep_research_answer_followup',
      description:
        'Answer a pending deep research clarification in the current chat.',
      parameters: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: 'Follow-up answer text' },
          action_id: {
            type: 'string',
            description: 'Optional deep research action id',
          },
        },
        required: ['answer'],
      },
      location: 'host',
      controllerOnly: true,
      execute: async (args, ctx) => {
        const actionId =
          String(args.action_id || '').trim() ||
          (ctx.chatJid
            ? getChatPendingFollowupActionId(ctx.chatJid) || ''
            : '');
        if (!actionId) {
          throw new Error('No pending deep research follow-up for this chat');
        }
        const sender = getLatestInboundSender(ctx.chatJid);
        await getDeepResearchService().answerFollowup(
          actionId,
          String(args.answer || ''),
          sender.senderId,
        );
        return JSON.stringify({ ok: true, actionId });
      },
    },
    {
      name: 'deep_research_status',
      description: 'Check the status of the latest deep research job.',
      parameters: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
        },
      },
      location: 'host',
      controllerOnly: true,
      sideEffecting: false,
      execute: async (args, ctx) => {
        const actionId =
          String(args.action_id || '').trim() ||
          (ctx.chatJid
            ? getDeepResearchService().getLatestJobForChat(ctx.chatJid)?.id ||
              ''
            : '');
        if (!actionId) {
          throw new Error('No deep research job found for this chat');
        }
        return JSON.stringify(getDeepResearchService().getStatus(actionId));
      },
    },
    {
      name: 'deep_research_cancel',
      description: 'Cancel a deep research job.',
      parameters: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
        },
        required: ['action_id'],
      },
      location: 'host',
      controllerOnly: true,
      execute: async (args) => {
        const actionId = String(args.action_id || '').trim();
        getDeepResearchService().cancel(actionId);
        return JSON.stringify({ ok: true, actionId });
      },
    },
    {
      name: 'research_search',
      description:
        'Internal deep research search helper. Prefer deep_research_start for general use. Set `category` to "research paper" for academic sources, "news" for current events, "pdf" for whitepapers/reports, "company", "financial report", or "github". Omit for general web search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'integer' },
          category: {
            type: 'string',
            enum: [
              'research paper',
              'news',
              'pdf',
              'company',
              'financial report',
              'github',
              'personal site',
              'tweet',
              'linkedin profile',
            ],
          },
        },
        required: ['query'],
      },
      location: 'host',
      controllerOnly: true,
      sideEffecting: false,
      execute: async (args, ctx) => {
        const provider = getProvider(ctx.settings);
        const category = args.category ? String(args.category) : undefined;
        const results = await provider.search(String(args.query || ''), {
          maxResults: Number(args.max_results) || 5,
          includeDomains: Array.isArray(ctx.settings.domainAllowlist)
            ? ctx.settings.domainAllowlist.map(String)
            : [],
          excludeDomains: Array.isArray(ctx.settings.domainBlocklist)
            ? ctx.settings.domainBlocklist.map(String)
            : [],
          category: category as ResearchCategory | undefined,
        });
        return JSON.stringify(results);
      },
    },
    {
      name: 'research_fetch',
      description:
        'Internal deep research fetch helper. Prefer deep_research_start for general use.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
      location: 'host',
      controllerOnly: true,
      sideEffecting: false,
      execute: async (args, ctx) => {
        const provider = getProvider(ctx.settings);
        return JSON.stringify(await provider.fetch(String(args.url || '')));
      },
    },
    {
      name: 'research_read_workspace_file',
      description:
        'Read a workspace file for deep research. Paths must stay inside the current workspace group folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      location: 'host',
      controllerOnly: true,
      sideEffecting: false,
      execute: async (args, ctx) => {
        const base = path.resolve(process.cwd(), 'groups', ctx.sourceGroup);
        const target = path.resolve(base, String(args.path || ''));
        if (!target.startsWith(base)) {
          throw new Error('Workspace file path escapes group folder');
        }
        return fs.readFileSync(target, 'utf-8');
      },
    },
    {
      name: 'research_list_workspace_files',
      description:
        'List workspace files for deep research from the current group folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
      },
      location: 'host',
      controllerOnly: true,
      sideEffecting: false,
      execute: async (args, ctx) => {
        const base = path.resolve(process.cwd(), 'groups', ctx.sourceGroup);
        const target = path.resolve(base, String(args.path || '.'));
        if (!target.startsWith(base)) {
          throw new Error('Workspace file path escapes group folder');
        }
        return JSON.stringify(
          fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? 'directory' : 'file',
          })),
        );
      },
    },
    {
      name: 'research_save_report_artifact',
      description:
        'Internal helper to save a text report artifact under the current group folder.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['relative_path', 'content'],
      },
      location: 'host',
      controllerOnly: true,
      execute: async (args, ctx) => {
        const base = path.resolve(process.cwd(), 'groups', ctx.sourceGroup);
        const target = path.resolve(base, String(args.relative_path || ''));
        if (!target.startsWith(base)) {
          throw new Error('Artifact path escapes group folder');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(args.content || ''), 'utf-8');
        return JSON.stringify({ ok: true, path: target });
      },
    },
  ],
};

registerIntegration(deepResearchIntegration);
