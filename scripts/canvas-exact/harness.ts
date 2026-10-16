// Browser side of the exact Canvas2D pixel test, loaded by harness.html
// under the bare Vite server of run.ts. Two pictures are compared byte for byte, never by a score:
//
//   paint  `paintNodeTree` of a whole fixture page, this tree's painter against the reference tree's (REF);
//   scene  the scene renderer (tiles, frame titles, the canvas the editor shows) driven through a script of edits —
//          typing into a text, moves, fills, hiding, removing, resizing, renaming — after every edit: this tree's
//          renderer, which repaints only what the edit touched, against the reference tree's renderer given the same
//          documents, and against a fresh renderer of this tree that paints the final document from nothing.
//
// The reference tree is a checkout of REF served under /@fs (run.ts makes it); without it only the fresh comparison
// runs. Both trees get the same documents (built here, by this tree's code) and their own font and image caches.

import type {DesignDocument, NodeId, NodeType, SceneNode, TextProps} from '../../shared/design/types';
import type {Rect} from '../../shared/design/geometry';
import {createDocument, createNode, defaultTextProps, pageBackground, solid} from '../../shared/design/defaults';
import {normalizeDocument} from '../../shared/design/normalize';
import {beginTransaction, type TableMode, type Transaction} from '../../shared/design/transaction';
import {snapshotDocument} from '../../shared/design/table-cache';
import {testMeasurer} from '../../tests/helpers/design-big-files';
import {FIXTURES} from '../goldens/fixtures';
import {pageArea} from '../goldens/harness-shared';

type Tree = {
  paintNodeTree: typeof import('../../src/design/engine/render/painter').paintNodeTree;
  SpatialIndex: typeof import('../../src/design/engine/render/spatial-index').SpatialIndex;
  createCanvasSceneRenderer: typeof import('../../src/design/engine/render/scene-renderer').createCanvasSceneRenderer;
  cssColor: typeof import('../../src/design/engine/render/blend').cssColor;
  GREEK_BELOW_PX: number;
  fonts: import('../../src/design/engine/fonts').DesignFontRegistry;
  images: import('../../src/design/engine/images').DesignImageCache;
  whenExportReady: typeof import('../../src/design/engine/export-raster').whenExportReady;
};

async function loadTree(base: string): Promise<Tree> {
  const at = (file: string) => import(/* @vite-ignore */ `${base}/${file}`);
  const [painter, spatial, scene, blend, textMath, fontsModule, imagesModule, exportRaster] = await Promise.all([
    at('src/design/engine/render/painter.ts'), at('src/design/engine/render/spatial-index.ts'), at('src/design/engine/render/scene-renderer.ts'),
    at('src/design/engine/render/blend.ts'), at('src/design/engine/render/text-math.ts'), at('src/design/engine/fonts.ts'), at('src/design/engine/images.ts'),
    at('src/design/engine/export-raster.ts'),
  ]);
  return {
    paintNodeTree: painter.paintNodeTree, SpatialIndex: spatial.SpatialIndex, createCanvasSceneRenderer: scene.createCanvasSceneRenderer,
    cssColor: blend.cssColor, GREEK_BELOW_PX: textMath.GREEK_BELOW_PX, fonts: fontsModule.createFontRegistry({base: '/fonts'}),
    images: imagesModule.createImageCache(), whenExportReady: exportRaster.whenExportReady,
  };
}

const params = new URLSearchParams(location.search);
const refBase = params.get('ref');
const current = await loadTree('');
const reference = refBase ? await loadTree(refBase) : null;

// ── Documents ──

const counter = (prefix: string) => {
  let n = 0;
  return () => `${prefix}${(++n).toString(36)}`;
};

/** Text, mostly: paragraphs with 40 runs (E5's text), every alignment and auto-resize mode, sizes from 6 to 64 px,
 *  inside frames that clip, overlap and carry titles. */
