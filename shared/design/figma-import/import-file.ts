import type {DesignDocument, Matrix, NodeId, SceneNode} from '../types';
import {CONTAINER_TYPES, DESIGN_SCHEMA_VERSION, type NodeType} from '../types';
import {createNode} from '../defaults';
import {IDENTITY, transformRect, translation} from '../geometry';
import {groupFitUpdates} from '../group-fit';
import {countText, documentCaps, megabytes} from '../big-files';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';
import type {FigmaFile, FigmaNode} from './rest-types';
import {FigmaIndex, InstancePlan, liftUnitOf, plainId, type Entry} from './plan';
import {PageSpace, figmaSize, place, relativeTo} from './geometry';
import {buildNode, buildPage, noteFor, type BuildContext, type StyleUse} from './nodes';
import {attachStyles} from './styles';
import {inferOverrides} from './overrides';
import {figmaImageRefs} from './images';
import {ReportBuilder, type FigmaImportReport} from './report';

// A Figma file (REST JSON) → a Morfa document, pure and synchronous:
//   1. index the tree and decide which instances stay instances (plan.ts);
//   2. choose what fits the file caps: the chosen pages' top-level layers in order, plus the main
//      components they need from pages that were not chosen (lifted onto a "Components" page);
//   3. write every node (nodes.ts) placed in its new parent's space (geometry.ts);
//   4. fit groups to their children, attach styles, record instance overrides;
//   5. if the JSON is over the byte cap, start again with fewer layers.
// Pictures stay as Figma's hashes; the runner uploads them and calls `withUploadedImages`.

export type FigmaImportOptions = {
  /** Figma page ids to import, in any order (the file's order is kept). Default: every page. */
  pageIds?: readonly string[];
  /** Components (or variant sets) read on their own when the file was read page by page. */
  extraNodes?: readonly FigmaNode[];
  /** Lower caps (tests); never above DESIGN_DOCUMENT_CAPS. */
  caps?: {nodes?: number; bytes?: number; pages?: number};
};

/** A cap of the file the import hit: which, the chosen pages' number against it (layers, bytes of JSON, pages), and the cap. */
export type FigmaLimit = 'nodes' | 'bytes' | 'pages';
export type FigmaLimitHit = {limit: FigmaLimit; value: number; cap: number};

export type FigmaImportResult = {
  doc: DesignDocument;
  report: FigmaImportReport;
  /** Figma image hashes the document's IMAGE paints still point at. */
  imageRefs: string[];
  /** Serialized size, bytes. */
  bytes: number;
  /** The caps that left part of the chosen pages out (empty: everything chosen came in). */
  limits: FigmaLimitHit[];
  /** Layers on the chosen pages as Figma counts them, and the layers written. */
  layers: {chosen: number; imported: number};
};

/** The import cannot produce a file at all; the message is for the screen. `limit`: the cap that stopped it. */
export class FigmaImportError extends Error {
  readonly limit?: FigmaLimitHit;
  constructor(message: string, limit?: FigmaLimitHit) {
    super(message);
    this.name = 'FigmaImportError';
    this.limit = limit;
  }
}

export const COMPONENTS_PAGE_ID = 'figma-components';
const COMPONENTS_PAGE_NAME = 'Components';
const SHELF_GAP = 160;
const CONTAINERS = new Set<NodeType>(CONTAINER_TYPES);
const SHELF_WIDTH = 6000;

/** UTF-8 length of a string without encoding it. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** JSON.stringify leaves out properties whose value it cannot write. */
const unwritten = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol';
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as {toJSON?: unknown}).toJSON !== 'function';

/**
 * The UTF-8 bytes of `JSON.stringify(doc)`, counted entry by entry: a document of 150 000 layers is a 120 MB string, which this never
 * builds (Stage G: no huge string in the import). Its tables are objects of entries; every other field is small.
 */
export function documentJsonBytes(doc: DesignDocument): number {
  const object = (value: Record<string, unknown>, nested: boolean) => {
    let bytes = 2,
      written = 0;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (unwritten(item)) continue;
      bytes += utf8Length(JSON.stringify(key)) + 1 + (nested && plain(item) ? object(item, false) : utf8Length(JSON.stringify(item)));
      written++;
    }
    return bytes + Math.max(0, written - 1);
  };
  return object(doc as unknown as Record<string, unknown>, true);
}

