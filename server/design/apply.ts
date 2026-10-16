import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {applyPatch, composePatches, type DocumentPatch} from '../../shared/design/patch';
import {documentTarget, mergeChange} from '../../shared/design/merge';
import {PATCH_TABLES} from '../../shared/design/schema';
import {engineTs} from '../../shared/design/engine-switch';
import {applyDocumentChangeWasm, storedValuesWasm, viaOps} from '../../shared/design/ops-engine';
import {normalizeDetailed} from '../../shared/design/normalize';
import {carryTableCaches, forgetTable} from '../../shared/design/table-cache';
import type {TextMeasurer} from '../../shared/design/text-layout';

/** An autosave change as the client sends it: the patch made on `baseVersion`, and with co-editing `before`, the
 * client's copy of every node the patch touches as it was before the change (null: the node did not exist), and
 * `beforeTables`, the same for the other tables and the page order. */
export type DocumentChange = {patch: DocumentPatch; before?: Record<NodeId, SceneNode | null>; beforeTables?: DocumentPatch};
/** The next document, the entries written (`stored`), and whether they differ from what was sent. */
export type AppliedChange = {doc: DesignDocument; stored: DocumentPatch; adjusted: boolean};

/**
 * THE apply step of PATCH /api/design-files/:id/document: the stored document and a change → the next document.
 * With `before` copies the change merges field by field into whatever version the file is at now
 * (shared/design/merge.ts, docs/design-tool.md "Co-editing"); without them it applies as it is (the
 * route then accepts it only on the version it was made on).
 */
export function applyDocumentChange(current: DesignDocument, change: DocumentChange, nodesCopy?: Record<NodeId, SceneNode>): AppliedChange {
  if (engineTs('ops')) return applyDocumentChangeTs(current, change, nodesCopy);
  const apply = (doc: DesignDocument, patch: DocumentPatch) => applyPatch(doc, patch, nodesCopy);
  return viaOps('applyDocumentChange', () => applyDocumentChangeTs(current, change, nodesCopy), () => applyDocumentChangeWasm(current, change, apply), () => [current, change]);
}

/** `nodesCopy`: a table with `current`'s entries that the next document may take instead of a copy (applyPatch's;
 *  the server's spare table, server/design/document-cache.ts). Writing the same change into it twice (`both`) is the same. */
function applyDocumentChangeTs(current: DesignDocument, change: DocumentChange, nodesCopy?: Record<NodeId, SceneNode>): AppliedChange {
  if (change.before === undefined && change.beforeTables === undefined) return {doc: applyPatch(current, change.patch, nodesCopy), stored: change.patch, adjusted: false};
  const merged = mergeChange(documentTarget(current), change.patch, {...change.beforeTables, nodes: change.before ?? {}});
  return {doc: applyPatch(current, merged.patch, nodesCopy), stored: merged.patch, adjusted: merged.adjusted};
}

/** `applyDocumentChange`'s result after the server laid it out: `laidOut` false when it left that to the editor. */
export type LaidOutChange = AppliedChange & {laidOut: boolean};

/**
 * DESIGN_SERVER_LAYOUT=1 (lane L6; docs/design-tool.md "Co-editing", Layout): the layouts around what a
 * merged save wrote run here, once, after the merge, with the server's measurer (server/design/wasm-engine.ts), and
 * go into the stored change itself, so every editor receives the laid-out document and none corrects it. The same
 * step the editor ran as its own correction (src/design/realtime/live-session.ts `relayout`): normalization of the
 * written layers, its writes taken as updates of the layers' own fields (never `id`, `parentId`, `children`).
 * A save whose text needed a face the server does not have (`misses` grew), or a board, is left to the editor as before:
 * `laidOut` false.
 */
