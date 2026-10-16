import type {SqlExecutor, TransactionContext} from '../postgresql/client';
import {exportRows, exportSection, type ExportValue} from '../launch/export-json';

// The rows of "Morfa" shared libraries (SQL036, docs/design-tool.md §Teams) as the rest of the design server moves,
// counts, erases and exports them. A library's rows are held by the account that holds its file (`user_id`), so they follow
// the file into another place and a team to its new owner; they go with the file by cascade. Kept apart from libraries.ts so
// files.ts, teams.ts and lifecycle.ts can use it without importing the library routes' logic.

/** Bytes of a team's library versions (its files' publications), which join a new owner's room with the team. */
export async function teamLibraryBytes(tx: SqlExecutor, teamId: string): Promise<number> {
  const row = await tx.one<{bytes: number}>(
    `SELECT COALESCE(sum(v.bytes),0) AS bytes FROM design_library_versions v JOIN design_libraries l ON l.id=v.library_id
     JOIN design_files f ON f.id=l.file_id WHERE f.team_id=$1`,
    [teamId],
  );
  return Number(row!.bytes);
}

/** Bytes of one file's library versions, which move with the file. */
export async function fileLibraryBytes(tx: SqlExecutor, fileId: string): Promise<number> {
  const row = await tx.one<{bytes: number}>(
    'SELECT COALESCE(sum(v.bytes),0) AS bytes FROM design_library_versions v JOIN design_libraries l ON l.id=v.library_id WHERE l.file_id=$1',
    [fileId],
  );
  return Number(row!.bytes);
}

/** A team handed over: its files' libraries and their versions are held by the new owner. */
export async function reholdTeamLibraries(tx: TransactionContext, teamId: string, ownerId: string): Promise<void> {
  await tx.execute('UPDATE design_libraries SET user_id=$2 WHERE file_id IN (SELECT id FROM design_files WHERE team_id=$1)', [teamId, ownerId]);
  await tx.execute(
    `UPDATE design_library_versions SET user_id=$2 WHERE library_id IN
       (SELECT l.id FROM design_libraries l JOIN design_files f ON f.id=l.file_id WHERE f.team_id=$1)`,
    [teamId, ownerId],
  );
}

/**
 * A file moved between a team and personal files: its library and versions follow the file's new holder. A library is offered
 * only inside its file's place, so the links between this file and the place it left go: its own subscriptions to that place's
 * libraries, and other files' subscriptions to its library. Every file keeps the copies it took.
 */
export async function moveFileLibraries(tx: TransactionContext, fileId: string, holder: string): Promise<void> {
  await tx.execute('UPDATE design_libraries SET user_id=$2 WHERE file_id=$1', [fileId, holder]);
  await tx.execute('UPDATE design_library_versions SET user_id=$2 WHERE library_id IN (SELECT id FROM design_libraries WHERE file_id=$1)', [fileId, holder]);
  await tx.execute('DELETE FROM design_library_subscriptions WHERE file_id=$1', [fileId]);
  await tx.execute('DELETE FROM design_library_subscriptions WHERE library_id IN (SELECT id FROM design_libraries WHERE file_id=$1)', [fileId]);
}

/** A copy of a file starts with the libraries its source had enabled (the copies in its document came from them). */
export async function copySubscriptions(tx: TransactionContext, fromFileId: string, toFileId: string, enabledBy: string): Promise<void> {
  await tx.execute(
    `INSERT INTO design_library_subscriptions(file_id,library_id,enabled_by,seen_version)
     SELECT $2,library_id,$3,seen_version FROM design_library_subscriptions WHERE file_id=$1 ON CONFLICT DO NOTHING`,
    [fromFileId, toFileId, enabledBy],
  );
}

/** Account erasure, inside its transaction: the libraries of every file the account holds, their versions, and the
 *  subscriptions of those files (the files themselves go right after). Picture copies go with their pictures. */
export async function eraseLibraryRows(tx: TransactionContext, userId: string): Promise<void> {
  await tx.execute('DELETE FROM design_library_subscriptions WHERE file_id IN (SELECT id FROM design_files WHERE user_id=$1)', [userId]);
  await tx.execute('DELETE FROM design_library_versions WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM design_libraries WHERE user_id=$1', [userId]);
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The account's data export: the libraries its files publish, each version with its description, manifest and snapshot (one
 *  row per read, keyset by id, so memory is bounded by one snapshot), and the libraries its files have enabled. */
export function exportLibraryRows(ownerId: string): ExportValue {
  return exportSection({
    published: exportRows(async function* (tx) {
      const rows = await tx.many<{id: string; file_id: string; version: number; published_at: string; unpublished_at: string | null}>(
        `SELECT id,file_id,version,to_char(published_at AT TIME ZONE 'UTC',${ISO}) AS published_at,
           to_char(unpublished_at AT TIME ZONE 'UTC',${ISO}) AS unpublished_at
         FROM design_libraries WHERE user_id=$1 ORDER BY id LIMIT 5000`,
        [ownerId],
      );
      for (const row of rows) yield {id: row.id, fileId: row.file_id, version: row.version, publishedAt: row.published_at, unpublishedAt: row.unpublished_at};
    }),
    versions: exportRows(async function* (tx) {
      let cursor: string | null = null;
      for (;;) {
        const row:
          | {id: string; library_id: string; version: number; file_version: number; description: string; manifest: string; snapshot: string; created_at: string}
          | undefined = await tx.one(
          `SELECT id,library_id,version,file_version,description,manifest,snapshot,to_char(created_at AT TIME ZONE 'UTC',${ISO}) AS created_at
           FROM design_library_versions WHERE user_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 1`,
          [ownerId, cursor],
        );
        if (!row) return;
        cursor = row.id;
        yield {
          id: row.id,
          libraryId: row.library_id,
          version: row.version,
          fileVersion: Number(row.file_version),
          description: row.description,
          createdAt: row.created_at,
          manifest: row.manifest,
          snapshot: row.snapshot,
        };
      }
    }),
    enabled: exportRows(async function* (tx) {
      const rows = await tx.many<{file_id: string; library_id: string; enabled_at: string; seen_version: number | null}>(
        `SELECT s.file_id,s.library_id,to_char(s.enabled_at AT TIME ZONE 'UTC',${ISO}) AS enabled_at,s.seen_version
         FROM design_library_subscriptions s JOIN design_files f ON f.id=s.file_id WHERE f.user_id=$1 ORDER BY s.file_id,s.library_id LIMIT 100000`,
        [ownerId],
      );
      for (const row of rows) yield {fileId: row.file_id, libraryId: row.library_id, enabledAt: row.enabled_at, seenVersion: row.seen_version};
    }),
  });
}
