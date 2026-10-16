import type {ComponentPropertyDefinition, ComponentPropertyType, DesignDocument, NodeId, SceneNode} from '../../../../../shared/design/types';
import {deepEqual, exposedInstancesOf, parseVariantName, propertyDefinitionsOf, propertyName, variantValues, type BindableProperty} from '../../../../../shared/design/components';
import {variantSetIssues, type VariantIssue} from '../../../../../shared/design/variants';
import {pageIdOf} from '../../../../../shared/design/tree';

// What the "Component" and "Instance" sections show, as plain data computed from the document and
// the selection. Pure, so node tests check it, and compared structurally so a panel re-renders only
// when what it shows changes (never on a drag that leaves the components alone).

export const MIXED = Symbol('mixed');
export type Mixed = typeof MIXED;

export type PropertyRow = {
  key: string;
  /** Without the "#n" suffix. */
  name: string;
  type: ComponentPropertyType;
  defaultValue: string | boolean;
  options?: readonly string[];
  preferredValues?: readonly NodeId[];
};

export type ComponentModel = {
  kind: 'component' | 'variant' | 'set';
  id: NodeId;
  /** Where the definitions live: the set for a variant, else the node itself. */
  ownerId: NodeId;
  setId: NodeId | null;
  name: string;
  description: string;
  /** VARIANT properties (sets and variants). */
  variantProperties: PropertyRow[];
  /** BOOLEAN, TEXT and INSTANCE_SWAP properties. */
  properties: PropertyRow[];
  /** A variant's own values. */
  values: Record<string, string> | null;
  issues: VariantIssue[];
};

/** Rows of a definitions map: variant properties in their order, the rest after them. */
export function propertyRows(defs: Record<string, ComponentPropertyDefinition>): {variant: PropertyRow[]; other: PropertyRow[]} {
  const variant: PropertyRow[] = [], other: PropertyRow[] = [];
  for (const [key, def] of Object.entries(defs)) {
    const row: PropertyRow = {key, name: def.type === 'VARIANT' ? key : propertyName(key), type: def.type, defaultValue: def.defaultValue};
    if (def.variantOptions) row.options = def.variantOptions;
    if (def.preferredValues?.length) row.preferredValues = def.preferredValues;
    (def.type === 'VARIANT' ? variant : other).push(row);
  }
  return {variant, other};
}

