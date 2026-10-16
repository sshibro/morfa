import {db} from '../../db';
import {prepared, type SqlExecutor} from '../../postgresql/client';
import type {DesignTeamRole} from '../../../shared/design/teams';
import {collabConfigured} from './config';
import {pushAcl, pushFile} from './client';
import {heldFiles, type HeldFile} from './leases';
import {fileRoleJoins} from '../file-access';

// Permission changes reach collab at once (docs/BACKEND.md §2 "Permissions", TARGETS A4 ≤ 2 s): after a team, role, membership,
// move, trash or erase change commits, every file a collab node holds among those it touches gets POST /internal/acl for each
// person who may have it open — the file's holder account and the members of its team (and of the team it left, for a move),
// plus whoever the change named — with that person's role now, or null when they lost the file (collab closes their sockets
// with `bye {access}`; a changed role gets `access {role}`). Each push is also announced on PostgreSQL's `design_acl` channel,
// the fallback a collab node may LISTEN on. A push that fails is not retried: every socket is re-validated through
// GET /internal/design-files/:id/access every 20 s anyway (internal-router.ts).

/** The role of each of `users` in `fileId` as fileAccess decides it (null: no access, or the account is closing). A trashed file is
 *  read-only for everyone. */
// Prepared (lane A7): collab re-validates every open socket through it every 20 s (TARGETS A3), and every ACL push reads it. The role
// is the one rule of file-access.ts `fileRoleJoins` (the owner, the live team's members, the file's guests).
const ROLES_IN = prepared(`SELECT u.id AS user_id,f.trashed_at IS NOT NULL AS trashed,
       CASE WHEN NOT EXISTS (SELECT 1 FROM users a WHERE a.id=u.id AND a.deletion_requested_at IS NULL) THEN NULL ELSE fa_role.role END AS role
     FROM unnest($2::text[]) AS u(id) CROSS JOIN design_files f ${fileRoleJoins('f', 'u.id')} WHERE f.id=$1`);
export async function rolesIn(fileId: string, users: readonly string[], executor: SqlExecutor = db): Promise<Map<string, DesignTeamRole | null>> {
  const rows = await executor.many<{user_id: string; role: DesignTeamRole | null; trashed: boolean}>(ROLES_IN, [fileId, [...users]]);
  const roles = new Map<string, DesignTeamRole | null>(users.map(user => [user, null]));
  for (const row of rows) roles.set(row.user_id, row.role && row.trashed ? 'viewer' : row.role);
  return roles;
}

/** The people who may have `file` open: its holder account, its team's members and those of `extraTeams`, its guests, and `users`. */
async function candidates(file: HeldFile, users: readonly string[], extraTeams: readonly string[]): Promise<string[]> {
  const teams = [...new Set([file.team_id, ...extraTeams].filter((team): team is string => !!team))];
  const members = teams.length
    ? await db.many<{user_id: string}>('SELECT DISTINCT user_id FROM design_team_members WHERE team_id=ANY($1::text[])', [teams])
    : [];
  const guests = await db.many<{user_id: string}>('SELECT user_id FROM design_file_members WHERE file_id=$1', [file.id]);
  return [...new Set([file.user_id, ...members.map(row => row.user_id), ...guests.map(row => row.user_id), ...users])];
}

export type AclTarget = {fileId?: string; teamId?: string; userId?: string; users?: readonly string[]; extraTeams?: readonly string[]};

/** Pushes the current roles of the files `target` names that a collab node holds; resolves with the number of pushes. */
export async function pushAccess(target: AclTarget): Promise<number> {
  if (!collabConfigured()) return 0;
  const held = await heldFiles({fileId: target.fileId, teamId: target.teamId, userId: target.fileId || target.teamId ? undefined : target.userId});
  let pushed = 0;
  await Promise.all(
    held.map(async file => {
      // In the trash now (its team or project was deleted with it): the sockets end as for a trashed file.
      if (file.trashed && target.teamId) {
        await pushFile(file.node, file.id, {close: 'trashed'}).then(() => pushed++, error => console.error('collab acl push:', (error as Error).message));
        return;
      }
      const people = await candidates(file, [...(target.users ?? []), ...(target.userId ? [target.userId] : [])], target.extraTeams ?? []);
      const roles = await rolesIn(file.id, people);
      const notices: string[] = [];
      for (const [user, role] of roles) {
        notices.push(JSON.stringify({file: file.id, user, role, node: file.node}));
        try {
          await pushAcl(file.node, file.id, user, role);
          pushed++;
        } catch (error) {
          console.error('collab acl push:', (error as Error).message);
        }
      }
      // The fallback channel (a NOTIFY payload stays under 8 000 bytes: one per person).
      if (notices.length) await db.query("SELECT pg_notify('design_acl',payload) FROM unnest($1::text[]) AS payload", [notices]).catch(() => undefined);
    }),
  );
  return pushed;
}

const inFlight = new Set<Promise<unknown>>();

/** Fire and forget (after a commit): the caller's answer does not wait for collab. */
export function collabAclChanged(target: AclTarget): void {
  if (!collabConfigured()) return;
  const run = pushAccess(target).catch(error => console.error('collab acl push:', (error as Error).message));
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/**
 * A session ended (sign-out): every socket of the account on a file a collab node holds is closed (`role: null` → `bye {access}`).
 * A ticket carries no session, so collab cannot tell which socket the ended session opened: the account's other tabs and devices
 * reconnect through /session at once (their sessions still hold), the signed-out one cannot. Legacy's streams end within the 20 s
 * re-validation; this is at once.
 */
export function collabSignedOut(userId: string): void {
  if (!collabConfigured()) return;
  const run = (async () => {
    for (const file of await heldFiles({userId})) await pushAcl(file.node, file.id, userId, null).catch(error => console.error('collab acl push:', (error as Error).message));
  })().catch(error => console.error('collab acl push:', (error as Error).message));
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** For tests and shutdown: resolves when every push started so far is done. */
export async function aclPushesIdle(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}
