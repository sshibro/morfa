import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {dataDir} from '../db';
import {prepared, type SqlExecutor, type TransactionContext} from '../postgresql/client';
import type {CustomerAuthority} from '../customer-authority';
import {uploadedImageName} from '../upload-storage';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {LIBRARY_PAGE_ID} from '../../shared/design/types';
import {pageLayerCounts, pageSlice, skeletonOf, type DesignPageSlice, type DesignPartial} from '../../shared/design/pages';
import type {
  DesignFileKind,
  DesignFileMove,
  DesignFileSummary,
  DesignImageUploaded,
  DesignSaved,
  DesignVersionSummary,
} from '../../shared/design/api';
import type {DesignFileAccess, DesignTeamRole} from '../../shared/design/teams';
import {canEditTeamFiles, canManageTeam} from '../../shared/design/teams';
import {DESIGN_DOCUMENT_CAPS, DESIGN_LIMITS} from '../../shared/design/limits';
import {documentCaps, tooLargeMessage} from '../../shared/design/big-files';
import {createDocument, newId} from '../../shared/design/defaults';
import {isEmptyPatch, type DocumentPatch} from '../../shared/design/patch';
import {
  documentImageFiles,
  validateDocument,
  validatePatch,
  type DesignValidation,
} from '../../shared/design/schema';
import {holderOf, scopeOfFile, type DesignScope} from './access';
import {applyDocumentChange, layOutChange, storedValues} from './apply';
import {serverLayoutOn, serverMeasurer} from './wasm-engine';
import {checkPatchedDocument} from '../../shared/design/ops-check';
import {cachedDocument, forgetDocument, keepsParsed, lendDocument, rememberDocument, takeSpareNodes} from './document-cache';
import {documentBytes, documentNodeCount, documentText} from './document-text';
import {CLEAR_CHECKPOINT, compactionDone, compressDocuments, deltaMinBytes, documentForSave, lockedDocumentText, MAX_WAITING_BYTES, MAX_WAITING_CHANGES, scheduleCompaction, storedDocument, storedDocumentText, waitingChanges} from './document-store';
import {scheduleServerThumbnail} from './thumbnails';
import {collabActive, forwardReplace} from './collab/writes';
import {collabConfigured, collabWire} from './collab/config';
import {fileCollabMode, type CollabMode} from './collab/switch';
import {readFastDocument, type FastDocument} from './document-fast';
import {checkpointApiBytes, keptCheckpoint, tooLarge as tooLargeCheckpoint, type CheckpointEncoding, type CheckpointSource} from './document-checkpoint';
import {shadowAfterReplace, shadowAfterSave, type ClientOp} from './collab/shadow';
import {collabFileClosed} from './collab/notices';
import {leaseHolder} from './collab/leases';
import {designFail, isDesignFailure, notFound} from './errors';
import {catchUp, closeFile, recordChange, recordRename, recordReset, revalidateLive} from './live/hub';
import {arriveAtFile} from './file-sharing';
import {serializedForFile} from './live/queue';
import {documentsFull, makeRoom} from './room';
import {
  designRead,
  designReadOne,
  designReadRows,
  designWrite,
  fileAccess,
  fileAccessSql,
  FILE_COLUMNS,
  versionOf,
  forbidden,
  OWNER_ONLY_FILE,
  lockTeams,
  MANAGERS_ONLY,
  READ_ONLY,
  SESSION_EXPIRY_SQL,
  type DesignFileAccessRow,
  type DesignFileRow,
} from './file-access';
import {
  assertOwnedDesignImages,
  copyImageFile,
  designStorageSql,
  designStorageUsed,
  encodeDesignImage,
  encodeThumbnail,
  imageRef,
  imageUrl,
  newImageFilename,
  removeImageFiles,
  teamStorageSql,
  teamStorageUsed,
  writeImageFile,
} from './images';
import {cleanName} from './names';
import {BOARD_NAMES} from '../../shared/design/board/names';
import {asBoardDocument} from '../../shared/design/board/document';
import {unreadCommentsSql} from './comments';
import {projectNotFound, requireTeamRole, teamNotFound, teamProject} from './teams';
import {copySubscriptions, fileLibraryBytes, moveFileLibraries} from './library-rows';

export {cleanName} from './names';

// "Morfa" files (docs/design-tool.md §Server API). Heavy work (parsing, validating and serializing a
// document of up to 20 MB, encoding pictures) happens outside the account lock; the write itself is a short
// transaction that re-checks access and compares the version (optimistic concurrency).
//
// A file is personal (its account's) or a team's (docs/design-tool.md §Teams). Every route reaches it through `fileAccess`, which answers
// the row and the caller's role; from there on the file's own rows are addressed by the account that holds them (`row.user_id`: the
// personal owner, or the team's owner), and its limits, storage and pictures are its scope's (access.ts `scopeOfFile`).

export const DEFAULT_FILE_NAME = 'Untitled';
/** A new board's name (docs/board.md); the product's name lives in shared/design/board/names.ts. */
export const DEFAULT_BOARD_NAME = BOARD_NAMES.untitled;
/** Files of one account (or one team) including the trash. Protects the server, not the business. */
export const MAX_FILES_PER_ACCOUNT = 5_000;
/** Named versions of one file. */
export const MAX_NAMED_VERSIONS = 200;
/** Automatic versions of one file, newest kept, on top of the history days. */
export const MAX_AUTO_VERSIONS = 500;
const COPY_SUFFIX = ' (copy)';

/** What a summary reads of a file's row: the file list selects only these (lane B6, TARGETS A1: 200 rows per list). */
type SummaryRow = Pick<DesignFileRow, 'id' | 'name' | 'version' | 'created_at' | 'updated_at' | 'thumbnail_filename' | 'trashed_at' | 'team_id' | 'project_id' | 'kind'>;
const SUMMARY_COLUMNS = `id,name,${versionOf('design_files')} AS version,created_at,updated_at,thumbnail_filename,trashed_at,team_id,project_id,kind`;

export const summary = (row: SummaryRow): DesignFileSummary => ({
  id: row.id,
  name: row.name,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  thumbnailUrl: row.thumbnail_filename ? imageUrl(row.thumbnail_filename) : null,
  trashedAt: row.trashed_at,
  teamId: row.team_id,
  projectId: row.project_id,
  kind: row.kind === 'board' ? 'board' : 'design',
});
const accessOf = (row: DesignFileAccessRow): DesignFileAccess => ({
  role: row.role,
  canEdit: canEditTeamFiles(row.role),
  // A guest sees the file outside its place: not the team's libraries, members or projects.
  team: row.team_id && !row.guest ? {id: row.team_id, name: row.team_name ?? ''} : null,
  ...(row.guest ? {guest: true} : {}),
});
/** A copy of a file lands in its own place (the owner's files, the team's): a guest cannot make one there. */
const NO_GUEST_COPY = 'Only the file\'s owner or a team member can make a copy of this file.';

/** 400 `design_document_invalid` with what the editor needs to put back exactly the refused value: the `path` of
 * the value, the `entry` it belongs to (`{table, key}`: a node, a style, a picture...) and, for a layer, its `nodeId`.
 * PATCH, PUT, create and restore answer in this one shape. */
function rejected(result: DesignValidation<unknown> & {ok: false}, prefix = ''): never {
  const entry = prefix ? undefined : result.entry;
  return designFail(400, 'design_document_invalid', 'File not saved: ' + result.error.replace(/\.$/, '') + '.', {
    path: prefix + result.path,
    ...(entry ? {entry} : {}),
    ...(entry?.table === 'nodes' && entry.key !== null ? {nodeId: entry.key} : {}),
  });
}
const conflict = (currentVersion: number | undefined): never =>
  designFail(409, 'version_conflict', 'The file was changed in another tab. Open it again.', {
    currentVersion: currentVersion ?? null,
  });

type Prepared = {
  /** The document (the fast path parses its text only when something asks: the collab shadow's comparison). */
  readonly doc: DesignDocument;
  /** The picture table (the check that each picture is the account's). */
  images: Readonly<Record<string, {url: string} | null>>;
  /** The UTF-8 JSON text, put together when a write needs it (document-text.ts: from the entries' kept text). */
  text: () => Buffer;
  bytes: number;
  nodeCount: number;
  imageFiles: string[];
  /** Read by the Rust fast path (document-fast.ts): no parsed document is at hand to keep in the cache. */
  fast?: true;
};
/** The stored form of a document that passed validation, within the byte cap (20 MB; the big-files switch raises it). */
function prepare(doc: DesignDocument): Prepared {
  const bytes = documentBytes(doc);
  const caps = documentCaps();
  if (bytes > caps.bytes) designFail(413, 'design_document_too_large', tooLargeMessage(caps, bytes), {bytes, limit: caps.bytes});
  let text: Buffer | undefined;
  return {
    doc,
    images: doc.images,
    text: () => (text ??= documentText(doc)),
    bytes,
    nodeCount: documentNodeCount(doc),
    imageFiles: documentImageFiles(doc),
  };
}
/**
 * The document a create or a whole replace stored, kept for the next save. It is the caller's object (`validateDocument` answers
 * the value it was given), so its node table is lent: the cache never makes it the spare a later save writes into
 * (document-cache.ts), and the caller's copy stays as it was.
 */
function rememberKept(id: string, holder: string, version: number, prepared: Prepared) {
  lendDocument(prepared.doc);
  rememberDocument(id, holder, version, prepared.doc, prepared.bytes);
}
/** `prepare` of a document the Rust fast path read: its text, size, layers and pictures came from that one pass. */
function prepareFast(fast: FastDocument): Prepared {
  const caps = documentCaps();
  if (fast.bytes > caps.bytes) designFail(413, 'design_document_too_large', tooLargeMessage(caps, fast.bytes), {bytes: fast.bytes, limit: caps.bytes});
  let doc: DesignDocument | undefined;
  return {
    get doc() {
      return (doc ??= JSON.parse(fast.text.toString('utf8')) as DesignDocument);
    },
    images: fast.images,
    text: () => fast.text,
    bytes: fast.bytes,
    nodeCount: fast.nodeCount,
    imageFiles: fast.imageFiles,
    fast: true,
  };
}
/** `prefix` names a part of the body other than the patch itself (`before.`): its refusals name no entry to revert. */
function checkedPatch(value: unknown, prefix = ''): DocumentPatch {
  const result = validatePatch(value);
  return result.ok ? result.value : rejected(result, prefix);
}
function validated(value: unknown): DesignDocument {
  const result = validateDocument(value);
  return result.ok ? result.value : rejected(result);
}

