import type {ComponentPropertyDefinition, ComponentPropertyReferences, Constraints, DesignDocument, NodeId, SceneNode, TextPathData, TextProps, TextRun, VectorPath} from './types';
import {FRAME_LIKE_TYPES} from './types';
import {createNode, newId as randomId} from './defaults';
import {localMatrix, transformRect, unionRects} from './geometry';
import {constrainedBox, isAutoLayout, resizeUpdates, sameValue, scalePaths, scaleTextPath, textModeAfterResize} from './constraints';
import type {Size} from './constraints';
import {copyTable, forgetTable, tableCache, type TableLog} from './table-cache';
import {engineTs, withEngine} from './engine-switch';
import {draftSnapshot, sameSyncWrites, syncDraftWasm, syncWritesOf} from './instances-wasm';

// Components, instances, overrides and component properties (docs/design-tool.md §The document).
//
// A main component is a COMPONENT node; an instance is an INSTANCE node whose children are real nodes
// mirroring the main's subtree. A copy's id is `${prefix};${mainNodeId}` and its `mainId` names the node
// it mirrors. The prefix is the instance the copy belongs to: the top-level instance for everything
// that follows the main (copies of a nested instance's copies included, so ids stay `${instanceId};${mainId}`
// at every depth), or a nested instance that was swapped to another component, whose copies then mirror
// that component directly. Ids are therefore unique and deterministic, and survive every sync.
//
// A copy holds concrete values (renderers never resolve anything). `overrides` lists the fields the user
// changed on that copy; syncing takes every other field from the node it mirrors. Fields that are
// objects with independent parts are tracked per part, as Figma does: `text.characters`,
// `text.style.fontSize`, `autoLayout.itemSpacing`, `componentProperties.<key>`, `boundVariables.<field>`.
//
// Every operation is pure: it takes a document and returns a new one with the ids it touched.

// ── Results and errors ─────────────────────────────────────────────────────────────────────────

/** What an operation returns: the new document and the ids of the nodes it created, changed or removed.
 *  Hand them to the transaction as dirty ids, or diff the two documents with `diffDocuments` (patch.ts). */
export type DesignEdit = {doc: DesignDocument; changed: ReadonlySet<NodeId>};

/** A fixed id (used for the first node an operation creates; further ones get `-2`, `-3`… suffixes) or a
 *  generator such as `newId` from defaults.ts. */
export type IdSource = NodeId | (() => NodeId);

export type ComponentErrorCode =
  | 'empty' | 'not_found' | 'not_component' | 'not_instance' | 'inside_instance' | 'inside_component' | 'nested_component'
  | 'unsupported' | 'different_parents' | 'not_container' | 'set_child' | 'nested_instance' | 'cycle'
  | 'not_variant' | 'no_variant' | 'duplicate_property' | 'unknown_property' | 'wrong_type' | 'invalid_name' | 'remote_component';

/** Russian texts for the UI's toast; the code is what callers branch on. */
export const COMPONENT_ERROR_MESSAGES: Record<ComponentErrorCode, string> = {
  empty: 'Nothing is selected',
  not_found: 'Layer not found',
  not_component: 'This is not a component',
  not_instance: 'This is not an instance',
  inside_instance: 'Layers inside an instance cannot be changed this way',
  inside_component: 'A component cannot be created inside another component',
  nested_component: 'The selection already contains a component',
  unsupported: 'This layer cannot be made into a component',
  different_parents: 'Layers must have the same parent',
  not_container: 'A layer cannot be nested here',
  set_child: 'Only components can be inside a component set',
  nested_instance: 'Detach the outer instance first',
  cycle: 'A component cannot contain its own instance',
  not_variant: 'The component is not part of the component set',
  no_variant: 'There is no such variant',
  duplicate_property: 'A property with this name already exists',
  unknown_property: 'There is no such property',
  wrong_type: 'The value does not fit the property type',
  invalid_name: 'Invalid name',
  remote_component: 'A library component is changed in the library file',
};

export class DesignComponentError extends Error {
  constructor(readonly code: ComponentErrorCode, message: string = COMPONENT_ERROR_MESSAGES[code]) {
    super(message);
    this.name = 'DesignComponentError';
  }
}

const fail = (code: ComponentErrorCode): never => {
  throw new DesignComponentError(code);
};

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────

type Fields = Record<string, unknown>;
type Nodes = Record<NodeId, SceneNode>;
const fieldsOf = (node: SceneNode | Partial<SceneNode>) => node as unknown as Fields;
const asNode = (fields: Fields) => fields as unknown as SceneNode;

/** `{...node, ...partial}` where an `undefined` in the partial removes the field (so stored JSON stays lean). */
export function assignFields(node: SceneNode, partial: Partial<SceneNode>): SceneNode {
  const next = {...node, ...partial} as Fields;
  for (const key in partial) if ((partial as Fields)[key] === undefined) delete next[key];
  return asNode(next);
}

/** Structural equality for the JSON-like values of a document. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  let definedA = 0, definedB = 0;
  for (const key of ka) {
    const value = (a as Fields)[key];
    if (value === undefined) continue;
    definedA++;
    if (!deepEqual(value, (b as Fields)[key])) return false;
  }
  for (const key of kb) if ((b as Fields)[key] !== undefined) definedB++;
  return definedA === definedB;
}

function idSource(source: IdSource | undefined): () => NodeId {
  if (typeof source === 'function') return source;
  if (source === undefined) return randomId;
  let count = 0;
  return () => (count++ ? `${source}-${count}` : source);
}

const isFrameLikeNode = (node: SceneNode | undefined) => !!node && FRAME_LIKE_TYPES.includes(node.type);
/** Frames whose children flow (auto layout): their children's position and FILL/HUG sizes are computed. */
const isFlowContainer = (node: SceneNode | undefined) => isFrameLikeNode(node) && !!node!.autoLayout && node!.autoLayout.layoutMode !== 'NONE';

/** The mutable working copy every operation builds its result in. Nodes are copied on the first write, so
 *  untouched entries keep their identity (diffDocuments, autosave and the renderer's caches rely on it).
 *  Exported for variants.ts; editors use the operations instead. */
export class DocumentDraft {
  nodes: Nodes;
  readonly changed = new Set<NodeId>();
  /** Parents of the nodes `delete` removed (as they were before), for normalization's dirty set. */
  readonly formerParents = new Set<NodeId>();
  private ownNodes = false;
  private modes: Record<NodeId, Record<string, string>> | undefined;
  private ownModes = false;
  /** With `owned`: the table is a document's own, written in place — every write logs the entry before it. */
  private readonly log: TableLog | undefined;

  /** `owned`: `base.nodes` is a private table the caller lets the draft write into in place (a
   *  transaction's working table, see shared/design/normalize.ts) instead of copying it. */
  constructor(readonly base: DesignDocument, options: {owned?: boolean; log?: TableLog} = {}) {
    this.nodes = base.nodes;
    this.modes = base.variableModes;
    this.ownNodes = !!options.owned;
    this.log = options.owned ? options.log : undefined;
  }

  /** Whether the draft writes into a table of its own (copied or lent): indexes cached for it then
   *  describe an earlier state and must not outlive the operation (`forgetTable`). */
  get ownsTable(): boolean {
    return this.ownNodes;
  }

  get(id: NodeId | null | undefined): SceneNode | undefined {
    return id === null || id === undefined ? undefined : this.nodes[id];
  }

  put(node: SceneNode): void {
    if (!this.ownNodes) {
      this.nodes = copyTable(this.nodes);
      this.ownNodes = true;
    }
    this.log?.touch(node.id);
    this.nodes[node.id] = node;
    this.changed.add(node.id);
  }

  patch(id: NodeId, partial: Partial<SceneNode>): SceneNode | undefined {
    const node = this.nodes[id];
    if (!node) return undefined;
    const next = assignFields(node, partial);
    this.put(next);
    return next;
  }

  /** Removes one node (not its children) and any variable modes it carried. */
  delete(id: NodeId): void {
    if (!(id in this.nodes)) return;
    if (!this.ownNodes) {
      this.nodes = copyTable(this.nodes);
      this.ownNodes = true;
    }
    const parentId = this.nodes[id].parentId;
    if (parentId) this.formerParents.add(parentId);
    this.log?.deleting(id);
    delete this.nodes[id];
    this.changed.add(id);
    if (this.modes && id in this.modes) this.setModes(id, undefined);
  }

  deleteSubtree(id: NodeId): void {
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      const node = this.nodes[current];
      if (!node) continue;
      if (node.children) stack.push(...node.children);
      this.delete(current);
    }
  }

  modesOf(id: NodeId): Record<string, string> | undefined {
    return this.modes?.[id];
  }

  setModes(id: NodeId, value: Record<string, string> | undefined): void {
    if (!this.ownModes) {
      this.modes = {...(this.modes ?? {})};
      this.ownModes = true;
    }
    if (value && Object.keys(value).length) this.modes![id] = value;
    else delete this.modes![id];
  }

  /** The document as it stands, or `base` itself when nothing changed. */
  finish(): DesignDocument {
    // A lent table owned from the start: nothing written means nothing changed.
    if ((!this.ownNodes || (this.nodes === this.base.nodes && !this.changed.size)) && !this.ownModes) return this.base;
    const doc: DesignDocument = {...this.base, nodes: this.nodes};
    if (this.ownModes) {
      if (this.modes && Object.keys(this.modes).length) doc.variableModes = this.modes;
      else delete doc.variableModes;
    }
    return doc;
  }
}

function insertChild(draft: DocumentDraft, parentId: NodeId, childId: NodeId, index?: number): void {
  const parent = draft.get(parentId)!;
  const children = (parent.children ?? []).filter(id => id !== childId);
  const at = index === undefined ? children.length : Math.max(0, Math.min(children.length, Math.round(index)));
  children.splice(at, 0, childId);
  draft.patch(parentId, {children});
}

function removeChild(draft: DocumentDraft, parentId: NodeId | null, childId: NodeId): void {
  const parent = draft.get(parentId);
  if (parent?.children?.includes(childId)) draft.patch(parent.id, {children: parent.children.filter(id => id !== childId)});
}

// ── Tree queries ───────────────────────────────────────────────────────────────────────────────

/** Copies (nodes inside an instance) are exactly the nodes with a `mainId`. */
export const isInstanceCopy = (node: SceneNode | undefined) => node?.mainId !== undefined;

/** True for nodes inside an instance: they can be restyled (overrides) but not deleted, moved or given children. */
export const isInsideInstance = (doc: DesignDocument, id: NodeId) => isInstanceCopy(doc.nodes[id]);

function rootInstanceIn(nodes: Nodes, id: NodeId): NodeId | null {
  let node = nodes[id];
  for (let guard = 0; node && node.mainId !== undefined && guard < 10_000; guard++) node = node.parentId ? nodes[node.parentId] : (undefined as never);
  return node && node.type === 'INSTANCE' ? node.id : null;
}

/** The top-level instance a copy belongs to (the instance itself for an instance; null for other nodes). */
export const instanceRootOf = (doc: DesignDocument, id: NodeId) => rootInstanceIn(doc.nodes, id);

function nearestComponentIn(nodes: Nodes, id: NodeId | null | undefined): NodeId | null {
  for (let node = id ? nodes[id] : undefined, guard = 0; node && guard < 10_000; node = node.parentId ? nodes[node.parentId] : undefined, guard++) {
    if (node.type === 'COMPONENT') return node.id;
  }
  return null;
}

/** The main component a node is part of (itself for a component), or null. */
export const containingComponent = (doc: DesignDocument, id: NodeId) => nearestComponentIn(doc.nodes, id);

/** A nested instance a main component can expose: an INSTANCE of its own (not a copy) somewhere inside a main. */
export function isExposableInstance(doc: DesignDocument, id: NodeId): boolean {
  const node = doc.nodes[id];
  return node?.type === 'INSTANCE' && node.mainId === undefined && nearestComponentIn(doc.nodes, node.parentId) !== null;
}

/** The exposed nested instances whose properties an instance shows below its own: copies inside it with
 *  `isExposedInstance`, in layer order (top first), through nested instances too, as Figma lists them. */
export function exposedInstancesOf(doc: DesignDocument, instanceId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const visit = (id: NodeId, depth: number) => {
    const node = doc.nodes[id];
    if (!node?.children || depth > 64) return;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = doc.nodes[node.children[i]];
      if (!child) continue;
      if (child.type === 'INSTANCE' && child.isExposedInstance && child.mainId !== undefined) out.push(child.id);
      visit(child.id, depth + 1);
    }
  };
  if (doc.nodes[instanceId]?.type === 'INSTANCE') visit(instanceId, 0);
  return out;
}

const componentIn = (nodes: Nodes, id: NodeId | undefined): SceneNode | undefined => {
  const node = id ? nodes[id] : undefined;
  return node?.type === 'COMPONENT' ? node : undefined;
};

function setOfIn(nodes: Nodes, component: SceneNode): SceneNode | undefined {
  const parent = component.parentId ? nodes[component.parentId] : undefined;
  return parent?.type === 'COMPONENT_SET' ? parent : undefined;
}

