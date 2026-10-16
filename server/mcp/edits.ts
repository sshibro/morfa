// How an assistant changes a file (docs/mcp-server.md §Editing). Nothing here is a second editor: a call runs the canvas tools
// (src/design/canvas-tools/executor.ts runCanvasTool, with the shared checker and the editor's store, history-free) against the file's
// stored document on the server, and the change it made is saved as a teammate's edit is: the files API's autosave
// (server/design/files.ts patchDesignDocument, merging field by field onto whatever the file holds by then), which broadcasts it to every
// open editor (live/hub.ts recordChange) and keeps the automatic versions. The rules that follow from it:
//   - only a connection allowed to change files (`write`, while ENABLE_MCP_EDITS=1), on a file the account may edit, not in the trash;
//   - each call is one change, the editor's own (layouts, constraints, text sizes as the store computes them; nothing the server's
//     schema would refuse);
//   - each change is kept with its way back (mcp_edits), so the assistant can undo its own edits in order: the editor's ⌘Z holds only
//     the person's own steps, as for a teammate's, and the file's version history holds everything;
// Layer ids are the document's own (what the reading tools give); the canvas tools name layers by aliases ("L12"), so a call's ids are
// given aliases here and the result's aliases are turned back into ids.
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {db} from '../db';
import {fileAccess} from '../design/file-access';
import {storedDocument} from '../design/document-store';
import {isDesignFailure} from '../design/errors';
import {patchDesignDocument} from '../design/files';
import {composePatches, diffDocuments, invertPatch, isEmptyPatch, type DocumentPatch} from '../../shared/design/patch';
import {LIBRARY_PAGE_ID, type DesignDocument, type NodeId, type SceneNode} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import type {CanvasAliases} from '../../src/design/canvas-tools/aliases';
import type {DesignStore} from '../../src/design/engine/store';
import type {Principal} from './auth';
import {mcpAuthority} from './authority';
import {mcpEditsOn} from './config';
import {pageOf, ROUGH_MEASURER} from './design-read';
import {ToolError} from './errors';
import {fileNotFound, mcpRead} from './files';

/** The newest edits of a connection in a file that can be undone, and how long any is kept. */
export const KEPT_EDITS = 50;
export const KEPT_EDIT_DAYS = 30;
/** A change bigger than this (its JSON and its way back together) is saved but not kept for undo. */
export const MAX_KEPT_EDIT_CHARS = 4_000_000;

// ── Who may edit ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Refuses a connection that may not change files (editing off, or the person allowed reading only). */
export function requireWriter(principal: Principal): void {
  if (!mcpEditsOn())
    throw new ToolError(
      'unavailable',
      'Changing files is not open on this Morfa server.',
      'Use the reading tools; tell the person that editing through an assistant is not available yet.',
    );
  if (!principal.scopes.has('write'))
    throw new ToolError(
      'insufficient_scope',
      'The person allowed this connection to read their files, not to change them.',
      'Ask the person to connect Morfa again and allow changing files (in the assistant: disconnect Morfa, then connect it again).',
    );
}

// ── Translating ids ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Aliases over the document's own ids: a call's ids get aliases from L900001 on (far above what an assistant uses as its own
 *  local ids), the executor names layers by their ids (`alias` is the id), and `output` turns the call's aliases in a result back into
 *  ids. An id that is not a layer of the file's pages (unknown, a page, the library) resolves to nothing, which the tools report. */
