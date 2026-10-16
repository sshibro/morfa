import {useCallback, useEffect, useReducer, useState, useSyncExternalStore} from 'react';
import type {Hyperlink} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import {applyTextOp} from '../engine/commands/text';
import {layerLink, selectNode} from '../engine/commands/link';
import {runCommand} from '../engine/commands/registry';
import {activeTextEdit, subscribeTextEditing, textEditingSnapshot} from '../engine/text-editor';
import {linkAtCaret, onTextLinkRequest, textLinkFor} from '../engine/text-editor/link-request';
import {Popover} from '../ui/Popover';
import {Portal} from '../ui/layer';
import {TextInput} from '../ui/TextInput';
import {IconButton} from '../ui/Button';
import {IconArrowRight, IconExternal, IconFrame, IconLink, IconTrash} from '../ui/icons';

// Text links on the canvas, as Figma's ("Add links to text"): ⌘K while editing a text opens "Link" at the caret for the
// selected words (a caret inside a link edits that link); a caret inside a link shows its card there — the address or the
// layer it leads to, "Open link" or "Go to layer", "Edit link" and "Remove link". A layer link of this
// file ("Copy link to selection", ⌘L) links the words to that layer, as Figma links text to a frame. The session's keys
// and paste are in text-editor/session.ts.

const shortUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

export function TextLinkLayer({store, canvasSize}: {store: DesignStore; canvasSize: () => {width: number; height: number}}) {
  const editing = useSyncExternalStore(useCallback(listener => subscribeTextEditing(store, listener), [store]), () => textEditingSnapshot(store));
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState(false);
  useEffect(() => onTextLinkRequest(store, () => setOpen(true)), [store]);
  // While a text is edited, the card follows the caret through pans and zooms and the link through undo; otherwise the
  // layer listens to nothing, so drags and pans do not render it (design-render-counts.spec).
  const editingText = !!editing;
  useEffect(() => (editingText ? store.subscribe(redraw, {slice: ['viewport', 'doc']}) : undefined), [store, editingText]);
  useEffect(() => {
    if (!editing) setOpen(false);
  }, [editing]);

  const session = editing ? activeTextEdit(store) : null;
  const anchor = session?.anchor?.() ?? null;
  if (!editing || !session || !anchor) return null;
  const link = linkAtCaret(store)?.hyperlink ?? null;
  const back = () => session.focus();

  if (open) {
    return <LinkField anchor={anchor} current={link} onClose={() => {
      setOpen(false);
      back();
    }} store={store} />;
  }
  if (!link) return null;
  const layer = link.type === 'NODE' ? store.getState().doc.nodes[link.nodeId] : undefined;
  const rect = anchor.getBoundingClientRect();
  return (
    <Portal>
      <div className="dz-text-link-card" role="group" aria-label="Text link" style={{left: rect.left, top: rect.bottom + 8}}
        // The card keeps the keyboard in the text: a press on it does not take the focus.
        onPointerDown={event => event.preventDefault()}>
        {link.type === 'URL' ? (
          <>
            <IconLink className="dz-text-link-icon" />
            <a className="dz-text-link-url" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>{shortUrl(link.url)}</a>
            <IconButton label="Open link" onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}><IconExternal /></IconButton>
          </>
        ) : (
          <>
            <IconFrame className="dz-text-link-icon" />
            <span className="dz-text-link-url">{layer ? layer.name || 'Untitled' : 'Layer deleted'}</span>
            {layer && <IconButton label="Go to layer" onClick={() => {
              if (selectNode(store, link.nodeId)) runCommand('zoom-selection', {store, canvasSize});
            }}><IconArrowRight /></IconButton>}
          </>
        )}
        <IconButton label="Edit link" shortcut="Mod+KeyK" onClick={() => setOpen(true)}><IconLink /></IconButton>
        <IconButton label="Remove link" onClick={() => {
          applyTextOp(store, {kind: 'link', link: null}, 'Remove link');
          back();
        }}><IconTrash /></IconButton>
      </div>
    </Portal>
  );
}

/** "Link": the address for the selected words; Enter links them, an empty field takes the link away. */
function LinkField({store, anchor, current, onClose}: {store: DesignStore; anchor: Element; current: Hyperlink | null; onClose: () => void}) {
  const initial = current?.type === 'URL' ? current.url : current?.type === 'NODE' ? layerLink(store, current.nodeId) ?? '' : '';
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState(false);
  const commit = (value: string) => {
    if (!value.trim()) {
      if (current) applyTextOp(store, {kind: 'link', link: null}, 'Remove link');
      onClose();
      return;
    }
    const next = textLinkFor(store, value);
    if (!next) {
      setError(true);
      return;
    }
    applyTextOp(store, {kind: 'link', link: next}, 'Link');
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-start" aria-label="Link" className="dz-text-link-popover" sheet={false}>
      <div className="dz-text-link-field">
        <TextInput value={draft} autoFocus selectOnFocus inputMode="url" placeholder="https://… or a link to a layer" aria-label="Link address" icon={<IconLink />}
          aria-invalid={error || undefined} className={error ? 'is-invalid' : undefined}
          onChange={value => {
            setDraft(value);
            setError(false);
          }}
          onCommit={commit} onCancel={onClose} />
        {error && <p className="dz-text-error" role="alert">Enter a link that starts with http:// or https://, or a link from "Copy link to selection"</p>}
      </div>
    </Popover>
  );
}
