import type {DesignDocument, NodeId, SceneNode} from './types';
import {createNode, newId as randomId} from './defaults';
import {apply, invert, worldBox, worldMatrix} from './geometry';
import {
  DesignComponentError, DocumentDraft, findVariant, formatVariantName, parseVariantName, propertyDefinitionsOf, propertyName, refreshVariantDefinitionsIn,
  renameVariantPropertyInDraft, rewriteVariantNames, setInstanceProperty, syncDraft,
  type DesignEdit, type IdSource,
} from './components';

// Variants (docs/design-tool.md §The document): a COMPONENT_SET holds COMPONENTs whose names carry their
// property values, "Size=Large, State=Hover", as in Figma. The set's VARIANT definitions
// follow the names (shared/design/components.ts keeps them in sync on every change); an instance shows
// one variant and switching a value swaps it to the matching variant, keeping its overrides.

const fail = (code: ConstructorParameters<typeof DesignComponentError>[0]): never => {
  throw new DesignComponentError(code);
};

/** "Size=Large, State=Hover" → {Size: 'Large', State: 'Hover'} (null if not in that form). */
export const variantProps = parseVariantName;
/** The inverse, properties in `order` first. */
export const formatVariantProps = formatVariantName;

/** Space around and between variants in a set. */
export const VARIANT_GAP = 20;
/** Figma's dashed purple frame around a set (--dz-component). */
const SET_STROKE = {r: 0x97 / 255, g: 0x47 / 255, b: 0xff / 255};
const FIRST_PROPERTY = 'Property 1';
const DEFAULT_VALUE = 'Default';

function idSource(source: IdSource | undefined): () => NodeId {
  if (typeof source === 'function') return source;
  if (source === undefined) return randomId;
  let count = 0;
  return () => (count++ ? `${source}-${count}` : source);
}

function variantKeys(set: SceneNode): string[] {
  return Object.entries(set.componentPropertyDefinitions ?? {}).filter(([, def]) => def.type === 'VARIANT').map(([key]) => key);
}

function variantsOf(draft: DocumentDraft, set: SceneNode): SceneNode[] {
  return (set.children ?? []).map(id => draft.get(id)).filter((node): node is SceneNode => node?.type === 'COMPONENT');
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes(',') || trimmed.includes('=')) fail('invalid_name');
  return trimmed;
}

/** Lays the variants out in a grid inside the set and fits the set around them. With two or more
 *  properties the grid is a matrix: columns are the last property's values, rows the other properties'
 *  combinations; otherwise rows of up to four (or a square). The set's top-left stays where it is. */
export function arrangeVariantsIn(draft: DocumentDraft, setId: NodeId): void {
  const set = draft.get(setId);
  if (set?.type !== 'COMPONENT_SET') return;
  const variants = variantsOf(draft, set);
  if (!variants.length) return;
  const keys = variantKeys(set);
  const cells: {row: number; col: number}[] = [];
  let matrix = false;
  if (keys.length >= 2) {
    const last = keys[keys.length - 1];
    const columns = set.componentPropertyDefinitions?.[last]?.variantOptions ?? [];
    const rows: string[] = [];
    const taken = new Set<string>();
    matrix = true;
    for (const variant of variants) {
      const values = parseVariantName(variant.name);
      const col = values ? columns.indexOf(values[last]) : -1;
      const rowKey = values ? keys.slice(0, -1).map(key => values[key] ?? '').join('\u0000') : '';
      if (!values || col < 0) { matrix = false; break; }
      let row = rows.indexOf(rowKey);
      if (row < 0) row = rows.push(rowKey) - 1;
      if (taken.has(`${row}:${col}`)) { matrix = false; break; }
      taken.add(`${row}:${col}`);
      cells.push({row, col});
    }
  }
  if (!matrix) {
    cells.length = 0;
    const perRow = variants.length <= 4 ? variants.length : Math.ceil(Math.sqrt(variants.length));
    variants.forEach((_, i) => cells.push({row: Math.floor(i / perRow), col: i % perRow}));
  }
  const widths: number[] = [], heights: number[] = [];
  variants.forEach((variant, i) => {
    const {row, col} = cells[i];
    widths[col] = Math.max(widths[col] ?? 0, variant.width);
    heights[row] = Math.max(heights[row] ?? 0, variant.height);
  });
  for (let i = 0; i < widths.length; i++) widths[i] ??= 0;
  for (let i = 0; i < heights.length; i++) heights[i] ??= 0;
  const offset = (sizes: number[], index: number) => VARIANT_GAP + sizes.slice(0, index).reduce((sum, size) => sum + size + VARIANT_GAP, 0);
  variants.forEach((variant, i) => {
    const {row, col} = cells[i];
    const x = offset(widths, col), y = offset(heights, row);
    if (variant.x !== x || variant.y !== y || variant.rotation) draft.patch(variant.id, {x, y, rotation: 0});
  });
  const width = offset(widths, widths.length), height = offset(heights, heights.length);
  if (set.width !== width || set.height !== height) draft.patch(setId, {width, height});
}

