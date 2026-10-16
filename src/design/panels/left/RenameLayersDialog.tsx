import {useMemo, useRef, useState} from 'react';
import type {NodeId} from '../../../../shared/design/types';
import type {DesignStore} from '../../engine/store';
import {userUpdate} from '../../engine/user-edit';
import {Button} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {NumberField} from '../../ui/NumberField';
import {TextInput} from '../../ui/TextInput';
import {RENAME_TOKENS, renameAll, renameOrder} from './batch-rename';

// "Rename layers": ⌘R (or the row menu's "Rename") with several layers selected, as Figma's Rename layers. The
// rules are batch-rename.ts's; the dialog shows the first names as they will be and renames all in one undo step.

const PREVIEW = 6;

export function RenameLayersDialog({store, ids, onClose}: {store: DesignStore; ids: readonly NodeId[]; onClose: () => void}) {
  const doc = store.getState().doc;
  const ordered = useMemo(() => renameOrder(doc, ids.filter(id => doc.nodes[id])), [doc, ids]);
  const names = useMemo(() => ordered.map(id => doc.nodes[id].name), [doc, ordered]);
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState<string>(RENAME_TOKENS.current);
  const [start, setStart] = useState(1);
  const input = useRef<HTMLInputElement>(null);
  const next = useMemo(() => renameAll(names, {find, replace, start}), [names, find, replace, start]);
  const changes = next.filter((name, k) => name !== names[k]).length;

  /** A token goes where the caret is in "Replace with", as Figma's buttons put it. */
  const insert = (token: string) => {
    const field = input.current;
    const from = field?.selectionStart ?? replace.length, to = field?.selectionEnd ?? replace.length;
    setReplace(replace.slice(0, from) + token + replace.slice(to));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(from + token.length, from + token.length);
    });
  };
  const apply = () => {
    if (!changes) return onClose();
    store.transact('Rename layers', tx => {
      ordered.forEach((id, k) => {
        if (next[k] !== names[k]) userUpdate(tx, id, {name: next[k]});
      });
    });
    onClose();
  };

  return (
    <Dialog title={`Rename layers: ${ordered.length}`} onClose={onClose} width={420} dismissible={false} className="dz-rename-layers"
      initialFocus={input}
      footer={<>
        <Button size={32} onClick={onClose}>Cancel</Button>
        <Button size={32} variant="primary" disabled={!changes} onClick={apply}>Rename</Button>
      </>}>
      <form className="dz-rename-form" onSubmit={event => {
        event.preventDefault();
        apply();
      }}>
        <label className="dz-rename-label">
          <span>Find</span>
          <TextInput value={find} onChange={setFind} placeholder="Whole name" aria-label="Find" />
        </label>
        <label className="dz-rename-label">
          <span>Replace with</span>
          <TextInput value={replace} onChange={setReplace} inputRef={input} aria-label="Replace with" selectOnFocus />
        </label>
        <div className="dz-rename-tokens" role="group" aria-label="Insert">
          <Button size={24} variant="ghost" onClick={() => insert(RENAME_TOKENS.current)}>Current name</Button>
          <Button size={24} variant="ghost" onClick={() => insert(RENAME_TOKENS.up)}>Number ↑</Button>
          <Button size={24} variant="ghost" onClick={() => insert(RENAME_TOKENS.down)}>Number ↓</Button>
        </div>
        <label className="dz-rename-label">
          <span>{replace.includes('$N') && !replace.includes('$n') ? 'End at' : 'Start at'}</span>
          <NumberField value={start} onChange={value => setStart(Math.round(value))} precision={0} aria-label="Start at" className="dz-rename-start" />
        </label>
        <p className="dz-rename-hint">$& — what was found (the whole name if "Find" is empty), $1, $2 — its parenthesized parts, $n and $N — the number in ascending and descending order; $nn, $nnn — with leading zeros.</p>
        <button type="submit" hidden />
      </form>
      <ol className="dz-rename-preview" aria-label="New names">
        {next.slice(0, PREVIEW).map((name, k) => (
          <li key={ordered[k]}><span className="dz-rename-old">{names[k]}</span><span aria-hidden="true">→</span><span className="dz-rename-new">{name}</span></li>
        ))}
        {next.length > PREVIEW && <li className="dz-rename-more">…and {next.length - PREVIEW} more</li>}
      </ol>
    </Dialog>
  );
}
