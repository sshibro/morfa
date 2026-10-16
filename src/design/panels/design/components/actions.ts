import type {ComponentPropertyType, DesignDocument, NodeId} from '../../../../../shared/design/types';
import {newId} from '../../../../../shared/design/defaults';
import {
  addComponentProperty, bindProperty, deleteProperty, editProperty, formatVariantName, propertyDefinitionsOf, propertyName, setInstanceProperty, swapInstance,
  variantValues, wouldCreateCycle, type BindableProperty,
} from '../../../../../shared/design/components';
import {addVariantProperty, combineAsVariants, renameVariantProperty, renameVariantValue} from '../../../../../shared/design/variants';
import {chainEdits, notify, runEdit} from '../../../engine/commands/components';
import type {DesignStore} from '../../../engine/store';
import {editNodes} from '../../../engine/user-edit';
import {TYPE_FOR_FIELD} from './model';

// What the "Component" and "Instance" sections do: each action is one undo step through the pure
// operations (shared/design/components.ts, variants.ts) and `runEdit`, which turns a refusal into a toast.

export const PROPERTY_TYPE_LABELS: Record<ComponentPropertyType, string> = {
  VARIANT: 'Variant',
  BOOLEAN: 'Boolean',
  TEXT: 'Text',
  INSTANCE_SWAP: 'Instance swap',
};

/** "Property 1", "Property 2"…: the first name no property of the owner uses. */
export function nextPropertyName(doc: DesignDocument, ownerId: NodeId, base = 'Property'): string {
  // A set's variants may keep properties of their own (a component combined with its switches): their names are taken too.
  const owner = doc.nodes[ownerId];
  const variants = owner?.type === 'COMPONENT_SET' ? owner.children ?? [] : [];
  const taken = new Set([ownerId, ...variants].flatMap(id => Object.keys(propertyDefinitionsOf(doc, id))).map(propertyName));
  for (let n = 1; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A component an INSTANCE_SWAP property can start with: a nested instance's, else another local one. */
function swapDefault(doc: DesignDocument, componentId: NodeId): NodeId | null {
  const root = doc.nodes[componentId];
  const roots = root?.type === 'COMPONENT_SET' ? root.children ?? [] : [componentId];
  for (const rootId of roots) {
    const stack = [...(doc.nodes[rootId]?.children ?? [])];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node) continue;
      if (node.type === 'INSTANCE' && node.componentId && doc.nodes[node.componentId]) return node.componentId;
      if (node.children && node.type !== 'INSTANCE') stack.push(...node.children);
    }
  }
  const parent = roots[0] ?? componentId;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (node.type !== 'COMPONENT' || node.mainId !== undefined || roots.includes(id) || id === componentId) continue;
    if (!wouldCreateCycle(doc, id, parent)) return id;
  }
  return null;
}

/** "+" in "Properties": adds a property of `type` to a component, variant (its set) or set, and returns
 *  its key. A variant property on a lone component turns it into a variant set first, as in Figma. */
export function addProperty(store: DesignStore, componentId: NodeId, type: ComponentPropertyType): {key: string; ownerId: NodeId} | null {
  const {doc} = store.getState();
  const node = doc.nodes[componentId];
  if (!node) return null;
  const set = node.type === 'COMPONENT_SET' ? node : node.parentId && doc.nodes[node.parentId]?.type === 'COMPONENT_SET' ? doc.nodes[node.parentId] : null;
  if (type === 'VARIANT') {
    if (set) {
      const name = nextPropertyName(doc, set.id);
      return runEdit(store, 'New property', current => addVariantProperty(current, set.id, name)) ? {key: name, ownerId: set.id} : null;
    }
    const setId = newId();
    const result = runEdit(store, 'New property', current => combineAsVariants(current, [componentId], setId), {select: out => [out.setId]});
    if (!result) return null;
    const key = Object.keys(propertyDefinitionsOf(store.getState().doc, setId))[0];
    return key ? {key, ownerId: setId} : null;
  }
  const ownerId = set?.id ?? componentId;
  const name = nextPropertyName(doc, ownerId);
  let defaultValue: string | boolean = type === 'BOOLEAN' ? true : 'Text';
  if (type === 'INSTANCE_SWAP') {
    const component = swapDefault(doc, componentId);
    if (!component) {
      notify(store, 'Swapping needs one more component in the file');
      return null;
    }
    defaultValue = component;
  }
  const result = runEdit(store, 'New property', current => addComponentProperty(current, componentId, {name, type, defaultValue}));
  return result ? {key: result.key, ownerId} : null;
}

