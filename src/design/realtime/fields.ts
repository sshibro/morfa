import type {DocumentPatch} from '../../../shared/design/patch';
import type {ClientOp, ProtocolNodeFields, ProtocolOpFields} from '../../../shared/design/protocol';
import type {NodeId, SceneNode} from '../../../shared/design/types';

// Field-level remote changes (protocol 2, crates/protocol/src/fields.rs, lane W). A change carries the nodes the file
// already had as the fields that changed: `fields: {<id>: {set, unset}}` beside `patch` (whose `nodes` keep only new and
// removed nodes). The editor spreads them over the node it has at the change's previous version: the result is the node
// the server stored, and every value the change did not touch (fills, strokes, effects, text) keeps its object, so the
// render and text caches keyed by identity survive other people's edits.

/** One node's changed fields (SceneNode field names). */
export type NodeFields = ProtocolNodeFields;
/** A change's field-level nodes, by id. */
export type ChangeFields = Record<NodeId, NodeFields>;

/** `{...node, ...set}` without `unset`: a new node object whose untouched values are the old node's own. */
export function spreadFields(node: SceneNode, fields: NodeFields): SceneNode {
  const next = (fields.set ? {...node, ...fields.set} : {...node}) as Record<string, unknown>;
  if (fields.unset) for (const key of fields.unset) delete next[key];
  return next as unknown as SceneNode;
}

/** `b`'s fields after `a`'s, as one. */
export function mergeFields(a: NodeFields | undefined, b: NodeFields): NodeFields {
  if (!a) return b;
  const set: Record<string, unknown> = {...a.set, ...b.set};
  const unset = new Set(a.unset ?? []);
  for (const key of Object.keys(b.set ?? {})) unset.delete(key);
  for (const key of b.unset ?? []) {
    delete set[key];
    unset.add(key);
  }
  const out: NodeFields = {};
  if (Object.keys(set).length) out.set = set;
  if (unset.size) out.unset = [...unset];
  return out;
}

const own = Object.hasOwn;

/**
 * The changes (and `extra`, a whole-node patch on top: the server's version of this editor's save) as one whole-node
 * patch, in one pass: tables are copied once (composeAll), and each field-level node is spread over the node it had
 * just before: an earlier change's in this list, else `base(id)`, the server's node as this editor holds it. Null when
 * a field-level node has no base (the editor does not hold what the server changed): the caller reloads.
 */
export function resolveChanges(
  changes: readonly {patch: DocumentPatch; fields?: ChangeFields}[],
  extra: DocumentPatch | null,
  base: (id: NodeId) => SceneNode | null | undefined,
): DocumentPatch | null {
  const out: Record<string, unknown> = {};
  const take = (patch: DocumentPatch) => {
    for (const table of Object.keys(patch) as (keyof DocumentPatch)[]) {
      const value = patch[table];
      if (value === undefined) continue;
      if (table === 'pages') out.pages = value;
      else Object.assign(((out[table] ??= {}) as Record<string, unknown>), value);
    }
  };
  for (const change of changes) {
    take(change.patch);
    if (!change.fields) continue;
    const nodes = (out.nodes ??= {}) as Record<NodeId, SceneNode | null>;
    for (const id of Object.keys(change.fields)) {
      const prior = own(nodes, id) ? nodes[id] : base(id);
      if (!prior) return null;
      nodes[id] = spreadFields(prior, change.fields[id]);
    }
  }
  if (extra) take(extra);
  if (out.pages) out.pages = [...(out.pages as string[])];
  return out as DocumentPatch;
}

/**
 * Composes the field-level part of consecutive changes without a base (the decode worker's catch-up): a node replaced
 * whole earlier takes the fields into its whole value; otherwise the fields merge. `nodes` is the composite's whole-node
 * table so far (mutated); returns false when fields name a node an earlier change removed.
 */
export function composeFieldsInto(nodes: Record<NodeId, SceneNode | null>, into: ChangeFields, fields: ChangeFields): boolean {
  for (const id of Object.keys(fields)) {
    if (own(nodes, id)) {
      const prior = nodes[id];
      if (!prior) return false;
      nodes[id] = spreadFields(prior, fields[id]);
    } else into[id] = mergeFields(into[id], fields[id]);
  }
  return true;
}

