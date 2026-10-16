import type {DesignDocument, ImageAsset, ImageRef, Matrix, NodeId, Paint, SceneNode, Style, StyleId, Vec} from '../../../shared/design/types';
import {CONTAINER_TYPES} from '../../../shared/design/types';
import {createNode, newId, TYPE_NAMES} from '../../../shared/design/defaults';
import {invert, multiply, rectContains, transformRect, translation, unionRects, worldMatrix, type Rect} from '../../../shared/design/geometry';
import {placementChanges, placementFor, type Transaction} from '../../../shared/design/transaction';
import {frameAtPoint, isDropTarget, isInsideInstance, sortByPaintOrder, topLevelSelection, type SpatialIndex} from '../../../shared/design/tree';
import {documentCaps} from '../../../shared/design/big-files';
import {validatePatch} from '../../../shared/design/schema';
import {mainsAsInstances} from './main-copies';
import {cloneSubtrees} from '../../../shared/design/clone';

// Copy, cut, paste and duplicate. Copies live in an in-memory clipboard and on the system clipboard
// as marked JSON (`{"morfaDesign":1,…}`), so they survive between files and tabs. What comes back
// from the system clipboard is untrusted text: it is parsed, bounded and rebuilt node by node
// through `createNode` before anything reaches a document, and pictures are only accepted as
// same-origin `/uploads/…` (docs/design-tool.md §Rules).

export const CLIPBOARD_VERSION = 1;

export type ClipboardPayload = {
  morfaDesign: typeof CLIPBOARD_VERSION;
  /** Copied roots, back to front. */
  roots: NodeId[];
  /** The roots and their subtrees as they were. */
  nodes: Record<NodeId, SceneNode>;
  /** Each root's local → page matrix when copied. */
  world: Record<NodeId, Matrix>;
  /** Each root's parent's local → page matrix when copied (pasting into a frame keeps the offset). */
  parentWorld: Record<NodeId, Matrix>;
  styles: Record<StyleId, Style>;
  images: Record<ImageRef, ImageAsset>;
  /** Main components the copied instances showed and the file had when copied: an instance whose main is one of these
   *  and is missing where it is pasted came from another file (its main did not travel with it). */
  mains?: NodeId[];
};

// ── Cloning ──────────────────────────────────────────────────────────────────────────────────────

// `cloneSubtrees` lives in shared/design/clone.ts: the server builds a board template's pieces with it too.
export {cloneSubtrees};

/** Creates cloned nodes (from `cloneSubtrees`) in a transaction: each root under `parentId` at the
 *  given index, descendants under their copied parents. */
export function insertClones(tx: Transaction, clones: readonly SceneNode[], parentFor: (root: SceneNode) => {parentId: NodeId; index?: number}) {
  const created = new Set<NodeId>();
  for (const node of clones) {
    if (node.parentId && created.has(node.parentId)) {
      tx.create(node, node.parentId);
    } else {
      const {parentId, index} = parentFor(node);
      tx.create(node, parentId, index);
    }
    created.add(node.id);
  }
}

// ── The payload ──────────────────────────────────────────────────────────────────────────────────

function collectStyles(doc: DesignDocument, nodes: Iterable<SceneNode>): Record<StyleId, Style> {
  const out: Record<StyleId, Style> = {};
  const take = (id: StyleId | undefined) => {
    if (id && doc.styles[id]) out[id] = doc.styles[id];
  };
  for (const node of nodes) {
    take(node.fillStyleId);
    take(node.strokeStyleId);
    take(node.effectStyleId);
    take(node.gridStyleId);
    take(node.textStyleId);
    for (const run of node.text?.runs ?? []) take(run.textStyleId);
  }
  return out;
}

const imageRefsOf = (paints: readonly Paint[] | undefined, into: Set<ImageRef>) => {
  for (const paint of paints ?? []) if (paint.type === 'IMAGE' && paint.imageRef) into.add(paint.imageRef);
};

function collectImages(doc: DesignDocument, nodes: Iterable<SceneNode>): Record<ImageRef, ImageAsset> {
  const refs = new Set<ImageRef>();
  for (const node of nodes) {
    imageRefsOf(node.fills, refs);
    imageRefsOf(node.strokes, refs);
    for (const run of node.text?.runs ?? []) imageRefsOf(run.fills, refs);
  }
  const out: Record<ImageRef, ImageAsset> = {};
  for (const ref of refs) if (doc.images[ref]) out[ref] = doc.images[ref];
  return out;
}

/** The payload for copying `ids` (their top-level part, without pages or nodes inside instances
 *  taken alone… those become ordinary layers when pasted). Null when nothing can be copied. */