export function textHeavyFixture(): DesignDocument {
  const doc = createDocument('page', 'Text');
  const nextId = counter('x');
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>): NodeId => {
    const id = nextId();
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  const style = defaultTextProps('').style;
  // The Cyrillic paragraphs, pangram and typed letters are text-shaping test data (Cyrillic glyphs, fallback, widths) and stay Russian.
  const characters = Array.from({length: 40}, (_, k) => `Абзац ${k + 1}: `.padEnd(50, 'текст ')).join('').slice(0, 2000);
  const long = add('FRAME', 'page', {name: 'Long text', x: 0, y: 0, width: 1440, height: 900, fills: [solid({r: 1, g: 1, b: 1})], clipsContent: true});
  add('TEXT', long, {name: 'E5', x: 40, y: 40, width: 1200, height: 400, fills: [solid({r: 0.1, g: 0.1, b: 0.12})],
    text: {...defaultTextProps(characters), runs: Array.from({length: 40}, (_, k) => ({start: k * 50, end: (k + 1) * 50, style: {fontWeight: k % 2 ? 700 : 400}})), textAutoResize: 'HEIGHT'} as TextProps});
  const aligns = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] as const;
  const modes = ['NONE', 'HEIGHT', 'WIDTH_AND_HEIGHT'] as const;
  for (let f = 0; f < 3; f++) {
    const frame = add('FRAME', 'page', {name: `Cards ${f + 1}`, x: 1540 + f * 760, y: 0, width: 700, height: 1400, fills: [solid({r: 0.97, g: 0.96, b: 0.94})], clipsContent: f !== 1, cornerRadius: 12});
    for (let k = 0; k < 30; k++) {
      const size = [6, 9, 11, 13, 16, 20, 28, 40, 64][k % 9];
      const words = `${k + 1}. Съешь же ещё этих мягких французских булок, да выпей чаю`;
      add('TEXT', frame, {
        x: 20 + (k % 3) * 8, y: 20 + k * 46, width: 640, height: Math.max(12, size * 1.3), opacity: k % 7 === 6 ? 0.6 : 1,
        fills: [solid({r: (k * 37) % 255 / 255, g: 0.2, b: 0.35})],
        text: {...defaultTextProps(words), style: {...style, fontSize: size, fontWeight: [400, 500, 700][k % 3]}, align: aligns[k % 4], textAutoResize: modes[k % 3],
          runs: [{start: 0, end: 3, style: {fontWeight: 700}}, {start: 10, end: 22, style: {fontSize: size + 4}}]} as TextProps,
      });
    }
  }
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}

const FIXTURE_LIST = [...FIXTURES, {name: 'text-heavy', source: 'scripts/canvas-exact/harness.ts textHeavyFixture()', build: textHeavyFixture}];
const built = new Map<string, DesignDocument>();
function documentOf(name: string): DesignDocument {
  let doc = built.get(name);
  if (!doc) {
    const fixture = FIXTURE_LIST.find(f => f.name === name);
    if (!fixture) throw new Error(`no fixture ${name}`);
    built.set(name, (doc = fixture.build()));
  }
  return doc;
}

export function listFixtures(): {name: string; pages: {id: NodeId; name: string}[]}[] {
  return FIXTURE_LIST.map(f => ({name: f.name, pages: documentOf(f.name).pages.map(id => ({id, name: documentOf(f.name).nodes[id].name}))}));
}

// ── Comparing ──

/** `unstable`: pixels left out (under a picture); `tolerated`: pixels one level apart in a shadow's or blur's reach. */
export type Diff = {width: number; height: number; differing: number; first: [number, number] | null; box: Rect | null; unstable: number; tolerated: number};

const pixelsOf = (c: HTMLCanvasElement) => new Uint32Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer);

/** Where Chromium does not repeat itself, as found on main: 1 = left out (and counted), under a
 *  picture fill — an image draws one or two levels apart depending on what Chromium drew before; 2 = within one level
 *  a channel (and counted), in the reach of a shadow or a blur — a `shadowBlur` drop shadow comes out one level apart
 *  depending on what was drawn before it in the same paint (an unrelated gradient fill 540 page px away flips it, in a
 *  whole-page paint, no repaint involved). Every other pixel must be equal byte for byte, and a difference of more
 *  than one level fails anywhere but under a picture. Built from the document alone. */
