import '../styles/teams.css';
import {useCallback, useEffect, useState} from 'react';
import {
  canManageTeam,
  DESIGN_FILE_GUEST_LABELS,
  DESIGN_FILE_LINK_LABELS,
  DESIGN_TEAM_ROLE_LABELS,
  type DesignFileAccess,
  type DesignFileGuest,
  type DesignFileGuestRole,
  type DesignFileLinkAccess,
  type DesignFileSharing,
  type DesignTeamSummary,
} from '../../../shared/design/teams';
import {readFileSharing, removeDesignFileGuest, setDesignFileGuestRole, setDesignFileLink} from '../api';
import {Button, IconButton} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconCheck, IconChevronLeft, IconClose, IconLink, IconTeam} from '../ui/icons';
import {Select} from '../ui/Select';
import {Spinner} from '../ui/Spinner';
import {listDesignTeams} from './api';
import {quoted} from './model';
import {TeamPeople} from './People';
import {errorText} from '../ui/error-text';

// "Share" in the editor and on a board (docs/design-tool.md §Teams, "File access"), Figma's share dialog: set who may open the
// file by its link, and see everyone who has it — the owner or the team, the people it was shared with (their role, or "Remove
// access"). "Copy link" copies the file's address. Whoever may edit the file shares it; everyone else sees the list. A team file's managers reach the team's people here
// too ("Team members").

export type ShareDialogProps = {
  fileId: string;
  fileName: string;
  kind: 'design' | 'board';
  access: DesignFileAccess | null;
  /** The file's address (the editor's link to it). */
  link: string;
  onClose: () => void;
};

const initialOf = (name: string) => [...name.trim()][0]?.toLocaleUpperCase('en') ?? '·';
const GUEST_OPTIONS = (['editor', 'viewer'] as const).map(role => ({value: role, label: DESIGN_FILE_GUEST_LABELS[role]}));
const LINK_OPTIONS = (['none', 'view', 'edit'] as const).map(link => ({value: link, label: DESIGN_FILE_LINK_LABELS[link]}));

