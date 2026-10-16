// Exact page sizes for the vector PDF (docs/design-tool.md §Export). Chromium honours a CSS page size only in
// whole points and then rounds it to its 300 dpi print grid (a 400 pt page comes out 400.08 pt), so the
// renderer asks for a page a little larger than the frame, its content in the top-left corner, and this
// module then sets each page's /MediaBox to the frame's exact size: [0, H' − h, w, H'] where H' is the
// height Chromium wrote (PDF space grows upwards; the content hangs from the top).
//
// The input is Chromium's own output (Skia's PDF writer): a classic cross-reference table, one section, plain
// object dictionaries, no incremental updates. Anything else is left exactly as it is (`null`): the pages are
// then off by at most a point, which is better than a file a viewer cannot open.

const latin1 = (bytes: Uint8Array, from: number, to: number) => Buffer.from(bytes.buffer, bytes.byteOffset + from, to - from).toString('latin1');

type XrefEntry = {id: number; offset: number};

function readXref(pdf: Buffer): {entries: XrefEntry[]; xrefAt: number; trailer: string} | null {
  const tail = latin1(pdf, Math.max(0, pdf.length - 1024), pdf.length);
  const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!start) return null;
  const xrefAt = Number(start[1]);
  if (!Number.isSafeInteger(xrefAt) || xrefAt <= 0 || xrefAt >= pdf.length) return null;
  const table = latin1(pdf, xrefAt, pdf.length);
  const head = /^xref\r?\n0 (\d+)\r?\n/.exec(table);
  if (!head) return null;
  const count = Number(head[1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) return null;
  const entries: XrefEntry[] = [];
  let at = head[0].length;
  for (let id = 0; id < count; id++) {
    const line = /^(\d{10}) (\d{5}) ([nf])[ \r]?\r?\n/.exec(table.slice(at, at + 21));
    if (!line) return null;
    at += line[0].length;
    if (line[3] === 'n') entries.push({id, offset: Number(line[1])});
  }
  const trailer = /^trailer\s*(<<[\s\S]*?>>)\s*startxref/.exec(table.slice(at));
  if (!trailer || /\/Prev\b|\/XRefStm\b/.test(trailer[1])) return null;
  return {entries, xrefAt, trailer: trailer[1]};
}

const ref = (dict: string, key: string) => {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(dict);
  return match ? Number(match[1]) : null;
};

/** The dictionary part of an object (before any stream). */
function dictionaryOf(text: string): string {
  const stream = text.search(/>>\s*stream\r?\n/);
  return stream >= 0 ? text.slice(0, stream + 2) : text;
}

const number = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/**
 * Sets the pages' boxes to `sizes` (points, in page order). Returns the new file, or null when the file is not
 * the shape this reader knows or its page count differs from `sizes` (the caller then keeps Chromium's file).
 */
