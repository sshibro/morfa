import {
  assignableRoles,
  DESIGN_INVITE_PARAM,
  DESIGN_INVITE_STORAGE_KEY,
  DESIGN_INVITE_TOKEN,
  DESIGN_TEAM_ROLE_LABELS,
  DESIGN_TEAM_ROLE_NOTES,
  type DesignInviteRole,
  type DesignTeamInvite,
  type DesignTeamRole,
} from '../../../shared/design/teams';

// Pure helpers of the teams UI (docs/design-tool.md §Teams): the invite carried in the address or kept over the sign-in, the words the
// dialogs show, the choices a role has. tests/design-teams-ui.test.ts drives them.

type StorageLike = Pick<Storage, 'getItem' | 'removeItem'>;

/**
 * The invite this page load brings, read once: `?designInvite=<token>` in the address (removed from it), or the one the sign-in screen
 * kept in the tab while the visitor signed in (removed too). Anything that is not a token is dropped. `search` is the address's query
 * without the invite, for history.replaceState.
 */
export function takeDesignInvite(search: string, storage: StorageLike | null): {token: string | null; search: string | null} {
  const query = new URLSearchParams(search);
  let token: string | null = null,
    cleaned: string | null = null;
  if (query.has(DESIGN_INVITE_PARAM)) {
    const value = query.get(DESIGN_INVITE_PARAM) ?? '';
    if (DESIGN_INVITE_TOKEN.test(value)) token = value;
    query.delete(DESIGN_INVITE_PARAM);
    const rest = query.toString();
    cleaned = rest ? '?' + rest : '';
  }
  try {
    const kept = storage?.getItem(DESIGN_INVITE_STORAGE_KEY) ?? null;
    if (kept !== null) storage?.removeItem(DESIGN_INVITE_STORAGE_KEY);
    if (!token && kept && DESIGN_INVITE_TOKEN.test(kept)) token = kept;
  } catch {
    // Storage blocked: only the address carries the invite.
  }
  return {token, search: cleaned};
}

const DAY = 86_400_000;
const dateLabel = (iso: string) => new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'long', timeZone: 'Europe/Moscow'}).format(new Date(iso));

/** One line about a link: "Expires October 14 · 0 of 1", "Used", "Revoked", "Expired". */
export function inviteLine(invite: Pick<DesignTeamInvite, 'state' | 'expiresAt' | 'uses' | 'maxUses'>, now = Date.now()): string {
  if (invite.state === 'revoked') return 'Revoked';
  if (invite.state === 'expired') return 'Expired';
  if (invite.state === 'used') return invite.maxUses === 1 ? 'Used' : `Used ${invite.uses} of ${invite.maxUses}`;
  const left = Date.parse(invite.expiresAt) - now;
  const until = left < DAY ? 'Expires in under a day' : `Expires ${dateLabel(invite.expiresAt)}`;
  return `${until} · ${invite.uses} of ${invite.maxUses}`;
}

/** The settings of the next link in words: "For 7 days, for one person". */
export function linkSettingsLine(days: string, uses: string): string {
  const period = INVITE_DAYS.find(option => option.value === days)?.label ?? `${days} days`;
  const people = uses === '1' ? 'for one person' : `for up to ${uses} people`;
  return `For ${period}, ${people}`;
}

export const INVITE_DAYS = [
  {value: '1', label: '1 day'},
  {value: '7', label: '7 days'},
  {value: '30', label: '30 days'},
] as const;
export const INVITE_USES = [
  {value: '1', label: 'One person'},
  {value: '5', label: 'Up to 5 people'},
  {value: '25', label: 'Up to 25 people'},
  {value: '100', label: 'Up to 100 people'},
] as const;

/** The roles an actor's picker offers for an invite, with their notes. */
export function inviteRoleOptions(actor: DesignTeamRole): {value: DesignInviteRole; label: string; description: string}[] {
  return assignableRoles(actor).map(role => ({value: role, label: DESIGN_TEAM_ROLE_LABELS[role], description: DESIGN_TEAM_ROLE_NOTES[role]}));
}
/** The roles a member's select offers to an actor: the member's own and those the actor hands out (the owner also hands the team over). */
export function memberRoleOptions(actor: DesignTeamRole, current: DesignTeamRole): {value: DesignTeamRole; label: string}[] {
  const roles = new Set<DesignTeamRole>([current, ...assignableRoles(actor)]);
  if (actor === 'owner') roles.add('owner');
  return (['owner', 'admin', 'editor', 'developer', 'viewer'] as const)
    .filter(role => roles.has(role))
    .map(role => ({value: role, label: role === 'owner' && current !== 'owner' ? 'Transfer team' : DESIGN_TEAM_ROLE_LABELS[role]}));
}

/** A team or project name in quotes: "…", with double quotes inside the name turned into single ones (Studio "North" → "Studio 'North'"). */
export const quoted = (name: string) => '"' + name.replace(/"/g, "'") + '"';

