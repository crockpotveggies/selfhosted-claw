// Multimodal image description via an OpenAI-compatible chat completions
// endpoint (e.g. vLLM serving a vision-capable model). Used to filter out
// uninformative imagery (logos, stock photos, decorative covers) and to
// give the section drafter a short description of each image so it can
// match visuals to the claim they support.

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ integration: 'deep-research' });

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  timeoutMs?: number;
}

export type ImageKind =
  | 'chart'
  | 'diagram'
  | 'screenshot'
  | 'map'
  | 'photo'
  | 'portrait'
  | 'logo'
  | 'text'
  | 'other';

export interface ImageDescription {
  description: string;
  kind: ImageKind;
  is_informative: boolean;
}

const VALID_KINDS: ReadonlySet<ImageKind> = new Set<ImageKind>([
  'chart',
  'diagram',
  'screenshot',
  'map',
  'photo',
  'portrait',
  'logo',
  'text',
  'other',
]);

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_DESCRIPTION_CHARS = 400;

function extractJson(raw: string): unknown {
  const fenceStripped = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(fenceStripped);
  } catch {
    const first = fenceStripped.indexOf('{');
    const last = fenceStripped.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(fenceStripped.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Returns null if vision is disabled, unsupported by the endpoint, or the
// response was unparseable. Callers should treat null as "fall back to
// heuristic-only filtering" rather than an error.
export async function describeImage(
  jpegBuffer: Buffer,
  context: { topic: string; sourceTitle: string; sourceUrl: string },
  config: VisionConfig,
): Promise<ImageDescription | null> {
  if (!config.enabled) return null;
  if (!config.baseUrl || !config.model) {
    log.info(
      { baseUrl: config.baseUrl, model: config.model },
      'Vision endpoint not configured, skipping',
    );
    return null;
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dataUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.1,
          max_tokens: 300,
          response_format: { type: 'json_object' },
          // Qwen3 / vLLM-specific. Harmless on endpoints that ignore unknown
          // fields; keeps thinking-mode off so we get straight JSON back.
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            {
              role: 'system',
              content: [
                'You analyze a single image from a research source and return JSON with keys: description, kind, is_informative.',
                '- description: 1-2 sentences, concrete, specific. Mention labeled axes, data, entities, or scenes. No fluff.',
                '- kind: one of "chart", "diagram", "screenshot", "map", "photo", "portrait", "logo", "text", "other".',
                '- is_informative: true if the image conveys substantive research value; false for brand logos, decorative covers, stock photos, generic hero images, or author headshots.',
                'Rules: a logo is never informative. A stock photo (person at laptop, handshake, abstract tech) is never informative. A chart, technical diagram, map, or screenshot of data usually is. When uncertain, prefer is_informative=false.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Research topic: ${context.topic}\nSource title: ${context.sourceTitle}\nWhat does this image show, and is it informative for the research report?`,
                },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.info(
        {
          url: context.sourceUrl,
          status: response.status,
          body: body.slice(0, 240),
        },
        'Vision endpoint returned error, falling back to heuristic filter',
      );
      return null;
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = payload.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(raw) as Partial<ImageDescription> | null;
    if (!parsed || typeof parsed.description !== 'string') {
      log.info(
        { url: context.sourceUrl, rawHead: String(raw).slice(0, 120) },
        'Vision response not parseable as JSON',
      );
      return null;
    }
    const rawKind = String(parsed.kind || '')
      .toLowerCase()
      .trim();
    const kind: ImageKind = VALID_KINDS.has(rawKind as ImageKind)
      ? (rawKind as ImageKind)
      : 'other';
    return {
      description: parsed.description.trim().slice(0, MAX_DESCRIPTION_CHARS),
      kind,
      is_informative: Boolean(parsed.is_informative),
    };
  } catch (err) {
    log.info(
      {
        url: context.sourceUrl,
        err: err instanceof Error ? err.message : String(err),
      },
      'Vision call failed, falling back to heuristic filter',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
