import type {SqlExecutor, TransactionContext} from '../postgresql/client';
import {lockResources} from '../postgresql/locks';
import type {CustomerAuthority} from '../customer-authority';
import {
  type DesignFileGuest,
  type DesignFileGuestRole,
  type DesignFileLinkAccess,
  type DesignFilePerson,
  type DesignFileSharing,
  type DesignSharedFile,
} from '../../shared/design/teams';
import {designFail, notFound} from './errors';
import {designRead, designWrite, fileAccess, fileRoleJoins, forbidden, versionOf, type DesignFileAccessRow} from './file-access';
import {revalidateLive} from './live/hub';

// Sharing one file, Figma's way (docs/design-tool.md §Teams, "File access"). Whoever may edit a file may share it: change or remove
// the people it was shared with, and set the file's link ("Only invited people", or anyone with the link may view or edit). Opening a
// file by its link keeps it in the visitor's "Shared with me". The access itself is decided only by file-access.ts `fileRoleJoins`.

type SharingContext = {tx: SqlExecutor; row: DesignFileAccessRow; actorId: string};
const ID = /^[0-9a-f-]{36}$/;
const nameOf = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);
/** The lock under which a file's guests and link change (after the caller's account lock). */
const sharingLock = (fileId: string) => ({kind: 'project' as const, id: 'design-file-sharing:' + fileId});
const guestNotFound = (): never => designFail(404, 'not_found', 'This person does not have access to the file.');
const isGuestRole = (value: unknown): value is DesignFileGuestRole => value === 'editor' || value === 'viewer';

/** Who has the file and how, as the caller may see it. */
async function sharingOf({tx, row, actorId}: SharingContext): Promise<DesignFileSharing> {
  const canShare = row.role === 'owner' || row.role === 'admin' || row.role === 'editor';
  const person = (user: {id: string; name: string | null}): DesignFilePerson => ({
    userId: user.id,
    name: nameOf(user.name) ?? 'Member',
    you: user.id === actorId,
  });
  const owner = row.team_id
    ? null
    : person(
        (await tx.one<{id: string; name: string | null}>(
          'SELECT id,name FROM users WHERE id=$1',
          [row.user_id],
        ))!,
      );
  const team = row.team_id
    ? await tx.one<{id: string; name: string; members: number}>(
        'SELECT t.id,t.name,(SELECT count(*)::int FROM design_team_members m WHERE m.team_id=t.id) AS members FROM design_teams t WHERE t.id=$1 AND t.deleted_at IS NULL',
        [row.team_id],
      )
    : null;
  const guests = await tx.many<{id: string; name: string | null; role: DesignFileGuestRole}>(
    // The people the file was shared with (those who came by the link are the link's row); a team's members are the team's row.
    `SELECT u.id,u.name,x.role FROM design_file_members x JOIN users u ON u.id=x.user_id AND u.deletion_requested_at IS NULL
     WHERE x.file_id=$1 AND x.role IS NOT NULL AND ($3::text IS NOT NULL OR u.id<>$2)
       AND NOT EXISTS(SELECT 1 FROM design_team_members m JOIN design_teams t ON t.id=m.team_id AND t.deleted_at IS NULL WHERE m.team_id=$3 AND m.user_id=u.id)
     ORDER BY x.created_at,u.id LIMIT 500`,
    [row.id, row.user_id, row.team_id],
  );
  return {
    fileId: row.id,
    link: row.link_access,
    canShare: canShare && row.trashed_at === null,
    you: {role: row.role, guest: row.guest},
    owner,
    team: team ?? null,
    guests: guests.map((guest): DesignFileGuest => ({...person(guest), role: guest.role!})),
  };
}

/** "Share": who has the file and how. Anyone who can open the file sees it. */
export async function readFileSharing(actor: CustomerAuthority, fileId: string): Promise<DesignFileSharing> {
  return designRead(actor, async tx =>
    sharingOf({tx, row: await fileAccess(tx, actor.ownerId, fileId, 'view'), actorId: actor.ownerId}),
  );
}

/** A write to a file's sharing: the caller's account lock, the file's sharing lock, the caller allowed to share it. */
async function sharingWrite<T>(
  actor: CustomerAuthority,
  fileId: string,
  work: (context: SharingContext & {tx: TransactionContext}) => Promise<T>,
  need: 'share' | 'view' = 'share',
): Promise<T> {
  if (typeof fileId !== 'string' || !ID.test(fileId)) return notFound();
  return designWrite(actor, async tx => {
    await lockResources(tx, [sharingLock(fileId)]);
    const row = await fileAccess(tx, actor.ownerId, fileId, need);
    return work({tx, row, actorId: actor.ownerId});
  });
}
/** The row again after a change (its link column may have moved). */
const reread = async (context: SharingContext) => ({
  ...context,
  row: await fileAccess(context.tx, context.actorId, context.row.id, 'view'),
});

/** The file's link: "Only invited people", or anyone signed in with the link may view or edit. Closing it takes the file away from those
 *  who had it only by the link. */
