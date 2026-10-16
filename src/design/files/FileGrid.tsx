import {memo, useRef, useState, type KeyboardEvent, type MouseEvent} from 'react';
import type {DesignFileSummary} from '../../../shared/design/api';
import {IconButton} from '../ui/Button';
import {IconComment, IconFrame, IconMore, IconStar} from '../ui/icons';
import {TextInput} from '../ui/TextInput';
import {editedAgo, relativeTime, trashedAgo, type FileSort} from './format';
import {BOARD_NAMES} from '../../../shared/design/board/names';
import {IconBoard} from './board-icon';
import {useLongPress} from './phone/long-press';
import type {SelectHow} from './selection';
import {FILES_DRAG_TYPE} from './drop';

export type FileMenuAnchor = MouseEvent | {element: Element; keyboard: boolean};

export type FileGridProps = {
  files: readonly DesignFileSummary[];
  mode: 'grid' | 'list';
  trash: boolean;
  /** The keyboard's place: the file last clicked or moved to. */
  selectedId: string | null;
  /** Every selected file (⌘/Ctrl- and Shift-clicks add to it, selection.ts). */
  selectedIds: readonly string[];
  onSelect: (id: string, how?: SelectHow) => void;
  /** After "Select" on a phone: a tap adds a file to the selection or takes it out instead of opening it. */
  touchSelecting?: boolean;
  /** ⌘A: every file shown; Escape: none. */
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** The list's headings sort by their column, as Figma's list view (a mouse convenience; the "Sort" menu is the way for
   *  everyone). */
  sort?: FileSort;
  onSort?: (sort: FileSort) => void;
  /** A drag starts on a card: the files it carries (the selection when the card is in it); none, no drag (drop.ts). */
  onDragFiles?: (file: DesignFileSummary) => readonly string[];
  onDragEnd?: () => void;
  /** "Favorites" (useFavourites.ts): whether a file is starred, and the card's star, Figma's star on hover (grid only). */
  starred?: (id: string) => boolean;
  onStar?: (file: DesignFileSummary, on: boolean) => void;
  onOpen: (file: DesignFileSummary, newTab?: boolean) => void;
  onMenu: (file: DesignFileSummary, anchor: FileMenuAnchor) => void;
  renamingId: string | null;
  onRenameStart: (file: DesignFileSummary) => void;
  onRename: (file: DesignFileSummary, name: string) => void;
  onRenameEnd: () => void;
  onTrash: (file: DesignFileSummary) => void;
  /** Re-renders relative times once a minute. */
  now: number;
  /** A card's own line instead of "Modified …" (in "Shared with me": whose file and what may be done). */
  describe?: (file: DesignFileSummary) => {text: string} | null;
};

export const designHref = (id: string) => '#design/' + encodeURIComponent(id);

/** "Oct 3" this year, "Oct 3, 2025" before. */
const shortDate = (iso: string, now: number) => {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'short', ...(sameYear ? {} : {year: 'numeric'})}).format(date);
};

/**
 * Files as cards (16:10 thumbnails) or rows. One tab stop for the whole set: arrows move the
 * selection, Enter opens, F2 renames, Delete moves to the trash, the context-menu key or Shift+F10
 * opens the menu. ⌘/Ctrl-click and Shift-click select several files, ⌘A all, Escape none (Figma's); each item is a real
 * link, so a middle click opens a new tab and ⌘Enter opens the focused file in one. A finger opens a file with one tap
 * (a trashed one shows its menu) and holds a card for its menu; the "⋯" is always shown where nothing hovers (files.css).
 */
