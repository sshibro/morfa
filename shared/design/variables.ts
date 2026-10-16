import type {AutoLayout, DesignDocument, NodeId, Paint, RGBA, SceneNode, TextProps, TextStyle, Variable, VariableAlias, VariableCollection, VariableId, VariableType, VariableValue} from './types';
import {copyTable, tableCache, type TableLog} from './table-cache';
import {engineTs, withEngine} from './engine-switch';
import {applyVariablesWasm, sameVariableWrites} from './instances-wasm';

/** A node table and how it differs from one whose indexes may be cached (see shared/design/normalize.ts). */
type TableOrigin = {nodes: Readonly<Record<NodeId, SceneNode>>; changed: Iterable<NodeId>};

// Variables (docs/design-tool.md §The document): collections with modes, typed variables (COLOR, FLOAT,
// STRING, BOOLEAN) whose value per mode is concrete or an alias of another variable of the same type.
// Nodes keep concrete values: a binding (`boundVariables` on the node, `boundVariables.color` on a solid
// paint) says where a value came from, and `applyVariables` rewrites bound fields whenever a variable,
// a mode choice or a node's place changes. Renderers and exporters never resolve variables.
//
// Which mode a node uses for a collection: the nearest ancestor (itself included) that picked one in
// `doc.variableModes`; an instance and its copies also inherit a mode picked on their main component's
// node; otherwise the collection's default mode.

export type ResolvedValue = RGBA | number | string | boolean;

/** The new document and the ids (nodes, variables, collections) whose entries changed. */
export type VariableEdit = {doc: DesignDocument; changed: ReadonlySet<string>};

export type VariableErrorCode = 'not_found' | 'wrong_type' | 'alias_cycle' | 'duplicate_name' | 'invalid_name' | 'last_mode' | 'unknown_mode' | 'not_bindable';

export const VARIABLE_ERROR_MESSAGES: Record<VariableErrorCode, string> = {
  not_found: 'Variable not found',
  wrong_type: 'The value type does not fit',
  alias_cycle: 'A variable cannot refer to itself',
  duplicate_name: 'A variable with this name already exists',
  invalid_name: 'Invalid name',
  last_mode: 'A collection must keep at least one mode',
  unknown_mode: 'There is no such mode',
  not_bindable: 'This field cannot be bound to a variable',
};

export class DesignVariableError extends Error {
  constructor(readonly code: VariableErrorCode, message: string = VARIABLE_ERROR_MESSAGES[code]) {
    super(message);
    this.name = 'DesignVariableError';
  }
}

function fail(code: VariableErrorCode): never {
  throw new DesignVariableError(code);
}

export const isAlias = (value: unknown): value is VariableAlias =>
  typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS' && typeof (value as VariableAlias).id === 'string';

const isColor = (value: unknown): value is RGBA =>
  typeof value === 'object' && value !== null && ['r', 'g', 'b', 'a'].every(key => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, number>)[key]));

function matchesType(type: VariableType, value: unknown): boolean {
  switch (type) {
    case 'COLOR': return isColor(value);
    case 'FLOAT': return typeof value === 'number' && Number.isFinite(value);
    case 'STRING': return typeof value === 'string';
    case 'BOOLEAN': return typeof value === 'boolean';
  }
}

const DEFAULT_VALUES: Record<VariableType, ResolvedValue> = {COLOR: {r: 0, g: 0, b: 0, a: 1}, FLOAT: 0, STRING: '', BOOLEAN: false};

// ── Resolution ─────────────────────────────────────────────────────────────────────────────────

/** The node whose explicit mode an instance or a copy inherits: a copy's mirror, an instance's component. */
function counterpart(doc: DesignDocument, node: SceneNode): SceneNode | undefined {
  if (node.mainId !== undefined) return doc.nodes[node.mainId];
  if (node.type === 'INSTANCE' && node.componentId) return doc.nodes[node.componentId];
  return undefined;
}

/** The mode `nodeId` uses for `collectionId`; undefined when the collection does not exist. */
export function modeForNode(doc: DesignDocument, nodeId: NodeId, collectionId: string): string | undefined {
  const collection = doc.variableCollections[collectionId];
  if (!collection) return undefined;
  const modes = doc.variableModes;
  if (modes) {
    const valid = (modeId: string | undefined): modeId is string => !!modeId && collection.modes.some(mode => mode.modeId === modeId);
    for (let node = doc.nodes[nodeId], guard = 0; node && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
      const own = modes[node.id]?.[collectionId];
      if (valid(own)) return own;
      let main = counterpart(doc, node);
      for (let depth = 0; main && depth < 64; depth++) {
        const inherited = modes[main.id]?.[collectionId];
        if (valid(inherited)) return inherited;
        main = counterpart(doc, main);
      }
    }
  }
  return collection.defaultModeId;
}

/** A variable's concrete value. `modeId` picks the mode of the variable's own collection (falling back to
 *  the default mode when the variable has no value there); aliases into other collections resolve in the
 *  mode `nodeId` uses for them, else their default. Undefined for a missing variable or an alias cycle. */
