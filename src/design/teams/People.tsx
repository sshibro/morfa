import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {
  canManageMember,
  canManageTeam,
  DESIGN_TEAM_ROLE_LABELS,
  designInviteUrl,
  type DesignInviteRole,
  type DesignTeamInvite,
  type DesignTeamMember,
  type DesignTeamMembers,
  type DesignTeamRole,
  type DesignTeamSummary,
} from '../../../shared/design/teams';
import {PRODUCT_NAME} from '../../../shared/design/product';
import {Button, IconButton} from '../ui/Button';
import {IconCheck, IconClose, IconLink} from '../ui/icons';
import {Select} from '../ui/Select';
import {Spinner} from '../ui/Spinner';
import {TextInput} from '../ui/TextInput';
import {changeMemberRole, createTeamInvite, listTeamInvites, listTeamMembers, removeTeamMember, revokeTeamInvite} from './api';
import {
  INVITE_DAYS,
  INVITE_USES,
  inviteLine,
  inviteRoleOptions,
  linkSettingsLine,
  memberRoleOptions,
  quoted,
} from './model';
import {ConfirmDialog} from './TeamDialogs';
import {errorText} from '../ui/error-text';

// A team's people, the way Figma's share dialog shows them (docs/design-tool.md §Teams): who is in the team with their roles, then the
// invite link. "Members" in the file browser and "Share" in the editor both show this. Managers change roles below their own,
// remove members, make and revoke invite links; everyone else sees the list.
// A refused change is said here, in the dialog: a toast would sit under the modal dialog's backdrop, dimmed and out of reach.

const initialOf = (name: string) => [...name.trim()][0]?.toLocaleUpperCase('en') ?? '·';

/** Copies `text`; when the browser refuses, selects `field` (if any) so ⌘C still works, and says so. */
async function copyText(text: string, field?: HTMLInputElement | null): Promise<string | null> {
  try {
    await navigator.clipboard.writeText(text);
    return null;
  } catch {
    field?.select();
    return 'Copy the link manually: the browser did not allow access to the clipboard.';
  }
}

type Pending = null | {kind: 'remove'; member: DesignTeamMember} | {kind: 'handover'; member: DesignTeamMember};

