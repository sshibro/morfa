import {db} from '../db';
import {eraseDesignFavouritesOf, exportDesignFavourites} from './favourites';
import type {TransactionContext} from '../postgresql/client';
import {lockResources} from '../postgresql/locks';
import {exportRows, exportSection, type ExportValue} from '../launch/export-json';
import {DESIGN_LIMITS} from '../../shared/design/limits';
import {eraseDesignCommentsOf} from './comments';
import {eraseDesignMeetingsOf} from './meeting/service';
import {eraseDesignTemplatesOf} from './templates';
import {forgetDocument} from './document-cache';
import {BASE_OF, WAITING_CHANGES_OF, wholeTextOf, type Stored} from './document-store';
import {lockAccount, lockTeams, versionOf} from './file-access';
import {eraseFileWithin} from './files';
import {removeImageFiles} from './images';
import {eraseLibraryRows, exportLibraryRows} from './library-rows';

const SWEEP_BATCH = 500;

/**
 * Erases files that stayed in the trash longer than the trash is kept (`DESIGN_LIMITS.trashDays`), with their
 * versions, thumbnails and the pictures no other file uses. Each file is its own transaction under the owner's
 * account lock; one failure does not stop the rest and is thrown after the batch (the scheduler retries next run).
 * Closing accounts are left to the account erasure. Not scheduled here: the caller runs it (hourly is plenty).
 */