export function buildClipboardPayload(doc: DesignDocument, ids: readonly NodeId[]): ClipboardPayload | null {
  const roots = sortByPaintOrder(doc, topLevelSelection(doc, ids).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE'));
  if (!roots.length) return null;
  const nodes: Record<NodeId, SceneNode> = {};
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    nodes[id] = node;
    stack.push(...(node.children ?? []));
  }
  const world: Record<NodeId, Matrix> = {}, parentWorld: Record<NodeId, Matrix> = {};
  for (const id of roots) {
    world[id] = worldMatrix(doc, id);
    parentWorld[id] = worldMatrix(doc, doc.nodes[id].parentId!);
  }
  const all = Object.values(nodes);
  const mains = [...new Set(all.flatMap(node => (node.type === 'INSTANCE' && node.componentId && doc.nodes[node.componentId] ? [node.componentId] : [])))];
  return {morfaDesign: CLIPBOARD_VERSION, roots, nodes, world, parentWorld, styles: collectStyles(doc, all), images: collectImages(doc, all), ...(mains.length ? {mains} : {})};
}

export const serializePayload = (payload: ClipboardPayload) => JSON.stringify(payload);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isMatrix = (value: unknown): value is Matrix =>
  Array.isArray(value) && value.length === 2 && value.every(row => Array.isArray(row) && row.length === 3 && row.every(isFiniteNumber));
const NODE_TYPES = new Set(Object.keys(TYPE_NAMES));
const NUMBER_FIELDS = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'strokeWeight', 'strokeMiterLimit'] as const;

/** Rebuilds one node from untrusted data: the fields a node always has come from `createNode` and
 *  are only replaced by values of the same kind; sizes are clamped to ≥ 0. */
function sanitizeNode(raw: unknown): SceneNode | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string' || !NODE_TYPES.has(raw.type) || raw.type === 'PAGE') return null;
  const base = createNode(raw.type as SceneNode['type'], {id: raw.id});
  const out: Record<string, unknown> = {...base};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'id' || key === 'type' || key === 'parentId' || key === 'children' || value === undefined || value === null) continue;
    const current = (base as unknown as Record<string, unknown>)[key];
    if (current === undefined) {
      // Type-specific or optional fields the defaults leave out: plain JSON values only.
      if (typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value) || isRecord(value) || Array.isArray(value)) out[key] = value;
      continue;
    }
    if (Array.isArray(current) ? Array.isArray(value) : typeof current === typeof value && (typeof value !== 'number' || Number.isFinite(value))) out[key] = value;
  }
  for (const key of NUMBER_FIELDS) if (!isFiniteNumber(out[key])) out[key] = (base as unknown as Record<string, number>)[key];
  out.width = Math.max(0, out.width as number);
  out.height = Math.max(0, out.height as number);
  out.children = CONTAINER_TYPES.includes(base.type) ? (Array.isArray(raw.children) ? raw.children.filter((id): id is string => typeof id === 'string') : []) : undefined;
  if (!out.children) delete out.children;
  out.parentId = typeof raw.parentId === 'string' ? raw.parentId : null;
  return out as unknown as SceneNode;
}

