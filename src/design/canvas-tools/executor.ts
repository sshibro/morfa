// The canvas tools as a document runs them (docs/mcp-server.md §Editing): create, update, delete and duplicate layers and add colour
// styles. Each call is checked (shared/design/canvas-tools-check.ts checkCanvasTool) and then run against a document in a store.
// Rules:
//   - every edit is exactly one step, through the store's `transact`;
//   - a change a person could make by hand goes through `userUpdate` (styles detach, instance copies record overrides), what follows
//     from it (children following a resize, sizing a layout forces) is written as the engine computes it;
//   - every new layer and changed field is checked with the server's schema before it enters (`storableNode`), so a call can never
//     stop the file from saving: what would be refused is left out and reported, never repaired into something else;
//   - a call that fails reports `ok: false` with the reason; nothing here throws.
// Results are written for the model: concise English, layers named by their aliases.
// Loaded with the first call (the MCP server imports it dynamically): it brings the tools' checker and its schema library.
import {CANVAS_RESULT_CHARS, type CanvasLayerUpdate, type CanvasToolInputs, type CanvasToolResult} from '../../../shared/design/canvas-tools';
import {checkCanvasTool} from '../../../shared/design/canvas-tools-check';
import {resizeUpdates} from '../../../shared/design/constraints';
import {newId} from '../../../shared/design/defaults';
import {applyLinear, invert, worldMatrix, type Rect} from '../../../shared/design/geometry';
import {canFill, canHug, effectiveSizing, layoutSizingUpdates} from '../../../shared/design/layout';
import {isEmptyPatch} from '../../../shared/design/patch';
import {applyFillsToRange, applyStyleToRange, insertText} from '../../../shared/design/text-edit';
import type {Transaction} from '../../../shared/design/transaction';
import {isAncestor, isContainerNode, isInsideInstance, pageIdOf, sortByPaintOrder, topLevelSelection} from '../../../shared/design/tree';
import type {DesignDocument, NodeId, SceneNode, TextStyle} from '../../../shared/design/types';
import {cloneSubtrees, insertClones} from '../engine/clipboard';
import {besideOffset} from '../engine/commands/edit';
import {removeNodes} from '../engine/commands/structure';
import {mainsAsInstances} from '../engine/main-copies';
import type {DesignStore, RefusalReason, TransactOptions} from '../engine/store';
import {userUpdate} from '../engine/user-edit';
import type {CanvasAliases} from './aliases';
import {autoLayoutOf, buildNodes, hexPaint, specsBounds} from './build';
import {applyPalette, freeSpot, storableNode} from './document';

/** What a tool call runs against. */
export type CanvasToolContext = {
  store: DesignStore;
  aliases: CanvasAliases;
  /** The catalogue's spelling of a font family, or null. */
  font(family: string): string | null;
  /** Where new screens go. */
  view(): Rect;
};

export type CanvasToolOutcome = {
  /** What goes back to the caller. */
  result: CanvasToolResult;
  /** New top-level layers (`create_layers`) or copies (`duplicate_layers`). */
  created: NodeId[];
  /** Layers created in all (`create_layers`, children included). */
  createdCount: number;
  /** Layers the call changed. */
  touched: NodeId[];
};

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