export function importFigmaFile(file: FigmaFile, options: FigmaImportOptions = {}): FigmaImportResult {
  const inForce = documentCaps();
  const caps = {
    nodes: Math.min(options.caps?.nodes ?? inForce.nodes, inForce.nodes),
    bytes: Math.min(options.caps?.bytes ?? inForce.bytes, inForce.bytes),
    pages: Math.min(options.caps?.pages ?? inForce.pages, inForce.pages),
  };
  const index = new FigmaIndex(file, options.extraNodes ?? []);
  const plan = new InstancePlan(index, id => !!file.components && Object.hasOwn(file.components, id) && file.components[id]?.remote === true);
  const chosen = chosenLayers(index, options.pageIds);
  let budget = caps.nodes;
  let byteCut = false;
  let firstBytes = 0,
    lastBytes = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = assemble(file, index, plan, options, {...caps, nodes: budget}, byteCut);
    const bytes = documentJsonBytes(result.doc);
    if (!attempt) firstBytes = bytes;
    lastBytes = bytes;
    if (bytes <= caps.bytes) return withLimits({...result, bytes}, caps, chosen, firstBytes);
    const nodes = Object.keys(result.doc.nodes).length;
    budget = Math.max(1, Math.floor(nodes * (caps.bytes / bytes) * 0.9));
    byteCut = true;
  }
  throw new FigmaImportError(
    `Even part of the chosen pages is ${megabytes(lastBytes)} MB, and a Morfa file can be at most ${megabytes(caps.bytes)} MB. Choose fewer pages.`,
    {limit: 'bytes', value: lastBytes, cap: caps.bytes},
  );
}

/** Layers on the chosen pages (every page without a choice) as Figma counts them, the pages themselves not counted. */
function chosenLayers(index: FigmaIndex, pageIds: readonly string[] | undefined): number {
  const wanted = pageIds ? new Set(pageIds) : null;
  return index.pages.filter(page => !wanted || wanted.has(page.node.id)).reduce((sum, page) => sum + Math.max(0, page.size - 1), 0);
}

/** The caps that cut this import, and its notes with the numbers: how many layers came in of how many, against which cap. */
function withLimits(result: Omit<FigmaImportResult, 'limits' | 'layers'>, caps: {nodes: number; bytes: number; pages: number}, chosen: number, firstBytes: number): FigmaImportResult {
  let imported = 0;
  for (const node of Object.values(result.doc.nodes)) if (node.type !== 'PAGE') imported++;
  const limits: FigmaLimitHit[] = [];
  const rest = 'Import the rest as a separate file: choose other pages.';
  for (const item of result.report.items) {
    if (item.key === 'cap-nodes') {
      limits.push({limit: 'nodes', value: chosen, cap: caps.nodes});
      item.message = `The chosen pages have ${countText(chosen)} layers, and a Morfa file can hold at most ${countText(caps.nodes)}: ${countText(imported)} were imported, the last layers were not. ${rest}`;
    } else if (item.key === 'cap-bytes') {
      limits.push({limit: 'bytes', value: firstBytes, cap: caps.bytes});
      item.message = `The chosen pages are larger than ${megabytes(caps.bytes)} MB, which is the limit of a Morfa file: ${countText(imported)} of ${countText(chosen)} layers were imported, the last ones were not. ${rest}`;
    } else if (item.key === 'cap-pages') {
      // The note counts the pages left out; a file keeps one page for the components lifted from pages not chosen.
      const pages = item.count + caps.pages - 1;
      limits.push({limit: 'pages', value: pages, cap: caps.pages});
      item.message = `${countText(pages)} pages are chosen, and a Morfa file can hold at most ${countText(caps.pages)}: the rest were not imported. ${rest}`;
    }
  }
  return {...result, limits, layers: {chosen, imported}};
}

/** One page's share of an import: its layers as written and the bytes of their JSON. */
export type FigmaPageMeasure = {id: string; name: string; layers: number; bytes: number};
/** What an import of `pageIds` would write with no cap: every page's share, and the components lifted from pages not chosen. */
export type FigmaImportMeasure = {layers: number; bytes: number; pages: FigmaPageMeasure[]; lifted: {layers: number; bytes: number}};

