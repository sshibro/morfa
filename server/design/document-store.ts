import {db} from '../db';
import type {SqlExecutor} from '../postgresql/client';
import type {DesignDocument, SceneNode} from '../../shared/design/types';
import {applyPatch, type DocumentPatch} from '../../shared/design/patch';
import {carryTableCaches, forgetTable} from '../../shared/design/table-cache';
import {cachedDocument, cachedEntry, lendDocument, rememberDocument, takeSpareNodes} from './document-cache';
import {documentBytes, documentText} from './document-text';
import {designFail} from './errors';
import {serializedForFile} from './live/queue';
import {decodeJournalRow} from './collab/checkpoint';
import {fileCollabMode} from './collab/switch';
import {versionOf} from './file-access';
import {BASE_OF, composedOf, hasRows, WAITING_CHANGES_OF, wholeTextOf, type Num, type Stored} from './document-compose';

export {BASE_OF, baseOf, composedOf, composeStored, WAITING_CHANGES_OF, wholeTextOf, type Stored} from './document-compose';

// How a file's document is stored (docs/design-tool.md §Performance, "Saving large files"; docs/BACKEND.md §3). The
// document at `design_files.version` is a base with the rows of `design_file_changes` after it applied in version order:
//
// - the base is `design_files.document` (the JSON text of the document at some version), or, once collab recorded a checkpoint
//   (`checkpoint_key`, `checkpoint_version`; migration 012), that checkpoint object, which is then newer than the text;
// - the rows are those above the base: Node writes `patch` (JSON), collab writes `patch` too or `op` (a whole document as an
//   inline checkpoint: a replace), collab/checkpoint.ts reads both. Rows at or below a checkpoint are collab's catch-up tail.
//
// A large file is saved by writing its change as a row instead of its whole text (up to 20 MB, rewritten, compressed and logged by
// PostgreSQL on every save before). The text catches up (`compact`): when a save finds many changes waiting, when an automatic
// version is taken, some seconds after the last save in this process, when the process stops, and as long after a read that found
// changes this process did not write. Writing the whole text clears the checkpoint pointer (the text is newer) and the rows. While
// a collab node holds the file's lease, or collab wrote it and the file is in DESIGN_COLLAB=rust, nothing here compacts it: collab
// checkpoints it and the store only reads. Every read of a file's document goes through here.

/** Documents smaller than this are written whole on every save, as before. DESIGN_DOCUMENT_DELTA_BYTES overrides (tests use 0). */
export function deltaMinBytes(): number {
  const value = Number(process.env.DESIGN_DOCUMENT_DELTA_BYTES ?? 256 * 1024);
  return Number.isSafeInteger(value) && value >= 0 ? value : 256 * 1024;
}
/** A save writes the whole text again once this many changes, or bytes of changes (or half the document, when that is more: files.ts
 *  writeDocument), wait after it. */
export const MAX_WAITING_CHANGES = 120;
export const MAX_WAITING_BYTES = 4 * 1024 * 1024;
/** After the last save of a file in this process, its text catches up this much later. DESIGN_DOCUMENT_COMPACT_MS overrides. */
function compactAfterMs(): number {
  const value = Number(process.env.DESIGN_DOCUMENT_COMPACT_MS ?? 20_000);
  return Number.isSafeInteger(value) && value > 0 ? value : 20_000;
}
/** The SET clause that forgets a checkpoint: for every write of the whole text (which is then the newest base). */
export const CLEAR_CHECKPOINT = 'checkpoint_key=NULL,checkpoint_version=NULL,checkpoint_format=NULL';

type Row = {id: string; user_id: string; version: number};
/** The base and the changes after it, in one statement (one snapshot even in a read-committed transaction). */
async function readStored(tx: SqlExecutor, fileId: string, holder: string): Promise<Stored | undefined> {
  return tx.one<Stored>(
    `SELECT ${BASE_OF('f')},${versionOf('f')} AS version,c.versions,c.patches,c.ops FROM design_files f ${WAITING_CHANGES_OF('f')} WHERE f.id=$1 AND f.user_id=$2`,
    [fileId, holder],
  );
}

/** `readStored` for `row`, which must still be at the version the caller read (a save in between is a conflict). */
async function readAt(tx: SqlExecutor, row: Row): Promise<Stored> {
  const stored = await readStored(tx, row.id, row.user_id);
  if (!stored || Number(stored.version) !== Number(row.version))
    return designFail(409, 'version_conflict', 'The file was changed in another tab. Open it again.', {currentVersion: stored ? Number(stored.version) : null});
  return stored;
}