/** "Combine as variants": the components move into a new COMPONENT_SET (a dashed purple frame) laid out
 *  in a grid. Property values come from the names ("Size=Large, State=Hover"); names in a
 *  common "Button/…" folder give the set that name and their last part as the value; other names become
 *  "Property 1=Variant N". Instances keep working and gain the variant values. */
export function combineAsVariants(doc: DesignDocument, componentIds: readonly NodeId[], newSetId: NodeId): DesignEdit & {setId: NodeId} {
  const ids = [...new Set(componentIds)];
  if (!ids.length) fail('empty');
  const nodes = doc.nodes;
  const components = ids.map(id => {
    const node = nodes[id];
    if (node?.type !== 'COMPONENT') fail('not_component');
    if (nodes[node!.parentId ?? '']?.type === 'COMPONENT_SET') fail('unsupported');
    return node!;
  });
  const boxes = new Map(components.map(node => [node.id, worldBox(doc, node.id)]));
  components.sort((a, b) => boxes.get(a.id)!.y - boxes.get(b.id)!.y || boxes.get(a.id)!.x - boxes.get(b.id)!.x);

  // Property values from the names.
  const names = components.map(node => node.name);
  const slash = names.every(name => name.includes('/')) ? names[0].slice(0, names[0].lastIndexOf('/')) : null;
  const folder = slash && names.every(name => name.slice(0, name.lastIndexOf('/')) === slash) ? slash : null;
  // The made-up property takes a name none of the components' own properties (a switch, a text) has, as Figma keeps names unique.
  const taken = new Set(components.flatMap(node => Object.keys(node.componentPropertyDefinitions ?? {}).map(propertyName)));
  let made = FIRST_PROPERTY;
  for (let n = 2; taken.has(made); n++) made = `Property ${n}`;
  const values = components.map((node, i) => {
    const own = folder ? node.name.slice(folder.length + 1).trim() : node.name;
    const parsed = parseVariantName(own);
    if (parsed) return parsed;
    return {[made]: folder && own ? own : `Variant ${i + 1}`};
  });
  const order: string[] = [];
  for (const entry of values) for (const key of Object.keys(entry)) if (!order.includes(key)) order.push(key);
  const setName = folder?.trim() || (parseVariantName(components[0].name) ? 'Component' : components[0].name);

  const draft = new DocumentDraft(doc);
  const first = components[0];
  const parentId = first.parentId!;
  const parent = draft.get(parentId)!;
  const anchor = Math.max(...components.filter(node => node.parentId === parentId).map(node => (parent.children ?? []).indexOf(node.id)));
  const topLeft = {x: Math.min(...[...boxes.values()].map(box => box.x)), y: Math.min(...[...boxes.values()].map(box => box.y))};
  const local = parent.type === 'PAGE' ? topLeft : apply(invert(worldMatrix(doc, parentId)), topLeft);

  for (const node of components) {
    const from = draft.get(node.parentId);
    if (from?.children) draft.patch(from.id, {children: from.children.filter(id => id !== node.id)});
  }
  const siblings = draft.get(parentId)!.children ?? [];
  const below = components.filter(node => node.parentId === parentId && (parent.children ?? []).indexOf(node.id) < anchor).length;
  const at = Math.max(0, Math.min(siblings.length, anchor - below));
  draft.patch(parentId, {children: [...siblings.slice(0, at), newSetId, ...siblings.slice(at)]});
  draft.put(createNode('COMPONENT_SET', {
    id: newSetId, parentId, name: setName, x: local.x, y: local.y,
    fills: [], strokes: [{type: 'SOLID', color: SET_STROKE, opacity: 1, visible: true, blendMode: 'NORMAL'}],
    strokeWeight: 1, strokeAlign: 'INSIDE', dashPattern: [10, 5], cornerRadius: 5, clipsContent: false,
    children: components.map(node => node.id), componentPropertyDefinitions: {},
  }));
  components.forEach((node, i) => {
    const full: Record<string, string> = {};
    for (const key of order) full[key] = values[i][key] ?? DEFAULT_VALUE;
    draft.patch(node.id, {
      parentId: newSetId, name: formatVariantName(full, order), rotation: 0,
      constraints: {horizontal: 'MIN', vertical: 'MIN'}, layoutPositioning: 'AUTO',
      layoutSizingHorizontal: node.layoutSizingHorizontal === 'FILL' ? 'FIXED' : node.layoutSizingHorizontal,
      layoutSizingVertical: node.layoutSizingVertical === 'FILL' ? 'FIXED' : node.layoutSizingVertical,
    });
  });
  refreshVariantDefinitionsIn(draft, newSetId);
  arrangeVariantsIn(draft, newSetId);
  syncDraft(draft, new Set([newSetId, ...ids]));
  return {doc: draft.finish(), changed: draft.changed, setId: newSetId};
}

