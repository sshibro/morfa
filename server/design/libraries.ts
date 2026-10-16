import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {dataDir} from '../db';
import {prepared, type SqlExecutor} from '../postgresql/client';
import type {CustomerAuthority} from '../customer-authority';
import type {DesignDocument} from '../../shared/design/types';
import type {
  DesignFileLibraries,
  DesignFileLibrary,
  DesignLibraryImported,
  DesignLibraryImportRequest,
  DesignLibraryPublish,
  DesignLibraryVersionSummary,
  DesignOwnLibrary,
} from '../../shared/design/api';
import {
  buildLibrarySnapshot,
  LIBRARY_CAPS,
  LibraryError,
  snapshotPart,
  validateLibrarySnapshot,
  type LibraryManifest,
  type LibrarySnapshot,
} from '../../shared/design/libraries';
import {DESIGN_DOCUMENT_CAPS, DESIGN_LIMITS} from '../../shared/design/limits';
import {documentImageFiles} from '../../shared/design/schema';
import {holderOf, scopeOfFile, type DesignScope} from './access';
import {storedDocument} from './document-store';
import {designFail, notFound} from './errors';
import {designRead, designReadRows, designWrite, fileAccess, fileAccessSql, forbidden, SESSION_EXPIRY_SQL, type DesignFileAccessRow} from './file-access';
import {storageFull} from './files';
import {copyImageFile, designStorageUsed, encodeDesignImage, imageUrl, newImageFilename, removeImageFiles, teamStorageUsed, writeImageFile} from './images';
import {documentsFull, makeRoom} from './room';

// "Morfa" shared libraries on the server (docs/design-tool.md §Teams, "Shared libraries", SQL036). A file publishes a
// snapshot built here from its stored document (shared/design/libraries.ts), never one sent by the browser; files of the same
// place (the team's files, or the same account's personal files) list, enable and use it. Nothing crosses places: a library is
// offered only beside its file, and every picture an import hands a file is that file's place's own (copied when the library's
// version still points at pictures of a place its file left). Every route reaches its file through `fileAccess`.

const LIBRARY_ID = /^[0-9a-f-]{36}$/;
/** Libraries one file may enable. */
export const MAX_ENABLED_LIBRARIES = 100;
/** Libraries a file lists (its place's, and the ones it enabled). */
const MAX_LISTED_LIBRARIES = 200;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;

const libraryNotFound = (): never => designFail(404, 'not_found', 'Library not found.');
const unavailable = (): never =>
  designFail(409, 'design_library_unavailable', 'The library was unpublished or its file is in the trash. Everything already in the file stays.');
const conflict = (currentVersion: number): never =>
  designFail(409, 'version_conflict', 'The file was changed in another tab. Open it again.', {currentVersion});

/** The libraries a file sees: those of files in its own place. `$1` is the team or the holder. */
const placeFilter = (scope: DesignScope) => (scope.kind === 'team' ? 'f.team_id=$1' : 'f.user_id=$1 AND f.team_id IS NULL');
const placeKey = (scope: DesignScope) => (scope.kind === 'team' ? scope.teamId : scope.userId);

type ListedRow = {
  id: string;
  file_id: string;
  name: string;
  version: number;
  published_at: string;
  unpublished_at: string | null;
  trashed: boolean;
  description: string;
  manifest: string;
  enabled: boolean;
  seen_version: number | null;
};

/** A library as a file (`file`, an SQL expression) sees it: enabled there and the version it last saw. */
const listedSql = (file: string) => `SELECT l.id,l.file_id,f.name,l.version,l.published_at,l.unpublished_at,f.trashed_at IS NOT NULL AS trashed,v.description,v.manifest,
    s.file_id IS NOT NULL AS enabled,s.seen_version
  FROM design_libraries l JOIN design_files f ON f.id=l.file_id
  JOIN design_library_versions v ON v.library_id=l.id AND v.version=l.version
  LEFT JOIN design_library_subscriptions s ON s.library_id=l.id AND s.file_id=${file}`;
