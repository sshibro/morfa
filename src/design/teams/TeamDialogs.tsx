import {useRef, useState, type ReactNode} from 'react';
import {DESIGN_LIMITS} from '../../../shared/design/limits';
import {DESIGN_TEAM_LIMITS, DESIGN_TEAM_ROLE_LABELS, canManageTeam, type DesignTeamSummary} from '../../../shared/design/teams';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconLeave, IconTrash} from '../ui/icons';
import {TextInput} from '../ui/TextInput';
import {deleteDesignTeam, leaveDesignTeam, renameDesignTeam} from './api';
import {quoted} from './model';
import {errorText} from '../ui/error-text';

// The small dialogs of teams (docs/design-tool.md §Teams): a name (a new team, a project, a rename), a confirmation, and "Team settings". Each says what the server answered when it refuses; nothing is assumed to have worked before the answer.


/** One name: "Create team", "New project", "Rename project". */
export function NameDialog({title, label, initial = '', placeholder, submitLabel, note, onClose, onSubmit}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  note?: ReactNode;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const name = value.trim();
  const submit = async () => {
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} width={400} dismissible={false} initialFocus={input} className="dz-team-dialog" footer={
      <>
        <Button size={32} onClick={onClose}>Cancel</Button>
        <Button size={32} variant="primary" busy={busy} disabled={!name} onClick={() => void submit()}>{submitLabel}</Button>
      </>
    }>
      <label className="dz-team-field">
        <span className="dz-team-label">{label}</span>
        <TextInput size={32} value={value} onChange={setValue} onCommit={() => void submit()} inputRef={input} selectOnFocus
          maxLength={DESIGN_TEAM_LIMITS.nameLength} placeholder={placeholder} aria-label={label} />
      </label>
      {note && <p className="dz-team-note">{note}</p>}
      {error && <p className="dz-team-error" role="alert">{error}</p>}
    </Dialog>
  );
}

/** "Delete…", "Leave…": the irreversible ones ask first. */
export function ConfirmDialog({title, children, confirmLabel, onClose, onConfirm}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={title} onClose={onClose} width={400} className="dz-team-dialog" footer={
      <>
        <Button size={32} onClick={onClose}>Cancel</Button>
        <Button size={32} variant="danger" busy={busy} data-autofocus onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onConfirm();
          } catch (failure) {
            setError(errorText(failure));
            setBusy(false);
          }
        }}>{confirmLabel}</Button>
      </>
    }>
      {children}
      {error && <p className="dz-team-error" role="alert">{error}</p>}
    </Dialog>
  );
}

type Step = 'main' | 'delete' | 'leave';

/** "Team settings": the name (owner and admins), "Leave team" (anyone but the owner), "Delete team" (the owner). */
export function TeamSettingsDialog({team, onClose, onChanged, onGone}: {
  team: DesignTeamSummary;
  onClose: () => void;
  onChanged: (team: DesignTeamSummary) => void;
  /** The team is deleted or left: the browser goes back to personal files. */
  onGone: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>('main');
  const [name, setName] = useState(team.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manager = canManageTeam(team.role);
  const owner = team.role === 'owner';
  const changed = name.trim() && name.trim() !== team.name;

  if (step === 'delete')
    return (
      <ConfirmDialog title="Delete team?" confirmLabel="Delete team" onClose={() => setStep('main')} onConfirm={async () => {
        await deleteDesignTeam(team.id);
        onGone(`Team ${quoted(team.name)} deleted`);
      }}>
        <p>The team {quoted(team.name)} will disappear for all members and invite links will stop working. Its files go to the team trash and are deleted
          after {DESIGN_LIMITS.trashDays} days; only support can bring them back.</p>
      </ConfirmDialog>
    );
  if (step === 'leave')
    return (
      <ConfirmDialog title="Leave team?" confirmLabel="Leave" onClose={() => setStep('main')} onConfirm={async () => {
        await leaveDesignTeam(team.id);
        onGone(`You left the team ${quoted(team.name)}`);
      }}>
        <p>The files of the team {quoted(team.name)} will no longer be available to you. Your personal files stay. You can rejoin with a new invite link.</p>
      </ConfirmDialog>
    );

  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const {team: renamed} = await renameDesignTeam(team.id, name.trim());
      onChanged(renamed);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Team settings" onClose={onClose} width={420} className="dz-team-dialog" footer={
      manager ? (
        <>
          <Button size={32} onClick={onClose}>Cancel</Button>
          <Button size={32} variant="primary" busy={busy} disabled={!changed} onClick={() => void save()}>Save</Button>
        </>
      ) : <Button size={32} variant="primary" onClick={onClose}>Done</Button>
    }>
      <label className="dz-team-field">
        <span className="dz-team-label">Name</span>
        <TextInput size={32} value={name} onChange={setName} onCommit={() => void save()} disabled={!manager}
          maxLength={DESIGN_TEAM_LIMITS.nameLength} aria-label="Team name" />
      </label>
      <p className="dz-team-note">Your role: {DESIGN_TEAM_ROLE_LABELS[team.role]}. Members: {team.members}.</p>
      {error && <p className="dz-team-error" role="alert">{error}</p>}
      <div className="dz-team-danger">
        {owner ? (
          <div className="dz-team-danger-row">
            <div>
              <div className="dz-team-danger-title">Delete team</div>
              <div className="dz-team-danger-text">Files go to the trash, members lose access.</div>
            </div>
            <Button size={32} variant="danger" icon={<IconTrash />} onClick={() => setStep('delete')}>Delete</Button>
          </div>
        ) : (
          <div className="dz-team-danger-row">
            <div>
              <div className="dz-team-danger-title">Leave team</div>
              <div className="dz-team-danger-text">Your personal files stay with you.</div>
            </div>
            <Button size={32} icon={<IconLeave />} onClick={() => setStep('leave')}>Leave</Button>
          </div>
        )}
        {owner && <p className="dz-team-note">The owner cannot leave the team: first transfer it to another member in Members.</p>}
      </div>
    </Dialog>
  );
}
