// Image processing for deep research reports. Downloads source imagery
// (og:image URLs returned by Exa) and normalizes everything to modestly
// sized JPEG so we can embed it in a PDF without blowing the size budget.

import sharp from 'sharp';

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ integration: 'deep-research' });

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  mediaType: 'image/jpeg';
  sourceUrl: string;
  sizeBytes: number;
}

export interface ProcessImageOptions {
  maxWidth?: number;
  quality?: number;
  maxSizeBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_WIDTH = 600;
const DEFAULT_QUALITY = 70;
const DEFAULT_MAX_SIZE_BYTES = 120_000;
const DEFAULT_TIMEOUT_MS = 10_000;
// Bound the downloaded bytes. og:image URLs occasionally point at huge
// upscaled originals; refuse anything absurd before pushing through sharp.
const DOWNLOAD_BYTE_CAP = 15 * 1024 * 1024;

// Quality gate thresholds. These are aimed at filtering out company logos,
// favicons, social-share thumbnails, and stock placeholder graphics that
// previously made it through. Values are conservative — better to drop a
// borderline image than to embed a low-signal logo.
const MIN_LONG_EDGE = 400; // shortest acceptable longer edge in pixels
const MIN_PIXEL_AREA = 120_000; // ~346x346, knocks out small logos
const SQUARE_MIN_LONG_EDGE = 700; // square images must be large to count
const SQUARE_ASPECT_RATIO = 1.15; // |w/h| within this is "square"
const MAX_ASPECT_RATIO = 4.0; // banners wider than this are usually decoration
const MIN_ENTROPY = 4.5; // sharp .stats() shannon entropy in bits, 0-8

// URL substrings that almost always indicate a logo, icon, or boilerplate
// asset rather than substantive content. Matched case-insensitively against
// the full URL.
const URL_BLOCK_PATTERNS = [
  '/logo',
  '/logos/',
  '-logo.',
  '_logo.',
  'logo.png',
  'logo.svg',
  'logo.jpg',
  '/icon',
  '/icons/',
  '-icon.',
  '_icon.',
  'apple-touch-icon',
  'favicon',
  '/avatar',
  '/avatars/',
  'gravatar',
  'placeholder',
  'og-image-default',
  'default-og',
  'sprite.',
  '/badge',
];

function isLikelyLogoUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return URL_BLOCK_PATTERNS.some((pattern) => lower.includes(pattern));
}

interface QualityMeasurements {
  width: number;
  height: number;
  area: number;
  aspect: number;
  entropy: number;
}

type QualityVerdict =
  | { ok: true; measurements: QualityMeasurements }
  | { ok: false; reason: string; details?: Record<string, number> };