/** Copies a subtree under `parentId` with fresh ids. Instances inside get fresh ids and their copies are
 *  re-keyed under them (`${newInstanceId};${mainId}`), so the duplicate follows the same mains. */
function duplicateSubtree(draft: DocumentDraft, rootId: NodeId, parentId: NodeId, next: () => NodeId): NodeId {
  const instanceIds = new Map<NodeId, NodeId>();
  const rootOf = (node: SceneNode): SceneNode | undefined => {
    let current: SceneNode | undefined = node;
    while (current && current.mainId !== undefined) current = draft.get(current.parentId);
    return current;
  };
  const visit = (id: NodeId, newParent: NodeId): NodeId | null => {
    const node = draft.get(id);
    if (!node) return null;
    let nodeId: NodeId;
    if (node.mainId !== undefined) {
      const root = rootOf(node);
      const mapped = root ? instanceIds.get(root.id) : undefined;
      nodeId = mapped && node.id.startsWith(root!.id + ';') ? mapped + node.id.slice(root!.id.length) : next();
    } else {
      nodeId = next();
      if (node.type === 'INSTANCE') instanceIds.set(id, nodeId);
    }
    const copy: SceneNode = {...node, id: nodeId, parentId: newParent};
    if (node.children) copy.children = node.children.map(child => visit(child, nodeId)).filter((child): child is NodeId => child !== null);
    draft.put(copy);
    const modes = draft.modesOf(id);
    if (modes) draft.setModes(nodeId, {...modes});
    return nodeId;
  };
  return visit(rootId, parentId)!;
}

export type AddVariantOptions = {
  /** The variant to duplicate; default the set's default variant. */
  from?: NodeId;
  newId?: IdSource;
};

/** "+ Add variant": duplicates a variant below the others with a new value of the last property
 *  ("Variant N"), so every combination stays unique, and grows the set to fit. */
export function addVariant(doc: DesignDocument, setId: NodeId, options: AddVariantOptions = {}): DesignEdit & {id: NodeId} {
  const set = doc.nodes[setId];
  if (set?.type !== 'COMPONENT_SET') fail('not_variant');
  const draft = new DocumentDraft(doc);
  const variants = variantsOf(draft, set!);
  const baseId = options.from ?? [...variants].sort((a, b) => a.y - b.y || a.x - b.x)[0]?.id;
  const base = baseId ? draft.get(baseId) : undefined;
  if (base?.type !== 'COMPONENT' || base.parentId !== setId) fail('not_variant');
  const keys = variantKeys(set!);
  const property = keys[keys.length - 1] ?? FIRST_PROPERTY;
  const used = new Set(variants.map(variant => parseVariantName(variant.name)?.[property]).filter(Boolean));
  let n = variants.length + 1;
  while (used.has(`Variant ${n}`)) n++;
  const values = {...(parseVariantName(base!.name) ?? {}), [property]: `Variant ${n}`};
  const id = duplicateSubtree(draft, base!.id, setId, idSource(options.newId));
  const bottom = Math.max(...variants.map(variant => variant.y + variant.height));
  draft.patch(id, {name: formatVariantName(values, keys.length ? keys : [property]), x: base!.x, y: bottom + VARIANT_GAP});
  draft.patch(setId, {children: [...(draft.get(setId)!.children ?? []), id]});
  const added = draft.get(id)!;
  const current = draft.get(setId)!;
  const width = Math.max(current.width, added.x + added.width + VARIANT_GAP);
  const height = Math.max(current.height, added.y + added.height + VARIANT_GAP);
  if (width !== current.width || height !== current.height) draft.patch(setId, {width, height});
  refreshVariantDefinitionsIn(draft, setId);
  syncDraft(draft, new Set([setId, id]));
  return {doc: draft.finish(), changed: draft.changed, id};
}

/** A new variant property: every variant gets `name=value`. */
export function addVariantProperty(doc: DesignDocument, setId: NodeId, name: string, value = DEFAULT_VALUE): DesignEdit {
  const set = doc.nodes[setId];
  if (set?.type !== 'COMPONENT_SET') fail('not_variant');
  const property = checkName(name);
  const defaultValue = checkName(value);
  if (Object.keys(propertyDefinitionsOf(doc, setId)).some(key => key === property || key.startsWith(property + '#'))) fail('duplicate_property');
  const draft = new DocumentDraft(doc);
  rewriteVariantNames(draft, setId, values => ({...values, [property]: defaultValue}), [...variantKeys(set!), property]);
  syncDraft(draft, new Set([setId]));
  return {doc: draft.finish(), changed: draft.changed};
}

