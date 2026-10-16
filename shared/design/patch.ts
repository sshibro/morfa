import type {DesignDocument, ImageAsset, ImageRef, NodeId, SceneNode, Style, StyleId, Variable, VariableCollection, VariableId} from './types';
import {applyEntriesInPlace, carryTableCaches, copyTable} from './table-cache';
import {engineFor, engineTs} from './engine-switch';
import {applyPatchWasm, composePatchesWasm, diffDocumentsWasm, invertPatchWasm, isEmptyPatchWasm, viaOps} from './ops-engine';

// A change to a file, at the granularity the editor and the server both understand: whole nodes,
// styles, images and variables are replaced or removed (null). Undo/redo, autosave (PATCH
// /api/design-files/:id) and version restore all move documents with these.

export type DocumentPatch = {
  nodes?: Record<NodeId, SceneNode | null>;
  /** The full new page order, when it changed. */
  pages?: NodeId[];
  styles?: Record<StyleId, Style | null>;
  images?: Record<ImageRef, ImageAsset | null>;
  variableCollections?: Record<string, VariableCollection | null>;
  variables?: Record<VariableId, Variable | null>;
  variableModes?: Record<NodeId, Record<string, string> | null>;
};

type Table = 'nodes' | 'styles' | 'images' | 'variableCollections' | 'variables' | 'variableModes';
const TABLES: readonly Table[] = ['nodes', 'styles', 'images', 'variableCollections', 'variables', 'variableModes'];

const isEmptyPatchTs = (patch: DocumentPatch) => !patch.pages && TABLES.every(table => !patch[table] || !Object.keys(patch[table]!).length);

/** A new document with the patch applied. Untouched tables and entries keep their identity, and
 *  indexes cached for the old node table that the patch leaves valid are carried to the new one
 *  (undo and redo then never rescan the file for them). `nodesCopy`: a private copy of `doc.nodes`
 *  the caller hands over (made ahead of time), written into instead of copying the table now. */
function applyPatchTs(doc: DesignDocument, patch: DocumentPatch, nodesCopy?: Record<NodeId, SceneNode>): DesignDocument {
  const next: DesignDocument = {...doc};
  if (patch.pages) next.pages = [...patch.pages];
  for (const table of TABLES) {
    const changes = patch[table] as Record<string, unknown> | undefined;
    if (!changes) continue;
    const keys = Object.keys(changes);
    if (!keys.length) continue;
    if (table === 'nodes' && nodesCopy === doc.nodes) {
      // In place (the editor's store): the document's own table takes the writes, logged, its indexes
      // derived for them. The document before survives as the inverse the caller took first.
      applyEntriesInPlace(nodesCopy, patch.nodes!);
      continue;
    }
    const copy: Record<string, unknown> = table === 'nodes' && nodesCopy ? nodesCopy : copyTable((doc[table] as Record<string, unknown> | undefined) ?? {});
    for (const key of keys) {
      const value = changes[key];
      if (value === null) delete copy[key];
      else copy[key] = value;
    }
    (next as Record<Table, unknown>)[table] = copy;
    if (table === 'nodes') carryTableCaches(doc.nodes, next.nodes, keys);
  }
  return next;
}

/** The patch that takes `applyPatch(doc, patch)` back to `doc`. */
function invertPatchTs(doc: DesignDocument, patch: DocumentPatch): DocumentPatch {
  const inverse: DocumentPatch = {};
  if (patch.pages) inverse.pages = [...doc.pages];
  for (const table of TABLES) {
    const changes = patch[table] as Record<string, unknown> | undefined;
    if (!changes) continue;
    const before = (doc[table] as Record<string, unknown> | undefined) ?? {};
    const undo: Record<string, unknown> = {};
    for (const key of Object.keys(changes)) undo[key] = key in before ? before[key] : null;
    (inverse as Record<Table, unknown>)[table] = undo;
  }
  return inverse;
}

