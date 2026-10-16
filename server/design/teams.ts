import {randomUUID} from 'node:crypto';
import type {SqlExecutor, TransactionContext} from '../postgresql/client';
import type {CustomerAuthority} from '../customer-authority';
import {
  assignableRoles,
  canManageMember,
  canManageTeam,
  DESIGN_TEAM_LIMITS,
  DESIGN_TEAM_ROLE_LABELS,
  type DesignProjectSummary,
  type DesignTeamList,
  type DesignTeamMember,
  type DesignTeamMembers,
  type DesignTeamRole,
  type DesignTeamSummary,
} from '../../shared/design/teams';
import {forgetDocument} from './document-cache';
import {designFail} from './errors';
import {designRead, designWrite, forbidden, MANAGERS_ONLY} from './file-access';
import {cleanName} from './names';
import {documentsFull, hasRoom} from './room';
import {reholdTeamLibraries, teamLibraryBytes} from './library-rows';

// "Morfa" teams, step 1 (docs/design-tool.md §Teams): workspaces with an owner, members and roles, and projects. Every write takes
// the caller's account lock, then the team's lock (server/design/file-access.ts `teamLock`), so membership and counts change one at a
// time per team.

export type TeamRow = {id: string; name: string; owner_id: string; created_at: string; deleted_at: string | null};
const TEAM_ID = /^[0-9a-f-]{36}$/;
const ID = /^[0-9a-f-]{36}$/;
export const teamNotFound = (): never => designFail(404, 'not_found', 'Team not found.');
const memberNotFound = (): never => designFail(404, 'not_found', 'Member not found.');
export const projectNotFound = (): never => designFail(404, 'not_found', 'Project not found.');
export const teamLimit = (message: string, limit: number): never => designFail(409, 'design_team_limit', message, {limit});
export const OWNER_ONLY = 'Only the team owner can do this.';

/** The caller's membership of a live team, or null (a team that does not exist, is deleted, or is not the caller's). */
export async function teamMembership(
  tx: SqlExecutor,
  teamId: string,
  userId: string,
): Promise<{team: TeamRow; role: DesignTeamRole} | null> {
  if (typeof teamId !== 'string' || !TEAM_ID.test(teamId)) return null;
  const row = await tx.one<TeamRow & {role: DesignTeamRole}>(
    `SELECT t.id,t.name,t.owner_id,t.created_at,t.deleted_at,m.role FROM design_teams t
     JOIN design_team_members m ON m.team_id=t.id AND m.user_id=$2 WHERE t.id=$1 AND t.deleted_at IS NULL`,
    [teamId, userId],
  );
  if (!row) return null;
  const {role, ...team} = row;
  return {team, role};
}

/** The team and the caller's role, when the caller is a member whose role passes `allowed`: 404 for anyone else, 403 for a member
 * whose role does not allow it. */
export async function requireTeamRole(
  tx: SqlExecutor,
  teamId: string,
  userId: string,
  allowed: (role: DesignTeamRole) => boolean = () => true,
  message = MANAGERS_ONLY,
): Promise<{team: TeamRow; role: DesignTeamRole}> {
  const membership = await teamMembership(tx, teamId, userId);
  if (!membership) return teamNotFound();
  if (!allowed(membership.role)) forbidden(message);
  return membership;
}

const iso = (value: string | Date) => new Date(value).toISOString();

async function summaries(tx: SqlExecutor, viewerId: string, teamId?: string): Promise<DesignTeamSummary[]> {
  const rows = await tx.many<TeamRow & {role: DesignTeamRole; members: number}>(
    `SELECT t.id,t.name,t.owner_id,t.created_at,t.deleted_at,m.role,
       (SELECT count(*)::int FROM design_team_members x WHERE x.team_id=t.id) AS members
     FROM design_teams t JOIN design_team_members m ON m.team_id=t.id AND m.user_id=$1
     WHERE t.deleted_at IS NULL AND ($2::text IS NULL OR t.id=$2) ORDER BY t.created_at,t.id`,
    [viewerId, teamId ?? null],
  );
  if (!rows.length) return [];
  const projects = await tx.many<{id: string; team_id: string; name: string; created_at: string}>(
    'SELECT id,team_id,name,created_at FROM design_projects WHERE team_id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY lower(name),id',
    [rows.map(row => row.id)],
  );
  const result: DesignTeamSummary[] = [];
  for (const row of rows) {
    result.push({
      id: row.id,
      name: row.name,
      role: row.role,
      createdAt: iso(row.created_at),
      members: row.members,
      projects: projects
        .filter(project => project.team_id === row.id)
        .map((project): DesignProjectSummary => ({id: project.id, name: project.name, createdAt: iso(project.created_at)})),
    });
  }
  return result;
}

