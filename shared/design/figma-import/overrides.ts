import type {DesignDocument, NodeId, SceneNode} from '../types';
import {propertyDefinitionsOf, syncInstances, withOverrideTracking} from '../components';
import {sameValue} from '../constraints';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';

// Instance overrides. The REST answer gives each copy its final values; our copies also need to say
// which fields they own (`overrides`), or the first sync would reset them to the main's. Figma's own
// override list is incomplete (it says nothing about sizes a resize gave), so overrides are found by
// comparison with what a sync from the mains produces:
//   1. property values and nested swaps first, since they drive other copies;
//   2. then level by level from each top-level instance down: a copy's synced values depend on its
//      ancestors' overrides (a resized instance stretches its children) but not on its descendants',
//      so each level is compared once the levels above it are settled.
// A copy that still differs after that (its structure, not a field) is counted as unresolved.

const IDENTITY = new Set(['id', 'parentId', 'children', 'mainId', 'overrides', 'type']);

export function sameNode(a: SceneNode, b: SceneNode): boolean {
  const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>;
  for (const key in left) if (key !== 'overrides' && !sameValue(left[key], right[key])) return false;
  for (const key in right) if (key !== 'overrides' && !(key in left) && right[key] !== undefined) return false;
  return true;
}

function fieldsOf(node: SceneNode): Partial<SceneNode> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) if (!IDENTITY.has(key)) out[key] = value;
  return out as Partial<SceneNode>;
}

const capped = (list: readonly string[] | undefined) => (list?.length ? list.slice(0, L.overrides) : undefined);

/** Property values an instance sets away from what it would get anyway, and nested swaps. */
function propertyOverrides(doc: DesignDocument, node: SceneNode): string[] {
  const out: string[] = [];
  const source = node.mainId !== undefined ? doc.nodes[node.mainId] : undefined;
  const swapped = !!source && source.type === 'INSTANCE' && source.componentId !== node.componentId;
  if (swapped) out.push('componentId');
  const definitions = node.componentId ? propertyDefinitionsOf(doc, node.componentId) : {};
  const inherited = source && !swapped ? source.componentProperties ?? {} : {};
  for (const [key, value] of Object.entries(node.componentProperties ?? {})) {
    const definition = definitions[key];
    if (!definition || definition.type === 'VARIANT') continue;
    const expected = Object.hasOwn(inherited, key) ? inherited[key] : definition.defaultValue;
    if (value !== expected) out.push(`componentProperties.${key}`);
  }
  return out;
}

export type OverrideResult = {doc: DesignDocument; unresolved: number};

/** Records overrides on every instance and copy of `doc` (entries are replaced in its node map). */
export function inferOverrides(doc: DesignDocument): OverrideResult {
  const instances = new Set<NodeId>();
  const levels: NodeId[][] = [];
  for (const node of Object.values(doc.nodes)) {
    if (node.type === 'INSTANCE') instances.add(node.id);
    if (node.type !== 'INSTANCE' && node.mainId === undefined) continue;
    // Levels below the top-level instance this node belongs to.
    let level = 0;
    for (let at: SceneNode | undefined = node; at && at.mainId !== undefined; at = at.parentId ? doc.nodes[at.parentId] : undefined) level++;
    (levels[level] ??= []).push(node.id);
  }
  if (!instances.size) return {doc, unresolved: 0};

  for (const id of instances) {
    const node = doc.nodes[id];
    const list = capped(propertyOverrides(doc, node));
    if (list) doc.nodes[id] = {...node, overrides: list};
  }

  let synced: DesignDocument | null = null;
  for (const ids of levels) {
    if (!ids) continue;
    synced ??= syncInstances(doc, instances);
    let changed = false;
    for (const id of ids) {
      const own = doc.nodes[id];
      const derived = synced.nodes[id];
      if (!derived || sameNode(own, derived)) continue;
      const list = capped(withOverrideTracking(synced, id, fieldsOf(own), {direct: true}).overrides);
      if ((list?.length ?? 0) === (own.overrides?.length ?? 0)) continue;
      doc.nodes[id] = {...own, overrides: list};
      changed = true;
    }
    if (changed) synced = null;
  }

  const final = synced ?? syncInstances(doc, instances);
  let unresolved = 0;
  for (const ids of levels) for (const id of ids ?? []) if (!final.nodes[id] || !sameNode(doc.nodes[id], final.nodes[id])) unresolved++;
  return {doc, unresolved};
}
