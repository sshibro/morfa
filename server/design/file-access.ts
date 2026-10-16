import {db} from '../db';
import {prepared, type SqlExecutor, type TransactionContext} from '../postgresql/client';
import {lockResources, type LockResource} from '../postgresql/locks';
import {assertCustomerAuthority, type CustomerAuthority} from '../customer-authority';
import {mcpConnectionReads} from '../mcp/authority';
import {fail} from '../hosting/errors';
import {
  canEditTeamFiles,
  canManageTeam,
  type DesignFileLinkAccess,
  type DesignTeamRole,
} from '../../shared/design/teams';
import type {DesignFileKind} from '../../shared/design/api';
import {designFail, notFound} from './errors';

/** A design file's row without its document (which can be 20 MB). For a team file `user_id` is the team's owner, who holds its rows. */
export type DesignFileRow = {
  id: string;
  user_id: string;
  team_id: string | null;
  project_id: string | null;
  name: string;
  version: number;
  bytes: number;
  node_count: number;
  thumbnail_filename: string | null;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
  auto_version_at: string | null;
  /** "Board" (SQL039): a board or a design file, fixed when the file is made (docs/board.md §File kind). */
  kind: DesignFileKind;
  /** SQL015: who besides the file's place may open it by its link: nobody, or anyone signed in, to view or to edit. */
  link_access: DesignFileLinkAccess;
};
const COLUMNS = [
  'id',
  'user_id',
  'team_id',
  'project_id',
  'name',
  'version',
  'bytes',
  'node_count',
  'thumbnail_filename',
  'created_at',
  'updated_at',
  'trashed_at',
  'auto_version_at',
  'kind',
  'link_access',
] as const;
/**
 * The file's version, as SQL, for `design_files <alias>`: `design_files.version`, or the collab journal's counter beside it when that
 * is greater (SQL016: a collab node run with MORFA_JOURNAL_VERSION_HEADS=1 moves `design_file_heads.version` on every commit instead
 * of the file's wide row, and its checkpoints fold it back; docs/BACKEND.md §3). Every read of a file's version
 * goes through it, and every write bumps from it (`versionOf(…)+1`), which leaves the head behind for good. Without the switch no head
 * exists and it is `<alias>.version`.
 */
export const versionOf = (alias: string) =>
  `greatest(${alias}.version,coalesce((SELECT h.version FROM design_file_heads h WHERE h.file_id=${alias}.id),0))`;
/** The columns of `design_files <alias>` (`design_files` itself when it has no alias), the version through `versionOf`. */
export const fileColumnsOf = (alias: string) =>
  COLUMNS.map(column => (column === 'version' ? `${versionOf(alias)} AS version` : alias + '.' + column)).join(',');
/** The columns of `design_files`, unaliased (a SELECT from it, an INSERT's or UPDATE's RETURNING). */
export const FILE_COLUMNS = fileColumnsOf('design_files');

/** view: open, read versions, export (the trash too); edit: change the document, name, pictures (never in the trash); share: invite
 * people to the file and set its link (whoever may edit it, as in Figma); admin: trash, restore, erase, move. */
export type DesignNeed = 'view' | 'edit' | 'share' | 'admin';
/** The file and the caller's role in it: 'owner' for a personal file of the caller, the team role for a team file, 'editor' or 'viewer'
 * for a guest (someone the file was shared with, or who opened it by its link: `guest`). */
export type DesignFileAccessRow = DesignFileRow & {
  role: DesignTeamRole;
  team_name: string | null;
  guest: boolean;
  guest_row: boolean;
};

/**
 * THE rule of who may open a file, as SQL joins over `design_files ${f}` for the account `user` (a parameter or a column): adds
 * `fa_role.role` (null: no access), `fa_role.guest` and `fa_parts.guest_row` (the account has a row in the file's guests). Used by
 * fileAccess below, collab's /session and its permission pushes (server/design/collab), the picture reads, "Shared with me", favourites,
 * the libraries, comments and the MCP server's file list, so they never disagree.
 * - A personal file: its owner ('owner').
 * - A team file: the members of its live team, with their team role.
 * - A guest (SQL015): an invite's role, or the file's link access ('edit' → editor, 'view' → viewer), the higher one; never for a file in
 *   the trash or of a deleted team. A team member who is also a guest has the higher of the two.
 */
