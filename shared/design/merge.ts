import type {DesignDocument, Matrix, NodeId, SceneNode, TextProps} from './types';
import {CONTAINER_TYPES, LIBRARY_PAGE_ID} from './types';
import type {DocumentPatch} from './patch';
import {localMatrix, multiply} from './geometry';
import {placementFor} from './transaction';
import {caretStyleAt, insertText, sameValue} from './text-edit';
import {DESIGN_FIELD_LIMITS} from './document-limits';
import {engineTs} from './engine-switch';
import {mergeChangeWasm, mergeListWasm, rebaseLocalWasm, rememberTarget, textEditWasm, viaOps} from './ops-engine';

// Co-editing (docs/design-tool.md §Teams, "Co-editing"): a change made on an older version of a file
// lands on the newer one field by field. The server runs this for every autosave patch whose `baseVersion` is behind,
// and every editor runs the same function to rebase its unsaved changes over the changes of others, so both sides
// reach the same document. Pure and deterministic: the same target and change give the same result on any machine.
//
// The rules, in short (the doc has the long version):
// - Fields: a field the change did not touch keeps the target's value; a field it did touch takes the change's
//   value (the later writer wins, as in Figma). Records keyed by id (auto layout, bound variables, component
//   properties, plugin data, a variable's values by mode) merge one level deeper; `overrides` merges as a set; lists of
//   entries with ids (a layer's annotations, a page's measurements) merge entry by entry.
// - Text: the characters of a text layer merge when the two edits touch different places; otherwise the later wins.
// - Structure: `parentId` decides where a layer lives and each `children` list is rebuilt from it, keeping the target's
//   order and placing what the change moved after the change's own neighbours. A move into a layer that no longer
//   exists, or one that would make a cycle, is refused (the layer stays where the target has it).
// - Removal: an edit of a layer someone removed is dropped (removal wins); a removal takes what its author saw, and a
//   layer someone else added or moved into the removed part meanwhile moves up to the nearest surviving ancestor in
//   place (no one loses work they could not see removed). A new layer whose parent was removed moves up the same way.
//   Instance copies are never moved out of their instance: they go with it.
// - A group or boolean left without layers is removed; the last page is never removed.

export type MergeTable = 'styles' | 'images' | 'variableCollections' | 'variables' | 'variableModes';
const TABLES: readonly MergeTable[] = ['styles', 'images', 'variableCollections', 'variables', 'variableModes'];

/** What a merge reads of the document a change lands on. */
export interface MergeTarget {
  pages(): readonly NodeId[];
  node(id: NodeId): SceneNode | undefined;
  /** The entry, or undefined when the table has none. */
  entry(table: MergeTable, key: string): unknown;
}

const own = <T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);

export function documentTarget(doc: DesignDocument): MergeTarget {
  const target: MergeTarget = {
    pages: () => doc.pages,
    node: id => own(doc.nodes, id),
    entry: (table, key) => own(doc[table] as Record<string, unknown> | undefined, key),
  };
  // The ops engine's wasm side reads the document itself, by id (shared/design/ops-engine.ts).
  rememberTarget(target, doc);
  return target;
}

export type MergeOutcome = {
  /** Entries to write onto the target (whole entries, null removes), and the page order when it changes. */
  patch: DocumentPatch;
  /** The change did not land as it was sent: a field, a move, a removal or a text was adjusted. */
  adjusted: boolean;
};

/** Deep equality of stored values (an absent key and an undefined one are the same). */
export const same = sameValue;

const CONTAINERS = new Set<string>(CONTAINER_TYPES);
const STRUCTURE = new Set(['id', 'parentId', 'children']);
/** Node fields whose value is a record of independent entries: merged entry by entry. */
// `board` (docs/board.md): a connector's two ends and its line merge one by one, so two people moving its two ends both land.
const NODE_RECORDS = new Set(['autoLayout', 'boundVariables', 'componentProperties', 'componentPropertyDefinitions', 'pluginData', 'constraints', 'board', 'grid', 'gridChild']);
/** Node fields whose value is a list of entries with an `id` (a layer's annotations, a page's measurements): merged entry
 *  by entry, so two people pinning notes or measurements at once both keep theirs. */
const NODE_ENTRY_LISTS = new Set(['annotations', 'measurements']);
/** A walk up the tree longer than this is a cycle (the schema allows `depth` levels). */
const WALK_LIMIT = DESIGN_FIELD_LIMITS.depth + 8;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `theirs` with the record entries `ours` changed against `base`. */
function mergeRecord(base: Record<string, unknown>, ours: Record<string, unknown>, theirs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {...theirs};
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (same(base[key], ours[key])) continue;
    if (ours[key] === undefined) delete out[key];
    else out[key] = ours[key];
  }
  return out;
}