/** The "Component" section's model for a single selected COMPONENT or COMPONENT_SET. */
export function componentModel(doc: DesignDocument, ids: readonly NodeId[]): ComponentModel | null {
  if (ids.length !== 1) return null;
  const node = doc.nodes[ids[0]];
  if (!node || node.mainId !== undefined || (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET')) return null;
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  const setId = node.type === 'COMPONENT_SET' ? node.id : parent?.type === 'COMPONENT_SET' ? parent.id : null;
  const kind = node.type === 'COMPONENT_SET' ? 'set' : setId ? 'variant' : 'component';
  const rows = propertyRows(propertyDefinitionsOf(doc, node.id));
  return {
    kind, id: node.id, ownerId: setId ?? node.id, setId, name: node.name, description: node.description ?? '',
    variantProperties: rows.variant, properties: rows.other,
    values: kind === 'variant' ? variantValues(doc, node.id) : null,
    issues: setId && kind === 'set' ? variantSetIssues(doc, setId) : [],
  };
}

export type InstanceRow = {
  key: string;
  name: string;
  type: ComponentPropertyType;
  value: string | boolean | Mixed;
  options?: readonly string[];
  preferredValues?: readonly NodeId[];
};

export type InstanceModel = {
  ids: NodeId[];
  /** The main every instance shows, MIXED when they differ, null when it was deleted. */
  componentId: NodeId | Mixed | null;
  /** The set (for variants) or the component the swap menu marks as current. */
  swapId: NodeId | Mixed | null;
  /** The set's name for a variant, else the component's; "Mixed" is the panel's business. */
  mainName: string | Mixed;
  /** Some instance's main component is missing (it can be restored). */
  orphan: boolean;
  /** Some selected instance lies inside another instance (detach, push are not for it). */
  nested: boolean;
  rows: InstanceRow[];
};

const valueOf = (node: SceneNode, key: string, def: ComponentPropertyDefinition, doc: DesignDocument): string | boolean => {
  if (def.type === 'VARIANT') {
    const values = node.componentId ? variantValues(doc, node.componentId) : {};
    return values[key] ?? String(def.defaultValue);
  }
  const own = node.componentProperties?.[key];
  return own === undefined ? def.defaultValue : own;
};

/** The "Instance" section's model for the selected instances (other layers in the selection are
 *  ignored). With several, only properties every instance has show, a differing value as MIXED. */
export function instanceModel(doc: DesignDocument, ids: readonly NodeId[]): InstanceModel | null {
  const instances = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => node?.type === 'INSTANCE');
  if (!instances.length) return null;
  let componentId: NodeId | Mixed | null | undefined;
  let swapId: NodeId | Mixed | null | undefined;
  let mainName: string | Mixed | undefined;
  let orphan = false, nested = false;
  let rows: InstanceRow[] | null = null;
  for (const node of instances) {
    const main = node.componentId ? doc.nodes[node.componentId] : undefined;
    const own = main?.type === 'COMPONENT' ? main.id : null;
    if (!own) orphan = true;
    if (node.mainId !== undefined) nested = true;
    const set = main?.parentId && doc.nodes[main.parentId]?.type === 'COMPONENT_SET' ? doc.nodes[main.parentId] : undefined;
    const swap = set?.id ?? own;
    const name = set?.name ?? main?.name ?? node.name;
    componentId = componentId === undefined ? own : componentId === own ? componentId : MIXED;
    swapId = swapId === undefined ? swap : swapId === swap ? swapId : MIXED;
    mainName = mainName === undefined ? name : mainName === name ? mainName : MIXED;
    const defs = own ? propertyDefinitionsOf(doc, own) : {};
    const mine: InstanceRow[] = [];
    for (const [key, def] of Object.entries(defs)) {
      const row: InstanceRow = {key, name: def.type === 'VARIANT' ? key : propertyName(key), type: def.type, value: valueOf(node, key, def, doc)};
      if (def.variantOptions) row.options = def.variantOptions;
      if (def.preferredValues?.length) row.preferredValues = def.preferredValues;
      mine.push(row);
    }
    if (!rows) {
      rows = mine;
      continue;
    }
    const byKey = new Map(mine.map(row => [row.key, row]));
    rows = rows.filter(row => byKey.get(row.key)?.type === row.type).map(row => {
      const other = byKey.get(row.key)!;
      const value = row.value === MIXED || row.value !== other.value ? MIXED : row.value;
      const options = row.options && other.options ? row.options.filter(option => other.options!.includes(option)) : row.options;
      return {...row, value, ...(options ? {options} : {})};
    });
  }
  // Variant rows first, in the set's order; then the rest as defined.
  rows = [...rows!.filter(row => row.type === 'VARIANT'), ...rows!.filter(row => row.type !== 'VARIANT')];
  return {ids: instances.map(node => node.id), componentId: componentId ?? null, swapId: swapId ?? null, mainName: mainName ?? '', orphan, nested, rows};
}

/** Structural equality of models (MIXED compares by identity). */
export const sameModel = (a: unknown, b: unknown) => deepEqual(a, b);

/** An exposed nested instance as its parent instance shows it: the copy, its name and its properties. */
export type ExposedGroup = {id: NodeId; name: string; rows: InstanceRow[]};

/** The groups "Instance" adds below one instance's own properties (Figma's exposed nested instances). */
export function exposedGroups(doc: DesignDocument, instanceId: NodeId): ExposedGroup[] {
  const out: ExposedGroup[] = [];
  for (const id of exposedInstancesOf(doc, instanceId)) {
    const model = instanceModel(doc, [id]);
    if (model && !model.orphan && model.rows.length) out.push({id, name: doc.nodes[id].name, rows: model.rows});
  }
  return out;
}

/** How a component reads in a field: its set's name for a variant, the last part of a "Icons/Arrow"
 *  name, "Deleted component" when it is gone. */
export function componentLabel(doc: DesignDocument, id: NodeId): string {
  const node = doc.nodes[id];
  if (!node) return 'Deleted component';
  const set = node.parentId && doc.nodes[node.parentId]?.type === 'COMPONENT_SET' ? doc.nodes[node.parentId] : undefined;
  const name = (set ?? node).name;
  return name.split('/').map(part => part.trim()).filter(Boolean).pop() ?? name;
}

// ── Swap menu ────────────────────────────────────────────────────────────────────────────────────

export type SwapEntry = {
  /** A COMPONENT outside sets, or a COMPONENT_SET. */
  id: NodeId;
  name: string;
  /** Last part of a "Buttons/Primary" name. */
  label: string;
  /** "Page / Buttons": where the menu groups it. */
  group: string;
  pageId: NodeId;
  kind: 'component' | 'set';
};

/** Local components the swap menu offers: components outside sets and variant sets, grouped by page
 *  and the "/" folders of their names, in page order then name order. One pass over the file. */
export function swapEntries(doc: DesignDocument): SwapEntry[] {
  const out: SwapEntry[] = [];
  const pageOrder = new Map(doc.pages.map((id, i) => [id, i]));
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (node.mainId !== undefined) continue;
    const isSet = node.type === 'COMPONENT_SET';
    if (!isSet && node.type !== 'COMPONENT') continue;
    if (!isSet && node.parentId && doc.nodes[node.parentId]?.type === 'COMPONENT_SET') continue;
    const pageId = pageIdOf(doc, id);
    if (!pageId) continue;
    const parts = node.name.split('/').map(part => part.trim()).filter(Boolean);
    const label = parts.pop() ?? node.name;
    const page = doc.nodes[pageId]?.name ?? '';
    out.push({id, name: node.name, label, group: [page, ...parts].join(' / '), pageId, kind: isSet ? 'set' : 'component'});
  }
  const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
  return out.sort((a, b) => (pageOrder.get(a.pageId)! - pageOrder.get(b.pageId)!) || collator.compare(a.group, b.group) || collator.compare(a.label, b.label));
}