const LISTED = listedSql('$2');
/** What "Libraries" lists of the file's place (`x`: the file): published libraries whose file is not in the trash, and the ones it enabled.
 *  A guest of the file (file-access.ts) sees only the ones it enabled: the place's other files are not theirs to see. */
const OFFERED = `l.file_id<>x.id AND ((l.unpublished_at IS NULL AND f.trashed_at IS NULL AND NOT x.guest) OR s.file_id IS NOT NULL)`;
/** `listFileLibraries` in one statement (designReadRows; lane A7, TARGETS A5): the session, `fileAccess(…, 'view')` of `$3` and the
 *  libraries of its place (a team's, or the holder's personal files: one branch each, so each keeps its index), by name. */
const LIBRARIES = prepared(`WITH a AS (SELECT (${SESSION_EXPIRY_SQL}) AS expires),
  x AS (${fileAccessSql('$3', '$1')} AND EXISTS(SELECT 1 FROM a WHERE a.expires IS NOT NULL))
  SELECT a.expires,x.id AS file,lib.* FROM a LEFT JOIN x ON true LEFT JOIN LATERAL (
    SELECT * FROM (
      ${listedSql('x.id')} WHERE x.team_id IS NOT NULL AND f.team_id=x.team_id AND ${OFFERED}
      UNION ALL
      ${listedSql('x.id')} WHERE x.team_id IS NULL AND f.user_id=x.user_id AND f.team_id IS NULL AND ${OFFERED}
    ) offered ORDER BY offered.name,offered.id LIMIT ${MAX_LISTED_LIBRARIES}
  ) lib ON true`);

const listed = (row: ListedRow): DesignFileLibrary => ({
  id: row.id,
  fileId: row.file_id,
  name: row.name,
  version: Number(row.version),
  publishedAt: row.published_at,
  unpublishedAt: row.unpublished_at,
  description: row.description,
  manifest: JSON.parse(row.manifest) as LibraryManifest,
  enabled: row.enabled,
  available: row.unpublished_at === null && !row.trashed,
  seenVersion: row.seen_version === null ? null : Number(row.seen_version),
});

/** A library of the file's place (never the file's own), whatever its state; 404 for anything else. A guest of the file reaches only
 *  the libraries the file enabled (they use them; they do not browse or enable the place's others). */
async function libraryFor(tx: SqlExecutor, file: DesignFileAccessRow, libraryId: string): Promise<DesignFileLibrary> {
  if (typeof libraryId !== 'string' || !LIBRARY_ID.test(libraryId)) libraryNotFound();
  const scope = scopeOfFile(file);
  const row = await tx.one<ListedRow>(`${LISTED} WHERE ${placeFilter(scope)} AND l.file_id<>$2 AND l.id=$3`, [placeKey(scope), file.id, libraryId]);
  return row && (!file.guest || row.enabled) ? listed(row) : libraryNotFound();
}
/** Publishing a file's library puts it in its place's "Libraries": the place's people do it, never a guest of the file. */
const NO_GUEST_PUBLISH = 'Only the file\'s owner or a team member can publish its library.';

/** "Libraries": every library of the file's place it may enable (published, its file not in the trash) and every one it
 *  enabled (also when unpublished since), by name. */
export async function listFileLibraries(actor: CustomerAuthority, fileId: string): Promise<DesignFileLibraries> {
  const rows = await designReadRows<(ListedRow & {file: string | null}) | {file: string | null; id: null}>(actor, LIBRARIES, [fileId]);
  if (!rows[0].file) return notFound();
  return {libraries: rows.filter((row): row is ListedRow & {file: string} => row.id !== null).map(listed)};
}

// ── The file's own library ───────────────────────────────────────────────────────────────────