/** A set of strings: what `ours` added and removed, applied to `theirs` (order: theirs, then additions). */
function mergeSet(base: readonly string[] | undefined, ours: readonly string[] | undefined, theirs: readonly string[] | undefined): string[] | undefined {
  const b = new Set(base ?? []), o = new Set(ours ?? []);
  const out = (theirs ?? []).filter(value => !(b.has(value) && !o.has(value)));
  const seen = new Set(out);
  for (const value of ours ?? []) if (!b.has(value) && !seen.has(value)) {
    seen.add(value);
    out.push(value);
  }
  return out.length || ours ? out : undefined;
}

/** A list of `{id}` entries: `theirs` without what `ours` removed, with what `ours` added or changed (the later writer wins
 *  an entry both changed; a removal wins over a change), in `ours`'s order where it moved entries. Undefined when empty. */
type Entry = {id: string};
function mergeEntries(base: readonly Entry[] | undefined, ours: readonly Entry[], theirs: readonly Entry[] | undefined): Entry[] | undefined {
  const b = new Map((base ?? []).map(entry => [entry.id, entry])), o = new Map(ours.map(entry => [entry.id, entry]));
  const value = new Map<string, Entry>();
  for (const entry of theirs ?? []) {
    if (b.has(entry.id) && !o.has(entry.id)) continue;
    const mine = o.get(entry.id);
    value.set(entry.id, mine && !same(b.get(entry.id), mine) ? mine : entry);
  }
  const added: string[] = [];
  for (const entry of ours) if (!b.has(entry.id) && !value.has(entry.id)) {
    value.set(entry.id, entry);
    added.push(entry.id);
  }
  if (!value.size) return undefined;
  const list = [...(theirs ?? []).map(entry => entry.id).filter(id => value.has(id)), ...added];
  return mergeListTs(list, [...b.keys()], [...o.keys()], id => value.has(id)).map(id => value.get(id)!);
}

// ── Text ───────────────────────────────────────────────────────────────────────────────────────

/** The one replacement that turns `a` into `b`: [start, end) of `a` becomes `inserted`. */
function textEditTs(a: string, b: string): {start: number; end: number; inserted: string} | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  return {start: prefix, end: a.length - suffix, inserted: b.slice(prefix, b.length - suffix)};
}

const contentOf = (text: TextProps) => [text.characters, text.runs, text.listTypes] as const;
const sameContent = (a: TextProps, b: TextProps) => a.characters === b.characters && same(a.runs, b.runs) && same(a.listTypes, b.listTypes);

/**
 * The text content (characters, runs, list types) when both sides changed it: `ours`'s edit replayed on `theirs` when
 * it is one replacement of the characters that does not overlap `theirs`'s, else null (the later writer wins).
 */
function mergeTextContent(base: TextProps, ours: TextProps, theirs: TextProps): TextProps | null {
  const mine = textEditTs(base.characters, ours.characters), other = textEditTs(base.characters, theirs.characters);
  if (!mine || !other) return null;
  let at: number,
    replaced = 0;
  if (mine.start === mine.end && other.start === other.end && mine.start === other.start) {
    // Ours goes on from what theirs typed there: the same typing, once. A save sent again after its answer was lost (it had
    // landed) carries what landed plus what was typed since; adding it after theirs would type the landed part twice.
    if (mine.inserted.startsWith(other.inserted)) {
      at = mine.start;
      replaced = other.inserted.length;
    } else at = mine.start + other.inserted.length; // both typed at one place: theirs first
  } else if (mine.end <= other.start) at = mine.start;
  else if (other.end <= mine.start) at = mine.start + other.inserted.length - (other.end - other.start);
  else return null; // the edits overlap: the later writer decides
  // Ours must be exactly that replacement (typing, deleting, pasting one style): otherwise it also restyled text.
  const style = mine.inserted ? caretStyleAt(ours, mine.start, mine.start + mine.inserted.length) : null;
  const replayed = insertText(base, mine.start, mine.end, mine.inserted, style);
  if (!same(replayed.runs, ours.runs) || !same(replayed.listTypes, ours.listTypes)) return null;
  const merged = insertText(theirs, at, at + (mine.end - mine.start) + replaced, mine.inserted, style);
  if (merged.characters.length > DESIGN_FIELD_LIMITS.characters) return null;
  return merged;
}