/** A document put together from the base and its rows: kept for the next save, and its text caught up within the usual delay
 *  (changes left by a process that stopped, or saved by another process). */
async function composed(row: Row, stored: Stored, schedule: boolean): Promise<DesignDocument> {
  const doc = await composedOf(stored);
  rememberDocument(row.id, row.user_id, Number(row.version), doc, documentBytes(doc));
  if (schedule && hasRows(stored)) scheduleCompaction(row.id, compactAfterMs(), false);
  return doc;
}

const reads = {whole: 0, caughtUp: 0};
/** Each change copies the node table (~7 ms for 20 000 layers): past this many a whole read (~0.3 s for 16 MB) costs less. */
const CATCH_UP_CHANGES = 32;
/** For tests: how often a document was read whole and how often a held one was caught up with the changes after it. */
export const documentReads = () => ({...reads});

/**
 * The document this process holds at an older version, caught up with the changes saved after it (by another process or a collab
 * node, whose saves this one did not make), when the rows still reach back to it: a few patches instead of reading, parsing and
 * measuring up to 20 MB again. Undefined otherwise (the text caught up meanwhile, or a whole text was written).
 */
async function caughtUp(tx: SqlExecutor, row: Row, schedule = true): Promise<DesignDocument | undefined> {
  const known = cachedEntry(row.id, row.user_id),
    version = Number(row.version);
  if (!known || known.version >= version || version - known.version > CATCH_UP_CHANGES) return undefined;
  const changes = await tx.many<{version: Num; patch: string | null; op: Buffer | null}>(
    'SELECT version,patch,op FROM design_file_changes WHERE file_id=$1 AND version>$2 AND version<=$3 ORDER BY version',
    [row.id, known.version, version],
  );
  if (changes.length !== version - known.version || changes.some((change, k) => Number(change.version) !== known.version + 1 + k)) return undefined;
  // The held document is shared (the cache, an answer being built): the changes make a new one, untouched entries kept. Rows are
  // patches (Node's saves, collab's ops) or, after a PUT under a lease, a whole replacement (decodeJournalRow).
  const bodies = changes.map(change => decodeJournalRow(change.patch, change.op, Number(change.version)));
  // A store journal entry replays only on the store: the whole read (composedOf) puts this file together.
  if (bodies.some(body => body.kind === 'entry')) return undefined;
  let doc = known.doc;
  const patches: DocumentPatch[] = [];
  for (const body of bodies) if (body.kind === 'patch') patches.push(body.patch);
  const current = cachedEntry(row.id, row.user_id)?.doc === known.doc;
  if (patches.length !== bodies.length) {
    // A replacement in the run: its document is the base from there on. No table is reused or kept as a spare (lane L6's
    // reuse writes only into a table made from the held document by patches).
    for (const body of bodies) doc = body.kind === 'replace' ? body.document : body.kind === 'patch' ? applyPatch(doc, body.patch) : doc;
    reads.caughtUp++;
    rememberDocument(row.id, row.user_id, version, doc, documentBytes(doc));
    if (schedule) scheduleCompaction(row.id, compactAfterMs(), false);
    return doc;
  }
  // Patches only: one node table takes them all, in order: the cache's spare when it has one (document-cache.ts), else one copy.
  let table = current ? takeSpareNodes(row.id, known.doc) : undefined;
  const written = new Set<string>();
  for (const patch of patches) {
    doc = applyPatch(doc, patch, table);
    if (!table && doc.nodes !== known.doc.nodes) table = doc.nodes as Record<string, SceneNode>;
    for (const id of Object.keys(patch.nodes ?? {})) written.add(id);
  }
  // Written in place after the first change: the indexes carried then are re-derived for the whole run.
  if (patches.length > 1 && table) {
    forgetTable(table);
    carryTableCaches(known.doc.nodes, table, written);
  }
  reads.caughtUp++;
  rememberDocument(row.id, row.user_id, version, doc, documentBytes(doc), current ? {doc: known.doc, patches} : undefined);
  // Whoever saved them catches the text up; in case it stopped first, this process does too.
  if (schedule) scheduleCompaction(row.id, compactAfterMs(), false);
  return doc;
}