export function resolveVariable(doc: DesignDocument, id: VariableId, modeId?: string, nodeId?: NodeId): ResolvedValue | undefined {
  const seen = new Set<VariableId>();
  let variable: Variable | undefined = doc.variables[id];
  let mode = modeId;
  while (variable) {
    if (seen.has(variable.id)) return undefined;
    seen.add(variable.id);
    const collection: VariableCollection | undefined = doc.variableCollections[variable.collectionId];
    const chosen: string | undefined = mode !== undefined && variable.valuesByMode[mode] !== undefined ? mode
      : nodeId !== undefined ? modeForNode(doc, nodeId, variable.collectionId)
        : collection?.defaultModeId;
    const value: VariableValue | undefined = (chosen !== undefined ? variable.valuesByMode[chosen] : undefined)
      ?? (collection ? variable.valuesByMode[collection.defaultModeId] : undefined)
      ?? Object.values(variable.valuesByMode)[0];
    if (value === undefined) return undefined;
    if (!isAlias(value)) return matchesType(variable.type, value) ? value : undefined;
    const next: Variable | undefined = doc.variables[value.id];
    mode = next && next.collectionId === variable.collectionId ? chosen : undefined;
    variable = next;
  }
  return undefined;
}

/** Whether pointing `variableId` at `targetId` (in any mode) would make an alias loop. */
export function wouldCreateAliasCycle(doc: DesignDocument, variableId: VariableId, targetId: VariableId): boolean {
  const seen = new Set<VariableId>();
  const stack = [targetId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === variableId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const value of Object.values(doc.variables[id]?.valuesByMode ?? {})) if (isAlias(value)) stack.push(value.id);
  }
  return false;
}

/** The loop a variable's aliases run into (ids in order), or null. Imported files can contain one. */
export function aliasCycle(doc: DesignDocument, variableId: VariableId): VariableId[] | null {
  const path: VariableId[] = [];
  const onPath = new Set<VariableId>();
  const done = new Set<VariableId>();
  const visit = (id: VariableId): VariableId[] | null => {
    if (onPath.has(id)) return path.slice(path.indexOf(id));
    if (done.has(id)) return null;
    onPath.add(id);
    path.push(id);
    for (const value of Object.values(doc.variables[id]?.valuesByMode ?? {})) {
      if (!isAlias(value)) continue;
      const found = visit(value.id);
      if (found) return found;
    }
    path.pop();
    onPath.delete(id);
    done.add(id);
    return null;
  };
  return visit(variableId);
}

// ── Bindable fields ────────────────────────────────────────────────────────────────────────────

type FieldSpec = {type: VariableType; write(node: SceneNode, value: ResolvedValue): Partial<SceneNode> | null};

const finite = (value: ResolvedValue) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const numberField = (key: 'width' | 'height' | 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight' | 'strokeWeight' | 'cornerRadius', min = -Infinity): FieldSpec => ({
  type: 'FLOAT',
  write(node, value) {
    const number = finite(value);
    if (number === null) return null;
    const next = Math.max(min, number);
    const partial: Partial<SceneNode> = {};
    if (node[key] !== next) (partial as Record<string, number>)[key] = next;
    // One radius for every corner: individual radii follow, as Figma applies it.
    if (key === 'cornerRadius' && node.rectangleCornerRadii && node.rectangleCornerRadii.some(radius => radius !== next)) partial.rectangleCornerRadii = [next, next, next, next];
    return Object.keys(partial).length ? partial : null;
  },
});

const autoLayoutField = (key: 'itemSpacing' | 'counterAxisSpacing' | 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom'): FieldSpec => ({
  type: 'FLOAT',
  write(node, value) {
    const number = finite(value);
    if (number === null || !node.autoLayout || node.autoLayout[key] === number) return null;
    return {autoLayout: {...node.autoLayout, [key]: number} as AutoLayout};
  },
});

/** Figma's `gridRowGap` / `gridColumnGap` bindings: the gaps of a grid auto-layout frame (`node.grid`). */
const gridField = (key: 'rowGap' | 'columnGap'): FieldSpec => ({
  type: 'FLOAT',
  write(node, value) {
    const number = finite(value);
    if (number === null || !node.grid || node.grid[key] === number) return null;
    return {grid: {...node.grid, [key]: number}};
  },
});

