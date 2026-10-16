import type {DesignDocument, ImageRef, Matrix, NodeId, SceneNode} from './types';
import type {FontSpec, TextMeasurer} from './text-layout';
import {IDENTITY, localMatrix, multiply, rectsIntersect, worldBox, worldMatrix, type Rect} from './geometry';
import {subtreeRenderBounds} from './bounds';
import {exportSvgPage, type SvgPage} from './svg-export';

// Vector PDF export (docs/design-tool.md §Export). The server draws the PDF from the stored document
// (server/design/pdf/): each page is the SVG exporter's print flavour, rendered by a sandboxed Chromium
// that prints vectors, real text with embedded fonts and the pictures' own pixels, and rasterizes only
// shadows and blurs. The one thing the server cannot do the way the editor does is measure text: the
// editor measures with its canvas and the fonts it has loaded, and line breaks follow those widths.
// So the editor runs the very same export first with a recording measurer and sends what it measured
// (`PdfMeasurements`: numbers, never markup); the server lays the text out again with those answers and
// gets the editor's lines exactly. Shared here so both sides make the same calls in the same order.

export const PDF_EXPORT_LIMITS = {
  /** Pages (frames) in one PDF. */
  pages: 50,
  /** Acrobat's page limit (200 inches). A larger frame is scaled down to fit, keeping its proportions. */
  pageSide: 14_400,
  /** Distinct fonts (family, weight, slant, size) and measured strings in one request. */
  fonts: 4_000,
  widths: 250_000,
  textLength: 2_000,
  titleLength: 200,
  /** The request body (the measurements are most of it). */
  bodyBytes: 12 * 1024 * 1024,
  /** Chromium rasterizes what a PDF cannot hold (shadows, blurs) at 300 dpi. */
  rasterDpi: 300,
  /** Pixels of those rasters: the largest single one, and all of one export together (millions). */
  rasterMegapixels: 96,
  rasterMegapixelsTotal: 240,
} as const;

// ── Measurements ─────────────────────────────────────────────────────────────────────────────────

/** [family, weight, italic (1) or not (0), size, ascent, descent]; metrics are null when never asked. */
export type PdfFontEntry = [string, number, 0 | 1, number, number | null, number | null];
/** [index into `fonts`, text, advance width]. */
export type PdfWidthEntry = [number, string, number];
export type PdfMeasurements = {fonts: PdfFontEntry[]; widths: PdfWidthEntry[]};

const fontKey = (family: string, weight: number, italic: boolean, size: number) => `${family}\u0000${weight}\u0000${italic ? 1 : 0}\u0000${size}`;
const keyOf = (font: FontSpec) => fontKey(font.family, font.weight, font.italic, font.size);

/** Wraps the editor's measurer: answers as it does and remembers every question and answer. */
export function recordMeasurements(base: TextMeasurer): {measurer: TextMeasurer; table(): PdfMeasurements} {
  const index = new Map<string, number>();
  const fonts: PdfFontEntry[] = [];
  const widths = new Map<string, Map<string, number>>();
  const fontOf = (font: FontSpec): number => {
    const key = keyOf(font);
    let at = index.get(key);
    if (at === undefined) {
      at = fonts.length;
      index.set(key, at);
      fonts.push([font.family, font.weight, font.italic ? 1 : 0, font.size, null, null]);
    }
    return at;
  };
  const measurer: TextMeasurer = {
    get revision() {
      return base.revision;
    },
    width(text, font) {
      const width = base.width(text, font);
      if (text) {
        const key = keyOf(font);
        fontOf(font);
        let table = widths.get(key);
        if (!table) widths.set(key, (table = new Map()));
        table.set(text, width);
      }
      return width;
    },
    metrics(font) {
      const metrics = base.metrics(font);
      const entry = fonts[fontOf(font)];
      entry[4] = Number.isFinite(metrics.ascent) ? metrics.ascent : null;
      entry[5] = Number.isFinite(metrics.descent) ? metrics.descent : null;
      return metrics;
    },
  };
  return {
    measurer,
    table() {
      const out: PdfWidthEntry[] = [];
      for (const [key, table] of widths) {
        const at = index.get(key)!;
        for (const [text, width] of table) out.push([at, text, Number.isFinite(width) ? width : 0]);
      }
      return {fonts: fonts.map(entry => [...entry] as PdfFontEntry), widths: out};
    },
  };
}