export function fileRoleJoins(f: string, user: string): string {
  return `CROSS JOIN LATERAL (
      SELECT (SELECT m.role FROM design_teams t JOIN design_team_members m ON m.team_id=t.id AND m.user_id=${user}
                WHERE t.id=${f}.team_id AND t.deleted_at IS NULL) AS team_role,
             g.present AS guest_row,
             CASE WHEN ${f}.trashed_at IS NULL AND (${f}.team_id IS NULL OR EXISTS(SELECT 1 FROM design_teams t WHERE t.id=${f}.team_id AND t.deleted_at IS NULL))
               THEN CASE WHEN g.role='editor' OR ${f}.link_access='edit' THEN 'editor' WHEN g.role='viewer' OR ${f}.link_access='view' THEN 'viewer' END
             END AS guest_role
        FROM (SELECT (SELECT x.role FROM design_file_members x WHERE x.file_id=${f}.id AND x.user_id=${user}) AS role,
                     EXISTS(SELECT 1 FROM design_file_members x WHERE x.file_id=${f}.id AND x.user_id=${user}) AS present) g
    ) fa_parts
    CROSS JOIN LATERAL (
      SELECT CASE WHEN ${f}.team_id IS NULL AND ${f}.user_id=${user} THEN 'owner'
                  WHEN fa_parts.team_role IN('owner','admin','editor') THEN fa_parts.team_role
                  WHEN fa_parts.guest_role='editor' THEN 'editor'
                  WHEN fa_parts.guest_role IS NOT NULL THEN COALESCE(fa_parts.team_role,'viewer')
                  ELSE fa_parts.team_role END AS role,
             NOT (${f}.team_id IS NULL AND ${f}.user_id=${user}) AND fa_parts.team_role IS NULL AS guest
    ) fa_role`;
}

const FILE_ID = /^[0-9a-f-]{36}$/;
export const READ_ONLY = 'View only: the owner, admins and editors can change team files.';
export const MANAGERS_ONLY = 'Only the team owner and admins can do this.';
export const forbidden = (message: string): never => designFail(403, 'design_forbidden', message);

/**
 * The pictures among `names` (an SQL text[]) that `user` may read as a guest: those of the files shared with them (or opened by their
 * link) that they still have, used by the file (its document, a saved version, uploaded into it, its thumbnail). The guests' half of
 * GET /uploads/:filename's rule (server/app.ts), the PDF export's and the AI's.
 */
export const guestPicturesSql = (names: string, user: string) => `SELECT d.filename FROM design_file_members x
    JOIN design_files f ON f.id=x.file_id
    ${fileRoleJoins('f', user)}
    JOIN design_images d ON d.filename=ANY(${names}) AND d.user_id=f.user_id AND d.team_id IS NOT DISTINCT FROM f.team_id
   WHERE x.user_id=${user} AND fa_role.role IS NOT NULL
     AND (d.file_id=f.id OR d.filename=ANY(f.image_files) OR f.thumbnail_filename=d.filename
          OR EXISTS(SELECT 1 FROM design_file_versions v WHERE v.file_id=f.id AND d.filename=ANY(v.image_files)))`;

export const GUEST_READ_ONLY = 'View only: this file was shared with you for viewing.';
export const OWNER_ONLY_FILE = 'Only the file owner can do this.';

/**
 * THE authorization decision of the files API: every route reaches a file only through here (docs/design-tool.md §Teams). A personal file
 * belongs to one account and its owner may do everything. A team file is visible to every member of its live team: view is any member,
 * edit is an editor, an admin or the owner, admin is an admin or the owner. A guest (the file shared with them, or opened by its link)
 * views, or edits and shares as an editor, never admin. Anyone else gets 404, as for a
 * file that does not exist; someone whose role does not allow the need gets 403 `design_forbidden`. Call it inside the request's transaction, after its account lock for writes.
 */
export async function fileAccess(
  tx: SqlExecutor,
  userId: string,
  fileId: string,
  need: DesignNeed,
): Promise<DesignFileAccessRow> {
  if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) return notFound();
  const row = await tx.one<DesignFileAccessRow>(FILE_ACCESS, [fileId, userId]);
  if (!row) return notFound();
  if ((need === 'edit' || need === 'share') && !canEditTeamFiles(row.role))
    forbidden(row.guest ? GUEST_READ_ONLY : READ_ONLY);
  if (need === 'admin' && (row.guest || !canManageTeam(row.role)))
    forbidden(row.guest ? OWNER_ONLY_FILE : MANAGERS_ONLY);
  if ((need === 'edit' || need === 'share') && row.trashed_at !== null) return notFound();
  return row;
}

/** The expiry of the caller's live session (`account`, `session`: SQL expressions), no row when it ended or the account is closing. */
export const sessionExpirySql = (account: string, session: string) =>
  `SELECT s.expires FROM users u JOIN sessions s ON s.user_id=u.id
   WHERE u.id=${account} AND s.token=${session} AND u.deletion_requested_at IS NULL`;