export const FileGrid = memo(function FileGrid(props: FileGridProps) {
  const {files, mode, selectedId, onSelect} = props;
  const list = useRef<HTMLUListElement>(null);
  const focusIndex = Math.max(0, files.findIndex(file => file.id === selectedId));

  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if ((event.target as HTMLElement).closest('input')) return;
    if (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      props.onSelectAll();
      return;
    }
    if (event.key === 'Escape' && props.selectedIds.length) {
      event.preventDefault();
      props.onClearSelection();
      return;
    }
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-file-link]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    // Columns: how many items share the first row's top.
    const top = items[0]?.getBoundingClientRect().top;
    const columns = mode === 'list' ? 1 : Math.max(1, items.filter(item => Math.abs(item.getBoundingClientRect().top - top) < 2).length);
    const targets: Record<string, number> = {ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: items.length - 1};
    if (!(event.key in targets)) return;
    if (mode === 'list' && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) return;
    event.preventDefault();
    const next = Math.min(items.length - 1, Math.max(0, targets[event.key]));
    items[next].focus();
    onSelect(files[next].id);
  };

  return (
    <ul ref={list} className={`dz-files is-${mode}`} aria-label="Files" onKeyDown={move}>
      {mode === 'list' && (
        <li className="dz-files-head" aria-hidden="true">
          {([['name', 'Name'], ['updated', props.trash ? 'Deleted' : 'Modified'], ['created', 'Created']] as const).map(([value, label]) => (
            <span key={value} className={`dz-files-head-cell ${props.sort === value ? 'is-sorted' : ''}`.trim()} onClick={() => props.onSort?.(value)}>{label}</span>
          ))}
        </li>
      )}
      {files.map((file, index) => <FileItem key={file.id} file={file} index={index} focusable={index === focusIndex} {...props} />)}
    </ul>
  );
});

type ItemProps = FileGridProps & {file: DesignFileSummary; index: number; focusable: boolean};

function FileItem({file, focusable, mode, trash, selectedIds, touchSelecting, onSelect, onDragFiles, onDragEnd, starred, onStar, onOpen, onMenu, renamingId, onRenameStart, onRename, onRenameEnd, onTrash, now, describe}: ItemProps) {
  const selected = selectedIds.includes(file.id);
  const renaming = renamingId === file.id;
  const own = describe?.(file) ?? null;
  const subtitle = own ? own.text : trash && file.trashedAt ? trashedAgo(file.trashedAt, now) : editedAgo(file.updatedAt, now);
  const pointer = useRef('mouse');
  const press = useLongPress(element => {
    onSelect(file.id);
    onMenu(file, {element, keyboard: false});
  });
  const keyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(file, event.metaKey || event.ctrlKey);
    } else if (event.key === 'F2' && !trash) {
      event.preventDefault();
      onRenameStart(file);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && !trash) {
      event.preventDefault();
      onTrash(file);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      onMenu(file, {element: event.currentTarget, keyboard: true});
    }
  };
  return (
    <li className={`dz-file ${selected ? 'is-selected' : ''} ${renaming ? 'is-renaming' : ''}`.trim()} data-file-id={file.id}
      draggable={!!onDragFiles && !renaming}
      onDragStart={event => {
        const ids = onDragFiles?.(file) ?? [];
        if (!ids.length) return event.preventDefault();
        if (!selected) onSelect(file.id);
        // Moved onto a place, linked into "Favorites" (Starred.tsx).
        event.dataTransfer.effectAllowed = 'linkMove';
        event.dataTransfer.setData(FILES_DRAG_TYPE, JSON.stringify(ids));
      }}
      onDragEnd={() => onDragEnd?.()}
      onContextMenu={event => {
        if (press.consumed()) return event.preventDefault();
        // A right click inside the selection acts on all of it; outside, on this file alone.
        if (!selected) onSelect(file.id);
        onMenu(file, event);
      }}>
      <a href={designHref(file.id)} data-file-link="" className="dz-file-hit" tabIndex={focusable ? 0 : -1} draggable={false}
        aria-label={`${file.name}${file.kind === 'board' ? `, ${BOARD_NAMES.one}` : ''}, ${subtitle}${file.unreadComments ? `, unread comments: ${file.unreadComments}` : ''}`} aria-current={selected || undefined}
        {...press.handlers}
        onPointerDown={event => {
          pointer.current = event.pointerType;
          press.handlers.onPointerDown(event);
        }}
        onClick={event => {
          event.preventDefault();
          if (press.consumed()) return;
          if (event.metaKey || event.ctrlKey) onSelect(file.id, 'toggle');
          else if (event.shiftKey) onSelect(file.id, 'range');
          else if (pointer.current !== 'touch') onSelect(file.id);
          else if (touchSelecting) onSelect(file.id, 'toggle');
          else if (trash) {
            onSelect(file.id);
            onMenu(file, {element: event.currentTarget, keyboard: false});
          } else onOpen(file);
        }}
        onDoubleClick={() => {
          // Two quick taps while choosing files are two choices, not an open.
          if (touchSelecting && pointer.current === 'touch') return;
          onOpen(file);
        }}
        onFocus={event => {
          // The keyboard's Tab selects the file it lands on; a click selects in onClick, with its modifiers.
          if (!selected && event.currentTarget.matches(':focus-visible')) onSelect(file.id);
        }}
        onKeyDown={keyDown} />
      <Thumbnail url={file.thumbnailUrl} unread={trash ? 0 : file.unreadComments ?? 0} board={file.kind === 'board'} />
      {mode === 'grid' && !trash && onStar && (() => {
        const on = !!starred?.(file.id);
        return (
          <IconButton className={`dz-file-star ${on ? 'is-on' : ''}`.trim()} label={on ? 'Remove from favorites' : 'Add to favorites'} tooltip={false}
            aria-pressed={on} onClick={() => onStar(file, !on)}>
            <IconStar fill={on ? 'currentColor' : 'none'} />
          </IconButton>
        );
      })()}
      <div className="dz-file-meta">
        {/* Figma's card: the file's kind as a small coloured mark beside its name (grid only; the list's picture says it). */}
        {mode === 'grid' && <span className={`dz-file-mark ${file.kind === 'board' ? 'is-board' : ''}`.trim()} aria-hidden="true">{file.kind === 'board' ? <IconBoard size={14} /> : <IconFrame size={14} />}</span>}
        {renaming ? (
          <RenameField name={file.name} onDone={name => (name ? onRename(file, name) : onRenameEnd())} />
        ) : (
          <span className="dz-file-name" title={file.name}>{file.name}</span>
        )}
        <span className="dz-file-time">{mode === 'list' && !own ? relativeTime(trash && file.trashedAt ? file.trashedAt : file.updatedAt, now) : subtitle}</span>
        {mode === 'list' && <span className="dz-file-time">{shortDate(file.createdAt, now)}</span>}
      </div>
      <IconButton className="dz-file-more" label="File actions" tooltip={false}
        onClick={event => {
          if (!selected) onSelect(file.id);
          onMenu(file, {element: event.currentTarget, keyboard: event.detail === 0});
        }}>
        <IconMore />
      </IconButton>
    </li>
  );
}