/**
 * The page picker's data: the chosen pages (default: all) mapped with no cap, measured page by page
 * as the file would store them — a mapped layer is often three times its Figma JSON, so Figma's own counts do not say what fits.
 * Synchronous and as costly as an import of those pages.
 */
export function measureFigmaImport(file: FigmaFile, options: Pick<FigmaImportOptions, 'pageIds' | 'extraNodes'> = {}): FigmaImportMeasure {
  const index = new FigmaIndex(file, options.extraNodes ?? []);
  const plan = new InstancePlan(index, id => !!file.components && Object.hasOwn(file.components, id) && file.components[id]?.remote === true);
  const unbounded = {nodes: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, pages: Number.MAX_SAFE_INTEGER};
  const {doc} = assemble(file, index, plan, options, unbounded, false);
  const share = (pageId: NodeId) => {
    let layers = 0,
      bytes = 0;
    const stack = [...(doc.nodes[pageId]?.children ?? [])];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node) continue;
      layers++;
      // The entry as the document's JSON holds it: `"id":{…},`.
      bytes += utf8Length(JSON.stringify(node)) + utf8Length(node.id) + 4;
      stack.push(...(node.children ?? []));
    }
    return {layers, bytes};
  };
  const pages = index.pages
    .filter(page => doc.pages.includes(plainId(page.node.id)))
    .map(page => ({id: page.node.id, name: typeof page.node.name === 'string' && page.node.name.trim() ? page.node.name : 'Untitled', ...share(plainId(page.node.id))}));
  let layers = 0;
  for (const node of Object.values(doc.nodes)) if (node.type !== 'PAGE') layers++;
  return {layers, bytes: documentJsonBytes(doc), pages, lifted: doc.nodes[COMPONENTS_PAGE_ID] ? share(COMPONENTS_PAGE_ID) : {layers: 0, bytes: 0}};
}

/** The caps a set of pages of `measure` goes over, by the sum of their shares (an estimate: components they need from other pages
 *  come on top; `planFigmaParts` measures each part it proposes). */
export function figmaPagesOver(measure: FigmaImportMeasure, pageIds: readonly string[], caps: {nodes: number; bytes: number; pages: number} = documentCaps()): FigmaLimitHit[] {
  const chosen = new Set(pageIds);
  let layers = 0,
    bytes = 0;
  for (const page of measure.pages) if (chosen.has(page.id)) ((layers += page.layers), (bytes += page.bytes));
  const over: FigmaLimitHit[] = [];
  if (layers > caps.nodes) over.push({limit: 'nodes', value: layers, cap: caps.nodes});
  if (bytes > caps.bytes) over.push({limit: 'bytes', value: bytes, cap: caps.bytes});
  if (chosen.size > caps.pages - 1) over.push({limit: 'pages', value: chosen.size, cap: caps.pages});
  return over;
}

/** One file of a kit brought in parts: its pages, what it measures, and whether it fits (a single page over the caps does not). */
export type FigmaImportPart = {pageIds: string[]; layers: number; bytes: number; fits: boolean};

/**
 * A large file in parts that each fit the caps (with `margin` to spare): pages in the file's order, as many as fit, each part
 * measured as an import of just those pages (the components it needs from other pages included) and split again when over. A page
 * over the caps on its own is a part of its own that does not fit: its import brings what fits and says what it left out.
 */
export function planFigmaParts(
  file: FigmaFile,
  options: Pick<FigmaImportOptions, 'pageIds' | 'extraNodes'> & {caps?: {nodes: number; bytes: number; pages: number}; margin?: number} = {},
): FigmaImportPart[] {
  const caps = options.caps ?? documentCaps(),
    margin = options.margin ?? 0.9;
  const limit = {nodes: caps.nodes * margin, bytes: caps.bytes * margin, pages: caps.pages - 1};
  const all = measureFigmaImport(file, options);
  const measured = (pageIds: string[]): FigmaImportPart => {
    const one = measureFigmaImport(file, {pageIds, extraNodes: options.extraNodes});
    return {pageIds, layers: one.layers, bytes: one.bytes, fits: one.layers <= limit.nodes && one.bytes <= limit.bytes && pageIds.length <= limit.pages};
  };
  const parts: FigmaImportPart[] = [];
  const settle = (pageIds: string[]) => {
    const part = measured(pageIds);
    if (part.fits || pageIds.length === 1) return void parts.push(part);
    const half = pageIds.length >> 1;
    settle(pageIds.slice(0, half));
    settle(pageIds.slice(half));
  };
  let current: string[] = [],
    layers = 0,
    bytes = 0;
  for (const page of all.pages) {
    if (current.length && (layers + page.layers > limit.nodes || bytes + page.bytes > limit.bytes || current.length + 1 > limit.pages)) {
      settle(current);
      ((current = []), (layers = 0), (bytes = 0));
    }
    current.push(page.id);
    layers += page.layers;
    bytes += page.bytes;
  }
  if (current.length) settle(current);
  return parts;
}

