// "Morfa" teams, step 1 (docs/design-tool.md §Teams): the roles, what each may do, the limits and the wire types of
// `/api/design-teams`. No zod and no server imports: the design area and the server read the same rules. The server decides every
// request (server/design/file-access.ts and server/design/teams.ts); the client only hides what the server would refuse.
//
// Routes (signed in; 404 while ENABLE_DESIGN_TOOL is off or the account is outside DESIGN_TOOL_ACCOUNTS; non-members get 404):
//   GET    /api/design-teams                                   → DesignTeamList
//   POST   /api/design-teams                       {name}       → 201 {team: DesignTeamSummary}
//   PATCH  /api/design-teams/:teamId               {name}       → {team}                       owner, admin
//   DELETE /api/design-teams/:teamId                            → {ok}                         owner; files go to the team's trash
//   GET    /api/design-teams/:teamId/members                    → DesignTeamMembers
//   PATCH  /api/design-teams/:teamId/members/:userId {role}     → DesignTeamMembers            owner, admin ("owner" hands the team over)
//   DELETE /api/design-teams/:teamId/members/:userId            → DesignTeamMembers            owner, admin
//   POST   /api/design-teams/:teamId/leave                      → {ok}                         anyone but the owner
//   GET    /api/design-teams/:teamId/invites                    → {invites: DesignTeamInvite[]} owner, admin
//   POST   /api/design-teams/:teamId/invites       {role, days, maxUses} → 201 DesignInviteCreated  owner, admin
//   DELETE /api/design-teams/:teamId/invites/:inviteId          → {invites}                    owner, admin
//   POST   /api/design-teams/:teamId/projects      {name}       → 201 {project}                owner, admin
//   PATCH  /api/design-teams/:teamId/projects/:projectId {name} → {project}                    owner, admin
//   DELETE /api/design-teams/:teamId/projects/:projectId        → {ok}                         owner, admin; its files go to the trash
//   GET    /api/design-teams/invites/:token                     → DesignInvitePreview          any signed-in account
//   POST   /api/design-teams/invites/:token/accept              → DesignInviteAccepted         idempotent for a member
// Team files live in /api/design-files: `GET /?team=<id>&project=<id>`, `POST /` with {teamId, projectId}, `POST /:id/move`.
import type {DesignFileSummary} from './api';

export type DesignTeamRole = 'owner' | 'admin' | 'editor' | 'developer' | 'viewer';
/** Roles an invite link can give: ownership is only handed over by the owner. */
export type DesignInviteRole = Exclude<DesignTeamRole, 'owner'>;

export const DESIGN_TEAM_ROLES: readonly DesignTeamRole[] = ['owner', 'admin', 'editor', 'developer', 'viewer'];
export const DESIGN_INVITE_ROLES: readonly DesignInviteRole[] = ['admin', 'editor', 'developer', 'viewer'];
export const isDesignTeamRole = (value: unknown): value is DesignTeamRole => DESIGN_TEAM_ROLES.includes(value as DesignTeamRole);

export const DESIGN_TEAM_ROLE_LABELS: Readonly<Record<DesignTeamRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  developer: 'Developer',
  viewer: 'Viewer',
};
/** One line under each role in a picker. */
export const DESIGN_TEAM_ROLE_NOTES: Readonly<Record<DesignTeamRole, string>> = {
  owner: 'Everything, including deleting the team',
  admin: 'Members, invitations and projects',
  editor: 'Creates and edits files',
  developer: 'Views, Code, export and versions',
  viewer: 'Views and exports',
};

/** Changes a team file's document, name and pictures; creates and duplicates files. */
export const canEditTeamFiles = (role: DesignTeamRole): boolean => role === 'owner' || role === 'admin' || role === 'editor';
/** Members, invites and projects; moves files between the team and personal files; trash and restore. */
export const canManageTeam = (role: DesignTeamRole): boolean => role === 'owner' || role === 'admin';
/** The "Code" tab (inspection). A viewer only looks and exports. */
export const canInspectCode = (role: DesignTeamRole): boolean => role !== 'viewer';

/** Roles `actor` may hand out to someone else (an invite, or a change of role). The owner's role moves only by a handover. */
export function assignableRoles(actor: DesignTeamRole): DesignInviteRole[] {
  if (actor === 'owner') return ['admin', 'editor', 'developer', 'viewer'];
  if (actor === 'admin') return ['editor', 'developer', 'viewer'];
  return [];
}
/** Whether `actor` may change the role of, or remove, a member whose role is `target` (never themselves: they leave instead). */
export function canManageMember(actor: DesignTeamRole, target: DesignTeamRole): boolean {
  if (actor === 'owner') return target !== 'owner';
  if (actor === 'admin') return target === 'editor' || target === 'developer' || target === 'viewer';
  return false;
}

export const DESIGN_TEAM_LIMITS = {
  /** Teams one account owns (deleted ones not counted). */
  ownedTeams: 20,
  /** Teams one account belongs to. */
  memberships: 50,
  /** Members of one team. */
  members: 200,
  /** Projects of one team. */
  projects: 100,
  /** Invite links of one team that still work. */
  liveInvites: 50,
  /** The longest an invite link lives. */
  inviteDays: 30,
  /** The most people one link can bring in. */
  inviteUses: 100,
  nameLength: 100,
} as const;
/** The query that carries an invite into the design area: `<app>/?designInvite=<token>#designs`. */
export const DESIGN_INVITE_PARAM = 'designInvite';
/** An invite token: 32 random bytes, base64url. Only its SHA-256 is stored. */
export const DESIGN_INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const designInviteUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, '')}/?${DESIGN_INVITE_PARAM}=${token}#designs`;
/** Where a link opened while signed out waits for the sign-in (sessionStorage of the tab): the sign-in screen keeps it, the design
 * area takes it. */