const teamOf = (scope: DesignScope) => (scope.kind === 'team' ? scope.teamId : null);
/** Files of a scope: an account's personal ones, or a team's. `$1` is the holder or the team. */
const scopeFilter = (scope: DesignScope, alias = '', key = '$1') =>
  scope.kind === 'team' ? `${alias}team_id=${key}` : `${alias}user_id=${key} AND ${alias}team_id IS NULL`;
const scopeKey = (scope: DesignScope) => (scope.kind === 'team' ? scope.teamId : scope.userId);

async function storageUsed(tx: SqlExecutor, scope: DesignScope): Promise<number> {
  return scope.kind === 'team' ? teamStorageUsed(tx, scope.teamId) : designStorageUsed(tx, scope.userId);
}
const ownedImages = (tx: SqlExecutor, scope: DesignScope, images: Readonly<Record<string, {url: string} | null>>) =>
  assertOwnedDesignImages(tx, holderOf(scope), images, teamOf(scope));

/** Below the hard cap of files (the trash included) when a file is added. Protects the server. */
async function assertFileRoom(tx: SqlExecutor, scope: DesignScope) {
  const total = (await tx.one<{total: number}>(`SELECT count(*) AS total FROM design_files WHERE ${scopeFilter(scope)}`, [scopeKey(scope)]))!.total;
  if (total >= MAX_FILES_PER_ACCOUNT)
    designFail(409, 'design_file_limit', 'Too many files, including the trash. Empty the trash.', {
      limit: MAX_FILES_PER_ACCOUNT,
    });
}

// ── Files ──────────────────────────────────────────────────────────────────────────────────────

/** An ISO timestamp exactly as the pools' parser writes it (postgresql/codecs.ts `parseUtcTimestamp`: UTC, the microseconds
 * PostgreSQL keeps with trailing zeros dropped, at least three digits), or NULL: `YYYY-MM-DDTHH:MM:SS.fff[fff]Z`. Built from the
 * UTC timestamp's own text (`YYYY-MM-DD HH:MM:SS[.f…]`, trailing zeros already dropped; DateStyle ISO, which every pool sets), a
 * third of the cost of to_char's. */
export const isoTimestampSql = (column: string) => {
  const text = `(${column} AT TIME ZONE 'UTC')::text`;
  return `replace(left(${text},19),' ','T')||'.'||rpad(substr(${text},21),greatest(3,length(${text})-20),'0')||'Z'`;
};
/** `summary(row)` of design_files `alias` as JSON text, byte for byte JSON.stringify's: the keys in this order, strings escaped by
 * to_json (as V8 escapes them), null as `null`; built by concatenation (a row_to_json per row was a third of the list's time). */
const summaryJsonSql = (alias: string) => {
  const string = (value: string) => `COALESCE(to_json(${value})::text,'null')`;
  const time = (column: string) => `COALESCE('"'||${isoTimestampSql(alias + '.' + column)}||'"','null')`;
  return (
    `'{"id":'||${string(alias + '.id')}||',"name":'||${string(alias + '.name')}||',"version":'||${alias}.version||` +
    `',"createdAt":'||${time('created_at')}||',"updatedAt":'||${time('updated_at')}||` +
    `',"thumbnailUrl":'||${string(`'/uploads/'||${alias}.thumbnail_filename`)}||',"trashedAt":'||${time('trashed_at')}||` +
    `',"teamId":'||${string(alias + '.team_id')}||',"projectId":'||${string(alias + '.project_id')}||` +
    `',"kind":'||CASE WHEN ${alias}.kind='board' THEN '"board"' ELSE '"design"' END`
  );
};

/**
 * The file browser's list: the caller's personal files, or (with `teamId`) a team's, optionally one project's. Answered as the JSON
 * text of `DesignFileList` (lane A7, TARGETS A1: 200 files listed by 50 people at once): one statement (`designReadOne`) checks the
 * session, the membership and the project and reads the summaries, unread counts, usage and storage, and
 * PostgreSQL writes the summaries' JSON, so this process neither parses 200 rows nor serializes them (its one thread was the limit).
 */
export async function listDesignFiles(
  actor: CustomerAuthority,
  trash: boolean,
  where: {teamId?: string; projectId?: string} = {},
): Promise<string> {
  const owner = actor.ownerId,
    team = where.teamId !== undefined,
    project = team && where.projectId !== undefined;
  const row = await designReadOne<{owner_id?: string | null; role?: DesignTeamRole | null; project?: boolean; files: string; active: number; storage: number}>(
    actor,
    listStatement(team, project, trash, where.projectId !== undefined),
    [team ? where.teamId : owner, trash, where.projectId ?? null],
  );
  if (team && !row.role) return teamNotFound();
  if (project && !row.project) return projectNotFound();
  // The same keys in the same order as JSON.stringify of `DesignFileList`.
  return `{"files":${row.files},"usage":${JSON.stringify({files: row.active, storageBytes: row.storage})},"limits":${JSON.stringify(DESIGN_LIMITS)}}`;
}
/** The list's statement for one shape of request, built once and prepared (planning it was half of its time). `$3` is the scope's key
 *  (the team, or the caller), `$4` the trash, `$5` the project. */
const listStatements = new Map<string, string>();
function listStatement(team: boolean, project: boolean, trash: boolean, anyProject: boolean): string {
  const key = `${+team}${+project}${+trash}${+anyProject}`;
  let sql = listStatements.get(key);
  if (sql) return sql;
  const scope: DesignScope = team ? {kind: 'team', teamId: '', ownerId: ''} : {kind: 'personal', userId: ''};
  // Every check of designRead + requireTeamRole + teamProject: the caller's live session, a member of a live team, a live project of it.
  const allowed = `a.expires IS NOT NULL${team ? ' AND a.role IS NOT NULL' : ''}${project ? ' AND a.project' : ''}`;
  // The files outside the trash: the rows themselves when they are exactly those (the whole scope, not the trash); same snapshot.
  const active = !trash && !anyProject ? 'SELECT count(*)::int FROM f' : `SELECT count(*)::int FROM design_files WHERE ${scopeFilter(scope, '', '$3')} AND trashed_at IS NULL`;
  // Unread comments (comments.ts `unreadDesignComments`, newer than when the caller joined the team) mark a card; none in the trash.
  const unread = trash ? 'SELECT NULL::text AS file_id,0 AS n WHERE false' : unreadCommentsSql('t.file_id IN (SELECT id FROM f)', '$1', team ? '(SELECT joined_at FROM a)' : 'NULL::timestamptz');
  sql = prepared(`WITH a AS (
       SELECT (${SESSION_EXPIRY_SQL}) AS expires${team ? ',t.owner_id,m.role,m.joined_at' : ''}
              ${project ? ',EXISTS(SELECT 1 FROM design_projects p WHERE p.id=$5 AND p.team_id=t.id AND p.deleted_at IS NULL) AS project' : ''}
         FROM (SELECT) one
         ${team ? 'LEFT JOIN design_teams t ON t.id=$3 AND t.deleted_at IS NULL LEFT JOIN design_team_members m ON m.team_id=t.id AND m.user_id=$1' : ''}
     ), f AS (
       SELECT ${SUMMARY_COLUMNS} FROM design_files WHERE ${scopeFilter(scope, '', '$3')} AND (trashed_at IS NOT NULL)=$4
         AND ($5::text IS NULL OR project_id=$5) AND EXISTS(SELECT 1 FROM a WHERE ${allowed})
     ), u AS (${unread})
     SELECT a.*,
            (SELECT COALESCE('['||string_agg(${summaryJsonSql('f')}||CASE WHEN u.n>0 THEN ',"unreadComments":'||u.n||'}' ELSE '}' END,
                    ',' ORDER BY f.updated_at DESC,f.id)||']','[]') FROM f LEFT JOIN u ON u.file_id=f.id) AS files,
            (${active}) AS active,
            (${team ? teamStorageSql('$3') : designStorageSql('$3')}) AS storage
       FROM a`);
  listStatements.set(key, sql);
  return sql;
}

/** The scope a new file goes to: the caller's personal files, or a team (an editor's or above), in one of its live projects. */
async function targetScope(
  tx: SqlExecutor,
  userId: string,
  teamId: string | undefined | null,
  projectId: string | undefined | null,
  allowed: (role: DesignTeamRole) => boolean = canEditTeamFiles,
  message = READ_ONLY,
): Promise<{scope: DesignScope; projectId: string | null}> {
  if (teamId === undefined || teamId === null) {
    if (projectId) designFail(400, 'invalid_request', 'Only a team file can belong to a project.');
    return {scope: {kind: 'personal', userId}, projectId: null};
  }
  const {team} = await requireTeamRole(tx, teamId, userId, allowed, message);
  if (projectId) await teamProject(tx, team.id, projectId);
  return {scope: {kind: 'team', teamId: team.id, ownerId: team.owner_id}, projectId: projectId ?? null};
}

/** A new file: the given document (validated in full) or one empty page, in the caller's personal files or a team (and project). A retry
 * with the same `clientId` answers the file the first attempt made. */
