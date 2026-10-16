// Lane L3's browser harness: the same documents laid out by the TypeScript text layout with Chrome's
// measureText and by the Rust engine with its own shaping (T3), the same frames painted with fillText and
// with the engine's glyph outlines (T4), the layout and frame times behind the perf bars, and the ten
// screens for the owner. Driven by scripts/text-engine/run-harness.mjs through `window.harness`.
import {buildBoardTemplate, insertBoardTemplate, BOARD_TEMPLATES} from '../../shared/design/board/templates';
import {renderBounds} from '../../shared/design/bounds';
import {worldBox} from '../../shared/design/geometry';
import {createDocument} from '../../shared/design/defaults';
import {DESIGN_TEMPLATES} from '../../shared/design/templates';
import {engineCalls, setEngine} from '../../shared/design/engine-switch';
import {setTextFonts, setTextGlyphMode, setTextWasm} from '../../shared/design/text-engine';
import {forgetMeasurements, layoutText, layoutTextMany, type FontSpec, type TextLayout} from '../../shared/design/text-layout';
import {beginTransaction} from '../../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {createFontRegistry} from '../../src/design/engine/fonts';
import {createImageCache} from '../../src/design/engine/images';
import {paintNodeTree} from '../../src/design/engine/render/painter';
import {forgetGlyphs, setTextSpriteCurve, type SpriteCurve} from '../../src/design/engine/render/text-glyphs';
import init, * as wasm from '../../src/design/wasm-text/morfa_text_wasm.js';
import initFonts, * as fontsWasm from '../../src/design/wasm-fonts/morfa_text_fonts_wasm.js';
import {heavyPage, productFile} from '../../tests/helpers/design-big-files';

const log = (line: string) => {
  const el = document.getElementById('log')!;
  el.textContent += `${line}\n`;
};

type Doc = {name: string; doc: DesignDocument};
type TextCase = {doc: string; id: NodeId; name: string; text: string; node: SceneNode};
type T3Row = {doc: string; id: NodeId; name: string; text: string; lines: [number, number]; widths: number[]; height: [number, number]; reason: string};

const fonts = createFontRegistry({base: '/fonts'});
const images = createImageCache();
let counter = 0;
const newId = () => `h${++counter}`;

function documents(): Doc[] {
  const out: Doc[] = [];
  for (const template of DESIGN_TEMPLATES) {
    if (template.id === 'blank') continue;
    out.push({name: template.id, doc: template.build({measurer: fonts.measurer, newId})});
  }
  const board = createDocument('page', 'Board');
  const tx = beginTransaction(board);
  let x = 0;
  for (const spec of BOARD_TEMPLATES) {
    const built = buildBoardTemplate(spec.id, newId);
    insertBoardTemplate(tx, built, 'page', {x, y: 0});
    x += built.bounds.width + 400;
  }
  out.push({name: 'board', doc: tx.commit({measurer: fonts.measurer}).doc});
  out.push({name: 'heavyPage', doc: heavyPage()});
  out.push({name: 'productFile', doc: productFile()});
  return out;
}

const textNodes = (docs: Doc[]): TextCase[] =>
  docs.flatMap(({name, doc}) => Object.values(doc.nodes).filter(node => node.type === 'TEXT' && node.text).map(node => ({doc: name, id: node.id, name: node.name, text: node.text!.characters, node})));

function specsOf(cases: TextCase[]): FontSpec[] {
  const seen = new Map<string, FontSpec>();
  for (const {node} of cases) {
    const styles = [node.text!.style, ...(node.text!.runs ?? []).map(run => ({...node.text!.style, ...run.style}))];
    for (const style of styles) {
      const spec = {family: style.fontFamily, weight: style.fontWeight, italic: style.italic, size: 16};
      seen.set(`${spec.family}|${spec.weight}|${spec.italic}`, spec);
    }
  }
  return [...seen.values()];
}

async function loadFonts(cases: TextCase[]): Promise<number> {
  const specs = specsOf(cases);
  await Promise.all(specs.map(spec => fonts.ensure(spec)));
  await fonts.whenIdle();
  await document.fonts.ready;
  return specs.length;
}

const relayout = (node: SceneNode): TextLayout => layoutText(node, fonts.measurer);