/** 401 unless `sessionExpirySql` found a session that has not expired. */
export function assertLiveSession(expires: number | null | undefined) {
  if (expires === null || expires === undefined || expires <= Date.now()) fail(401, 'unauthorized', 'Sign in to continue.');
}
const SESSION_EXPIRY = prepared(sessionExpirySql('$1', '$2'));
/** `fileAccess`'s row of the file `file` for the account `user` (SQL expressions): the file's columns, the caller's `role` (THE rule,
 *  `fileRoleJoins`), whether they are a `guest` and have a `guest_row`, and the `team_name`; no row when the file is not the caller's to see. For a
 *  one-statement read (`designReadRows`) too: it ends in its WHERE clause, so a caller may add `AND …`. */
export const fileAccessSql = (file: string, user: string) =>
  `SELECT ${fileColumnsOf('f')},fa_role.role,fa_role.guest,fa_parts.guest_row,t.name AS team_name
     FROM design_files f
     ${fileRoleJoins('f', user)}
     LEFT JOIN design_teams t ON t.id=f.team_id AND t.deleted_at IS NULL
     WHERE f.id=${file} AND fa_role.role IS NOT NULL`;
const FILE_ACCESS = prepared(fileAccessSql('$1', '$2'));

async function readAuthority(actor: CustomerAuthority, sql: SqlExecutor) {
  // An assistant's connection (server/mcp/authority.ts) has no session: its token is checked instead.
  if (actor.mcpToken !== undefined) {
    if (!(await mcpConnectionReads(sql, actor.ownerId, actor.mcpToken))) assertLiveSession(null);
    return;
  }
  assertLiveSession((await sql.one<{expires: number}>(SESSION_EXPIRY, [actor.ownerId, actor.sessionHash]))?.expires);
}

/** One consistent read-only view for a customer read; the session is checked again after it, so no bytes of a
 * signed-out or closing account leave the server (as server/projects-router.ts). */
export async function designRead<T>(
  actor: CustomerAuthority,
  work: (tx: TransactionContext) => Promise<T>,
): Promise<T> {
  const captured = {...actor};
  const result = await db.transaction(
    async tx => {
      await readAuthority(captured, tx);
      return work(tx);
    },
    {readOnly: true, isolation: 'repeatable read'},
  );
  await readAuthority(captured, db);
  return result;
}

/** The session check of a one-statement read (`designReadOne`): `$1` is the account, `$2` its session's hash. */
export const SESSION_EXPIRY_SQL = sessionExpirySql('$1', '$2');
/**
 * A customer read that is one statement: one snapshot, so no transaction (lane A7, TARGETS A1/A5: five fewer round trips than
 * `designRead`). `sql` selects `(${SESSION_EXPIRY_SQL}) AS expires` in a one-row CTE, gates its reads on it, and answers at least that
 * row (its data LEFT JOINed to it); its own parameters start at `$3`. 401 unless that session lives; the session is checked again
 * after the statement, as `designRead` does. Answers every row.
 */
export async function designReadRows<T>(actor: CustomerAuthority, sql: string, params: readonly unknown[]): Promise<T[]> {
  const captured = {...actor};
  const rows = await db.many<T & {expires: number | null}>(sql, [captured.ownerId, captured.sessionHash, ...params]);
  assertLiveSession(rows[0]?.expires);
  await readAuthority(captured, db);
  return rows;
}
/** `designReadRows` of a statement that answers one row. */
export const designReadOne = async <T>(actor: CustomerAuthority, sql: string, params: readonly unknown[]): Promise<T> =>
  (await designReadRows<T>(actor, sql, params))[0];

/** A customer write: the account lock first (pictures, limits and erasure meet under it), then the session, then the teams it changes (project rank, after every account). */
export async function designWrite<T>(
  actor: CustomerAuthority,
  work: (tx: TransactionContext) => Promise<T>,
  locks: {teams?: readonly string[]} = {},
): Promise<T> {
  const captured = {...actor};
  return db.transaction(async tx => {
    await lockAccount(tx, captured.ownerId);
    await assertCustomerAuthority(tx, captured.ownerId, captured);
    if (locks.teams?.length) await lockTeams(tx, locks.teams);
    return work(tx);
  });
}

/** The account lock and a live account, for customer writes and the system's own (the trash sweep). */
export async function lockAccount(tx: TransactionContext, userId: string) {
  await lockResources(tx, [{kind: 'account', id: userId}]);
  if (!(await tx.one('SELECT id FROM users WHERE id=$1 AND deletion_requested_at IS NULL FOR KEY SHARE', [userId])))
    fail(403, 'account_unavailable', 'The account is unavailable.');
}

/** A team's lock: membership, roles, invites, projects and the team's file count change under it. Project rank, so it always follows the
 * account locks of the transaction. */
export const teamLock = (teamId: string): LockResource => ({kind: 'project', id: 'design-team:' + teamId});
export async function lockTeams(tx: TransactionContext, teamIds: readonly string[]) {
  await lockResources(tx, teamIds.map(teamLock));
}