// Inspect the *original* (pre-resize) image dimensions and entropy to decide
// whether it carries enough visual information to belong in a research
// report. Runs before the expensive resize so we abort early on obvious
// non-content imagery, and returns its measurements on success so the
// candidate scorer doesn't have to re-decode.
async function assessQuality(raw: Buffer): Promise<QualityVerdict> {
  let metadata: sharp.Metadata;
  let stats: sharp.Stats;
  try {
    const pipeline = sharp(raw);
    metadata = await pipeline.metadata();
    stats = await pipeline.stats();
  } catch (err) {
    return {
      ok: false,
      reason: `metadata failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) {
    return { ok: false, reason: 'unknown dimensions' };
  }
  const longEdge = Math.max(width, height);
  const area = width * height;
  const aspect = width / height;
  const entropy = stats.entropy ?? 0;

  if (longEdge < MIN_LONG_EDGE) {
    return {
      ok: false,
      reason: 'too small (long edge)',
      details: { width, height, longEdge },
    };
  }
  if (area < MIN_PIXEL_AREA) {
    return {
      ok: false,
      reason: 'too small (area)',
      details: { width, height, area },
    };
  }
  if (
    aspect > 1 / SQUARE_ASPECT_RATIO &&
    aspect < SQUARE_ASPECT_RATIO &&
    longEdge < SQUARE_MIN_LONG_EDGE
  ) {
    return {
      ok: false,
      reason: 'square logo-shaped',
      details: { width, height, aspect },
    };
  }
  if (aspect > MAX_ASPECT_RATIO || aspect < 1 / MAX_ASPECT_RATIO) {
    return {
      ok: false,
      reason: 'extreme aspect ratio (banner-like)',
      details: { width, height, aspect },
    };
  }
  if (entropy < MIN_ENTROPY) {
    return {
      ok: false,
      reason: 'low entropy (uniform / logo-like)',
      details: { entropy },
    };
  }
  return { ok: true, measurements: { width, height, area, aspect, entropy } };
}

async function downloadBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'self-hosted-claw deep research',
        Accept: 'image/*',
      },
    });
    if (!response.ok) {
      throw new Error(
        `Image download failed (${response.status}): ${response.statusText}`,
      );
    }
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader) {
      const declared = Number(lengthHeader);
      if (Number.isFinite(declared) && declared > DOWNLOAD_BYTE_CAP) {
        throw new Error(`Image declared ${declared} bytes exceeds cap`);
      }
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > DOWNLOAD_BYTE_CAP) {
      throw new Error(`Image size ${buffer.byteLength} exceeds cap`);
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

interface CandidateEvaluation {
  url: string;
  raw: Buffer;
  measurements: QualityMeasurements;
  score: number;
}

// How many candidates to download + evaluate per source. More gives the
// scorer more material to choose from but multiplies bandwidth. 4 strikes
// a good balance against typical Exa imageLinks lists.
const RANKING_CANDIDATE_LIMIT = 4;

// Score = entropy (info content) × sqrt(area) (visibility). Squaring
// dampens the area term so a giant uniform image doesn't beat a smaller
// busy one. Entropy at ~7.5 bits + 800x600 area gives ~5800; a logo at
// ~3.5 bits + 200x200 gives ~700.
function scoreCandidate(measurements: QualityMeasurements): number {
  return measurements.entropy * Math.sqrt(measurements.area);
}

async function evaluateCandidate(
  url: string,
  timeoutMs: number,
): Promise<CandidateEvaluation | null> {
  if (isLikelyLogoUrl(url)) {
    log.info({ url }, 'Image rejected by URL pattern (logo/icon)');
    return null;
  }
  let raw: Buffer;
  try {
    raw = await downloadBytes(url, timeoutMs);
  } catch (err) {
    log.warn(
      { url, err: err instanceof Error ? err.message : String(err) },
      'Image download failed',
    );
    return null;
  }
  const verdict = await assessQuality(raw);
  if (!verdict.ok) {
    log.info(
      { url, reason: verdict.reason, ...(verdict.details || {}) },
      'Image rejected by quality gate',
    );
    return null;
  }
  return {
    url,
    raw,
    measurements: verdict.measurements,
    score: scoreCandidate(verdict.measurements),
  };
}

// Evaluate up to RANKING_CANDIDATE_LIMIT candidates in parallel, score each
// surviving image by entropy × sqrt(area), and compress only the winner.
// This biases selection toward the most informative image per source — a
// chart or diagram beats a small logo or hero photo.
export async function processFirstUsableImage(
  candidates: string[],
  options?: ProcessImageOptions,
): Promise<ProcessedImage | null> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const slice = candidates
    .filter((c) => Boolean(c))
    .slice(0, RANKING_CANDIDATE_LIMIT);
  if (!slice.length) return null;

  const evaluated = await Promise.all(
    slice.map((url) => evaluateCandidate(url, timeoutMs)),
  );
  const survivors = evaluated.filter(
    (entry): entry is CandidateEvaluation => entry !== null,
  );
  if (!survivors.length) return null;
  survivors.sort((a, b) => b.score - a.score);
  const winner = survivors[0];

  log.info(
    {
      winnerUrl: winner.url,
      winnerScore: Math.round(winner.score),
      winnerWidth: winner.measurements.width,
      winnerHeight: winner.measurements.height,
      winnerEntropy: Number(winner.measurements.entropy.toFixed(2)),
      candidatesEvaluated: slice.length,
      survivors: survivors.length,
    },
    'Selected best image candidate',
  );

  return compressToJpeg(winner.url, winner.raw, options);
}

// Resize + JPEG re-encode. If we overshoot the per-image byte budget we
// iteratively drop quality down to 40. sharp handles every common input
// format and flattens transparent PNGs onto white before JPEG encoding.
async function compressToJpeg(
  url: string,
  raw: Buffer,
  options?: ProcessImageOptions,
): Promise<ProcessedImage | null> {
  const maxWidth = options?.maxWidth ?? DEFAULT_MAX_WIDTH;
  let quality = options?.quality ?? DEFAULT_QUALITY;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;

  const encode = (q: number) =>
    sharp(raw)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality: q, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

  try {
    let attempt = await encode(quality);
    while (attempt.data.byteLength > maxSizeBytes && quality > 40) {
      quality -= 10;
      attempt = await encode(quality);
    }
    if (attempt.data.byteLength > maxSizeBytes) {
      log.warn(
        {
          url,
          finalQuality: quality,
          finalBytes: attempt.data.byteLength,
          maxSizeBytes,
        },
        'Image too large after compression, dropping',
      );
      return null;
    }
    log.info(
      {
        url,
        sizeBytes: attempt.data.byteLength,
        width: attempt.info.width,
        height: attempt.info.height,
        quality,
      },
      'Image processed for report',
    );
    return {
      buffer: attempt.data,
      width: attempt.info.width,
      height: attempt.info.height,
      mediaType: 'image/jpeg',
      sourceUrl: url,
      sizeBytes: attempt.data.byteLength,
    };
  } catch (err) {
    log.warn(
      { url, err: err instanceof Error ? err.message : String(err) },
      'Image processing failed',
    );
    return null;
  }
}

export async function processImageFromUrl(
  url: string,
  options?: ProcessImageOptions,
): Promise<ProcessedImage | null> {
  return processFirstUsableImage([url], options);
}