function t3(cases: TextCase[]): {rows: T3Row[]; failures: T3Row[]; nodes: number; lines: number} {
  setEngine('text', 'ts');
  forgetMeasurements(fonts.measurer);
  const reference = cases.map(c => relayout(c.node));
  setEngine('text', 'wasm');
  forgetMeasurements(fonts.measurer);
  const engine = cases.map(c => relayout(c.node));
  const rows: T3Row[] = [];
  let lines = 0;
  cases.forEach((c, i) => {
    const a = reference[i], b = engine[i];
    lines += a.lines.length;
    let reason = '';
    if (a.lines.length !== b.lines.length) reason = `lines ${a.lines.length} ≠ ${b.lines.length}`;
    else {
      for (let k = 0; k < a.lines.length; k++) {
        const tolerance = Math.max(0.5, a.lines[k].width * 0.01);
        if (Math.abs(a.lines[k].width - b.lines[k].width) > tolerance) {
          reason = `line ${k} width ${a.lines[k].width.toFixed(2)} vs ${b.lines[k].width.toFixed(2)}`;
          break;
        }
      }
      if (!reason && Math.abs(a.height - b.height) > 0.5) reason = `height ${a.height.toFixed(2)} vs ${b.height.toFixed(2)}`;
    }
    rows.push({doc: c.doc, id: c.id, name: c.name, text: c.text.slice(0, 40), lines: [a.lines.length, b.lines.length], widths: a.lines.map((l, k) => +(l.width - (b.lines[k]?.width ?? NaN)).toFixed(3)), height: [+a.height.toFixed(3), +b.height.toFixed(3)], reason});
  });
  return {rows, failures: rows.filter(r => r.reason), nodes: cases.length, lines};
}

type Timing = {ts: number; wasm: number; tsWarm: number; wasmWarm: number; batched: number; batchedWarm: number; nodes: number};

function perfLayout(cases: TextCase[]): Timing {
  const time = (mode: 'ts' | 'wasm', warm: boolean) => {
    setEngine('text', mode);
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
      forgetMeasurements(fonts.measurer);
      if (warm) {
        for (const c of cases) relayout(c.node);
        // Fresh text objects: the layout runs again, the widths stay cached.
        const fresh = cases.map(c => ({...c.node, text: {...c.node.text!}}));
        const started = performance.now();
        for (const n of fresh) relayout(n);
        best = Math.min(best, performance.now() - started);
      } else {
        const started = performance.now();
        for (const c of cases) relayout(c.node);
        best = Math.min(best, performance.now() - started);
      }
    }
    return best;
  };
  const batch = (warm: boolean) => {
    setEngine('text', 'wasm');
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
      forgetMeasurements(fonts.measurer);
      let nodes: SceneNode[] = cases.map(c => c.node);
      if (warm) {
        layoutTextMany(nodes, fonts.measurer);
        nodes = cases.map(c => ({...c.node, text: {...c.node.text!}}));
      }
      const started = performance.now();
      layoutTextMany(nodes, fonts.measurer);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  return {ts: time('ts', false), wasm: time('wasm', false), tsWarm: time('ts', true), wasmWarm: time('wasm', true), batched: batch(false), batchedWarm: batch(true), nodes: cases.length};
}

type Screen = {name: string; doc: Doc; rootId: NodeId; bounds: {x: number; y: number; width: number; height: number}};

function pickScreens(docs: Doc[]): Screen[] {
  const wanted: Record<string, number> = {mobile: 2, site: 1, presentation: 2, social: 1, 'ui-kit': 1, board: 1, heavyPage: 1, productFile: 1};
  const out: Screen[] = [];
  for (const d of docs) {
    const count = wanted[d.name] ?? 0;
    if (!count) continue;
    const pageId = d.doc.pages[0];
    const children = d.doc.nodes[pageId].children ?? [];
    if (d.name === 'board') {
      const box = children.map(id => worldBox(d.doc, id)).reduce((a, b) => ({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y)}));
      const first = children.slice(0, 1);
      const firstBox = worldBox(d.doc, first[0]);
      out.push({name: `board: ${BOARD_TEMPLATES[0].name}`, doc: d, rootId: pageId, bounds: {...firstBox, width: Math.min(firstBox.width, box.width, MAX_WIDTH), height: Math.min(firstBox.height, MAX_HEIGHT)}});
      continue;
    }
    for (const id of children.slice(0, count)) {
      const node = d.doc.nodes[id];
      const box = worldBox(d.doc, id);
      out.push({name: `${d.name}: ${node.name}`, doc: d, rootId: id, bounds: {...box, width: Math.min(box.width, MAX_WIDTH), height: Math.min(box.height, MAX_HEIGHT)}});
    }
  }
  return out;
}