const safeImage = (asset: unknown): asset is ImageAsset =>
  isRecord(asset) && typeof asset.url === 'string' && /^\/uploads\/[^/?#]+$/.test(asset.url) && !asset.url.includes('..') && isFiniteNumber(asset.width) && isFiniteNumber(asset.height);

/** The node as the server would store it (shared/design/schema.ts, unknown keys dropped), or null. Copied text
 *  comes from anywhere: a field the schema refuses (a javascript: link, a malformed text or paint) would otherwise
 *  sit in the document, and every later autosave, which carries the failed patch along, would be refused with it. */
function storable(node: SceneNode): SceneNode | null {
  // Links to the tree are rebuilt by the caller (children) and the paste (parents).
  const {children, parentId} = node;
  const checked = validatePatch({nodes: {[node.id]: {...node, parentId: null, ...(children ? {children: []} : {})}}});
  if (!checked.ok) return null;
  const value = checked.value.nodes![node.id]!;
  value.parentId = parentId;
  if (children) value.children = children;
  return value;
}

/** Reads a payload from clipboard text. Anything that is not a well-formed copy gives null. */
export function parsePayload(text: string | null | undefined): ClipboardPayload | null {
  if (!text || text.length > documentCaps().bytes || !text.trimStart().startsWith('{')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.morfaDesign !== CLIPBOARD_VERSION || !Array.isArray(raw.roots) || !isRecord(raw.nodes)) return null;
  const rawNodes = raw.nodes;
  const nodes: Record<NodeId, SceneNode> = {};
  const roots: NodeId[] = [];
  let count = 0;
  const visit = (id: unknown, parentId: NodeId | null): boolean => {
    if (typeof id !== 'string' || Object.hasOwn(nodes, id) || ++count > documentCaps().nodes) return false;
    const sanitized = sanitizeNode(Object.hasOwn(rawNodes, id) ? rawNodes[id] : undefined);
    const node = sanitized && sanitized.id === id ? storable(sanitized) : null;
    if (!node) return false;
    if (parentId) node.parentId = parentId;
    nodes[id] = node;
    if (node.children) node.children = node.children.filter(child => visit(child, id));
    return true;
  };
  for (const id of raw.roots) if (visit(id, null)) roots.push(id as string);
  if (!roots.length) return null;
  const world: Record<NodeId, Matrix> = {}, parentWorld: Record<NodeId, Matrix> = {};
  const rawWorld = isRecord(raw.world) ? raw.world : {}, rawParentWorld = isRecord(raw.parentWorld) ? raw.parentWorld : {};
  for (const id of roots) {
    const node = nodes[id];
    world[id] = isMatrix(rawWorld[id]) ? rawWorld[id] : [[1, 0, node.x], [0, 1, node.y]];
    parentWorld[id] = isMatrix(rawParentWorld[id]) ? rawParentWorld[id] : [[1, 0, 0], [0, 1, 0]];
  }
  const styles: Record<StyleId, Style> = {};
  if (isRecord(raw.styles)) {
    for (const [id, style] of Object.entries(raw.styles)) {
      if (!isRecord(style) || style.id !== id || typeof style.name !== 'string' || !['FILL', 'TEXT', 'EFFECT', 'GRID'].includes(style.type as string)) continue;
      const checked = validatePatch({styles: {[id]: style}});
      if (checked.ok) styles[id] = checked.value.styles![id]!;
    }
  }
  const images: Record<ImageRef, ImageAsset> = {};
  if (isRecord(raw.images)) {
    for (const [ref, asset] of Object.entries(raw.images)) {
      if (!safeImage(asset)) continue;
      const checked = validatePatch({images: {[ref]: {url: asset.url, width: asset.width, height: asset.height, ...(typeof asset.name === 'string' ? {name: asset.name} : {})}}});
      if (checked.ok) images[ref] = checked.value.images![ref]!;
    }
  }
  const mains = Array.isArray(raw.mains) ? raw.mains.filter((id): id is string => typeof id === 'string' && id.length <= 256).slice(0, documentCaps().nodes) : [];
  return {morfaDesign: CLIPBOARD_VERSION, roots, nodes, world, parentWorld, styles, images, ...(mains.length ? {mains} : {})};
}

let internal: {payload: ClipboardPayload; text: string} | null = null;

/** Remembers a copy in memory (used when the system clipboard is not readable). */
export function setInternalClipboard(payload: ClipboardPayload): string {
  const text = serializePayload(payload);
  internal = {payload, text};
  return text;
}

/** The payload for pasting: from the system clipboard text when it carries one, otherwise the
 *  in-memory copy (only when the system clipboard could not be read at all). */
export function resolvePayload(systemText: string | null | undefined): ClipboardPayload | null {
  if (systemText !== null && systemText !== undefined) {
    if (internal && systemText === internal.text) return internal.payload;
    return parsePayload(systemText);
  }
  return internal?.payload ?? null;
}

// ── Pasting ──────────────────────────────────────────────────────────────────────────────────────

export type PasteView = {
  /** Page point at the canvas's centre. */
  center: Vec;
  /** The part of the page on screen. */
  visible: Rect;
  index?: SpatialIndex | null;
};

export type PasteTarget = {parentId: NodeId; index?: number; mode: 'world' | 'centre' | 'relative'; centre?: Vec};

const boundsOf = (payload: ClipboardPayload, shift: Matrix = [[1, 0, 0], [0, 1, 0]]): Rect =>
  unionRects(payload.roots.map(id => transformRect(multiply(shift, payload.world[id]), {x: 0, y: 0, width: payload.nodes[id].width, height: payload.nodes[id].height}))) ?? {x: 0, y: 0, width: 0, height: 0};

/** Where a paste lands, like Figma: inside the selected frame (keeping the copied offset when it
 *  fits, centred otherwise); above the selected layer; or, with nothing selected, in the frame under
 *  the copy (or the middle of the screen), never one of the copied layers. The copies keep their place when it is on screen and are centred on the
 *  screen otherwise. "Paste in place" (`inPlace`) always keeps the copied position. */
export function choosePasteTarget(doc: DesignDocument, pageId: NodeId, selection: readonly NodeId[], payload: ClipboardPayload, view: PasteView, inPlace: boolean): PasteTarget {
  const bounds = boundsOf(payload);
  const selected = sortByPaintOrder(doc, selection.filter(id => doc.nodes[id] && !isInsideInstance(doc, id)));
  const top = selected.at(-1);
  const frame = selected.length === 1 && top && isDropTarget(doc.nodes[top]) && !payload.roots.includes(top) ? top : null;
  if (frame) {
    if (inPlace) return {parentId: frame, mode: 'world'};
    const world = worldMatrix(doc, frame);
    const node = doc.nodes[frame];
    const relative = unionRects(payload.roots.map(id => transformRect(multiply(invert(payload.parentWorld[id]), payload.world[id]), {x: 0, y: 0, width: payload.nodes[id].width, height: payload.nodes[id].height})));
    if (relative && rectContains({x: 0, y: 0, width: node.width, height: node.height}, relative)) return {parentId: frame, mode: 'relative'};
    const centre = transformRect(world, {x: 0, y: 0, width: node.width, height: node.height});
    return {parentId: frame, mode: 'centre', centre: {x: centre.x + centre.width / 2, y: centre.y + centre.height / 2}};
  }
  const visibleNow = rectContains(view.visible, bounds);
  if (top) {
    const parentId = doc.nodes[top].parentId!;
    const index = (doc.nodes[parentId].children ?? []).indexOf(top) + 1;
    return {parentId, index, mode: inPlace || visibleNow ? 'world' : 'centre', centre: view.center};
  }
  // Never into the copied layers themselves (a frame pasted back on its place lands beside it, not inside it).
  const originals = new Set(payload.roots.filter(id => doc.nodes[id]));
  if (inPlace) return {parentId: frameAtPoint(doc, pageId, {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2}, originals, view.index) ?? pageId, mode: 'world'};
  const parentId = frameAtPoint(doc, pageId, visibleNow ? {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2} : view.center, originals, view.index) ?? pageId;
  return {parentId, mode: visibleNow ? 'world' : 'centre', centre: view.center};
}

/** Pastes the payload in a transaction; returns the new root ids (the new selection). */
export function pastePayload(tx: Transaction, payload: ClipboardPayload, target: PasteTarget, makeId: () => NodeId = newId): NodeId[] {
  const doc = tx.doc;
  for (const [id, style] of Object.entries(payload.styles)) if (!doc.styles[id]) tx.setStyle(style);
  for (const [ref, asset] of Object.entries(payload.images)) if (!doc.images[ref]) tx.setImage(ref, asset);
  // A main this file holds pastes as an instance of it (main-copies.ts).
  const {nodes: clones, ids} = mainsAsInstances(doc, payload.nodes, payload.roots, cloneSubtrees(payload.nodes, payload.roots, makeId), target.parentId);
  // Bindings to variables this file does not have are dropped; the concrete values stay.
  for (const clone of clones) {
    if (clone.boundVariables) {
      const kept = Object.fromEntries(Object.entries(clone.boundVariables).filter(([, alias]) => doc.variables[alias.id]));
      if (Object.keys(kept).length) clone.boundVariables = kept;
      else delete clone.boundVariables;
    }
  }
  const parentWorld = worldMatrix(doc, target.parentId);
  let shift: Matrix = [[1, 0, 0], [0, 1, 0]];
  if (target.mode === 'centre' && target.centre) {
    const bounds = boundsOf(payload);
    shift = translation(Math.round(target.centre.x - (bounds.x + bounds.width / 2)), Math.round(target.centre.y - (bounds.y + bounds.height / 2)));
  }
  const rootIds = new Set(payload.roots.map(id => ids.get(id)!));
  const oldOf = new Map([...ids].map(([old, fresh]) => [fresh, old]));
  let index = target.index;
  for (const clone of clones) {
    if (!rootIds.has(clone.id)) continue;
    const old = oldOf.get(clone.id)!;
    const world = target.mode === 'relative' ? multiply(parentWorld, multiply(invert(payload.parentWorld[old]), payload.world[old])) : multiply(shift, payload.world[old]);
    Object.assign(clone, placementChanges(clone, placementFor(clone, multiply(invert(parentWorld), world))));
  }
  insertClones(tx, clones, () => {
    const at = index;
    if (index !== undefined) index++;
    return {parentId: target.parentId, index: at};
  });
  return payload.roots.map(id => ids.get(id)!);
}