/** The variant of a set that new instances use: the top-left one, as in Figma. */
function defaultVariantIn(nodes: Nodes, set: SceneNode): SceneNode | undefined {
  let best: SceneNode | undefined;
  for (const id of set.children ?? []) {
    const node = nodes[id];
    if (node?.type !== 'COMPONENT') continue;
    if (!best || node.y < best.y - 0.5 || (Math.abs(node.y - best.y) <= 0.5 && node.x < best.x)) best = node;
  }
  return best;
}

/** COMPONENT → itself, COMPONENT_SET → its default variant, anything else → undefined. */
function resolveComponentIn(nodes: Nodes, id: NodeId): SceneNode | undefined {
  const node = nodes[id];
  if (node?.type === 'COMPONENT') return node;
  if (node?.type === 'COMPONENT_SET') return defaultVariantIn(nodes, node);
  return undefined;
}

export const defaultVariant = (doc: DesignDocument, setId: NodeId) => {
  const set = doc.nodes[setId];
  return set?.type === 'COMPONENT_SET' ? defaultVariantIn(doc.nodes, set)?.id ?? null : null;
};

/** The name instances show: the set's name for a variant, else the component's. */
function displayNameIn(nodes: Nodes, component: SceneNode): string {
  return setOfIn(nodes, component)?.name ?? component.name;
}

// ── Variant names and property definitions ─────────────────────────────────────────────────────

/** "Size=Large, State=Hover" → {Size: 'Large', State: 'Hover'}; null when the
 *  name is not in that form. */
export function parseVariantName(name: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let any = false;
  for (const part of name.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim();
    if (!key) return null;
    out[key] = part.slice(eq + 1).trim();
    any = true;
  }
  return any ? out : null;
}

/** The inverse of `parseVariantName`, properties in `order` first. */
export function formatVariantName(values: Record<string, string>, order: readonly string[] = []): string {
  const keys = [...order.filter(key => key in values), ...Object.keys(values).filter(key => !order.includes(key))];
  return keys.map(key => `${key}=${values[key]}`).join(', ');
}

/** "Icon#12" → "Icon". Variant properties have no suffix. */
export const propertyName = (key: string) => {
  const hash = key.lastIndexOf('#');
  return hash > 0 ? key.slice(0, hash) : key;
};

/** A component's properties: a variant sees its set's (all variants share them, as in Figma) plus its own. */
function definitionsIn(nodes: Nodes, component: SceneNode): Record<string, ComponentPropertyDefinition> {
  if (component.type === 'COMPONENT_SET') return component.componentPropertyDefinitions ?? {};
  const set = setOfIn(nodes, component);
  const own = component.componentPropertyDefinitions ?? {};
  if (!set) return own;
  const shared = set.componentPropertyDefinitions ?? {};
  return Object.keys(own).length ? {...shared, ...own} : shared;
}

export function propertyDefinitionsOf(doc: DesignDocument, componentId: NodeId): Record<string, ComponentPropertyDefinition> {
  const node = doc.nodes[componentId];
  return node && (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') ? definitionsIn(doc.nodes, node) : {};
}

/** The variant property values of a component: its parsed name, missing ones filled from the set's defaults. */
function variantValuesIn(nodes: Nodes, component: SceneNode): Record<string, string> {
  const set = setOfIn(nodes, component);
  const parsed = parseVariantName(component.name) ?? {};
  if (!set) return parsed;
  const out: Record<string, string> = {};
  for (const [key, def] of Object.entries(set.componentPropertyDefinitions ?? {})) {
    if (def.type === 'VARIANT') out[key] = parsed[key] ?? String(def.defaultValue);
  }
  return out;
}

export const variantValues = (doc: DesignDocument, componentId: NodeId) => {
  const component = componentIn(doc.nodes, componentId);
  return component ? variantValuesIn(doc.nodes, component) : {};
};

/** The VARIANT definitions a set's variant names imply: option order is kept where values survive, new
 *  values are appended, and the default is the default variant's value. Null when nothing changes. */
function variantDefinitionsFromNames(nodes: Nodes, set: SceneNode): Record<string, ComponentPropertyDefinition> | null {
  const existing = set.componentPropertyDefinitions ?? {};
  const order: string[] = [];
  const used = new Map<string, string[]>();
  for (const [key, def] of Object.entries(existing)) if (def.type === 'VARIANT') { order.push(key); used.set(key, []); }
  for (const id of set.children ?? []) {
    const node = nodes[id];
    if (node?.type !== 'COMPONENT') continue;
    const parsed = parseVariantName(node.name);
    if (!parsed) continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (!used.has(key)) { order.push(key); used.set(key, []); }
      const values = used.get(key)!;
      if (!values.includes(value)) values.push(value);
    }
  }
  const fallback = defaultVariantIn(nodes, set);
  const defaults = fallback ? parseVariantName(fallback.name) ?? {} : {};
  const next: Record<string, ComponentPropertyDefinition> = {};
  for (const [key, def] of Object.entries(existing)) if (def.type !== 'VARIANT') next[key] = def;
  for (const key of order) {
    const values = used.get(key)!;
    if (!values.length) continue;
    const previous = existing[key]?.type === 'VARIANT' ? existing[key].variantOptions ?? [] : [];
    const options = [...previous.filter(value => values.includes(value)), ...values.filter(value => !previous.includes(value))];
    next[key] = {type: 'VARIANT', defaultValue: defaults[key] !== undefined && options.includes(defaults[key]) ? defaults[key] : options[0], variantOptions: options};
  }
  return deepEqual(next, existing) ? null : next;
}

/** Rewrites a set's VARIANT definitions from its variants' names (after a rename in the layers panel). */
export function refreshVariantDefinitionsIn(draft: DocumentDraft, setId: NodeId): boolean {
  const set = draft.get(setId);
  if (set?.type !== 'COMPONENT_SET') return false;
  const next = variantDefinitionsFromNames(draft.nodes, set);
  if (!next) return false;
  draft.patch(setId, {componentPropertyDefinitions: next});
  return true;
}

/** The variant of `set` closest to `wanted`: it must have `wanted[priority]`, and among those the one
 *  matching most other values wins (the first in layer order on a tie) — Figma's fallback when a
 *  combination does not exist. */
function findVariantIn(nodes: Nodes, set: SceneNode, wanted: Record<string, string>, priority: string): SceneNode | undefined {
  let best: SceneNode | undefined, bestScore = -1;
  for (const id of set.children ?? []) {
    const node = nodes[id];
    if (node?.type !== 'COMPONENT') continue;
    const values = variantValuesIn(nodes, node);
    if (values[priority] !== wanted[priority]) continue;
    let score = 0;
    for (const key in wanted) if (values[key] === wanted[key]) score++;
    if (score > bestScore) { best = node; bestScore = score; }
  }
  return best;
}

export function findVariant(doc: DesignDocument, setId: NodeId, wanted: Record<string, string>, priority: string): NodeId | null {
  const set = doc.nodes[setId];
  return set?.type === 'COMPONENT_SET' ? findVariantIn(doc.nodes, set, wanted, priority)?.id ?? null : null;
}

const validPropertyValue = (def: ComponentPropertyDefinition, value: unknown) =>
  def.type === 'BOOLEAN' ? typeof value === 'boolean' : typeof value === 'string';

// ── Overrides ──────────────────────────────────────────────────────────────────────────────────

/** Fields a copy can override (or the INSTANCE itself, except its placement). Everything else on a copy
 *  always comes from the node it mirrors. `name` counts only when the user renames the copy. */
export const OVERRIDABLE_FIELDS: readonly string[] = [
  'name', 'visible', 'locked', 'opacity', 'blendMode', 'isMask', 'maskType',
  'x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY', 'constrainProportions',
  'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern', 'effects',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'boundVariables',
  'constraints', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'exportSettings', 'reactions',
  'cornerRadius', 'rectangleCornerRadii', 'cornerSmoothing', 'individualStrokeWeights',
  'clipsContent', 'autoLayout', 'grid', 'gridChild', 'layoutGrids', 'gridStyleId', 'overflowDirection',
  'overlayPositionType', 'overlayBackground', 'overlayBackgroundInteraction', 'scrollBehavior',
  'arcData', 'pointCount', 'innerRadius', 'strokeStartMarker', 'strokeEndMarker', 'variableWidthStrokeProperties', 'vectorPaths', 'booleanOperation',
  'text', 'textStyleId', 'textPath', 'annotations',
  'componentId', 'componentProperties',
  'pluginData',
];
const OVERRIDABLE = new Set(OVERRIDABLE_FIELDS);

/** Object fields tracked per part (`text.characters`, `text.style.fontSize`, `autoLayout.paddingLeft`,
 *  `componentProperties.<key>`, `boundVariables.<field>`), so a main's change to another part still arrives. */
export const GRANULAR_OVERRIDE_FIELDS: readonly string[] = ['text', 'autoLayout', 'grid', 'componentProperties', 'boundVariables'];
const GRANULAR = new Set(GRANULAR_OVERRIDE_FIELDS);

/** Where an instance sits and how it behaves in its parent: the instance's own, never its main's. */
const PLACEMENT_FIELDS = new Set(['x', 'y', 'rotation', 'flipX', 'flipY', 'visible', 'locked', 'isMask', 'maskType', 'constraints', 'layoutPositioning', 'gridChild', 'scrollBehavior', 'componentPropertyReferences', 'isExposedInstance', 'pluginData']);
/** A swapped nested instance keeps its slot: placement plus how it sizes in an auto-layout parent. */
const SWAP_PLACEMENT_FIELDS = new Set([...PLACEMENT_FIELDS, 'layoutSizingHorizontal', 'layoutSizingVertical']);
/** Never recorded on a top-level instance: they are its own anyway. */
const ROOT_UNTRACKED = new Set([...PLACEMENT_FIELDS, 'componentId']);
/** Fields a parent's resize moves on its descendants; recorded only on nodes the user acted on. */
const GEOMETRY_FIELDS = new Set(['x', 'y', 'width', 'height', 'rotation', 'vectorPaths', 'textPath']);
/** Fields of a COMPONENT that an instance never takes (`remote`: a library copy's origin, shared/design/libraries.ts). */
const COMPONENT_ONLY = new Set(['id', 'parentId', 'children', 'description', 'componentPropertyDefinitions', 'remote']);

type ParsedOverrides = Map<string, true | string[]>;

function parseOverrides(list: readonly string[]): ParsedOverrides {
  const map: ParsedOverrides = new Map();
  for (const path of list) {
    const dot = path.indexOf('.');
    if (dot < 0 || !GRANULAR.has(path.slice(0, dot))) { map.set(path, true); continue; }
    const head = path.slice(0, dot), key = path.slice(dot + 1);
    const current = map.get(head);
    if (current === true) continue;
    if (current) current.push(key);
    else map.set(head, [key]);
  }
  return map;
}

/** True when `path` (a field or a part of one) is overridden on the node. */
export function isOverridden(node: SceneNode | undefined, path: string): boolean {
  if (!node?.overrides) return false;
  return node.overrides.some(entry => entry === path || entry.startsWith(path + '.') || path.startsWith(entry + '.'));
}

function granularDiff(head: string, before: unknown, after: unknown, out: string[]): void {
  const a = (before ?? {}) as Fields, b = (after ?? {}) as Fields;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (head === 'text' && key === 'style') {
      const sa = (a.style ?? {}) as Fields, sb = (b.style ?? {}) as Fields;
      for (const styleKey of new Set([...Object.keys(sa), ...Object.keys(sb)])) if (!deepEqual(sa[styleKey], sb[styleKey])) out.push(`text.style.${styleKey}`);
      continue;
    }
    if (!deepEqual(a[key], b[key])) out.push(`${head}.${key}`);
  }
}

function addOverridePaths(current: readonly string[], paths: readonly string[]): readonly string[] {
  let next: string[] | null = null;
  for (const path of paths) {
    const list: readonly string[] = next ?? current;
    if (list.some(entry => entry === path || path.startsWith(entry + '.'))) continue;
    next = list.filter(entry => !entry.startsWith(path + '.'));
    next.push(path);
  }
  return next ?? current;
}

function removeOverridePaths(current: readonly string[] | undefined, fields: readonly string[]): string[] | undefined {
  if (!current?.length) return undefined;
  const next = current.filter(entry => !fields.some(field => entry === field || entry.startsWith(field + '.')));
  return next.length ? next : undefined;
}

function changedPaths(doc: DesignDocument, node: SceneNode, partial: Partial<SceneNode>, direct: boolean): string[] {
  const out: string[] = [];
  const root = node.mainId === undefined;
  const fields = fieldsOf(node), changes = fieldsOf(partial);
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  const inFlow = isFlowContainer(parent) && (changes.layoutPositioning ?? node.layoutPositioning) !== 'ABSOLUTE';
  for (const key in changes) {
    if (!OVERRIDABLE.has(key)) continue;
    if (root && ROOT_UNTRACKED.has(key)) continue;
    if (!direct && GEOMETRY_FIELDS.has(key)) continue;
    if (inFlow && (key === 'x' || key === 'y')) continue;
    if (inFlow && key === 'width' && (changes.layoutSizingHorizontal ?? node.layoutSizingHorizontal) !== 'FIXED') continue;
    if (inFlow && key === 'height' && (changes.layoutSizingVertical ?? node.layoutSizingVertical) !== 'FIXED') continue;
    if (GRANULAR.has(key)) granularDiff(key, fields[key], changes[key], out);
    else if (!deepEqual(fields[key], changes[key])) out.push(key);
  }
  return out;
}