export type McpAliases = CanvasAliases & {input(id: unknown): unknown; output(text: string): string};
const FIRST_ALIAS = 900_001;
export function mcpAliases(isLayer: (id: string) => boolean): McpAliases {
  const byAlias = new Map<string, NodeId>();
  const byId = new Map<NodeId, string>();
  let next = FIRST_ALIAS;
  return {
    alias: id => id,
    known: id => id,
    resolve: alias => {
      const id = byAlias.get(alias);
      return id !== undefined && isLayer(id) ? id : null;
    },
    input(id) {
      if (typeof id !== 'string') return id;
      let alias = byId.get(id);
      if (!alias) {
        alias = `L${next++}`;
        byId.set(id, alias);
        byAlias.set(alias, id);
      }
      return alias;
    },
    // Quoted text (layer names, the texts) is the file's, never an alias: only bare aliases are turned back.
    output: text =>
      text.replace(/"(?:[^"\\]|\\.)*"|\bL9[0-9]{5}\b/g, match =>
        match.startsWith('"') ? match : JSON.stringify(byAlias.get(match) ?? match).slice(1, -1),
      ),
  };
}

/** Whether `id` is a layer the tools may touch: a node of the file that is not a page and not on the library page. */
export function editableLayer(doc: DesignDocument, id: string): boolean {
  if (!Object.hasOwn(doc.nodes, id)) return false;
  const node = doc.nodes[id]!;
  return node.type !== 'PAGE' && pageOf(doc, id) !== undefined && pageOf(doc, id) !== LIBRARY_PAGE_ID;
}

// ── The work of one call ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The server's text shaper when it is built (production), else rough widths: text sizes in a layout are then estimates. */
async function textMeasurer(): Promise<TextMeasurer> {
  try {
    const {serverMeasurer} = await import('../design/wasm-engine');
    return serverMeasurer();
  } catch {
    return ROUGH_MEASURER;
  }
}

/** The pages an assistant may build on: every page but the library. */
export const contentPages = (doc: DesignDocument): NodeId[] => doc.pages.filter(id => id !== LIBRARY_PAGE_ID && doc.nodes[id]);

/** What a call's work runs against: the file's document in a store of its own, on one page. */
export type EditSession = {
  file: {id: string; name: string; version: number};
  /** The document as stored, before the call. */
  base: DesignDocument;
  store: DesignStore;
  aliases: McpAliases;
  pageId: NodeId;
  /** Where new layers go on the page: right of what stands there (`pageView`); `size`, the box they take. */
  view(size?: {width: number; height: number}): {x: number; y: number; width: number; height: number};
};

/** The gap between a new top-level layer and what stands on the page before it. */
export const PAGE_GAP = 100;

/**
 * Where the canvas tools put new top-level layers (they centre a box of `size` in a view, then move it right past what
 * stands there): a row to the right of what is on the page, top-aligned with it, as a designer lays out screens; the origin on an empty
 * page. Without a size, a screen's worth of canvas there.
 */
export function pageView(
  doc: DesignDocument,
  pageId: NodeId,
  size: {width: number; height: number} = {width: 1440, height: 900},
): {x: number; y: number; width: number; height: number} {
  let right = -Infinity,
    top = Infinity;
  for (const id of doc.nodes[pageId]?.children ?? []) {
    const node = doc.nodes[id];
    if (!node || node.visible === false) continue;
    right = Math.max(right, node.x + node.width);
    top = Math.min(top, node.y);
  }
  const at = Number.isFinite(right) ? {x: Math.round(right + PAGE_GAP), y: Math.round(top)} : {x: 0, y: 0};
  return {...at, width: Math.max(1, size.width), height: Math.max(1, size.height)};
}

/** The box the top-level layers of a create_layers call take (their own x/y, 0 when left out), as `specsBounds` reads them. */
export function layersBox(layers: readonly unknown[]): {width: number; height: number} | undefined {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const raw of layers) {
    const layer = raw as {parent?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown};
    if (layer?.parent != null || typeof layer?.width !== 'number' || typeof layer.height !== 'number') continue;
    const x = typeof layer.x === 'number' ? layer.x : 0,
      y = typeof layer.y === 'number' ? layer.y : 0;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + layer.width);
    bottom = Math.max(bottom, y + layer.height);
  }
  return Number.isFinite(left) ? {width: right - left, height: bottom - top} : undefined;
}

