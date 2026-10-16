import {memo, useEffect, useRef, useState} from 'react';
import {IconOffline} from '../../ui/icons';
import {TextInput} from '../../ui/TextInput';
import {useTooltip} from '../../ui/Tooltip';
import {MemoryIndicator} from './MemoryIndicator';

/** `unsaved`: saving stopped until the designer decides (a conflict with another tab). `readonly`: a team file the caller may only
 *  look at (a developer or a viewer: docs/design-tool.md §Teams); nothing is saved and the name is not renamed. */
export type SaveState = 'saved' | 'saving' | 'offline' | 'unsaved' | 'readonly';

const SAVE_LABEL: Record<SaveState, string> = {saved: 'Saved', saving: 'Saving…', offline: 'Offline', unsaved: 'Not saved', readonly: 'View only'};

/** "Saved" / "Saving…" / "Offline" under the file name; announced politely. */
export const SaveStatus = memo(function SaveStatus({state}: {state: SaveState}) {
  const tip = useTooltip(
    state === 'offline'
      ? {label: 'Changes will be saved when the connection returns', placement: 'bottom-start'}
      : state === 'readonly'
        ? {label: 'Only editors can change team files. You can still view, export and copy code.', placement: 'bottom-start'}
        : null,
  );
  const focusable = state === 'offline' || state === 'readonly';
  return (
    <span className={`dz-save-status is-${state}`} role="status" aria-live="polite" {...tip} tabIndex={focusable ? 0 : undefined}>
      {state === 'offline' && <IconOffline size={12} />}
      {SAVE_LABEL[state]}
    </span>
  );
});

export type FileTitleProps = {
  name: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  /** Bump to start renaming from elsewhere (the "Rename" command). */
  renameRequest?: number;
};

/** The file's name, renamed in place: click, type, Enter (Escape keeps the old name). */
export const FileTitle = memo(function FileTitle({name, onRename, saveState, renameRequest = 0}: FileTitleProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // Enter, blur and Escape can all arrive for one edit; only the first one counts.
  const closed = useRef(true);
  const start = () => {
    closed.current = false;
    setDraft(name);
  };
  const firstRequest = useRef(renameRequest);
  const readOnly = saveState === 'readonly';
  useEffect(() => {
    if (renameRequest !== firstRequest.current && !readOnly) start();
  }, [renameRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = (value: string | null) => {
    if (closed.current) return;
    closed.current = true;
    setDraft(null);
    const next = value?.trim().replace(/\s+/g, ' ');
    if (next && next !== name) onRename(next.slice(0, 200));
  };
  return (
    <div className="dz-file-title">
      {readOnly ? (
        <span className="dz-file-name is-static" title={name}>{name}</span>
      ) : draft === null ? (
        <button type="button" className="dz-file-name" title="Rename" onClick={start}>{name}</button>
      ) : (
        <TextInput className="dz-file-name-input" appearance="quiet" value={draft} onChange={setDraft} onCommit={finish} onCancel={() => finish(null)}
          autoFocus selectOnFocus maxLength={200} aria-label="File name" onBlur={event => finish(event.currentTarget.value)} />
      )}
      <SaveStatus state={saveState} />
      <MemoryIndicator />
    </div>
  );
});