/** The file's document at `row.version` (parsed): the cache, the held document caught up, or the base with the changes after it.
 *  The caller may keep it (its node table is never reused: document-cache.ts). */
export async function storedDocument(tx: SqlExecutor, row: Row): Promise<DesignDocument> {
  const doc = await documentForSave(tx, row);
  lendDocument(doc);
  return doc;
}

/** `storedDocument` for the save path (server/design/files.ts `patchDesignDocument`), which runs in the file's queue and
 *  lets the document go once the next version is cached: its node table may be the spare of a later save. */
export async function documentForSave(tx: SqlExecutor, row: Row): Promise<DesignDocument> {
  const cached = cachedDocument(row.id, row.user_id, Number(row.version)) ?? (await caughtUp(tx, row));
  if (cached) return cached;
  const stored = await readAt(tx, row);
  reads.whole++;
  if (hasRows(stored) || stored.checkpoint_key) return composed(row, stored, true);
  // The text alone is the document: parsed once and kept, so the reads of a big file's skeleton and pages (docs/decisions/
  // big-files.md §3) and the next save find it (the cache keeps what fits its budget: a 100 MB file with the switch on).
  const doc = JSON.parse(stored.document!) as DesignDocument;
  rememberDocument(row.id, row.user_id, Number(row.version), doc, Buffer.byteLength(stored.document!));
  return doc;
}

/** The JSON text of the file's document at `row.version`, to send or copy: the cached (or caught up) document's text, the stored
 *  text as it is when it is the base and no change waits after it (no parse), or the base with its changes applied. */
export async function storedDocumentText(tx: SqlExecutor, row: Row, schedule = true): Promise<string | Buffer> {
  const cached = cachedDocument(row.id, row.user_id, Number(row.version)) ?? (await caughtUp(tx, row, schedule));
  if (cached) return documentText(cached);
  const stored = await readAt(tx, row);
  reads.whole++;
  return hasRows(stored) || stored.checkpoint_key ? documentText(await composed(row, stored, schedule)) : stored.document!;
}

/** The file's whole document text at whatever version it is now, from one statement (one snapshot). */
export async function currentDocumentText(tx: SqlExecutor, fileId: string, holder: string): Promise<string | undefined> {
  const stored = await readStored(tx, fileId, holder);
  return stored && wholeTextOf(stored);
}

/** Whether `design_files.document` alone is not the document: changes wait after it, or a checkpoint is newer. A statement that
 *  copies `document` in SQL needs the whole text then. */
async function textIsBehind(tx: SqlExecutor, fileId: string): Promise<boolean> {
  return !!(await tx.one(
    `SELECT 1 FROM design_files f WHERE f.id=$1 AND (f.checkpoint_key IS NOT NULL OR EXISTS
       (SELECT 1 FROM design_file_changes c WHERE c.file_id=f.id AND c.version>COALESCE(f.checkpoint_version,0)))`,
    [fileId],
  ));
}

/** For a statement that copies the document in SQL (a copy of the file, a named version): the file's row locked, and its whole text
 *  when `document` alone is not the document (null: `document` is the document). Undefined when the file is gone. */
export async function lockedDocumentText(tx: SqlExecutor, fileId: string, holder: string): Promise<{version: number; text: string | Buffer | null} | undefined> {
  const row = await tx.one<Row>(
    `SELECT id,user_id,${versionOf('design_files')} AS version FROM design_files WHERE id=$1 AND user_id=$2 FOR UPDATE`,
    [fileId, holder],
  );
  if (!row) return undefined;
  return {version: Number(row.version), text: (await textIsBehind(tx, fileId)) ? await storedDocumentText(tx, row) : null};
}

/** What waits after the base of a locked file: the count and the bytes of the changes, and whether a checkpoint is the base. */
export async function waitingChanges(tx: SqlExecutor, fileId: string): Promise<{count: number; bytes: number; checkpoint: boolean}> {
  const row = (await tx.one<{count: number; bytes: string | number; checkpoint: boolean}>(
    `SELECT count(c.version)::int AS count,COALESCE(sum(COALESCE(octet_length(c.patch),octet_length(c.op))),0)::bigint AS bytes,
            bool_or(f.checkpoint_key IS NOT NULL) AS checkpoint
       FROM design_files f LEFT JOIN design_file_changes c ON c.file_id=f.id AND c.version>COALESCE(f.checkpoint_version,0)
      WHERE f.id=$1`,
    [fileId],
  ))!;
  return {count: Number(row.count), bytes: Number(row.bytes), checkpoint: !!row.checkpoint};
}

