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

// Try each candidate URL in turn, returning the first one that downloads and
// processes successfully. Useful when a source has both an og:image and
// several in-page imageLinks — many academic and PDF sources have no
// og:image but do have figures embedded in the page.
export async function processFirstUsableImage(
  candidates: string[],
  options?: ProcessImageOptions,
): Promise<ProcessedImage | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const processed = await processImageFromUrl(candidate, options);
    if (processed) return processed;
  }
  return null;
}

export async function processImageFromUrl(
  url: string,
  options?: ProcessImageOptions,
): Promise<ProcessedImage | null> {
  const maxWidth = options?.maxWidth ?? DEFAULT_MAX_WIDTH;
  let quality = options?.quality ?? DEFAULT_QUALITY;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

  // Resize + JPEG re-encode. If we overshoot the per-image byte budget we
  // iteratively drop quality. sharp handles every common input format and
  // converts transparent PNGs to JPEG with a white background automatically
  // when we flatten.
  try {
    let attempt = await sharp(raw)
      .rotate() // honor EXIF orientation
      .flatten({ background: '#ffffff' })
      .resize({
        width: maxWidth,
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    while (attempt.data.byteLength > maxSizeBytes && quality > 40) {
      quality -= 10;
      attempt = await sharp(raw)
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({
          width: maxWidth,
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
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