export type OverrideTrackingOptions = {
  /** False for updates the user did not make on this node directly (a parent's resize moving it):
   *  geometry (x, y, width, height, rotation, vectorPaths) is then not recorded. Default true. */
  direct?: boolean;
};

/** The partial an editor should apply to a node inside an instance (or to an instance): the same fields
 *  plus `overrides` grown by the fields that change. Other nodes, and partials that set `overrides`
 *  themselves (a reset), come back unchanged. */
export function withOverrideTracking(doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>, options: OverrideTrackingOptions = {}): Partial<SceneNode> {
  const node = doc.nodes[id];
  if (!node || 'overrides' in partial) return partial;
  if (node.mainId === undefined && node.type !== 'INSTANCE') return partial;
  const paths = changedPaths(doc, node, partial, options.direct !== false);
  if (!paths.length) return partial;
  const current = node.overrides ?? [];
  const next = addOverridePaths(current, paths);
  return next === current ? partial : {...partial, overrides: [...next]};
}

/** `withOverrideTracking` for every update of a transaction. `direct` names the nodes the user acted on;
 *  without it every update counts as direct. */
export function recordOverrides(doc: DesignDocument, updates: ReadonlyMap<NodeId, Partial<SceneNode>>, options: {direct?: ReadonlySet<NodeId>} = {}): Map<NodeId, Partial<SceneNode>> {
  const out = new Map<NodeId, Partial<SceneNode>>();
  for (const [id, partial] of updates) out.set(id, withOverrideTracking(doc, id, partial, {direct: options.direct ? options.direct.has(id) : true}));
  return out;
}