/** The caller's teams with the caller's role, and their projects. */
export async function listDesignTeams(actor: CustomerAuthority): Promise<DesignTeamList> {
  return designRead(actor, async tx => ({teams: await summaries(tx, actor.ownerId)}));
}

async function summaryOf(tx: SqlExecutor, teamId: string, viewerId: string): Promise<DesignTeamSummary> {
  return (await summaries(tx, viewerId, teamId))[0] ?? teamNotFound();
}

const teamName = (value: string): string =>
  cleanName(value, DESIGN_TEAM_LIMITS.nameLength) ?? designFail(400, 'invalid_request', 'Enter a team name.');

/** "Create team": the creator is its owner. At most 20 teams owned and 50 memberships per account. */
export async function createDesignTeam(actor: CustomerAuthority, value: string): Promise<DesignTeamSummary> {
  const name = teamName(value),
    id = randomUUID(),
    owner = actor.ownerId;
  return designWrite(actor, async tx => {
    const counts = (await tx.one<{owned: number; memberships: number}>(
      `SELECT (SELECT count(*)::int FROM design_teams WHERE owner_id=$1 AND deleted_at IS NULL) AS owned,
         (SELECT count(*)::int FROM design_team_members m JOIN design_teams t ON t.id=m.team_id AND t.deleted_at IS NULL WHERE m.user_id=$1) AS memberships`,
      [owner],
    ))!;
    if (counts.owned >= DESIGN_TEAM_LIMITS.ownedTeams)
      teamLimit(`You can create up to ${DESIGN_TEAM_LIMITS.ownedTeams} teams.`, DESIGN_TEAM_LIMITS.ownedTeams);
    if (counts.memberships >= DESIGN_TEAM_LIMITS.memberships)
      teamLimit(`You can be a member of at most ${DESIGN_TEAM_LIMITS.memberships} teams.`, DESIGN_TEAM_LIMITS.memberships);
    await tx.execute('INSERT INTO design_teams(id,name,owner_id) VALUES($1,$2,$3)', [id, name, owner]);
    await tx.execute("INSERT INTO design_team_members(team_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
    return summaryOf(tx, id, owner);
  });
}

export async function renameDesignTeam(actor: CustomerAuthority, teamId: string, value: string): Promise<DesignTeamSummary> {
  const name = teamName(value);
  return designWrite(
    actor,
    async tx => {
      await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      await tx.execute('UPDATE design_teams SET name=$2 WHERE id=$1', [teamId, name]);
      return summaryOf(tx, teamId, actor.ownerId);
    },
    {teams: teamLocks(teamId)},
  );
}

/** The team lock of a request's team id, when it can be one (an id that cannot be is refused as not found inside). */
export const teamLocks = (teamId: string) => (TEAM_ID.test(teamId) ? [teamId] : []);

/**
 * "Delete team" (the owner): the team disappears for everyone, its files go to the trash (the sweep erases them after the
 * trash days, then the team's rows) and its links stop working.
 */
export async function deleteDesignTeam(actor: CustomerAuthority, teamId: string): Promise<void> {
  await designWrite(
    actor,
    async tx => {
      const {team} = await requireTeamRole(tx, teamId, actor.ownerId, role => role === 'owner', OWNER_ONLY);
      await tx.execute('UPDATE design_files SET trashed_at=clock_timestamp() WHERE team_id=$1 AND trashed_at IS NULL', [team.id]);
      await tx.execute('UPDATE design_team_invites SET revoked_at=clock_timestamp() WHERE team_id=$1 AND revoked_at IS NULL', [team.id]);
      await tx.execute('UPDATE design_teams SET deleted_at=clock_timestamp() WHERE id=$1', [team.id]);
    },
    {teams: teamLocks(teamId)},
  );
}

// ── Members ──────────────────────────────────────────────────────────────────────────────────────

/** The members of a team the caller belongs to: names and roles, as every member sees them. */
async function membersOf(tx: SqlExecutor, team: TeamRow, viewerId: string): Promise<DesignTeamMembers> {
  const rows = await tx.many<{user_id: string; role: DesignTeamRole; joined_at: string; name: string}>(
    `SELECT m.user_id,m.role,m.joined_at,u.name FROM design_team_members m JOIN users u ON u.id=m.user_id
     WHERE m.team_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 WHEN 'developer' THEN 3 ELSE 4 END,m.joined_at,m.user_id`,
    [team.id],
  );
  const members = rows.map((row): DesignTeamMember => {
    const name = (row.name ?? '').trim();
    return {
      userId: row.user_id,
      name: name || 'Member',
      role: row.role,
      joinedAt: iso(row.joined_at),
      you: row.user_id === viewerId,
    };
  });
  return {members};
}

export async function listTeamMembers(actor: CustomerAuthority, teamId: string): Promise<DesignTeamMembers> {
  return designRead(actor, async tx => {
    const {team, role} = await requireTeamRole(tx, teamId, actor.ownerId);
    return membersOf(tx, team, actor.ownerId);
  });
}

/** Moves every row the team holds to its new owner: the files, their versions, their libraries and the team's pictures follow the account that
 *  holds them. */
async function rehold(tx: TransactionContext, teamId: string, ownerId: string) {
  // The team's documents join the new owner's room (room.ts), which must hold them as it is: nothing of theirs gives way.
  const moving = (await tx.one<{bytes: number}>(
    `SELECT (SELECT COALESCE(sum(bytes),0) FROM design_files WHERE team_id=$1)
           +(SELECT COALESCE(sum(v.bytes),0) FROM design_file_versions v JOIN design_files f ON f.id=v.file_id WHERE f.team_id=$1) AS bytes`,
    [teamId],
  ))!.bytes;
  if (!(await hasRoom(tx, ownerId, Number(moving) + (await teamLibraryBytes(tx, teamId)))))
    documentsFull(size => `The new owner would not have enough space: their files together with the team's files and their versions would take more than ${size}.`);
  // A create's retry key belongs to the account that held the file: it does not follow it.
  const files = await tx.many<{id: string}>('UPDATE design_files SET user_id=$2,client_id=NULL WHERE team_id=$1 RETURNING id', [teamId, ownerId]);
  await tx.execute(
    'UPDATE design_file_versions SET user_id=$2 WHERE file_id IN (SELECT id FROM design_files WHERE team_id=$1)',
    [teamId, ownerId],
  );
  await tx.execute('UPDATE design_images SET user_id=$2 WHERE team_id=$1', [teamId, ownerId]);
  await reholdTeamLibraries(tx, teamId, ownerId);
  await tx.execute('UPDATE design_teams SET owner_id=$2 WHERE id=$1', [teamId, ownerId]);
  for (const file of files) forgetDocument(file.id);
}

/**
 * A member's new role. The owner and admins change the roles of members below them; an admin hands out at most "Editor". `owner` hands
 * the team over (the owner only): the new owner holds the team's files from now on; the former owner becomes an admin.
 */
export async function changeTeamMemberRole(
  actor: CustomerAuthority,
  teamId: string,
  userId: string,
  role: DesignTeamRole,
): Promise<DesignTeamMembers> {
  return designWrite(
    actor,
    async tx => {
      const me = await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      if (typeof userId !== 'string' || !userId || userId.length > 200) memberNotFound();
      const target = await tx.one<{role: DesignTeamRole}>('SELECT role FROM design_team_members WHERE team_id=$1 AND user_id=$2', [teamId, userId]);
      if (!target) return memberNotFound();
      if (userId === actor.ownerId) designFail(400, 'invalid_request', 'You cannot change your own role.');
      if (role === 'owner') {
        if (me.role !== 'owner') forbidden(OWNER_ONLY);
        const owned = (await tx.one<{n: number}>('SELECT count(*)::int AS n FROM design_teams WHERE owner_id=$1 AND deleted_at IS NULL', [userId]))!.n;
        if (owned >= DESIGN_TEAM_LIMITS.ownedTeams)
          teamLimit(`This member already owns ${DESIGN_TEAM_LIMITS.ownedTeams} teams.`, DESIGN_TEAM_LIMITS.ownedTeams);
        // Ownership goes first, then the roles: one owner per team at every moment.
        await tx.execute("UPDATE design_team_members SET role='admin' WHERE team_id=$1 AND user_id=$2", [teamId, actor.ownerId]);
        await tx.execute("UPDATE design_team_members SET role='owner' WHERE team_id=$1 AND user_id=$2", [teamId, userId]);
        await rehold(tx, teamId, userId);
        const team = (await tx.one<TeamRow>('SELECT id,name,owner_id,created_at,deleted_at FROM design_teams WHERE id=$1', [teamId]))!;
        return membersOf(tx, team, actor.ownerId);
      }
      if (!canManageMember(me.role, target.role)) forbidden(MANAGERS_ONLY);
      if (!assignableRoles(me.role).includes(role as never))
        forbidden(`Only the team owner can give the "${DESIGN_TEAM_ROLE_LABELS[role]}" role.`);
      await tx.execute('UPDATE design_team_members SET role=$3 WHERE team_id=$1 AND user_id=$2', [teamId, userId, role]);
      return membersOf(tx, me.team, actor.ownerId);
    },
    {teams: teamLocks(teamId)},
  );
}

/** "Remove from team": the member loses the team's files; their own personal files are untouched. */
export async function removeTeamMember(actor: CustomerAuthority, teamId: string, userId: string): Promise<DesignTeamMembers> {
  return designWrite(
    actor,
    async tx => {
      const me = await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      if (userId === actor.ownerId) designFail(400, 'invalid_request', 'To leave the team, choose "Leave team".');
      if (typeof userId !== 'string' || !userId || userId.length > 200) memberNotFound();
      const target = await tx.one<{role: DesignTeamRole}>('SELECT role FROM design_team_members WHERE team_id=$1 AND user_id=$2', [teamId, userId]);
      if (!target) return memberNotFound();
      if (!canManageMember(me.role, target.role)) forbidden(MANAGERS_ONLY);
      await tx.execute('DELETE FROM design_team_members WHERE team_id=$1 AND user_id=$2', [teamId, userId]);
      return membersOf(tx, me.team, actor.ownerId);
    },
    {teams: teamLocks(teamId)},
  );
}

/** "Leave team": anyone but the owner, who hands the team over or deletes it instead. */
export async function leaveDesignTeam(actor: CustomerAuthority, teamId: string): Promise<void> {
  await designWrite(
    actor,
    async tx => {
      const me = await requireTeamRole(tx, teamId, actor.ownerId);
      if (me.role === 'owner')
        designFail(409, 'invalid_request', 'The owner cannot leave the team. Transfer it to another member or delete it.');
      await tx.execute('DELETE FROM design_team_members WHERE team_id=$1 AND user_id=$2', [teamId, actor.ownerId]);
    },
    {teams: teamLocks(teamId)},
  );
}

// ── Projects ─────────────────────────────────────────────────────────────────────────────────────

const projectName = (value: string): string =>
  cleanName(value, DESIGN_TEAM_LIMITS.nameLength) ?? designFail(400, 'invalid_request', 'Enter a project name.');
const projectView = (row: {id: string; name: string; created_at: string}): DesignProjectSummary => ({
  id: row.id,
  name: row.name,
  createdAt: iso(row.created_at),
});

/** A live project of the team, or 404. */
export async function teamProject(tx: SqlExecutor, teamId: string, projectId: string) {
  if (typeof projectId !== 'string' || !ID.test(projectId)) return projectNotFound();
  return (
    (await tx.one<{id: string; name: string; created_at: string}>(
      'SELECT id,name,created_at FROM design_projects WHERE id=$1 AND team_id=$2 AND deleted_at IS NULL',
      [projectId, teamId],
    )) ?? projectNotFound()
  );
}

export async function createDesignProject(actor: CustomerAuthority, teamId: string, value: string): Promise<DesignProjectSummary> {
  const name = projectName(value);
  return designWrite(
    actor,
    async tx => {
      await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      const count = (await tx.one<{n: number}>('SELECT count(*)::int AS n FROM design_projects WHERE team_id=$1 AND deleted_at IS NULL', [teamId]))!.n;
      if (count >= DESIGN_TEAM_LIMITS.projects)
        teamLimit(`A team can have up to ${DESIGN_TEAM_LIMITS.projects} projects.`, DESIGN_TEAM_LIMITS.projects);
      const row = await tx.one<{id: string; name: string; created_at: string}>(
        'INSERT INTO design_projects(id,team_id,name) VALUES($1,$2,$3) RETURNING id,name,created_at',
        [randomUUID(), teamId, name],
      );
      return projectView(row!);
    },
    {teams: teamLocks(teamId)},
  );
}

export async function renameDesignProject(
  actor: CustomerAuthority,
  teamId: string,
  projectId: string,
  value: string,
): Promise<DesignProjectSummary> {
  const name = projectName(value);
  return designWrite(
    actor,
    async tx => {
      await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      await teamProject(tx, teamId, projectId);
      const row = await tx.one<{id: string; name: string; created_at: string}>(
        'UPDATE design_projects SET name=$3 WHERE id=$1 AND team_id=$2 RETURNING id,name,created_at',
        [projectId, teamId, name],
      );
      return projectView(row!);
    },
    {teams: teamLocks(teamId)},
  );
}

/** "Delete project": its files go to the team's trash (restored, they come back without a project). */
export async function deleteDesignProject(actor: CustomerAuthority, teamId: string, projectId: string): Promise<void> {
  await designWrite(
    actor,
    async tx => {
      await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      await teamProject(tx, teamId, projectId);
      await tx.execute(
        'UPDATE design_files SET trashed_at=COALESCE(trashed_at,clock_timestamp()),project_id=NULL WHERE team_id=$1 AND project_id=$2',
        [teamId, projectId],
      );
      await tx.execute('UPDATE design_projects SET deleted_at=clock_timestamp() WHERE id=$1 AND team_id=$2', [projectId, teamId]);
    },
    {teams: teamLocks(teamId)},
  );
}