const cornerField = (index: 0 | 1 | 2 | 3): FieldSpec => ({
  type: 'FLOAT',
  write(node, value) {
    const number = finite(value);
    if (number === null || node.cornerRadius === undefined) return null;
    const radii: [number, number, number, number] = node.rectangleCornerRadii ? [...node.rectangleCornerRadii] : [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
    if (radii[index] === Math.max(0, number) && node.rectangleCornerRadii) return null;
    radii[index] = Math.max(0, number);
    return {rectangleCornerRadii: radii};
  },
});

const strokeSideField = (side: 'top' | 'right' | 'bottom' | 'left'): FieldSpec => ({
  type: 'FLOAT',
  write(node, value) {
    const number = finite(value);
    if (number === null) return null;
    const weights = node.individualStrokeWeights ?? {top: node.strokeWeight, right: node.strokeWeight, bottom: node.strokeWeight, left: node.strokeWeight};
    if (node.individualStrokeWeights && weights[side] === number) return null;
    return {individualStrokeWeights: {...weights, [side]: Math.max(0, number)}};
  },
});

const textStyleField = (type: VariableType, make: (value: ResolvedValue, style: TextStyle) => Partial<TextStyle> | null): FieldSpec => ({
  type,
  write(node, value) {
    if (!node.text) return null;
    const partial = make(value, node.text.style);
    if (!partial || Object.entries(partial).every(([key, next]) => JSON.stringify((node.text!.style as Record<string, unknown>)[key]) === JSON.stringify(next))) return null;
    return {text: {...node.text, style: {...node.text.style, ...partial}}};
  },
});

const textField = (key: 'paragraphSpacing' | 'paragraphIndent'): FieldSpec => ({
  type: 'FLOAT',
  write(node, value) {
    const number = finite(value);
    if (number === null || !node.text || node.text.paragraphSpacing === undefined || node.text[key] === number) return null;
    return {text: {...node.text, [key]: number}};
  },
});

function clipRuns(text: TextProps, characters: string): TextProps {
  const length = characters.length;
  const runs = (text.runs ?? []).filter(run => run.start < length).map(run => (run.end > length ? {...run, end: length} : run));
  return {...text, characters, runs};
}

/** Node fields a variable can drive (Figma's bindable fields), by the variable type each takes. Opacity
 *  takes a percentage (0–100), as Figma's number variables for opacity do. Paint colours bind on the
 *  paint itself (`bindPaintVariable`). */
const FIELD_SPECS: Record<string, FieldSpec> = {
  width: numberField('width', 0),
  height: numberField('height', 0),
  minWidth: numberField('minWidth', 0),
  maxWidth: numberField('maxWidth', 0),
  minHeight: numberField('minHeight', 0),
  maxHeight: numberField('maxHeight', 0),
  itemSpacing: autoLayoutField('itemSpacing'),
  counterAxisSpacing: autoLayoutField('counterAxisSpacing'),
  paddingLeft: autoLayoutField('paddingLeft'),
  paddingRight: autoLayoutField('paddingRight'),
  paddingTop: autoLayoutField('paddingTop'),
  paddingBottom: autoLayoutField('paddingBottom'),
  gridRowGap: gridField('rowGap'),
  gridColumnGap: gridField('columnGap'),
  cornerRadius: numberField('cornerRadius', 0),
  topLeftRadius: cornerField(0),
  topRightRadius: cornerField(1),
  bottomRightRadius: cornerField(2),
  bottomLeftRadius: cornerField(3),
  strokeWeight: numberField('strokeWeight', 0),
  strokeTopWeight: strokeSideField('top'),
  strokeRightWeight: strokeSideField('right'),
  strokeBottomWeight: strokeSideField('bottom'),
  strokeLeftWeight: strokeSideField('left'),
  opacity: {
    type: 'FLOAT',
    write(node, value) {
      const number = finite(value);
      if (number === null) return null;
      const opacity = Math.min(1, Math.max(0, number / 100));
      return node.opacity === opacity ? null : {opacity};
    },
  },
  visible: {type: 'BOOLEAN', write: (node, value) => (typeof value === 'boolean' && node.visible !== value ? {visible: value} : null)},
  characters: {type: 'STRING', write: (node, value) => (typeof value === 'string' && node.text && node.text.characters !== value ? {text: clipRuns(node.text, value)} : null)},
  fontFamily: textStyleField('STRING', value => (typeof value === 'string' && value ? {fontFamily: value} : null)),
  fontSize: textStyleField('FLOAT', value => (finite(value) !== null && (value as number) > 0 ? {fontSize: value as number} : null)),
  fontWeight: textStyleField('FLOAT', value => (finite(value) !== null ? {fontWeight: Math.min(900, Math.max(100, value as number))} : null)),
  letterSpacing: textStyleField('FLOAT', value => (finite(value) !== null ? {letterSpacing: {unit: 'PIXELS', value: value as number}} : null)),
  lineHeight: textStyleField('FLOAT', value => (finite(value) !== null ? {lineHeight: {unit: 'PIXELS', value: value as number}} : null)),
  paragraphSpacing: textField('paragraphSpacing'),
  paragraphIndent: textField('paragraphIndent'),
};

/** Field name → the variable type it takes. */
export const BINDABLE_FIELDS: Readonly<Record<string, VariableType>> = Object.fromEntries(Object.entries(FIELD_SPECS).map(([field, spec]) => [field, spec.type]));

// ── Reverse index ──────────────────────────────────────────────────────────────────────────────

export type VariableUsage = {
  /** Variable → nodes binding it directly (node fields, paints, text run paints). */
  byVariable: Map<VariableId, Set<NodeId>>;
  /** Every node with at least one binding. */
  bound: Set<NodeId>;
};

function paintAliases(paints: readonly Paint[] | undefined, out: (id: VariableId) => void): void {
  if (!paints) return;
  for (const paint of paints) if (paint.type === 'SOLID' && paint.boundVariables?.color) out(paint.boundVariables.color.id);
}

function aliasesOf(node: SceneNode, out: (id: VariableId) => void): void {
  if (node.boundVariables) for (const alias of Object.values(node.boundVariables)) if (alias) out(alias.id);
  paintAliases(node.fills, out);
  paintAliases(node.strokes, out);
  if (node.text?.runs) for (const run of node.text.runs) paintAliases(run.fills, out);
}

/** Whether two versions of an entry bind the same variables. Fields an edit leaves alone keep their
 *  objects (immutable updates), so moving or resizing a layer is decided by identity alone. */
function sameBindings(a: SceneNode | undefined, b: SceneNode | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) {
    let any = false;
    aliasesOf((a ?? b)!, () => (any = true));
    return !any;
  }
  if (a.boundVariables === b.boundVariables && a.fills === b.fills && a.strokes === b.strokes && a.text?.runs === b.text?.runs) return true;
  const left: VariableId[] = [], right: VariableId[] = [];
  aliasesOf(a, id => left.push(id));
  aliasesOf(b, id => right.push(id));
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/** A table whose changed entries bind what they bound before has the same usage: an edit that does
 *  not touch a binding never rescans the file. Anything else rebuilds it (in table order). */
const usageCache = tableCache<VariableUsage>((previous, before, after, changed) => {
  for (const id of changed) if (!sameBindings(before[id], after[id])) return undefined;
  return previous;
});

/** Which nodes bind which variables, built once per node map. With `origin`, `doc.nodes` is a table
 *  still being written (normalization's, frame after frame of a drag): the usage of the origin's
 *  table, which stays as it is, is built and kept instead, and used whenever the changed ids leave
 *  it valid. */
export function variableUsage(doc: DesignDocument, origin?: TableOrigin): VariableUsage {
  const usage = usageCache.get(doc.nodes);
  if (usage) return usage;
  if (origin) {
    const previous = buildUsage(origin.nodes);
    let same = true;
    for (const id of origin.changed) if (!sameBindings(origin.nodes[id], doc.nodes[id])) { same = false; break; }
    if (same) return previous;
  }
  return buildUsage(doc.nodes);
}

function buildUsage(nodes: Readonly<Record<NodeId, SceneNode>>): VariableUsage {
  let usage = usageCache.get(nodes);
  if (usage) return usage;
  const byVariable = new Map<VariableId, Set<NodeId>>();
  const bound = new Set<NodeId>();
  for (const id in nodes) {
    aliasesOf(nodes[id], variableId => {
      bound.add(id);
      let set = byVariable.get(variableId);
      if (!set) byVariable.set(variableId, set = new Set());
      set.add(id);
    });
  }
  usage = {byVariable, bound};
  usageCache.set(nodes, usage);
  return usage;
}

const dependentsCache = new WeakMap<object, Map<VariableId, Set<VariableId>>>();

/** Variable → the variables that alias it (in any mode), built once per variables table. */
export function aliasDependents(doc: DesignDocument): Map<VariableId, Set<VariableId>> {
  let map = dependentsCache.get(doc.variables);
  if (map) return map;
  map = new Map();
  for (const variable of Object.values(doc.variables)) {
    for (const value of Object.values(variable.valuesByMode)) {
      if (!isAlias(value)) continue;
      let set = map.get(value.id);
      if (!set) map.set(value.id, set = new Set());
      set.add(variable.id);
    }
  }
  dependentsCache.set(doc.variables, map);
  return map;
}

// ── Applying ───────────────────────────────────────────────────────────────────────────────────

function resolvePaints(doc: DesignDocument, nodeId: NodeId, paints: Paint[]): Paint[] {
  let next: Paint[] | null = null;
  paints.forEach((paint, i) => {
    if (paint.type !== 'SOLID' || !paint.boundVariables?.color) return;
    const variable = doc.variables[paint.boundVariables.color.id];
    if (variable?.type !== 'COLOR') return;
    const value = resolveVariable(doc, variable.id, undefined, nodeId);
    if (!isColor(value)) return;
    if (paint.color.r === value.r && paint.color.g === value.g && paint.color.b === value.b && paint.opacity === value.a) return;
    next ??= [...paints];
    next[i] = {...paint, color: {r: value.r, g: value.g, b: value.b}, opacity: value.a};
  });
  return next ?? paints;
}

/** The node with every bound field set to its variable's value in the node's modes (itself if unchanged). */
export function resolvedNode(doc: DesignDocument, node: SceneNode): SceneNode {
  let next = node;
  if (node.boundVariables) {
    for (const [field, alias] of Object.entries(node.boundVariables)) {
      const spec = FIELD_SPECS[field];
      const variable = alias ? doc.variables[alias.id] : undefined;
      if (!spec || variable?.type !== spec.type) continue;
      const value = resolveVariable(doc, variable.id, undefined, node.id);
      if (value === undefined) continue;
      const partial = spec.write(next, value);
      if (partial) next = {...next, ...partial};
    }
  }
  const fills = resolvePaints(doc, node.id, next.fills);
  if (fills !== next.fills) next = {...next, fills};
  const strokes = resolvePaints(doc, node.id, next.strokes);
  if (strokes !== next.strokes) next = {...next, strokes};
  if (next.text?.runs.some(run => run.fills)) {
    let changed = false;
    const runs = next.text.runs.map(run => {
      if (!run.fills) return run;
      const runFills = resolvePaints(doc, node.id, run.fills);
      if (runFills === run.fills) return run;
      changed = true;
      return {...run, fills: runFills};
    });
    if (changed) next = {...next, text: {...next.text, runs}};
  }
  return next;
}

const NO_IDS: ReadonlySet<string> = new Set();

function hasEntries(table: object | undefined): boolean {
  for (const _ in table) return true;
  return false;
}

/** The bound nodes that are in `dirty` or below a dirty node. Walks down from the dirty nodes while
 *  that stays cheaper than walking up from every bound node (a dragged layer has no subtree to speak
 *  of; a pasted page might), then up with each ancestor's answer remembered. */
function boundUnderDirty(doc: DesignDocument, dirty: ReadonlySet<string>, bound: ReadonlySet<NodeId>): NodeId[] {
  const found: NodeId[] = [];
  const budget = 2 * bound.size + 64;
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [];
  for (const id of dirty) stack.push(id);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > budget) {
      found.length = 0;
      const below = new Map<NodeId, boolean>();
      for (const boundId of bound) {
        const path: NodeId[] = [];
        let hit = false;
        for (let node = doc.nodes[boundId], guard = 0; node && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
          if (dirty.has(node.id)) { hit = true; break; }
          const known = below.get(node.id);
          if (known !== undefined) { hit = known; break; }
          path.push(node.id);
        }
        for (const each of path) below.set(each, hit);
        if (hit) found.push(boundId);
      }
      return found;
    }
    const node = doc.nodes[id];
    if (!node) continue;
    if (bound.has(id)) found.push(id);
    if (node.children) for (const child of node.children) stack.push(child);
  }
  return found;
}