// ── Catching the text up ─────────────────────────────────────────────────────────────────────────

/**
 * PostgreSQL compresses the documents this transaction writes with lz4 where the server has it, instead of the default pglz: for a
 * 16 MB document about a ninth of the database's time (170 → 19 ms) and 40 % of the WAL (2.1 → 0.8 MB). Every stored value records
 * its own method, so reads and older values need nothing.
 */
let lz4: boolean | undefined;
export async function compressDocuments(tx: SqlExecutor) {
  lz4 ??= (await tx.one<{lz4: boolean}>("SELECT 'lz4'=ANY(enumvals) AS lz4 FROM pg_settings WHERE name='default_toast_compression'"))?.lz4 === true;
  if (lz4) await tx.execute("SET LOCAL default_toast_compression='lz4'");
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The text of `fileId` catches up `delay` ms from now (by default some seconds after a save); a later save moves it on.
 *  `postpone` false (a read): a catch-up already planned keeps its time. */
export function scheduleCompaction(fileId: string, delay = compactAfterMs(), postpone = true) {
  const known = timers.get(fileId);
  if (known && !postpone) return;
  if (known) clearTimeout(known);
  const timer = setTimeout(() => {
    timers.delete(fileId);
    // On failure the changes stay where they are: the next save, read or stop catches up.
    void compact(fileId).catch(() => false);
  }, delay);
  timer.unref();
  timers.set(fileId, timer);
}
/** A whole text was written (a save, a replace, a move): nothing waits for the timer. */
export function compactionDone(fileId: string) {
  const known = timers.get(fileId);
  if (known) clearTimeout(known);
  timers.delete(fileId);
}

/**
 * Writes the document of `fileId` at its current version as the stored text and deletes the changes it holds, after the saves of the
 * file queued in this process. Nothing when no change waits, the file went away, a collab node holds its lease, or collab wrote it
 * (a checkpoint, journal rows under a fence) and it is in DESIGN_COLLAB=rust: collab checkpoints those (docs/BACKEND.md §3). A
 * file of Node's own rows is caught up in every mode. The size, the pictures, the version and `updated_at` stay:
 * every save recorded them. A system write: it changes no content, so it takes no account's lock, only the file's row.
 */
export function compact(fileId: string): Promise<boolean> {
  return serializedForFile(fileId, () =>
    db.transaction(async tx => {
      const row = await tx.one<Row & {team_id: string | null; leased: boolean; collab: boolean}>(
        `SELECT f.id,f.user_id,f.team_id,${versionOf('f')} AS version,COALESCE(f.lease_until>=clock_timestamp(),false) AS leased,
           (f.checkpoint_key IS NOT NULL OR EXISTS (SELECT 1 FROM design_file_changes c WHERE c.file_id=f.id AND c.fence IS NOT NULL)) AS collab
         FROM design_files f WHERE f.id=$1 FOR UPDATE OF f`,
        [fileId],
      );
      // A node holds it, or collab wrote it and the file is collab's (rust): collab checkpoints it, the store only reads.
      if (!row || row.leased || (row.collab && fileCollabMode(row) === 'rust') || !(await textIsBehind(tx, fileId))) return false;
      const text = await storedDocumentText(tx, row, false);
      await compressDocuments(tx);
      // The text is the document at the file's version: a collab head (SQL016) is folded into design_files.version with it.
      await tx.execute(`UPDATE design_files SET document=$1,version=$3,${CLEAR_CHECKPOINT} WHERE id=$2 AND ${versionOf('design_files')}=$3`, [
        text,
        fileId,
        row.version,
      ]);
      await tx.execute('DELETE FROM design_file_changes WHERE file_id=$1 AND version<=$2', [fileId, row.version]);
      return true;
    }),
  );
}

/** The process is stopping: every text waiting for its timer catches up now. */
export async function flushDocumentWrites(): Promise<void> {
  const due = [...timers.entries()];
  for (const [, timer] of due) clearTimeout(timer);
  timers.clear();
  await Promise.allSettled(due.map(([fileId]) => compact(fileId)));
}

/** For tests: the files whose text waits for its timer. */
export const scheduledCompactions = () => [...timers.keys()];