export async function createDesignFile(
  actor: CustomerAuthority,
  input: {name?: string; document?: unknown; clientId?: string; teamId?: string; projectId?: string | null; kind?: DesignFileKind},
): Promise<{file: DesignFileSummary; created: boolean}> {
  const caller = actor.ownerId,
    id = randomUUID(),
    kind: DesignFileKind = input.kind === 'board' ? 'board' : 'design',
    name = cleanName(input.name) ?? (kind === 'board' ? DEFAULT_BOARD_NAME : DEFAULT_FILE_NAME),
    clientId = input.clientId ?? null;
  const document = input.document === undefined ? createDocument(newId()) : validated(input.document);
  // A board's document is marked as one, whoever made it (docs/board.md §File kind): its normalization runs the board's steps.
  const prepared = prepare(kind === 'board' ? asBoardDocument(document) : document);
  const result = await designWrite(
    actor,
    async tx => {
      const {scope, projectId} = await targetScope(tx, caller, input.teamId, input.projectId);
      const holder = holderOf(scope);
      if (clientId) {
        const existing = await tx.one<DesignFileRow>(
          `SELECT ${FILE_COLUMNS} FROM design_files WHERE user_id=$1 AND client_id=$2`,
          [holder, clientId],
        );
        if (existing) return {file: summary(existing), created: false, holder};
      }
      await assertFileRoom(tx, scope);
      await ownedImages(tx, scope, prepared.images);
      if (!(await makeRoom(tx, holder, prepared.bytes))) documentsFull();
      await compressDocuments(tx);
      const row = await tx.one<DesignFileRow>(
        `INSERT INTO design_files(id,user_id,team_id,project_id,name,document,bytes,node_count,image_files,client_id,kind)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${FILE_COLUMNS}`,
        [id, holder, teamOf(scope), projectId, name, prepared.text(), prepared.bytes, prepared.nodeCount, prepared.imageFiles, clientId, kind],
      );
      return {file: summary(row!), created: true, holder};
    },
    {teams: input.teamId && /^[0-9a-f-]{36}$/.test(input.teamId) ? [input.teamId] : []},
  );
  if (result.created) rememberKept(id, result.holder, result.file.version, prepared);
  return {file: result.file, created: result.created};
}

/** The summary, the caller's access and the JSON text of the document, sent as it is: the stored text (no parse for a read), or
 *  the text of the document this process holds at that version (no database read of up to 20 MB), or the stored text with the
 *  changes waiting after it (document-store.ts). With `have` — the version the caller's browser already holds (lane O's warm
 *  open) — and the file still at that version (`versionOf`, the same version the text would be at), no text: null. */
export async function openDesignFile(
  actor: CustomerAuthority,
  id: string,
  have: number | null = null,
): Promise<{file: DesignFileSummary; access: DesignFileAccess; documentText: string | Buffer | null}> {
  // An invite waiting for the caller's address is claimed here, and a file reached by its link kept in "Shared with me" (file-sharing.ts).
  await arriveAtFile(actor, id);
  return designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'view');
    const file = summary(row);
    return {file, access: accessOf(row), documentText: have !== null && file.version === have ? null : await storedDocumentText(tx, row)};
  });
}

/**
 * `GET /:id/checkpoint`: the file and access as `openDesignFile` answers them, and where its document's
 * codec bytes come from (document-checkpoint.ts): its collab checkpoint object, or its stored text at the file's version. The text
 * is read in this snapshot only when no earlier read kept the answer; an api-path file over DESIGN_CHECKPOINT_API_BYTES is
 * refused with 413 before anything is read.
 */
export async function openDesignCheckpoint(
  actor: CustomerAuthority,
  id: string,
  encoding: CheckpointEncoding,
): Promise<{file: DesignFileSummary; access: DesignFileAccess; source: CheckpointSource}> {
  await arriveAtFile(actor, id);
  return designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'view');
    const base = (await tx.one<{checkpoint_key: string | null; checkpoint_version: number | string | null}>(
      'SELECT checkpoint_key,checkpoint_version FROM design_files WHERE id=$1',
      [row.id],
    ))!;
    const answer = {file: summary(row), access: accessOf(row)};
    if (base.checkpoint_key) return {...answer, source: {kind: 'object', fileId: row.id, key: base.checkpoint_key, version: Number(base.checkpoint_version)}};
    const version = Number(row.version);
    if (keptCheckpoint(row.id, {kind: 'text', version}, encoding)) return {...answer, source: {kind: 'text', fileId: row.id, version, text: () => checkpointTextAgain(actor, id, version)}};
    if (Number(row.bytes) > checkpointApiBytes()) tooLargeCheckpoint(Number(row.bytes));
    const text = await storedDocumentText(tx, row);
    return {...answer, source: {kind: 'text', fileId: row.id, version, text: () => Promise.resolve(text)}};
  });
}
/** The text of `version` read again (an answer kept at the file's read went before it was used): the access checked again, and a
 *  file that moved on meanwhile is a conflict, which the editor answers by opening it again. */
function checkpointTextAgain(actor: CustomerAuthority, id: string, version: number): Promise<string | Buffer> {
  return designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'view');
    if (Number(row.version) !== version) conflict(row.version);
    if (Number(row.bytes) > checkpointApiBytes()) tooLargeCheckpoint(Number(row.bytes));
    return storedDocumentText(tx, row);
  });
}

/** `GET /:id?pages=skeleton` (big files, docs/decisions/big-files.md §3): the document without the layers of its pages — page
 *  nodes, components with their subtrees, the library page, the tables — and how many layers each page holds. The skeleton of a
 *  100 MB file is a few kilobytes, so the first byte does not wait for the whole text. Two kinds of file answer `whole` instead,
 *  without reading the document, and the editor opens them whole:
 *  - `small`: one the fixed caps would hold (DESIGN_DOCUMENT_CAPS: 20 MB, 50 000 layers) — opened as with big files off, every
 *    page at once and from the warm cache (BIG.md stage G: big files on changes nothing for the files that fitted before);
 *    `always` keeps pages on demand for it (the page machinery's tests);
 *  - `big`: one this process would not keep parsed (over half the parsed-copy budget: a 400 MB file), which would be parsed again
 *    for the skeleton and again for each page (12–17 s and 35 s for f500k) — opened from its checkpoint, else whole. */
export async function openDesignSkeleton(
  actor: CustomerAuthority,
  id: string,
  options: {always?: boolean} = {},
): Promise<{file: DesignFileSummary; access: DesignFileAccess} & ({document: DesignDocument; partial: DesignPartial} | {whole: 'small' | 'big'})> {
  // As openDesignFile: an invite waiting for the caller's address is claimed, a file reached by its link kept in "Shared with me".
  await arriveAtFile(actor, id);
  return designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'view');
    const bytes = Number(row.bytes);
    if (!options.always && bytes <= DESIGN_DOCUMENT_CAPS.bytes && Number(row.node_count) <= DESIGN_DOCUMENT_CAPS.nodes)
      return {file: summary(row), access: accessOf(row), whole: 'small' as const};
    if (!keepsParsed(bytes) && !cachedDocument(row.id, row.user_id, Number(row.version))) return {file: summary(row), access: accessOf(row), whole: 'big' as const};
    const doc = await storedDocument(tx, row);
    return {file: summary(row), access: accessOf(row), document: skeletonOf(doc), partial: {loaded: [], layers: pageLayerCounts(doc)}};
  });
}

/** `GET /:id/pages/:pageId`: one page's layers at the file's current version (the client applies later changes on top). */
export async function readDesignPage(actor: CustomerAuthority, id: string, pageId: string): Promise<DesignPageSlice> {
  return designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'view');
    const doc = await storedDocument(tx, row);
    if (!Object.hasOwn(doc.nodes, pageId) || doc.nodes[pageId].type !== 'PAGE' || (!doc.pages.includes(pageId) && pageId !== LIBRARY_PAGE_ID))
      designFail(404, 'page_not_found', 'Page not found.');
    return {version: row.version, nodes: pageSlice(doc, pageId)};
  });
}

/** What a live stream of the file needs (docs/design-tool.md "Co-editing"): the caller's access and version,
 *  and the name the others see (the account's display name, "Member" without one: no part of an e-mail is shown). */
export async function liveAccess(
  actor: CustomerAuthority,
  id: string,
): Promise<{version: number; role: DesignTeamRole; canEdit: boolean; teamId: string | null; name: string}> {
  return designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'view');
    const user = await tx.one<{name: string | null}>('SELECT name FROM users WHERE id=$1', [actor.ownerId]);
    const name = [...(user?.name ?? '').trim()].slice(0, 80).join('') || 'Member';
    return {version: row.version, role: row.role, canEdit: canEditTeamFiles(row.role) && row.trashed_at === null, teamId: row.team_id, name};
  });
}

/** Which path this file's co-editing takes (collab/switch.ts `fileCollabMode`: the team's entry, then the holder's, then the
 *  global mode) and the socket's wire: what the editor picks its transport from (src/design/realtime/transport/pick.ts), so every
 *  member of a file is on the file's path whatever their own account's mode. */
export async function fileCollab(actor: CustomerAuthority, id: string): Promise<{designCollab: CollabMode; designCollabWire?: 'binary'}> {
  const row = await designRead(actor, tx => fileAccess(tx, actor.ownerId, id, 'view'));
  const designCollab = fileCollabMode(row);
  return designCollab === 'rust' && collabWire() === 'binary' ? {designCollab, designCollabWire: 'binary'} : {designCollab};
}

export async function renameDesignFile(
  actor: CustomerAuthority,
  id: string,
  value: string,
): Promise<DesignFileSummary> {
  const name = cleanName(value) ?? designFail(400, 'invalid_request', 'Enter a file name.');
  const renamed = await designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'edit');
    const renamed = await tx.one<DesignFileRow>(
      `UPDATE design_files SET name=$1,updated_at=clock_timestamp() WHERE id=$2 AND user_id=$3 RETURNING ${FILE_COLUMNS}`,
      [name, row.id, row.user_id],
    );
    return summary(renamed!);
  });
  recordRename(id, renamed.name);
  return renamed;
}