/** Renames a property (a variant property through its set); returns the new key. */
export function renameProperty(store: DesignStore, ownerId: NodeId, key: string, name: string, variant: boolean): string | null {
  if (variant) return runEdit(store, 'Rename property', current => renameVariantProperty(current, ownerId, key, name)) ? name.trim() : null;
  return runEdit(store, 'Rename property', current => editProperty(current, ownerId, key, {name}))?.key ?? null;
}

export function setPropertyDefault(store: DesignStore, ownerId: NodeId, key: string, defaultValue: string | boolean, coalesce?: string): void {
  runEdit(store, 'Property value', current => editProperty(current, ownerId, key, {defaultValue}), {coalesce});
}

export function setPreferredValues(store: DesignStore, ownerId: NodeId, key: string, preferredValues: NodeId[]): void {
  runEdit(store, 'Preferred values', current => editProperty(current, ownerId, key, {preferredValues}));
}

export function removeProperty(store: DesignStore, ownerId: NodeId, key: string): void {
  runEdit(store, 'Delete property', current => deleteProperty(current, ownerId, key));
}

export function renameValue(store: DesignStore, setId: NodeId, property: string, from: string, to: string): void {
  runEdit(store, 'Rename value', current => renameVariantValue(current, setId, property, from, to));
}

/** A selected variant's own value of a property (renames the variant; the set's options follow). */
export function setVariantValue(store: DesignStore, variantId: NodeId, property: string, value: string): void {
  const {doc} = store.getState();
  const set = doc.nodes[doc.nodes[variantId]?.parentId ?? ''];
  if (set?.type !== 'COMPONENT_SET') return;
  const order = Object.entries(set.componentPropertyDefinitions ?? {}).filter(([, def]) => def.type === 'VARIANT').map(([key]) => key);
  const name = formatVariantName({...variantValues(doc, variantId), [property]: value.trim()}, order);
  editNodes(store, 'Variant value', [variantId], () => ({name}));
}

export function setDescription(store: DesignStore, id: NodeId, description: string): void {
  editNodes(store, 'Component description', [id], node => (node.description === description ? null : {description}));
}

/** Binds (or with null unbinds) a layer of a main to a property. */
export function bindLayer(store: DesignStore, nodeId: NodeId, field: BindableProperty, key: string | null): void {
  bindLayers(store, [nodeId], field, key);
}

/** The same for several layers (one per variant of a set) as one undo step. */
export function bindLayers(store: DesignStore, nodeIds: readonly NodeId[], field: BindableProperty, key: string | null): void {
  runEdit(store, key ? 'Bind to property' : 'Unbind from property', current => chainEdits(current, nodeIds, (doc, id) => bindProperty(doc, id, field, key)));
}

/** "Create property" from a layer: a property whose default is the layer's current value, bound to it. */
export function createPropertyFor(store: DesignStore, componentId: NodeId, nodeId: NodeId, field: BindableProperty): string | null {
  const {doc} = store.getState();
  const node = doc.nodes[nodeId];
  if (!node) return null;
  const type = TYPE_FOR_FIELD[field];
  const defaultValue = field === 'visible' ? node.visible : field === 'characters' ? node.text?.characters ?? '' : node.componentId ?? '';
  const base = field === 'visible' ? `Show "${node.name}"` : node.name;
  const set = doc.nodes[doc.nodes[componentId]?.parentId ?? ''];
  const name = uniqueName(doc, set?.type === 'COMPONENT_SET' ? set.id : componentId, base.replace(/[,=]/g, ' ').trim() || 'Property');
  let key: string | null = null;
  runEdit(store, 'New property', current => {
    const added = addComponentProperty(current, componentId, {name, type, defaultValue});
    key = added.key;
    const bound = bindProperty(added.doc, nodeId, field, added.key);
    return {doc: bound.doc, changed: new Set([...added.changed, ...bound.changed])};
  });
  return key;
}

function uniqueName(doc: DesignDocument, ownerId: NodeId, base: string): string {
  const taken = new Set(Object.keys(propertyDefinitionsOf(doc, ownerId)).map(propertyName));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

// ── Instances ────────────────────────────────────────────────────────────────────────────────────

/** Sets a property on every selected instance that has it (variants switch, booleans and texts become
 *  values, swaps change the nested component). */
export function setInstancesProperty(store: DesignStore, ids: readonly NodeId[], key: string, value: string | boolean, coalesce?: string): void {
  runEdit(store, 'Instance property', current => chainEdits(current, ids, (doc, id) => setInstanceProperty(doc, id, key, value)), {coalesce});
}

/** "Swap instance": every selected instance shows `componentId` (a set gives its default variant). */
export function swapInstances(store: DesignStore, ids: readonly NodeId[], componentId: NodeId): void {
  runEdit(store, 'Instance swap', current => chainEdits(current, ids, (doc, id) => swapInstance(doc, id, componentId)));
}