/** Marks a picture painted. One already in the cache is marked before the first paint, so it shows at once; one that
 *  arrives later fades in (files.css). */
const markLoaded = (img: HTMLImageElement | null) => {
  if (img?.complete && img.naturalWidth) img.dataset.loaded = '';
};

/** The card's picture, with the count of unread comments in its corner (docs/design-tool.md §Teams "Comments"). A board's card
 *  carries the board's mark (docs/board.md). */
function Thumbnail({url, unread, board}: {url: string | null; unread: number; board: boolean}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`dz-file-thumb ${board ? 'is-board' : ''}`.trim()} aria-hidden="true">
      {url && !failed
        ? <img ref={markLoaded} src={url} alt="" loading="lazy" decoding="async" draggable={false} onLoad={event => {event.currentTarget.dataset.loaded = '';}} onError={() => setFailed(true)} />
        : <span className="dz-file-thumb-empty">{board ? <IconBoard size={20} /> : <IconFrame size={20} />}</span>}
      {board && <span className="dz-file-kind"><IconBoard size={12} /><span>{BOARD_NAMES.product}</span></span>}
      {unread > 0 && <span className="dz-file-unread"><IconComment size={12} /><span>{unread > 99 ? '99+' : unread}</span></span>}
    </div>
  );
}

function RenameField({name, onDone}: {name: string; onDone: (name: string | null) => void}) {
  const [draft, setDraft] = useState(name);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const next = value?.trim().replace(/\s+/g, ' ');
    onDone(next && next !== name ? next.slice(0, 200) : null);
  };
  return (
    <TextInput className="dz-file-rename" value={draft} onChange={setDraft} onCommit={finish} onCancel={() => finish(null)} onBlur={event => finish(event.currentTarget.value)}
      autoFocus selectOnFocus maxLength={200} aria-label="New file name" />
  );
}