/** Like `applyVariables`, also returning the ids of the nodes it rewrote. `owned`: `doc.nodes` is
 *  the caller's private working table (normalization's), written in place instead of copied.
 *  `origin`: how that table differs from one whose usage index may be cached. A file without
 *  variables costs nothing; otherwise the work is what `dirty` reaches. */
export function applyVariablesDetailed(doc: DesignDocument, dirty: ReadonlySet<string>, options: {owned?: boolean; origin?: TableOrigin; log?: TableLog} = {}): VariableEdit {
  // The engine switch (lane L2c, shared/design/instances-wasm.ts); normalize's own calls (`owned`, `origin`) stay TypeScript.
  // Its own early exits first, in every mode: a file without variables costs nothing.
  if (!dirty.size || !hasEntries(doc.variables)) return {doc, changed: NO_IDS};
  // normalize.ts always passes `{owned, origin}`: its calls stay TypeScript (normalize flips as a whole).
  if (options.owned !== undefined || options.origin !== undefined || engineTs('normalize')) return applyVariablesTs(doc, dirty, options);
  return withEngine('normalize', 'applyVariablesDetailed', () => applyVariablesTs(doc, dirty, options), () => applyVariablesWasm(doc, dirty), {equal: sameVariableWrites, inputs: () => [...dirty]});
}