/** A copy with the same document, pictures (shared, the scope's own) and a copy of the thumbnail, in the same place. Versions stay. */
export async function duplicateDesignFile(actor: CustomerAuthority, id: string): Promise<DesignFileSummary> {
  const caller = actor.ownerId,
    copyId = randomUUID();
  const source = await designRead(actor, async tx => {
    const row = await fileAccess(tx, caller, id, 'edit');
    if (row.guest) forbidden(NO_GUEST_COPY);
    const thumbnail = row.thumbnail_filename
      ? await tx.one<{filename: string; bytes: number; width: number; height: number}>(
          "SELECT filename,bytes,width,height FROM design_images WHERE filename=$1 AND user_id=$2 AND kind='thumbnail'",
          [row.thumbnail_filename, row.user_id],
        )
      : undefined;
    return {row, thumbnail};
  });
  let thumbnail: string | null = null;
  if (source.thumbnail) {
    thumbnail = newImageFilename('thumbnail', 'webp');
    await copyImageFile(source.thumbnail.filename, thumbnail).catch(() => (thumbnail = null));
  }
  try {
    return await designWrite(
      actor,
      async tx => {
        const row = await fileAccess(tx, caller, id, 'edit');
        const scope = scopeOfFile(row);
        await assertFileRoom(tx, scope);
        if (!(await makeRoom(tx, row.user_id, row.bytes))) documentsFull();
        const name =
          [...row.name]
            .slice(0, 200 - COPY_SUFFIX.length)
            .join('')
            .trim() + COPY_SUFFIX;
        // The document as it is now: the stored text, or that text with the changes waiting after it (document-store.ts).
        const whole = await lockedDocumentText(tx, row.id, row.user_id);
        if (whole?.text) await compressDocuments(tx);
        const copy = await tx.one<DesignFileRow>(
          `INSERT INTO design_files(id,user_id,team_id,project_id,name,document,bytes,node_count,image_files,thumbnail_filename,kind)
         SELECT $1,user_id,team_id,project_id,$2,COALESCE($6::text,document),bytes,node_count,image_files,$3,kind FROM design_files WHERE id=$4 AND user_id=$5 RETURNING ${FILE_COLUMNS}`,
          [copyId, name, thumbnail, row.id, row.user_id, whole?.text ?? null],
        );
        if (thumbnail)
          await tx.execute(
            "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,'thumbnail',$5,$6,$7)",
            [thumbnail, row.user_id, row.team_id, copyId, source.thumbnail!.bytes, source.thumbnail!.width, source.thumbnail!.height],
          );
        // The copy shows the same library copies: it keeps the libraries they came from enabled (docs/design-tool.md §Teams).
        await copySubscriptions(tx, row.id, copyId, caller);
        return summary(copy!);
      },
      {teams: source.row.team_id ? [source.row.team_id] : []},
    );
  } catch (error) {
    if (thumbnail) await removeImageFiles([thumbnail]);
    throw error;
  }
}

/**
 * "Duplicate to drafts" (Figma's trash, and its file menu): a copy of a file as a new file of the caller's own drafts (their personal
 * files), the file itself untouched — also while it is in the trash, where nothing else may change it. Whoever may open the file and edit
 * it by the access rule makes it: its owner, or an editor of its team and above; never a guest, nor a viewer of the team. The copy is a
 * new file (a new id, version 1) under the same name with " (copy)". A team's file brings its pictures and thumbnail along as copies
 * the caller holds (the drafts' storage counts them; the document points at the copies); the caller's own file shares them, and keeps
 * the libraries it enabled, as "Duplicate" does. A team's libraries are not offered in personal files, so a team file's copy keeps
 * its document (the component copies in it) without them.
 */
export async function duplicateDesignFileToDrafts(actor: CustomerAuthority, id: string): Promise<DesignFileSummary> {
  const caller = actor.ownerId,
    copyId = randomUUID();
  const drafts: DesignScope = {kind: 'personal', userId: caller};
  const allowed = (row: DesignFileAccessRow) => {
    if (row.guest) forbidden(NO_GUEST_COPY);
    if (!canEditTeamFiles(row.role)) forbidden(READ_ONLY);
  };
  const source = await designRead(actor, async tx => {
    const row = await fileAccess(tx, caller, id, 'view');
    allowed(row);
    const doc = await storedDocument(tx, row);
    // The caller's own personal file: the copy stays in its place and shares its pictures.
    const same = row.team_id === null && row.user_id === caller;
    const pictures = same
      ? []
      : await tx.many<{filename: string; bytes: number; width: number; height: number}>(
          "SELECT filename,bytes,width,height FROM design_images WHERE user_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND kind='image' AND filename=ANY($3::text[])",
          [row.user_id, row.team_id, documentImageFiles(doc)],
        );
    const thumbnail = row.thumbnail_filename
      ? await tx.one<{filename: string; bytes: number; width: number; height: number}>(
          "SELECT filename,bytes,width,height FROM design_images WHERE filename=$1 AND user_id=$2 AND kind='thumbnail'",
          [row.thumbnail_filename, row.user_id],
        )
      : undefined;
    return {row, doc, same, pictures, thumbnail};
  });
  // The files are copied outside the transaction; a failed write removes the copies.
  const copies: Copied[] = [];
  let thumbnail: Copied | null = null;
  try {
    for (const picture of source.pictures) {
      const to = newImageFilename('image', picture.filename.endsWith('.png') ? 'png' : 'webp');
      await copyImageFile(picture.filename, to);
      copies.push({from: picture.filename, to, bytes: picture.bytes, width: picture.width, height: picture.height});
    }
    if (source.thumbnail) {
      const to = newImageFilename('thumbnail', 'webp');
      const copied = await copyImageFile(source.thumbnail.filename, to).then(
        () => true,
        () => false,
      );
      if (copied) thumbnail = {from: source.thumbnail.filename, to, bytes: source.thumbnail.bytes, width: source.thumbnail.width, height: source.thumbnail.height};
    }
  } catch (error) {
    await removeImageFiles(copies.map(copy => copy.to));
    throw error;
  }
  const made = [...copies, ...(thumbnail ? [thumbnail] : [])];
  try {
    const prepared = prepare(copies.length ? rewriteImages(source.doc, new Map(copies.map(copy => [copy.from, copy.to]))) : source.doc);
    const name = [...source.row.name].slice(0, 200 - COPY_SUFFIX.length).join('').trim() + COPY_SUFFIX;
    return await designWrite(
      actor,
      async tx => {
        const row = await fileAccess(tx, caller, id, 'view');
        allowed(row);
        // Copied as it was read: a change in between (a restore from the trash and an edit) is a conflict, never a mix.
        if (row.version !== source.row.version) return conflict(row.version);
        await assertFileRoom(tx, drafts);
        const adding = made.reduce((sum, copy) => sum + Number(copy.bytes), 0);
        if (adding) {
          const used = await storageUsed(tx, drafts);
          if (used + adding > DESIGN_LIMITS.storageBytes) storageFull(used);
        }
        if (!(await makeRoom(tx, caller, prepared.bytes))) documentsFull();
        await compressDocuments(tx);
        const copy = await tx.one<DesignFileRow>(
          `INSERT INTO design_files(id,user_id,team_id,project_id,name,document,bytes,node_count,image_files,thumbnail_filename,kind)
           VALUES($1,$2,NULL,NULL,$3,$4,$5,$6,$7,$8,$9) RETURNING ${FILE_COLUMNS}`,
          [copyId, caller, name, prepared.text(), prepared.bytes, prepared.nodeCount, prepared.imageFiles, thumbnail?.to ?? null, source.row.kind],
        );
        for (const picture of copies)
          await tx.execute(
            "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,NULL,$3,'image',$4,$5,$6)",
            [picture.to, caller, copyId, picture.bytes, picture.width, picture.height],
          );
        if (thumbnail)
          await tx.execute(
            "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,NULL,$3,'thumbnail',$4,$5,$6)",
            [thumbnail.to, caller, copyId, thumbnail.bytes, thumbnail.width, thumbnail.height],
          );
        if (source.same) await copySubscriptions(tx, row.id, copyId, caller);
        return summary(copy!);
      },
      {teams: source.row.team_id ? [source.row.team_id] : []},
    );
  } catch (error) {
    await removeImageFiles(made.map(copy => copy.to));
    throw error;
  }
}

export async function trashDesignFile(actor: CustomerAuthority, id: string): Promise<void> {
  await designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'admin');
    await tx.execute(
      'UPDATE design_files SET trashed_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL',
      [row.id, row.user_id],
    );
  });
  // Whoever has it open is told it went to the trash (edits are refused from now on).
  closeFile(id, 'trashed');
}

export async function restoreDesignFile(actor: CustomerAuthority, id: string): Promise<DesignFileSummary> {
  return designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'admin');
    if (row.trashed_at === null) return summary(row);
    const restored = await tx.one<DesignFileRow>(
      `UPDATE design_files SET trashed_at=NULL WHERE id=$1 AND user_id=$2 RETURNING ${FILE_COLUMNS}`,
      [row.id, row.user_id],
    );
    return summary(restored!);
  }).then(file => {
    // Read-only no more: the open streams and sockets learn their roles again.
    revalidateLive({fileId: id});
    return file;
  });
}

export async function eraseDesignFile(actor: CustomerAuthority, id: string): Promise<void> {
  const holder = await designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'admin');
    // A collab node that holds it is told after the commit; the lease goes with the row.
    const holder = await leaseHolder(row.id, tx);
    await eraseFileWithin(tx, row.user_id, row.id);
    return holder;
  });
  forgetDocument(id);
  closeFile(id, 'erased');
  if (holder) collabFileClosed(id, 'erased', holder.node);
}

/**
 * Erases a file inside the caller's transaction: the file, its versions and its library and template with their versions (cascade), its
 * thumbnail and every picture of its scope uploaded into it or used by it that no other file, version or other file's library or template
 * version held by the same account
 * uses (a team's files are all held by its owner, so this is conservative across the owner's personal and team files: a picture is kept
 * while anything may still show it). Picture files go before the commit, as uploads do in account erasure: a failed commit leaves rows whose
 * erasure a retry repeats, never a private file without its row.
 */