const fold = (text: string) => text.toLocaleLowerCase('en').replace(/\u0451/g, '\u0435');

/** Entries matching a search (every word somewhere in the name, folders included), preferred ones first. */
export function filterSwapEntries(entries: readonly SwapEntry[], query: string, preferred: readonly NodeId[] = []): {preferred: SwapEntry[]; groups: {group: string; entries: SwapEntry[]}[]} {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matches = entries.filter(entry => {
    const text = fold(entry.name);
    return words.every(word => text.includes(word));
  });
  const preferredSet = new Set(preferred);
  const first = preferred.map(id => matches.find(entry => entry.id === id)).filter((entry): entry is SwapEntry => !!entry);
  const groups: {group: string; entries: SwapEntry[]}[] = [];
  for (const entry of matches) {
    if (preferredSet.has(entry.id)) continue;
    const last = groups[groups.length - 1];
    if (last?.group === entry.group) last.entries.push(entry);
    else groups.push({group: entry.group, entries: [entry]});
  }
  return {preferred: first, groups};
}

// ── Property bindings inside a main ──────────────────────────────────────────────────────────────

export const FIELD_FOR_TYPE: Record<Exclude<ComponentPropertyType, 'VARIANT'>, BindableProperty> = {BOOLEAN: 'visible', TEXT: 'characters', INSTANCE_SWAP: 'mainComponent'};
export const TYPE_FOR_FIELD: Record<BindableProperty, Exclude<ComponentPropertyType, 'VARIANT'>> = {visible: 'BOOLEAN', characters: 'TEXT', mainComponent: 'INSTANCE_SWAP'};

/** The main component a layer belongs to, when it is a layer of a main (not a copy, not the main itself). */
export function mainOfLayer(doc: DesignDocument, id: NodeId): NodeId | null {
  const node = doc.nodes[id];
  if (!node || node.mainId !== undefined) return null;
  for (let parent = node.parentId ? doc.nodes[node.parentId] : undefined; parent; parent = parent.parentId ? doc.nodes[parent.parentId] : undefined) {
    if (parent.type === 'COMPONENT') return parent.id;
    if (parent.type === 'INSTANCE' || parent.type === 'PAGE') return null;
  }
  return null;
}