export function layOutChange(applied: AppliedChange, measurer: TextMeasurer & {readonly misses?: number}, base?: {doc: DesignDocument; owned: boolean}): LaidOutChange {
  const {doc} = applied;
  if (doc.board === true) return {...applied, laidOut: false};
  const storedNodes = applied.stored.nodes ?? {};
  const ids = Object.keys(storedNodes).filter(id => Object.hasOwn(doc.nodes, id));
  if (!ids.length) return {...applied, laidOut: true};
  const misses = measurer.misses ?? 0;
  // `base`: the document the change was merged into. Its indexes carry over (instances, variables: no scan of the file),
  // and with `owned` (the save's own node table, server/design/document-cache.ts) normalization writes into the table.
  const owned = !!base?.owned;
  const merged = (id: NodeId): SceneNode | undefined =>
    !base ? (Object.hasOwn(doc.nodes, id) ? doc.nodes[id] : undefined) : Object.hasOwn(storedNodes, id) ? (storedNodes[id] ?? undefined) : Object.hasOwn(base.doc.nodes, id) ? base.doc.nodes[id] : undefined;
  const result = normalizeDetailed(doc, new Set(ids), {measurer}, {owned, ...(base ? {origin: {nodes: base.doc.nodes, changed: Object.keys(storedNodes)}} : {})});
  const table = doc.nodes as Record<NodeId, SceneNode>;
  const missed = (measurer.misses ?? 0) !== misses;
  const nodes: Record<NodeId, SceneNode> = {};
  let any = false,
    reshaped = false;
  for (const id of result.changed) {
    const before = merged(id),
      after = Object.hasOwn(result.doc.nodes, id) ? result.doc.nodes[id] : undefined;
    if (!before !== !after) reshaped = true;
    if (!before || !after || before === after || missed) continue;
    const {id: _id, parentId: _parent, children: _children, ...fields} = after;
    const next = {...before, ...fields} as SceneNode;
    if (JSON.stringify(next) === JSON.stringify(before)) continue;
    nodes[id] = next;
    any = true;
  }
  if (owned) {
    // Normalization wrote into the save's own table: what it may keep is the layout below, the rest goes back. A layer it
    // added or removed would change the table's key order: the merged document is made again instead (rare).
    if (reshaped) return layOutChange({...applied, doc: applyPatch(base!.doc, applied.stored)}, measurer, {doc: base!.doc, owned: false});
    for (const id of result.changed) {
      const value = Object.hasOwn(nodes, id) ? nodes[id] : merged(id);
      if (value) table[id] = value;
    }
    forgetTable(table);
    carryTableCaches(base!.doc.nodes, table, new Set([...Object.keys(storedNodes), ...result.changed]));
  }
  if (missed) return owned ? {...applied, doc: {...doc, nodes: table}, laidOut: false} : {...applied, laidOut: false};
  if (!any) return {...applied, doc: owned ? {...doc, nodes: table} : doc, laidOut: true};
  const layout: DocumentPatch = {nodes};
  return {doc: owned ? {...doc, nodes: table} : applyPatch(doc, layout), stored: composePatches(applied.stored, layout), adjusted: true, laidOut: true};
}

/** What the server holds now for every entry the client sent or the merge wrote: the editor puts its copy right. */
export function storedValues(doc: DesignDocument, sent: DocumentPatch, stored: DocumentPatch): DocumentPatch {
  if (engineTs('ops')) return storedValuesTs(doc, sent, stored);
  return viaOps('storedValues', () => storedValuesTs(doc, sent, stored), () => storedValuesWasm(doc, sent, stored), () => [sent, stored]);
}

function storedValuesTs(doc: DesignDocument, sent: DocumentPatch, stored: DocumentPatch): DocumentPatch {
  const out: DocumentPatch = {};
  for (const table of PATCH_TABLES) {
    const keys = new Set([...Object.keys((sent[table] as object | undefined) ?? {}), ...Object.keys((stored[table] as object | undefined) ?? {})]);
    if (!keys.size) continue;
    const values: Record<string, unknown> = {};
    const now = (doc[table] as Record<string, unknown> | undefined) ?? {};
    for (const key of keys) values[key] = Object.hasOwn(now, key) ? now[key] : null;
    (out as Record<string, unknown>)[table] = values;
  }
  if (sent.pages || stored.pages) out.pages = [...doc.pages];
  return out;
}