export async function eraseFileWithin(tx: TransactionContext, owner: string, id: string): Promise<void> {
  const removed = await tx.many<{filename: string}>(
    `WITH refs AS (
       SELECT unnest(image_files) AS filename FROM design_files WHERE id=$2 AND user_id=$1
       UNION SELECT unnest(image_files) FROM design_file_versions WHERE file_id=$2 AND user_id=$1
       UNION SELECT unnest(v.image_files) FROM design_library_versions v JOIN design_libraries l ON l.id=v.library_id WHERE l.file_id=$2
       UNION SELECT unnest(v.image_files) FROM design_template_versions v JOIN design_templates t ON t.id=v.template_id WHERE t.file_id=$2
     ), place AS (SELECT team_id FROM design_files WHERE id=$2 AND user_id=$1)
     DELETE FROM design_images d WHERE d.user_id=$1 AND d.team_id IS NOT DISTINCT FROM (SELECT team_id FROM place) AND (
       (d.kind='thumbnail' AND d.file_id=$2) OR
       (d.kind='image' AND (d.file_id=$2 OR d.filename IN (SELECT filename FROM refs))
         AND NOT EXISTS (SELECT 1 FROM design_files f WHERE f.user_id=$1 AND f.id<>$2 AND d.filename=ANY(f.image_files))
         AND NOT EXISTS (SELECT 1 FROM design_file_versions v WHERE v.user_id=$1 AND v.file_id<>$2 AND d.filename=ANY(v.image_files))
         AND NOT EXISTS (SELECT 1 FROM design_library_versions v JOIN design_libraries l ON l.id=v.library_id
                         WHERE v.user_id=$1 AND l.file_id<>$2 AND d.filename=ANY(v.image_files))
         -- Another board's template versions (server/design/templates.ts) show the pictures of its place they were built with.
         AND NOT EXISTS (SELECT 1 FROM design_template_versions v JOIN design_templates t ON t.id=v.template_id JOIN design_files tf ON tf.id=t.file_id
                         WHERE tf.user_id=$1 AND t.file_id<>$2 AND d.filename=ANY(v.image_files))
         -- collab writes image_files with each checkpoint (crates/collab pg.rs FileStats), so a file with collab rows (fence set)
         -- above its checkpoint may show pictures its image_files does not list yet. While one exists, no picture of the holder goes.
         AND NOT EXISTS (SELECT 1 FROM design_files f WHERE f.user_id=$1 AND f.id<>$2
                         AND EXISTS (SELECT 1 FROM design_file_changes c WHERE c.file_id=f.id AND c.fence IS NOT NULL
                                     AND c.version>coalesce(f.checkpoint_version,0))))
     ) RETURNING d.filename`,
    [owner, id],
  );
  await tx.execute('DELETE FROM design_files WHERE id=$1 AND user_id=$2', [id, owner]);
  await removeImageFiles(removed.map(row => row.filename));
}

// ── Moving ─────────────────────────────────────────────────────────────────────────────────────

type Picture = {filename: string; kind: 'image' | 'thumbnail'; bytes: number; width: number; height: number; shared: boolean};
type Copied = {from: string; to: string; bytes: number; width: number; height: number};

/**
 * "Move": between a team's projects (an editor or above), into a team (the file's owner, an admin or the owner of that team), or
 * from a team back to the caller's personal files (an admin or the team's owner). The file keeps its id, document and versions. Pictures
 * used only by this file move with it; a picture the place it leaves still uses elsewhere (or one from the site library) is copied into the
 * new place and the document points at the copy. Old versions keep their own addresses (docs/design-tool.md §Teams). Refused when the new
 * place has no room for the file or its pictures.
 */
export async function moveDesignFile(actor: CustomerAuthority, id: string, input: DesignFileMove): Promise<DesignFileSummary> {
  const caller = actor.ownerId,
    toTeam = input.teamId ?? null,
    toProject = input.projectId ?? null;
  const plan = await designRead(actor, async tx => {
    const row = await fileAccess(tx, caller, id, 'view');
    if (row.guest) forbidden(OWNER_ONLY_FILE);
    if (row.trashed_at !== null) designFail(404, 'not_found', 'The file is in the trash. Restore it to move it.');
    if (row.team_id !== null && toTeam !== null && row.team_id !== toTeam)
      designFail(400, 'invalid_request', 'First move the file to your personal files, then to the other team.');
    if (row.team_id === toTeam) {
      // Between projects of one team, or nothing to do for a personal file.
      if (toTeam !== null) {
        if (!canEditTeamFiles(row.role)) forbidden(READ_ONLY);
        if (toProject) await teamProject(tx, toTeam, toProject);
      }
      return {kind: 'project' as const, row};
    }
    if (row.team_id === null) {
      if (row.user_id !== caller) forbidden(MANAGERS_ONLY);
      await targetScope(tx, caller, toTeam, toProject, canManageTeam, 'Only a team\'s owner and admins can move files into it.');
    } else if (!canManageTeam(row.role)) forbidden('Only a team\'s owner and admins can take a file out of it.');
    const doc = await storedDocument(tx, row);
    const from = scopeOfFile(row);
    const used = await tx.many<{filename: string}>(
      `SELECT unnest(image_files) AS filename FROM design_files WHERE id=$1 AND user_id=$2
       UNION SELECT unnest(image_files) FROM design_file_versions WHERE file_id=$1 AND user_id=$2`,
      [row.id, row.user_id],
    );
    const names = used.map(item => item.filename);
    const pictures = await tx.many<Picture>(
      `SELECT d.filename,d.kind,d.bytes,d.width,d.height,
         (EXISTS (SELECT 1 FROM design_files f WHERE ${scopeFilter(from, 'f.')} AND f.id<>$2 AND d.filename=ANY(f.image_files))
          OR EXISTS (SELECT 1 FROM design_file_versions v JOIN design_files f ON f.id=v.file_id WHERE ${scopeFilter(from, 'f.')} AND v.file_id<>$2 AND d.filename=ANY(v.image_files))) AS shared
       FROM design_images d WHERE d.user_id=$3 AND d.team_id IS NOT DISTINCT FROM $4 AND
         ((d.kind='image' AND d.filename=ANY($5::text[])) OR (d.kind='thumbnail' AND d.file_id=$2))`,
      [scopeKey(from), row.id, row.user_id, row.team_id, names],
    );
    // A personal file may also show pictures of its owner's site library: they never move, the team gets a copy.
    const library = row.team_id
      ? []
      : await tx.many<{filename: string}>('SELECT filename FROM uploads WHERE user_id=$1 AND ready=1 AND filename=ANY($2::text[])', [
          row.user_id,
          documentImageFiles(doc),
        ]);
    return {kind: 'scope' as const, row, doc, pictures, library: library.map(item => item.filename)};
  });

  if (plan.kind === 'project') {
    if (toTeam === null) return summary(plan.row);
    return designWrite(
      actor,
      async tx => {
        const row = await fileAccess(tx, caller, id, 'edit');
        if (row.team_id !== toTeam) return conflict(row.version);
        if (toProject) await teamProject(tx, toTeam, toProject);
        const moved = await tx.one<DesignFileRow>(
          `UPDATE design_files SET project_id=$3 WHERE id=$1 AND user_id=$2 RETURNING ${FILE_COLUMNS}`,
          [row.id, row.user_id, toProject],
        );
        return summary(moved!);
      },
      {teams: [toTeam]},
    );
  }

  // Copies of what the place it leaves keeps using, made outside the transaction (a failed write removes them).
  const {row: before, doc, pictures, library} = plan;
  const inDocument = new Set(documentImageFiles(doc));
  const copies: Copied[] = [];
  try {
    for (const picture of pictures)
      if (picture.kind === 'image' && picture.shared && inDocument.has(picture.filename)) {
        const to = newImageFilename('image', picture.filename.endsWith('.png') ? 'png' : 'webp');
        await copyImageFile(picture.filename, to);
        copies.push({from: picture.filename, to, bytes: picture.bytes, width: picture.width, height: picture.height});
      }
    for (const filename of library) {
      const encoded = await encodeDesignImage(await fs.readFile(path.join(dataDir, 'uploads', path.basename(filename))));
      const to = newImageFilename('image', encoded.extension);
      await writeImageFile(to, encoded.data);
      copies.push({from: filename, to, bytes: encoded.data.length, width: encoded.width, height: encoded.height});
    }
  } catch (error) {
    await removeImageFiles(copies.map(copy => copy.to));
    throw error;
  }
  const renamed = new Map(copies.map(copy => [copy.from, copy.to]));
  const rewritten = copies.length ? prepare(rewriteImages(doc, renamed)) : null;
  const exclusive = pictures.filter(picture => !(picture.kind === 'image' && picture.shared)).map(picture => picture.filename);
  const moving = pictures.filter(picture => !(picture.kind === 'image' && picture.shared)).reduce((sum, picture) => sum + Number(picture.bytes), 0);
  const adding = copies.reduce((sum, copy) => sum + copy.bytes, 0);

  try {
    const saved = await designWrite(
      actor,
      async tx => {
        const row = await fileAccess(tx, caller, id, 'view');
        if (row.version !== before.version || row.team_id !== before.team_id || row.user_id !== before.user_id) return conflict(row.version);
        // A rewritten document is a new version: never while a collab node holds the file (its document may be newer than ours).
        if (rewritten && (await leaseHolder(row.id, tx))) collabActive(row.id);
        const {scope: to, projectId} = await targetScope(
          tx,
          caller,
          toTeam,
          toProject,
          canManageTeam,
          'Only a team\'s owner and admins can move files into it.',
        );
        if (row.team_id === null ? row.user_id !== caller : !canManageTeam(row.role)) forbidden(MANAGERS_ONLY);
        await assertFileRoom(tx, to);
        const used = await storageUsed(tx, to);
        if (used + moving + adding > DESIGN_LIMITS.storageBytes) storageFull(used);
        const holder = holderOf(to),
          team = teamOf(to);
        if (holder !== row.user_id) {
          const versions = (await tx.one<{bytes: number}>(
            'SELECT COALESCE(sum(bytes),0) AS bytes FROM design_file_versions WHERE file_id=$1 AND user_id=$2',
            [row.id, row.user_id],
          ))!.bytes;
          const libraries = await fileLibraryBytes(tx, row.id);
          if (!(await makeRoom(tx, holder, (rewritten?.bytes ?? row.bytes) + Number(versions) + libraries))) documentsFull();
        }
        // Its library follows it, and is offered in its new place only (docs/design-tool.md §Teams, shared libraries).
        await moveFileLibraries(tx, row.id, holder);
        if (rewritten) await compressDocuments(tx);
        for (const copy of copies)
          await tx.execute(
            "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,'image',$5,$6,$7)",
            [copy.to, holder, team, row.id, copy.bytes, copy.width, copy.height],
          );
        await tx.execute(
          'UPDATE design_images SET user_id=$3,team_id=$4 WHERE user_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND filename=ANY($5::text[])',
          [row.user_id, row.team_id, holder, team, exclusive],
        );
        await tx.execute('UPDATE design_file_versions SET user_id=$3 WHERE file_id=$1 AND user_id=$2', [row.id, row.user_id, holder]);
        // At the version the document was read at: a save in between is a conflict, never overwritten by the rewritten copy.
        const moved = await tx.one<DesignFileRow>(
          `UPDATE design_files SET user_id=$3,team_id=$4,project_id=$5,client_id=NULL,
             document=COALESCE($6::text,document),bytes=COALESCE($7,bytes),image_files=COALESCE($8,image_files),
             version=CASE WHEN $6::text IS NULL THEN version ELSE ${versionOf('design_files')}+1 END,updated_at=clock_timestamp(),
             checkpoint_key=CASE WHEN $6::text IS NULL THEN checkpoint_key END,
             checkpoint_version=CASE WHEN $6::text IS NULL THEN checkpoint_version END,
             checkpoint_format=CASE WHEN $6::text IS NULL THEN checkpoint_format END
           WHERE id=$1 AND user_id=$2 AND ${versionOf('design_files')}=$9 RETURNING ${FILE_COLUMNS}`,
          [row.id, row.user_id, holder, team, projectId, rewritten?.text() ?? null, rewritten?.bytes ?? null, rewritten?.imageFiles ?? null, before.version],
        );
        if (!moved) return conflict(row.version);
        // The rewritten text is the whole document: the changes it holds no longer wait after it.
        if (rewritten) await tx.execute('DELETE FROM design_file_changes WHERE file_id=$1', [row.id]);
        return {...summary(moved), holder: moved.user_id};
      },
      {teams: [toTeam ?? before.team_id].filter((team): team is string => !!team)},
    );
    forgetDocument(id);
    // A rewritten document was stored whole: no change waits for a catch-up.
    if (rewritten) compactionDone(id);
    // Who may open it changed with its place, and a rewritten document is a new one for the open editors.
    if (rewritten) {
      recordReset(id, saved.version);
      shadowAfterReplace({fileId: id, file: {user_id: saved.holder, team_id: saved.teamId ?? null}, version: saved.version, document: rewritten.doc});
    }
    revalidateLive({fileId: id, extraTeams: before.team_id ? [before.team_id] : []});
    const {holder: _holder, ...file} = saved;
    return file;
  } catch (error) {
    await removeImageFiles(copies.map(copy => copy.to));
    throw error;
  }
}