export async function sweepDesignTrash(now = new Date()): Promise<{erased: number}> {
  const due = await db.many<{id: string; user_id: string; team_id: string | null}>(
    `SELECT f.id,f.user_id,f.team_id FROM design_files f JOIN users u ON u.id=f.user_id
     WHERE f.trashed_at IS NOT NULL AND f.trashed_at<$1::timestamptz-make_interval(days=>$2::int) AND u.deletion_requested_at IS NULL
     ORDER BY f.trashed_at,f.id LIMIT $3`,
    [now, DESIGN_LIMITS.trashDays, SWEEP_BATCH],
  );
  const failures: unknown[] = [];
  let erased = 0;
  for (const file of due) {
    try {
      const done = await db.transaction(async tx => {
        await lockAccount(tx, file.user_id);
        // A deleted team's files leave after the trash days too.
        if (file.team_id) await lockTeams(tx, [file.team_id]);
        const still = await tx.one(
          'SELECT id FROM design_files WHERE id=$1 AND user_id=$2 AND trashed_at<$3::timestamptz-make_interval(days=>$4::int)',
          [file.id, file.user_id, now, DESIGN_LIMITS.trashDays],
        );
        if (!still) return false;
        await eraseFileWithin(tx, file.user_id, file.id);
        return true;
      });
      if (done) {
        erased++;
        forgetDocument(file.id);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    console.error('[design] trash sweep: ' + failures.length + ' file(s) failed; retrying next run.');
    throw failures[0];
  }
  await sweepDeletedTeams();
  return {erased};
}

/** A deleted team whose files are all erased goes with its members, links and projects. One transaction per team under its owner's and its own lock. */
async function sweepDeletedTeams(): Promise<void> {
  const teams = await db.many<{id: string; owner_id: string}>(
    `SELECT t.id,t.owner_id FROM design_teams t WHERE t.deleted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM design_files f WHERE f.team_id=t.id) ORDER BY t.deleted_at,t.id LIMIT 100`,
  );
  for (const team of teams)
    await db.transaction(async tx => {
      await lockTeamRows(tx, team.owner_id, team.id);
      if (await tx.one('SELECT 1 FROM design_files WHERE team_id=$1 LIMIT 1', [team.id])) return;
      await tx.execute('DELETE FROM design_teams WHERE id=$1 AND deleted_at IS NOT NULL', [team.id]);
    });
}

/**
 * Account erasure, before its transaction: the teams the account owns are deleted under their own locks (the erasure's transaction takes no further lock), then the picture and thumbnail files go first,
 * as uploads do: the account's own and those of the teams it held (docs/design-tool.md §Teams).
 */
export async function removeDesignAccountFiles(userId: string): Promise<void> {
  const owned = await db.many<{id: string}>('SELECT id FROM design_teams WHERE owner_id=$1 ORDER BY id', [userId]);
  for (const team of owned)
    await db.transaction(async tx => {
      // The account is closing (lockAccount would refuse it): its lock is taken as it is.
      await lockTeamRows(tx, userId, team.id);
      await tx.execute('UPDATE design_teams SET deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE id=$1', [team.id]);
      await tx.execute('UPDATE design_team_invites SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE team_id=$1', [team.id]);
    });
  const rows = await db.many<{filename: string}>('SELECT filename FROM design_images WHERE user_id=$1', [userId]);
  await removeImageFiles(rows.map(row => row.filename));
}
/** The system's own lock of a team's rows: its owner's account, then the team. The owner may be
 * closing: no session or live account is asked. */
async function lockTeamRows(tx: TransactionContext, ownerId: string, teamId: string) {
  await lockResources(tx, [{kind: 'account', id: ownerId}]);
  await lockTeams(tx, [teamId]);
}

/** Account erasure, inside its transaction: every design row the account holds (its files and the files of the teams it owned, with
 * their versions, pictures and shared libraries; files elsewhere keep the copies they took), its memberships, and the teams it owned with their members, links and projects. The user row is
 * anonymised, not deleted, so the foreign-key cascade never fires. Takes no lock: the erasure holds the account's. */
export async function eraseDesignAccount(tx: TransactionContext, userId: string): Promise<void> {
  await eraseLibraryRows(tx, userId);
  await tx.execute('DELETE FROM design_images WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM design_file_versions WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM design_files WHERE user_id=$1', [userId]);
  // Comments in those files went with them; the account's comments in files other accounts hold stay, detached (comments.ts).
  await eraseDesignCommentsOf(tx, userId);
  // Its ballots in other people's files go; the timers and votes it started there name nobody (server/design/meeting/).
  await eraseDesignMeetingsOf(tx, userId);
  await eraseDesignTemplatesOf(tx, userId);
  await tx.execute('DELETE FROM design_team_members WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM design_teams WHERE owner_id=$1', [userId]);
  await tx.execute('UPDATE design_team_members SET invited_by=NULL WHERE invited_by=$1', [userId]);
  await tx.execute('UPDATE design_team_invites SET created_by=NULL WHERE created_by=$1', [userId]);
  // Files shared with the account (SQL015): it leaves them; the people it shared files with keep them, named by nobody.
  await tx.execute('DELETE FROM design_file_members WHERE user_id=$1', [userId]);
  await tx.execute('UPDATE design_file_members SET invited_by=NULL WHERE invited_by=$1', [userId]);
  // Its stars (SQL018): only it saw them.
  await eraseDesignFavouritesOf(tx, userId);
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The account's data export (152-FZ): its design files with their documents as stored, the saved versions
 * (when and how they were named; their documents are earlier states of the same files) and the pictures'
 * metadata. One row per read, keyset by id, so memory is bounded by one document.
 */
export function exportDesignAccount(ownerId: string): ExportValue {
  return exportSection({
    files: exportRows(async function* (tx) {
      let cursor: string | null = null;
      for (;;) {
        // The stored text (or collab's checkpoint) with the changes after it (document-store.ts), in the same statement.
        const row:
          | (Stored & {
              id: string;
              name: string;
              version: number;
              created_at: string;
              updated_at: string;
              trashed_at: string | null;
              team_id: string | null;
            })
          | undefined = await tx.one(
          `SELECT f.id,f.name,${BASE_OF('f')},${versionOf('f')} AS version,f.team_id,c.versions,c.patches,c.ops,to_char(f.created_at AT TIME ZONE 'UTC',${ISO}) AS created_at,
                    to_char(f.updated_at AT TIME ZONE 'UTC',${ISO}) AS updated_at,to_char(f.trashed_at AT TIME ZONE 'UTC',${ISO}) AS trashed_at
             FROM design_files f ${WAITING_CHANGES_OF('f')} WHERE f.user_id=$1 AND ($2::text IS NULL OR f.id>$2) ORDER BY f.id LIMIT 1`,
          [ownerId, cursor],
        );
        if (!row) return;
        cursor = row.id;
        yield {
          id: row.id,
          name: row.name,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          trashedAt: row.trashed_at,
          // A file of a team the account owns (docs/design-tool.md §Teams); null for a personal file.
          teamId: row.team_id,
          // The document at the file's version: the stored text, with the changes waiting after it applied.
          document: await wholeTextOf(row),
        };
      }
    }),
    versions: exportRows(async function* (tx) {
      let cursor: string | null = null;
      for (;;) {
        const row:
          {id: string; file_id: string; version: number; label: string | null; created_at: string} | undefined =
          await tx.one(
            `SELECT id,file_id,version,label,to_char(created_at AT TIME ZONE 'UTC',${ISO}) AS created_at
           FROM design_file_versions WHERE user_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 1`,
            [ownerId, cursor],
          );
        if (!row) return;
        cursor = row.id;
        yield {id: row.id, fileId: row.file_id, version: row.version, label: row.label, createdAt: row.created_at};
      }
    }),
    // The shared libraries its files publish (each version's manifest and snapshot) and the ones its files enabled (§Teams).
    libraries: exportLibraryRows(ownerId),
    // The teams the account belongs to and its role in each (docs/design-tool.md §Teams); the other members are theirs, not exported here.
    teams: exportRows(async function* (tx) {
      const rows = await tx.many<{id: string; name: string; role: string; joined_at: string; owner: boolean; deleted_at: string | null}>(
        `SELECT t.id,t.name,m.role,to_char(m.joined_at AT TIME ZONE 'UTC',${ISO}) AS joined_at,t.owner_id=$1 AS owner,
           to_char(t.deleted_at AT TIME ZONE 'UTC',${ISO}) AS deleted_at
         FROM design_team_members m JOIN design_teams t ON t.id=m.team_id WHERE m.user_id=$1 ORDER BY m.joined_at,t.id LIMIT 1000`,
        [ownerId],
      );
      for (const row of rows)
        yield {id: row.id, name: row.name, role: row.role, joinedAt: row.joined_at, owner: row.owner, deletedAt: row.deleted_at};
    }),
    // The comments the account wrote, in any file it could open then (docs/design-tool.md §Teams "Comments"): its own words; the
    // threads' other comments are their authors'.
    comments: exportRows(async function* (tx) {
      let cursor: string | null = null;
      for (;;) {
        const rows: {id: string; thread_id: string; file_id: string; body: string; created_at: string; edited_at: string | null; first: boolean}[] =
          await tx.many(
            `SELECT c.id,c.thread_id,t.file_id,c.body,to_char(c.created_at AT TIME ZONE 'UTC',${ISO}) AS created_at,
               to_char(c.edited_at AT TIME ZONE 'UTC',${ISO}) AS edited_at,c.seq=(SELECT min(f.seq) FROM design_comments f WHERE f.thread_id=t.id) AS first
             FROM design_comments c JOIN design_comment_threads t ON t.id=c.thread_id
             WHERE c.author_id=$1 AND ($2::text IS NULL OR c.id>$2) ORDER BY c.id LIMIT 200`,
            [ownerId, cursor],
          );
        if (!rows.length) return;
        for (const row of rows)
          yield {id: row.id, threadId: row.thread_id, fileId: row.file_id, startsThread: row.first, text: row.body, createdAt: row.created_at, editedAt: row.edited_at};
        cursor = rows[rows.length - 1]!.id;
      }
    }),
    // Its votes in voting sessions that are still kept (docs/board-meeting.md): which object of which file, how many dots.
    meetingVotes: exportRows(async function* (tx) {
      const rows = await tx.many<{file_id: string; vote_id: string; node_id: string; count: number}>(
        'SELECT file_id,vote_id,node_id,count FROM design_meeting_votes WHERE user_id=$1 ORDER BY file_id,vote_id,node_id LIMIT 10000',
        [ownerId],
      );
      for (const row of rows) yield {fileId: row.file_id, voteId: row.vote_id, nodeId: row.node_id, count: Number(row.count)};
    }),
    // What it starred ("Favorites", SQL018): which file or project, and when (server/design/favourites.ts).
    favourites: exportDesignFavourites(ownerId),
    pictures: exportRows(async function* (tx) {
      let cursor: string | null = null;
      for (;;) {
        const row:
          | {
              filename: string;
              file_id: string | null;
              kind: string;
              bytes: number;
              width: number;
              height: number;
              created_at: string;
            }
          | undefined = await tx.one(
          `SELECT filename,file_id,kind,bytes,width,height,to_char(created_at AT TIME ZONE 'UTC',${ISO}) AS created_at
             FROM design_images WHERE user_id=$1 AND ($2::text IS NULL OR filename>$2) ORDER BY filename LIMIT 1`,
          [ownerId, cursor],
        );
        if (!row) return;
        cursor = row.filename;
        yield {
          url: '/uploads/' + row.filename,
          fileId: row.file_id,
          kind: row.kind,
          bytes: row.bytes,
          width: row.width,
          height: row.height,
          createdAt: row.created_at,
        };
      }
    }),
  });
}