const DPR = 2;
/** Screens are painted at DPR 2 exactly; tall pages are cropped to their top (T4 measures pixels, not pages). */
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1100;

function paintScreen(screen: Screen, mode: 'canvas' | 'outline'): HTMLCanvasElement {
  setTextGlyphMode(mode);
  forgetGlyphs();
  const {bounds} = screen;
  const scale = DPR;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bounds.width * scale));
  canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const roots = screen.rootId === screen.doc.doc.pages[0] ? screen.doc.doc.nodes[screen.rootId].children ?? [] : [screen.rootId];
  paintNodeTree({ctx, transform: [[scale, 0, -bounds.x * scale], [0, scale, -bounds.y * scale]], scale}, screen.doc.doc, roots, {images, fonts});
  return canvas;
}

/** Mean SSIM over 8×8 windows of the grayscale of two equal images. */
function ssim(a: ImageData, b: ImageData): number {
  const gray = (d: ImageData) => {
    const out = new Float32Array(d.width * d.height);
    for (let i = 0; i < out.length; i++) out[i] = 0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2];
    return out;
  };
  const ga = gray(a), gb = gray(b);
  const W = 8, C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, windows = 0;
  const w = a.width, h = a.height;
  const stepX = Math.max(1, Math.min(W, w)), stepY = Math.max(1, Math.min(W, h));
  for (let y = 0; y + stepY <= h; y += stepY) {
    for (let x = 0; x + stepX <= w; x += stepX) {
      let ma = 0, mb = 0;
      const n = stepX * stepY;
      for (let j = 0; j < stepY; j++) for (let i = 0; i < stepX; i++) {
        const k = (y + j) * w + x + i;
        ma += ga[k];
        mb += gb[k];
      }
      ma /= n;
      mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < stepY; j++) for (let i = 0; i < stepX; i++) {
        const k = (y + j) * w + x + i;
        va += (ga[k] - ma) ** 2;
        vb += (gb[k] - mb) ** 2;
        cov += (ga[k] - ma) * (gb[k] - mb);
      }
      va /= n;
      vb /= n;
      cov /= n;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }
  return windows ? sum / windows : 1;
}

type Region = {screen: string; id: NodeId; name: string; ssim: number; px: number; crop?: string};

function t4(screens: Screen[], curve: SpriteCurve = null): {regions: Region[]; failures: Region[]; screensSsim: {name: string; ssim: number}[]; pngs: {name: string; before: string; after: string}[]} {
  setEngine('text', 'wasm');
  setTextSpriteCurve(curve);
  const regions: Region[] = [];
  const screensSsim: {name: string; ssim: number}[] = [];
  const pngs: {name: string; before: string; after: string}[] = [];
  for (const screen of screens) {
    const before = paintScreen(screen, 'canvas');
    const after = paintScreen(screen, 'outline');
    const ca = before.getContext('2d')!, cb = after.getContext('2d')!;
    const scale = before.width / screen.bounds.width;
    screensSsim.push({name: screen.name, ssim: ssim(ca.getImageData(0, 0, before.width, before.height), cb.getImageData(0, 0, after.width, after.height))});
    pngs.push({name: screen.name, before: before.toDataURL('image/png'), after: after.toDataURL('image/png')});
    const doc = screen.doc.doc;
    const under = (id: NodeId): NodeId[] => [id, ...(doc.nodes[id].children ?? []).flatMap(under)];
    const roots = screen.rootId === doc.pages[0] ? doc.nodes[screen.rootId].children ?? [] : [screen.rootId];
    for (const id of roots.flatMap(under)) {
      const node = doc.nodes[id];
      if (node.type !== 'TEXT' || !node.text?.characters.trim()) continue;
      const box = renderBounds(doc, id, {measurer: fonts.measurer});
      if (!box) continue;
      const x = Math.max(0, Math.floor((box.x - screen.bounds.x) * scale)), y = Math.max(0, Math.floor((box.y - screen.bounds.y) * scale));
      const w = Math.min(before.width - x, Math.ceil(box.width * scale)), h = Math.min(before.height - y, Math.ceil(box.height * scale));
      if (w < 2 || h < 2) continue;
      const value = ssim(ca.getImageData(x, y, w, h), cb.getImageData(x, y, w, h));
      const region: Region = {screen: screen.name, id, name: node.name, ssim: value, px: w * h};
      if (value < 0.98 && w * h < 60_000) {
        // Before above after, ×3, for the eyes.
        const crop = document.createElement('canvas');
        crop.width = w * 3;
        crop.height = h * 6 + 6;
        const cc = crop.getContext('2d')!;
        cc.imageSmoothingEnabled = false;
        cc.fillStyle = '#f0f';
        cc.fillRect(0, 0, crop.width, crop.height);
        cc.drawImage(before, x, y, w, h, 0, 0, w * 3, h * 3);
        cc.drawImage(after, x, y, w, h, 0, h * 3 + 6, w * 3, h * 3);
        region.crop = crop.toDataURL('image/png');
      }
      regions.push(region);
    }
  }
  return {regions, failures: regions.filter(r => r.ssim < 0.98), screensSsim, pngs};
}