/** The document with each picture of `renamed` pointing at its copy; refs (what the layers name) stay. */
function rewriteImages(doc: DesignDocument, renamed: ReadonlyMap<string, string>): DesignDocument {
  const images: DesignDocument['images'] = {};
  for (const [ref, asset] of Object.entries(doc.images)) {
    const file = asset.url.slice('/uploads/'.length);
    images[ref] = renamed.has(file) ? {...asset, url: imageUrl(renamed.get(file)!)} : asset;
  }
  return {...doc, images};
}

// ── Documents ──────────────────────────────────────────────────────────────────────────────────

/**
 * Stores a prepared document as the next version, if the file is still at `baseVersion`. Before the change it
 * keeps a copy of the document it replaces: always for a replace or restore, at most once per 10 minutes of
 * editing for autosave. A new copy prunes the file's history to the history days.
 *
 * `change` (autosave): the patch that made the document from the one at `baseVersion`. A large document is then stored as that
 * change after its stored text (document-store.ts, docs/design-tool.md "Saving large files"), not as its whole text,
 * unless a copy is taken now or too many changes already wait; the size, pictures and layer count are the whole document's.
 */
async function writeDocument(
  tx: TransactionContext,
  input: {
    owner: string;
    id: string;
    baseVersion: number;
    prepared: Prepared;
    snapshot: 'auto' | 'always';
    /** The stored document's bytes before this write (the file's row read in this transaction). */
    previousBytes: number;
    change?: DocumentPatch;
  },
): Promise<DesignSaved & {delta: boolean}> {
  const {owner, id, baseVersion, prepared} = input;
  // The file's row, locked: a save of another process, a catch-up of the text and a copy of the file wait for this write.
  const locked = await tx.one<{due: boolean; leased: boolean}>(
    `SELECT (auto_version_at IS NULL OR auto_version_at<=clock_timestamp()-interval '10 minutes') AS due,
            COALESCE(lease_until>=clock_timestamp(),false) AS leased FROM design_files
     WHERE id=$1 AND user_id=$2 AND ${versionOf('design_files')}=$3 AND trashed_at IS NULL FOR UPDATE`,
    [id, owner, baseVersion],
  );
  if (!locked)
    return conflict(
      (await tx.one<{version: number}>(`SELECT ${versionOf('design_files')} AS version FROM design_files WHERE id=$1 AND user_id=$2`, [id, owner]))
        ?.version,
    );
  // A collab node holds the document (docs/BACKEND.md §7, rust): it writes the journal, never this process. Checked under the row
  // lock, so a node's lease cannot be taken between this check and the write (its UPDATE waits for this transaction).
  if (locked.leased) collabActive(id);
  const snapshot = input.snapshot === 'always' || locked.due;
  const waiting = await waitingChanges(tx, id);
  const changeText = input.change && !snapshot && prepared.bytes >= deltaMinBytes() ? JSON.stringify(input.change) : null;
  // The changes waiting after the text may reach half the document (4 MB at least): a cold read composes at most that much on top,
  // and a big file written in parts (an import) rewrites its whole text a few times, not on every part.
  const delta =
    changeText !== null &&
    waiting.count < MAX_WAITING_CHANGES &&
    waiting.bytes + Buffer.byteLength(changeText) <= Math.max(MAX_WAITING_BYTES, Math.floor(prepared.bytes / 2));
  const snapshotId = randomUUID();
  // Whole texts follow (this one, and the copy of the one it replaces): written with lz4 where the server has it.
  if (!delta) await compressDocuments(tx);
  let copied = 0;
  if (snapshot) {
    // The document this write replaces: the stored text itself, or the base (that text, or collab's checkpoint) with the changes
    // waiting after it.
    const replaced = waiting.count || waiting.checkpoint ? await storedDocumentText(tx, {id, user_id: owner, version: baseVersion}, false) : null;
    copied = (
      await tx.execute(
        `INSERT INTO design_file_versions(id,file_id,user_id,version,document,bytes,image_files)
         SELECT $1,id,user_id,${versionOf('design_files')},COALESCE($5::text,document),bytes,image_files FROM design_files
         WHERE id=$2 AND user_id=$3 AND ${versionOf('design_files')}=$4`,
        [snapshotId, id, owner, baseVersion, replaced],
      )
    ).changes;
  }
  const saved = await tx.one<{version: number; updated_at: string}>(
    `UPDATE design_files SET document=COALESCE($1::text,document),bytes=$2,node_count=$3,image_files=$4,version=${versionOf('design_files')}+1,updated_at=clock_timestamp(),
       auto_version_at=CASE WHEN $8::boolean THEN clock_timestamp() ELSE auto_version_at END${delta ? '' : ',' + CLEAR_CHECKPOINT}
     WHERE id=$5 AND user_id=$6 AND ${versionOf('design_files')}=$7 AND trashed_at IS NULL RETURNING version,updated_at`,
    [delta ? null : prepared.text(), prepared.bytes, prepared.nodeCount, prepared.imageFiles, id, owner, baseVersion, copied === 1],
  );
  if (!saved) return conflict(baseVersion);
  if (delta) await tx.execute('INSERT INTO design_file_changes(file_id,version,patch) VALUES($1,$2,$3)', [id, saved.version, changeText]);
  // A whole text is the newest base: the rows (Node's, or collab's journal and its catch-up tail) go with the checkpoint pointer.
  else if (waiting.count || waiting.checkpoint) await tx.execute('DELETE FROM design_file_changes WHERE file_id=$1', [id]);
  if (copied) {
    await tx.execute(
      `DELETE FROM design_file_versions WHERE file_id=$1 AND user_id=$2 AND created_at<clock_timestamp()-make_interval(days=>$3::int)
         AND label IS NULL`,
      [id, owner, DESIGN_LIMITS.historyDays],
    );
    await tx.execute(
      `DELETE FROM design_file_versions WHERE file_id=$1 AND user_id=$2 AND label IS NULL AND id NOT IN
         (SELECT id FROM design_file_versions WHERE file_id=$1 AND user_id=$2 AND label IS NULL ORDER BY created_at DESC,id DESC LIMIT $3)`,
      [id, owner, MAX_AUTO_VERSIONS],
    );
  }
  // The holder's room for documents (makeRoom): older automatic versions give way to this one. When even that is not
  // enough, an automatic copy is not kept (the save itself goes through unless the document grew); a replace or
  // restore, whose copy is the way back, and a document that grew are refused.
  const grew = prepared.bytes > input.previousBytes;
  if ((copied || grew) && !(await makeRoom(tx, owner, 0, copied ? snapshotId : null))) {
    if (input.snapshot === 'always' && copied) documentsFull();
    if (copied) await tx.execute('DELETE FROM design_file_versions WHERE id=$1 AND user_id=$2', [snapshotId, owner]);
    if (grew && !(await makeRoom(tx, owner, 0))) documentsFull();
  }
  return {version: saved.version, updatedAt: saved.updated_at, delta};
}
/** After a stored write: a change waiting after the text catches up later, a whole text needs nothing more. */
const afterWrite = (id: string, delta: boolean) => {
  if (delta) scheduleCompaction(id);
  else compactionDone(id);
  // The file card's picture, made by the render service some seconds after the last write (thumbnails.ts).
  scheduleServerThumbnail(id);
};