function chromiumMask(doc: DesignDocument, pageId: NodeId, width: number, height: number, scale: number, originX: number, originY: number): Uint8Array {
  const index = new current.SpatialIndex();
  index.sync(doc, pageId, current.fonts.measurer);
  const mask = new Uint8Array(width * height);
  const mark = (r: Rect, value: number) => {
    const x0 = Math.max(0, Math.floor((r.x - originX) * scale) - 2), y0 = Math.max(0, Math.floor((r.y - originY) * scale) - 2);
    const x1 = Math.min(width, Math.ceil((r.x + r.width - originX) * scale) + 2), y1 = Math.min(height, Math.ceil((r.y + r.height - originY) * scale) + 2);
    for (let y = y0; y < y1; y++) for (let i = y * width + x0; i < y * width + x1; i++) if (value === 1 || !mask[i]) mask[i] = value;
  };
  const nodes = nodesOnPage(doc, pageId);
  for (const node of nodes) {
    if (!node.effects?.some(e => e.visible !== false)) continue;
    const r = index.bounds(node.id);
    if (r) mark(r, 2);
  }
  for (const node of nodes) {
    if (!node.fills?.some(p => p.type === 'IMAGE' && p.visible !== false) && !node.strokes?.some(p => p.type === 'IMAGE' && p.visible !== false)) continue;
    const r = index.bounds(node.id);
    if (r) mark(r, 1);
  }
  return mask;
}

function compare(a: HTMLCanvasElement, b: HTMLCanvasElement, mask?: Uint8Array): Diff {
  let ignored = 0;
  if (mask) for (let i = 0; i < mask.length; i++) if (mask[i] === 1) ignored++;
  if (a.width !== b.width || a.height !== b.height) return {width: a.width, height: a.height, differing: -1, first: null, box: null, unstable: ignored, tolerated: 0};
  const da = new Uint8ClampedArray(pixelsOf(a).buffer), db = new Uint8ClampedArray(pixelsOf(b).buffer);
  let differing = 0, tolerated = 0, first: [number, number] | null = null, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0, p = 0; i < da.length; i += 4, p++) {
    if (da[i] === db[i] && da[i + 1] === db[i + 1] && da[i + 2] === db[i + 2] && da[i + 3] === db[i + 3]) continue;
    const kind = mask?.[p] ?? 0;
    if (kind === 1) continue;
    if (kind === 2 && Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3])) <= 1) {
      tolerated++;
      continue;
    }
    differing++;
    const x = p % a.width, y = Math.floor(p / a.width);
    first ??= [x, y];
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return {width: a.width, height: a.height, differing, first, box: differing ? {x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1} : null, unstable: ignored, tolerated};
}

const canvasOf = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

async function ready(tree: Tree, doc: DesignDocument, pageId: NodeId) {
  await tree.whenExportReady(doc, [pageId], {fonts: tree.fonts, images: tree.images, timeoutMs: 15_000});
  await tree.fonts.whenIdle();
}

// ── paint: a whole page ──

function paintPage(tree: Tree, doc: DesignDocument, pageId: NodeId, dpr: number, maxSide: number): {canvas: HTMLCanvasElement; x0: number; y0: number} {
  const whole = pageArea(doc, pageId, tree.fonts) ?? {x: 0, y: 0, width: 100, height: 100};
  const x0 = Math.floor(whole.x - 2), y0 = Math.floor(whole.y - 2);
  const width = Math.min(maxSide, Math.ceil((Math.ceil(whole.x + whole.width + 2) - x0) * dpr));
  const height = Math.min(maxSide, Math.ceil((Math.ceil(whole.y + whole.height + 2) - y0) * dpr));
  const canvas = canvasOf(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = tree.cssColor(pageBackground(doc.nodes[pageId]));
  ctx.fillRect(0, 0, width, height);
  const index = new tree.SpatialIndex();
  index.sync(doc, pageId, tree.fonts.measurer);
  tree.paintNodeTree({ctx, transform: [[dpr, 0, -x0 * dpr], [0, dpr, -y0 * dpr]], scale: dpr}, doc, [pageId],
    {images: tree.images, fonts: tree.fonts, clip: {x: 0, y: 0, width, height}, index, minSize: 0.5, greekBelow: tree.GREEK_BELOW_PX});
  return {canvas, x0, y0};
}

export async function paint(name: string, pageId: NodeId, dpr: number, maxSide: number): Promise<Diff & {skipped?: string}> {
  if (!reference) return {width: 0, height: 0, differing: 0, first: null, box: null, unstable: 0, tolerated: 0, skipped: 'no reference tree'};
  const doc = documentOf(name);
  await ready(current, doc, pageId);
  await ready(reference, doc, pageId);
  const {canvas: cur, x0, y0} = paintPage(current, doc, pageId, dpr, maxSide), {canvas: ref} = paintPage(reference, doc, pageId, dpr, maxSide);
  return compare(cur, ref, chromiumMask(doc, pageId, cur.width, cur.height, dpr, x0, y0));
}

// ── scene: tiles, titles, edits ──

type Step = {label: string; recipe: (tx: Transaction, doc: DesignDocument) => void};

function nodesOnPage(doc: DesignDocument, pageId: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  const stack = [...(doc.nodes[pageId].children ?? [])].reverse();
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    out.push(node);
    for (const id of [...(node.children ?? [])].reverse()) stack.push(id);
  }
  return out;
}

