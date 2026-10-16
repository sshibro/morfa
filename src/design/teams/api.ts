import {api, post} from '../../api';
import {readApi} from '../../api-read';
import type {
  DesignInviteAccepted,
  DesignInviteCreate,
  DesignInviteCreated,
  DesignInvitePreview,
  DesignProjectSummary,
  DesignTeamInvite,
  DesignTeamList,
  DesignTeamMembers,
  DesignTeamRole,
  DesignTeamSummary,
} from '../../../shared/design/teams';

// Client of `/api/design-teams` (docs/design-tool.md §Teams; the routes are listed in shared/design/teams.ts). Reads retry through
// readApi; writes go through api(), which carries the account header and its generation check. An invite token travels only in the
// path of its two routes.

const BASE = '/design-teams';
const team = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const json = (method: string, data: unknown): RequestInit => ({method, body: JSON.stringify(data)});

export const listDesignTeams = (signal?: AbortSignal) => readApi<DesignTeamList>(BASE, {signal});
export const createDesignTeam = (name: string) => post<{team: DesignTeamSummary}>(BASE, {name});
export const renameDesignTeam = (id: string, name: string) => api<{team: DesignTeamSummary}>(team(id), json('PATCH', {name}));
export const deleteDesignTeam = (id: string) => api<{ok: true}>(team(id), {method: 'DELETE'});
export const leaveDesignTeam = (id: string) => post<{ok: true}>(team(id) + '/leave');

export const listTeamMembers = (id: string, signal?: AbortSignal) => readApi<DesignTeamMembers>(team(id) + '/members', {signal});
export const changeMemberRole = (id: string, userId: string, role: DesignTeamRole) =>
  api<DesignTeamMembers>(`${team(id)}/members/${encodeURIComponent(userId)}`, json('PATCH', {role}));
export const removeTeamMember = (id: string, userId: string) =>
  api<DesignTeamMembers>(`${team(id)}/members/${encodeURIComponent(userId)}`, {method: 'DELETE'});

export const listTeamInvites = (id: string, signal?: AbortSignal) => readApi<{invites: DesignTeamInvite[]}>(team(id) + '/invites', {signal});
export const createTeamInvite = (id: string, input: DesignInviteCreate) => post<DesignInviteCreated>(team(id) + '/invites', input);
export const revokeTeamInvite = (id: string, inviteId: string) =>
  api<{invites: DesignTeamInvite[]}>(`${team(id)}/invites/${encodeURIComponent(inviteId)}`, {method: 'DELETE'});

export const createDesignProject = (id: string, name: string) => post<{project: DesignProjectSummary}>(team(id) + '/projects', {name});
export const renameDesignProject = (id: string, projectId: string, name: string) =>
  api<{project: DesignProjectSummary}>(`${team(id)}/projects/${encodeURIComponent(projectId)}`, json('PATCH', {name}));
export const deleteDesignProject = (id: string, projectId: string) =>
  api<{ok: true}>(`${team(id)}/projects/${encodeURIComponent(projectId)}`, {method: 'DELETE'});

/** The token is checked by the caller (DESIGN_INVITE_TOKEN) before it is sent. */
export const previewDesignInvite = (token: string, signal?: AbortSignal) =>
  readApi<DesignInvitePreview>(`${BASE}/invites/${token}`, {signal, retryDelays: []});
export const acceptDesignInvite = (token: string) => post<DesignInviteAccepted>(`${BASE}/invites/${token}/accept`);