export function setPageSizes(pdf: Buffer, sizes: readonly {width: number; height: number}[]): Buffer | null {
  if (latin1(pdf, 0, Math.min(8, pdf.length)) !== '%PDF-1.4' && !latin1(pdf, 0, 5).startsWith('%PDF-')) return null;
  const xref = readXref(pdf);
  if (!xref) return null;
  const sorted = [...xref.entries].sort((a, b) => a.offset - b.offset);
  const spans = new Map<number, {from: number; to: number}>();
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i].offset, to = i + 1 < sorted.length ? sorted[i + 1].offset : xref.xrefAt;
    if (!(from > 0 && to > from && to <= xref.xrefAt)) return null;
    if (!latin1(pdf, from, Math.min(to, from + 24)).startsWith(`${sorted[i].id} 0 obj`)) return null;
    spans.set(sorted[i].id, {from, to});
  }
  const dict = (id: number) => {
    const span = spans.get(id);
    return span ? dictionaryOf(latin1(pdf, span.from, Math.min(span.to, span.from + 64 * 1024))) : null;
  };
  // Pages in order: the page tree from the catalog, depth first (Skia nests /Pages nodes for many pages).
  const root = ref(xref.trailer, 'Root');
  const catalog = root === null ? null : dict(root);
  const top = catalog ? ref(catalog, 'Pages') : null;
  if (top === null) return null;
  const pages: number[] = [];
  const walk = (id: number, depth: number): boolean => {
    const node = dict(id);
    if (!node || depth > 32) return false;
    if (/\/Type\s*\/Pages\b/.test(node)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node);
      if (!kids) return false;
      for (const kid of kids[1].matchAll(/(\d+)\s+0\s+R/g)) if (!walk(Number(kid[1]), depth + 1)) return false;
      return true;
    }
    if (/\/Type\s*\/Page\b/.test(node)) {
      pages.push(id);
      return pages.length <= sizes.length;
    }
    return false;
  };
  if (!walk(top, 0) || pages.length !== sizes.length) return null;

  const replaced = new Map<number, Buffer>();
  for (let i = 0; i < pages.length; i++) {
    const span = spans.get(pages[i])!;
    const text = latin1(pdf, span.from, span.to);
    const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(dictionaryOf(text));
    if (!box) return null;
    const [x0, y0, x1, y1] = box.slice(1).map(Number);
    const {width, height} = sizes[i];
    if (![x0, y0, x1, y1, width, height].every(Number.isFinite) || !(width > 0 && height > 0)) return null;
    // Chromium's page is at least the frame (the renderer asks for more); never grow it.
    const w = Math.min(width, x1 - x0), h = Math.min(height, y1 - y0);
    const next = `/MediaBox [${number(x0)} ${number(y1 - h)} ${number(x0 + w)} ${number(y1)}]`;
    replaced.set(pages[i], Buffer.from(text.slice(0, box.index) + next + text.slice(box.index + box[0].length), 'latin1'));
  }

  const parts: Buffer[] = [pdf.subarray(0, sorted[0].offset)];
  let length = parts[0].length;
  const offsets = new Map<number, number>();
  for (const {id} of sorted) {
    const span = spans.get(id)!;
    const bytes = replaced.get(id) ?? pdf.subarray(span.from, span.to);
    offsets.set(id, length);
    parts.push(bytes);
    length += bytes.length;
  }
  const size = Math.max(...xref.entries.map(entry => entry.id)) + 1;
  let table = `xref\n0 ${size}\n`;
  for (let id = 0; id < size; id++) {
    const offset = offsets.get(id);
    table += offset === undefined ? `0000000000 ${id === 0 ? '65535' : '00000'} f \n` : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  parts.push(Buffer.from(`${table}trailer\n${xref.trailer}\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** The /MediaBox of every page, in order (for tests and checks). */
export function pageBoxes(pdf: Buffer): number[][] | null {
  const xref = readXref(pdf);
  if (!xref) return null;
  const sorted = [...xref.entries].sort((a, b) => a.offset - b.offset);
  const text = new Map<number, string>();
  for (let i = 0; i < sorted.length; i++) text.set(sorted[i].id, dictionaryOf(latin1(pdf, sorted[i].offset, i + 1 < sorted.length ? sorted[i + 1].offset : xref.xrefAt)));
  const root = ref(xref.trailer, 'Root');
  const catalog = root === null ? undefined : text.get(root);
  const top = catalog ? ref(catalog, 'Pages') : null;
  const boxes: number[][] = [];
  const walk = (id: number, depth: number) => {
    const node = text.get(id);
    if (!node || depth > 32) return;
    if (/\/Type\s*\/Pages\b/.test(node)) {
      for (const kid of (/\/Kids\s*\[([^\]]*)\]/.exec(node)?.[1] ?? '').matchAll(/(\d+)\s+0\s+R/g)) walk(Number(kid[1]), depth + 1);
    } else {
      const box = /\/MediaBox\s*\[\s*([^\]]*)\]/.exec(node);
      if (box) boxes.push(box[1].trim().split(/\s+/).map(Number));
    }
  };
  if (top !== null) walk(top, 0);
  return boxes;
}