/** Whether `field` of this layer can be bound: visibility of any layer, text of a TEXT, the component of a nested instance. */
export const bindableField = (node: SceneNode | undefined, field: BindableProperty) =>
  !!node && (field === 'visible' || (field === 'characters' && node.type === 'TEXT') || (field === 'mainComponent' && node.type === 'INSTANCE'));

export type BoundLayer = {id: NodeId; name: string; field: BindableProperty};

/** Layers of the owner's component(s) bound to `key` (variants of a set included). */
export function boundLayers(doc: DesignDocument, ownerId: NodeId, key: string): BoundLayer[] {
  const owner = doc.nodes[ownerId];
  if (!owner) return [];
  const roots = owner.type === 'COMPONENT_SET' ? (owner.children ?? []) : [ownerId];
  const out: BoundLayer[] = [];
  for (const root of roots) {
    const stack = [...(doc.nodes[root]?.children ?? [])];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node) continue;
      const refs = node.componentPropertyReferences;
      if (refs) for (const field of Object.keys(refs) as BindableProperty[]) if (refs[field] === key) out.push({id: node.id, name: node.name, field});
      if (node.children && node.type !== 'INSTANCE') stack.push(...node.children);
    }
  }
  return out;
}

export type LayerGroup = {
  /** Path inside the component and name: what makes layers of different variants "the same". */
  key: string;
  name: string;
  /** Parents inside the component ("Content / Row"), empty at the top. */
  path: string;
  ids: NodeId[];
  /** Variants the group's layers are in, and how many the component has (1 for a lone component). */
  variants: number;
  total: number;
};

/** Layers of a component — every variant's for a set, grouped by their path and name, so "Label" in
 *  four variants is one entry — whose `field` can take a property of `type` ("Bind layer"). */
export function bindableLayers(doc: DesignDocument, componentId: NodeId, type: Exclude<ComponentPropertyType, 'VARIANT'>): LayerGroup[] {
  const field = FIELD_FOR_TYPE[type];
  const root = doc.nodes[componentId];
  if (!root) return [];
  const roots = root.type === 'COMPONENT_SET' ? (root.children ?? []).filter(id => doc.nodes[id]?.type === 'COMPONENT') : [componentId];
  const groups = new Map<string, LayerGroup & {seen: Set<NodeId>}>();
  for (const rootId of roots) {
    const visit = (id: NodeId, path: string) => {
      const node = doc.nodes[id];
      if (!node) return;
      if (bindableField(node, field)) {
        const key = `${path}\u0000${node.name}`;
        let group = groups.get(key);
        if (!group) groups.set(key, group = {key, name: node.name, path, ids: [], variants: 0, total: roots.length, seen: new Set()});
        group.ids.push(id);
        if (!group.seen.has(rootId)) {
          group.seen.add(rootId);
          group.variants++;
        }
      }
      if (node.children && node.type !== 'INSTANCE') for (const child of [...node.children].reverse()) visit(child, path ? `${path} / ${node.name}` : node.name);
    };
    for (const child of [...(doc.nodes[rootId]?.children ?? [])].reverse()) visit(child, '');
  }
  return [...groups.values()].map(({seen: _seen, ...group}) => group);
}

/** The layers bound to a property, same-named ones of different variants as one row. */
export function boundLayerGroups(doc: DesignDocument, ownerId: NodeId, key: string): {name: string; field: BindableProperty; ids: NodeId[]}[] {
  const out: {name: string; field: BindableProperty; ids: NodeId[]}[] = [];
  for (const layer of boundLayers(doc, ownerId, key)) {
    const group = out.find(each => each.name === layer.name && each.field === layer.field);
    if (group) group.ids.push(layer.id);
    else out.push({name: layer.name, field: layer.field, ids: [layer.id]});
  }
  return out;
}

/** The instances a component holds of other components (not those inside them), top layers first. */
export function nestedInstancesOf(doc: DesignDocument, componentId: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (id: NodeId) => {
    const children = doc.nodes[id]?.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = doc.nodes[children[i]];
      if (!child || child.mainId !== undefined) continue;
      if (child.type === 'INSTANCE') out.push(child);
      else visit(child.id);
    }
  };
  visit(componentId);
  return out;
}
