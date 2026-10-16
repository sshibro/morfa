import {useState} from 'react';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {errorText} from '../ui/error-text';

// Autosave answered 409 version_conflict: the file was saved elsewhere (another tab, another device)
// since this editor opened it. Saving stopped; the designer chooses which copy wins. Nothing is
// lost either way: the server keeps the copy it replaces in the version history.

export type ConflictDialogProps = {
  /** "Load latest version": the server's copy replaces the editor's; unsaved edits are dropped. */
  onReload: () => Promise<void>;
  /** "Keep mine": the editor's copy is written over the server's. */
  onKeepMine: () => Promise<void>;
};

export function ConflictDialog({onReload, onKeepMine}: ConflictDialogProps) {
  const [busy, setBusy] = useState<'reload' | 'keep' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (kind: 'reload' | 'keep', action: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure, 'That did not work. Check your connection and try again.'));
      setBusy(null);
    }
  };
  return (
    // The choice is required: Escape and the backdrop do not close it.
    <Dialog title="File changed in another tab" onClose={() => {}} closable={false} width={420} className="dz-conflict" footer={
      <>
        <Button size={32} busy={busy === 'reload'} disabled={busy === 'keep'} onClick={act('reload', onReload)}>Load latest version</Button>
        <Button size={32} variant="primary" busy={busy === 'keep'} disabled={busy === 'reload'} data-autofocus onClick={act('keep', onKeepMine)}>Keep mine</Button>
      </>
    }>
      <p>While you were working, this file was saved in another tab or on another device, so your latest changes are not saved yet.</p>
      <p>&quot;Load latest version&quot; opens the saved copy without your unsaved edits. &quot;Keep mine&quot; saves what you see now over it. The replaced copy stays in the version history.</p>
      {error && <p className="dz-conflict-error" role="alert">{error}</p>}
    </Dialog>
  );
}