function assemble(file: FigmaFile, index: FigmaIndex, plan: InstancePlan, options: FigmaImportOptions, caps: {nodes: number; bytes: number; pages: number}, byteCut: boolean) {
  const report = new ReportBuilder();
  const wanted = options.pageIds ? new Set(options.pageIds) : null;
  let pages = index.pages.filter(page => !wanted || wanted.has(page.node.id));
  if (!pages.length && !index.loose.length) throw new FigmaImportError('The file has no pages that can be imported.');
  if (pages.length > caps.pages - 1) {
    report.note('cap-pages', 'limits', `A Morfa file holds at most ${caps.pages} pages: the rest were not imported`, pages[caps.pages - 1]?.node.name, pages.length - (caps.pages - 1));
    pages = pages.slice(0, caps.pages - 1);
  }
  const selected = new Set(pages);

  // ── What each subtree needs: main components (as lift units: a variant brings its set) ──────
  const closures = new Map<Entry, Set<Entry>>();
  const addUnit = (unit: Entry, out: Set<Entry>) => {
    if (out.has(unit)) return;
    out.add(unit);
    for (const more of closureOf(unit)) out.add(more);
  };
  const needsOf = (root: Entry, out: Set<Entry>) => {
    const stack = [root];
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.node.type === 'INSTANCE') {
        if (plan.isRootInstance(entry)) {
          const component = !plan.isDetached(entry) ? index.get(entry.node.componentId) : undefined;
          if (component) addUnit(liftUnitOf(component), out);
        } else if (plan.isSwapped(entry)) {
          const target = index.get(entry.node.componentId);
          if (target) addUnit(liftUnitOf(target), out);
        }
      }
      for (const child of index.children(entry)) stack.push(child);
    }
  };
  function closureOf(unit: Entry): Set<Entry> {
    let set = closures.get(unit);
    if (set) return set;
    set = new Set();
    closures.set(unit, set);
    needsOf(unit, set);
    set.delete(unit);
    return set;
  }

  // ── Top-level layers in order while they fit, with the components they bring ─────────────
  const accepted = new Set<Entry>();
  const needed = new Set<Entry>();
  const counted = new Set<Entry>();
  let used = pages.length + 1;
  for (const page of pages) {
    for (const child of index.children(page)) {
      const needs = new Set<Entry>();
      needsOf(child, needs);
      let cost = child.size;
      const fresh: Entry[] = [];
      for (const unit of needs) {
        if (counted.has(unit) || (unit.page && selected.has(unit.page))) continue;
        fresh.push(unit);
        cost += unit.size;
      }
      if (used + cost > caps.nodes) {
        if (byteCut) report.note('cap-bytes', 'limits', `The file came out larger than ${Math.round(caps.bytes / 1024 / 1024)} MB: the last layers were not imported`, child.node.name);
        else report.note('cap-nodes', 'limits', `A Morfa file holds at most ${caps.nodes.toLocaleString('en-US')} layers: the last layers were not imported`, child.node.name);
        continue;
      }
      used += cost;
      for (const unit of fresh) counted.add(unit);
      for (const unit of needs) needed.add(unit);
      accepted.add(child);
    }
  }
  const topOf = (entry: Entry): Entry | null => {
    let at: Entry | null = entry;
    while (at && at.parent && at.parent.node.type !== 'CANVAS') at = at.parent;
    return at && at.parent ? at : null;
  };
  const lifted = [...needed].filter(unit => {
    const top = topOf(unit);
    return !(top && accepted.has(top));
  });

  // ── Lifted components: a shelf on their own page, in their original order ───────────────
  const space = new PageSpace();
  const pageOrder = new Map(index.pages.map((page, i) => [page, i]));
  const originalBox = (unit: Entry) => {
    const {width, height} = figmaSize(unit);
    return transformRect(space.original(unit), {x: 0, y: 0, width, height});
  };
  lifted.sort((a, b) => (pageOrder.get(a.page!) ?? 1e9) - (pageOrder.get(b.page!) ?? 1e9) || originalBox(a).y - originalBox(b).y || originalBox(a).x - originalBox(b).x);
  let shelfX = 0, shelfY = 0, rowHeight = 0;
  for (const unit of lifted) {
    const box = originalBox(unit);
    if (shelfX > 0 && shelfX + box.width > SHELF_WIDTH) {
      shelfX = 0;
      shelfY += rowHeight + SHELF_GAP;
      rowHeight = 0;
    }
    space.shift.set(unit, translation(shelfX - box.x, shelfY - box.y));
    shelfX += box.width + SHELF_GAP;
    rowHeight = Math.max(rowHeight, box.height);
  }
  if (lifted.length) {
    const names = lifted.map(unit => unit.page?.node.name).filter((name): name is string => !!name);
    report.note('components-lifted', 'components', `Components from pages you did not choose were moved to the "${COMPONENTS_PAGE_NAME}" page`, names[0], lifted.length);
  }

  // ── What is written, and its ids ─────────────────────────────────────────────────────────
  type Out = {entry: Entry; parent: Entry | null; pageId: NodeId};
  const outputs: Out[] = [];
  const refs = new Map<string, NodeId>();
  const walk = (root: Entry, pageId: NodeId, rootDepth: number) => {
    const stack: Out[] = [{entry: root, parent: null, pageId}];
    while (stack.length) {
      const out = stack.pop()!;
      const {entry} = out;
      const type = plan.typeOf(entry);
      if (!type) {
        noteFor(report, entry.node.name)('unsupported-' + entry.node.type, 'vectors', 'Layers of this kind (widgets, embedded videos and links) are not imported');
        continue;
      }
      if (entry.depth - rootDepth >= L.depth) {
        noteFor(report, entry.node.name)('cap-depth', 'limits', `Layers nested deeper than ${L.depth} levels were not imported`);
        continue;
      }
      outputs.push(out);
      refs.set(entry.node.id, plan.idOf(entry));
      if (!CONTAINERS.has(type)) continue;
      const children = index.children(entry);
      for (let i = children.length - 1; i >= 0; i--) stack.push({entry: children[i], parent: entry, pageId});
    }
  };
  for (const page of pages) for (const child of index.children(page)) if (accepted.has(child)) walk(child, plainId(page.node.id), child.depth);
  for (const unit of lifted) walk(unit, COMPONENTS_PAGE_ID, unit.depth);
  // Outputs are in pre-order, parents first; children are attached in Figma's order below.

  const componentByKey = new Map<string, NodeId>();
  for (const [id, meta] of Object.entries({...(file.components ?? {}), ...(file.componentSets ?? {})})) {
    const ref = refs.get(id);
    if (ref && meta && typeof meta.key === 'string') componentByKey.set(meta.key, ref);
  }
  const styleUses: StyleUse[] = [];
  const context: BuildContext = {file, report, nodeRef: id => refs.get(id), componentByKey, styleUses, variables: {count: 0}};

  // ── Pages ────────────────────────────────────────────────────────────────────────────────
  const doc: DesignDocument = {schemaVersion: DESIGN_SCHEMA_VERSION, pages: [], nodes: {}, styles: {}, images: {}, variableCollections: {}, variables: {}};
  for (const page of pages) {
    const id = plainId(page.node.id);
    doc.nodes[id] = buildPage(page, id, context);
    doc.pages.push(id);
  }
  if (lifted.length) {
    doc.nodes[COMPONENTS_PAGE_ID] = createNode('PAGE', {id: COMPONENTS_PAGE_ID, name: COMPONENTS_PAGE_NAME});
    doc.pages.push(COMPONENTS_PAGE_ID);
  }
  if (!doc.pages.length) throw new FigmaImportError('The file has no pages that can be imported.');

  // ── Nodes, parents first ─────────────────────────────────────────────────────────────────
  const matrices = new Map<Entry, Matrix>();
  const matrixOf = (entry: Entry) => {
    let m = matrices.get(entry);
    if (!m) matrices.set(entry, m = space.placed(entry));
    return m;
  };
  let instances = 0, components = 0;
  for (const {entry, parent, pageId} of outputs) {
    const type = plan.typeOf(entry)!;
    const id = refs.get(entry.node.id)!;
    const parentNode = parent ? doc.nodes[refs.get(parent.node.id)!] : doc.nodes[pageId];
    if (!parentNode) continue;
    const local = relativeTo(parent ? matrixOf(parent) : IDENTITY, matrixOf(entry));
    const {width, height} = figmaSize(entry);
    const placed = place(local, width, height);
    const mainId = plan.mainIdOf(entry);
    let detached: {componentName: string} | undefined;
    if (entry.node.type === 'INSTANCE' && type === 'FRAME' && plan.isRootInstance(entry)) {
      const meta = file.components && entry.node.componentId && Object.hasOwn(file.components, entry.node.componentId) ? file.components[entry.node.componentId] : undefined;
      const componentName = meta?.name ?? entry.node.name ?? '';
      detached = {componentName};
      const reason = plan.detachReason(entry);
      const note = (key: string, message: string) => report.note(key, 'components', message, componentName);
      if (reason === 'remote') note('detached-remote', 'Instances of library components were detached and imported as frames: only this file is imported into Morfa');
      else if (reason === 'missing') note('detached-missing', 'Instances of components that are not in the file were detached and imported as frames');
      else note('detached-mismatch', 'Instances that did not match their component were detached and imported as frames');
    }
    const node = buildNode({entry, type, id, mainId, parent: parentNode, parentFigma: parent?.node, placed, detached}, context);
    doc.nodes[id] = node;
    (parentNode.children ??= []).push(id);
    if (type === 'INSTANCE' && mainId === undefined) instances++;
    if (type === 'COMPONENT' && mainId === undefined) components++;
  }

  removeEmptyGroups(doc);
  const groups = Object.values(doc.nodes).filter(node => node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION').map(node => node.id);
  if (groups.length) {
    const {updates} = groupFitUpdates(doc, groups);
    for (const [id, update] of updates) if (doc.nodes[id]) doc.nodes[id] = {...doc.nodes[id], ...update} as SceneNode;
  }
  attachStyles(doc, file, styleUses, report);
  exposeCopies(doc);
  const {unresolved} = inferOverrides(doc);
  if (unresolved) report.note('components-unresolved', 'components', 'Some layers in instances differ from the component in a way that cannot be recorded as an override: after the component is edited they will follow it', undefined, unresolved);
  if (context.variables.count) report.note('variables', 'styles', 'Variables are not imported: Figma provides them only on the Enterprise plan. Layers received their current values', undefined, context.variables.count);

  const imageRefs = figmaImageRefs(doc);
  let layers = 0;
  for (const node of Object.values(doc.nodes)) if (node.type !== 'PAGE') layers++;
  return {
    doc,
    imageRefs,
    report: report.build({fileName: (file.name ?? '').slice(0, L.name), pages: doc.pages.length, nodes: layers, components, instances, images: imageRefs.length}),
  };
}