function perfFrames(screens: Screen[]): {name: string; canvasMs: number; outlineMs: number; ratio: number}[] {
  setEngine('text', 'wasm');
  return screens.map(screen => {
    const time = (mode: 'canvas' | 'outline') => {
      paintScreen(screen, mode); // warm caches (paths, shapes, fonts)
      let best = Infinity;
      for (let i = 0; i < 6; i++) {
        setTextGlyphMode(mode);
        const started = performance.now();
        const canvas = paintScreen(screen, mode);
        void canvas.getContext('2d')!.getImageData(0, 0, 1, 1); // flush the raster
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const canvasMs = time('canvas'), outlineMs = time('outline');
    return {name: screen.name, canvasMs, outlineMs, ratio: outlineMs / canvasMs};
  });
}

(window as unknown as {harness: unknown}).harness = {
  async run(options: {screens?: boolean; perf?: boolean} = {}) {
    await init();
    await initFonts();
    setTextWasm(wasm as never);
    setTextFonts(fontsWasm as never);
    setEngine('text', 'wasm');
    log('wasm loaded');
    const docs = documents();
    const cases = textNodes(docs);
    log(`${docs.length} documents, ${cases.length} text nodes`);
    const faces = await loadFonts(cases);
    log(`fonts loaded: ${faces} specs → ${fontsWasm.text_face_count()} faces in the store`);
    const result: Record<string, unknown> = {faces: fontsWasm.text_face_count(), stats: engineCalls('text')};
    result.t3 = t3(cases);
    log(`T3: ${(result.t3 as {failures: unknown[]}).failures.length} failures of ${cases.length}`);
    if (options.perf !== false) {
      result.perfHeavy = perfLayout(cases.filter(c => c.doc === 'heavyPage'));
      result.perfProduct = perfLayout(cases.filter(c => c.doc === 'productFile'));
      result.perfTemplates = perfLayout(cases.filter(c => !['heavyPage', 'productFile'].includes(c.doc)));
      log('perf layout done');
    }
    const screens = pickScreens(docs);
    if (options.screens !== false) {
      result.t4 = t4(screens);
      log(`T4: ${(result.t4 as {failures: unknown[]}).failures.length} regions under 0.98`);
      const curves: Record<string, SpriteCurve> = {'sprites gamma 1.0': {gamma: 1.0, contrast: 0}, 'sprites gamma 1.2': {gamma: 1.2, contrast: 0}, 'sprites gamma 1.2 contrast 0.2': {gamma: 1.2, contrast: 0.2}, 'sprites gamma 1.45': {gamma: 1.45, contrast: 0}, 'sprites gamma 1.45 contrast 0.3': {gamma: 1.45, contrast: 0.3}};
      const variants: Record<string, unknown> = {};
      for (const [name, curve] of Object.entries(curves)) {
        const run = t4(screens, curve);
        const sorted = run.regions.map(r => r.ssim).sort((a, b) => a - b);
        variants[name] = {under: run.failures.length, regions: run.regions.length, median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], failures: run.failures.map(r => ({id: r.id, name: r.name, ssim: r.ssim}))};
        log(`T4 ${name}: ${run.failures.length} under 0.98`);
      }
      setTextSpriteCurve(null);
      result.t4Variants = variants;
      result.perfFrames = perfFrames(screens.filter(s => s.doc.name !== 'heavyPage'));
    }
    result.stats = engineCalls('text');
    return result;
  },
};
log('harness ready');