export function TeamPeople({team, onChanged}: {
  team: DesignTeamSummary;
  /** Roles or members changed: the caller reads the team again (the caller's own role after a handover). */
  onChanged: () => void;
}) {
  const manager = canManageTeam(team.role);
  const [members, setMembers] = useState<DesignTeamMembers | null>(null);
  const [invites, setInvites] = useState<DesignTeamInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [role, setRole] = useState<DesignTeamRole>(team.role);
  const [problem, setProblem] = useState<string | null>(null);
  const invitable = canManageTeam(role);

  useEffect(() => {
    const controller = new AbortController();
    listTeamMembers(team.id, controller.signal).then(setMembers, failure => !controller.signal.aborted && setError(errorText(failure)));
    if (manager) listTeamInvites(team.id, controller.signal).then(answer => setInvites(answer.invites), () => undefined);
    return () => controller.abort();
  }, [team.id, manager]);

  const apply = useCallback((next: DesignTeamMembers) => {
    setMembers(next);
    setRole(next.members.find(member => member.you)?.role ?? team.role);
    onChanged();
  }, [onChanged, team.role]);

  const change = async (member: DesignTeamMember, next: DesignTeamRole) => {
    if (next === member.role) return;
    setProblem(null);
    if (next === 'owner') {
      setPending({kind: 'handover', member});
      return;
    }
    try {
      apply(await changeMemberRole(team.id, member.userId, next));
    } catch (failure) {
      setProblem(errorText(failure));
    }
  };
  return (
    <>
      {!members && !error && <div className="dz-members-loading"><Spinner size={16} label="Loading members" /></div>}
      {error && <p className="dz-team-error" role="alert">{error}</p>}
      {members && (
        <section className="dz-people" aria-label="People with access">
          <ul className="dz-members-list" aria-label="Members">
            {members.members.map(member => {
              const editable = canManageMember(role, member.role) && !member.you;
              return (
                <li key={member.userId} className="dz-member">
                  <span className="dz-member-avatar" aria-hidden="true">{initialOf(member.name)}</span>
                  <span className="dz-member-who">
                    <span className="dz-member-name">{member.name}{member.you && <span className="dz-member-you"> · you</span>}</span>
                  </span>
                  {editable ? (
                    <>
                      <Select size={24} appearance="quiet" aria-label={`Role: ${member.name}`} value={member.role}
                        options={memberRoleOptions(role, member.role)} onChange={next => void change(member, next)} className="dz-member-role" />
                      <IconButton label="Remove from team" onClick={() => setPending({kind: 'remove', member})}><IconClose /></IconButton>
                    </>
                  ) : (
                    <span className="dz-member-role is-static">{DESIGN_TEAM_ROLE_LABELS[member.role]}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {problem && <p className="dz-team-error" role="alert">{problem}</p>}
          {!invitable && <p className="dz-team-note">Only the team owner and admins can invite people.</p>}
        </section>
      )}
      {invitable && <LinkInvite team={team} role={role} invites={invites} onInvites={setInvites} />}
      {pending?.kind === 'remove' && (
        <ConfirmDialog title="Remove from team?" confirmLabel="Remove" onClose={() => setPending(null)} onConfirm={async () => {
          apply(await removeTeamMember(team.id, pending.member.userId));
          setPending(null);
        }}>
          <p>{pending.member.name} will lose access to the files of the team {quoted(team.name)}. The member's personal files are not affected.</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'handover' && (
        <ConfirmDialog title="Transfer team?" confirmLabel="Transfer" onClose={() => setPending(null)} onConfirm={async () => {
          apply(await changeMemberRole(team.id, pending.member.userId, 'owner'));
          setPending(null);
        }}>
          <p>{pending.member.name} will become the owner of the team {quoted(team.name)} and will hold its files. You will stay an admin.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** "Invite link": a role and one click that makes the link and copies it. Its expiry and how many people may use it are a click
 *  away ("Customize"); the links that still work are listed with "Revoke". A link is shown only while this dialog is open (the server
 *  keeps its hash). */
function LinkInvite({team, role, invites, onInvites}: {
  team: DesignTeamSummary;
  role: DesignTeamRole;
  invites: DesignTeamInvite[] | null;
  onInvites: (invites: DesignTeamInvite[]) => void;
}) {
  const options = inviteRoleOptions(role);
  const [linkRole, setLinkRole] = useState<DesignInviteRole>(options.some(option => option.value === 'editor') ? 'editor' : options[0]?.value ?? 'viewer');
  // Reusable by default, as Figma's team link: one link for a chat of people, a month long; "Customize" narrows it.
  const [days, setDays] = useState<string>('30');
  const [uses, setUses] = useState<string>('100');
  const [tuning, setTuning] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The link made in this dialog and the settings it was made with: copying again copies it, a change of settings makes a new one. */
  const [shown, setShown] = useState<{id: string; link: string; key: string} | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const key = `${linkRole}/${days}/${uses}`;
  const current = shown?.key === key ? shown : null;
  const live = (invites ?? []).filter(invite => invite.state === 'active');

  const copy = async () => {
    setProblem(null);
    let link = current?.link ?? null;
    if (!link) {
      setBusy(true);
      try {
        const created = await createTeamInvite(team.id, {role: linkRole, days: Number(days), maxUses: Number(uses)});
        link = designInviteUrl(location.origin, created.token);
        setShown({id: created.invite.id, link, key});
        onInvites([created.invite, ...(invites ?? [])]);
      } catch (failure) {
        setProblem(errorText(failure));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    // The field shows once the link exists; let it render before selecting it on a refusal.
    await Promise.resolve();
    const refused = await copyText(link, linkInput.current);
    setProblem(refused);
    setCopied(!refused);
  };
  const revoke = async (invite: DesignTeamInvite) => {
    setProblem(null);
    try {
      // The row leaves the list of links that work: that is the confirmation.
      onInvites((await revokeTeamInvite(team.id, invite.id)).invites);
      if (shown?.id === invite.id) setShown(null);
    } catch (failure) {
      setProblem(errorText(failure));
    }
  };

  return (
    <section className="dz-invite" aria-label="Invite link">
      <div className="dz-invite-link-row">
        <span className="dz-invite-title"><IconLink /> Invite link</span>
        <Select size={32} appearance="quiet" aria-label="Role for the link" value={linkRole} options={options} onChange={next => {
          setLinkRole(next);
          setCopied(false);
        }} />
        <Button size={32} icon={copied && current ? <IconCheck /> : <IconLink />} busy={busy} onClick={() => void copy()}>
          {copied && current ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <p className="dz-team-note dz-invite-settings">
        {linkSettingsLine(days, uses)} · <button type="button" className="dz-link-button" aria-expanded={tuning} onClick={() => setTuning(value => !value)}>Customize</button>
      </p>
      {tuning && (
        <div className="dz-invite-form">
          <Select size={32} aria-label="Link expiry" value={days} options={INVITE_DAYS} onChange={next => {setDays(next); setCopied(false);}} />
          <Select size={32} aria-label="How many people" value={uses} options={INVITE_USES} onChange={next => {setUses(next); setCopied(false);}} />
        </div>
      )}
      {current && (
        <div className="dz-invite-link">
          <TextInput size={32} value={current.link} onChange={() => undefined} readOnly inputRef={linkInput} selectOnFocus aria-label="Invite link" />
        </div>
      )}
      {current && <p className="dz-team-note">Anyone who opens the link and signs in to {PRODUCT_NAME} can join. The link is visible only while this window is open.</p>}
      {problem && <p className="dz-team-error" role="alert">{problem}</p>}
      {live.length > 0 && (
        <ul className="dz-invite-list" aria-label="Active links">
          {live.map(invite => (
            <li key={invite.id} className="dz-invite-row">
              <span className="dz-invite-role">{DESIGN_TEAM_ROLE_LABELS[invite.role]}</span>
              <span className="dz-invite-line">{inviteLine(invite)}</span>
              <Button size={24} variant="ghost" onClick={() => void revoke(invite)}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A dialog's body text under its title: who sees what. */
export function PeopleLead({children}: {children: ReactNode}) {
  return <p className="dz-team-note dz-people-lead">{children}</p>;
}
