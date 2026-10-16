import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {SqlExecutor} from '../postgresql/client';
import type {CustomerAuthority} from '../customer-authority';
import {
  assignableRoles,
  canManageTeam,
  DESIGN_INVITE_TOKEN,
  DESIGN_TEAM_LIMITS,
  DESIGN_TEAM_ROLE_LABELS,
  type DesignInviteAccepted,
  type DesignInviteCreate,
  type DesignInviteCreated,
  type DesignInvitePreview,
  type DesignInviteRole,
  type DesignInviteState,
  type DesignTeamInvite,
  type DesignTeamRole,
} from '../../shared/design/teams';
import {designFail} from './errors';
import {designRead, designWrite, forbidden} from './file-access';
import {requireTeamRole, teamLimit, teamLocks, teamMembership} from './teams';

// Invites of "Morfa" teams (docs/design-tool.md §Teams): a link. The owner or an admin makes it with a role, an expiry (at most 30
// days) and a number of uses; whoever opens it signed in joins with that role.
// Only the SHA-256 of a token is stored, a token is shown once, and it never reaches a log: the request telemetry masks
// `/design-teams/invites/<token>` (server/admin/sanitize.ts).

type InviteRow = {
  id: string;
  team_id: string;
  role: DesignInviteRole;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked_at: string | null;
};
const COLUMNS = 'i.id,i.team_id,i.role,i.created_by,i.created_at,i.expires_at,i.max_uses,i.uses,i.revoked_at';
const iso = (value: string | Date) => new Date(value).toISOString();
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const INVITE_ID = /^[0-9a-f-]{36}$/;

export const inviteInvalid = (): never => designFail(404, 'design_invite_invalid', 'Invite not found. Check the link.');
const inviteOver = (): never =>
  designFail(410, 'design_invite_expired', 'This invite is no longer valid. Ask the team for a new link.');

function stateOf(row: InviteRow, now = Date.now()): DesignInviteState {
  if (row.revoked_at) return 'revoked';
  if (row.uses >= row.max_uses) return 'used';
  if (Date.parse(iso(row.expires_at)) <= now) return 'expired';
  return 'active';
}
const nameOf = (value: string | null) => (value && value.trim() ? value.trim() : null);
const view = (row: InviteRow & {creator: string | null}): DesignTeamInvite => ({
  id: row.id,
  role: row.role,
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
  maxUses: row.max_uses,
  uses: row.uses,
  state: stateOf(row),
  createdBy: nameOf(row.creator),
});

async function invitesOf(tx: SqlExecutor, teamId: string): Promise<DesignTeamInvite[]> {
  const rows = await tx.many<InviteRow & {creator: string | null}>(
    `SELECT ${COLUMNS},u.name AS creator FROM design_team_invites i LEFT JOIN users u ON u.id=i.created_by
     WHERE i.team_id=$1 AND i.email IS NULL ORDER BY i.created_at DESC,i.id LIMIT 100`,
    [teamId],
  );
  return rows.map(view);
}

export async function listTeamInvites(actor: CustomerAuthority, teamId: string): Promise<DesignTeamInvite[]> {
  return designRead(actor, async tx => {
    await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
    return invitesOf(tx, teamId);
  });
}

/** "Create link": a role the caller may hand out, 1–30 days, 1–100 uses; at most 50 links that still work per team. */
export async function createTeamInvite(
  actor: CustomerAuthority,
  teamId: string,
  input: DesignInviteCreate,
): Promise<DesignInviteCreated> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > DESIGN_TEAM_LIMITS.inviteDays)
    designFail(400, 'invalid_request', `The link lasts from 1 to ${DESIGN_TEAM_LIMITS.inviteDays} days.`);
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > DESIGN_TEAM_LIMITS.inviteUses)
    designFail(400, 'invalid_request', `A link can be used by 1 to ${DESIGN_TEAM_LIMITS.inviteUses} people.`);
  const token = randomBytes(32).toString('base64url');
  return designWrite(
    actor,
    async tx => {
      const me = await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      if (!assignableRoles(me.role).includes(input.role))
        forbidden(`Only the team owner can invite with the "${DESIGN_TEAM_ROLE_LABELS[input.role] ?? input.role}" role.`);
      const live = (await tx.one<{n: number}>(
        'SELECT count(*)::int AS n FROM design_team_invites WHERE team_id=$1 AND email IS NULL AND revoked_at IS NULL AND uses<max_uses AND expires_at>clock_timestamp()',
        [teamId],
      ))!.n;
      if (live >= DESIGN_TEAM_LIMITS.liveInvites)
        teamLimit(`The team already has ${DESIGN_TEAM_LIMITS.liveInvites} active links. Revoke the ones you don't need.`, DESIGN_TEAM_LIMITS.liveInvites);
      const id = randomUUID();
      // One clock read for both times: two clock_timestamp() calls differ by microseconds, and a 30-day link then broke the
      // table's CHECK (expires_at <= created_at + 30 days).
      await tx.execute(
        `WITH now AS (SELECT clock_timestamp() AS t)
         INSERT INTO design_team_invites(id,team_id,token,role,created_by,created_at,expires_at,max_uses)
         SELECT $1,$2,$3,$4,$5,now.t,now.t+make_interval(days=>$6::int),$7 FROM now`,
        [id, teamId, digest(token), input.role, actor.ownerId, input.days, input.maxUses],
      );
      const invite = (await invitesOf(tx, teamId)).find(item => item.id === id)!;
      return {invite, token};
    },
    {teams: teamLocks(teamId)},
  );
}
/** "Revoke": the link stops working at once; people who joined with it stay. */
export async function revokeTeamInvite(actor: CustomerAuthority, teamId: string, inviteId: string): Promise<DesignTeamInvite[]> {
  return designWrite(
    actor,
    async tx => {
      await requireTeamRole(tx, teamId, actor.ownerId, canManageTeam);
      if (!INVITE_ID.test(inviteId)) designFail(404, 'not_found', 'Link not found.');
      const changed = await tx.execute(
        'UPDATE design_team_invites SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND team_id=$2 AND email IS NULL',
        [inviteId, teamId],
      );
      if (!changed.changes) designFail(404, 'not_found', 'Link not found.');
      return invitesOf(tx, teamId);
    },
    {teams: teamLocks(teamId)},
  );
}