/** Renames a variant property in the set's definitions and every variant's name; instances follow. */
export function renameVariantProperty(doc: DesignDocument, setId: NodeId, oldName: string, newName: string): DesignEdit {
  const set = doc.nodes[setId];
  if (set?.type !== 'COMPONENT_SET') fail('not_variant');
  if (set!.componentPropertyDefinitions?.[oldName]?.type !== 'VARIANT') fail('unknown_property');
  const name = checkName(newName);
  if (name === oldName) return {doc, changed: new Set()};
  if (Object.keys(set!.componentPropertyDefinitions ?? {}).some(key => key === name || key.startsWith(name + '#'))) fail('duplicate_property');
  const draft = new DocumentDraft(doc);
  renameVariantPropertyInDraft(draft, set!, oldName, name);
  syncDraft(draft, new Set([setId]));
  return {doc: draft.finish(), changed: draft.changed};
}

/** Renames one value of a variant property: every variant with it is renamed. Renaming onto an existing
 *  value merges them (duplicates then show in `variantSetIssues`). */
export function renameVariantValue(doc: DesignDocument, setId: NodeId, property: string, oldValue: string, newValue: string): DesignEdit {
  const set = doc.nodes[setId];
  if (set?.type !== 'COMPONENT_SET') fail('not_variant');
  const def = set!.componentPropertyDefinitions?.[property];
  if (def?.type !== 'VARIANT') fail('unknown_property');
  const value = checkName(newValue);
  if (value === oldValue) return {doc, changed: new Set()};
  const draft = new DocumentDraft(doc);
  // Keep the value's place in the options.
  draft.patch(setId, {componentPropertyDefinitions: {
    ...set!.componentPropertyDefinitions,
    [property]: {...def!, defaultValue: def!.defaultValue === oldValue ? value : def!.defaultValue, variantOptions: (def!.variantOptions ?? []).map(option => (option === oldValue ? value : option)).filter((option, i, all) => all.indexOf(option) === i)},
  }});
  rewriteVariantNames(draft, setId, values => (values[property] === oldValue ? {...values, [property]: value} : values));
  syncDraft(draft, new Set([setId]));
  return {doc: draft.finish(), changed: draft.changed};
}

/** Switches an instance (or nested instance) to the variant with `property = value`, keeping its other
 *  values where that combination exists, else the closest one; overrides are kept (shared/design/components.ts). */
export function setVariantProperty(doc: DesignDocument, instanceId: NodeId, property: string, value: string): DesignEdit {
  const instance = doc.nodes[instanceId];
  if (instance?.type !== 'INSTANCE') fail('not_instance');
  const def = propertyDefinitionsOf(doc, instance!.componentId ?? '')[property];
  if (def?.type !== 'VARIANT') fail('unknown_property');
  return setInstanceProperty(doc, instanceId, property, value);
}

/** The variant a combination selects (exact, else closest with `priority`'s value). */
export function variantFor(doc: DesignDocument, setId: NodeId, values: Record<string, string>, priority: string): NodeId | null {
  return findVariant(doc, setId, values, priority);
}

export type VariantIssue =
  | {type: 'duplicate'; ids: NodeId[]; name: string}
  | {type: 'invalid_name'; id: NodeId}
  | {type: 'missing_value'; id: NodeId; property: string}
  | {type: 'not_component'; id: NodeId};

/** What the properties panel warns about: variants sharing a combination, names that are not
 *  "Property=Value, …", variants lacking a property, and non-components inside the set. */
export function variantSetIssues(doc: DesignDocument, setId: NodeId): VariantIssue[] {
  const set = doc.nodes[setId];
  if (set?.type !== 'COMPONENT_SET') return [];
  const keys = variantKeys(set);
  const issues: VariantIssue[] = [];
  const combos = new Map<string, NodeId[]>();
  for (const id of set.children ?? []) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.type !== 'COMPONENT') { issues.push({type: 'not_component', id}); continue; }
    const values = parseVariantName(node.name);
    if (!values) { issues.push({type: 'invalid_name', id}); continue; }
    for (const key of keys) if (!(key in values)) issues.push({type: 'missing_value', id, property: key});
    const combo = formatVariantName(values, keys);
    combos.set(combo, [...(combos.get(combo) ?? []), id]);
  }
  for (const [name, ids] of combos) if (ids.length > 1) issues.push({type: 'duplicate', ids, name});
  return issues;
}

/** Re-grids a set's variants (the "Arrange" action). */
export function arrangeVariants(doc: DesignDocument, setId: NodeId): DesignEdit {
  const draft = new DocumentDraft(doc);
  arrangeVariantsIn(draft, setId);
  return {doc: draft.finish(), changed: draft.changed};
}