const round = (value: number) => {
  const r = Math.round(value * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
};
const quote = (text: string) => JSON.stringify(text.length > 60 ? text.slice(0, 60) + '…' : text);
/** A result's text within the cap, cut with a note. */
export function clipResult(text: string): string {
  const max = CANVAS_RESULT_CHARS;
  if (text.length <= max) return text;
  const note = '\n…(cut: the result was longer than the tool result cap)';
  return text.slice(0, max - note.length) + note;
}
const outcome = (call: {id: string}, ok: boolean, text: string, extra: Partial<CanvasToolOutcome> = {}): CanvasToolOutcome => ({
  result: {id: call.id, ok, text: clipResult(text)},
  created: [],
  createdCount: 0,
  touched: [],
  ...extra,
});
const failed = (call: {id: string}, text: string) => outcome(call, false, text);

const REFUSALS: Record<RefusalReason, string> = {
  readOnly: 'The file is open read-only for the person: nothing can be changed. Tell the person instead of retrying.',
  devMode: 'The editor is in "Code" (inspection) mode, where edits are refused. Ask the person to switch back to design mode.',
  memory: 'The file has reached its memory budget: layers cannot be added now. Change or remove layers instead, or tell the person.',
};

/** Runs one undo step and says whether the store refused it (read-only, "Code", the memory budget) and whether anything changed. */
function transact(store: DesignStore, label: string, recipe: (tx: Transaction) => void | {select?: readonly NodeId[]}, options?: TransactOptions): {refused: RefusalReason | null; changed: boolean} {
  const seen: {reason: RefusalReason | null} = {reason: null};
  const off = store.onRefused((_label, reason) => {
    seen.reason = reason;
  });
  try {
    const result = store.transact(label, recipe, options);
    return {refused: seen.reason, changed: !isEmptyPatch(result.patch)};
  } finally {
    off();
  }
}

/** Why a layer cannot take new children (or moved ones), or null when it can. */
function holdProblem(doc: DesignDocument, node: SceneNode): string | null {
  if (!isContainerNode(node) || node.type === 'PAGE') return `is a ${node.type}, which cannot hold layers: use a FRAME.`;
  if (node.type === 'INSTANCE' || isInsideInstance(doc, node.id)) return 'is an instance (or inside one): its layers follow its main component, so nothing can be added there.';
  if (node.type === 'BOOLEAN_OPERATION') return 'is a boolean operation: only its shapes belong inside.';
  if (node.type === 'COMPONENT_SET') return 'is a component set: it holds variants only.';
  return null;
}

/** Layers that take one corner radius. */
const RADIUS_TYPES = new Set<SceneNode['type']>(['RECTANGLE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'POLYGON', 'STAR', 'SECTION']);

// ── The entry ───────────────────────────────────────────────────────────────────────────────────

/** Runs one tool call. Never throws: a failure is `ok: false`. */
export async function runCanvasTool(call: {id: string; name: string; input: unknown}, ctx: CanvasToolContext): Promise<CanvasToolOutcome> {
  const checked = checkCanvasTool(call.name, call.id, call.input, ctx.font);
  if (!checked.ok) return failed(call, `The editor's check refused this call: ${checked.problems.join(' ')}`);
  const checkedCall = checked.call;
  try {
    switch (checkedCall.name) {
      case 'create_layers':
        return createLayers(checkedCall, ctx);
      case 'update_layers':
        return updateLayers(checkedCall, ctx);
      case 'delete_layers':
        return deleteLayers(checkedCall, ctx);
      case 'duplicate_layers':
        return duplicateLayers(checkedCall, ctx);
      case 'add_color_styles':
        return addColorStyles(checkedCall, ctx);
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : String(error);
    return failed(checkedCall, `The editor failed to run ${call.name}: ${message}`);
  }
}

type Call<K extends keyof CanvasToolInputs> = {id: string; name: K; input: CanvasToolInputs[K]};

// ── create_layers ───────────────────────────────────────────────────────────────────────────────

function createLayers(call: Call<'create_layers'>, ctx: CanvasToolContext): CanvasToolOutcome {
  const {store, aliases} = ctx;
  const {doc, pageId} = store.getState();
  let parent = doc.nodes[pageId];
  if (call.input.parent) {
    const id = aliases.resolve(call.input.parent);
    const node = id ? doc.nodes[id] : undefined;
    if (!node) return failed(call, `${call.input.parent} does not name a layer any more. Create on the page (parent null) or read the layers with morfa_get_layers for current ids.`);
    const problem = holdProblem(doc, node);
    if (problem) return failed(call, `${call.input.parent} ${problem}`);
    parent = node;
  }
  if (!parent) return failed(call, 'The page is not loaded.');
  const specs = call.input.layers;
  if (!specs.length) return failed(call, 'No layers to create.');
  // On the page: the layers' box centred in the view, moved right past what stands there; in a frame: at the specs' own positions.
  const bounds = specsBounds(specs);
  let offset = {x: 0, y: 0};
  if (!call.input.parent && bounds) {
    const view = ctx.view();
    const spot = freeSpot(doc, pageId, {x: view.x + view.width / 2 - bounds.width / 2, y: view.y + view.height / 2 - bounds.height / 2, width: bounds.width, height: bounds.height});
    offset = {x: spot.x - bounds.x, y: spot.y - bounds.y};
  } else if (bounds) offset = {x: Math.max(0, -bounds.x), y: Math.max(0, -bounds.y)};
  const built = buildNodes(specs, parent, offset, newId);
  // Parents come before their children: a layer the file cannot store takes its subtree with it.
  const left = new Set<NodeId>();
  const nodes = built.nodes.filter(node => {
    if (!left.has(node.parentId!) && storableNode(node)) return true;
    left.add(node.id);
    return false;
  });
  const roots = built.roots.filter(id => !left.has(id));
  if (!nodes.length) return failed(call, `None of the ${specs.length} layers can be stored in the file. Simplify them and try again.`);
  const step = transact(store, 'New layers', tx => {
    for (const node of nodes) tx.create(node, node.parentId!);
    return {select: roots};
  });
  if (step.refused) return failed(call, REFUSALS[step.refused]);
  // Every new layer is named back to the caller (it builds on them next), in the order of its specs.
  const made = new Set(nodes.map(node => node.id));
  const names = specs.map(spec => {
    const id = built.ids.get(spec.id);
    return `${spec.id}→${id && made.has(id) ? aliases.alias(id) : '(left out)'}`;
  });
  const after = store.getState().doc;
  const tops = roots.map(id => {
    const node = after.nodes[id]!;
    return `${aliases.alias(id)} ${node.type} ${quote(node.name)} x=${round(node.x)} y=${round(node.y)} ${round(node.width)}×${round(node.height)}`;
  });
  const where = call.input.parent ? `in ${call.input.parent} ${quote(parent.name)}` : 'on the page';
  const missing = specs.length - nodes.length;
  const text = [
    `Created ${nodes.length} ${nodes.length === 1 ? 'layer' : 'layers'} ${where}${missing ? `; ${missing} left out (the file cannot store them, or their parent was left out)` : ''}.`,
    `Top level: ${tops.join('; ')}.`,
    `Ids (local→id): ${names.join(', ')}.`,
  ].join('\n');
  return outcome(call, true, text, {created: roots, createdCount: nodes.length, touched: roots});
}

// ── update_layers ───────────────────────────────────────────────────────────────────────────────

function updateLayers(call: Call<'update_layers'>, ctx: CanvasToolContext): CanvasToolOutcome {
  const {store, aliases} = ctx;
  const doc = store.getState().doc;
  const problems: string[] = [];
  const done: string[] = [];
  const touched: NodeId[] = [];
  const work: {update: CanvasLayerUpdate; id: NodeId}[] = [];
  for (const update of call.input.updates) {
    const id = aliases.resolve(update.id);
    if (!id || !doc.nodes[id]) problems.push(`${update.id}: no such layer (deleted, or an unknown id).`);
    else if (doc.nodes[id]!.type === 'PAGE') problems.push(`${update.id}: a page cannot be changed.`);
    else work.push({update, id});
  }
  const step = transact(store, 'Change layers', tx => {
    for (const {update, id} of work) {
      const notes: string[] = [];
      try {
        const fields = applyUpdate(tx, id, update, aliases, notes);
        if (fields.length) {
          done.push(`${update.id} (${fields.join(', ')})`);
          touched.push(id);
        }
      } catch (error) {
        notes.push(error instanceof Error && error.message ? error.message : 'the change failed');
      }
      problems.push(...notes.map(note => `${update.id}: ${note}`));
    }
  });
  if (step.refused) return failed(call, REFUSALS[step.refused]);
  const total = call.input.updates.length;
  const lines = [done.length ? `Updated ${done.length} of ${total} ${total === 1 ? 'layer' : 'layers'}: ${done.join('; ')}.` : `Nothing changed (${total} ${total === 1 ? 'update' : 'updates'}).`];
  if (problems.length) lines.push(`Problems: ${problems.join(' ')}`);
  return outcome(call, done.length > 0 || !problems.length, lines.join('\n'), {touched});
}

/** One layer's update inside the step; returns the fields that changed, `notes` gets what could not. */
function applyUpdate(tx: Transaction, id: NodeId, update: CanvasLayerUpdate, aliases: CanvasAliases, notes: string[]): string[] {
  const fields: string[] = [];
  // 1. Where it lives.
  if (update.parent !== undefined || update.index !== undefined) {
    const node = tx.get(id)!;
    if (isInsideInstance(tx.doc, id)) notes.push('it is inside an instance, so it cannot move.');
    else if (update.parent === null) {
      // Onto its page, where it is on screen now (the move keeps its world position).
      const page = pageIdOf(tx.doc, id);
      if (!page) notes.push('its page was not found.');
      else if (node.parentId !== page) {
        tx.move(id, page, update.index === undefined ? undefined : Math.round(update.index));
        fields.push('parent');
      } else if (update.index !== undefined) {
        tx.reorder(id, Math.round(update.index));
        fields.push('index');
      }
    } else if (update.parent !== undefined) {
      const target = aliases.resolve(update.parent);
      const parent = target ? tx.get(target) : undefined;
      const problem = parent ? holdProblem(tx.doc, parent) : null;
      if (!target || !parent) notes.push(`parent ${update.parent}: no such layer.`);
      else if (problem) notes.push(`parent ${update.parent} ${problem}`);
      else if (target === id || isAncestor(tx.doc, id, target)) notes.push(`it cannot move into itself (${update.parent} is inside it).`);
      else {
        tx.move(id, target, update.index === undefined ? undefined : Math.round(update.index));
        fields.push(node.parentId === target ? 'index' : 'parent');
      }
    } else {
      tx.reorder(id, Math.round(update.index!));
      fields.push('index');
    }
  }

  // 2. Its own fields: one hand edit, checked with the server's schema first.
  let node = tx.get(id)!;
  const partial: Partial<SceneNode> = {};
  const named: string[] = [];
  if (update.name !== undefined && update.name !== node.name) {
    partial.name = update.name;
    named.push('name');
  }
  if (update.fill !== undefined) {
    const fills = update.fill === null ? [] : [hexPaint(update.fill)];
    if (node.type === 'TEXT' && node.text && fills.length) {
      // A text's colour is its fills: the whole text takes it, runs lose their own paints.
      const painted = applyFillsToRange(node.text, node.fills, 0, node.text.characters.length, fills);
      partial.text = painted.text;
      partial.fills = painted.fills;
    } else partial.fills = fills;
    named.push('fill');
  }
  if (update.stroke !== undefined) {
    if (update.stroke === null || update.stroke.weight <= 0) partial.strokes = [];
    else {
      partial.strokes = [hexPaint(update.stroke.color)];
      partial.strokeWeight = update.stroke.weight;
    }
    named.push('stroke');
  }
  if (update.cornerRadius !== undefined) {
    if (!RADIUS_TYPES.has(node.type)) notes.push(`a ${node.type} has no corner radius.`);
    else {
      partial.cornerRadius = update.cornerRadius;
      if (node.rectangleCornerRadii) partial.rectangleCornerRadii = null;
      named.push('cornerRadius');
    }
  }
  if (update.opacity !== undefined) {
    partial.opacity = update.opacity;
    named.push('opacity');
  }
  if (update.visible !== undefined) {
    partial.visible = update.visible;
    named.push('visible');
  }
  if (update.layout !== undefined) {
    if (node.type !== 'FRAME' && node.type !== 'COMPONENT') notes.push(`a ${node.type} has no auto layout (FRAME only).`);
    else if (update.layout === null) {
      // Off: the layers stay where layout put them (as "Remove auto layout").
      if (node.autoLayout && node.autoLayout.layoutMode !== 'NONE') {
        partial.autoLayout = {...node.autoLayout, layoutMode: 'NONE'};
        named.push('layout');
      }
    } else {
      const next = autoLayoutOf(update.layout);
      partial.autoLayout = node.autoLayout
        ? {...next, itemReverseZIndex: node.autoLayout.itemReverseZIndex, strokesIncludedInLayout: node.autoLayout.strokesIncludedInLayout, counterAxisAlignContent: node.autoLayout.counterAxisAlignContent}
        : next;
      named.push('layout');
    }
  }
  if (update.text !== undefined) {
    if (node.type !== 'TEXT' || !node.text) notes.push(`a ${node.type} has no text.`);
    else {
      const t = update.text;
      let text = partial.text ?? node.text;
      if (t.characters !== undefined && t.characters !== text.characters) text = insertText(text, 0, text.characters.length, t.characters);
      const style: Partial<TextStyle> = {};
      if (t.fontFamily !== undefined) style.fontFamily = t.fontFamily;
      if (t.fontWeight !== undefined) style.fontWeight = t.fontWeight;
      if (t.fontSize !== undefined) style.fontSize = t.fontSize;
      if (t.lineHeight !== undefined) style.lineHeight = t.lineHeight === null ? {unit: 'AUTO'} : {unit: 'PIXELS', value: t.lineHeight};
      if (t.letterSpacing !== undefined) style.letterSpacing = {unit: 'PERCENT', value: t.letterSpacing ?? 0};
      if (Object.keys(style).length) text = applyStyleToRange(text, 0, text.characters.length, style);
      if (t.align !== undefined) text = {...text, textAlignHorizontal: t.align};
      if (t.color !== undefined) {
        const painted = applyFillsToRange(text, partial.fills ?? node.fills, 0, text.characters.length, [hexPaint(t.color)]);
        text = painted.text;
        partial.fills = painted.fills;
      }
      partial.text = text;
      named.push('text');
    }
  }
  if (Object.keys(partial).length) {
    if (storableNode({...node, ...partial} as SceneNode)) {
      userUpdate(tx, id, partial);
      fields.push(...named);
    } else notes.push(`the file cannot store these values (${named.join(', ')}); they were not changed.`);
  }

  // 3. Its box: children follow their constraints, a text's resize mode follows (as typing W and H in the panel).
  if (update.x !== undefined || update.y !== undefined || update.width !== undefined || update.height !== undefined) {
    node = tx.get(id)!;
    const parent = node.parentId ? tx.get(node.parentId) : undefined;
    const inFlow = !!parent?.autoLayout && parent.autoLayout.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE';
    if (inFlow && (update.x !== undefined || update.y !== undefined)) notes.push(`x/y have no effect: the auto layout of its parent places it.`);
    const box = {x: update.x ?? node.x, y: update.y ?? node.y, width: update.width ?? node.width, height: node.type === 'LINE' ? 0 : (update.height ?? node.height)};
    for (const [target, change] of resizeUpdates(tx.doc, id, box)) {
      if (target === id) userUpdate(tx, target, change);
      else tx.update(target, change);
    }
    for (const key of ['x', 'y', 'width', 'height'] as const) if (update[key] !== undefined) fields.push(key);
  }

  // 4. Its sizing in a layout (after the box: a size typed by hand makes a side fixed, the sizing asked for wins).
  if (update.sizing) {
    for (const axis of ['horizontal', 'vertical'] as const) {
      const value = update.sizing[axis];
      const current = tx.get(id)!;
      const parent = current.parentId ? tx.get(current.parentId) : undefined;
      if (effectiveSizing(current, parent, axis) === value) continue;
      if ((value === 'HUG' && !canHug(current)) || (value === 'FILL' && !canFill(current, parent, axis))) {
        notes.push(value === 'HUG' ? `cannot HUG ${axis}ly: only a frame with auto layout or a text can.` : `cannot FILL ${axis}ly: its parent has no auto layout.`);
        continue;
      }
      for (const [target, change] of layoutSizingUpdates(tx.doc, id, axis, value)) {
        if (target === id) userUpdate(tx, target, change);
        else tx.update(target, change);
      }
      if (!fields.includes('sizing')) fields.push('sizing');
    }
  }
  return fields;
}

// ── delete_layers, duplicate_layers ─────────────────────────────────────────────────────────────

/** The layers the aliases name that structure edits may touch; the rest go to `problems`. */
function structural(ctx: CanvasToolContext, list: readonly string[], problems: string[], verb: string): NodeId[] {
  const {doc} = ctx.store.getState();
  const ids: NodeId[] = [];
  for (const alias of list) {
    const id = ctx.aliases.resolve(alias);
    const node = id ? doc.nodes[id] : undefined;
    if (!id || !node) problems.push(`${alias}: no such layer (already deleted, or an unknown id).`);
    else if (node.type === 'PAGE') problems.push(`${alias}: a page cannot be ${verb}.`);
    else if (isInsideInstance(doc, id)) problems.push(`${alias}: it is inside an instance and cannot be ${verb}${verb === 'deleted' ? ' (hide it with visible:false instead)' : ''}.`);
    else if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function deleteLayers(call: Call<'delete_layers'>, ctx: CanvasToolContext): CanvasToolOutcome {
  const problems: string[] = [];
  const ids = structural(ctx, call.input.ids, problems, 'deleted');
  const {doc} = ctx.store.getState();
  const top = topLevelSelection(doc, ids);
  if (!top.length) return failed(call, `Nothing deleted. ${problems.join(' ')}`);
  const named = top.map(id => ctx.aliases.alias(id));
  const step = transact(ctx.store, 'Delete', tx => removeNodes(tx, top));
  if (step.refused) return failed(call, REFUSALS[step.refused]);
  const inner = ids.length - top.length;
  const text = [`Deleted ${top.length} ${top.length === 1 ? 'layer' : 'layers'} with everything inside: ${named.join(', ')}.${inner ? ` (${inner} of the ids were inside them.)` : ''}`];
  if (problems.length) text.push(`Problems: ${problems.join(' ')}`);
  return outcome(call, true, text.join('\n'), {touched: top});
}

function duplicateLayers(call: Call<'duplicate_layers'>, ctx: CanvasToolContext): CanvasToolOutcome {
  const problems: string[] = [];
  const {doc} = ctx.store.getState();
  const ids = sortByPaintOrder(doc, topLevelSelection(doc, structural(ctx, call.input.ids, problems, 'duplicated')));
  if (!ids.length) return failed(call, `Nothing duplicated. ${problems.join(' ')}`);
  // Frames standing on the canvas: their copies go to their right, past what stands there (as ⌘D); the rest right after the original.
  const onCanvas = ids.filter(id => besideOffset(doc, [id]) !== null);
  const offset = onCanvas.length ? besideOffset(doc, onCanvas) : null;
  const {nodes, ids: map} = mainsAsInstances(doc, doc.nodes, ids, cloneSubtrees(doc.nodes, ids));
  const original = new Map([...map].map(([old, fresh]) => [fresh, old]));
  const copies = ids.map(id => map.get(id)!);
  const step = transact(ctx.store, 'Duplicate', tx => {
    insertClones(tx, nodes, root => {
      const source = original.get(root.id)!;
      const parentId = doc.nodes[source]!.parentId!;
      return {parentId, index: (tx.get(parentId)!.children ?? []).indexOf(source) + 1};
    });
    if (offset && (offset.x || offset.y)) {
      for (const id of onCanvas) {
        const copy = map.get(id)!;
        const node = tx.get(copy);
        if (!node) continue;
        const local = applyLinear(invert(worldMatrix(doc, doc.nodes[id]!.parentId!)), offset);
        tx.update(copy, {x: node.x + local.x, y: node.y + local.y});
      }
    }
    return {select: copies};
  });
  if (step.refused) return failed(call, REFUSALS[step.refused]);
  const after = ctx.store.getState().doc;
  const made = new Set(nodes.map(node => node.id));
  const lines = ids.map(id => {
    const copy = map.get(id)!;
    const node = after.nodes[copy];
    return `${ctx.aliases.alias(id)}→${ctx.aliases.alias(copy)}${node ? ` at x=${round(node.x)} y=${round(node.y)}` : ''}`;
  });
  // Layers inside the originals the caller already knows get their copies' aliases too (the copy of "L7 Title" is L52).
  const inner: string[] = [];
  for (const [old, fresh] of map) {
    if (inner.length >= 80 || ids.includes(old) || !made.has(fresh)) continue;
    const known = ctx.aliases.known(old);
    if (known) inner.push(`${known}→${ctx.aliases.alias(fresh)}`);
  }
  const text = [`Duplicated ${ids.length} ${ids.length === 1 ? 'layer' : 'layers'} (original→copy): ${lines.join(', ')}.`];
  if (inner.length) text.push(`Copies of layers inside them: ${inner.join(', ')}.`);
  if (problems.length) text.push(`Problems: ${problems.join(' ')}`);
  return outcome(call, true, text.join('\n'), {created: copies, touched: copies});
}

// ── add_color_styles ────────────────────────────────────────────────────────────────────────────

function addColorStyles(call: Call<'add_color_styles'>, ctx: CanvasToolContext): CanvasToolOutcome {
  const seen: {reason: RefusalReason | null} = {reason: null};
  const off = ctx.store.onRefused((_label, reason) => {
    seen.reason = reason;
  });
  let added: ReturnType<typeof applyPalette>;
  try {
    added = applyPalette(ctx.store, call.input.colors, call.input.group, 'Palette');
  } finally {
    off();
  }
  if (seen.reason) return failed(call, REFUSALS[seen.reason]);
  if (!added.ids.length) return failed(call, `No colour style could be stored${added.refused ? ' (the file refused their values)' : ''}.`);
  const group = call.input.group.trim().replace(/\/+$/, '');
  const text = `Added ${added.ids.length} colour ${added.ids.length === 1 ? 'style' : 'styles'} in ${quote(group || 'the root')}: ${call.input.colors.map(color => `${color.name} ${color.color}`).join(', ')}.${added.refused ? ` ${added.refused} could not be stored.` : ''}`;
  return outcome(call, true, text);
}