type FoundInvite = InviteRow & {team_name: string; creator: string | null};
async function inviteByToken(tx: SqlExecutor, token: string, lock = false): Promise<FoundInvite> {
  if (typeof token !== 'string' || !DESIGN_INVITE_TOKEN.test(token)) return inviteInvalid();
  return (
    (await tx.one<FoundInvite>(
      `SELECT ${COLUMNS},t.name AS team_name,u.name AS creator FROM design_team_invites i
       JOIN design_teams t ON t.id=i.team_id AND t.deleted_at IS NULL LEFT JOIN users u ON u.id=i.created_by
       WHERE i.token=$1 AND i.email IS NULL${lock ? ' FOR UPDATE OF i' : ''}`,
      [digest(token)],
    )) ?? inviteInvalid()
  );
}

/** What the invite page shows before "Join": the team's name and the role. A member sees their own role (the link may be used up
 * by their own visit). */
export async function previewTeamInvite(actor: CustomerAuthority, token: string): Promise<DesignInvitePreview> {
  return designRead(actor, async tx => {
    const invite = await inviteByToken(tx, token);
    const membership = await teamMembership(tx, invite.team_id, actor.ownerId);
    if (!membership && stateOf(invite) !== 'active') inviteOver();
    return {
      team: {id: invite.team_id, name: invite.team_name},
      role: invite.role,
      expiresAt: iso(invite.expires_at),
      invitedBy: nameOf(invite.creator),
      member: membership?.role ?? null,
    };
  });
}

/**
 * "Join": the signed-in account joins with the link's role and the link counts one use. Idempotent: a member is answered with
 * their own role and nothing is counted. Refused when the link is revoked, expired or used up (410), when the
 * team is full, or when the account is in too many teams.
 */
export async function acceptTeamInvite(actor: CustomerAuthority, token: string): Promise<DesignInviteAccepted> {
  const teamId = await designRead(actor, async tx => (await inviteByToken(tx, token)).team_id);
  return designWrite(
    actor,
    async tx => {
      const invite = await inviteByToken(tx, token, true);
      if (invite.team_id !== teamId) return inviteInvalid();
      return join(tx, actor, invite);
    },
    {teams: [teamId]},
  );
}

/** The joining itself, under the team's lock with the invite's row locked: the checks, the membership, one use counted. */
async function join(tx: SqlExecutor, actor: CustomerAuthority, invite: FoundInvite): Promise<DesignInviteAccepted> {
  const teamId = invite.team_id;
  const membership = await teamMembership(tx, teamId, actor.ownerId);
  const team = {id: teamId, name: invite.team_name};
  if (membership) return {team, role: membership.role, joined: false};
  if (stateOf(invite) !== 'active') inviteOver();
  const counts = (await tx.one<{memberships: number; members: number}>(
    `SELECT (SELECT count(*)::int FROM design_team_members m JOIN design_teams t ON t.id=m.team_id AND t.deleted_at IS NULL WHERE m.user_id=$1) AS memberships,
       (SELECT count(*)::int FROM design_team_members WHERE team_id=$2) AS members`,
    [actor.ownerId, teamId],
  ))!;
  if (counts.memberships >= DESIGN_TEAM_LIMITS.memberships)
    teamLimit(`You can be a member of at most ${DESIGN_TEAM_LIMITS.memberships} teams.`, DESIGN_TEAM_LIMITS.memberships);
  if (counts.members >= DESIGN_TEAM_LIMITS.members)
    teamLimit(`The team already has ${DESIGN_TEAM_LIMITS.members} members.`, DESIGN_TEAM_LIMITS.members);
  await tx.execute('INSERT INTO design_team_members(team_id,user_id,role,invited_by) VALUES($1,$2,$3,$4)', [
    teamId,
    actor.ownerId,
    invite.role,
    invite.created_by,
  ]);
  await tx.execute('UPDATE design_team_invites SET uses=uses+1 WHERE id=$1', [invite.id]);
  return {team, role: invite.role as DesignTeamRole, joined: true};
}
