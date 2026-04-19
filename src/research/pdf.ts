// Markdown-aware PDF renderer. Produces a real multi-page PDF with heading
// hierarchy, bulleted lists, paragraphs, and embedded JPEG images using only
// the standard Helvetica/Helvetica-Bold PostScript fonts built into every
// PDF viewer. Images are referenced from markdown as:
//   ![optional caption](name)
// where `name` is a key into the `images` map passed to createSimplePdf.

type FontKey = 'regular' | 'bold';

export interface PdfImage {
  /** Raw JPEG bytes (as produced by sharp .jpeg()). */
  buffer: Buffer;
  width: number;
  height: number;
}

interface TextBlock {
  kind: 'text';
  text: string;
  font: FontKey;
  size: number;
  spaceBefore: number;
  spaceAfter: number;
  indent: number;
  bullet: boolean;
  leading: number;
}

interface ImageBlock {
  kind: 'image';
  name: string;
  caption: string;
  spaceBefore: number;
  spaceAfter: number;
}

type RenderBlock = TextBlock | ImageBlock;

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
// Hard cap on a single image's rendered height so a tall portrait doesn't
// devour a whole page.
const MAX_IMAGE_HEIGHT = 320;
const DEFAULT_SIZE_BUDGET_BYTES = 1_048_576; // 1 MB

const WIN_ANSI_MAP: Record<string, number> = {
  '\u2022': 0x95,
  '\u2013': 0x96,
  '\u2014': 0x97,
  '\u2018': 0x91,
  '\u2019': 0x92,
  '\u201C': 0x93,
  '\u201D': 0x94,
  '\u2026': 0x85,
  '\u00A0': 0x20,
  '\u00A9': 0xa9,
  '\u00AE': 0xae,
  '\u2122': 0x99,
};

const ASCII_FALLBACK: Record<string, string> = {
  '\u2022': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2026': '...',
};

function escapePdfText(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') {
      out += '\\\\';
      continue;
    }
    if (char === '(') {
      out += '\\(';
      continue;
    }
    if (char === ')') {
      out += '\\)';
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      out += char;
      continue;
    }
    const mapped = WIN_ANSI_MAP[char];
    if (mapped !== undefined) {
      out += `\\${mapped.toString(8).padStart(3, '0')}`;
      continue;
    }
    if (ASCII_FALLBACK[char]) {
      out += ASCII_FALLBACK[char];
      continue;
    }
    if (code >= 0xa0 && code <= 0xff) {
      out += `\\${code.toString(8).padStart(3, '0')}`;
      continue;
    }
    out += '?';
  }
  return out;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

function approxCharWidth(char: string, size: number, font: FontKey): number {
  const narrow = 'ilrt!.,;:|\'"`/\\()[]{}';
  const wide = 'MW%@';
  let factor: number;
  if (narrow.includes(char)) factor = 0.33;
  else if (wide.includes(char)) factor = 0.9;
  else if (char === ' ') factor = 0.28;
  else factor = 0.55;
  if (font === 'bold') factor *= 1.06;
  return factor * size;
}

function measure(text: string, size: number, font: FontKey): number {
  let total = 0;
  for (const char of text) total += approxCharWidth(char, size, font);
  return total;
}