/** The edits of a scene run, picked from the page: typing into its first (or longest) text, then one of each kind. */
function stepsFor(doc: DesignDocument, pageId: NodeId): Step[] {
  const nodes = nodesOnPage(doc, pageId);
  const texts = nodes.filter(n => n.type === 'TEXT' && n.visible !== false);
  const text = texts.reduce<SceneNode | undefined>((best, n) => (!best || n.text!.characters.length > best.text!.characters.length ? n : best), undefined);
  const leaves = nodes.filter(n => !n.children?.length && n.type !== 'TEXT' && n.visible !== false);
  const top = (doc.nodes[pageId].children ?? []).map(id => doc.nodes[id]).filter(n => n && (n.type === 'FRAME' || n.type === 'SECTION' || n.type === 'COMPONENT'));
  const steps: Step[] = [];
  if (text) {
    for (const ch of ['ы', 'ш', ' ', 'Q', '\n', 'й']) steps.push({label: `type ${JSON.stringify(ch)}`, recipe: (tx, d) => {
      const t = d.nodes[text.id].text!;
      tx.update(text.id, {text: {...t, characters: t.characters + ch}});
    }});
    steps.push({label: 'backspace', recipe: (tx, d) => {
      const t = d.nodes[text.id].text!;
      tx.update(text.id, {text: {...t, characters: t.characters.slice(0, -1)}});
    }});
    steps.push({label: 'text in the middle', recipe: (tx, d) => {
      const t = d.nodes[text.id].text!;
      const at = Math.floor(t.characters.length / 2);
      tx.update(text.id, {text: {...t, characters: t.characters.slice(0, at) + 'вставка ' + t.characters.slice(at)}});
    }});
  }
  const leaf = leaves[Math.floor(leaves.length / 3)];
  if (leaf) {
    steps.push({label: 'move', recipe: tx => tx.update(leaf.id, {x: leaf.x + 7.25, y: leaf.y + 3.5})});
    steps.push({label: 'fill', recipe: tx => tx.update(leaf.id, {fills: [solid({r: 0.9, g: 0.2, b: 0.4})]})});
    steps.push({label: 'hide', recipe: tx => tx.update(leaf.id, {visible: false})});
    steps.push({label: 'show', recipe: tx => tx.update(leaf.id, {visible: true})});
  }
  const other = leaves[Math.floor((2 * leaves.length) / 3)];
  if (other && other !== leaf) steps.push({label: 'remove', recipe: tx => tx.remove(other.id)});
  const frame = top[0];
  if (frame) {
    steps.push({label: 'resize a top frame', recipe: (tx, d) => tx.update(frame.id, {width: d.nodes[frame.id].width + 13})});
    steps.push({label: 'rename a top frame', recipe: tx => tx.update(frame.id, {name: `${frame.name} (new name)`})});
    if (top[1]) steps.push({label: 'move a top frame', recipe: (tx, d) => tx.update(top[1].id, {x: d.nodes[top[1].id].x + 40.5})});
  }
  return steps;
}

type View = {x: number; y: number; zoom: number; width: number; height: number; dpr: number};
type Renderer = ReturnType<Tree['createCanvasSceneRenderer']>;

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

/** Renders until the picture is final, including what fonts that loaded meanwhile change (a glyph range a new
 *  character needs, the UI font of the titles): the fonts load in the order the renderers ask, so a run that did not
 *  wait would compare a picture before a load with one after it. */
