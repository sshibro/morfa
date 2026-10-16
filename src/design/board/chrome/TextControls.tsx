import {useCallback, useRef, useState, type ReactNode} from 'react';
import type {NodeId, SceneNode, TextStyle} from '../../../../shared/design/types';
import {childPart} from '../../../../shared/design/board/model';
import {applyTextOp} from '../../engine/commands/text';
import {decorationChange, normalizeLink} from '../../engine/text-editor/style-ops';
import type {DesignStore} from '../../engine/store';
import {Popover} from '../../ui/Popover';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {useTooltip} from '../../ui/Tooltip';
import {isHandwriting, setHandwriting, setTextSize, textSizeOf, TEXT_SIZE_LABELS, type TextSize} from '../edits';
import {BdLink, BdList, BdStrike} from './icons';

// The text group of the context toolbar (help.figma.com "Sticky notes in FigJam", its picture: "Aa", then bold, strikethrough,
// link and list): "Aa" opens the face (plain or handwriting) and, where the object takes one, the size; the others act on the
// whole text of every selected object at once, one undo step each, through the editor's own text operations.

type Get = (id: NodeId | null | undefined) => SceneNode | undefined;

/** The text layers of board objects: a sticky's or shape's text, a connector's label, a text itself. */
export function textIdsOf(get: Get, objects: readonly SceneNode[]): NodeId[] {
  const ids: NodeId[] = [];
  for (const object of objects) {
    if (object.type === 'TEXT') ids.push(object.id);
    if (object.board?.kind === 'table') {
      for (const rowId of object.children ?? []) for (const cellId of get(rowId)?.children ?? []) {
        const text = childPart(get, get(cellId), 'text');
        if (text?.type === 'TEXT') ids.push(text.id);
      }
      continue;
    }
    const part = childPart(get, object, 'text') ?? childPart(get, childPart(get, object, 'label'), 'text') ?? childPart(get, object, 'label');
    if (part?.type === 'TEXT') ids.push(part.id);
  }
  return ids;
}

const firstStyle = (get: Get, ids: readonly NodeId[]): TextStyle | undefined => get(ids[0])?.text?.style;

export function ContextButton({label, pressed, onClick, children, className = ''}: {label: string; pressed?: boolean; onClick: () => void; children: ReactNode; className?: string}) {
  const tip = useTooltip({label, placement: 'top'});
  return <button type="button" className={`bd-context-btn ${className}`.trim()} aria-label={label} aria-pressed={pressed} {...tip} onClick={onClick}>{children}</button>;
}

/** "Aa": the face, and the size when `sized` (a sticky sizes its own text). */
export function FaceMenu({store, objects, get, sized}: {store: DesignStore; objects: SceneNode[]; get: Get; sized: boolean}) {
  const first = objects[0];
  const items = useCallback((): MenuItem[] => {
    const hand = isHandwriting(get, first);
    const faces: MenuItem[] = [
      {id: 'plain', label: 'Regular', checked: !hand, radio: true, onSelect: () => setHandwriting(store, objects, false)},
      {id: 'hand', label: 'Handwriting', checked: hand, radio: true, onSelect: () => setHandwriting(store, objects, true)},
    ];
    if (!sized) return faces;
    const size = textSizeOf(get, first);
    const sizes: MenuItem[] = (['s', 'm', 'l', 'xl'] as TextSize[]).map(id => ({
      id: 'size-' + id, label: `${{s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large'}[id]} · ${TEXT_SIZE_LABELS[id]}`, checked: size === id, radio: true,
      onSelect: () => setTextSize(store, objects, id),
    }));
    return [...faces, {type: 'separator'}, ...sizes];
  }, [store, objects, get, first, sized]);
  const menu = useMenuTrigger({items, label: 'Font', placement: 'top-start', minWidth: 200});
  const tip = useTooltip(menu.open ? null : {label: sized ? 'Font and size' : 'Font', placement: 'top'});
  return (
    <>
      <button type="button" className="bd-context-btn is-face" aria-label={sized ? 'Font and size' : 'Font'} {...tip} {...menu.triggerProps}>Aa</button>
      {menu.element}
    </>
  );
}

export function StrikeButton({store, ids, get}: {store: DesignStore; ids: NodeId[]; get: Get}) {
  const on = firstStyle(get, ids)?.textDecoration === 'STRIKETHROUGH';
  return (
    <ContextButton label="Strikethrough" pressed={on} onClick={() => applyTextOp(store, {kind: 'toggle', make: pieces => decorationChange(pieces, 'STRIKETHROUGH')}, 'Strikethrough', {ids})}>
      <BdStrike size={20} />
    </ContextButton>
  );
}

export function ListButton({store, ids, get}: {store: DesignStore; ids: NodeId[]; get: Get}) {
  const on = (get(ids[0])?.text?.listTypes ?? []).some(type => type === 'UNORDERED');
  return (
    <ContextButton label="Bulleted list" pressed={on} onClick={() => applyTextOp(store, {kind: 'list', type: 'UNORDERED', toggle: true}, 'List', {ids})}>
      <BdList size={20} />
    </ContextButton>
  );
}

/** "Link": a small field over the toolbar; the address links the whole text; empty takes the link away. */
export function LinkButton({store, ids, get}: {store: DesignStore; ids: NodeId[]; get: Get}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const link = firstStyle(get, ids)?.hyperlink;
  const current = link?.type === 'URL' ? link.url : '';
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState(false);
  const tip = useTooltip(open ? null : {label: 'Link', placement: 'top'});
  const save = () => {
    if (!draft.trim()) {
      applyTextOp(store, {kind: 'link', link: null}, 'Link', {ids});
      setOpen(false);
      return;
    }
    const url = normalizeLink(draft);
    if (!url) {
      setError(true);
      return;
    }
    applyTextOp(store, {kind: 'link', link: {type: 'URL', url}}, 'Link', {ids});
    setOpen(false);
  };
  return (
    <>
      <button ref={button} type="button" className="bd-context-btn" aria-label="Link" aria-pressed={!!current} aria-expanded={open} {...tip}
        onClick={() => {
          setDraft(current);
          setError(false);
          setOpen(value => !value);
        }}>
        <BdLink size={20} />
      </button>
      {open && button.current && (
        <Popover anchor={button.current} placement="top" offset={10} aria-label="Link" className="bd-link-popover" onClose={() => setOpen(false)}>
          <form onSubmit={event => {
            event.preventDefault();
            save();
          }}>
            <input className="bd-link-input" type="text" inputMode="url" autoFocus value={draft} placeholder="https://" aria-label="Link address" aria-invalid={error}
              onChange={event => {
                setDraft(event.currentTarget.value);
                setError(false);
              }} />
            {error && <p className="bd-link-error" role="alert">This does not look like an address</p>}
          </form>
        </Popover>
      )}
    </>
  );
}