export async function setFileLink(
  actor: CustomerAuthority,
  fileId: string,
  link: DesignFileLinkAccess,
): Promise<DesignFileSharing> {
  if (!['none', 'view', 'edit'].includes(link)) designFail(400, 'invalid_request', 'Choose who the link is available to.');
  const answer = await sharingWrite(actor, fileId, async context => {
    await context.tx.execute('UPDATE design_files SET link_access=$2 WHERE id=$1', [context.row.id, link]);
    // Those who had the file only by its link: their rows go, and they are named to the pushes below (collab's ACL push asks
    // the file's guests' rows for whom to tell, and theirs are gone by then).
    const visitors =
      link === 'none'
        ? (
            await context.tx.many<{user_id: string}>(
              'DELETE FROM design_file_members WHERE file_id=$1 AND role IS NULL RETURNING user_id',
              [context.row.id],
            )
          ).map(visitor => visitor.user_id)
        : [];
    return {sharing: await sharingOf(await reread(context)), visitors};
  });
  revalidateLive({fileId, ...(answer.visitors.length ? {users: answer.visitors} : {})});
  return answer.sharing;
}

/** A guest's role ("Can edit" / "Can view"); someone who came by the link gets the role as an invite would. */
export async function setFileGuestRole(
  actor: CustomerAuthority,
  fileId: string,
  userId: string,
  role: DesignFileGuestRole,
): Promise<DesignFileSharing> {
  if (!isGuestRole(role)) designFail(400, 'invalid_request', 'Choose what people can do with the file.');
  const answer = await sharingWrite(actor, fileId, async context => {
    const changed = await context.tx.execute('UPDATE design_file_members SET role=$3 WHERE file_id=$1 AND user_id=$2', [
      context.row.id,
      userId,
      role,
    ]);
    if (!changed.changes) guestNotFound();
    return sharingOf(context);
  });
  revalidateLive({fileId, users: [userId]});
  return answer;
}

/** "Remove access" (a sharer), or "Leave file" (the guest themselves): the row goes; a file whose link is open stays reachable by it. */
export async function removeFileGuest(
  actor: CustomerAuthority,
  fileId: string,
  who: string,
): Promise<DesignFileSharing | null> {
  // `me`: the caller themselves ("Remove from shared with me" in the file browser, which does not hold the account's id).
  const userId = who === 'me' ? actor.ownerId : who;
  const self = userId === actor.ownerId;
  const answer = await sharingWrite(
    actor,
    fileId,
    async context => {
      if (!self && !(context.row.role === 'owner' || context.row.role === 'admin' || context.row.role === 'editor'))
        forbidden('Only someone who can edit the file can remove other people\'s access.');
      const removed = await context.tx.execute('DELETE FROM design_file_members WHERE file_id=$1 AND user_id=$2', [
        context.row.id,
        userId,
      ]);
      if (!removed.changes) guestNotFound();
      return self ? null : sharingOf(context);
    },
    self ? 'view' : 'share',
  );
  revalidateLive({fileId, users: [userId]});
  return answer;
}

type SharedRow = {
  id: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
  thumbnail_filename: string | null;
  trashed_at: string | null;
  team_id: string | null;
  project_id: string | null;
  kind: string;
  role: DesignFileGuestRole;
  from_name: string | null;
};

/** "Shared with me": the files shared with the caller or opened by their link that they still have, newest first. */
export async function listSharedFiles(
  actor: CustomerAuthority,
  imageUrl: (filename: string) => string,
): Promise<DesignSharedFile[]> {
  return designRead(actor, async tx => {
    const rows = await tx.many<SharedRow>(
      `SELECT f.id,f.name,${versionOf('f')} AS version,f.created_at,f.updated_at,f.thumbnail_filename,f.trashed_at,f.team_id,f.project_id,f.kind,
              fa_role.role,COALESCE(t.name,o.name) AS from_name
         FROM design_file_members x JOIN design_files f ON f.id=x.file_id
         ${fileRoleJoins('f', '$1')}
         LEFT JOIN design_teams t ON t.id=f.team_id LEFT JOIN users o ON o.id=f.user_id
        WHERE x.user_id=$1 AND fa_role.guest AND fa_role.role IS NOT NULL
        ORDER BY f.updated_at DESC,f.id LIMIT 500`,
      [actor.ownerId],
    );
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      thumbnailUrl: row.thumbnail_filename ? imageUrl(row.thumbnail_filename) : null,
      trashedAt: row.trashed_at,
      // A guest sees the file outside its place: no team and project of theirs.
      teamId: null,
      projectId: null,
      kind: row.kind === 'board' ? 'board' : 'design',
      role: row.role,
      from: nameOf(row.from_name) ?? 'Member',
    }));
  });
}

/** Before a file opens for someone who is not in it yet: a file reached by its open link is kept in their "Shared with me". Cheap when
 * there is nothing to do (one read). */
export async function arriveAtFile(actor: CustomerAuthority, fileId: string): Promise<void> {
  if (typeof fileId !== 'string' || !ID.test(fileId)) return;
  const state = await designRead(actor, tx =>
    tx.one<{
      role: string | null;
      guest: boolean;
      guest_row: boolean;
      link_access: DesignFileLinkAccess;
    }>(
      `SELECT fa_role.role,fa_role.guest,fa_parts.guest_row,f.link_access
       FROM design_files f ${fileRoleJoins('f', '$2')} WHERE f.id=$1`,
      [fileId, actor.ownerId],
    ),
  );
  if (!state) return;
  if (state.role && state.guest && !state.guest_row && state.link_access !== 'none')
    await designWrite(actor, async tx => {
      await lockResources(tx, [sharingLock(fileId)]);
      await tx.execute(
        "INSERT INTO design_file_members(file_id,user_id,role) SELECT $1,$2,NULL FROM design_files WHERE id=$1 AND link_access<>'none' ON CONFLICT DO NOTHING",
        [fileId, actor.ownerId],
      );
    });
}
