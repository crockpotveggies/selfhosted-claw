function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapText(text: string, width = 90): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    let remaining = trimmed;
    while (remaining.length > width) {
      let splitAt = remaining.lastIndexOf(' ', width);
      if (splitAt < Math.floor(width / 2)) splitAt = width;
      lines.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

export function createSimplePdf(text: string): Buffer {
  const lines = wrapText(text, 88);
  const pageHeight = 792;
  const top = 760;
  const lineHeight = 14;
  const linesPerPage = 48;
  const pages: Array<{ contentId: number; pageId: number; stream: string }> =
    [];
  let objectId = 3;

  for (let index = 0; index < lines.length; index += linesPerPage) {
    const pageLines = lines.slice(index, index + linesPerPage);
    const contentOps = [
      'BT',
      '/F1 11 Tf',
      `50 ${top} Td`,
      ...pageLines.flatMap((line, lineIndex) => {
        const escaped = escapePdfText(line || ' ');
        if (lineIndex === 0) {
          return [`(${escaped}) Tj`];
        }
        return [`0 -${lineHeight} Td`, `(${escaped}) Tj`];
      }),
      'ET',
    ].join('\n');
    const pageId = objectId++;
    const contentId = objectId++;
    pages.push({ pageId, contentId, stream: contentOps });
  }

  const objects: string[] = [];
  objects.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj');
  const kids = pages.map((page) => `${page.pageId} 0 R`).join(' ');
  objects.push(
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages.length} >> endobj`,
  );
  for (const page of pages) {
    objects.push(
      `${page.pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << /F1 ${objectId} 0 R >> >> /Contents ${page.contentId} 0 R >> endobj`,
    );
    objects.push(
      `${page.contentId} 0 obj << /Length ${Buffer.byteLength(page.stream, 'utf-8')} >> stream\n${page.stream}\nendstream endobj`,
    );
  }
  objects.push(
    `${objectId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`,
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
  for (let index = 1; index < offsets.length; index++) {
    output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, 'utf-8');
}