/**
 * An op as protocol 2 sends it: every node the client had before (its `before` copy) and still has goes as the fields
 * that differ from that copy (compared by identity: the store's updates are immutable, so an untouched value is the
 * same object), with `was`, the copy's values of those fields, for the server's merge when the op is behind. New and
 * removed nodes, and the other tables, stay as they are. Without `before` copies the op goes whole.
 */
export function toFieldOp(op: ClientOp): ClientOp {
  const nodes = op.patch.nodes as Record<NodeId, SceneNode | null> | undefined;
  const before = op.before as Record<NodeId, SceneNode | null> | undefined;
  if (!nodes || !before) return op;
  const set: NonNullable<ProtocolOpFields['set']> = {};
  const unset: NonNullable<ProtocolOpFields['unset']> = {};
  const was: NonNullable<ProtocolOpFields['was']> = {};
  const restNodes: Record<NodeId, SceneNode | null> = {};
  const restBefore: Record<NodeId, SceneNode | null> = {};
  let count = 0;
  for (const id of Object.keys(nodes)) {
    const next = nodes[id] as Record<string, unknown> | null;
    const prior = (own(before, id) ? before[id] : undefined) as Record<string, unknown> | null | undefined;
    if (!next || !prior) {
      restNodes[id] = next as SceneNode | null;
      if (prior !== undefined) restBefore[id] = prior as SceneNode | null;
      continue;
    }
    const nodeSet: Record<string, unknown> = {};
    const nodeWas: Record<string, unknown> = {};
    const nodeUnset: string[] = [];
    for (const key of Object.keys(next)) {
      if (next[key] === prior[key] && own(prior, key)) continue;
      nodeSet[key] = next[key];
      if (own(prior, key)) nodeWas[key] = prior[key];
    }
    for (const key of Object.keys(prior)) {
      if (own(next, key)) continue;
      nodeUnset.push(key);
      nodeWas[key] = prior[key];
    }
    set[id] = nodeSet;
    if (nodeUnset.length) unset[id] = nodeUnset;
    if (Object.keys(nodeWas).length) was[id] = nodeWas;
    count++;
  }
  if (!count) return op;
  const {nodes: _nodes, ...tables} = op.patch;
  const patch = Object.keys(restNodes).length ? {...tables, nodes: restNodes} : tables;
  const {before: _before, ...rest} = op;
  return {
    ...rest,
    patch: patch as DocumentPatch,
    ...(Object.keys(restBefore).length ? {before: restBefore} : {}),
    fields: {set, ...(Object.keys(unset).length ? {unset} : {}), ...(Object.keys(was).length ? {was} : {})},
  };
}

/**
 * The whole-node op a field op stands for, over `node(id)` (the receiver's nodes at `version`): what crates/collab's
 * fields_op does, for servers written in TypeScript (the tests' fake collab). A field node the receiver no longer has is
 * dropped when the op is behind (removal wins, as in the merge: the answer then carries `own`) and makes the op invalid
 * (null) when it is not.
 */
export function expandFieldOp(op: ClientOp, version: number, node: (id: NodeId) => SceneNode | undefined): {op: ClientOp; dropped: NodeId[]} | null {
  if (!op.fields) return {op, dropped: []};
  const {set = {}, unset = {}, was = {}} = op.fields;
  const nodes: Record<NodeId, SceneNode | null> = {...((op.patch.nodes as Record<NodeId, SceneNode | null> | undefined) ?? {})};
  const before: Record<NodeId, SceneNode | null> = {...((op.before as Record<NodeId, SceneNode | null> | undefined) ?? {})};
  const behind = op.baseVersion !== version;
  const dropped: NodeId[] = [];
  for (const id of new Set([...Object.keys(set), ...Object.keys(unset)])) {
    const current = node(id);
    if (!current) {
      if (!behind) return null;
      dropped.push(id);
      continue;
    }
    nodes[id] = spreadFields(current, {set: set[id] ?? {}, unset: unset[id] ?? []});
    if (behind) {
      const keys = [...Object.keys(set[id] ?? {}), ...(unset[id] ?? [])];
      const prior = was[id] ?? {};
      before[id] = spreadFields(current, {set: Object.fromEntries(keys.filter(key => own(prior, key)).map(key => [key, prior[key]])), unset: keys.filter(key => !own(prior, key))});
    }
  }
  const {fields: _fields, ...rest} = op;
  // Behind, the op merges: it always has its copies then (also when every field node was dropped).
  return {op: {...rest, patch: {...op.patch, nodes} as DocumentPatch, ...(behind || Object.keys(before).length ? {before} : {})}, dropped};
}