/** A text layer's `text`: its content as above, its other fields (base style, alignment, sizing...) one by one. */
function mergeText(base: TextProps, ours: TextProps, theirs: TextProps): {text: TextProps; adjusted: boolean} {
  const out = mergeRecord(base as unknown as Record<string, unknown>, ours as unknown as Record<string, unknown>, theirs as unknown as Record<string, unknown>) as unknown as TextProps;
  const oursChanged = !sameContent(base, ours), theirsChanged = !sameContent(base, theirs);
  let content: TextProps = theirs, adjusted = false;
  if (oursChanged && !theirsChanged) content = ours;
  // The same edit on both sides (above all a save sent again after its answer was lost, which the server already holds): once.
  else if (oursChanged && theirsChanged && sameContent(ours, theirs)) content = theirs;
  else if (oursChanged && theirsChanged) {
    const merged = mergeTextContent(base, ours, theirs);
    content = merged ?? ours;
    adjusted = !!merged;
  }
  const [characters, runs, listTypes] = contentOf(content);
  const text: TextProps = {...out, characters, runs};
  if (listTypes) text.listTypes = listTypes;
  else delete text.listTypes;
  return {text, adjusted};
}

// ── Fields ─────────────────────────────────────────────────────────────────────────────────────

/** `theirs` with every field `ours` changed against `base` (structure aside). Null when nothing differs from theirs. */
function mergeNodeFields(base: SceneNode, ours: SceneNode, theirs: SceneNode): {node: SceneNode; adjusted: boolean} {
  const out = {...theirs} as unknown as Record<string, unknown>;
  const b = base as unknown as Record<string, unknown>, o = ours as unknown as Record<string, unknown>, t = theirs as unknown as Record<string, unknown>;
  let adjusted = false;
  for (const key of new Set([...Object.keys(b), ...Object.keys(o)])) {
    if (STRUCTURE.has(key)) continue;
    const before = b[key], after = o[key];
    if (before === after || same(before, after)) {
      if (!same(t[key], after)) adjusted = true;
      continue;
    }
    if (after === undefined) {
      delete out[key];
      continue;
    }
    if (key === 'text' && before && t.text) {
      const merged = mergeText(before as TextProps, after as TextProps, t.text as TextProps);
      out.text = merged.text;
      adjusted ||= merged.adjusted;
    } else if (key === 'overrides') out.overrides = mergeSet(before as string[] | undefined, after as string[], t.overrides as string[] | undefined);
    else if (NODE_ENTRY_LISTS.has(key) && (before === undefined || Array.isArray(before)) && Array.isArray(after) && (t[key] === undefined || Array.isArray(t[key]))) {
      const merged = mergeEntries(before as Entry[] | undefined, after as Entry[], t[key] as Entry[] | undefined);
      if (merged) out[key] = merged;
      else delete out[key];
      if (!same(out[key], after)) adjusted = true;
    } else if (NODE_RECORDS.has(key) && isPlainObject(before) && isPlainObject(after) && isPlainObject(t[key])) {
      out[key] = mergeRecord(before, after, t[key] as Record<string, unknown>);
      if (!same(out[key], after)) adjusted = true;
    } else out[key] = after;
  }
  return {node: out as unknown as SceneNode, adjusted};
}

/** A table entry (style, picture, variable...) field by field; a variable's values by mode and a mode choice entry by entry. */
function mergeEntryFields(table: MergeTable, base: Record<string, unknown>, ours: Record<string, unknown>, theirs: Record<string, unknown>, keepVariable: (id: string) => boolean): Record<string, unknown> {
  if (table === 'variableModes') return mergeRecord(base, ours, theirs);
  const out: Record<string, unknown> = {...theirs};
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    const before = base[key], after = ours[key];
    if (same(before, after)) continue;
    if (after === undefined) delete out[key];
    else if (table === 'variables' && key === 'valuesByMode' && isPlainObject(before) && isPlainObject(after) && isPlainObject(theirs[key])) out[key] = mergeRecord(before, after, theirs[key] as Record<string, unknown>);
    else if (table === 'variableCollections' && key === 'variableIds' && Array.isArray(before) && Array.isArray(after) && Array.isArray(theirs[key]))
      out[key] = mergeListTs(theirs[key] as string[], before as string[], after as string[], keepVariable);
    else out[key] = after;
  }
  return out;
}

// ── Lists ──────────────────────────────────────────────────────────────────────────────────────

/** Indexes (into `values`) of a longest strictly increasing subsequence. */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = [], previous = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) out.add(i);
  return out;
}