/** A copy of an exposed nested instance is exposed as its source is (Figma's file may mark only the main's), so the
 *  instance sync that follows the import changes nothing. */
function exposeCopies(doc: DesignDocument): void {
  const memo = new Map<NodeId, boolean>();
  const exposed = (id: NodeId, depth: number): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const node = doc.nodes[id];
    const value = node?.type === 'INSTANCE' && (node.mainId !== undefined && depth < 64 ? exposed(node.mainId, depth + 1) : !!node.isExposedInstance);
    memo.set(id, value);
    return value;
  };
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'INSTANCE' || node.mainId === undefined) continue;
    const want = exposed(node.id, 0);
    if (want === !!node.isExposedInstance) continue;
    const next = {...node};
    if (want) next.isExposedInstance = true;
    else delete next.isExposedInstance;
    doc.nodes[node.id] = next;
  }
}

/** Groups and boolean operations left without children (everything in them was skipped). */
function removeEmptyGroups(doc: DesignDocument): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of Object.values(doc.nodes)) {
      if ((node.type !== 'GROUP' && node.type !== 'BOOLEAN_OPERATION') || node.children?.length) continue;
      delete doc.nodes[node.id];
      const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
      if (parent?.children) parent.children = parent.children.filter(id => id !== node.id);
      changed = true;
    }
  }
}