export const DESIGN_INVITE_STORAGE_KEY = 'morfa-design-invite';

export type DesignProjectSummary = {id: string; name: string; createdAt: string};
export type DesignTeamSummary = {
  id: string;
  name: string;
  /** The caller's role. */
  role: DesignTeamRole;
  createdAt: string;
  members: number;
  projects: DesignProjectSummary[];
};
export type DesignTeamList = {teams: DesignTeamSummary[]};

export type DesignTeamMember = {
  userId: string;
  /** The display name; "Member" for an account without one. */
  name: string;
  role: DesignTeamRole;
  joinedAt: string;
  you: boolean;
};
export type DesignTeamMembers = {members: DesignTeamMember[]};

export type DesignInviteState = 'active' | 'used' | 'expired' | 'revoked';
export type DesignTeamInvite = {
  id: string;
  role: DesignInviteRole;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  state: DesignInviteState;
  /** Who made the link (display name), when the account still exists. */
  createdBy: string | null;
};
/** The token is in the answer once; the server keeps only its hash. */
export type DesignInviteCreated = {invite: DesignTeamInvite; token: string};
export type DesignInviteCreate = {role: DesignInviteRole; days: number; maxUses: number};
export type DesignInvitePreview = {
  team: {id: string; name: string};
  role: DesignInviteRole;
  expiresAt: string;
  /** Who made the invite (display name), when the account still exists. */
  invitedBy: string | null;
  /** The caller's role when already a member, else null. */
  member: DesignTeamRole | null;
};
export type DesignInviteAccepted = {team: {id: string; name: string}; role: DesignTeamRole; joined: boolean};

/** What the editor knows about the caller's rights to an open file (GET /api/design-files/:id `access`). */
export type DesignFileAccess = {
  /** Personal files: 'owner'; a guest: 'editor' or 'viewer'. */
  role: DesignTeamRole;
  canEdit: boolean;
  /** The file's team, for a member of it (null for a personal file and for a guest). */
  team: {id: string; name: string} | null;
  /** The file was shared with the caller (or opened by its link): no team, no moving or deleting. Absent: false. */
  guest?: boolean;
};

// ── Sharing one file (docs/design-tool.md §Teams, "File access"), Figma's way ─────────────────────────────────────────────────────
// Routes (signed in; GET /api/design-files/:id/sharing for anyone with access, the writes for whoever may edit the file):
//   GET    /api/design-files/:id/sharing                          → DesignFileSharing
//   PATCH  /api/design-files/:id/sharing          {link}          → DesignFileSharing
//   PATCH  /api/design-files/:id/sharing/guests/:userId {role}    → DesignFileSharing
//   DELETE /api/design-files/:id/sharing/guests/:userId           → DesignFileSharing   (a guest may remove themselves: "Leave")
//   GET    /api/design-files?shared=1                             → {files: DesignSharedFile[]}  "Shared with me"

/** Who besides the file's place may open it by its link: nobody, or anyone signed in who has it, to view or to edit. */
export type DesignFileLinkAccess = 'none' | 'view' | 'edit';
export const DESIGN_FILE_LINK_ACCESS: readonly DesignFileLinkAccess[] = ['none', 'view', 'edit'];
/** What a file's guest may do: Figma's "can edit" and "can view". */
export type DesignFileGuestRole = 'editor' | 'viewer';
export const DESIGN_FILE_GUEST_ROLES: readonly DesignFileGuestRole[] = ['editor', 'viewer'];
export const DESIGN_FILE_GUEST_LABELS: Readonly<Record<DesignFileGuestRole, string>> = {editor: 'Can edit', viewer: 'Can view'};
/** The same in a card's or a sidebar entry's short line. */
export const DESIGN_FILE_GUEST_SHORT: Readonly<Record<DesignFileGuestRole, string>> = {editor: 'editing', viewer: 'viewing'};
export const DESIGN_FILE_LINK_LABELS: Readonly<Record<DesignFileLinkAccess, string>> = {
  none: 'Invited people only',
  view: 'Anyone with the link can view',
  edit: 'Anyone with the link can edit',
};
export type DesignFilePerson = {
  userId: string;
  name: string;
  you: boolean;
};
export type DesignFileGuest = DesignFilePerson & {role: DesignFileGuestRole};
export type DesignFileSharing = {
  fileId: string;
  link: DesignFileLinkAccess;
  /** The caller may invite people, change guests and the link (whoever may edit the file). */
  canShare: boolean;
  you: {role: DesignTeamRole; guest: boolean};
  /** A personal file's owner; null for a team file. */
  owner: DesignFilePerson | null;
  /** A team file's team: its members see the file with their team role. */
  team: {id: string; name: string; members: number} | null;
  guests: DesignFileGuest[];
};
/** A file in "Shared with me": shared with the caller (or opened by its link). */
export type DesignSharedFile = DesignFileSummary & {
  role: DesignFileGuestRole;
  /** Whose file it is: the owner's name for a personal file, the team's for a team file. */
  from: string;
};