async function settle(tree: Tree, renderer: Renderer, options: Parameters<Renderer['render']>[0]) {
  for (let round = 0; round < 8; round++) {
    const revision = tree.fonts.measurer.revision;
    renderer.render(options);
    for (let n = 0; n < 600; n++) {
      const stats = renderer.stats();
      if (stats.complete && !stats.pending) break;
      await frame();
      renderer.render(options);
    }
    await tree.fonts.whenIdle();
    await document.fonts.ready;
    // Frames the loop scheduled itself (the prefetch ring) leave the visible picture as it is; one more call draws it.
    await frame();
    renderer.render(options);
    if (tree.fonts.measurer.revision === revision && document.fonts.status === 'loaded') return;
  }
}

function viewsOf(doc: DesignDocument, pageId: NodeId, focus: Rect | null): View[] {
  const area = pageArea(doc, pageId, current.fonts) ?? {x: 0, y: 0, width: 800, height: 600};
  const width = 800, height = 600;
  const fit = Math.min(width / area.width, height / area.height, 1) * 0.95;
  const views: View[] = [{x: area.x - 10 / fit, y: area.y - 10 / fit, zoom: fit, width, height, dpr: 1}];
  const at = focus ?? area;
  views.push({x: at.x - 30.5, y: at.y - 41.25, zoom: 1, width, height, dpr: 2});
  views.push({x: at.x - 200, y: at.y - 120, zoom: 0.37, width, height, dpr: 2});
  // The sweep: small zooms at fractional DPRs, where tile and part edges fall between pixels (views 3 on).
  for (const zoom of SWEEP_ZOOMS) for (const dpr of SWEEP_DPRS) views.push({x: area.x - 13.3 / zoom, y: area.y - 7.7 / zoom, zoom, width, height, dpr});
  return views;
}

const SWEEP_ZOOMS = [0.1, 0.137, 0.189, 0.25, 0.31, 0.43, 0.5];
const SWEEP_DPRS = [1, 1.25, 1.5];
/** How many views `scene` takes for a page: 3, then the sweep's zoom × DPR. */
export const viewCount = () => 3 + SWEEP_ZOOMS.length * SWEEP_DPRS.length;

/** `vsFresh`: this tree's picture after the edits against this tree painting the same document from nothing;
 *  `vsReference`: against the reference tree painting it from nothing; `referenceRepaint`: the reference's own picture
 *  after the same edits against its paint from nothing (main's own repaint, reported, never this tree's verdict). All
 *  three are made in this run, in this browser: no pixels recorded on another machine are compared. */
export type SceneStep = {label: string; changed: number; vsReference: Diff | null; vsFresh: Diff; referenceRepaint: Diff | null; pictures?: Record<string, string>};

const dump = params.has('dump');

/** `dotGrid`: as a board shows the page (its dots under everything); the reference commit has no dots, so it is left out. */
/** How the scenes' edits get their node table (`?table=`, run.ts passes MORFA_TABLE): `in-place` writes one table every
 *  step, as the editor's store does by default, so each step's document shares it with the one before. */
const TABLE: TableMode = params.get('table') === 'in-place' ? 'in-place' : 'copy';