function applyVariablesTs(doc: DesignDocument, dirty: ReadonlySet<string>, options: {owned?: boolean; origin?: TableOrigin; log?: TableLog}): VariableEdit {
  const unchanged: VariableEdit = {doc, changed: NO_IDS};
  // Without variables no binding resolves: nothing can change (resolvedNode skips missing ones).
  if (!dirty.size || !hasEntries(doc.variables)) return unchanged;
  const usage = variableUsage(doc, options.origin);
  if (!usage.bound.size) return unchanged;
  const targets = new Set<NodeId>();

  const seeds: VariableId[] = [];
  for (const id of dirty) {
    if (doc.variables[id]) seeds.push(id);
    else if (doc.variableCollections[id]) seeds.push(...doc.variableCollections[id].variableIds);
  }
  if (seeds.length) {
    const dependents = aliasDependents(doc);
    const seen = new Set<VariableId>();
    while (seeds.length) {
      const id = seeds.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const nodeId of usage.byVariable.get(id) ?? []) targets.add(nodeId);
      for (const dependent of dependents.get(id) ?? []) seeds.push(dependent);
    }
  }
  // A dirty node (moved, created, given a mode) re-resolves with its bound descendants.
  for (const id of boundUnderDirty(doc, dirty, usage.bound)) targets.add(id);

  // Every node resolves against the document as it was (as when results went to a copy), then the
  // results are written.
  const results: SceneNode[] = [];
  for (const id of targets) {
    const node = doc.nodes[id];
    if (!node) continue;
    const next = resolvedNode(doc, node);
    if (next !== node) results.push(next);
  }
  if (!results.length) return unchanged;
  const nodes = options.owned ? doc.nodes : copyTable(doc.nodes);
  const log = options.owned ? options.log : undefined;
  const changed = new Set<NodeId>();
  for (const next of results) {
    log?.touch(next.id);
    nodes[next.id] = next;
    changed.add(next.id);
  }
  return {doc: options.owned ? doc : {...doc, nodes}, changed};
}

/** Writes resolved values into the bound fields of nodes in `dirty` (and their bound descendants) and of
 *  nodes bound to variables or collections in `dirty` (through aliases too). Normalize calls it right after
 *  `syncInstances` with the transaction's dirty ids plus the copies the sync rewrote. Returns `doc` itself
 *  when nothing changed. */
export function applyVariables(doc: DesignDocument, dirty: ReadonlySet<NodeId>): DesignDocument {
  return applyVariablesDetailed(doc, dirty).doc;
}

/** Re-resolves every bound node (after an import or a schema migration). */
export function applyAllVariables(doc: DesignDocument): DesignDocument {
  return applyVariablesDetailed(doc, new Set(doc.pages)).doc;
}