/**
 * A list of ids (a layer's children, the pages, a collection's variables) after `ours` reordered `base`: `list` is the
 * target's list, already holding exactly the ids that belong (`keep`). Ids `ours` added or moved out of order are taken
 * out and put back before the next id `ours` kept in its order (at the end when none follows); every other id keeps
 * the target's order. Linear in the lists' lengths.
 */
function mergeListTs(list: readonly string[], base: readonly string[], ours: readonly string[], keep: (id: string) => boolean): string[] {
  const basePos = new Map<string, number>();
  base.forEach((id, i) => basePos.set(id, i));
  const common: number[] = [], commonIds: string[] = [];
  for (const id of ours) if (basePos.has(id)) {
    common.push(basePos.get(id)!);
    commonIds.push(id);
  }
  const steady = new Set<string>();
  for (const i of longestIncreasing(common)) steady.add(commonIds[i]);
  const moved = new Set(ours.filter(id => !steady.has(id) && keep(id)));
  if (!moved.size) return list.filter(keep);
  const listed = new Set(list);
  // Each moved id goes before the next steady id ours lists after it that the target still holds here.
  const before = new Map<string, string[]>(), tail: string[] = [];
  let anchor: string | null = null;
  for (let i = ours.length - 1; i >= 0; i--) {
    const id = ours[i];
    if (steady.has(id)) {
      if (listed.has(id) && keep(id)) anchor = id;
      continue;
    }
    if (!moved.has(id)) continue;
    let bucket = anchor === null ? tail : before.get(anchor);
    if (!bucket) before.set(anchor!, (bucket = []));
    bucket.push(id);
  }
  const out: string[] = [];
  for (const id of list) {
    if (moved.has(id) || !keep(id)) continue;
    const bucket = before.get(id);
    if (bucket) for (let i = bucket.length - 1; i >= 0; i--) out.push(bucket[i]);
    out.push(id);
  }
  for (let i = tail.length - 1; i >= 0; i--) out.push(tail[i]);
  return out;
}

// ── The merge ──────────────────────────────────────────────────────────────────────────────────

/**
 * `change` (entries after it) made by someone whose copy of each entry was `before` (null: absent; an entry without a
 * before copy is taken whole, as the last writer's), landed on `target`: the entries to write. With nothing changed
 * on the target since `before`, the result is `change` itself (same values).
 */