export async function scene(name: string, pageId: NodeId, viewIndex: number, dotGrid = false): Promise<{view: View; steps: SceneStep[]}> {
  const start = documentOf(name);
  await ready(current, start, pageId);
  if (reference) await ready(reference, start, pageId);
  const steps = stepsFor(start, pageId);
  const focusNode = nodesOnPage(start, pageId).find(n => n.type === 'TEXT');
  const focusIndex = new current.SpatialIndex();
  focusIndex.sync(start, pageId, current.fonts.measurer);
  const view = viewsOf(start, pageId, focusNode ? focusIndex.bounds(focusNode.id) ?? null : null)[viewIndex];
  const device = {width: Math.round(view.width * view.dpr), height: Math.round(view.height * view.dpr)};
  const make = (tree: Tree) => {
    const canvas = canvasOf(device.width, device.height);
    // Read back from the start: Chromium moves a canvas to the CPU on its first read, and a scaled tile drawn on the
    // GPU and on the CPU can differ by one level; every canvas compared here is on the CPU from its first frame.
    canvas.getContext('2d', {alpha: false, willReadFrequently: true});
    return {canvas, renderer: tree.createCanvasSceneRenderer(canvas, {images: tree.images, fonts: tree.fonts})};
  };
  const cur = make(current), ref = reference && !dotGrid ? make(reference) : null;
  let selected: ReadonlySet<NodeId> = new Set<NodeId>();
  const optionsFor = (doc: DesignDocument, changes?: {from: DesignDocument; ids: Iterable<NodeId>}) => ({
    doc, pageId, viewport: {x: view.x, y: view.y, zoom: view.zoom}, size: {width: view.width, height: view.height}, dpr: view.dpr,
    labels: {selected, editing: null}, ...(dotGrid ? {dotGrid} : {}), ...(changes ? {changes} : {}),
  });
  // In place the scene writes a table of its own (the fixture's document is shared by every view).
  let doc = TABLE === 'in-place' ? snapshotDocument(start) : start;
  await settle(current, cur.renderer, optionsFor(doc));
  if (ref) await settle(reference!, ref.renderer, optionsFor(doc));
  const out: SceneStep[] = [];
  const record = async (label: string, changed: NodeId[], from: DesignDocument | null) => {
    if (from) {
      cur.renderer.documentChanged({doc, changed: new Set(changed)});
      ref?.renderer.documentChanged({doc, changed: new Set(changed)});
    }
    await settle(current, cur.renderer, optionsFor(doc));
    if (ref) await settle(reference!, ref.renderer, optionsFor(doc));
    const fresh = make(current);
    await settle(current, fresh.renderer, optionsFor(doc));
    const refFresh = ref ? make(reference!) : null;
    if (refFresh) await settle(reference!, refFresh.renderer, optionsFor(doc));
    // The fresh ones may have loaded something the others have not drawn with yet.
    await settle(current, cur.renderer, optionsFor(doc));
    if (ref) await settle(reference!, ref.renderer, optionsFor(doc));
    const unstable = chromiumMask(doc, pageId, device.width, device.height, view.zoom * view.dpr, view.x, view.y);
    const vsFresh = compare(cur.canvas, fresh.canvas, unstable);
    const vsReference = refFresh ? compare(cur.canvas, refFresh.canvas, unstable) : null;
    const referenceRepaint = ref && refFresh ? compare(ref.canvas, refFresh.canvas, unstable) : null;
    const differs = vsFresh.differing !== 0 || (vsReference && vsReference.differing !== 0);
    const pictures = dump && differs ? {current: cur.canvas.toDataURL(), fresh: fresh.canvas.toDataURL(), ...(ref ? {reference: ref.canvas.toDataURL(), referenceFresh: refFresh!.canvas.toDataURL()} : {})} : undefined;
    out.push({label, changed: changed.length, vsReference, vsFresh, referenceRepaint, ...(pictures ? {pictures} : {})});
    fresh.renderer.dispose();
    refFresh?.renderer.dispose();
  };
  await record('open', [], null);
  // Everything repainted, the same document: the tiles painted again equal the first ones.
  cur.renderer.invalidate();
  await record('repaint everything', [], null);
  for (const step of steps) {
    const tx = beginTransaction(doc, {table: TABLE});
    step.recipe(tx, doc);
    const result = tx.commit({measurer: testMeasurer});
    const from = doc;
    doc = result.doc;
    await record(step.label, Object.keys(result.patch.nodes ?? {}), from);
  }
  // Selecting a top frame recolours its title.
  const firstTop = (doc.nodes[pageId].children ?? [])[0];
  if (firstTop) {
    // A new set, as the editor's selection is: the renderers compare it by identity.
    selected = new Set([firstTop]);
    await record('select a top frame', [], null);
  }
  cur.renderer.dispose();
  ref?.renderer.dispose();
  return {view, steps: out};
}

declare global {
  interface Window {
    exact: {listFixtures: typeof listFixtures; paint: typeof paint; scene: typeof scene; viewCount: typeof viewCount; hasReference: boolean};
  }
}
window.exact = {listFixtures, paint, scene, viewCount, hasReference: !!reference};
document.getElementById('out')!.textContent = `canvas-exact harness: ${FIXTURE_LIST.length} fixtures, reference ${refBase ?? 'none'}`;
document.getElementById('out')!.dataset.state = 'ready';