/** One patch with the effect of `first` then `second`. */
function composePatchesTs(first: DocumentPatch, second: DocumentPatch): DocumentPatch {
  const out: DocumentPatch = {};
  const pages = second.pages ?? first.pages;
  if (pages) out.pages = [...pages];
  for (const table of TABLES) {
    const a = first[table] as Record<string, unknown> | undefined, b = second[table] as Record<string, unknown> | undefined;
    if (!a && !b) continue;
    (out as Record<Table, unknown>)[table] = {...(a ?? {}), ...(b ?? {})};
  }
  return out;
}

/** The patch that turns `before` into `after`, comparing entries by identity (immutable updates). */
function diffDocumentsTs(before: DesignDocument, after: DesignDocument): DocumentPatch {
  const patch: DocumentPatch = {};
  if (before.pages !== after.pages && (before.pages.length !== after.pages.length || before.pages.some((id, i) => id !== after.pages[i]))) patch.pages = [...after.pages];
  for (const table of TABLES) {
    const a = (before[table] as Record<string, unknown> | undefined) ?? {}, b = (after[table] as Record<string, unknown> | undefined) ?? {};
    if (a === b) continue;
    const changes: Record<string, unknown> = {};
    for (const key of Object.keys(b)) if (a[key] !== b[key]) changes[key] = b[key];
    for (const key of Object.keys(a)) if (!(key in b)) changes[key] = null;
    if (Object.keys(changes).length) (patch as Record<Table, unknown>)[table] = changes;
  }
  return patch;
}

// The ops engine switch (shared/design/engine-switch.ts, lane L2a: crates/ops through crates/wasm): `ts` runs the
// functions above, `wasm` the Rust port, `both` both with the answers compared exactly.

export const isEmptyPatch = (patch: DocumentPatch): boolean =>
  engineTs('ops') ? isEmptyPatchTs(patch) : viaOps('isEmptyPatch', () => isEmptyPatchTs(patch), () => isEmptyPatchWasm(patch), () => [patch]);

/** A new document with the patch applied. Untouched tables and entries keep their identity, and
 *  indexes cached for the old node table that the patch leaves valid are carried to the new one
 *  (undo and redo then never rescan the file for them). `nodesCopy`: a private copy of `doc.nodes`
 *  the caller hands over (made ahead of time), written into instead of copying the table now. */
export function applyPatch(doc: DesignDocument, patch: DocumentPatch, nodesCopy?: Record<NodeId, SceneNode>): DesignDocument {
  if (engineTs('ops')) return applyPatchTs(doc, patch, nodesCopy);
  // In `both` the TypeScript has written into `nodesCopy` already: the wasm side makes its own copy.
  return viaOps(
    'applyPatch',
    () => applyPatchTs(doc, patch, nodesCopy),
    () => applyPatchWasm(doc, patch, engineFor('ops') === 'both' ? undefined : nodesCopy),
    () => [doc, patch],
  );
}

/** The patch that takes `applyPatch(doc, patch)` back to `doc`. */
export function invertPatch(doc: DesignDocument, patch: DocumentPatch): DocumentPatch {
  return engineTs('ops') ? invertPatchTs(doc, patch) : viaOps('invertPatch', () => invertPatchTs(doc, patch), () => invertPatchWasm(doc, patch), () => [doc, patch]);
}

/** One patch with the effect of `first` then `second`. */
export function composePatches(first: DocumentPatch, second: DocumentPatch): DocumentPatch {
  return engineTs('ops') ? composePatchesTs(first, second) : viaOps('composePatches', () => composePatchesTs(first, second), () => composePatchesWasm(first, second), () => [first, second]);
}

/** The patch that turns `before` into `after`, comparing entries by identity (immutable updates). */
export function diffDocuments(before: DesignDocument, after: DesignDocument): DocumentPatch {
  return engineTs('ops') ? diffDocumentsTs(before, after) : viaOps('diffDocuments', () => diffDocumentsTs(before, after), () => diffDocumentsWasm(before, after), () => [before, after]);
}