async function ownLibrary(tx: SqlExecutor, file: DesignFileAccessRow): Promise<DesignOwnLibrary> {
  const row = await tx.one<Omit<ListedRow, 'enabled' | 'seen_version' | 'trashed'>>(
    `SELECT l.id,l.file_id,f.name,l.version,l.published_at,l.unpublished_at,v.description,v.manifest
     FROM design_libraries l JOIN design_files f ON f.id=l.file_id JOIN design_library_versions v ON v.library_id=l.id AND v.version=l.version
     WHERE l.file_id=$1`,
    [file.id],
  );
  if (!row) return {library: null};
  const versions = await tx.many<{version: number; description: string; created_at: string}>(
    'SELECT version,description,created_at FROM design_library_versions WHERE library_id=$1 ORDER BY version DESC',
    [row.id],
  );
  return {
    library: {
      id: row.id,
      fileId: row.file_id,
      name: row.name,
      version: Number(row.version),
      publishedAt: row.published_at,
      unpublishedAt: row.unpublished_at,
      description: row.description,
      manifest: JSON.parse(row.manifest) as LibraryManifest,
      versions: versions.map((version): DesignLibraryVersionSummary => ({version: Number(version.version), description: version.description, createdAt: version.created_at})),
    },
  };
}

export async function readOwnLibrary(actor: CustomerAuthority, fileId: string): Promise<DesignOwnLibrary> {
  return designRead(actor, async tx => ownLibrary(tx, await fileAccess(tx, actor.ownerId, fileId, 'view')));
}

const cleanDescription = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, LIBRARY_CAPS.description);

/**
 * "Publish library": a new version of the file's library from its stored document at `baseVersion` (the editor saves
 * first). The snapshot holds exactly what the selected assets need; the manifest keeps, for each asset, the version it last
 * changed in. Counted in the holder's room for documents; the newest LIBRARY_CAPS.versionsKept versions are kept. Publishing
 * again after "Unpublish" publishes it again.
 */