/** Puts the overridden parts of `own` over `base` (the value from the main). */
function mergeGranular(head: string, base: unknown, own: unknown, keys: readonly string[]): unknown {
  const ownFields = (own ?? {}) as Fields;
  const out: Fields = {...((base ?? {}) as Fields)};
  for (const key of keys) {
    if (head === 'text' && key.startsWith('style.')) {
      const styleKey = key.slice(6);
      const style: Fields = {...((out.style ?? {}) as Fields)};
      const value = ((ownFields.style ?? {}) as Fields)[styleKey];
      if (value === undefined) delete style[styleKey];
      else style[styleKey] = value;
      out.style = style;
      continue;
    }
    const value = ownFields[key];
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  if (base === undefined && !Object.keys(out).length) return undefined;
  return deepEqual(out, own) ? own : out;
}

function applyOverrides(node: Fields, old: SceneNode, overrides: ParsedOverrides): void {
  const own = fieldsOf(old);
  for (const [head, keys] of overrides) {
    if (head === 'componentProperties' || head === 'componentId') continue;
    const value = keys === true ? own[head] : mergeGranular(head, node[head], own[head], keys);
    if (value === undefined) delete node[head];
    else node[head] = value;
  }
}

// ── Text and vectors that follow a copy ────────────────────────────────────────────────────────

function clipRuns(runs: TextRun[], length: number): TextRun[] {
  if (runs.every(run => run.end <= length)) return runs;
  const out: TextRun[] = [];
  for (const run of runs) {
    if (run.start >= length) continue;
    out.push(run.end > length ? {...run, end: length} : run);
  }
  return out;
}

function withCharacters(text: TextProps, characters: string): TextProps {
  return {...text, characters, runs: clipRuns(text.runs ?? [], characters.length)};
}

/** How a copy's children follow when the copy's box differs from the box their sources sit in: as
 *  `resizeNode` moves the children of a resized node ('follow', shared/design/constraints.ts) — by their
 *  constraints, scaled inside groups and boolean operations, untouched in a section. */
type ChildGeometry = {before: Size; after: Size; scale: boolean};
/** Where a copy's parent puts it: the resize to follow, and whether the parent lays its children out. */
type Placement = {geometry: ChildGeometry | null; flow: boolean};

function childGeometry(node: Fields, source: SceneNode): ChildGeometry | null {
  const width = node.width as number, height = node.height as number;
  if (sameValue(width, source.width) && sameValue(height, source.height)) return null;
  const type = node.type as SceneNode['type'];
  if (type === 'SECTION') return null;
  return {before: {width: source.width, height: source.height}, after: {width, height}, scale: type === 'GROUP' || type === 'BOOLEAN_OPERATION'};
}

const SCALE_BOTH: Constraints = {horizontal: 'SCALE', vertical: 'SCALE'};

function applyGeometry(node: Fields, overrides: ParsedOverrides | null, geometry: ChildGeometry): void {
  const current = asNode(node);
  const box = constrainedBox(current, geometry.before, geometry.after, geometry.scale ? SCALE_BOTH : current.constraints);
  const width = Math.max(0, box.width), height = current.type === 'LINE' ? 0 : Math.max(0, box.height);
  const widthChanged = !sameValue(width, current.width), heightChanged = !sameValue(height, current.height);
  if (!overrides?.has('x')) node.x = box.x;
  if (!overrides?.has('y')) node.y = box.y;
  if (!overrides?.has('width')) node.width = width;
  if (!overrides?.has('height')) node.height = height;
  // A text stretched by its constraints stops growing on that axis, as constraints.ts does it.
  const text = node.text as TextProps | undefined;
  if (text && (widthChanged || heightChanged) && !isPartOverridden(overrides, 'text', 'textAutoResize')) {
    const mode = textModeAfterResize(text.textAutoResize, widthChanged, heightChanged);
    if (mode !== text.textAutoResize) {
      node.text = {...text, textAutoResize: mode};
      if (!overrides?.has('layoutSizingHorizontal') && node.layoutSizingHorizontal !== 'FILL') node.layoutSizingHorizontal = mode === 'WIDTH_AND_HEIGHT' ? 'HUG' : 'FIXED';
      if (!overrides?.has('layoutSizingVertical') && node.layoutSizingVertical !== 'FILL') node.layoutSizingVertical = mode === 'WIDTH_AND_HEIGHT' || mode === 'HEIGHT' ? 'HUG' : 'FIXED';
    }
  }
}

/** Values auto layout and text measuring own. The copy keeps what the last normalize computed for them
 *  instead of its main's (laid out for the main's content): a sync never undoes layout, and layout runs
 *  again on whatever the sync changed. `old` must mirror the same node. */
function keepLayoutOwned(node: Fields, old: SceneNode, overrides: ParsedOverrides | null, flow: boolean, root: boolean): void {
  const own = fieldsOf(old);
  const keep = (key: string) => {
    if (!overrides?.has(key) && own[key] !== undefined) node[key] = own[key];
  };
  const inFlow = flow && node.layoutPositioning !== 'ABSOLUTE';
  if (inFlow && !root) { keep('x'); keep('y'); }
  const text = node.text as TextProps | undefined;
  // Measured sizes hold while the text is the same.
  const measured = !!text && !!old.text && (text === old.text || deepEqual(text, old.text));
  const laysOut = isAutoLayout(asNode(node));
  const sizing = (value: unknown) => (inFlow && value === 'FILL') || (value === 'HUG' && (laysOut || measured));
  if (sizing(node.layoutSizingHorizontal)) keep('width');
  if (sizing(node.layoutSizingVertical)) keep('height');
  if (measured && !inFlow) {
    const mode = text!.textAutoResize;
    if (mode === 'WIDTH_AND_HEIGHT') { keep('width'); keep('height'); }
    else if (mode === 'HEIGHT' && sameValue(node.width, old.width)) keep('height');
  }
}

// ── Reverse index ──────────────────────────────────────────────────────────────────────────────

type InstanceIndex = {byComponent: Map<NodeId, NodeId[]>; count: number};

/** The component an entry shows, when it is an INSTANCE (what the instance index records). */
const shownComponent = (node: SceneNode | undefined): NodeId | null => (node?.type === 'INSTANCE' && node.componentId ? node.componentId : null);

/** A table that differs from the indexed one only where no instance appeared, went or changed its
 *  component has the same index: an edit to ordinary layers never rescans the file for instances.
 *  Any other change rebuilds it (in table order, as a fresh build lists them). */
const instanceIndexes = tableCache<InstanceIndex>((previous, before, after, changed) => {
  for (const id of changed) if (shownComponent(before[id]) !== shownComponent(after[id])) return undefined;
  return previous;
});

/** A node table and how it differs from one whose indexes may be cached (normalization's working
 *  table during a commit, see shared/design/normalize.ts). */
export type TableOrigin = {nodes: Readonly<Nodes>; changed: Iterable<NodeId>};

/** componentId → every INSTANCE showing it (top-level ones and nested copies), built once per node map.
 *  With `origin`, `nodes` is a table still being written (normalization's, frame after frame of a
 *  drag): the index of the origin's table, which stays as it is, is built and kept instead, and used
 *  whenever the changed ids leave it valid. */
function instanceIndex(nodes: Nodes, origin?: TableOrigin): InstanceIndex {
  const index = instanceIndexes.get(nodes);
  if (index) return index;
  if (origin) {
    const previous = buildInstanceIndex(origin.nodes);
    for (const id of origin.changed) if (shownComponent(origin.nodes[id]) !== shownComponent(nodes[id])) return buildInstanceIndex(nodes);
    return previous;
  }
  return buildInstanceIndex(nodes);
}

function buildInstanceIndex(nodes: Readonly<Nodes>): InstanceIndex {
  let index = instanceIndexes.get(nodes);
  if (index) return index;
  const byComponent = new Map<NodeId, NodeId[]>();
  let count = 0;
  for (const node of Object.values(nodes)) {
    if (node.type !== 'INSTANCE' || !node.componentId) continue;
    count++;
    const list = byComponent.get(node.componentId);
    if (list) list.push(node.id);
    else byComponent.set(node.componentId, [node.id]);
  }
  index = {byComponent, count};
  instanceIndexes.set(nodes, index);
  return index;
}

/** Every INSTANCE (top-level or nested) that shows the component. */
export function instancesOfComponent(doc: DesignDocument, componentId: NodeId): NodeId[] {
  return [...(instanceIndex(doc.nodes).byComponent.get(componentId) ?? [])];
}

// ── Sync ───────────────────────────────────────────────────────────────────────────────────────

type Owner = {props: Record<string, string | boolean>};

/** Copy → the source node it was last derived from, recorded only when nothing else fed the derivation
 *  (no parent resize, no property references, no swap transfer), one table for children of a plain parent
 *  and one for children of an auto-layout parent. Both are immutable, so while the copy and its source are
 *  the same objects the copy is up to date and syncing skips it. */
const derivedFrom = [new WeakMap<SceneNode, SceneNode>(), new WeakMap<SceneNode, SceneNode>()] as const;
const derivedTable = (flow: boolean) => derivedFrom[flow ? 1 : 0];

const sameIds = (a: readonly NodeId[], b: readonly NodeId[] | undefined) => !!b && a.length === b.length && a.every((id, i) => id === b[i]);

/** `id === `${prefix};${mainId}`` without building the string. */
const isCopyId = (id: string, prefix: string, mainId: string) =>
  id.length === prefix.length + 1 + mainId.length && id.charCodeAt(prefix.length) === 59 && id.startsWith(prefix) && id.endsWith(mainId);

const COPY_IDENTITY = new Set(['id', 'parentId', 'children', 'mainId', 'overrides']);

/** Whether a copy without overrides holds exactly its source's fields (the parent's size unchanged and no
 *  property driving it): the check the first sync after loading a file makes for every copy. */
function mirrorsSource(copy: SceneNode, source: SceneNode): boolean {
  if (copy.mainId !== source.id || copy.type !== source.type) return false;
  const own = fieldsOf(copy), from = fieldsOf(source);
  let count = 0;
  for (const key in from) {
    if (COPY_IDENTITY.has(key)) continue;
    const value = from[key];
    if (value === undefined) continue;
    count++;
    const mine = own[key];
    if (mine !== value && !deepEqual(mine, value)) return false;
  }
  for (const key in own) if (!COPY_IDENTITY.has(key) && own[key] !== undefined) count--;
  return count === 0;
}
type Transfer = Map<string, SceneNode>;
/** Copies that left their parent during a rebuild, with that parent: removed at the end unless the rebuild
 *  moved them elsewhere (a main child moved into another frame keeps its copy and overrides). */
type RootState = {stale: [id: NodeId, parentId: NodeId][]};

/** One sync pass over a draft. Top-level instances are rebuilt whole, in dependency order: before an
 *  instance reads a nested instance of its main, that nested instance is rebuilt first (`ensure`). */
class SyncRun {
  readonly pending = new Set<NodeId>();
  private readonly done = new Set<NodeId>();
  private readonly active = new Set<NodeId>();
  /** Components being materialized: a data cycle stops here instead of recursing forever. */
  private readonly stack: NodeId[] = [];
  private readonly definitions = new Map<NodeId, Record<string, ComponentPropertyDefinition>>();
  private readonly variants = new Map<NodeId, Record<string, string>>();

  constructor(private readonly draft: DocumentDraft) {}

  run(): void {
    for (const id of this.pending) this.ensure(id);
  }

  private ensure(id: NodeId): void {
    if (this.done.has(id) || this.active.has(id)) return;
    const node = this.draft.get(id);
    if (node?.type === 'INSTANCE' && node.mainId === undefined) {
      this.active.add(id);
      this.rebuildRoot(node);
      this.active.delete(id);
    }
    this.done.add(id);
  }

  private component(id: NodeId | undefined): SceneNode | undefined {
    return componentIn(this.draft.nodes, id);
  }

  private defs(component: SceneNode): Record<string, ComponentPropertyDefinition> {
    let defs = this.definitions.get(component.id);
    if (!defs) this.definitions.set(component.id, defs = definitionsIn(this.draft.nodes, component));
    return defs;
  }

  private variantOf(component: SceneNode): Record<string, string> {
    let values = this.variants.get(component.id);
    if (!values) this.variants.set(component.id, values = variantValuesIn(this.draft.nodes, component));
    return values;
  }

  private rebuildRoot(instance: SceneNode): void {
    const component = this.component(instance.componentId);
    if (!component || this.stack.includes(component.id)) return;
    const state: RootState = {stale: []};
    const overrides = instance.overrides?.length ? parseOverrides(instance.overrides) : null;
    const node = fromComponent(this.draft.nodes, component, instance, PLACEMENT_FIELDS);
    node.id = instance.id;
    node.parentId = instance.parentId;
    if (overrides) applyOverrides(node, instance, overrides);
    const flow = isAutoLayout(this.draft.get(instance.parentId));
    // FILL only means something in an auto-layout parent.
    if (!flow) {
      if (node.layoutSizingHorizontal === 'FILL') node.layoutSizingHorizontal = 'FIXED';
      if (node.layoutSizingVertical === 'FILL') node.layoutSizingVertical = 'FIXED';
    }
    // A size layout gave this instance (hugging its content, filling its parent) stays until layout runs
    // again, unless the instance now shows another component.
    const first = instance.children?.[0];
    if (!first || this.draft.get(this.draft.get(first)?.mainId)?.parentId === component.id) keepLayoutOwned(node, instance, overrides, flow, true);
    const props = this.properties(component, null, instance, overrides);
    node.componentProperties = props.values;
    if (props.overrides?.length) node.overrides = props.overrides;
    if (node.text) node.text = sanitizeText(node.text as TextProps);
    this.stack.push(component.id);
    node.children = this.buildChildren(node, instance, component, instance.id, {props: props.values}, null, '', state);
    this.stack.pop();
    this.write(instance, node);
    this.removeStale(state);
  }

  /** Effective property values of an instance (or nested copy) of `component`: overridden values, else
   *  the value the mirrored nested instance has (`inherited`), else the default; variant values come from
   *  the variant's name. Overridden keys the component lacks move to a same-named property (a swap). */
  private properties(component: SceneNode, inherited: Record<string, string | boolean> | null, old: SceneNode | undefined, overrides: ParsedOverrides | null): {values: Record<string, string | boolean>; overrides: readonly string[] | undefined} {
    const defs = this.defs(component);
    const own = old?.componentProperties ?? {};
    const overridden = overrides?.get('componentProperties');
    const isSet = (key: string) => overridden === true || (Array.isArray(overridden) && overridden.includes(key));
    const values: Record<string, string | boolean> = {};
    let variant: Record<string, string> | null = null;
    for (const key in defs) {
      const def = defs[key];
      if (def.type === 'VARIANT') {
        variant ??= this.variantOf(component);
        values[key] = variant[key] ?? def.defaultValue;
      } else if (isSet(key) && key in own && validPropertyValue(def, own[key])) values[key] = own[key];
      else if (inherited && key in inherited && validPropertyValue(def, inherited[key])) values[key] = inherited[key];
      else values[key] = def.defaultValue;
    }
    let list = old?.overrides;
    if (Array.isArray(overridden)) {
      for (const key of overridden) {
        if (key in defs && defs[key].type !== 'VARIANT') continue;
        list = (list ?? []).filter(entry => entry !== `componentProperties.${key}`);
        const name = propertyName(key);
        const match = Object.keys(defs).find(candidate => defs[candidate].type !== 'VARIANT' && propertyName(candidate) === name && !overridden.includes(candidate));
        if (match && key in own && validPropertyValue(defs[match], own[key])) {
          values[match] = own[key];
          list = [...list, `componentProperties.${match}`];
        }
      }
    }
    return {values, overrides: list};
  }

  /** Builds the copies of `source`'s children under `node`, reusing existing copies (`old`'s children). */
  private buildChildren(node: Fields, old: SceneNode | undefined, source: SceneNode, prefix: string, owner: Owner, transfer: Transfer | null, path: string, state: RootState): NodeId[] {
    const sourceChildren = source.children ?? [];
    const oldChildren = old?.children ?? [];
    let nextTransfer = transfer, basePath = path;
    if (oldChildren.length && (node.type === 'INSTANCE' || old?.type === 'INSTANCE') && !(sourceChildren.length && isCopyId(oldChildren[0], prefix, sourceChildren[0]))) {
      // A swap (variant switch, swapped nested instance): every old copy is gone. Figma keeps the overrides
      // of layers with the same name and place in the hierarchy; index the old ones by that path.
      const expected = new Set(sourceChildren.map(id => `${prefix};${id}`));
      if (!oldChildren.some(id => expected.has(id))) {
        nextTransfer = this.transferIndex(oldChildren);
        basePath = '';
      }
    }
    const placement: Placement = {geometry: childGeometry(node, source), flow: isAutoLayout(asNode(node))};
    const counts = nextTransfer ? new Map<string, number>() : null;
    const ids: NodeId[] = [];
    for (let i = 0; i < sourceChildren.length; i++) {
      const sourceId = sourceChildren[i];
      let child = this.draft.get(sourceId);
      if (!child) continue;
      if (child.type === 'INSTANCE' && child.mainId === undefined && this.pending.has(sourceId) && !this.done.has(sourceId)) {
        this.ensure(sourceId);
        child = this.draft.get(sourceId)!;
      }
      let childPath = '';
      if (counts) {
        const n = (counts.get(child.name) ?? 0) + 1;
        counts.set(child.name, n);
        childPath = `${basePath}/${child.name}#${n}`;
      }
      // The stored id string when it is the same id: no new string, and its hash is already cached.
      const id = i < oldChildren.length && isCopyId(oldChildren[i], prefix, sourceId) ? oldChildren[i] : `${prefix};${sourceId}`;
      ids.push(this.materialize(child, id, prefix, node.id as NodeId, owner, placement, nextTransfer, childPath, state));
    }
    if (oldChildren.length && !sameIds(ids, oldChildren)) {
      const kept = new Set(ids);
      for (const id of oldChildren) {
        if (kept.has(id)) continue;
        // Only copies go when their main node does; a stray layer that is no copy (bad import) stays on top
        // rather than being lost.
        if (this.draft.get(id)?.mainId === undefined && this.draft.get(id)) ids.push(id);
        else state.stale.push([id, node.id as NodeId]);
      }
    }
    return ids;
  }

  private transferIndex(oldChildren: readonly NodeId[]): Transfer {
    const index: Transfer = new Map();
    const visit = (ids: readonly NodeId[], path: string) => {
      const counts = new Map<string, number>();
      for (const id of ids) {
        const node = this.draft.get(id);
        if (!node) continue;
        const name = this.draft.get(node.mainId)?.name ?? node.name;
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        const key = `${path}/${name}#${n}`;
        index.set(key, node);
        if (node.children) visit(node.children, key);
      }
    };
    visit(oldChildren, '');
    return index;
  }

  /** The copy of `source` under `parentId`, built from the source, the existing copy's overrides, the
   *  owner instance's property values and the parent's resize. Returns its id. */
  private materialize(source: SceneNode, id: NodeId, prefix: string, parentId: NodeId, owner: Owner, placement: Placement, transfer: Transfer | null, path: string, state: RootState): NodeId {
    let old = this.draft.get(id);
    let seeded = false;
    if (!old && transfer) {
      const match = transfer.get(path);
      if (match && match.type === source.type) { old = match; seeded = true; }
    }
    // Nothing this copy depends on changed since it was derived (or, without overrides, it already equals
    // its source): only its descendants may need work.
    const simple = !placement.geometry && !transfer && source.type !== 'INSTANCE' && !source.componentPropertyReferences;
    const derived = derivedTable(placement.flow);
    if (simple && old && !seeded && old.parentId === parentId && (derived.get(old) === source || (!old.overrides && mirrorsSource(old, source)))) {
      derived.set(old, source);
      if (source.children) {
        const children = this.buildChildren(old as unknown as Fields, old, source, prefix, owner, null, path, state);
        if (!sameIds(children, old.children)) this.draft.put({...old, children});
      }
      return id;
    }
    const overrides = old?.overrides?.length ? parseOverrides(old.overrides) : null;

    let node: Fields;
    let childSource: SceneNode | null = null;
    let childPrefix = prefix;
    let propsComponent: SceneNode | undefined;
    let inherited: Record<string, string | boolean> | null = null;
    let pushed = false;
    if (source.type === 'INSTANCE') {
      let componentId = source.componentId;
      const ref = source.componentPropertyReferences?.mainComponent;
      if (ref !== undefined) {
        const value = owner.props[ref];
        if (typeof value === 'string' && this.component(value)) componentId = value;
      }
      if (overrides?.has('componentId') && this.component(old?.componentId)) componentId = old!.componentId;
      const swapTo = componentId !== source.componentId ? this.component(componentId) : undefined;
      if (swapTo && !this.stack.includes(swapTo.id)) {
        node = fromComponent(this.draft.nodes, swapTo, source, SWAP_PLACEMENT_FIELDS);
        childSource = swapTo;
        childPrefix = id;
        propsComponent = swapTo;
        this.stack.push(swapTo.id);
        pushed = true;
      } else {
        node = {...source};
        childSource = source;
        propsComponent = this.component(source.componentId);
        inherited = source.componentProperties ?? null;
      }
    } else {
      node = {...source};
      if (source.children) childSource = source;
    }
    node.id = id;
    node.parentId = parentId;
    node.mainId = source.id;
    if (node.overrides !== undefined) delete node.overrides;
    if (overrides) applyOverrides(node, old!, overrides);

    const refs = source.componentPropertyReferences as ComponentPropertyReferences | undefined;
    if (refs?.visible !== undefined && !overrides?.has('visible')) {
      const value = owner.props[refs.visible];
      if (typeof value === 'boolean') node.visible = value;
    }
    if (node.text) {
      let text = node.text as TextProps;
      if (refs?.characters !== undefined && !isPartOverridden(overrides, 'text', 'characters')) {
        const value = owner.props[refs.characters];
        if (typeof value === 'string' && value !== text.characters) text = withCharacters(text, value);
      }
      node.text = sanitizeText(text);
    }
    // Geometry: the main's, following the parent's resize by constraints (children in a flow wait for
    // layout), then what layout and measuring own is kept from the copy as last laid out.
    const inFlow = placement.flow && node.layoutPositioning !== 'ABSOLUTE';
    if (placement.geometry && !inFlow) applyGeometry(node, overrides, placement.geometry);
    if (old && !seeded && old.mainId === source.id && (node.type !== 'INSTANCE' || old.componentId === node.componentId)) keepLayoutOwned(node, old, overrides, placement.flow, false);
    if (node.type === 'VECTOR' && node.vectorPaths && !overrides?.has('vectorPaths') && (node.width !== source.width || node.height !== source.height) && source.width > 0 && source.height > 0) {
      node.vectorPaths = scalePaths(node.vectorPaths as VectorPath[], (node.width as number) / source.width, (node.height as number) / source.height);
    }
    // A text on a path follows its copy's size the same way (shared/design/text-path.ts).
    if (node.textPath && !overrides?.has('textPath') && (node.width !== source.width || node.height !== source.height) && source.width > 0 && source.height > 0) {
      node.textPath = scaleTextPath(node.textPath as TextPathData, (node.width as number) / source.width, (node.height as number) / source.height);
    }

    let list: readonly string[] | undefined = old?.overrides;
    let childOwner = owner;
    if (node.type === 'INSTANCE' && propsComponent) {
      const props = this.properties(propsComponent, inherited, old, overrides);
      node.componentProperties = props.values;
      list = props.overrides;
      childOwner = {props: props.values};
    }
    if (list?.length) node.overrides = list;

    if (childSource) {
      node.children = this.buildChildren(node, seeded ? undefined : old, childSource, childPrefix, childOwner, transfer, path, state);
    } else if (node.type === 'INSTANCE') {
      // Its main is gone or would recurse: keep what it shows.
      node.children = seeded ? [] : old?.children ?? [];
    }
    if (pushed) this.stack.pop();
    const written = this.write(seeded ? undefined : old, node);
    if (simple) derived.set(written, source);
    return id;
  }

  /** Stores the derived node unless it equals the existing one; returns the node now in the draft. */
  private write(old: SceneNode | undefined, node: Fields): SceneNode {
    if (old && sameNode(old, node)) return old;
    const next = asNode(node);
    this.draft.put(next);
    return next;
  }

  private removeStale(state: RootState): void {
    const stack = [...state.stale];
    while (stack.length) {
      const [id, parentId] = stack.pop()!;
      const node = this.draft.get(id);
      // A node the rebuild placed under another parent was rewritten with that parent: it stays.
      if (!node || node.parentId !== parentId) continue;
      for (const child of node.children ?? []) stack.push([child, id]);
      this.draft.delete(id);
    }
  }
}

function isPartOverridden(overrides: ParsedOverrides | null, head: string, part: string): boolean {
  const entry = overrides?.get(head);
  return entry === true || (Array.isArray(entry) && entry.includes(part));
}

function sanitizeText(text: TextProps): TextProps {
  const runs = clipRuns(text.runs ?? [], text.characters.length);
  return runs === text.runs ? text : {...text, runs};
}

/** An INSTANCE built from `component`'s fields with `placement`'s placement fields. */
function fromComponent(nodes: Nodes, component: SceneNode, placement: SceneNode, fields: ReadonlySet<string>): Fields {
  const node: Fields = {};
  const from = fieldsOf(component), own = fieldsOf(placement);
  for (const key in from) if (!COMPONENT_ONLY.has(key)) node[key] = from[key];
  for (const key of fields) {
    const value = own[key];
    if (value === undefined) delete node[key];
    else node[key] = value;
  }
  node.type = 'INSTANCE';
  node.componentId = component.id;
  node.name = displayNameIn(nodes, component);
  return node;
}

function sameNode(old: SceneNode, node: Fields): boolean {
  const before = fieldsOf(old);
  let count = 0;
  for (const key in node) {
    const value = node[key];
    if (value === undefined) continue;
    count++;
    const previous = before[key];
    if (previous !== value && !deepEqual(previous, value)) return false;
  }
  let previousCount = 0;
  for (const key in before) if (before[key] !== undefined) previousCount++;
  return count === previousCount;
}

/** Widens `dirty` to the instances that must be rebuilt and rebuilds them inside the draft. `origin`
 *  says how the draft's table differs from one whose instance index may be cached. Costs what
 *  `dirty` reaches: ancestors of each id, and the instance index only when a component or an
 *  instance is among them. */
export function syncDraft(draft: DocumentDraft, dirty: ReadonlySet<NodeId>, origin?: TableOrigin): void {
  if (!dirty.size) return;
  // The engine switch (lane L2c, shared/design/instances-wasm.ts); normalize's own calls (`origin`) stay TypeScript.
  if (!origin && !engineTs('normalize')) {
    const before = draftSnapshot(draft), changedBefore = new Set(draft.changed);
    withEngine('normalize', 'syncDraft', () => (syncDraftTs(draft, dirty), syncWritesOf(draft, changedBefore)), () => syncDraftWasm(draft, before, dirty), {equal: sameSyncWrites(draft, before), inputs: () => [...dirty]});
    return;
  }
  syncDraftTs(draft, dirty, origin);
}

function syncDraftTs(draft: DocumentDraft, dirty: ReadonlySet<NodeId>, origin?: TableOrigin): void {
  try {
    syncDirty(draft, dirty, origin);
  } finally {
    // The index may have been built from the table this run then wrote copies into.
    if (draft.ownsTable) forgetTable(draft.nodes);
  }
}

function syncDirty(draft: DocumentDraft, dirty: ReadonlySet<NodeId>, origin?: TableOrigin): void {
  const sets = new Set<NodeId>();
  for (const id of dirty) {
    const node = draft.get(id);
    if (node?.type === 'COMPONENT_SET') sets.add(id);
    else if (node?.type === 'COMPONENT' && draft.get(node.parentId)?.type === 'COMPONENT_SET') sets.add(node.parentId!);
  }
  for (const setId of sets) refreshVariantDefinitionsIn(draft, setId);

  const run = new SyncRun(draft);
  const affected = new Set<NodeId>();
  const queue: NodeId[] = [];
  const markComponent = (id: NodeId | null) => {
    if (id && !affected.has(id)) { affected.add(id); queue.push(id); }
  };
  const markInstance = (id: NodeId) => {
    const root = rootInstanceIn(draft.nodes, id);
    if (!root || run.pending.has(root)) return;
    run.pending.add(root);
    markComponent(nearestComponentIn(draft.nodes, root));
  };
  for (const id of dirty) {
    const node = draft.get(id);
    if (!node) continue;
    if (node.type === 'COMPONENT_SET') {
      for (const child of node.children ?? []) if (draft.get(child)?.type === 'COMPONENT') markComponent(child);
      continue;
    }
    if (node.type === 'INSTANCE' || node.mainId !== undefined) markInstance(id);
    markComponent(nearestComponentIn(draft.nodes, id));
  }
  if (affected.size) {
    // The draft's own writes so far (variant definitions) are part of how its table differs.
    const index = instanceIndex(draft.nodes, draft.ownsTable && origin ? {nodes: origin.nodes, changed: [...origin.changed, ...draft.changed]} : undefined);
    while (queue.length) {
      const componentId = queue.pop()!;
      for (const instance of index.byComponent.get(componentId) ?? []) markInstance(instance);
    }
  }
  run.run();
}

/** Like `syncInstances`, also returning the ids it created, changed or removed and the former parents
 *  of the removed ones (normalize passes them on to `applyVariables`, the text pass and layout).
 *  `owned`: `doc.nodes` is the caller's private working table, written in place. `origin`: how that
 *  table differs from one whose instance index may be cached. */
export function syncInstancesDetailed(doc: DesignDocument, dirty: ReadonlySet<NodeId>, options: {owned?: boolean; origin?: TableOrigin; log?: TableLog} = {}): DesignEdit & {formerParents: ReadonlySet<NodeId>} {
  const draft = new DocumentDraft(doc, {owned: options.owned, log: options.log});
  // normalize.ts always passes `{owned, origin}`: its calls stay TypeScript (normalize flips as a whole).
  if (options.owned !== undefined || options.origin !== undefined) {
    if (dirty.size) syncDraftTs(draft, dirty, options.origin);
  } else syncDraft(draft, dirty, options.origin);
  return {doc: draft.finish(), changed: draft.changed, formerParents: draft.formerParents};
}

/** Re-materialises every instance whose main component (or anything inside it, or a component nested in
 *  it) is in `dirty`, and every instance that is itself dirty or has a dirty copy, keeping each copy's
 *  overrides: missing copies are created, copies whose main node is gone are removed, children follow the
 *  main's order, and a resized instance lays its children out by their constraints (auto-layout instances
 *  are re-laid-out by the normalize pass that follows). Removed ids in `dirty` are expected to come with
 *  their former parent. Returns `doc` itself when nothing changed. */
export function syncInstances(doc: DesignDocument, dirty: ReadonlySet<NodeId>): DesignDocument {
  return syncInstancesDetailed(doc, dirty).doc;
}

// ── Cycles ─────────────────────────────────────────────────────────────────────────────────────

const usesCache = tableCache<Map<NodeId, Set<NodeId>>>();

/** Components a component's subtree shows instances of (directly; nested copies included). */
function usesOf(nodes: Nodes, componentId: NodeId): Set<NodeId> {
  let cache = usesCache.get(nodes);
  if (!cache) usesCache.set(nodes, cache = new Map());
  let uses = cache.get(componentId);
  if (uses) return uses;
  uses = new Set();
  const root = nodes[componentId];
  if (root?.type === 'COMPONENT_SET') for (const id of root.children ?? []) uses.add(id);
  const stack = [...(root?.children ?? [])];
  while (stack.length) {
    const node = nodes[stack.pop()!];
    if (!node) continue;
    if (node.type === 'INSTANCE' && node.componentId) uses.add(node.componentId);
    if (node.children) stack.push(...node.children);
  }
  cache.set(componentId, uses);
  return uses;
}

/** Whether an instance of `componentId` under `targetParentId` would make a component contain itself,
 *  directly or through other components. */
export function wouldCreateCycle(doc: DesignDocument, componentId: NodeId, targetParentId: NodeId): boolean {
  const nodes = doc.nodes;
  const containers = new Set<NodeId>();
  for (let node = nodes[targetParentId], guard = 0; node && guard < 10_000; node = node.parentId ? nodes[node.parentId] : (undefined as never), guard++) {
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') containers.add(node.id);
  }
  if (!containers.size) return false;
  const seen = new Set<NodeId>();
  const stack = [componentId];
  while (stack.length) {
    const id = stack.pop()!;
    if (containers.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const used of usesOf(nodes, id)) stack.push(used);
  }
  return false;
}

/** Why moving `ids` into `targetParentId` is not allowed, or null: into an instance, a component (or set)
 *  into a component, a non-component into a set, or a component into its own instance chain. */
export function moveViolation(doc: DesignDocument, ids: readonly NodeId[], targetParentId: NodeId): ComponentErrorCode | null {
  const nodes = doc.nodes;
  const target = nodes[targetParentId];
  if (!target?.children) return 'not_container';
  if (target.type === 'INSTANCE' || target.mainId !== undefined) return 'inside_instance';
  const intoComponent = nearestComponentIn(nodes, targetParentId) !== null;
  for (const id of ids) {
    const node = nodes[id];
    if (!node) return 'not_found';
    if (node.mainId !== undefined) return 'inside_instance';
    if (target.type === 'COMPONENT_SET' && node.type !== 'COMPONENT') return 'set_child';
    const stack = [id];
    while (stack.length) {
      const current = nodes[stack.pop()!];
      if (!current) continue;
      if (intoComponent && (current.type === 'COMPONENT' || current.type === 'COMPONENT_SET') && target.type !== 'COMPONENT_SET') return 'nested_component';
      if (current.type === 'INSTANCE' && current.componentId && current.mainId === undefined && wouldCreateCycle(doc, current.componentId, targetParentId)) return 'cycle';
      if (current.type === 'COMPONENT' && wouldCreateCycle(doc, current.id, targetParentId)) return 'cycle';
      if (current.children && current.type !== 'INSTANCE') stack.push(...current.children);
    }
  }
  return null;
}

// ── Main components ────────────────────────────────────────────────────────────────────────────

export type CreateComponentOptions = {
  /** Several selected layers: wrap them all in one component instead of making one each. */
  combine?: boolean;
};

const WRAP_REFUSED = new Set<SceneNode['type']>(['PAGE', 'SECTION', 'COMPONENT_SET']);

function checkComponentSource(nodes: Nodes, id: NodeId): SceneNode {
  const node = nodes[id] ?? fail('not_found');
  if (node.type === 'COMPONENT') return node;
  if (WRAP_REFUSED.has(node.type)) fail('unsupported');
  if (node.mainId !== undefined) fail('inside_instance');
  for (let parent = node.parentId ? nodes[node.parentId] : undefined; parent; parent = parent.parentId ? nodes[parent.parentId] : undefined) {
    if (parent.type === 'COMPONENT' || parent.type === 'COMPONENT_SET') fail('inside_component');
    if (parent.type === 'INSTANCE') fail('inside_instance');
  }
  const stack = [...(node.children ?? [])];
  while (stack.length) {
    const child = nodes[stack.pop()!];
    if (!child) continue;
    if (child.type === 'COMPONENT' || child.type === 'COMPONENT_SET') fail('nested_component');
    if (child.children && child.type !== 'INSTANCE') stack.push(...child.children);
  }
  return node;
}

/** Defined entries only: `createNode` spreads its props, and an explicit undefined would stay as a key. */
function defined<T extends object>(props: T): T {
  const out = {...props} as Fields;
  for (const key in out) if (out[key] === undefined) delete out[key];
  return out as T;
}

/** The fields a new wrapper takes over from the layer(s) it wraps: how they sat in their parent. */
function placementOf(node: SceneNode): Partial<SceneNode> {
  return defined({
    constraints: {...node.constraints},
    layoutPositioning: node.layoutPositioning,
    layoutSizingHorizontal: node.layoutSizingHorizontal === 'FILL' ? 'FILL' as const : 'FIXED' as const,
    layoutSizingVertical: node.layoutSizingVertical === 'FILL' ? 'FILL' as const : 'FIXED' as const,
  });
}

function wrapInComponent(draft: DocumentDraft, members: SceneNode[], id: NodeId, name: string): NodeId {
  const parent = draft.get(members[0].parentId)!;
  const order = parent.children ?? [];
  const sorted = [...members].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const box = unionRects(sorted.map(node => transformRect(localMatrix(node), {x: 0, y: 0, width: node.width, height: node.height})))!;
  const index = Math.max(...sorted.map(node => order.indexOf(node.id)));
  const component = createNode('COMPONENT', defined({
    id, parentId: parent.id, name, x: box.x, y: box.y, width: box.width, height: box.height,
    fills: [], clipsContent: false, children: sorted.map(node => node.id), ...placementOf(sorted[0]),
  }));
  if (sorted.length > 1) component.constraints = {horizontal: 'MIN', vertical: 'MIN'};
  const remaining = order.filter(childId => !sorted.some(node => node.id === childId));
  remaining.splice(index - (sorted.length - 1), 0, id);
  draft.put(component);
  draft.patch(parent.id, {children: remaining});
  for (const node of sorted) {
    draft.patch(node.id, {
      parentId: id, x: node.x - box.x, y: node.y - box.y,
      layoutPositioning: 'AUTO', constraints: {horizontal: 'MIN', vertical: 'MIN'},
      layoutSizingHorizontal: node.layoutSizingHorizontal === 'FILL' ? 'FIXED' : node.layoutSizingHorizontal,
      layoutSizingVertical: node.layoutSizingVertical === 'FILL' ? 'FIXED' : node.layoutSizingVertical,
    });
  }
  return id;
}

/** "Create component". One FRAME converts in place; a GROUP becomes a component frame with the group's
 *  box (its children keep their coordinates, which are already in the group's space); a COMPONENT stays
 *  as it is; any other layer (an instance included) is wrapped in a new COMPONENT. Several layers become
 *  one component each, or with `combine` one component wrapping them all (same parent required).
 *  Components never nest: layers inside a component or an instance are refused. */
export function createComponent(doc: DesignDocument, ids: readonly NodeId[], newId?: IdSource, options: CreateComponentOptions = {}): DesignEdit & {componentIds: NodeId[]} {
  if (!ids.length) fail('empty');
  const nodes = doc.nodes;
  const members = [...new Set(ids)].map(id => checkComponentSource(nodes, id));
  const next = idSource(newId);
  const draft = new DocumentDraft(doc);
  const componentIds: NodeId[] = [];
  if (options.combine && members.length > 1) {
    if (members.some(node => node.parentId !== members[0].parentId)) fail('different_parents');
    if (members.some(node => node.type === 'COMPONENT')) fail('nested_component');
    componentIds.push(wrapInComponent(draft, members, next(), 'Component'));
    return {doc: draft.finish(), changed: draft.changed, componentIds};
  }
  for (const node of members) {
    if (node.type === 'COMPONENT') {
      componentIds.push(node.id);
    } else if (node.type === 'FRAME') {
      draft.put({...node, type: 'COMPONENT', description: node.description ?? '', componentPropertyDefinitions: node.componentPropertyDefinitions ?? {}});
      componentIds.push(node.id);
    } else if (node.type === 'GROUP') {
      draft.put(createNode('COMPONENT', defined({
        id: node.id, parentId: node.parentId, children: node.children, name: node.name,
        x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, flipX: node.flipX, flipY: node.flipY,
        visible: node.visible, locked: node.locked, opacity: node.opacity, blendMode: node.blendMode, isMask: node.isMask, maskType: node.maskType,
        effects: node.effects, effectStyleId: node.effectStyleId, boundVariables: node.boundVariables,
        constraints: node.constraints, layoutPositioning: node.layoutPositioning,
        layoutSizingHorizontal: node.layoutSizingHorizontal, layoutSizingVertical: node.layoutSizingVertical,
        exportSettings: node.exportSettings, reactions: node.reactions, pluginData: node.pluginData,
        fills: [], clipsContent: false,
      })));
      componentIds.push(node.id);
    } else {
      componentIds.push(wrapInComponent(draft, [draft.get(node.id)!], next(), node.name));
    }
  }
  // A frame or group that already had instances placed inside other components is unaffected; nothing to sync.
  return {doc: draft.finish(), changed: draft.changed, componentIds};
}

// ── Instances ──────────────────────────────────────────────────────────────────────────────────

export type CreateInstanceOptions = {
  parentId: NodeId;
  /** Index in the parent's children (bottom-to-top); default on top. */
  index?: number;
  x?: number;
  y?: number;
  /** The instance's id (or a generator). Its copies derive theirs. */
  newId?: IdSource;
};

/** Places an instance of a component (a set gives its default variant) and materialises its copies. */
export function createInstance(doc: DesignDocument, componentId: NodeId, options: CreateInstanceOptions): DesignEdit & {id: NodeId} {
  const nodes = doc.nodes;
  const component = resolveComponentIn(nodes, componentId) ?? fail('not_component');
  const parent = nodes[options.parentId];
  if (!parent?.children) fail('not_container');
  if (parent!.type === 'INSTANCE' || parent!.mainId !== undefined) fail('inside_instance');
  if (parent!.type === 'COMPONENT_SET') fail('set_child');
  if (wouldCreateCycle(doc, component.id, parent!.id)) fail('cycle');
  const id = idSource(options.newId)();
  const draft = new DocumentDraft(doc);
  draft.put(createNode('INSTANCE', {
    id, parentId: parent!.id, name: displayNameIn(nodes, component), componentId: component.id,
    x: options.x ?? 0, y: options.y ?? 0, width: component.width, height: component.height,
    constraints: {...component.constraints},
  }));
  insertChild(draft, parent!.id, id, options.index);
  syncDraft(draft, new Set([id]));
  return {doc: draft.finish(), changed: draft.changed, id};
}

function flattenCopyOverrides(nodes: Nodes, copy: SceneNode, stopAt: NodeId): string[] | undefined {
  const out = new Set(copy.overrides ?? []);
  let mirror = copy.mainId ? nodes[copy.mainId] : undefined;
  for (let guard = 0; mirror && mirror.id !== stopAt && guard < 64; guard++) {
    for (const entry of mirror.overrides ?? []) out.add(entry);
    mirror = mirror.mainId ? nodes[mirror.mainId] : undefined;
  }
  return out.size ? [...out] : undefined;
}

/** The overrides a nested instance has relative to its own component: its own plus those of the nested
 *  instances it mirrors while they show the same component, plus a size that differs from the main's. */
function flattenRootOverrides(nodes: Nodes, instance: SceneNode): string[] | undefined {
  let out: readonly string[] = instance.overrides ?? [];
  let mirror = instance.mainId ? nodes[instance.mainId] : undefined;
  for (let guard = 0; mirror?.type === 'INSTANCE' && mirror.componentId === instance.componentId && guard < 64; guard++) {
    out = addOverridePaths(out, mirror.overrides ?? []);
    mirror = mirror.mainId ? nodes[mirror.mainId] : undefined;
  }
  const component = componentIn(nodes, instance.componentId);
  if (component && component.width !== instance.width) out = addOverridePaths(out, ['width']);
  if (component && component.height !== instance.height) out = addOverridePaths(out, ['height']);
  const list = out.filter(entry => entry !== 'componentId');
  return list.length ? list : undefined;
}

/** "Detach instance": the INSTANCE becomes a FRAME and its copies ordinary layers with fresh ids;
 *  nested instances stay instances (of their components, keeping their overrides) with their copies
 *  re-keyed under them. Returns old → new ids so the selection can follow. */
export function detachInstance(doc: DesignDocument, id: NodeId, newId: () => NodeId = randomId): DesignEdit & {ids: Map<NodeId, NodeId>} {
  const nodes = doc.nodes;
  const instance = nodes[id];
  if (instance?.type !== 'INSTANCE') fail('not_instance');
  if (instance!.mainId !== undefined) fail('nested_instance');
  const draft = new DocumentDraft(doc);
  const ids = new Map<NodeId, NodeId>();
  const moveModes = (from: NodeId, to: NodeId) => {
    const modes = draft.modesOf(from);
    if (modes) draft.setModes(to, modes);
  };

  const rekeyNested = (nested: SceneNode, parentId: NodeId): NodeId => {
    const fresh = newId();
    const mapId = (oldId: NodeId) => (oldId === nested.id ? fresh : oldId.startsWith(nested.id + ';') ? fresh + oldId.slice(nested.id.length) : `${fresh};${nodes[oldId]?.mainId ?? oldId}`);
    const visit = (node: SceneNode, newParent: NodeId) => {
      const nodeId = mapId(node.id);
      ids.set(node.id, nodeId);
      const copy: SceneNode = {...node, id: nodeId, parentId: newParent};
      if (node.id === nested.id) {
        delete copy.mainId;
        delete copy.componentPropertyReferences;
        const overrides = flattenRootOverrides(nodes, node);
        if (overrides) copy.overrides = overrides;
        else delete copy.overrides;
      } else {
        const tail = node.id.startsWith(nested.id + ';') ? node.id.slice(nested.id.length + 1) : node.mainId!;
        copy.mainId = tail;
        const overrides = flattenCopyOverrides(nodes, node, tail);
        if (overrides) copy.overrides = overrides;
        else delete copy.overrides;
      }
      if (node.children) copy.children = node.children.map(childId => mapId(childId));
      draft.delete(node.id);
      draft.put(copy);
      moveModes(node.id, nodeId);
      for (const childId of node.children ?? []) {
        const child = nodes[childId];
        if (child) visit(child, nodeId);
      }
    };
    visit(nested, parentId);
    return fresh;
  };

  const convert = (oldId: NodeId, parentId: NodeId): NodeId | null => {
    const node = nodes[oldId];
    if (!node) return null;
    if (node.type === 'INSTANCE') return rekeyNested(node, parentId);
    const fresh = newId();
    ids.set(oldId, fresh);
    const copy: SceneNode = {...node, id: fresh, parentId};
    delete copy.mainId;
    delete copy.overrides;
    delete copy.componentPropertyReferences;
    if (node.children) copy.children = node.children.map(childId => convert(childId, fresh)).filter((childId): childId is NodeId => childId !== null);
    draft.delete(oldId);
    draft.put(copy);
    moveModes(oldId, fresh);
    return fresh;
  };

  const frame: SceneNode = {...instance!, type: 'FRAME'};
  delete frame.componentId;
  delete frame.componentProperties;
  delete frame.overrides;
  frame.children = (instance!.children ?? []).map(childId => convert(childId, id)).filter((childId): childId is NodeId => childId !== null);
  draft.put(frame);
  // Instances of a component this one was placed in now show a frame there.
  syncDraft(draft, new Set([id]));
  return {doc: draft.finish(), changed: draft.changed, ids};
}

/** "Reset all changes". Without `fields` on an instance: every override of the instance and its copies
 *  (Figma's "Reset all changes"); without `fields` on a copy: all of that copy's; with `fields`: those
 *  fields (and their parts, e.g. `text` resets `text.characters`) on that node. */
export function resetOverrides(doc: DesignDocument, id: NodeId, fields?: readonly string[]): DesignEdit {
  const node = doc.nodes[id];
  if (!node || (node.type !== 'INSTANCE' && node.mainId === undefined)) fail('not_instance');
  const draft = new DocumentDraft(doc);
  if (!fields && node!.type === 'INSTANCE') {
    const stack = [id];
    while (stack.length) {
      const current = draft.get(stack.pop()!);
      if (!current) continue;
      if (current.overrides) draft.patch(current.id, {overrides: undefined});
      if (current.children) stack.push(...current.children);
    }
  } else {
    const overrides = fields ? removeOverridePaths(node!.overrides, fields) : undefined;
    if (!deepEqual(overrides, node!.overrides)) draft.patch(id, {overrides});
  }
  syncDraft(draft, new Set([rootInstanceIn(doc.nodes, id) ?? id]));
  return {doc: draft.finish(), changed: draft.changed};
}

/** "Swap instance": the instance shows another component (a set gives its default variant). Its own
 *  overrides stay; overrides of copies move to layers with the same name and place in the hierarchy;
 *  property values move to same-named properties. A nested instance records the swap as an override. */
export function swapInstance(doc: DesignDocument, id: NodeId, newComponentId: NodeId): DesignEdit {
  const nodes = doc.nodes;
  const node = nodes[id];
  if (node?.type !== 'INSTANCE') fail('not_instance');
  const target = resolveComponentIn(nodes, newComponentId) ?? fail('not_component');
  if (node!.parentId && wouldCreateCycle(doc, target.id, node!.parentId)) fail('cycle');
  const draft = new DocumentDraft(doc);
  if (node!.mainId === undefined) {
    if (node!.componentId !== target.id) draft.patch(id, {componentId: target.id});
  } else {
    // The component the copy would show without an override: property-driven, else its mirror's.
    const mirror = nodes[node!.mainId];
    let linked = mirror?.componentId;
    const ref = mirror?.componentPropertyReferences?.mainComponent;
    const ownerId = ref !== undefined ? nearestInstanceAbove(nodes, id) : null;
    const value = ownerId ? nodes[ownerId]?.componentProperties?.[ref!] : undefined;
    if (typeof value === 'string' && componentIn(nodes, value)) linked = value;
    const overrides = target.id === linked ? removeOverridePaths(node!.overrides, ['componentId']) : [...addOverridePaths(node!.overrides ?? [], ['componentId'])];
    draft.patch(id, {componentId: target.id, overrides});
  }
  syncDraft(draft, new Set([rootInstanceIn(nodes, id) ?? id]));
  return {doc: draft.finish(), changed: draft.changed};
}

function nearestInstanceAbove(nodes: Nodes, id: NodeId): NodeId | null {
  for (let node = nodes[nodes[id]?.parentId ?? ''], guard = 0; node && guard < 10_000; node = node.parentId ? nodes[node.parentId] : (undefined as never), guard++) {
    if (node.type === 'INSTANCE') return node.id;
  }
  return null;
}

/** "Go to main component": an instance's component, or for a layer inside an instance the layer
 *  of the main component it ultimately mirrors. Null when that node no longer exists. */
export function goToMainComponent(doc: DesignDocument, id: NodeId): NodeId | null {
  const node = doc.nodes[id];
  if (!node) return null;
  if (node.type === 'INSTANCE') return node.componentId && doc.nodes[node.componentId] ? node.componentId : null;
  let mirror = node;
  for (let guard = 0; mirror.mainId !== undefined && guard < 64; guard++) {
    const next = doc.nodes[mirror.mainId];
    if (!next) return null;
    mirror = next;
  }
  return mirror.id === id ? null : mirror.id;
}

/** Fields of a top-level instance that "Push changes" never writes into the main. */
const NOT_PUSHED = new Set([...ROOT_UNTRACKED, 'name']);

/** Writes the overridden parts of `source` into `target`; when the target is itself a copy (inside a
 *  nested instance of the main) the parts become its overrides. Returns the partial. */
function pushedFields(source: SceneNode, target: SceneNode, paths: readonly string[]): Partial<SceneNode> {
  const parsed = parseOverrides(paths);
  const partial: Fields = {};
  const from = fieldsOf(source), to = fieldsOf(target);
  for (const [head, keys] of parsed) {
    if (head === 'componentProperties' || head === 'componentId') continue;
    if (keys === true) partial[head] = from[head];
    else partial[head] = mergeGranular(head, to[head], from[head], keys);
  }
  if (partial.text) partial.text = sanitizeText(partial.text as TextProps);
  return partial as Partial<SceneNode>;
}

/** "Push changes to main component": the instance's overrides become the main's values (or,
 *  for copies of nested instances, overrides of the main's nested instance), the instance is left without
 *  overrides, and every other instance follows where it did not override the same fields. */
export function pushOverridesToMain(doc: DesignDocument, instanceId: NodeId): DesignEdit {
  const instance = doc.nodes[instanceId];
  if (instance?.type !== 'INSTANCE') fail('not_instance');
  if (instance!.mainId !== undefined) fail('nested_instance');
  const component = componentIn(doc.nodes, instance!.componentId) ?? fail('not_component');
  // A library's component is read-only in the files that use it (docs/design-tool.md §Teams, shared libraries).
  if (component.remote || setOfIn(doc.nodes, component)?.remote) fail('remote_component');
  const draft = new DocumentDraft(doc);
  const mainDirty = new Set<NodeId>();

  const writeToMain = (target: SceneNode, partial: Partial<SceneNode>, paths: readonly string[]) => {
    if (!Object.keys(partial).length) return;
    const update: Partial<SceneNode> = {...partial};
    if (target.mainId !== undefined) update.overrides = [...addOverridePaths(target.overrides ?? [], paths)];
    draft.patch(target.id, update);
    mainDirty.add(target.id);
  };

  // 1. Swaps and property values of nested instances first, outermost first: the main's nested instance
  //    then shows the same component, and the copies below map onto its copies.
  const queue = [...(instance!.children ?? [])];
  let swapped = false;
  while (queue.length) {
    const node = draft.get(queue.shift()!);
    if (!node) continue;
    if (node.children) queue.push(...node.children);
    if (node.type !== 'INSTANCE' || !node.overrides?.length) continue;
    const mirror = draft.get(node.mainId);
    if (!mirror) continue;
    const pushed = node.overrides.filter(entry => entry === 'componentId' || entry.startsWith('componentProperties.'));
    if (!pushed.length) continue;
    const partial: Partial<SceneNode> = {};
    if (pushed.includes('componentId')) partial.componentId = node.componentId;
    const keys = pushed.filter(entry => entry !== 'componentId').map(entry => entry.slice('componentProperties.'.length));
    if (keys.length) {
      const values = {...(mirror.componentProperties ?? {})};
      for (const key of keys) if (node.componentProperties && key in node.componentProperties) values[key] = node.componentProperties[key];
      partial.componentProperties = values;
    }
    const update: Partial<SceneNode> = {...partial};
    if (mirror.mainId !== undefined) update.overrides = [...addOverridePaths(mirror.overrides ?? [], pushed)];
    else if (keys.length) update.overrides = [...addOverridePaths(mirror.overrides ?? [], keys.map(key => `componentProperties.${key}`))];
    draft.patch(mirror.id, update);
    draft.patch(node.id, {overrides: removeOverridePaths(node.overrides, pushed)});
    mainDirty.add(mirror.id);
    swapped = true;
  }
  if (swapped) syncDraft(draft, new Set(mainDirty));

  // 2. Field overrides of the instance and its copies.
  const root = draft.get(instanceId)!;
  const rootPaths = (root.overrides ?? []).filter(entry => !NOT_PUSHED.has(entry.split('.')[0]) && !entry.startsWith('componentProperties.'));
  if (rootPaths.length) {
    const main = draft.get(component.id)!;
    const partial = pushedFields(root, main, rootPaths);
    const {width, height, ...rest} = partial;
    writeToMain(main, rest, rootPaths);
    if (width !== undefined || height !== undefined) {
      const resized = draft.get(component.id)!;
      const box = {x: resized.x, y: resized.y, width: width ?? resized.width, height: height ?? resized.height};
      for (const [nodeId, update] of resizeUpdates(draft.finish(), component.id, box)) {
        draft.patch(nodeId, update);
        mainDirty.add(nodeId);
      }
    }
    draft.patch(instanceId, {overrides: removeOverridePaths(root.overrides, rootPaths)});
  }
  const stack = [...(root.children ?? [])];
  while (stack.length) {
    const node = draft.get(stack.pop()!);
    if (!node) continue;
    if (node.children) stack.push(...node.children);
    const paths = (node.overrides ?? []).filter(entry => entry !== 'componentId' && !entry.startsWith('componentProperties.'));
    if (!paths.length) continue;
    const target = draft.get(node.mainId);
    if (!target) continue;
    writeToMain(target, pushedFields(node, target, paths), paths);
    updateBoundDefaults(draft, target, paths, mainDirty);
    draft.patch(node.id, {overrides: removeOverridePaths(node.overrides, paths)});
  }
  mainDirty.add(instanceId);
  syncDraft(draft, mainDirty);
  return {doc: draft.finish(), changed: draft.changed};
}

/** A pushed value of a layer bound to a property of the main becomes that property's default. */
function updateBoundDefaults(draft: DocumentDraft, target: SceneNode, paths: readonly string[], dirty: Set<NodeId>): void {
  if (target.mainId !== undefined || !target.componentPropertyReferences) return;
  const componentId = nearestComponentIn(draft.nodes, target.parentId);
  const component = componentId ? draft.get(componentId) : undefined;
  if (!component) return;
  const owner = setOfIn(draft.nodes, component) ?? component;
  const refs = target.componentPropertyReferences;
  const current = draft.get(target.id)!;
  const defs = {...(owner.componentPropertyDefinitions ?? {})};
  let changed = false;
  if (refs.visible && paths.includes('visible') && defs[refs.visible]) { defs[refs.visible] = {...defs[refs.visible], defaultValue: current.visible}; changed = true; }
  if (refs.characters && current.text && paths.some(path => path === 'text' || path === 'text.characters') && defs[refs.characters]) {
    defs[refs.characters] = {...defs[refs.characters], defaultValue: current.text.characters};
    changed = true;
  }
  if (changed) {
    draft.patch(owner.id, {componentPropertyDefinitions: defs});
    dirty.add(owner.id);
  }
}

// ── Component properties ───────────────────────────────────────────────────────────────────────

/** The node that holds a component's property definitions: its set for a variant, else itself. */
function propertyOwnerIn(nodes: Nodes, id: NodeId): SceneNode {
  const node = nodes[id];
  if (node?.type === 'COMPONENT_SET') return node.remote ? fail('remote_component') : node;
  if (node?.type !== 'COMPONENT') fail('not_component');
  const owner = setOfIn(nodes, node!) ?? node!;
  if (owner.remote) fail('remote_component');
  return owner;
}

/** Components whose instances carry the owner's properties. */
function componentsOfOwner(nodes: Nodes, owner: SceneNode): NodeId[] {
  return owner.type === 'COMPONENT_SET' ? (owner.children ?? []).filter(id => nodes[id]?.type === 'COMPONENT') : [owner.id];
}

const suffixOf = (key: string) => {
  const hash = key.lastIndexOf('#');
  return hash > 0 ? key.slice(hash + 1) : '';
};

function nextPropertyKey(nodes: Nodes, owner: SceneNode, name: string): string {
  let max = 0;
  const scan = (defs: Record<string, ComponentPropertyDefinition> | undefined) => {
    for (const key of Object.keys(defs ?? {})) {
      const n = Number(suffixOf(key));
      if (Number.isInteger(n) && n > max) max = n;
    }
  };
  scan(owner.componentPropertyDefinitions);
  if (owner.type === 'COMPONENT_SET') for (const id of owner.children ?? []) scan(nodes[id]?.componentPropertyDefinitions);
  return `${name}#${max + 1}`;
}

function checkPropertyName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes(',') || trimmed.includes('=')) fail('invalid_name');
  return trimmed;
}

