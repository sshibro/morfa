import type {DesignDocument, NodeId, SceneNode} from './types';
import type {DocumentDraft} from './components';
import {EngineSkipped, EngineUnsupported, engineByDefault, engineFor, firstDifference, shadowFor, shadowInReach} from './engine-switch';
import {copyTable} from './table-cache';

// Lane L2c: the Rust side of the instance and variable stages behind the engine switch (shared/design/engine-switch.ts,
// module 'normalize'). components.ts `syncDraft` and variables.ts `applyVariablesDetailed` call these when the module
// is `wasm` or `both`; the Rust stages are crates/layout/src/instances, reached through the shadow document's
// `normalize_stage` (crates/wasm/src/normalize.rs). Calls from inside normalize (`owned`/`origin`) stay TypeScript:
// normalize flips as a whole (the coordinator's step).

type StageResult = {reported: NodeId[]; written: NodeId[]; nodes: Record<NodeId, SceneNode | null>};

/** One Rust stage on the shadow brought to `doc`. The shadow skips a document it was last brought to (`doc ===`), and
 *  some callers write their table in place between calls (an owned draft, an import building its file), so it always
 *  gets a fresh object and compares the entries. A string the model cannot hold (a lone UTF-16 surrogate comes back
 *  as U+FFFD) sends the call to TypeScript, counted as a fallback, never a silent change. */
function stage(doc: DesignDocument, name: 'instances' | 'variables', dirty: ReadonlySet<NodeId>): StageResult {
  // By default (EDITOR_DEFAULTS alone) the stage keeps to the shadow's reach as geometry's readers do
  // (`shadowInReach`): never a load or a comparison of the whole file inside a call; TypeScript answers while the engine or
  // the shadow is loading (counted as skipped).
  if (engineByDefault('normalize') && !shadowInReach(doc)) throw new EngineSkipped('the shadow is not near this document (loading, or many ids behind)');
  const text = shadowFor({...doc}).normalize_stage(name, JSON.stringify([...dirty]));
  if (text.includes('\uFFFD') || text.includes('\\ufffd')) throw new EngineUnsupported('a written string holds U+FFFD (a lone surrogate the model cannot hold)');
  return JSON.parse(text) as StageResult;
}

const plain = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/** What one sync wrote, to compare the engines: the ids each wrote and every such entry as it stands after. */
export type SyncWrites = {written: NodeId[]; nodes: Record<NodeId, unknown>};

/** The document a draft stands for now (its own table copied when TypeScript will go on writing into it). */
export function draftSnapshot(draft: DocumentDraft): DesignDocument {
  const doc = draft.finish();
  return engineFor('normalize') === 'both' && doc !== draft.base ? {...doc, nodes: copyTable(doc.nodes)} : doc;
}

/** `syncDraft` in Rust on `before` (the draft's document when the call began); in `wasm` mode its writes go into the
 *  draft (`put`, and `delete` for removed copies, which also records their former parents and drops their modes). */
export function syncDraftWasm(draft: DocumentDraft, before: DesignDocument, dirty: ReadonlySet<NodeId>): SyncWrites {
  const result = stage(before, 'instances', dirty);
  if (engineFor('normalize') === 'wasm') {
    for (const id of result.written) {
      const node = result.nodes[id];
      if (node) draft.put(node);
      else draft.delete(id);
    }
  }
  const nodes: Record<NodeId, unknown> = {};
  for (const id of result.written) nodes[id] = result.nodes[id] ?? null;
  return {written: result.written, nodes};
}

/** The TypeScript sync's writes in the same form: the ids it added to the draft's `changed`, as they stand. */
export function syncWritesOf(draft: DocumentDraft, changedBefore: ReadonlySet<NodeId>): SyncWrites {
  const written = [...draft.changed].filter(id => !changedBefore.has(id));
  const nodes: Record<NodeId, unknown> = {};
  for (const id of written) nodes[id] = plain(draft.get(id));
  return {written, nodes};
}

/** Both engines' syncs agree: every id either wrote holds the same entry after (an id only one side wrote holds what
 *  it held before on the other). */
export function sameSyncWrites(draft: DocumentDraft, before: DesignDocument): (ts: SyncWrites, wasm: SyncWrites) => string | null {
  return (ts, wasm) => {
    const ids = new Set([...ts.written, ...wasm.written]);
    for (const id of ids) {
      const a = id in ts.nodes ? ts.nodes[id] : plain(draft.get(id));
      const b = id in wasm.nodes ? plain(wasm.nodes[id]) : plain(before.nodes[id]);
      const path = firstDifference(a, b, 0, `.nodes[${JSON.stringify(id)}]`);
      if (path !== null) return path;
    }
    return null;
  };
}

export type VariableWrites = {doc: DesignDocument; changed: ReadonlySet<string>};

/** `applyVariablesDetailed` in Rust: the rewritten nodes over a copy of the table. */
export function applyVariablesWasm(doc: DesignDocument, dirty: ReadonlySet<string>): VariableWrites {
  const result = stage(doc, 'variables', dirty);
  if (!result.written.length) return {doc, changed: new Set()};
  const nodes = copyTable(doc.nodes);
  for (const id of result.written) {
    const node = result.nodes[id];
    if (node) nodes[id] = node;
    else delete nodes[id];
  }
  return {doc: {...doc, nodes}, changed: new Set(result.written)};
}

/** Both engines' variable passes agree: the same ids, the same entries. */
export function sameVariableWrites(ts: VariableWrites, wasm: VariableWrites): string | null {
  const a = [...ts.changed].sort(), b = [...wasm.changed].sort();
  const ids = firstDifference(a, b, 0, '.changed');
  if (ids !== null) return ids;
  for (const id of a) {
    const path = firstDifference(plain(ts.doc.nodes[id]), plain(wasm.doc.nodes[id]), 0, `.doc.nodes[${JSON.stringify(id)}]`);
    if (path !== null) return path;
  }
  return null;
}
