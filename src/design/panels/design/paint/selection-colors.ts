import type {DesignDocument, Effect, NodeId, Paint, RGB, SceneNode} from '../../../../../shared/design/types';
import type {NodeUpdates} from '../../../../../shared/design/constraints';
import {colorKey} from './color';

// "Selection colors" and the picker's "Document colors": every solid colour a set of layers uses
// (fills, strokes, coloured ranges of text, shadows), and replacing one of them everywhere in the
// selection at once. Pure, tested in node (tests/design-paint.test.ts).

export type ColorUse = {key: string; color: RGB; opacity: number; count: number};

/** Nodes walked at most per listing: a 20 000-layer selection stays responsive (Figma also caps it). */
export const COLOR_WALK_LIMIT = 10_000;

type Visit = (color: RGB, opacity: number) => void;

function visitPaints(paints: readonly Paint[] | undefined, visit: Visit) {
  if (!paints) return;
  for (const paint of paints) if (paint.type === 'SOLID') visit(paint.color, paint.opacity);
}

function visitEffects(effects: readonly Effect[], visit: Visit) {
  for (const effect of effects) if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') visit(effect.color, effect.color.a);
}

/** Every solid colour of one node, in the order the panel lists them. */
export function visitNodeColors(node: SceneNode, visit: Visit) {
  visitPaints(node.fills, visit);
  if (node.text) for (const run of node.text.runs) visitPaints(run.fills, visit);
  visitPaints(node.strokes, visit);
  visitEffects(node.effects, visit);
}

/** The nodes and their descendants, depth first, at most `limit` of them. */
export function walkSubtrees(doc: DesignDocument, ids: readonly NodeId[], visit: (node: SceneNode) => void, limit = COLOR_WALK_LIMIT): boolean {
  const stack = [...ids].reverse();
  const seen = new Set<NodeId>();
  let count = 0;
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = doc.nodes[id];
    if (!node) continue;
    if (++count > limit) return false;
    visit(node);
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return true;
}

type NodeColor = {key: string; color: RGB; opacity: number};
const NO_COLORS: readonly NodeColor[] = [];
/** Each published node's own colours, by object identity: a document changes a few node objects per
 *  edit, so listing a large selection again (after a nudge, a rename) reads cached lists, and only
 *  the changed nodes work out their colour keys. */
const nodeColorLists = new WeakMap<SceneNode, readonly NodeColor[]>();
function ownColors(node: SceneNode): readonly NodeColor[] {
  let list = nodeColorLists.get(node);
  if (!list) {
    const found: NodeColor[] = [];
    visitNodeColors(node, (color, opacity) => void found.push({key: colorKey(color, opacity), color, opacity}));
    list = found.length ? found : NO_COLORS;
    nodeColorLists.set(node, list);
  }
  return list;
}

/** The distinct colours used in the selection's subtrees, in the order they are first met. Reads a
 *  published document only (node objects are cached by identity; a transaction's draft may still change). */
export function collectSelectionColors(doc: DesignDocument, ids: readonly NodeId[], limit = COLOR_WALK_LIMIT): ColorUse[] {
  const uses = new Map<string, ColorUse>();
  walkSubtrees(doc, ids, node => {
    for (const {key, color, opacity} of ownColors(node)) {
      const use = uses.get(key);
      if (use) use.count++;
      else uses.set(key, {key, color: {r: color.r, g: color.g, b: color.b}, opacity, count: 1});
    }
  }, limit);
  return [...uses.values()];
}

/** Whether a listing made on an earlier document still holds on `after`, which differs from it only in `changed`
 *  nodes: none of them was added, removed, moved to another parent, given other children or other
 *  colours (a nudge, a resize, a rename). `before(id)` is the node as the listing saw it — from the patches'
 *  inverses, not from the earlier document object: the store may write its table in place.
 *  Costs what changed, not what is selected. */
export function sameSelectionColors(before: (id: NodeId) => SceneNode | undefined, after: DesignDocument, changed: Iterable<NodeId>): boolean {
  for (const id of changed) {
    const a = before(id), b = after.nodes[id];
    if (a === b) continue;
    if (!a || !b || a.parentId !== b.parentId || a.children !== b.children) return false;
    const was = ownColors(a), now = ownColors(b);
    if (was !== now && (was.length !== now.length || was.some((use, i) => use.key !== now[i].key))) return false;
  }
  return true;
}

