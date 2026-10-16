import type {DesignDocument, NodeId, SceneNode} from './types';
import type {NodeUpdates} from './constraints';
import type {TextMeasurer} from './text-layout';
import {EngineSkipped, EngineUnsupported, engineByDefault, shadowFor, shadowInReach} from './engine-switch';
import type {MorfaDocHandle} from './engine-switch';

// The wasm side of the standalone layout entries (lane L2b): layout.ts `layoutFrame` and `layoutSizingUpdates`,
// constraints.ts `resizeUpdates` and `scaleUpdates`, group-fit.ts `groupFitUpdates`, each behind
// `withEngine('normalize', …)`. Rust (crates/layout) runs the entry on a draft of the shadow document and hands back the
// entries it wrote (`[[id, node | null], …]`, in the order first written); `updatesFrom` turns them into the NodeUpdates
// the TypeScript returns: per node, the fields that differ from the document's.
//
// The `MorfaDoc` methods are crates/wasm/src/normalize.rs (lane L2b's request R2, landed with the merge). A wasm build
// from before them (a stale server/design/wasm) answers from TypeScript, counted as a fallback (`EngineUnsupported`),
// never passed off as wasm.

/** The `MorfaDoc` methods lane L2b's entries call. */
export type LayoutEntries = Pick<MorfaDocHandle, 'normalize_layout_frame' | 'normalize_layout_sizing' | 'normalize_resize' | 'normalize_scale' | 'normalize_group_fit'>;

/** The shadow of `doc` with the layout entries, or `EngineUnsupported` when this build lacks them. By default
 *  (EDITOR_DEFAULTS alone, lane N1) the entries keep to the shadow's reach as geometry's readers do (`shadowInReach`): never
 *  a load inside a call; TypeScript answers while the engine or the shadow is loading (counted as skipped). */
export function layoutEntries(doc: DesignDocument): LayoutEntries {
  if (engineByDefault('normalize') && !shadowInReach(doc)) throw new EngineSkipped('the shadow is not near this document (loading, or many ids behind)');
  const shadow: Partial<MorfaDocHandle> = shadowFor(doc);
  if (typeof shadow.normalize_layout_frame !== 'function') throw new EngineUnsupported('this wasm build has no layout entries: rebuild it (scripts/wasm-build.sh)');
  return shadow as LayoutEntries;
}

const fake = new WeakMap<TextMeasurer, boolean>();

/** Rust measures with the fixed-width fake (`testMeasurer`: every UTF-16 unit half an em, ascent 0.8, descent 0.2) until
 *  L3's measurer reaches normalize; a call with any other measurer stays in TypeScript (counted as a fallback). No real
 *  font sets "W" and "i" both half an em wide. */
export function requireFixedWidth(measurer: TextMeasurer): void {
  let known = fake.get(measurer);
  if (known === undefined) {
    const font = {family: 'Inter', weight: 400, italic: false, size: 10};
    const metrics = measurer.metrics(font);
    known = measurer.width('W', font) === 5 && measurer.width('i', font) === 5 && metrics.ascent === 8 && metrics.descent === 2;
    fake.set(measurer, known);
  }
  if (!known) throw new EngineUnsupported('normalize in wasm measures text with the fixed-width fake only');
}

/** JSON equality, numbers by `===` (Rust's JSON writes −0 as 0, as JSON.stringify does). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => same(value, other[i]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key in left) if (left[key] !== undefined && !same(left[key], right[key])) return false;
  for (const key in right) if (right[key] !== undefined && left[key] === undefined) return false;
  return true;
}

/** NodeUpdates (and the removed ids) from the entries a Rust draft wrote over `doc`: `[[id, node | null], …]`, or
 *  `{entries, removed}` when the entry lists its removals in the TypeScript's order. */
export function updatesFrom(doc: DesignDocument, json: string): {updates: NodeUpdates; removed: NodeId[]} {
  const updates: NodeUpdates = new Map();
  const parsed = JSON.parse(json) as [NodeId, SceneNode | null][] | {entries: [NodeId, SceneNode | null][]; removed: NodeId[]};
  const list = Array.isArray(parsed) ? parsed : parsed.entries;
  const removed: NodeId[] = Array.isArray(parsed) ? [] : parsed.removed;
  for (const [id, node] of list) {
    if (!node) {
      if (Array.isArray(parsed)) removed.push(id);
      continue;
    }
    const base = doc.nodes[id] as unknown as Record<string, unknown> | undefined;
    if (!base) {
      updates.set(id, node);
      continue;
    }
    const fields: Record<string, unknown> = {};
    const next = node as unknown as Record<string, unknown>;
    for (const key in next) if (!same(next[key], base[key])) fields[key] = next[key];
    for (const key in base) if (base[key] !== undefined && !(key in next)) fields[key] = undefined;
    if (Object.keys(fields).length) updates.set(id, fields as Partial<SceneNode>);
  }
  return {updates, removed};
}