/** A measurer that answers from a table; a question the table cannot answer is counted in `misses`
 *  and answered with an estimate (the document changed, or the editor runs other code). */
export type ReplayMeasurer = TextMeasurer & {readonly misses: number};

export function replayMeasurements(table: PdfMeasurements): ReplayMeasurer {
  const metrics = new Map<string, {ascent: number; descent: number} | null>();
  const widths = new Map<string, Map<string, number>>();
  const keys: string[] = [];
  for (const [family, weight, italic, size, ascent, descent] of table.fonts) {
    const key = fontKey(family, weight, italic === 1, size);
    keys.push(key);
    metrics.set(key, ascent === null || descent === null ? null : {ascent, descent});
    widths.set(key, new Map());
  }
  for (const [at, text, width] of table.widths) widths.get(keys[at])?.set(text, width);
  let misses = 0;
  return {
    get misses() {
      return misses;
    },
    width(text, font) {
      if (!text) return 0;
      const width = widths.get(keyOf(font))?.get(text);
      if (width !== undefined) return width;
      misses++;
      // About an average Latin/Cyrillic advance: the text is still drawn, its lines may break elsewhere.
      return [...text].length * font.size * 0.55;
    },
    metrics(font) {
      const known = metrics.get(keyOf(font));
      if (known) return known;
      misses++;
      // Zero tells text layout to use its own fallback metrics.
      return {ascent: 0, descent: 0};
    },
  };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Checks a measurement table from a request (plain loops: up to 250 000 entries). Null when it is malformed. */
export function readMeasurements(value: unknown): PdfMeasurements | null {
  if (!value || typeof value !== 'object') return null;
  const {fonts, widths} = value as {fonts?: unknown; widths?: unknown};
  if (!Array.isArray(fonts) || !Array.isArray(widths)) return null;
  if (fonts.length > PDF_EXPORT_LIMITS.fonts || widths.length > PDF_EXPORT_LIMITS.widths) return null;
  for (const entry of fonts) {
    if (!Array.isArray(entry) || entry.length !== 6) return null;
    const [family, weight, italic, size, ascent, descent] = entry;
    if (typeof family !== 'string' || family.length > 200 || !finite(weight) || (italic !== 0 && italic !== 1) || !finite(size)) return null;
    if ((ascent !== null && !finite(ascent)) || (descent !== null && !finite(descent))) return null;
  }
  for (const entry of widths) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [at, text, width] = entry;
    if (!Number.isInteger(at) || at < 0 || at >= fonts.length || typeof text !== 'string' || text.length > PDF_EXPORT_LIMITS.textLength || !finite(width)) return null;
  }
  return {fonts: fonts as PdfFontEntry[], widths: widths as PdfWidthEntry[]};
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────

/** What one page draws: the layer itself, or for a slice whatever its page shows inside it. */
export type PdfPagePlan = {id: NodeId; ids: NodeId[]; crop?: Rect};

export function pdfPagePlan(doc: DesignDocument, id: NodeId): PdfPagePlan | null {
  if (typeof id !== 'string' || !Object.hasOwn(doc.nodes, id)) return null;
  const node = doc.nodes[id];
  if (!node || node.type === 'PAGE') return null;
  if (node.type !== 'SLICE') return {id, ids: [id]};
  let page: SceneNode | undefined = node;
  while (page && page.type !== 'PAGE') page = page.parentId ? doc.nodes[page.parentId] : undefined;
  if (!page) return null;
  const crop = worldBox(doc, id);
  if (!(crop.width > 0 && crop.height > 0)) return null;
  // Only the page's layers that reach into the slice: a small slice of a large page stays small.
  const ids = (page.children ?? []).filter(child => {
    const each = doc.nodes[child];
    if (!each || each.type === 'SLICE' || !each.visible) return false;
    const box = subtreeRenderBounds(doc, each, localMatrix(each));
    return !!box && rectsIntersect(box, crop);
  });
  return {id, ids, crop};
}

/** Options both sides pass to the exporter for page `index`. */
export type PdfSvgOptions = {measurer: TextMeasurer; imageHref?: (ref: ImageRef) => string | undefined};

/** The SVG of one page, exactly as the server renders it (the editor runs it only to record measurements). */
export function pdfPageSvg(doc: DesignDocument, plan: PdfPagePlan, index: number, options: PdfSvgOptions): SvgPage {
  return exportSvgPage(doc, plan.ids, {measurer: options.measurer, imageHref: options.imageHref, print: true, idPrefix: `p${index}_`, crop: plan.crop});
}

/** The page size in points (1 px = 1 pt, as design tools do), scaled down to fit PDF's page limit. */
export function pdfPageSize(bounds: Rect): {width: number; height: number; scale: number} {
  const width = Math.max(1, bounds.width), height = Math.max(1, bounds.height);
  const scale = Math.min(1, PDF_EXPORT_LIMITS.pageSide / Math.max(width, height));
  return {width: width * scale, height: height * scale, scale};
}

/** Pages in reading order: rows from the top, each row from the left (Figma's order for frames). A frame
 *  joins the row whose top band it starts in. */
export function readingOrder(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const boxes = ids.filter(id => doc.nodes[id]).map(id => ({id, box: worldBox(doc, id)}));
  boxes.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: {bottom: number; items: typeof boxes}[] = [];
  for (const item of boxes) {
    const row = rows[rows.length - 1];
    if (row && item.box.y < row.bottom) {
      row.items.push(item);
      row.bottom = Math.min(row.bottom, item.box.y + Math.max(item.box.height, 1));
    } else rows.push({bottom: item.box.y + Math.max(item.box.height, 1), items: [item]});
  }
  return rows.flatMap(row => row.items.sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y).map(item => item.id));
}