// ── Editing collections, modes and variables ───────────────────────────────────────────────────

function checkName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /[.{}$]/.test(trimmed)) fail('invalid_name');
  return trimmed;
}

const withTables = (doc: DesignDocument, collections: Record<string, VariableCollection> | null, variables: Record<VariableId, Variable> | null): DesignDocument => ({
  ...doc,
  ...(collections ? {variableCollections: collections} : {}),
  ...(variables ? {variables} : {}),
});

const edit = (doc: DesignDocument, changed: Iterable<string>): VariableEdit => ({doc, changed: new Set(changed)});

/** Applies variables after a change to `ids`, merging the rewritten nodes into the result. */
function settle(doc: DesignDocument, ids: Iterable<string>): VariableEdit {
  const dirty = new Set(ids);
  const applied = applyVariablesDetailed(doc, dirty);
  return {doc: applied.doc, changed: new Set([...dirty, ...applied.changed])};
}

export type NewCollection = {id: string; name: string; modes?: {modeId: string; name: string}[]};

/** A collection with its modes (default: one "Mode 1" with id `${id}:1`); the first mode is the default. */
export function createVariableCollection(doc: DesignDocument, collection: NewCollection): VariableEdit {
  const name = checkName(collection.name);
  const modes = collection.modes?.length ? collection.modes.map(mode => ({modeId: mode.modeId, name: checkName(mode.name)})) : [{modeId: `${collection.id}:1`, name: 'Mode 1'}];
  return edit(withTables(doc, {...doc.variableCollections, [collection.id]: {id: collection.id, name, modes, defaultModeId: modes[0].modeId, variableIds: []}}, null), [collection.id]);
}

export function renameVariableCollection(doc: DesignDocument, collectionId: string, name: string): VariableEdit {
  const collection = doc.variableCollections[collectionId] ?? fail('not_found');
  return edit(withTables(doc, {...doc.variableCollections, [collectionId]: {...collection, name: checkName(name)}}, null), [collectionId]);
}

/** Removes a collection and its variables; bound nodes keep their values and lose the binding. */
export function deleteVariableCollection(doc: DesignDocument, collectionId: string): VariableEdit {
  const collection = doc.variableCollections[collectionId] ?? fail('not_found');
  let current = doc;
  const changed = new Set<string>([collectionId]);
  for (const id of collection.variableIds) {
    if (!current.variables[id]) continue;
    const result = deleteVariable(current, id);
    current = result.doc;
    for (const item of result.changed) changed.add(item);
  }
  const collections = {...current.variableCollections};
  delete collections[collectionId];
  current = withTables(current, collections, null);
  if (current.variableModes && Object.values(current.variableModes).some(modes => collectionId in modes)) {
    const variableModes: Record<NodeId, Record<string, string>> = {};
    for (const [nodeId, modes] of Object.entries(current.variableModes)) {
      const rest = {...modes};
      delete rest[collectionId];
      if (Object.keys(rest).length) variableModes[nodeId] = rest;
      else changed.add(nodeId);
    }
    current = {...current, variableModes};
  }
  return edit(current, changed);
}

/** A new mode; every variable of the collection starts with its value in `copyFrom` (default mode). */
export function addVariableMode(doc: DesignDocument, collectionId: string, mode: {modeId: string; name: string}, copyFrom?: string): VariableEdit {
  const collection = doc.variableCollections[collectionId] ?? fail('not_found');
  if (collection.modes.some(existing => existing.modeId === mode.modeId)) fail('duplicate_name');
  const source = copyFrom ?? collection.defaultModeId;
  const variables = {...doc.variables};
  for (const id of collection.variableIds) {
    const variable = variables[id];
    if (!variable) continue;
    const value = variable.valuesByMode[source] ?? variable.valuesByMode[collection.defaultModeId];
    variables[id] = {...variable, valuesByMode: {...variable.valuesByMode, [mode.modeId]: value}};
  }
  const next = withTables(doc, {...doc.variableCollections, [collectionId]: {...collection, modes: [...collection.modes, {modeId: mode.modeId, name: checkName(mode.name)}]}}, variables);
  return edit(next, [collectionId, ...collection.variableIds]);
}

export function renameVariableMode(doc: DesignDocument, collectionId: string, modeId: string, name: string): VariableEdit {
  const collection = doc.variableCollections[collectionId] ?? fail('not_found');
  if (!collection.modes.some(mode => mode.modeId === modeId)) fail('unknown_mode');
  const modes = collection.modes.map(mode => (mode.modeId === modeId ? {...mode, name: checkName(name)} : mode));
  return edit(withTables(doc, {...doc.variableCollections, [collectionId]: {...collection, modes}}, null), [collectionId]);
}

/** Removes a mode: values in it go, nodes that picked it fall back to the default, aliases from other
 *  collections are untouched. The last mode cannot be removed. */