function mergeChangeTs(target: MergeTarget, change: DocumentPatch, before: DocumentPatch | undefined): MergeOutcome {
  const out: DocumentPatch = {};
  let adjusted = false;
  const P = change.nodes ?? {}, B = before?.nodes ?? {};
  const hasBefore = (id: string) => Object.hasOwn(B, id);
  const baseOf = (id: string): SceneNode | null => (hasBefore(id) ? B[id] : target.node(id) ?? null);
  const ids = Object.keys(P).sort();

  const created = new Set<string>(), edited = new Set<string>(), removing = new Set<string>();
  for (const id of ids) {
    const ours = P[id], current = target.node(id), base = baseOf(id);
    if (ours === null) {
      if (current) removing.add(id);
      continue;
    }
    if (!current) {
      // Removed by someone else meanwhile: removal wins over the edit.
      if (base === null) created.add(id);
      else adjusted = true;
      continue;
    }
    edited.add(id);
  }

  const exists = (id: string | null | undefined): id is string => !!id && (created.has(id) || !!target.node(id));
  const typeOf = (id: string) => (own(P, id) ?? target.node(id))?.type;
  // Where each layer ends up: the change's move when it can land, else where the target has it.
  const finalParent = new Map<string, string | null>();
  const parentNow = (id: string): string | null => {
    if (finalParent.has(id)) return finalParent.get(id)!;
    if (created.has(id)) return P[id]!.parentId;
    return target.node(id)?.parentId ?? null;
  };
  const createsCycle = (id: string, parent: string) => {
    let at: string | null = parent;
    for (let steps = 0; at !== null; steps++) {
      if (at === id || steps > WALK_LIMIT) return true;
      at = parentNow(at);
    }
    return false;
  };
  const canHold = (parent: string, child: SceneNode) => {
    const type = typeOf(parent);
    return !!type && CONTAINERS.has(type) && child.type !== 'PAGE';
  };
  const orphans: string[] = [];
  for (const id of ids) {
    if (!created.has(id) && !edited.has(id)) continue;
    const ours = P[id]!;
    if (ours.type === 'PAGE') {
      finalParent.set(id, null);
      continue;
    }
    const current = target.node(id), base = baseOf(id);
    const want = created.has(id) || !base || ours.parentId !== base.parentId ? ours.parentId : current!.parentId;
    if (current && want === current.parentId) {
      finalParent.set(id, want);
      continue;
    }
    if (want !== null && exists(want) && canHold(want, ours) && !createsCycle(id, want)) {
      finalParent.set(id, want);
      continue;
    }
    adjusted = true;
    if (current) finalParent.set(id, current.parentId);
    else orphans.push(id);
  }

  // Pages: the change's order merged into the target's; the last page is never removed. The hidden page of library copies
  // (LIBRARY_PAGE_ID) is a page node that is never listed: none of these rules is about it.
  const listedPage = (id: string) => P[id]!.type === 'PAGE' && id !== LIBRARY_PAGE_ID;
  const pageRemovals = new Set([...removing].filter(id => id !== LIBRARY_PAGE_ID && target.node(id)?.type === 'PAGE'));
  const survivingPages = target.pages().filter(id => !pageRemovals.has(id)).length + [...created].filter(listedPage).length;
  if (!survivingPages && pageRemovals.size) {
    const keepPage = target.pages().find(id => pageRemovals.has(id))!;
    removing.delete(keepPage);
    pageRemovals.delete(keepPage);
    adjusted = true;
  }

  // Removal: what the remover saw goes; what someone else put into it meanwhile is rescued.
  const roots = new Set<string>();
  for (const id of removing) {
    const base = baseOf(id) ?? target.node(id)!;
    if (base.parentId === null || !removing.has(base.parentId)) roots.add(id);
  }
  const removedMemo = new Map<string, boolean>();
  const removedByChange = (id: string): boolean => {
    const known = removedMemo.get(id);
    if (known !== undefined) return known;
    let result = false;
    if (removing.has(id) && target.node(id)) {
      if (roots.has(id)) result = true;
      else {
        const parent = parentNow(id);
        result = parent !== null && removing.has(parent) && removedByChange(parent);
      }
    }
    removedMemo.set(id, result);
    return result;
  };
  const gone = new Set<string>();
  for (const id of [...removing].sort()) if (removedByChange(id)) gone.add(id);
  for (const id of removing) if (!gone.has(id)) adjusted = true;

  const alive = (id: string) => exists(id) && !gone.has(id);
  const firstPage = () => {
    const page = target.pages().find(id => alive(id)) ?? [...created].sort().find(listedPage);
    return page ?? null;
  };

  // Layers that change parent without the change asking (rescued), with their new placement.
  const rescued = new Map<string, {parent: string; matrix: Matrix | null}>();
  const extra = new Map<string, string[]>();
  const addExtra = (parent: string, id: string) => (extra.get(parent) ?? (extra.set(parent, []), extra.get(parent)!)).push(id);

  /** The nearest living ancestor above `start` (a removed layer), and the local matrices of the removed ones on the way. */
  const survivor = (start: string, lookup: (id: string) => SceneNode | null | undefined): {parent: string | null; chain: SceneNode[]} => {
    const chain: SceneNode[] = [];
    let at: string | null = start;
    for (let steps = 0; at !== null && !alive(at) && steps <= WALK_LIMIT; steps++) {
      const node = lookup(at);
      if (!node) return {parent: firstPage(), chain};
      chain.push(node);
      at = node.parentId;
    }
    if (at === null || !alive(at)) return {parent: firstPage(), chain};
    return {parent: at, chain};
  };
  const carried = (node: SceneNode, chain: readonly SceneNode[]): Matrix | null => {
    if (!chain.length) return null;
    let m = localMatrix(node);
    for (const ancestor of chain) if (ancestor.type !== 'PAGE') m = multiply(localMatrix(ancestor), m);
    return m;
  };
  const dropped = new Set<string>();
  /** An instance copy cannot leave its instance: it goes, with everything under it. */
  const drop = (id: string) => {
    const queue = [id];
    for (let at = 0; at < queue.length; at++) {
      const nodeId = queue[at];
      if (dropped.has(nodeId)) continue;
      dropped.add(nodeId);
      const node = created.has(nodeId) ? P[nodeId]! : target.node(nodeId);
      for (const child of node?.children ?? []) queue.push(child);
    }
  };

  // New layers whose parent was removed by someone else move up, keeping their place on the page.
  for (const id of orphans) {
    const ours = P[id]!;
    if (ours.mainId !== undefined) {
      drop(id);
      continue;
    }
    const {parent, chain} = survivor(ours.parentId!, at => (hasBefore(at) ? B[at] : null));
    if (parent === null) {
      drop(id);
      continue;
    }
    finalParent.set(id, parent);
    rescued.set(id, {parent, matrix: carried(ours, chain)});
    addExtra(parent, id);
  }
  // Layers under removed ones that the remover did not remove (added or moved there by someone else) move up.
  const removedParents = [...gone].sort();
  for (const removed of removedParents) {
    const node = target.node(removed);
    for (const child of node?.children ?? []) {
      if (gone.has(child) || parentNow(child) !== removed || dropped.has(child)) continue;
      const kept = own(P, child) ?? target.node(child);
      if (!kept) continue;
      adjusted = true;
      if (kept.mainId !== undefined) {
        drop(child);
        continue;
      }
      const {parent, chain} = survivor(removed, at => target.node(at));
      if (parent === null) {
        drop(child);
        continue;
      }
      finalParent.set(child, parent);
      rescued.set(child, {parent, matrix: carried(kept, chain)});
      addExtra(parent, child);
    }
  }
  for (const id of dropped) gone.add(id);

  // Children lists of every parent the change or the rules above touched.
  const affected = new Set<string>();
  const parentOfNow = (id: string) => (created.has(id) ? P[id]!.parentId : target.node(id)?.parentId ?? null);
  for (const id of ids) {
    const ours = P[id];
    if (ours && CONTAINERS.has(ours.type) && (created.has(id) || !same(baseOf(id)?.children, ours.children))) affected.add(id);
  }
  for (const [id, parent] of finalParent) {
    const was = target.node(id)?.parentId ?? null;
    if (was !== parent) {
      if (was !== null) affected.add(was);
      if (parent !== null) affected.add(parent);
    }
  }
  for (const id of gone) {
    const parent = target.node(id)?.parentId ?? parentOfNow(id);
    if (parent !== null) affected.add(parent);
  }
  for (const parent of extra.keys()) affected.add(parent);

  // Layers that arrive under a parent by an accepted move, in id order.
  const arriving = new Map<string, string[]>();
  for (const id of [...finalParent.keys()].sort()) {
    const parent = finalParent.get(id)!;
    if (parent === null || rescued.has(id) || parent === target.node(id)?.parentId) continue;
    let bucket = arriving.get(parent);
    if (!bucket) arriving.set(parent, (bucket = []));
    bucket.push(id);
  }
  const lists = new Map<string, string[]>();
  const belongs = (parent: string) => (id: string) => alive(id) && !gone.has(id) && parentNow(id) === parent;
  const listOf = (parent: string): string[] => {
    const keep = belongs(parent);
    const ours = own(P, parent);
    let list: string[];
    if (created.has(parent)) list = (ours!.children ?? []).filter(keep);
    else {
      list = (target.node(parent)!.children ?? []).filter(keep);
      if (ours && !same(baseOf(parent)?.children, ours.children)) list = mergeListTs(list, baseOf(parent)?.children ?? [], ours.children ?? [], keep);
    }
    const listed = new Set(list);
    // Accepted moves the change's list does not order (a parent it did not send) and rescued layers: on top.
    for (const id of arriving.get(parent) ?? []) if (!listed.has(id) && keep(id)) {
      list.push(id);
      listed.add(id);
    }
    for (const id of extra.get(parent) ?? []) if (!listed.has(id) && keep(id)) {
      list.push(id);
      listed.add(id);
    }
    return list;
  };
  // Groups and booleans left empty go too (and may empty their own parent).
  const pendingParents = [...affected].sort();
  while (pendingParents.length) {
    const parent = pendingParents.shift()!;
    if (!alive(parent) || gone.has(parent)) continue;
    const list = listOf(parent);
    lists.set(parent, list);
    const type = typeOf(parent);
    if (!list.length && (type === 'GROUP' || type === 'BOOLEAN_OPERATION')) {
      gone.add(parent);
      adjusted = true;
      const up = parentNow(parent);
      if (up !== null && !pendingParents.includes(up)) pendingParents.push(up);
      lists.delete(parent);
    }
  }

  // The node entries.
  const nodes: Record<string, SceneNode | null> = {};
  const write = (id: string, node: SceneNode | null) => {
    nodes[id] = node;
  };
  for (const id of gone) if (target.node(id)) write(id, null);
  const touched = new Set<string>([...ids, ...lists.keys(), ...finalParent.keys()]);
  for (const id of [...touched].sort()) {
    if (gone.has(id) || !alive(id)) continue;
    const ours = own(P, id), current = target.node(id);
    let node: SceneNode;
    if (created.has(id)) node = {...ours!};
    else if (ours && edited.has(id)) {
      const merged = mergeNodeFields(baseOf(id) ?? current!, ours, current!);
      node = merged.node;
      adjusted ||= merged.adjusted;
    } else node = {...current!};
    const parent = node.type === 'PAGE' ? null : finalParent.has(id) ? finalParent.get(id)! : current?.parentId ?? node.parentId;
    node.parentId = parent;
    const list = lists.get(id);
    if (list) node.children = list;
    else if (!created.has(id) && current && CONTAINERS.has(node.type)) node.children = current.children ?? [];
    else if (created.has(id) && CONTAINERS.has(node.type)) node.children = (node.children ?? []).filter(belongs(id));
    const move = rescued.get(id);
    if (move?.matrix) {
      const placement = placementFor(node, move.matrix);
      node.x = placement.x;
      node.y = placement.y;
      node.rotation = placement.rotation;
      if (placement.flipX) node.flipX = true;
      else delete node.flipX;
      if (placement.flipY) node.flipY = true;
      else delete node.flipY;
    }
    if (current && same(node, current)) continue;
    write(id, node);
  }
  if (Object.keys(nodes).length) out.nodes = nodes;

  // The page order.
  const pageList = target.pages();
  const pageKeep = (id: string) => id !== LIBRARY_PAGE_ID && alive(id) && !gone.has(id) && typeOf(id) === 'PAGE';
  if (change.pages || pageRemovals.size || [...created].some(listedPage)) {
    let pages = pageList.filter(pageKeep);
    if (change.pages) pages = mergeListTs(pages, before?.pages ?? pageList, change.pages, pageKeep);
    const listed = new Set(pages);
    for (const id of [...created].sort()) if (listedPage(id) && !listed.has(id) && pageKeep(id)) pages.push(id);
    if (!same(pages, pageList)) out.pages = pages;
  }

  // The other tables, entry by entry.
  // A variable is there after the merge unless the change removed it, or edited one someone else removed.
  const variableAlive = (id: string) => {
    const ours = own(change.variables, id), current = target.entry('variables', id);
    if (ours === undefined) return current !== undefined;
    if (ours === null) return false;
    if (current !== undefined) return true;
    const base = own(before?.variables, id);
    return base === undefined || base === null;
  };
  for (const table of TABLES) {
    const changes = change[table] as Record<string, unknown> | undefined;
    if (!changes) continue;
    const bases = before?.[table] as Record<string, unknown> | undefined;
    const written: Record<string, unknown> = {};
    for (const key of Object.keys(changes).sort()) {
      const ours = changes[key], current = target.entry(table, key);
      const base = bases && Object.hasOwn(bases, key) ? bases[key] : current ?? null;
      if (ours === null) {
        if (current !== undefined) written[key] = null;
        continue;
      }
      if (table === 'variableModes' && !alive(key)) {
        adjusted = true;
        if (current !== undefined) written[key] = null;
        continue;
      }
      if (current === undefined) {
        if (base === null) written[key] = ours;
        else adjusted = true;
        continue;
      }
      const merged = mergeEntryFields(table, (base ?? current) as Record<string, unknown>, ours as Record<string, unknown>, current as Record<string, unknown>, variableAlive);
      if (!same(merged, ours)) adjusted = true;
      if (!same(merged, current)) written[key] = merged;
    }
    if (Object.keys(written).length) (out as Record<string, unknown>)[table] = written;
  }
  // A removed layer's mode choices go with it.
  for (const id of gone) if (target.entry('variableModes', id) !== undefined) (out.variableModes ??= {})[id] = null;

  return {patch: out, adjusted};
}