// ── What the server needs to know about a page ───────────────────────────────────────────────────

/** Families the visible text of the page sets type in (base styles and runs). */
export function textFamilies(doc: DesignDocument, ids: readonly NodeId[]): Set<string> {
  const families = new Set<string>();
  const stack = [...ids];
  let guard = 0;
  while (stack.length && guard++ < 1_000_000) {
    const node = doc.nodes[stack.pop()!];
    if (!node || !node.visible) continue;
    if (node.text) {
      families.add(node.text.style.fontFamily);
      for (const run of node.text.runs) if (run.style.fontFamily) families.add(run.style.fontFamily);
    }
    if (node.children) stack.push(...node.children);
  }
  return families;
}

/** Areas (pt², within the page) that Chromium rasterizes for shadows and blurs: each drop or inner
 *  shadow is one raster of the layer and its reach, a layer blur one raster of the whole layer. */
export function effectRasters(doc: DesignDocument, plan: PdfPagePlan, page: Rect, measurer?: TextMeasurer): number[] {
  const areas: number[] = [];
  const visit = (node: SceneNode | undefined, world: Matrix, depth: number) => {
    if (!node || !node.visible || node.type === 'SLICE' || depth > 256) return;
    const effects = node.effects.filter(e => e.visible);
    const blur = effects.some(e => e.type === 'LAYER_BLUR' && e.radius > 0);
    const shadows = effects.filter(e => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW').length;
    if (blur || shadows) {
      const box = subtreeRenderBounds(doc, node, world, {measurer});
      const x = box ? Math.max(box.x, page.x) : 0, y = box ? Math.max(box.y, page.y) : 0;
      const w = box ? Math.min(box.x + box.width, page.x + page.width) - x : 0;
      const h = box ? Math.min(box.y + box.height, page.y + page.height) - y : 0;
      if (w > 0 && h > 0) for (let n = 0; n < (blur ? 1 : shadows); n++) areas.push(w * h);
      if (blur) return;
    }
    for (const child of node.children ?? []) {
      const each = doc.nodes[child];
      if (each) visit(each, multiply(world, localMatrix(each)), depth + 1);
    }
  };
  for (const id of plan.ids) {
    const node = doc.nodes[id];
    if (node) visit(node, node.type === 'PAGE' ? IDENTITY : worldMatrix(doc, id), 0);
  }
  return areas;
}

/** Megapixels of a raster of `area` pt² at the PDF's raster resolution, on a page scaled by `scale`. */
export const rasterMegapixels = (area: number, scale = 1) => (area * scale * scale * (PDF_EXPORT_LIMITS.rasterDpi / 72) ** 2) / 1e6;