export function removeVariableMode(doc: DesignDocument, collectionId: string, modeId: string): VariableEdit {
  const collection = doc.variableCollections[collectionId] ?? fail('not_found');
  if (!collection.modes.some(mode => mode.modeId === modeId)) fail('unknown_mode');
  if (collection.modes.length === 1) fail('last_mode');
  const modes = collection.modes.filter(mode => mode.modeId !== modeId);
  const variables = {...doc.variables};
  for (const id of collection.variableIds) {
    const variable = variables[id];
    if (!variable || !(modeId in variable.valuesByMode)) continue;
    const valuesByMode = {...variable.valuesByMode};
    delete valuesByMode[modeId];
    variables[id] = {...variable, valuesByMode};
  }
  let next = withTables(doc, {...doc.variableCollections, [collectionId]: {...collection, modes, defaultModeId: collection.defaultModeId === modeId ? modes[0].modeId : collection.defaultModeId}}, variables);
  const nodes: NodeId[] = [];
  if (next.variableModes) {
    const variableModes: Record<NodeId, Record<string, string>> = {};
    for (const [nodeId, picked] of Object.entries(next.variableModes)) {
      if (picked[collectionId] !== modeId) { variableModes[nodeId] = picked; continue; }
      nodes.push(nodeId);
      const rest = {...picked};
      delete rest[collectionId];
      if (Object.keys(rest).length) variableModes[nodeId] = rest;
    }
    next = {...next, variableModes};
  }
  return settle(next, [collectionId, ...nodes]);
}

export function setDefaultVariableMode(doc: DesignDocument, collectionId: string, modeId: string): VariableEdit {
  const collection = doc.variableCollections[collectionId] ?? fail('not_found');
  if (!collection.modes.some(mode => mode.modeId === modeId)) fail('unknown_mode');
  return settle(withTables(doc, {...doc.variableCollections, [collectionId]: {...collection, defaultModeId: modeId}}, null), [collectionId]);
}

export type NewVariable = {id: VariableId; name: string; collectionId: string; type: VariableType; value?: VariableValue; description?: string};

/** A variable with `value` (or the type's zero) in every mode. Names are unique in their collection; "/"
 *  groups them, as in Figma. */
export function createVariable(doc: DesignDocument, variable: NewVariable): VariableEdit {
  const collection = doc.variableCollections[variable.collectionId] ?? fail('not_found');
  const name = checkName(variable.name);
  if (collection.variableIds.some(id => doc.variables[id]?.name === name)) fail('duplicate_name');
  const value = variable.value ?? DEFAULT_VALUES[variable.type];
  checkValue(doc, variable.id, variable.type, value);
  const valuesByMode: Record<string, VariableValue> = {};
  for (const mode of collection.modes) valuesByMode[mode.modeId] = isColor(value) ? {...value} : value;
  const created: Variable = {id: variable.id, name, collectionId: collection.id, type: variable.type, valuesByMode, description: variable.description ?? ''};
  return edit(withTables(doc, {...doc.variableCollections, [collection.id]: {...collection, variableIds: [...collection.variableIds, variable.id]}}, {...doc.variables, [variable.id]: created}), [variable.id, collection.id]);
}

export function renameVariable(doc: DesignDocument, variableId: VariableId, name: string): VariableEdit {
  const variable = doc.variables[variableId] ?? fail('not_found');
  const trimmed = checkName(name);
  const collection = doc.variableCollections[variable.collectionId];
  if (collection?.variableIds.some(id => id !== variableId && doc.variables[id]?.name === trimmed)) fail('duplicate_name');
  return edit(withTables(doc, null, {...doc.variables, [variableId]: {...variable, name: trimmed}}), [variableId]);
}

function checkValue(doc: DesignDocument, variableId: VariableId, type: VariableType, value: VariableValue): void {
  if (isAlias(value)) {
    const target = doc.variables[value.id] ?? fail('not_found');
    if (target.type !== type) fail('wrong_type');
    if (wouldCreateAliasCycle(doc, variableId, value.id)) fail('alias_cycle');
    return;
  }
  if (!matchesType(type, value)) fail('wrong_type');
}

/** Sets a variable's value in one mode: a concrete value of its type or an alias of a variable of the
 *  same type (never one that leads back to it). Bound nodes are updated. */
export function setVariableValue(doc: DesignDocument, variableId: VariableId, modeId: string, value: VariableValue): VariableEdit {
  const variable = doc.variables[variableId] ?? fail('not_found');
  const collection = doc.variableCollections[variable.collectionId];
  if (!collection?.modes.some(mode => mode.modeId === modeId)) fail('unknown_mode');
  checkValue(doc, variableId, variable.type, value);
  const stored = isAlias(value) ? {type: 'VARIABLE_ALIAS' as const, id: value.id} : isColor(value) ? {r: value.r, g: value.g, b: value.b, a: value.a} : value;
  const next = withTables(doc, null, {...doc.variables, [variableId]: {...variable, valuesByMode: {...variable.valuesByMode, [modeId]: stored}}});
  return settle(next, [variableId]);
}