function wrapToWidth(
  text: string,
  size: number,
  font: FontKey,
  maxWidth: number,
): string[] {
  if (!text) return [''];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, size, font) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (measure(word, size, font) <= maxWidth) {
      current = word;
    } else {
      let remaining = word;
      while (
        measure(remaining, size, font) > maxWidth &&
        remaining.length > 1
      ) {
        let cut = remaining.length;
        while (
          cut > 1 &&
          measure(remaining.slice(0, cut), size, font) > maxWidth
        ) {
          cut -= 1;
        }
        lines.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
      current = remaining;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const IMAGE_LINE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/;

function parseMarkdownToBlocks(markdown: string): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let paragraphBuf: string[] = [];

  const flushParagraph = () => {
    if (!paragraphBuf.length) return;
    blocks.push({
      kind: 'text',
      text: stripInlineMarkdown(paragraphBuf.join(' ')),
      font: 'regular',
      size: 11,
      spaceBefore: 4,
      spaceAfter: 6,
      indent: 0,
      bullet: false,
      leading: 15,
    });
    paragraphBuf = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const imageMatch = trimmed.match(IMAGE_LINE_PATTERN);
    if (imageMatch) {
      flushParagraph();
      blocks.push({
        kind: 'image',
        caption: imageMatch[1].trim(),
        name: imageMatch[2].trim(),
        spaceBefore: 8,
        spaceAfter: 8,
      });
      continue;
    }

    if (trimmed.startsWith('# ')) {
      flushParagraph();
      blocks.push({
        kind: 'text',
        text: stripInlineMarkdown(trimmed.slice(2).trim()),
        font: 'bold',
        size: 22,
        spaceBefore: 12,
        spaceAfter: 10,
        indent: 0,
        bullet: false,
        leading: 28,
      });
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushParagraph();
      blocks.push({
        kind: 'text',
        text: stripInlineMarkdown(trimmed.slice(3).trim()),
        font: 'bold',
        size: 16,
        spaceBefore: 14,
        spaceAfter: 6,
        indent: 0,
        bullet: false,
        leading: 20,
      });
      continue;
    }
    if (trimmed.startsWith('### ')) {
      flushParagraph();
      blocks.push({
        kind: 'text',
        text: stripInlineMarkdown(trimmed.slice(4).trim()),
        font: 'bold',
        size: 13,
        spaceBefore: 10,
        spaceAfter: 4,
        indent: 0,
        bullet: false,
        leading: 17,
      });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({
        kind: 'text',
        text: stripInlineMarkdown(trimmed.replace(/^[-*]\s+/, '')),
        font: 'regular',
        size: 11,
        spaceBefore: 2,
        spaceAfter: 2,
        indent: 18,
        bullet: true,
        leading: 15,
      });
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      const match = trimmed.match(/^(\d+)\.\s+(.*)$/);
      blocks.push({
        kind: 'text',
        text: `${match?.[1]}. ${stripInlineMarkdown(match?.[2] || '')}`,
        font: 'regular',
        size: 11,
        spaceBefore: 2,
        spaceAfter: 2,
        indent: 18,
        bullet: false,
        leading: 15,
      });
      continue;
    }
    if (trimmed.startsWith('> ')) {
      flushParagraph();
      blocks.push({
        kind: 'text',
        text: stripInlineMarkdown(trimmed.slice(2)),
        font: 'regular',
        size: 11,
        spaceBefore: 4,
        spaceAfter: 4,
        indent: 24,
        bullet: false,
        leading: 15,
      });
      continue;
    }
    paragraphBuf.push(trimmed);
  }
  flushParagraph();
  return blocks;
}

type DrawOp =
  | {
      kind: 'text';
      font: FontKey;
      size: number;
      x: number;
      y: number;
      text: string;
    }
  | {
      kind: 'image';
      imageName: string;
      x: number;
      y: number;
      width: number;
      height: number;
    };

function layoutBlocks(
  blocks: RenderBlock[],
  images: Map<string, PdfImage>,
  usedImageNames: Set<string>,
): DrawOp[][] {
  const pages: DrawOp[][] = [];
  let current: DrawOp[] = [];
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const newPage = () => {
    if (current.length) pages.push(current);
    current = [];
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  for (const block of blocks) {
    if (block.kind === 'text') {
      const maxWidth = CONTENT_WIDTH - block.indent;
      const wrapped = wrapToWidth(block.text, block.size, block.font, maxWidth);
      y -= block.spaceBefore;
      for (let i = 0; i < wrapped.length; i++) {
        const lineText = wrapped[i];
        if (y - block.leading < MARGIN_BOTTOM) newPage();
        const x = MARGIN_X + block.indent;
        if (block.bullet && i === 0) {
          current.push({
            kind: 'text',
            font: 'regular',
            size: block.size,
            x: MARGIN_X + 6,
            y,
            text: '\u2022',
          });
        }
        current.push({
          kind: 'text',
          font: block.font,
          size: block.size,
          x,
          y,
          text: lineText,
        });
        y -= block.leading;
      }
      y -= block.spaceAfter;
      continue;
    }

    // Image block.
    const image = images.get(block.name);
    if (!image) {
      // Referenced image is missing — render a neutral caption so the section
      // doesn't get a silent gap.
      if (block.caption) {
        current.push({
          kind: 'text',
          font: 'regular',
          size: 10,
          x: MARGIN_X,
          y,
          text: `[image unavailable: ${block.caption}]`,
        });
        y -= 14;
      }
      continue;
    }
    const scaleByWidth = CONTENT_WIDTH / image.width;
    const scaleByHeight = MAX_IMAGE_HEIGHT / image.height;
    const scale = Math.min(1, scaleByWidth, scaleByHeight);
    const renderWidth = image.width * scale;
    const renderHeight = image.height * scale;
    const captionLines = block.caption
      ? wrapToWidth(
          stripInlineMarkdown(block.caption),
          10,
          'regular',
          CONTENT_WIDTH,
        )
      : [];
    const captionHeight = captionLines.length * 13;
    const totalHeight =
      block.spaceBefore + renderHeight + 6 + captionHeight + block.spaceAfter;
    if (y - totalHeight < MARGIN_BOTTOM) newPage();
    y -= block.spaceBefore;
    const imageX = MARGIN_X + (CONTENT_WIDTH - renderWidth) / 2;
    // In PDF coordinates the image's origin is bottom-left, so the y we store
    // is the baseline; the image draws upward from there.
    const imageBottomY = y - renderHeight;
    current.push({
      kind: 'image',
      imageName: block.name,
      x: imageX,
      y: imageBottomY,
      width: renderWidth,
      height: renderHeight,
    });
    usedImageNames.add(block.name);
    y = imageBottomY - 6;
    for (const line of captionLines) {
      current.push({
        kind: 'text',
        font: 'regular',
        size: 10,
        x: MARGIN_X + (CONTENT_WIDTH - measure(line, 10, 'regular')) / 2,
        y,
        text: line,
      });
      y -= 13;
    }
    y -= block.spaceAfter;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([]);
  return pages;
}

function buildPageStream(
  ops: DrawOp[],
  imageNameToXObjectName: Map<string, string>,
): string {
  const parts: string[] = [];
  let inText = false;
  let lastFont: FontKey | null = null;
  let lastSize: number | null = null;
  let lastX: number | null = null;
  let lastY: number | null = null;

  const openText = () => {
    if (!inText) {
      parts.push('BT');
      inText = true;
      lastFont = null;
      lastSize = null;
      lastX = null;
      lastY = null;
    }
  };
  const closeText = () => {
    if (inText) {
      parts.push('ET');
      inText = false;
    }
  };

  for (const op of ops) {
    if (op.kind === 'text') {
      openText();
      if (op.font !== lastFont || op.size !== lastSize) {
        const fontRef = op.font === 'bold' ? '/F2' : '/F1';
        parts.push(`${fontRef} ${op.size} Tf`);
        lastFont = op.font;
        lastSize = op.size;
      }
      if (lastX === null || lastY === null) {
        parts.push(`1 0 0 1 ${op.x} ${op.y} Tm`);
      } else {
        const dx = op.x - lastX;
        const dy = op.y - lastY;
        parts.push(`${dx} ${dy} Td`);
      }
      lastX = op.x;
      lastY = op.y;
      parts.push(`(${escapePdfText(op.text)}) Tj`);
    } else {
      closeText();
      const xobjectName = imageNameToXObjectName.get(op.imageName);
      if (!xobjectName) continue;
      // cm = current transformation matrix: scales the 1x1 unit image to
      // (width × height) and translates to (x, y).
      parts.push(
        `q ${op.width} 0 0 ${op.height} ${op.x} ${op.y} cm ${xobjectName} Do Q`,
      );
    }
  }
  closeText();
  return parts.join('\n');
}

interface AssembleInput {
  pages: DrawOp[][];
  usedImages: Array<{ name: string; image: PdfImage }>;
}

function assemblePdf(input: AssembleInput): Buffer {
  const { pages, usedImages } = input;
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  const write = (data: string | Buffer) => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    parts.push(buf);
    cursor += buf.byteLength;
  };
  const writeObject = (data: string | Buffer) => {
    offsets.push(cursor);
    write(data);
  };

  // Assign object IDs: 1=Catalog, 2=Pages, then page+content pairs, then
  // fonts, then images.
  let nextId = 3;
  const pageIds = pages.map(() => ({ page: nextId++, content: nextId++ }));
  const fontRegularId = nextId++;
  const fontBoldId = nextId++;
  const imageObjectIds = new Map<string, number>();
  const imageNameToXObjectName = new Map<string, string>();
  for (let i = 0; i < usedImages.length; i++) {
    imageObjectIds.set(usedImages[i].name, nextId);
    imageNameToXObjectName.set(usedImages[i].name, `/Im${i + 1}`);
    nextId += 1;
  }
  const totalObjects = nextId - 1;

  write('%PDF-1.4\n');
  // Ensure older readers skip any byte-flag sniffing.
  write('%\xe2\xe3\xcf\xd3\n');

  writeObject('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');

  const kids = pageIds.map((ids) => `${ids.page} 0 R`).join(' ');
  writeObject(
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >> endobj\n`,
  );

  for (let i = 0; i < pages.length; i++) {
    const ids = pageIds[i];
    const stream = buildPageStream(pages[i], imageNameToXObjectName);
    const xobjectDictEntries: string[] = [];
    for (const { name } of usedImages) {
      const xref = imageNameToXObjectName.get(name);
      const id = imageObjectIds.get(name);
      if (xref && id !== undefined) {
        xobjectDictEntries.push(`${xref} ${id} 0 R`);
      }
    }
    const xobjectDict = xobjectDictEntries.length
      ? ` /XObject << ${xobjectDictEntries.join(' ')} >>`
      : '';
    writeObject(
      `${ids.page} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >>${xobjectDict} >> /Contents ${ids.content} 0 R >> endobj\n`,
    );
    const streamBuf = Buffer.from(stream, 'latin1');
    writeObject(
      `${ids.content} 0 obj << /Length ${streamBuf.byteLength} >> stream\n`,
    );
    write(streamBuf);
    write('\nendstream endobj\n');
  }

  writeObject(
    `${fontRegularId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj\n`,
  );
  writeObject(
    `${fontBoldId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj\n`,
  );

  for (const { name, image } of usedImages) {
    const id = imageObjectIds.get(name);
    if (id === undefined) continue;
    writeObject(
      `${id} 0 obj << /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.buffer.byteLength} >> stream\n`,
    );
    write(image.buffer);
    write('\nendstream endobj\n');
  }

  const xrefOffset = cursor;
  write(`xref\n0 ${totalObjects + 1}\n`);
  write('0000000000 65535 f \n');
  for (let i = 0; i < totalObjects; i++) {
    write(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  write(`trailer << /Size ${totalObjects + 1} /Root 1 0 R >>\n`);
  write(`startxref\n${xrefOffset}\n%%EOF`);

  return Buffer.concat(parts);
}

export interface CreatePdfOptions {
  images?: Map<string, PdfImage>;
  /** Soft cap; images dropped from the end until the PDF fits. Default 1 MB. */
  maxSizeBytes?: number;
}

export function createSimplePdf(
  markdown: string,
  options?: CreatePdfOptions,
): Buffer {
  const sizeBudget = options?.maxSizeBytes ?? DEFAULT_SIZE_BUDGET_BYTES;
  const allImages = options?.images ?? new Map<string, PdfImage>();

  // Render once with every requested image. If over budget, iteratively drop
  // the last-used image and re-render until we fit. This is simpler than
  // rewriting the xref table post-hoc and almost always converges after 0-2
  // iterations.
  const blocks = parseMarkdownToBlocks(markdown);

  const render = (allowed: Map<string, PdfImage>): Buffer => {
    const usedNames = new Set<string>();
    const pages = layoutBlocks(blocks, allowed, usedNames);
    const usedImages: Array<{ name: string; image: PdfImage }> = [];
    for (const [name, image] of allowed.entries()) {
      if (usedNames.has(name)) usedImages.push({ name, image });
    }
    return assemblePdf({ pages, usedImages });
  };

  let working = new Map(allImages);
  let pdf = render(working);
  while (pdf.byteLength > sizeBudget && working.size > 0) {
    // Drop the image embedded last (insertion order = appearance order).
    const names = Array.from(working.keys());
    working.delete(names[names.length - 1]);
    pdf = render(working);
  }
  return pdf;
}