/** Ids in the subtrees that use the colour `key` (a gesture computes them once, then rewrites only these). */
export function nodesUsingColor(doc: DesignDocument, ids: readonly NodeId[], key: string, limit = COLOR_WALK_LIMIT): NodeId[] {
  const out: NodeId[] = [];
  walkSubtrees(doc, ids, node => {
    let uses = false;
    visitNodeColors(node, (color, opacity) => {
      if (!uses && colorKey(color, opacity) === key) uses = true;
    });
    if (uses) out.push(node.id);
  }, limit);
  return out;
}

function replaceInPaints(paints: Paint[], key: string, color: RGB, opacity: number): Paint[] | null {
  let next: Paint[] | null = null;
  paints.forEach((paint, i) => {
    if (paint.type !== 'SOLID' || colorKey(paint.color, paint.opacity) !== key) return;
    next ??= [...paints];
    const replaced = {...paint, color: {...color}, opacity};
    delete replaced.boundVariables;
    next[i] = replaced;
  });
  return next;
}

/** The fields of `node` with colour `key` replaced (null when it does not use it). */
export function replaceColorInNode(node: SceneNode, key: string, color: RGB, opacity: number): Partial<SceneNode> | null {
  const patch: Partial<SceneNode> = {};
  const fills = replaceInPaints(node.fills, key, color, opacity);
  if (fills) patch.fills = fills;
  const strokes = replaceInPaints(node.strokes, key, color, opacity);
  if (strokes) patch.strokes = strokes;
  if (node.text?.runs.some(run => run.fills)) {
    let changed = false;
    const runs = node.text.runs.map(run => {
      const runFills = run.fills && replaceInPaints(run.fills, key, color, opacity);
      if (!runFills) return run;
      changed = true;
      return {...run, fills: runFills};
    });
    if (changed) patch.text = {...node.text, runs};
  }
  let effectsChanged = false;
  const effects = node.effects.map(effect => {
    if ((effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') || colorKey(effect.color, effect.color.a) !== key) return effect;
    effectsChanged = true;
    return {...effect, color: {r: color.r, g: color.g, b: color.b, a: opacity}};
  });
  if (effectsChanged) patch.effects = effects;
  return Object.keys(patch).length ? patch : null;
}

/** Updates that replace colour `key` with `color` at `opacity` in every node of the subtrees (or only in `among`). */
export function replaceColorUpdates(doc: DesignDocument, ids: readonly NodeId[], key: string, color: RGB, opacity: number, among?: readonly NodeId[]): NodeUpdates {
  const updates: NodeUpdates = new Map();
  for (const id of among ?? nodesUsingColor(doc, ids, key)) {
    const node = doc.nodes[id];
    const patch = node && replaceColorInNode(node, key, color, opacity);
    if (patch) updates.set(id, patch);
  }
  return updates;
}

// ── Document colours ───────────────────────────────────────────────────────────────────────────

const documentColors = new WeakMap<DesignDocument, ColorUse[]>();

/** Colours used anywhere in the file, most frequent first (the picker's swatches). Cached per
 *  document, so reopening the picker on an unchanged file costs nothing. (Per document, not per node
 *  table: the store may write its table in place, so the table's identity says
 *  nothing about the file having changed; the document object is new per commit.) */
export function collectDocumentColors(doc: DesignDocument, limit = 18): ColorUse[] {
  let all = documentColors.get(doc);
  if (!all) {
    const uses = new Map<string, ColorUse>();
    let order = 0;
    const first = new Map<string, number>();
    for (const id in doc.nodes) {
      const node = doc.nodes[id];
      if (node.type === 'PAGE') continue;
      visitNodeColors(node, (color, opacity) => {
        const key = colorKey(color, opacity);
        const use = uses.get(key);
        if (use) use.count++;
        else {
          uses.set(key, {key, color: {r: color.r, g: color.g, b: color.b}, opacity, count: 1});
          first.set(key, order++);
        }
      });
    }
    all = [...uses.values()].sort((a, b) => b.count - a.count || first.get(a.key)! - first.get(b.key)!);
    documentColors.set(doc, all);
  }
  return all.slice(0, limit);
}