/** Removes a variable. Aliases of it become the value it had; bound fields keep their value and lose the binding. */
export function deleteVariable(doc: DesignDocument, variableId: VariableId): VariableEdit {
  const variable = doc.variables[variableId] ?? fail('not_found');
  const changed = new Set<string>([variableId]);
  const variables = {...doc.variables};
  for (const dependentId of aliasDependents(doc).get(variableId) ?? []) {
    const dependent = variables[dependentId];
    if (!dependent) continue;
    const valuesByMode = {...dependent.valuesByMode};
    for (const [modeId, value] of Object.entries(valuesByMode)) {
      if (!isAlias(value) || value.id !== variableId) continue;
      const sameCollection = dependent.collectionId === variable.collectionId;
      valuesByMode[modeId] = resolveVariable(doc, variableId, sameCollection ? modeId : undefined) ?? DEFAULT_VALUES[dependent.type];
    }
    variables[dependentId] = {...dependent, valuesByMode};
    changed.add(dependentId);
  }
  delete variables[variableId];
  const collection = doc.variableCollections[variable.collectionId];
  const collections = collection ? {...doc.variableCollections, [collection.id]: {...collection, variableIds: collection.variableIds.filter(id => id !== variableId)}} : null;
  let nodes: Record<NodeId, SceneNode> | null = null;
  for (const nodeId of variableUsage(doc).byVariable.get(variableId) ?? []) {
    const node = doc.nodes[nodeId];
    if (!node) continue;
    nodes ??= {...doc.nodes};
    nodes[nodeId] = unbound(node, variableId);
    changed.add(nodeId);
  }
  const next = withTables(nodes ? {...doc, nodes} : doc, collections, variables);
  return edit(next, changed);
}

function unbindPaints(paints: Paint[], variableId: VariableId): Paint[] {
  if (!paints.some(paint => paint.type === 'SOLID' && paint.boundVariables?.color?.id === variableId)) return paints;
  return paints.map(paint => {
    if (paint.type !== 'SOLID' || paint.boundVariables?.color?.id !== variableId) return paint;
    const next = {...paint};
    delete next.boundVariables;
    return next;
  });
}

function unbound(node: SceneNode, variableId: VariableId): SceneNode {
  const next: SceneNode = {...node, fills: unbindPaints(node.fills, variableId), strokes: unbindPaints(node.strokes, variableId)};
  if (node.boundVariables) {
    const rest = Object.fromEntries(Object.entries(node.boundVariables).filter(([, alias]) => alias.id !== variableId));
    if (Object.keys(rest).length) next.boundVariables = rest;
    else delete next.boundVariables;
  }
  if (node.text?.runs.some(run => run.fills)) next.text = {...node.text, runs: node.text.runs.map(run => (run.fills ? {...run, fills: unbindPaints(run.fills, variableId)} : run))};
  return next;
}

// ── Binding nodes ──────────────────────────────────────────────────────────────────────────────

/** Binds a node field (see `BINDABLE_FIELDS`) to a variable, writing its value now; null unbinds and the
 *  field keeps its current value. Inside an instance the binding is an override (the editor records it
 *  with `withOverrideTracking`, shared/design/components.ts). */
export function bindVariable(doc: DesignDocument, nodeId: NodeId, field: string, variableId: VariableId | null): VariableEdit {
  const node = doc.nodes[nodeId] ?? fail('not_found');
  const spec = FIELD_SPECS[field] ?? fail('not_bindable');
  const bound = {...(node.boundVariables ?? {})};
  if (variableId === null) {
    delete bound[field];
  } else {
    const variable = doc.variables[variableId] ?? fail('not_found');
    if (variable.type !== spec.type) fail('wrong_type');
    bound[field] = {type: 'VARIABLE_ALIAS', id: variableId};
  }
  const next: SceneNode = {...node};
  if (Object.keys(bound).length) next.boundVariables = bound;
  else delete next.boundVariables;
  return settle({...doc, nodes: {...doc.nodes, [nodeId]: next}}, [nodeId]);
}

/** Binds the colour of the `index`-th solid paint of `fills` or `strokes` (paint opacity takes the alpha). */
export function bindPaintVariable(doc: DesignDocument, nodeId: NodeId, target: 'fills' | 'strokes', index: number, variableId: VariableId | null): VariableEdit {
  const node = doc.nodes[nodeId] ?? fail('not_found');
  const paint = node[target][index];
  if (paint?.type !== 'SOLID') fail('not_bindable');
  if (variableId !== null && doc.variables[variableId]?.type !== 'COLOR') fail(doc.variables[variableId] ? 'wrong_type' : 'not_found');
  const nextPaint = {...paint!};
  if (variableId === null) delete nextPaint.boundVariables;
  else nextPaint.boundVariables = {color: {type: 'VARIABLE_ALIAS', id: variableId}};
  const paints = [...node[target]];
  paints[index] = nextPaint;
  return settle({...doc, nodes: {...doc.nodes, [nodeId]: {...node, [target]: paints}}}, [nodeId]);
}

/** Picks a mode of a collection for a node and everything inside it (null: inherit again). */
export function setNodeVariableMode(doc: DesignDocument, nodeId: NodeId, collectionId: string, modeId: string | null): VariableEdit {
  if (!doc.nodes[nodeId]) fail('not_found');
  const collection = doc.variableCollections[collectionId] ?? fail('not_found');
  if (modeId !== null && !collection.modes.some(mode => mode.modeId === modeId)) fail('unknown_mode');
  const picked = {...(doc.variableModes?.[nodeId] ?? {})};
  if (modeId === null) delete picked[collectionId];
  else picked[collectionId] = modeId;
  const variableModes = {...(doc.variableModes ?? {})};
  if (Object.keys(picked).length) variableModes[nodeId] = picked;
  else delete variableModes[nodeId];
  return settle({...doc, variableModes}, [nodeId]);
}
