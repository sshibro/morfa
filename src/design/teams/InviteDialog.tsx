import {useEffect, useRef, useState} from 'react';
import {ApiError} from '../../api';
import {errorText} from '../ui/error-text';
import {
  DESIGN_TEAM_ROLE_LABELS,
  DESIGN_TEAM_ROLE_NOTES,
  type DesignInviteAccepted,
  type DesignInvitePreview,
} from '../../../shared/design/teams';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconTeam} from '../ui/icons';
import {Spinner} from '../ui/Spinner';
import {acceptDesignInvite, previewDesignInvite} from './api';

// The invite landing (docs/design-tool.md §Teams), over the file browser: a link, `/?designInvite=<token>#designs` (a visitor who was
// signed out signed in first; the address kept the token). It names the team, who invites and the role before anything changes;
// "Join" joins. A link that is spent, revoked or expired says so.

type State =
  | {kind: 'loading'}
  | {kind: 'ready'; preview: DesignInvitePreview}
  | {kind: 'failed'; title: string; text: string};

const failure = (error: unknown): State => {
  const code = error instanceof ApiError ? error.details?.code : undefined;
  if (code === 'design_invite_expired') return {kind: 'failed', title: 'Invitation is no longer valid', text: error instanceof Error ? error.message : ''};
  if (code === 'design_invite_invalid' || (error instanceof ApiError && error.status === 404))
    return {kind: 'failed', title: 'Invitation not found', text: 'Check the link or ask the team for a new one.'};
  return {kind: 'failed', title: 'Could not open the invitation', text: errorText(error, 'Check your connection and open the link again.')};
};

export function InviteDialog({token, onClose, onJoined}: {
  token: string;
  onClose: () => void;
  /** Joined (or already a member): the browser opens the team. */
  onJoined: (answer: DesignInviteAccepted) => void | Promise<void>;
}) {
  const [state, setState] = useState<State>({kind: 'loading'});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog opened on the spinner, with nothing to focus but its close button; the answer moves focus to the primary action.
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state.kind !== 'loading') primary.current?.focus({preventScroll: true});
  }, [state.kind]);
  useEffect(() => {
    const controller = new AbortController();
    previewDesignInvite(token, controller.signal).then(
      preview => !controller.signal.aborted && setState({kind: 'ready', preview}),
      error => !controller.signal.aborted && setState(failure(error)),
    );
    return () => controller.abort();
  }, [token]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await onJoined(await acceptDesignInvite(token));
    } catch (failed) {
      setError(errorText(failed, 'Could not join. Try again.'));
      setBusy(false);
    }
  };

  if (state.kind === 'loading')
    return (
      <Dialog title="Team invitation" onClose={onClose} width={400} className="dz-team-dialog">
        <div className="dz-members-loading"><Spinner size={16} label="Opening the invitation" /></div>
      </Dialog>
    );
  if (state.kind === 'failed')
    return (
      <Dialog title={state.title} onClose={onClose} width={400} className="dz-team-dialog" footer={<Button ref={primary} size={32} variant="primary" onClick={onClose}>Got it</Button>}>
        <p>{state.text}</p>
      </Dialog>
    );
  const {preview} = state;
  const member = preview.member;
  return (
    <Dialog title="Team invitation" onClose={onClose} width={400} className="dz-team-dialog dz-invite-landing" footer={
      member ? (
        <Button ref={primary} size={32} variant="primary" onClick={() => onJoined({team: preview.team, role: member, joined: false})}>Open team</Button>
      ) : (
        <>
          <Button size={32} onClick={onClose}>Not now</Button>
          <Button ref={primary} size={32} variant="primary" busy={busy} disabled={busy} onClick={() => void join()}>Join</Button>
        </>
      )
    }>
      {!member && preview.invitedBy && <p className="dz-invite-by">{preview.invitedBy} invites you to join the team</p>}
      <div className="dz-invite-hero">
        <span className="dz-invite-badge" aria-hidden="true"><IconTeam size={20} /></span>
        <div>
          <div className="dz-invite-team">{preview.team.name}</div>
          <div className="dz-invite-as">
            {member ? `You are already in the team: ${DESIGN_TEAM_ROLE_LABELS[member]}` : `Role: ${DESIGN_TEAM_ROLE_LABELS[preview.role]}`}
          </div>
        </div>
      </div>
      {!member && <p className="dz-team-note">{DESIGN_TEAM_ROLE_NOTES[preview.role]}. Your personal files stay yours alone.</p>}
      {error && <p className="dz-team-error" role="alert">{error}</p>}
    </Dialog>
  );
}