export async function publishLibrary(actor: CustomerAuthority, fileId: string, input: DesignLibraryPublish): Promise<DesignOwnLibrary> {
  const caller = actor.ownerId;
  const read = await designRead(actor, async tx => {
    const row = await fileAccess(tx, caller, fileId, 'edit');
    if (row.guest) forbidden(NO_GUEST_PUBLISH);
    if (row.version !== input.baseVersion) conflict(row.version);
    const doc = await storedDocument(tx, row);
    const library = await tx.one<{id: string; version: number}>('SELECT id,version FROM design_libraries WHERE file_id=$1', [row.id]);
    const previous = library
      ? await tx.one<{manifest: string}>('SELECT manifest FROM design_library_versions WHERE library_id=$1 AND version=$2', [library.id, library.version])
      : undefined;
    return {row, doc, library, previous: previous ? (JSON.parse(previous.manifest) as LibraryManifest) : null};
  });
  const version = Number(read.library?.version ?? 0) + 1;
  let snapshot: LibrarySnapshot;
  try {
    snapshot = buildLibrarySnapshot(read.doc, input, {version, previous: read.previous});
  } catch (error) {
    if (error instanceof LibraryError) designFail(400, 'invalid_request', error.message);
    throw error;
  }
  // The stored form passes the same checks a reader applies.
  const checked = validateLibrarySnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (!checked.ok) return designFail(400, 'design_document_invalid', 'Library not published: ' + checked.error.replace(/\.$/, '') + '.', {path: checked.path});
  const snapshotText = JSON.stringify(checked.value),
    manifestText = JSON.stringify(checked.value.manifest);
  const snapshotBytes = Buffer.byteLength(snapshotText),
    manifestBytes = Buffer.byteLength(manifestText);
  if (snapshotBytes > DESIGN_DOCUMENT_CAPS.bytes || manifestBytes > MANIFEST_MAX_BYTES)
    designFail(413, 'design_document_too_large', 'The library is larger than 20 MB. Publish some of the assets.');
  const imageFiles = documentImageFiles(checked.value.document);
  const description = cleanDescription(input.description);
  return designWrite(
    actor,
    async tx => {
      const row = await fileAccess(tx, caller, fileId, 'edit');
      if (row.guest) forbidden(NO_GUEST_PUBLISH);
      if (row.user_id !== read.row.user_id || row.team_id !== read.row.team_id) conflict(row.version);
      const library = await tx.one<{id: string; version: number}>('SELECT id,version FROM design_libraries WHERE file_id=$1 FOR UPDATE', [row.id]);
      if (Number(library?.version ?? 0) !== version - 1)
        designFail(409, 'version_conflict', 'The library was just published from another tab. Open the publication again.', {currentVersion: row.version});
      if (!(await makeRoom(tx, row.user_id, snapshotBytes + manifestBytes))) documentsFull();
      const id = library?.id ?? randomUUID();
      if (library)
        await tx.execute(
          'UPDATE design_libraries SET version=$2,user_id=$3,published_at=clock_timestamp(),unpublished_at=NULL WHERE id=$1',
          [id, version, row.user_id],
        );
      else await tx.execute('INSERT INTO design_libraries(id,file_id,user_id,version) VALUES($1,$2,$3,$4)', [id, row.id, row.user_id, version]);
      await tx.execute(
        `INSERT INTO design_library_versions(id,library_id,user_id,version,file_version,description,manifest,snapshot,bytes,image_files,published_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [randomUUID(), id, row.user_id, version, read.row.version, description, manifestText, snapshotText, snapshotBytes + manifestBytes, imageFiles, caller],
      );
      await tx.execute('DELETE FROM design_library_versions WHERE library_id=$1 AND version<=$2', [id, version - LIBRARY_CAPS.versionsKept]);
      return ownLibrary(tx, row);
    },
    {teams: read.row.team_id ? [read.row.team_id] : []},
  );
}

/** "Unpublish": no file can enable the library any more; files that have it keep their copies. Its versions stay
 *  until the file goes, and publishing again resumes it. */
export async function unpublishLibrary(actor: CustomerAuthority, fileId: string): Promise<DesignOwnLibrary> {
  return designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, fileId, 'edit');
    if (row.guest) forbidden(NO_GUEST_PUBLISH);
    await tx.execute('UPDATE design_libraries SET unpublished_at=COALESCE(unpublished_at,clock_timestamp()) WHERE file_id=$1', [row.id]);
    return ownLibrary(tx, row);
  });
}

// ── Enabling ─────────────────────────────────────────────────────────────────────────────────

/** "Libraries" → on: the file may use the library from now on; the current version counts as seen. */
export async function enableLibrary(actor: CustomerAuthority, fileId: string, libraryId: string): Promise<DesignFileLibrary> {
  return designWrite(actor, async tx => {
    const file = await fileAccess(tx, actor.ownerId, fileId, 'edit');
    const library = await libraryFor(tx, file, libraryId);
    if (library.enabled) return library;
    if (!library.available) unavailable();
    const count = (await tx.one<{n: number}>('SELECT count(*)::int AS n FROM design_library_subscriptions WHERE file_id=$1', [file.id]))!.n;
    if (count >= MAX_ENABLED_LIBRARIES) designFail(409, 'design_file_limit', `The file already uses ${MAX_ENABLED_LIBRARIES} libraries; you cannot add more.`, {limit: MAX_ENABLED_LIBRARIES});
    await tx.execute(
      'INSERT INTO design_library_subscriptions(file_id,library_id,enabled_by,seen_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [file.id, library.id, actor.ownerId, library.version],
    );
    return {...library, enabled: true, seenVersion: library.version};
  });
}

/** "Libraries" → off: nothing new from it; what the file took stays as it is. */
export async function disableLibrary(actor: CustomerAuthority, fileId: string, libraryId: string): Promise<void> {
  await designWrite(actor, async tx => {
    const file = await fileAccess(tx, actor.ownerId, fileId, 'edit');
    const library = await libraryFor(tx, file, libraryId);
    await tx.execute('DELETE FROM design_library_subscriptions WHERE file_id=$1 AND library_id=$2', [file.id, library.id]);
  });
}

/** The file was told about `version` (updated, or "Later"): the greeting waits for a newer one. */
export async function markLibrarySeen(actor: CustomerAuthority, fileId: string, libraryId: string, version: number): Promise<void> {
  await designWrite(actor, async tx => {
    const file = await fileAccess(tx, actor.ownerId, fileId, 'edit');
    const library = await libraryFor(tx, file, libraryId);
    await tx.execute(
      'UPDATE design_library_subscriptions SET seen_version=GREATEST(COALESCE(seen_version,0),LEAST($3::int,$4::int)) WHERE file_id=$1 AND library_id=$2',
      [file.id, library.id, version, library.version],
    );
  });
}

// ── Reading and using ────────────────────────────────────────────────────────────────────────

/** One version's snapshot as stored (thumbnails of assets not used yet, the update review's "after"): for a file that enabled
 *  the library or may enable it. */
export async function readLibraryVersion(actor: CustomerAuthority, fileId: string, libraryId: string, version: number): Promise<string> {
  return designRead(actor, async tx => {
    const file = await fileAccess(tx, actor.ownerId, fileId, 'view');
    const library = await libraryFor(tx, file, libraryId);
    if (!library.enabled && !library.available) unavailable();
    const row = await tx.one<{snapshot: string}>('SELECT snapshot FROM design_library_versions WHERE library_id=$1 AND version=$2', [library.id, version]);
    return row ? row.snapshot : designFail(404, 'not_found', 'Library version not found.');
  });
}

type PictureSource = {filename: string; bytes: number; width: number; height: number};
type Copied = {from: string; to: string; bytes: number; width: number; height: number};

async function storageUsed(tx: SqlExecutor, scope: DesignScope): Promise<number> {
  return Number(scope.kind === 'team' ? await teamStorageUsed(tx, scope.teamId) : await designStorageUsed(tx, scope.userId));
}

/**
 * The part of a library version the requested assets need, for an editor to put into the file: the components with what they
 * use, the styles, the collections. Its pictures are the file's place's: pictures of that place stay as they are; a picture of
 * another place (the library's file moved since that version) is copied into this place once (later uses take the same copy)
 * and counted in its storage; a picture that no longer exists is left out. The file must have enabled the library, and the
 * library must still be published.
 */
export async function importLibraryAssets(
  actor: CustomerAuthority,
  fileId: string,
  libraryId: string,
  input: DesignLibraryImportRequest,
): Promise<DesignLibraryImported> {
  const caller = actor.ownerId;
  const plan = await designRead(actor, async tx => {
    const file = await fileAccess(tx, caller, fileId, 'edit');
    const library = await libraryFor(tx, file, libraryId);
    if (!library.enabled) designFail(409, 'design_library_unavailable', 'First enable the library for the file.');
    if (!library.available) unavailable();
    const row = await tx.one<{snapshot: string}>('SELECT snapshot FROM design_library_versions WHERE library_id=$1 AND version=$2', [library.id, input.version]);
    if (!row) designFail(404, 'not_found', 'Library version not found. Open the assets again.');
    return {file, library, text: row!.snapshot};
  });
  const snapshot = JSON.parse(plan.text) as LibrarySnapshot;
  const part = snapshotPart(snapshot, {components: input.components ?? [], styles: input.styles ?? [], variableCollections: input.variableCollections ?? []});
  const {selection, document} = part;
  if (!selection.components.length && !selection.styles.length && !selection.variableCollections.length)
    designFail(400, 'invalid_request', 'These assets are not in the library version.');

  const scope = scopeOfFile(plan.file);
  const holder = holderOf(scope),
    team = scope.kind === 'team' ? scope.teamId : null;
  const wanted = [...new Set(Object.values(document.images).map(asset => asset.url.slice('/uploads/'.length)))];
  // Which pictures are already this place's, which were copied here before, and where the others come from.
  const pictures = await designRead(actor, async tx => {
    if (!wanted.length) return {owned: new Set<string>(), copies: new Map<string, string>(), sources: [] as PictureSource[], uploads: [] as string[]};
    const owned = team
      ? await tx.many<{filename: string}>("SELECT filename FROM design_images WHERE team_id=$1 AND kind='image' AND filename=ANY($2::text[])", [team, wanted])
      : await tx.many<{filename: string}>(
          `SELECT filename FROM design_images WHERE user_id=$1 AND team_id IS NULL AND kind='image' AND filename=ANY($2::text[])
           UNION SELECT filename FROM uploads WHERE user_id=$1 AND ready=1 AND filename=ANY($2::text[])`,
          [holder, wanted],
        );
    const mine = new Set(owned.map(row => row.filename));
    const rest = wanted.filter(file => !mine.has(file));
    const copies = new Map<string, string>();
    for (const row of rest.length
      ? await tx.many<{source: string; filename: string}>(
          `SELECT p.source,p.filename FROM design_library_pictures p JOIN design_images d ON d.filename=p.filename
           WHERE p.source=ANY($1::text[]) AND d.user_id=$2 AND d.team_id IS NOT DISTINCT FROM $3 AND d.kind='image' ORDER BY p.created_at`,
          [rest, holder, team],
        )
      : [])
      if (!copies.has(row.source)) copies.set(row.source, row.filename);
    const missing = rest.filter(file => !copies.has(file));
    const sources = missing.length
      ? await tx.many<PictureSource>("SELECT filename,bytes,width,height FROM design_images WHERE kind='image' AND filename=ANY($1::text[])", [missing])
      : [];
    const fromLibrary = new Set(sources.map(source => source.filename));
    const uploads = missing.length
      ? (await tx.many<{filename: string}>('SELECT filename FROM uploads WHERE ready=1 AND filename=ANY($1::text[])', [missing.filter(file => !fromLibrary.has(file))])).map(row => row.filename)
      : [];
    return {owned: mine, copies, sources, uploads};
  });

  // Copies made outside the transaction; a failed write removes them.
  const made: Copied[] = [];
  try {
    for (const source of pictures.sources) {
      const to = newImageFilename('image', source.filename.endsWith('.png') ? 'png' : 'webp');
      try {
        await copyImageFile(source.filename, to);
      } catch {
        continue; // Its file is gone: the picture is left out.
      }
      made.push({from: source.filename, to, bytes: Number(source.bytes), width: source.width, height: source.height});
    }
    for (const filename of pictures.uploads) {
      let data: Buffer;
      try {
        data = await fs.readFile(path.join(dataDir, 'uploads', path.basename(filename)));
      } catch {
        continue;
      }
      const encoded = await encodeDesignImage(data);
      const to = newImageFilename('image', encoded.extension);
      await writeImageFile(to, encoded.data);
      made.push({from: filename, to, bytes: encoded.data.length, width: encoded.width, height: encoded.height});
    }
  } catch (error) {
    await removeImageFiles(made.map(copy => copy.to));
    throw error;
  }
  if (made.length) {
    try {
      await designWrite(
        actor,
        async tx => {
          const file = await fileAccess(tx, caller, fileId, 'edit');
          if (file.user_id !== plan.file.user_id || file.team_id !== plan.file.team_id) conflict(file.version);
          const used = await storageUsed(tx, scope);
          const adding = made.reduce((sum, copy) => sum + copy.bytes, 0);
          if (used + adding > DESIGN_LIMITS.storageBytes) storageFull(used);
          for (const copy of made) {
            await tx.execute(
              "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,'image',$5,$6,$7)",
              [copy.to, holder, team, file.id, copy.bytes, copy.width, copy.height],
            );
            await tx.execute('INSERT INTO design_library_pictures(filename,source) VALUES($1,$2)', [copy.to, copy.from]);
          }
        },
        {teams: team ? [team] : []},
      );
    } catch (error) {
      await removeImageFiles(made.map(copy => copy.to));
      throw error;
    }
  }
  const copied = new Map(made.map(copy => [copy.from, copy.to]));
  const images: DesignDocument['images'] = {};
  for (const [ref, asset] of Object.entries(document.images)) {
    const file = asset.url.slice('/uploads/'.length);
    if (pictures.owned.has(file)) images[ref] = asset;
    else if (pictures.copies.has(file)) images[ref] = {...asset, url: imageUrl(pictures.copies.get(file)!)};
    else if (copied.has(file)) images[ref] = {...asset, url: imageUrl(copied.get(file)!)};
  }
  return {
    import: {
      libraryId: plan.library.id,
      version: input.version,
      components: [...selection.components],
      styles: [...selection.styles],
      variableCollections: [...selection.variableCollections],
      document: {...document, images},
    },
  };
}