/** The file to change, if the account may edit it: not in the trash, a design file (boards have their own tools in the app). */
async function openForEdit(principal: Principal, fileId: string) {
  return mcpRead(principal, async tx => {
    let row;
    try {
      row = await fileAccess(tx, principal.userId, fileId, 'edit');
    } catch (error) {
      throw editRefusal(error);
    }
    if (row.trashed_at !== null) throw fileNotFound();
    if (row.kind === 'board')
      throw new ToolError(
        'unavailable',
        'This file is a board; the editing tools change design files.',
        'Pick a design file (morfa_list_files shows the kind), or create one with morfa_create_file.',
      );
    return {id: row.id, name: row.name, version: Number(row.version), doc: await storedDocument(tx, row)};
  });
}

export type EditOutcome<T> = {ok: true; value: T} | {ok: false; error: ToolError};
export type EditResult<T> = {
  file: {id: string; name: string};
  /** The file's version after the call (unchanged when nothing changed). */
  version: number;
  changed: boolean;
  /** The kept change, for morfa_undo; null when nothing changed, or it was too big to keep. */
  editId: string | null;
  value: T;
};

/**
 * Runs `work` against the file's document and saves what it changed as one edit of the file. `pageId` (or the page of `near`, a layer)
 * is the page the work builds on; the file's first page otherwise. A refusal of the work saves nothing.
 */
export async function editFile<T>(
  principal: Principal,
  target: {fileId: string; pageId?: string; near?: string},
  label: string,
  work: (session: EditSession) => Promise<EditOutcome<T>>,
): Promise<EditResult<T>> {
  requireWriter(principal);
  const opened = await openForEdit(principal, target.fileId);
  const changed = await changeDocument(opened.doc, target, work, {
    file: {id: opened.id, name: opened.name, version: opened.version},
    measurer: await textMeasurer(),
  });
  const file = {id: opened.id, name: opened.name};
  if (!changed.patch) return {file, version: opened.version, changed: false, editId: null, value: changed.value};
  const saved = await save(principal, opened.id, opened.version, changed.patch, changed.inverse);
  // What the file holds now for the entries the change wrote (the merge may have kept a teammate's newer value), so an undo compares
  // against what is really there.
  const stored = saved.own ? composePatches(changed.patch, saved.own) : changed.patch;
  const editId = await keepEdit(principal, opened.id, label, saved.version, stored, changed.inverse);
  return {file, version: saved.version, changed: true, editId, value: changed.value};
}

/**
 * The work on a document in a store of its own, and the change it made (null: none) with its way back. No database: editFile's middle,
 * and what the tests run. A refusal of the work is thrown.
 */
export async function changeDocument<T>(
  doc: DesignDocument,
  target: {pageId?: string; near?: string},
  work: (session: EditSession) => Promise<EditOutcome<T>>,
  options: {file?: EditSession['file']; measurer?: TextMeasurer} = {},
): Promise<{value: T; pageId: NodeId; patch: DocumentPatch | null; inverse: DocumentPatch; after: DesignDocument}> {
  const pageId = pickPage(doc, target.pageId, target.near);
  const {createDesignStore} = await import('../../src/design/engine/store');
  // `copy`: the stored document (the cache's, which other readers share) is never written; no idle work, no undo history.
  const store = createDesignStore({
    doc,
    pageId,
    measurer: options.measurer ?? ROUGH_MEASURER,
    table: 'copy',
    idle: () => () => {},
    historyLimit: 1,
  });
  const aliases = mcpAliases(id => editableLayer(store.getState().doc, id));
  const outcome = await work({
    file: options.file ?? {id: '', name: '', version: 0},
    base: doc,
    store,
    aliases,
    pageId,
    view: size => pageView(store.getState().doc, pageId, size),
  });
  if (!outcome.ok) throw outcome.error;
  const after = store.getState().doc;
  const patch = diffDocuments(doc, after);
  if (isEmptyPatch(patch)) return {value: outcome.value, pageId, patch: null, inverse: {}, after};
  return {value: outcome.value, pageId, patch, inverse: invertPatch(doc, patch), after};
}

