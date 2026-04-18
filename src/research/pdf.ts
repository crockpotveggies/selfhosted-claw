// Minimal markdown-aware PDF renderer. Produces a real multi-page PDF with
// heading hierarchy, bulleted lists, and paragraphs, using only the standard
// Helvetica/Helvetica-Bold PostScript fonts built into every PDF viewer.

type FontKey = 'regular' | 'bold';

interface RenderBlock {
  text: string;
  font: FontKey;
  size: number;
  spaceBefore: number;
  spaceAfter: number;
  indent: number;
  bullet: boolean;
  leading: number;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

// Approximate character widths for Helvetica at 1pt, good enough for wrapping.
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
      // Hard split on overly long tokens (URLs, etc.).
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

function parseMarkdownToBlocks(markdown: string): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let paragraphBuf: string[] = [];

  const flushParagraph = () => {
    if (!paragraphBuf.length) return;
    blocks.push({
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

    if (trimmed.startsWith('# ')) {
      flushParagraph();
      blocks.push({
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

interface DrawOp {
  font: FontKey;
  size: number;
  x: number;
  y: number;
  text: string;
}

function layoutBlocks(blocks: RenderBlock[]): DrawOp[][] {
  const pages: DrawOp[][] = [];
  let current: DrawOp[] = [];
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const newPage = () => {
    if (current.length) pages.push(current);
    current = [];
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  for (const block of blocks) {
    const maxWidth = CONTENT_WIDTH - block.indent;
    const wrapped = wrapToWidth(block.text, block.size, block.font, maxWidth);
    y -= block.spaceBefore;
    for (let i = 0; i < wrapped.length; i++) {
      const lineText = wrapped[i];
      if (y - block.leading < MARGIN_BOTTOM) newPage();
      const x = MARGIN_X + block.indent;
      if (block.bullet && i === 0) {
        current.push({
          font: 'regular',
          size: block.size,
          x: MARGIN_X + 6,
          y,
          text: '\u2022',
        });
      }
      current.push({
        font: block.font,
        size: block.size,
        x,
        y,
        text: lineText,
      });
      y -= block.leading;
    }
    y -= block.spaceAfter;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([]);
  return pages;
}

function buildPageStream(ops: DrawOp[]): string {
  if (!ops.length) return 'BT ET';
  const parts: string[] = ['BT'];
  let lastFont: FontKey | null = null;
  let lastSize: number | null = null;
  let lastX: number | null = null;
  let lastY: number | null = null;
  for (const op of ops) {
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
  }
  parts.push('ET');
  return parts.join('\n');
}

export function createSimplePdf(text: string): Buffer {
  const blocks = parseMarkdownToBlocks(text);
  const pages = layoutBlocks(blocks);

  const objects: string[] = [];
  // 1 = Catalog, 2 = Pages, then per page (page + content), then 2 fonts.
  const pageObjectIds: Array<{ page: number; content: number }> = [];
  let nextId = 3;
  for (let i = 0; i < pages.length; i++) {
    pageObjectIds.push({ page: nextId++, content: nextId++ });
  }
  const fontRegularId = nextId++;
  const fontBoldId = nextId++;

  objects.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj');
  const kids = pageObjectIds.map((ids) => `${ids.page} 0 R`).join(' ');
  objects.push(
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pageObjectIds.length} >> endobj`,
  );
  for (let i = 0; i < pages.length; i++) {
    const ids = pageObjectIds[i];
    const stream = buildPageStream(pages[i]);
    objects.push(
      `${ids.page} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${ids.content} 0 R >> endobj`,
    );
    objects.push(
      `${ids.content} 0 obj << /Length ${Buffer.byteLength(stream, 'utf-8')} >> stream\n${stream}\nendstream endobj`,
    );
  }
  objects.push(
    `${fontRegularId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`,
  );
  objects.push(
    `${fontBoldId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj`,
  );

  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output, 'utf-8'));
    output += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(output, 'utf-8');
  output += `xref\n0 ${objects.length + 1}\n`;
  output += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    output += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, 'utf-8');
}