/** A live connection id the client names as its own (it is not sent its change back). */
const CLIENT = /^[0-9a-f-]{36}$/;
/** Saves of one file racing in other processes: the merge is redone on the newer version this many times. */
const MERGE_ATTEMPTS = 4;

/**
 * Autosave: a patch made on `baseVersion`. Only the patch's entries are validated in full, then the invariants
 * of the nodes it touched (shared/design/schema.ts `checkPatchedDocument`); new pictures must be the file's scope's.
 *
 * Co-editing (docs/design-tool.md "Co-editing"): with `before` copies the patch merges field by field into
 * the file's current version, however far it moved on since `baseVersion`, and the answer carries what the editor must
 * apply to catch up (`changes` after its version, `own` when the stored entries differ from what it sent). Saves of one
 * file run one at a time in this process; a save that lost a race with another process merges again. Without `before`
 * (an editor of an older release) a stale `baseVersion` is still 409.
 */
export async function patchDesignDocument(
  actor: CustomerAuthority,
  id: string,
  input: {baseVersion: number; patch?: unknown; before?: unknown; beforeTables?: unknown; client?: unknown},
): Promise<DesignSaved> {
  const caller = actor.ownerId,
    baseVersion = input.baseVersion;
  const patch: DocumentPatch = checkedPatch(input.patch);
  const before: Record<NodeId, SceneNode | null> | undefined =
    input.before === undefined ? undefined : checkedPatch({nodes: input.before}, 'before.').nodes;
  const beforeTables: DocumentPatch | undefined = input.beforeTables === undefined ? undefined : checkedPatch(input.beforeTables, 'before.');
  const merging = before !== undefined || beforeTables !== undefined;
  const client = typeof input.client === 'string' && CLIENT.test(input.client) ? input.client : null;
  /** The op as the client sent it (validated), for DESIGN_COLLAB=shadow (collab/shadow.ts). */
  const op = {
    baseVersion,
    patch: input.patch,
    ...(input.before !== undefined ? {before: input.before} : {}),
    ...(input.beforeTables !== undefined ? {beforeTables: input.beforeTables} : {}),
  };
  return serializedForFile(id, async () => {
    for (let attempt = 0; ; attempt++) {
      const {row, current} = await designRead(actor, async tx => {
        const row = await fileAccess(tx, caller, id, 'edit');
        // A collab node holds it (rust): the editor saves through the socket. Refused before the document is read; the write
        // checks again under the row lock.
        if (collabConfigured() && (await leaseHolder(row.id, tx))) collabActive(row.id);
        if (merging ? row.version < baseVersion : row.version !== baseVersion) conflict(row.version);
        return {row, current: await documentForSave(tx, row)};
      });
      const behind = row.version > baseVersion;
      /** The same op to collab's copy (shadow), after Node kept (`next` = `current`) or stored it. */
      const shadow = (version: number, next: DesignDocument, stored: DocumentPatch, sent: ClientOp = op) =>
        shadowAfterSave({fileId: id, file: row, version, appliedOn: row.version, current, next, op: sent, stored});
      /** What the editor needs besides the version: the others' changes it has not seen, and the server's copy of what it sent. */
      const answer = (version: number, updatedAt: string, doc: DesignDocument, stored: DocumentPatch, adjusted: boolean): DesignSaved => {
        if (!merging) return {version, updatedAt};
        const changes = behind ? catchUp(id, baseVersion, row.version) : [];
        if (changes === null) return {version, updatedAt, resync: true};
        return {version, updatedAt, ...(changes.length ? {changes} : {}), ...(behind || adjusted ? {own: storedValues(doc, patch, stored)} : {})};
      };
      if (isEmptyPatch(patch)) {
        shadow(row.version, current, {});
        return answer(row.version, row.updated_at, current, {}, false);
      }
      // The next document goes into the cache's spare node table when it has one (document-cache.ts): no copy of the file's.
      const merged = applyDocumentChange(current, {patch, before, beforeTables}, takeSpareNodes(id, current));
      // Everything the save asked for was already there, or was dropped (it edited what someone removed).
      if (isEmptyPatch(merged.stored)) {
        shadow(row.version, current, {});
        return answer(row.version, row.updated_at, current, {}, merged.adjusted);
      }
      // DESIGN_SERVER_LAYOUT=1: the server lays out what it combined (apply.ts `layOutChange`); the editor then does not.
      const applied = merging && serverLayoutOn() ? layOutChange(merged, serverMeasurer(), {doc: current, owned: merged.doc.nodes !== current.nodes}) : {...merged, laidOut: false};
      const next = applied.doc;
      const checked = checkPatchedDocument(current, next, applied.stored, () => documentNodeCount(next));
      if (!checked.ok) rejected(checked);
      const prepared = prepare(next);
      const known = new Set(Object.values(current.images).map(asset => asset.url));
      const added = Object.fromEntries(Object.entries(applied.stored.images ?? {}).filter(([, asset]) => asset && !known.has(asset.url)));
      let saved: DesignSaved & {delta: boolean};
      try {
        saved = await designWrite(actor, async tx => {
          const now = await fileAccess(tx, caller, id, 'edit');
          if (now.user_id !== row.user_id) return conflict(now.version);
          const scope = scopeOfFile(now);
          await ownedImages(tx, scope, added);
          return writeDocument(tx, {
            owner: now.user_id,
            id,
            baseVersion: row.version,
            prepared,
            snapshot: 'auto',
            previousBytes: now.bytes,
            change: applied.stored,
          });
        });
      } catch (error) {
        // Another process stored a version meanwhile: merge onto that one.
        if (merging && attempt + 1 < MERGE_ATTEMPTS && isDesignFailure(error) && error.code === 'version_conflict') continue;
        throw error;
      }
      rememberDocument(id, row.user_id, saved.version, next, prepared.bytes, {doc: current, patches: [applied.stored]});
      afterWrite(id, saved.delta);
      recordChange(id, {version: saved.version, patch: applied.stored, by: client, user: caller});
      // Collab does not lay out: when the server's layout wrote something, the shadow gets the stored change itself (what the
      // journal holds, applied on the version it was merged onto), so its copy stays comparable with Node's.
      shadow(saved.version, next, applied.stored, applied.stored !== merged.stored ? {baseVersion: row.version, patch: applied.stored} : undefined);
      const reply = answer(saved.version, saved.updatedAt, next, applied.stored, applied.adjusted);
      return applied.laidOut && merging && !reply.resync ? {...reply, layout: 'server' as const} : reply;
    }
  });
}

/** Replace the whole document (import, restore made by the client): validated in full. */
export async function replaceDesignDocument(
  actor: CustomerAuthority,
  id: string,
  input: {baseVersion: number; document?: unknown},
): Promise<DesignSaved> {
  return storeWholeDocument(actor, id, input.baseVersion, prepare(validated(input.document)));
}

/** `replaceDesignDocument` of a document the Rust fast path read (router.ts: a `PUT` body it accepted). */
export async function replaceFastDocument(actor: CustomerAuthority, id: string, baseVersion: number, document: FastDocument): Promise<DesignSaved> {
  return storeWholeDocument(actor, id, baseVersion, prepareFast(document));
}

async function storeWholeDocument(
  actor: CustomerAuthority,
  id: string,
  baseVersion: number,
  prepared: Prepared,
): Promise<DesignSaved> {
  const caller = actor.ownerId;
  return serializedForFile(id, async () => {
    if (collabConfigured()) {
      // A collab node holds the file (rust): the document goes to its actor as a replace (a new version there and in the journal).
      await designRead(actor, async tx => {
        const row = await fileAccess(tx, caller, id, 'edit');
        if (row.version !== baseVersion) conflict(row.version);
        await ownedImages(tx, scopeOfFile(row), prepared.images);
      });
      const version = await forwardReplace(id, caller, prepared.text, baseVersion);
      if (version !== null) {
        forgetDocument(id);
        return {version, updatedAt: new Date().toISOString()};
      }
    }
    const saved = await designWrite(actor, async tx => {
      const row = await fileAccess(tx, caller, id, 'edit');
      if (row.version !== baseVersion) conflict(row.version);
      const scope = scopeOfFile(row);
      await ownedImages(tx, scope, prepared.images);
      const result = await writeDocument(tx, {
        owner: row.user_id,
        id,
        baseVersion,
        prepared,
        snapshot: 'always',
        previousBytes: row.bytes,
      });
      return {...result, holder: row.user_id, teamId: row.team_id};
    });
    // A document read by the fast path has no parsed copy: the next read parses the stored text, as after a restart.
    if (prepared.fast) forgetDocument(id);
    else rememberKept(id, saved.holder, saved.version, prepared);
    afterWrite(id, saved.delta);
    // A whole new document: the open editors reload it (their unsaved changes go on top).
    recordReset(id, saved.version);
    const file = {user_id: saved.holder, team_id: saved.teamId};
    if (!prepared.fast || fileCollabMode(file) === 'shadow')
      shadowAfterReplace({fileId: id, file, version: saved.version, document: prepared.doc});
    return {version: saved.version, updatedAt: saved.updatedAt};
  });
}

// ── Versions ───────────────────────────────────────────────────────────────────────────────────

const VERSION_ID = /^[0-9a-f-]{36}$/;
const versionNotFound = (): never => designFail(404, 'not_found', 'Version not found.');
const versionSummary = (row: {
  id: string;
  version: number;
  label: string | null;
  created_at: string;
}): DesignVersionSummary => ({
  id: row.id,
  version: row.version,
  label: row.label,
  createdAt: row.created_at,
});