export default function ShareDialog({fileId, fileName, kind, access, link, onClose}: ShareDialogProps) {
  const [sharing, setSharing] = useState<DesignFileSharing | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [team, setTeam] = useState<DesignTeamSummary | null>(null);
  const [teamPanel, setTeamPanel] = useState(false);
  const what = kind === 'board' ? 'board' : 'file';

  useEffect(() => {
    const controller = new AbortController();
    readFileSharing(fileId, controller.signal).then(
      answer => !controller.signal.aborted && setSharing(answer),
      error => !controller.signal.aborted && setFailed(errorText(error)),
    );
    return () => controller.abort();
  }, [fileId]);
  // A team file's managers manage the team's people from here too: the team as the file browser knows it.
  const teamId = access?.team && canManageTeam(access.role) ? access.team.id : null;
  const reloadTeam = useCallback(() => {
    if (!teamId) return;
    listDesignTeams().then(answer => setTeam(answer.teams.find(entry => entry.id === teamId) ?? null), () => undefined);
  }, [teamId]);
  useEffect(reloadTeam, [reloadTeam]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setProblem(null);
    } catch {
      setProblem('Copy the address from the browser bar: the browser did not allow access to the clipboard.');
    }
  };
  const act = async (work: () => Promise<DesignFileSharing | {ok: true}>) => {
    setProblem(null);
    try {
      const next = await work();
      if ('fileId' in next) setSharing(next);
    } catch (error) {
      setProblem(errorText(error));
    }
  };

  // As Figma's: "Copy link" in the header beside ×, in the accent; "Done" closes.
  const copy = (
    <Button size={24} variant="ghost" icon={copied ? <IconCheck /> : <IconLink />} className="dz-share-copy" onClick={() => void copyLink()}>
      {copied ? 'Link copied' : 'Copy link'}
    </Button>
  );
  const footer = <Button size={32} variant="primary" onClick={onClose}>Done</Button>;

  if (teamPanel && team)
    return (
      <Dialog title={`Members · ${team.name}`} onClose={onClose} width={520} dismissible={false} className="dz-team-dialog dz-members dz-share"
        footer={<Button size={32} variant="primary" onClick={onClose}>Done</Button>}>
        <Button size={24} variant="ghost" icon={<IconChevronLeft />} className="dz-share-back" onClick={() => setTeamPanel(false)}>Back to {what} access</Button>
        <TeamPeople team={team} onChanged={reloadTeam} />
      </Dialog>
    );

  return (
    <Dialog title={`Share ${quoted(fileName)}`} onClose={onClose} width={520} dismissible={false} className="dz-team-dialog dz-members dz-share" actions={copy} footer={footer}>
      {failed && !sharing && <p className="dz-team-error" role="alert">{failed}</p>}
      {!sharing && !failed && <div className="dz-members-loading"><Spinner size={16} label="Loading access" /></div>}
      {sharing && (
        <>
          {!sharing.canShare && <p className="dz-team-note">Only people who can edit this {kind === 'board' ? 'board' : 'file'} can change who has access.</p>}
          <section className="dz-people" aria-label="Who has access">
            <h3 className="dz-share-heading">Who has access</h3>
            <div className="dz-member dz-share-link-row">
              <span className="dz-member-avatar is-icon" aria-hidden="true"><IconLink size={14} /></span>
              <span className="dz-member-who">
                <span className="dz-member-name">Link access</span>
                <span className="dz-member-email">{linkNote(sharing.link, what)}</span>
              </span>
              {sharing.canShare ? (
                <Select size={24} appearance="quiet" aria-label="Link access" value={sharing.link} options={LINK_OPTIONS} className="dz-share-link-select"
                  onChange={(next: DesignFileLinkAccess) => void act(() => setDesignFileLink(fileId, next))} />
              ) : (
                <span className="dz-member-role is-static">{sharing.link === 'none' ? 'Off' : sharing.link === 'view' ? 'Can view' : 'Can edit'}</span>
              )}
            </div>
            <ul className="dz-members-list" aria-label="People with access">
              {sharing.team && (
                <li className="dz-member">
                  <span className="dz-member-avatar is-icon" aria-hidden="true"><IconTeam size={14} /></span>
                  <span className="dz-member-who">
                    <span className="dz-member-name">Team {quoted(sharing.team.name)}</span>
                    <span className="dz-member-email">{membersLine(sharing.team.members)} — by their roles in the team</span>
                  </span>
                  {team ? (
                    <Button size={24} variant="ghost" onClick={() => setTeamPanel(true)}>Members</Button>
                  ) : (
                    sharing.you.guest ? null : <span className="dz-member-role is-static">{DESIGN_TEAM_ROLE_LABELS[sharing.you.role]} (you)</span>
                  )}
                </li>
              )}
              {sharing.owner && (
                <li className="dz-member">
                  <span className="dz-member-avatar" aria-hidden="true">{initialOf(sharing.owner.name)}</span>
                  <span className="dz-member-who">
                    <span className="dz-member-name">{sharing.owner.name}{sharing.owner.you && <span className="dz-member-you"> · you</span>}</span>
                  </span>
                  <span className="dz-member-role is-static">Owner</span>
                </li>
              )}
              {sharing.guests.map(guest => (
                <GuestRow key={guest.userId} guest={guest} canShare={sharing.canShare}
                  onRole={role => void act(() => setDesignFileGuestRole(fileId, guest.userId, role))}
                  onRemove={() => void act(() => removeDesignFileGuest(fileId, guest.userId))}
                  onLeave={() => void removeDesignFileGuest(fileId, 'me').then(onClose, error => setProblem(errorText(error)))} />
              ))}
            </ul>
          </section>
          {problem && <p className="dz-team-error" role="alert">{problem}</p>}
        </>
      )}
    </Dialog>
  );
}

const membersLine = (count: number) =>
  `${count} ${count === 1 ? 'member' : 'members'}`;
const linkNote = (link: DesignFileLinkAccess, what: string) =>
  link === 'none'
    ? `Only people on this list can open this ${what}`
    : `Anyone who signs in to Morfa with the link can ${link === 'edit' ? 'edit' : 'view'}`;

/** One person the file was shared with: their role and "Remove access" for a sharer, "Leave" for themselves. */
function GuestRow({guest, canShare, onRole, onRemove, onLeave}: {
  guest: DesignFileGuest;
  canShare: boolean;
  onRole: (role: DesignFileGuestRole) => void;
  onRemove: () => void;
  onLeave: () => void;
}) {
  return (
    <li className="dz-member">
      <span className="dz-member-avatar" aria-hidden="true">{initialOf(guest.name)}</span>
      <span className="dz-member-who">
        <span className="dz-member-name">{guest.name}{guest.you && <span className="dz-member-you"> · you</span>}</span>
      </span>
      {canShare && !guest.you ? (
        <>
          <Select size={24} appearance="quiet" aria-label={`Access: ${guest.name}`} value={guest.role} options={GUEST_OPTIONS} onChange={onRole} className="dz-member-role" />
          <IconButton label={`Remove access: ${guest.name}`} onClick={onRemove}><IconClose /></IconButton>
        </>
      ) : (
        <>
          <span className="dz-member-role is-static">{DESIGN_FILE_GUEST_LABELS[guest.role]}</span>
          {guest.you && <Button size={24} variant="ghost" onClick={onLeave}>Leave</Button>}
        </>
      )}
    </li>
  );
}