function checkDefault(nodes: Nodes, type: ComponentPropertyDefinition['type'], value: unknown): string | boolean {
  if (type === 'BOOLEAN' && typeof value === 'boolean') return value;
  if (type === 'TEXT' && typeof value === 'string') return value;
  if (type === 'INSTANCE_SWAP' && typeof value === 'string' && resolveComponentIn(nodes, value)) return resolveComponentIn(nodes, value)!.id;
  if (type === 'VARIANT' && typeof value === 'string') return value;
  return fail('wrong_type');
}

export type NewComponentProperty = {name: string; type: 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP'; defaultValue: string | boolean; preferredValues?: NodeId[]};

/** "Component properties" → "+": a BOOLEAN, TEXT or INSTANCE_SWAP property with a unique key "Name#n".
 *  A variant's properties live on its set, shared by every variant (variant properties: variants.ts). */
export function addComponentProperty(doc: DesignDocument, componentId: NodeId, property: NewComponentProperty): DesignEdit & {key: string} {
  const nodes = doc.nodes;
  const owner = propertyOwnerIn(nodes, componentId);
  if ((property.type as string) === 'VARIANT') fail('unsupported');
  const name = checkPropertyName(property.name);
  const defs = definitionsIn(nodes, owner);
  if (Object.keys(defs).some(key => propertyName(key) === name)) fail('duplicate_property');
  const defaultValue = checkDefault(nodes, property.type, property.defaultValue);
  const key = nextPropertyKey(nodes, owner, name);
  const def: ComponentPropertyDefinition = {type: property.type, defaultValue};
  if (property.preferredValues?.length) def.preferredValues = [...property.preferredValues];
  const draft = new DocumentDraft(doc);
  draft.patch(owner.id, {componentPropertyDefinitions: {...(owner.componentPropertyDefinitions ?? {}), [key]: def}});
  syncDraft(draft, new Set(componentsOfOwner(nodes, owner)));
  return {doc: draft.finish(), changed: draft.changed, key};
}

export type BindableProperty = keyof ComponentPropertyReferences;
const FIELD_TYPES: Record<BindableProperty, ComponentPropertyDefinition['type']> = {visible: 'BOOLEAN', characters: 'TEXT', mainComponent: 'INSTANCE_SWAP'};

/** The node field a property drives, set to the property's value. */
function drivenFields(nodes: Nodes, node: SceneNode, field: BindableProperty, value: string | boolean): Partial<SceneNode> | null {
  if (field === 'visible' && typeof value === 'boolean') return node.visible === value ? null : {visible: value};
  if (field === 'characters' && typeof value === 'string' && node.text) return node.text.characters === value ? null : {text: withCharacters(node.text, value)};
  if (field === 'mainComponent' && typeof value === 'string' && componentIn(nodes, value) && node.componentId !== value) return {componentId: value};
  return null;
}

/** Binds a layer inside a main component to one of its properties (`key`), or unbinds it (null):
 *  visible ↔ BOOLEAN, characters (TEXT layers) ↔ TEXT, mainComponent (nested instances) ↔ INSTANCE_SWAP.
 *  The layer takes the property's default value, as the main always shows defaults. */
export function bindProperty(doc: DesignDocument, nodeId: NodeId, field: BindableProperty, key: string | null): DesignEdit {
  const nodes = doc.nodes;
  const node = nodes[nodeId] ?? fail('not_found');
  if (node.mainId !== undefined) fail('inside_instance');
  const componentId = nearestComponentIn(nodes, node.parentId) ?? fail('not_component');
  const draft = new DocumentDraft(doc);
  const refs: ComponentPropertyReferences = {...(node.componentPropertyReferences ?? {})};
  if (key === null) {
    delete refs[field];
    draft.patch(nodeId, {componentPropertyReferences: Object.keys(refs).length ? refs : undefined});
  } else {
    const def = definitionsIn(nodes, nodes[componentId]!)[key] ?? fail('unknown_property');
    if (def.type !== FIELD_TYPES[field] || (field === 'characters' && node.type !== 'TEXT') || (field === 'mainComponent' && node.type !== 'INSTANCE')) fail('wrong_type');
    if (field === 'mainComponent' && typeof def.defaultValue === 'string' && wouldCreateCycle(doc, def.defaultValue, node.parentId!)) fail('cycle');
    refs[field] = key;
    draft.patch(nodeId, {componentPropertyReferences: refs, ...(drivenFields(nodes, node, field, def.defaultValue) ?? {})});
  }
  syncDraft(draft, new Set([nodeId]));
  return {doc: draft.finish(), changed: draft.changed};
}

/** The value an instance (or nested copy) shows for `key` when it does not override it. */
function inheritedValue(nodes: Nodes, node: SceneNode, key: string, def: ComponentPropertyDefinition): string | boolean {
  const mirror = node.mainId ? nodes[node.mainId] : undefined;
  if (mirror?.type === 'INSTANCE' && mirror.componentId === node.componentId) {
    const value = mirror.componentProperties?.[key];
    if (value !== undefined && validPropertyValue(def, value)) return value;
  }
  return def.defaultValue;
}

/** Sets a property value on an instance or a nested instance (the properties panel). A variant property
 *  switches to the matching variant (variants.ts `setVariantProperty`). Copies driven by the property lose
 *  their own override of that field, so the value shows. */
export function setInstanceProperty(doc: DesignDocument, instanceId: NodeId, key: string, value: string | boolean): DesignEdit {
  const nodes = doc.nodes;
  const node = nodes[instanceId];
  if (node?.type !== 'INSTANCE') fail('not_instance');
  const component = componentIn(nodes, node!.componentId) ?? fail('not_component');
  const def = definitionsIn(nodes, component)[key] ?? fail('unknown_property');
  if (def.type === 'VARIANT') {
    if (typeof value !== 'string') fail('wrong_type');
    const set = setOfIn(nodes, component) ?? fail('not_variant');
    const target = findVariantIn(nodes, set, {...variantValuesIn(nodes, component), [key]: value as string}, key) ?? fail('no_variant');
    return target.id === component.id ? {doc, changed: new Set()} : swapInstance(doc, instanceId, target.id);
  }
  let stored: string | boolean = value;
  if (def.type === 'INSTANCE_SWAP') {
    const target = typeof value === 'string' ? resolveComponentIn(nodes, value) : undefined;
    if (!target) fail('wrong_type');
    if (wouldCreateCycle(doc, target!.id, instanceId)) fail('cycle');
    stored = target!.id;
  } else if (!validPropertyValue(def, value)) fail('wrong_type');

  const draft = new DocumentDraft(doc);
  const path = `componentProperties.${key}`;
  const inherited = inheritedValue(nodes, node!, key, def);
  const overrides = stored === inherited ? removeOverridePaths(node!.overrides, [path]) : [...addOverridePaths(node!.overrides ?? [], [path])];
  draft.patch(instanceId, {componentProperties: {...(node!.componentProperties ?? {}), [key]: stored}, overrides});
  // Copies this instance's properties drive: their own value of the driven field gives way.
  const stack = [...(node!.children ?? [])];
  while (stack.length) {
    const copy = nodes[stack.pop()!];
    if (!copy) continue;
    if (copy.children && copy.type !== 'INSTANCE') stack.push(...copy.children);
    const refs = copy.componentPropertyReferences;
    if (!refs || !copy.overrides) continue;
    const fields: string[] = [];
    if (refs.visible === key) fields.push('visible');
    if (refs.characters === key) fields.push('text.characters', 'text.runs');
    if (refs.mainComponent === key) fields.push('componentId');
    if (!fields.length) continue;
    const next = removeOverridePaths(copy.overrides, fields);
    if (!deepEqual(next, copy.overrides)) draft.patch(copy.id, {overrides: next});
  }
  syncDraft(draft, new Set([rootInstanceIn(nodes, instanceId) ?? instanceId]));
  return {doc: draft.finish(), changed: draft.changed};
}

/** Nodes of an owner's components (not inside their instances) whose references use `key`. */
function referencingNodes(nodes: Nodes, owner: SceneNode, key: string): SceneNode[] {
  const out: SceneNode[] = [];
  const stack = componentsOfOwner(nodes, owner).flatMap(id => nodes[id]?.children ?? []);
  while (stack.length) {
    const node = nodes[stack.pop()!];
    if (!node) continue;
    const refs = node.componentPropertyReferences;
    if (refs && (refs.visible === key || refs.characters === key || refs.mainComponent === key)) out.push(node);
    if (node.children && node.type !== 'INSTANCE') stack.push(...node.children);
  }
  return out;
}

/** Renames a property key on every instance (values and override entries) of the owner's components. */
function renameOnInstances(draft: DocumentDraft, owner: SceneNode, from: string, to: string | null): void {
  const index = instanceIndex(draft.nodes);
  for (const componentId of componentsOfOwner(draft.nodes, owner)) {
    for (const id of index.byComponent.get(componentId) ?? []) {
      const node = draft.get(id);
      if (!node) continue;
      const hasValue = node.componentProperties && from in node.componentProperties;
      const entry = `componentProperties.${from}`;
      const hasOverride = node.overrides?.includes(entry);
      if (!hasValue && !hasOverride) continue;
      const values = {...(node.componentProperties ?? {})};
      const value = values[from];
      delete values[from];
      if (to !== null && value !== undefined) values[to] = value;
      let overrides = node.overrides?.filter(item => item !== entry);
      if (to !== null && hasOverride) overrides = [...(overrides ?? []), `componentProperties.${to}`];
      draft.patch(id, {componentProperties: values, overrides: overrides?.length ? overrides : undefined});
    }
  }
}

export type PropertyChanges = {name?: string; defaultValue?: string | boolean; preferredValues?: NodeId[]};

/** Edits a property of a component or set (`ownerId`): a new name keeps the key's suffix and is renamed on
 *  every reference and instance; a new default is shown by the main and by instances that did not
 *  override it. Variant properties are renamed through variants.ts. */
export function editProperty(doc: DesignDocument, ownerId: NodeId, key: string, changes: PropertyChanges): DesignEdit & {key: string} {
  const nodes = doc.nodes;
  const owner = propertyOwnerIn(nodes, ownerId);
  const defs = owner.componentPropertyDefinitions ?? {};
  const def = defs[key] ?? fail('unknown_property');
  const draft = new DocumentDraft(doc);
  const dirty = new Set<NodeId>(componentsOfOwner(nodes, owner));
  let nextKey = key;
  let nextDef: ComponentPropertyDefinition = {...def};
  if (changes.name !== undefined) {
    const name = checkPropertyName(changes.name);
    if (name !== propertyName(key)) {
      if (Object.keys(definitionsIn(nodes, owner)).some(other => other !== key && propertyName(other) === name)) fail('duplicate_property');
      if (def.type === 'VARIANT') {
        renameVariantPropertyIn(draft, owner, key, name);
        nextKey = name;
      } else {
        nextKey = suffixOf(key) ? `${name}#${suffixOf(key)}` : nextPropertyKey(nodes, owner, name);
        for (const node of referencingNodes(nodes, owner, key)) {
          const refs = {...node.componentPropertyReferences};
          for (const field of Object.keys(refs) as BindableProperty[]) if (refs[field] === key) refs[field] = nextKey;
          draft.patch(node.id, {componentPropertyReferences: refs});
          dirty.add(node.id);
        }
        renameOnInstances(draft, owner, key, nextKey);
      }
    }
  }
  if (changes.defaultValue !== undefined) {
    if (def.type === 'VARIANT') fail('unsupported');
    nextDef.defaultValue = checkDefault(nodes, def.type, changes.defaultValue);
    for (const node of referencingNodes(nodes, owner, key)) {
      const refs = node.componentPropertyReferences!;
      for (const field of Object.keys(refs) as BindableProperty[]) {
        if (refs[field] !== key) continue;
        const partial = drivenFields(nodes, draft.get(node.id)!, field, nextDef.defaultValue);
        if (partial) { draft.patch(node.id, partial); dirty.add(node.id); }
      }
    }
  }
  if (changes.preferredValues !== undefined) {
    if (changes.preferredValues.length) nextDef.preferredValues = [...changes.preferredValues];
    else delete nextDef.preferredValues;
  }
  const current = draft.get(owner.id)!.componentPropertyDefinitions ?? {};
  const rebuilt: Record<string, ComponentPropertyDefinition> = {};
  for (const [existing, value] of Object.entries(current)) {
    if (existing === key || existing === nextKey) rebuilt[nextKey] = def.type === 'VARIANT' ? {...value, ...(nextDef.preferredValues ? {preferredValues: nextDef.preferredValues} : {})} : nextDef;
    else rebuilt[existing] = value;
  }
  draft.patch(owner.id, {componentPropertyDefinitions: rebuilt});
  dirty.add(owner.id);
  syncDraft(draft, dirty);
  return {doc: draft.finish(), changed: draft.changed, key: nextKey};
}

/** Removes a property: references to it are unbound (layers keep their current values), instances drop its
 *  value and override. A variant property is also removed from every variant's name. */
export function deleteProperty(doc: DesignDocument, ownerId: NodeId, key: string): DesignEdit {
  const nodes = doc.nodes;
  const owner = propertyOwnerIn(nodes, ownerId);
  const defs = owner.componentPropertyDefinitions ?? {};
  const def = defs[key] ?? fail('unknown_property');
  const draft = new DocumentDraft(doc);
  const dirty = new Set<NodeId>([owner.id, ...componentsOfOwner(nodes, owner)]);
  if (def.type === 'VARIANT') {
    rewriteVariantNames(draft, owner.id, values => {
      const next = {...values};
      delete next[key];
      return next;
    });
  } else {
    for (const node of referencingNodes(nodes, owner, key)) {
      const refs = {...node.componentPropertyReferences};
      for (const field of Object.keys(refs) as BindableProperty[]) if (refs[field] === key) delete refs[field];
      draft.patch(node.id, {componentPropertyReferences: Object.keys(refs).length ? refs : undefined});
      dirty.add(node.id);
    }
    renameOnInstances(draft, owner, key, null);
  }
  const next = {...(draft.get(owner.id)!.componentPropertyDefinitions ?? {})};
  delete next[key];
  draft.patch(owner.id, {componentPropertyDefinitions: next});
  syncDraft(draft, dirty);
  return {doc: draft.finish(), changed: draft.changed};
}

/** For a layer inside an instance whose `field` a property drives: the instance whose property to set and
 *  the key, so an edit on the canvas (typing into bound text) can go to the property instead of an override. */
export function propertyForField(doc: DesignDocument, nodeId: NodeId, field: BindableProperty): {instanceId: NodeId; key: string} | null {
  const node = doc.nodes[nodeId];
  const source = node?.mainId ? doc.nodes[node.mainId] : undefined;
  const key = source?.componentPropertyReferences?.[field];
  if (key === undefined) return null;
  const instanceId = nearestInstanceAbove(doc.nodes, nodeId);
  return instanceId ? {instanceId, key} : null;
}

// ── Variant names (shared with variants.ts) ────────────────────────────────────────────────────

/** Rewrites every variant's name of a set through `rewrite` (values in, values out), keeping the set's
 *  property order, then refreshes the VARIANT definitions. */
export function rewriteVariantNames(draft: DocumentDraft, setId: NodeId, rewrite: (values: Record<string, string>, variant: SceneNode) => Record<string, string>, order?: readonly string[]): void {
  const set = draft.get(setId);
  if (set?.type !== 'COMPONENT_SET') return;
  const keys = order ?? Object.entries(set.componentPropertyDefinitions ?? {}).filter(([, def]) => def.type === 'VARIANT').map(([key]) => key);
  for (const id of set.children ?? []) {
    const variant = draft.get(id);
    if (variant?.type !== 'COMPONENT') continue;
    const values = parseVariantName(variant.name);
    if (!values) continue;
    const name = formatVariantName(rewrite(values, variant), keys);
    if (name !== variant.name) draft.patch(id, {name});
  }
  refreshVariantDefinitionsIn(draft, setId);
}

function renameVariantPropertyIn(draft: DocumentDraft, set: SceneNode, from: string, to: string): void {
  const defs = set.componentPropertyDefinitions ?? {};
  const order = Object.entries(defs).filter(([, def]) => def.type === 'VARIANT').map(([key]) => (key === from ? to : key));
  // Rename the definition first so the refresh keeps its options' order.
  const renamed: Record<string, ComponentPropertyDefinition> = {};
  for (const [key, def] of Object.entries(defs)) renamed[key === from ? to : key] = def;
  draft.patch(set.id, {componentPropertyDefinitions: renamed});
  rewriteVariantNames(draft, set.id, values => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) next[key === from ? to : key] = value;
    return next;
  }, order);
}

export {renameVariantPropertyIn as renameVariantPropertyInDraft};