// ── An editor's unsaved changes over the server's ──────────────────────────────────────────────

const ALL_TABLES = ['nodes', ...TABLES] as const;
type AnyTable = (typeof ALL_TABLES)[number];
const tableOf = (patch: DocumentPatch, table: AnyTable) => patch[table] as Record<string, unknown> | undefined;

/** What an editor holds: its document, the entries that differ from the server's copy, and the server's copy of them. */
export type LocalChanges = {
  /** The editor's document: the server's copy with the unsaved changes on top. */
  doc: DesignDocument;
  /** Unsaved changes (sent or waiting): the editor's value of each entry that differs from the server's, and the page order. */
  local: DocumentPatch;
  /** The server's value of each entry of `local` (null: absent), and its page order when `local.pages` is set. */
  server: DocumentPatch;
};
export type Rebased = {
  /** Entries (and the page order) to write into the editor's document. */
  display: DocumentPatch;
  /** The unsaved changes after the rebase, and the server's copy of them. */
  local: DocumentPatch;
  server: DocumentPatch;
};

/**
 * The server's copy changed (`change`: its new value of each entry it names — another person's edit, or the server's
 * version of this editor's own): the editor's unsaved changes are put on top of it with `mergeChange`, the same step the
 * server runs when they arrive, so both sides reach the same document. Cost: the changes involved, never the file.
 */