function pickPage(doc: DesignDocument, pageId: string | undefined, near: string | undefined): NodeId {
  const pages = contentPages(doc);
  if (pageId !== undefined) {
    if (!pages.includes(pageId))
      throw new ToolError('not_found', 'No such page in this file.', 'Take page ids from morfa_get_file.');
    return pageId;
  }
  const page = near !== undefined && editableLayer(doc, near) ? pageOf(doc, near) : undefined;
  if (page) return page;
  if (!pages.length)
    throw new ToolError('not_found', 'This file has no page to build on.', 'Add one with morfa_add_page.');
  return pages[0]!;
}

/** Saves a change made on `baseVersion` as the editor's autosave does, merged onto the file as it is now. */
async function save(
  principal: Principal,
  fileId: string,
  baseVersion: number,
  patch: DocumentPatch,
  inverse: DocumentPatch,
): Promise<{version: number; own?: DocumentPatch}> {
  // The server's copy of every entry the change touches, as the editor sends it (src/design/persistence/autosave.ts contextFor).
  const {nodes: before = {}, ...beforeTables} = inverse;
  try {
    const saved = await patchDesignDocument(mcpAuthority(principal), fileId, {baseVersion, patch, before, beforeTables});
    return {version: saved.version, ...(saved.own ? {own: saved.own} : {})};
  } catch (error) {
    throw editRefusal(error);
  }
}

/** Keeps the change and its way back, and lets the oldest go. A change too big to keep is saved all the same. */
async function keepEdit(
  principal: Principal,
  fileId: string,
  label: string,
  version: number,
  patch: DocumentPatch,
  inverse: DocumentPatch,
): Promise<string | null> {
  const patchText = JSON.stringify(patch),
    inverseText = JSON.stringify(inverse);
  if (patchText.length + inverseText.length > MAX_KEPT_EDIT_CHARS) return null;
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.execute(
      'INSERT INTO mcp_edits(id,grant_id,file_id,label,version,patch,inverse) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
      [id, principal.grantId, fileId, label.slice(0, 80), version, patchText, inverseText],
    );
    await tx.execute(
      `DELETE FROM mcp_edits WHERE grant_id=$1 AND (created_at < clock_timestamp() - make_interval(days=>$3::int)
         OR (file_id=$2 AND id NOT IN (SELECT id FROM mcp_edits WHERE grant_id=$1 AND file_id=$2 ORDER BY created_at DESC, id DESC LIMIT $4)))`,
      [principal.grantId, fileId, KEPT_EDIT_DAYS, KEPT_EDITS],
    );
  });
  return id;
}

// ── Undo ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type KeptEdit = {id: string; label: string; version: number; patch: DocumentPatch; inverse: DocumentPatch; created_at: string};

/** The entries of `patch` whose value in `doc` is no longer what the patch wrote: someone (or something) changed them since. */
export function changedSince(doc: DesignDocument, patch: DocumentPatch): string[] {
  const changed: string[] = [];
  // As stored (JSON): a value the document holds is compared without its undefined fields, as the patch was kept.
  const plain = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  for (const [table, entries] of Object.entries(patch) as [keyof DocumentPatch, unknown][]) {
    if (table === 'pages') {
      if (!isDeepStrictEqual(doc.pages, entries)) changed.push('the page order');
      continue;
    }
    const current = (doc[table as keyof DesignDocument] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      const now = Object.hasOwn(current, key) ? current[key] : undefined;
      if (!isDeepStrictEqual(plain(now), value)) changed.push(table === 'nodes' ? key : `${table}.${key}`);
    }
  }
  return changed;
}

/**
 * Takes back this connection's newest change of the file that is not undone yet (or the one `editId` names, which must be that one):
 * its way back is saved as a new edit, merged like any other. Refused when something it changed was changed again since by anyone,
 * so nothing done after it is lost.
 */
