import {bigFilesEnabled} from '../../shared/design/big-files';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import type {DocumentPatch} from '../../shared/design/patch';
import {forgetTable} from '../../shared/design/table-cache';

// The last parsed document of recently edited files, so an autosave patch does not read and parse a 20 MB
// file on every save. An entry is the document of one exact (file, owner, version): versions only grow and
// every document write makes a new one, so an entry is never stale, only unused. Documents are immutable
// (shared/design/patch.ts keeps untouched entries by identity); nothing may mutate a cached one.
//
// The node table of the version before. A save makes the next document from
// the cached one by copying its node table (20 000 keys: ~6 ms and its garbage, the save's largest cost). Instead the
// entry keeps the previous version's table, with the patches since, as a spare: once no document handed out uses it,
// the next save brings it up to date with those few entries and writes its own change into it (`takeSpareNodes`). A
// table that left the cache's hands (`storedDocument`, a reader that may hold the document across an await) is lent
// and never reused; the save path and the text readers, which use it only synchronously, do not lend it.

type Spare = {nodes: Record<NodeId, SceneNode>; patches: DocumentPatch[]};
type Entry = {userId: string; version: number; doc: DesignDocument; bytes: number; spare?: Spare};
/** Node tables of documents handed to readers that may keep them: never written again. */
const lent = new WeakSet<object>();
const recycled = {taken: 0, refused: 0};

/** A reader may hold `doc` past this moment: its node table is never reused. */
export const lendDocument = (doc: DesignDocument): void => void lent.add(doc.nodes);

/** For tests and benches: how many saves wrote into a reused table, and how many found the spare lent. */
export const recycledTables = () => ({...recycled});

/**
 * The node table of an older version of `fileId`, brought to the entries of `doc` (the cached document): the caller's
 * to write `doc`'s next version into (applyPatch's `nodesCopy`). Undefined when there is none, it is lent, or the cache
 * moved on. Taken once: a write that fails leaves the cache without a spare, never with a wrong one.
 */
export function takeSpareNodes(fileId: string, doc: DesignDocument): Record<NodeId, SceneNode> | undefined {
  const entry = entries.get(fileId);
  const spare = entry?.doc === doc ? entry.spare : undefined;
  if (!entry || !spare) return undefined;
  entry.spare = undefined;
  if (lent.has(spare.nodes) || spare.nodes === doc.nodes) {
    recycled.refused++;
    return undefined;
  }
  // Indexes derived from the table's older contents go; applyPatch carries `doc`'s own to it afterwards.
  forgetTable(spare.nodes);
  const nodes = spare.nodes;
  for (const patch of spare.patches)
    for (const [id, node] of Object.entries(patch.nodes ?? {})) {
      if (node === null) delete nodes[id];
      else nodes[id] = node;
    }
  recycled.taken++;
  return nodes;
}
const entries = new Map<string, Entry>();
let total = 0;

/** DESIGN_DOCUMENT_CACHE_BYTES: JSON bytes kept parsed (64 MB by default, 512 MB with the big-files switch on, so a 100 MB
 *  file's skeleton and pages are read from one parsed copy — docs/decisions/big-files.md §3; 0 turns the cache off). */
function budget() {
  const value = Number(process.env.DESIGN_DOCUMENT_CACHE_BYTES ?? (bigFilesEnabled() ? 512 : 64) * 1024 * 1024);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Whether a document of `bytes` JSON bytes is kept parsed here (rememberDocument's rule): one that is not is parsed again on every
 *  read (lane O: the skeleton read then sends such a file whole instead, files.ts `openDesignSkeleton`). */
export const keepsParsed = (bytes: number): boolean => bytes <= budget() / 2;

export function cachedDocument(fileId: string, userId: string, version: number): DesignDocument | undefined {
  const entry = entries.get(fileId);
  if (!entry || entry.userId !== userId || entry.version !== version) return undefined;
  entries.delete(fileId);
  entries.set(fileId, entry);
  return entry.doc;
}

/** The document this process holds for the file at whatever version it is (document-store.ts catches it up with the changes
 *  after it when another process saved meanwhile). */
export function cachedEntry(fileId: string, userId: string): {version: number; doc: DesignDocument} | undefined {
  const entry = entries.get(fileId);
  return entry && entry.userId === userId ? {version: entry.version, doc: entry.doc} : undefined;
}

export function forgetDocument(fileId: string) {
  const entry = entries.get(fileId);
  if (!entry) return;
  entries.delete(fileId);
  total -= entry.bytes;
}

/** `from`: the cached document `doc` was made from and the patches between them: its node table becomes the spare. */
export function rememberDocument(fileId: string, userId: string, version: number, doc: DesignDocument, bytes: number, from?: {doc: DesignDocument; patches: DocumentPatch[]}) {
  const previous = entries.get(fileId);
  forgetDocument(fileId);
  const limit = budget();
  if (bytes > limit / 2) return;
  const spare =
    from && previous?.doc === from.doc && previous.userId === userId && from.doc.nodes !== doc.nodes && !lent.has(from.doc.nodes)
      ? {nodes: from.doc.nodes as Record<NodeId, SceneNode>, patches: from.patches}
      : undefined;
  entries.set(fileId, {userId, version, doc, bytes, ...(spare ? {spare} : {})});
  total += bytes;
  for (const [key, entry] of entries) {
    if (total <= limit) break;
    entries.delete(key);
    total -= entry.bytes;
  }
}