export async function listDesignVersions(actor: CustomerAuthority, id: string): Promise<DesignVersionSummary[]> {
  // One statement (designReadRows; lane A7, TARGETS A5): the session, `fileAccess(…, 'view')` and the versions, newest first.
  const rows = await designReadRows<{file: string | null; id: string | null; version: number; label: string | null; created_at: string}>(
    actor,
    VERSIONS,
    [id],
  );
  if (!rows[0].file) return notFound();
  return rows.filter((row): row is typeof row & {id: string} => row.id !== null).map(versionSummary);
}
const VERSIONS = prepared(`WITH a AS (SELECT (${SESSION_EXPIRY_SQL}) AS expires),
  f AS (${fileAccessSql('$3', '$1')} AND EXISTS(SELECT 1 FROM a WHERE a.expires IS NOT NULL))
  SELECT a.expires,f.id AS file,v.id,v.version,v.label,v.created_at
    FROM a LEFT JOIN f ON true LEFT JOIN design_file_versions v ON v.file_id=f.id AND v.user_id=f.user_id
   ORDER BY v.created_at DESC,v.id DESC`);

/** "Save version": a named copy of the current document. */
export async function saveDesignVersion(
  actor: CustomerAuthority,
  id: string,
  value: string,
): Promise<DesignVersionSummary> {
  const label = cleanName(value, 120) ?? designFail(400, 'invalid_request', 'Name the version.');
  return designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'edit');
    const named = (await tx.one<{n: number}>(
      'SELECT count(*) AS n FROM design_file_versions WHERE file_id=$1 AND user_id=$2 AND label IS NOT NULL',
      [row.id, row.user_id],
    ))!.n;
    if (named >= MAX_NAMED_VERSIONS)
      designFail(409, 'design_file_limit', `The file already has ${MAX_NAMED_VERSIONS} named versions.`, {
        limit: MAX_NAMED_VERSIONS,
      });
    if (!(await makeRoom(tx, row.user_id, row.bytes))) documentsFull();
    // The document as it is now: the stored text, or that text with the changes waiting after it (document-store.ts).
    const whole = await lockedDocumentText(tx, row.id, row.user_id);
    if (whole?.text) await compressDocuments(tx);
    const saved = await tx.one<{id: string; version: number; label: string | null; created_at: string}>(
      `INSERT INTO design_file_versions(id,file_id,user_id,version,label,document,bytes,image_files)
       SELECT $1,id,user_id,${versionOf('design_files')},$2,COALESCE($5::text,document),bytes,image_files FROM design_files WHERE id=$3 AND user_id=$4
       RETURNING id,version,label,created_at`,
      [randomUUID(), label, row.id, row.user_id, whole?.text ?? null],
    );
    return versionSummary(saved!);
  });
}

export async function readDesignVersion(actor: CustomerAuthority, id: string, versionId: string): Promise<string> {
  if (!VERSION_ID.test(versionId)) versionNotFound();
  return designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'view');
    const version = await tx.one<{document: string}>(
      'SELECT document FROM design_file_versions WHERE id=$1 AND file_id=$2 AND user_id=$3',
      [versionId, row.id, row.user_id],
    );
    return version ? version.document : versionNotFound();
  });
}

/** The version's document becomes the file's next version; the current one is kept as a version first. */
export async function restoreDesignVersion(
  actor: CustomerAuthority,
  id: string,
  versionId: string,
  baseVersion: number,
): Promise<DesignSaved> {
  if (!VERSION_ID.test(versionId)) versionNotFound();
  const text = await designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'edit');
    if (row.version !== baseVersion) conflict(row.version);
    const version = await tx.one<{document: string}>(
      'SELECT document FROM design_file_versions WHERE id=$1 AND file_id=$2 AND user_id=$3',
      [versionId, row.id, row.user_id],
    );
    return version ? version.document : versionNotFound();
  });
  // The stored text through the Rust fast path; one it declines through JSON.parse and the schema, as before.
  const fast = readFastDocument(text);
  return storeWholeDocument(actor, id, baseVersion, fast ? prepareFast(fast) : prepare(validated(JSON.parse(text))));
}

/** "Edit version info" of a version (Figma's "Edit version info"): its label replaced. An automatic version named this way
 *  becomes a named one, kept past the history days, within the file's 200. */
export async function renameDesignVersion(
  actor: CustomerAuthority,
  id: string,
  versionId: string,
  value: string,
): Promise<DesignVersionSummary> {
  if (!VERSION_ID.test(versionId)) versionNotFound();
  const label = cleanName(value, 120) ?? designFail(400, 'invalid_request', 'Name the version.');
  return designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'edit');
    const current = await tx.one<{label: string | null}>(
      'SELECT label FROM design_file_versions WHERE id=$1 AND file_id=$2 AND user_id=$3',
      [versionId, row.id, row.user_id],
    );
    if (!current) versionNotFound();
    if (current!.label === null) {
      const named = (await tx.one<{n: number}>(
        'SELECT count(*) AS n FROM design_file_versions WHERE file_id=$1 AND user_id=$2 AND label IS NOT NULL',
        [row.id, row.user_id],
      ))!.n;
      if (named >= MAX_NAMED_VERSIONS)
        designFail(409, 'design_file_limit', `The file already has ${MAX_NAMED_VERSIONS} named versions.`, {limit: MAX_NAMED_VERSIONS});
    }
    const saved = await tx.one<{id: string; version: number; label: string | null; created_at: string}>(
      'UPDATE design_file_versions SET label=$1 WHERE id=$2 AND file_id=$3 AND user_id=$4 RETURNING id,version,label,created_at',
      [label, versionId, row.id, row.user_id],
    );
    return versionSummary(saved!);
  });
}

/** "Create a copy of the file" of a version (Figma's "Duplicate" in the version history): a new file in the file's place
 *  holding the version's document, under the same checks as a new file (the place's file limit, the account's room,
 *  pictures of the place only). The file itself is left as it is. */
export async function duplicateDesignVersion(
  actor: CustomerAuthority,
  id: string,
  versionId: string,
  input: {name?: string},
): Promise<DesignFileSummary> {
  if (!VERSION_ID.test(versionId)) versionNotFound();
  const source = await designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, id, 'edit');
    if (row.guest) forbidden(NO_GUEST_COPY);
    const version = await tx.one<{document: string}>(
      'SELECT document FROM design_file_versions WHERE id=$1 AND file_id=$2 AND user_id=$3',
      [versionId, row.id, row.user_id],
    );
    return version ? {row, text: version.document} : versionNotFound();
  });
  const name = cleanName(input.name) ?? [...source.row.name].slice(0, 200 - COPY_SUFFIX.length).join('').trim() + COPY_SUFFIX;
  const {file} = await createDesignFile(actor, {
    name,
    document: JSON.parse(source.text),
    kind: source.row.kind,
    ...(source.row.team_id ? {teamId: source.row.team_id, projectId: source.row.project_id} : {}),
  });
  return file;
}

// ── Pictures ───────────────────────────────────────────────────────────────────────────────────

export function storageFull(used: number): never {
  const gigabytes = Math.round(DESIGN_LIMITS.storageBytes / 1024 ** 3);
  return designFail(
    413,
    'design_storage_limit',
    `Image storage is full: ${gigabytes} GB. Delete files you no longer need.`,
    {limit: DESIGN_LIMITS.storageBytes, used},
  );
}

/** A picture for the file: re-encoded, stored as its scope's design picture (the account's, or the team's), counted against the storage limit. */
export async function storeDesignImage(
  actor: CustomerAuthority,
  id: string,
  data: Buffer,
  originalName?: string,
): Promise<DesignImageUploaded> {
  const caller = actor.ownerId;
  await designRead(actor, async tx => {
    const row = await fileAccess(tx, caller, id, 'edit');
    const scope = scopeOfFile(row);
    const used = await storageUsed(tx, scope);
    if (used >= DESIGN_LIMITS.storageBytes) storageFull(used);
  });
  const encoded = await encodeDesignImage(data);
  const filename = newImageFilename('image', encoded.extension);
  await writeImageFile(filename, encoded.data);
  try {
    await designWrite(actor, async tx => {
      const row = await fileAccess(tx, caller, id, 'edit');
      const scope = scopeOfFile(row);
      if (row.team_id) await lockTeams(tx, [row.team_id]);
      const used = await storageUsed(tx, scope);
      if (used + encoded.data.length > DESIGN_LIMITS.storageBytes) storageFull(used);
      await tx.execute(
        "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,'image',$5,$6,$7)",
        [filename, row.user_id, row.team_id, row.id, encoded.data.length, encoded.width, encoded.height],
      );
    });
  } catch (error) {
    await removeImageFiles([filename]);
    throw error;
  }
  const name = originalName ? uploadedImageName(originalName).slice(0, 200) : '';
  return {
    ref: imageRef(filename),
    asset: {url: imageUrl(filename), width: encoded.width, height: encoded.height, ...(name ? {name} : {})},
  };
}

/** The file browser's picture of the first page; replaces the previous one. */
export async function storeDesignThumbnail(
  actor: CustomerAuthority,
  id: string,
  data: Buffer,
): Promise<{thumbnailUrl: string}> {
  const caller = actor.ownerId;
  await designRead(actor, tx => fileAccess(tx, caller, id, 'edit'));
  const encoded = await encodeThumbnail(data);
  const filename = newImageFilename('thumbnail', 'webp');
  await writeImageFile(filename, encoded.data);
  let previous: string | null;
  try {
    previous = await designWrite(actor, async tx => {
      const row = await fileAccess(tx, caller, id, 'edit');
      await tx.execute(
        "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,'thumbnail',$5,$6,$7)",
        [filename, row.user_id, row.team_id, row.id, encoded.data.length, encoded.width, encoded.height],
      );
      await tx.execute('UPDATE design_files SET thumbnail_filename=$1 WHERE id=$2 AND user_id=$3', [
        filename,
        row.id,
        row.user_id,
      ]);
      if (row.thumbnail_filename)
        await tx.execute("DELETE FROM design_images WHERE filename=$1 AND user_id=$2 AND kind='thumbnail'", [
          row.thumbnail_filename,
          row.user_id,
        ]);
      return row.thumbnail_filename;
    });
  } catch (error) {
    await removeImageFiles([filename]);
    throw error;
  }
  if (previous) await removeImageFiles([previous]).catch(() => {});
  return {thumbnailUrl: imageUrl(filename)};
}