export async function undoEdit(
  principal: Principal,
  fileId: string,
  editId?: string,
): Promise<{file: {id: string; name: string}; version: number; undone: {id: string; label: string}; left: number}> {
  requireWriter(principal);
  const kept = await db.many<KeptEdit>(
    `SELECT id,label,version,patch,inverse,created_at FROM mcp_edits
      WHERE grant_id=$1 AND file_id=$2 AND undone_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 2`,
    [principal.grantId, fileId],
  );
  const edit = kept[0];
  if (!edit)
    throw new ToolError(
      'not_found',
      'This connection has no change of this file left to undo.',
      'Changes are kept for undo for 30 days, the newest 50 per file; fix anything older with the editing tools.',
    );
  if (editId !== undefined && editId !== edit.id)
    throw new ToolError(
      'conflict',
      'Only the newest change can be undone; that edit is not the newest one left.',
      `Undo the newer ones first (call morfa_undo without editId; the newest is ${edit.id}).`,
    );
  const opened = await openForEdit(principal, fileId);
  const changed = changedSince(opened.doc, edit.patch);
  if (changed.length)
    throw new ToolError(
      'conflict',
      `Layers this change touched were changed again since (${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', …' : ''}); undoing it would lose that.`,
      'Read the layers again and change them back with morfa_update_layers or morfa_delete_layers instead.',
      {changed: changed.slice(0, 50)},
    );
  const {version} = await save(principal, opened.id, opened.version, edit.inverse, edit.patch);
  await db.execute('UPDATE mcp_edits SET undone_at=clock_timestamp() WHERE id=$1 AND grant_id=$2', [edit.id, principal.grantId]);
  const left = await db.one<{n: number}>(
    'SELECT count(*)::int AS n FROM mcp_edits WHERE grant_id=$1 AND file_id=$2 AND undone_at IS NULL',
    [principal.grantId, fileId],
  );
  return {file: {id: opened.id, name: opened.name}, version, undone: {id: edit.id, label: edit.label}, left: left?.n ?? 0};
}

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The files API's refusal of an edit as a tool error the model can act on; anything else is rethrown (an internal error). */
export function editRefusal(error: unknown): unknown {
  if (error instanceof ToolError || !isDesignFailure(error)) return error;
  const said = {code: error.code, message: error.message};
  switch (error.status) {
    case 401:
      return new ToolError('unauthorized', 'This Morfa connection no longer works.', 'Ask the person to connect Morfa again.');
    case 403:
      return new ToolError(
        'forbidden',
        'This account can view this file but not edit it.',
        'Ask the person to get edit access from the file owner, or duplicate the file in Morfa and work on the copy.',
        said,
      );
    case 404:
      return fileNotFound();
    case 409:
      return error.code === 'collab_active'
        ? new ToolError(
            'unavailable',
            'The file is open in live co-editing right now, which an assistant cannot save into yet.',
            'Try again when the person has closed the file, or describe the change for them to make.',
            said,
          )
        : new ToolError('conflict', 'The file changed while the edit was saved.', 'Read the layers again and repeat the call.', said);
    case 413:
      return new ToolError(
        'too_large',
        'Morfa refused the change: the file or the account has reached a limit.',
        'Tell the person (details.message says which limit, in Russian); change or remove layers instead of adding them.',
        said,
      );
    case 400:
    case 422:
      return new ToolError(
        'refused',
        `Morfa refused to store the change (${error.code}).`,
        'Simplify the layers and try again; details say which entry was refused.',
        {...said, ...(error.extra ? {details: error.extra} : {})},
      );
    default:
      return error;
  }
}

/** The ids of the layers a patch created (new nodes whose parent is not new too), in the order of `ids`. */
export function createdRoots(patch: DocumentPatch, base: DesignDocument): NodeId[] {
  const created = Object.entries(patch.nodes ?? {}).filter(([id, node]) => node && !Object.hasOwn(base.nodes, id));
  const fresh = new Set(created.map(([id]) => id));
  return created.filter(([, node]) => !fresh.has((node as SceneNode).parentId ?? '')).map(([id]) => id);
}