function rebaseLocalTs(state: LocalChanges, change: DocumentPatch): Rebased {
  const {doc, local, server} = state;
  const serverValue = (table: AnyTable, key: string): unknown => {
    const changed = tableOf(change, table);
    if (changed && Object.hasOwn(changed, key)) return changed[key];
    const known = tableOf(server, table);
    if (known && Object.hasOwn(known, key)) return known[key];
    return own(doc[table] as Record<string, unknown> | undefined, key) ?? null;
  };
  const serverPages = change.pages ?? server.pages ?? doc.pages;
  // Nothing the change names is changed here: the unsaved changes stay as they are.
  let overlaps = !!(change.pages && local.pages);
  for (const table of ALL_TABLES) {
    if (overlaps) break;
    const changed = tableOf(change, table), mine = tableOf(local, table);
    if (!changed || !mine) continue;
    for (const key of Object.keys(changed)) if (Object.hasOwn(mine, key)) {
      overlaps = true;
      break;
    }
  }
  const merged = overlaps
    ? mergeChangeTs({pages: () => serverPages, node: id => (serverValue('nodes', id) as SceneNode | null) ?? undefined, entry: (table, key) => serverValue(table, key) ?? undefined}, local, server).patch
    : local;
  const display: DocumentPatch = {}, nextLocal: DocumentPatch = {}, nextServer: DocumentPatch = {};
  for (const table of ALL_TABLES) {
    const keys = new Set([...Object.keys(tableOf(change, table) ?? {}), ...Object.keys(tableOf(local, table) ?? {}), ...Object.keys(tableOf(merged, table) ?? {})]);
    if (!keys.size) continue;
    const shown: Record<string, unknown> = {}, mine: Record<string, unknown> = {}, theirs: Record<string, unknown> = {};
    const result = tableOf(merged, table), current = doc[table] as Record<string, unknown> | undefined;
    for (const key of keys) {
      const value = serverValue(table, key);
      const view = result && Object.hasOwn(result, key) ? result[key] : value;
      if ((view ?? undefined) !== own(current, key)) shown[key] = view;
      if (!same(view, value)) {
        mine[key] = view;
        theirs[key] = value;
      }
    }
    if (Object.keys(shown).length) (display as Record<string, unknown>)[table] = shown;
    if (Object.keys(mine).length) {
      (nextLocal as Record<string, unknown>)[table] = mine;
      (nextServer as Record<string, unknown>)[table] = theirs;
    }
  }
  const pages = overlaps ? merged.pages ?? serverPages : local.pages ?? serverPages;
  if (!same(pages, doc.pages)) display.pages = [...pages];
  if (!same(pages, serverPages)) {
    nextLocal.pages = [...pages];
    nextServer.pages = [...serverPages];
  }
  return {display, local: nextLocal, server: nextServer};
}

// ── The ops engine switch (shared/design/engine-switch.ts, lane L2a) ─────────────────────────────────────────────

/** The one replacement that turns `a` into `b`: [start, end) of `a` becomes `inserted`. */
export function textEdit(a: string, b: string): {start: number; end: number; inserted: string} | null {
  return engineTs('ops') ? textEditTs(a, b) : viaOps('textEdit', () => textEditTs(a, b), () => textEditWasm(a, b), () => [a, b]);
}

/** See `mergeListTs`. */
export function mergeList(list: readonly string[], base: readonly string[], ours: readonly string[], keep: (id: string) => boolean): string[] {
  return engineTs('ops') ? mergeListTs(list, base, ours, keep) : viaOps('mergeList', () => mergeListTs(list, base, ours, keep), () => mergeListWasm(list, base, ours, keep), () => [list, base, ours]);
}

/** See `mergeChangeTs`. */
export function mergeChange(target: MergeTarget, change: DocumentPatch, before: DocumentPatch | undefined): MergeOutcome {
  return engineTs('ops') ? mergeChangeTs(target, change, before) : viaOps('mergeChange', () => mergeChangeTs(target, change, before), () => mergeChangeWasm(target, change, before), () => [change, before]);
}

/** See `rebaseLocalTs`. */
export function rebaseLocal(state: LocalChanges, change: DocumentPatch): Rebased {
  return engineTs('ops') ? rebaseLocalTs(state, change) : viaOps('rebaseLocal', () => rebaseLocalTs(state, change), () => rebaseLocalWasm(state, change), () => [state.local, state.server, change]);
}
