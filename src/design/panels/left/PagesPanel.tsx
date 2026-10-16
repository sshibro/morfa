import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent} from 'react';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {useDesignStore} from '../../engine/useDesignStore';
import {useEditorServices} from '../../editor/services';
import {Button, IconButton} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {IconCheck, IconChevronDown, IconChevronRight, IconPlus} from '../../ui/icons';
import {useContextMenu} from '../../ui/Menu';
import {TextInput} from '../../ui/TextInput';
import {formatShortcut} from '../../ui/shortcuts';
import {canCopyLinks, copyPageLink} from '../../engine/commands/link';
import {addPage, duplicatePage, isPageDivider, movePage} from './page-actions';
import '../../styles/panel-left.css';

// "Pages": the file's pages in order, the current one marked. "+" adds "Page N" and names it
// in place; a double click renames; the menu duplicates or deletes (never the last page, and a page
// with layers only after confirming); dragging reorders; an empty page named "-…" is a divider (PageEntry). The divider under the list sets how much of
// the panel the pages take (remembered per browser). The chevron before the title folds the list away, as Figma UI3's
// Pages section does; folded, the header names the current page (also remembered per browser).

export const PAGES_HEIGHT_KEY = 'morfa-design-pages-height';
export const PAGES_FOLDED_KEY = 'morfa-design-pages-folded';

function readFolded(): boolean {
  try {
    return localStorage.getItem(PAGES_FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean) {
  try {
    if (folded) localStorage.setItem(PAGES_FOLDED_KEY, '1');
    else localStorage.removeItem(PAGES_FOLDED_KEY);
  } catch {
    // Not remembered: private mode or blocked storage.
  }
}
const ROW = 32;
const HEADER = 40;
const MIN_HEIGHT = HEADER;
const DEFAULT_ROWS_SHOWN = 4.5;

/** `divider`: an empty page whose name starts with "-" is drawn as a line between groups of pages, as Figma's page
 *  dividers; it is not opened by a click or the arrows, and is renamed, moved and deleted like a page. */
type PageEntry = {id: NodeId; name: string; divider: boolean};

const samePages = (a: PageEntry[], b: PageEntry[]) => a.length === b.length && a.every((page, i) => page.id === b[i].id && page.name === b[i].name && page.divider === b[i].divider);
const pagesOf = (doc: DesignDocument): PageEntry[] => doc.pages.map(id => {
  const name = doc.nodes[id]?.name ?? 'Page';
  return {id, name, divider: isPageDivider(name, doc.nodes[id]?.children?.length === 0)};
});

function readHeight(): number | null {
  try {
    const stored = Number(localStorage.getItem(PAGES_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : null;
  } catch {
    return null;
  }
}

function storeHeight(height: number) {
  try {
    localStorage.setItem(PAGES_HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // Storage blocked: the height holds for this visit.
  }
}

export const PagesPanel = memo(function PagesPanel() {
  const {store, toast} = useEditorServices();
  const pages = useDesignStore(state => pagesOf(state.doc), samePages, {store, slice: 'doc'});
  const current = useDesignStore(state => state.pageId, Object.is, {store, slice: 'page'});
  // Big files: the pages whose layers are being fetched (a switch waits for them).
  const loading = useDesignStore(state => state.pages?.loading ?? null, Object.is, {store, slice: 'pages'});
  const [height, setHeight] = useState<number | null>(readHeight);
  const [folded, setFolded] = useState(readFolded);
  const [renaming, setRenaming] = useState<NodeId | null>(null);
  const [confirm, setConfirm] = useState<PageEntry | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [dragging, setDragging] = useState<NodeId | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const press = useRef<{id: NodeId; x: number; y: number; pointerId: number; dragging: boolean} | null>(null);

  const rename = useCallback((id: NodeId, value: string | null) => {
    setRenaming(null);
    const name = value?.trim();
    const page = store.getState().doc.nodes[id];
    if (page && name && name !== page.name) store.transact('Rename page', tx => tx.update(id, {name}));
  }, [store]);

  const remove = useCallback((page: PageEntry, confirmed = false) => {
    const doc = store.getState().doc;
    if (doc.pages.length <= 1) return;
    if (!confirmed && doc.nodes[page.id]?.children?.length) {
      setConfirm(page);
      return;
    }
    // Big files: a page's layers go with it in one change, so the store must hold them first.
    void store.ensurePage(page.id).then(() => {
      if (!store.getState().doc.nodes[page.id]) return;
      store.transact('Delete page', tx => tx.removePage(page.id));
      toast(`Page "${page.name}" deleted. Undo: ${formatShortcut('Mod+KeyZ')}`);
    });
  }, [store, toast]);

  const openMenu = (event: ReactMouseEvent, page: PageEntry) => {
    const last = store.getState().doc.pages.length <= 1;
    menu.open(event, [
      {id: 'page.rename', label: 'Rename', onSelect: () => setRenaming(page.id)},
      {id: 'page.duplicate', label: 'Duplicate page', onSelect: () => duplicatePage(store, page.id)},
      {id: 'page.copy-link', label: 'Copy link to page', disabled: !canCopyLinks(store), onSelect: () => void copyPageLink(store, page.id)},
      {type: 'separator'},
      {id: 'page.delete', label: 'Delete page', danger: true, disabled: last, description: last ? 'The file must keep at least one page' : undefined, onSelect: () => remove(page)},
    ]);
  };

  // ── Reordering by drag ──
  const boundaryAt = useCallback((clientY: number) => {
    const element = list.current;
    if (!element) return 0;
    const y = clientY - element.getBoundingClientRect().top + element.scrollTop;
    return Math.max(0, Math.min(store.getState().doc.pages.length, Math.round(y / ROW)));
  }, [store]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const state = press.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (!state.dragging && Math.abs(event.clientY - state.y) < 4) return;
      if (!state.dragging) {
        state.dragging = true;
        setDragging(state.id);
      }
      const from = store.getState().doc.pages.indexOf(state.id);
      const boundary = boundaryAt(event.clientY);
      setDrop(boundary === from || boundary === from + 1 ? null : boundary);
    };
    const up = (event: PointerEvent) => {
      const state = press.current;
      if (!state || state.pointerId !== event.pointerId) return;
      press.current = null;
      if (!state.dragging) return;
      setDragging(null);
      setDrop(null);
      movePage(store, state.id, boundaryAt(event.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [store, boundaryAt]);

  // ── The divider ──
  const resize = useRef<{id: number; startY: number; startHeight: number; height: number} | null>(null);
  const maxHeight = () => Math.max(MIN_HEIGHT, (root.current?.parentElement?.parentElement?.clientHeight ?? 600) - 120);
  const clampHeight = (value: number) => Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, value)));
  const naturalHeight = () => HEADER + Math.min(pages.length, DEFAULT_ROWS_SHOWN) * ROW + 8;
  const commitHeight = (value: number) => {
    const next = clampHeight(value);
    setHeight(next);
    storeHeight(next);
  };
  const dividerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startHeight = root.current?.getBoundingClientRect().height ?? naturalHeight();
    resize.current = {id: event.pointerId, startY: event.clientY, startHeight, height: startHeight};
    root.current?.closest('.dz')?.classList.add('dz-dragging-row');
  };
  const dividerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resize.current;
    if (!state || state.id !== event.pointerId) return;
    state.height = clampHeight(state.startHeight + event.clientY - state.startY);
    root.current?.style.setProperty('--dz-pages-h', state.height + 'px');
  };
  const dividerUp = () => {
    const state = resize.current;
    if (!state) return;
    resize.current = null;
    root.current?.closest('.dz')?.classList.remove('dz-dragging-row');
    commitHeight(state.height);
  };
  const resetHeight = () => {
    setHeight(null);
    try {
      localStorage.removeItem(PAGES_HEIGHT_KEY);
    } catch {
      // Nothing stored.
    }
  };
  /** A finger has no double click: a long press (or a right click) on the divider offers the same reset (lane PH). */
  const dividerMenu = (event: ReactMouseEvent) => {
    menu.open(event, [{id: 'pages.height-reset', label: 'Default height', disabled: height === null, onSelect: resetHeight}]);
  };
  const dividerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const now = root.current?.getBoundingClientRect().height ?? naturalHeight();
    const step = event.shiftKey ? ROW * 2 : ROW / 2;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = now - step;
    else if (event.key === 'ArrowDown') next = now + step;
    else if (event.key === 'Home') next = MIN_HEIGHT;
    else if (event.key === 'End') next = maxHeight();
    else if (event.key === 'Enter') {
      event.preventDefault();
      resetHeight();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    commitHeight(next);
  };

  return (
    <div ref={root} className={`dz-pages ${height !== null && !folded ? 'is-sized' : ''} ${folded ? 'is-folded' : ''}`.trim()}
      style={height !== null && !folded ? {'--dz-pages-h': height + 'px'} as CSSProperties : undefined}>
      <div className="dz-pages-header">
        <h3 className="dz-pages-title">
          <button type="button" className="dz-pages-fold" aria-expanded={!folded} onClick={() => {
            setFolded(!folded);
            writeFolded(!folded);
          }}>
            <span className="dz-pages-chevron" aria-hidden="true">{folded ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}</span>
            Pages
            {folded && <span className="dz-pages-current">{pages.find(page => page.id === current)?.name}</span>}
          </button>
        </h3>
        {!store.readOnly && <IconButton label="Add page" onClick={() => setRenaming(addPage(store))}><IconPlus /></IconButton>}
      </div>
      <div ref={list} className={`dz-pages-list ${dragging ? 'is-dragging' : ''}`.trim()} role="listbox" aria-label="Pages">
        {pages.map(page => {
          const selected = page.id === current;
          const divider = page.divider && renaming !== page.id;
          return (
            <div key={page.id} role="option" aria-selected={selected} tabIndex={selected ? 0 : -1}
              aria-label={divider ? `Divider "${page.name}"` : undefined} aria-disabled={divider || undefined} title={divider ? page.name : undefined}
              className={`dz-page-row ${selected ? 'is-current' : ''} ${divider ? 'is-divider' : ''} ${dragging === page.id ? 'is-dragged' : ''} ${loading?.has(page.id) ? 'is-loading' : ''}`.trim()}
              aria-busy={loading?.has(page.id) || undefined}
              onPointerDown={event => {
                if (event.button !== 0 || (event.target as Element).closest('input')) return;
                if (!page.divider) store.setPage(page.id);
                press.current = {id: page.id, x: event.clientX, y: event.clientY, pointerId: event.pointerId, dragging: false};
              }}
              onDoubleClick={event => {
                if (!(event.target as Element).closest('input')) setRenaming(page.id);
              }}
              onContextMenu={event => openMenu(event, page)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                const index = pages.findIndex(each => each.id === page.id);
                const go = (step: 1 | -1) => {
                  // Dividers are stepped over.
                  let to = index + step;
                  while (pages[to]?.divider) to += step;
                  const next = pages[to];
                  if (!next) return;
                  event.preventDefault();
                  store.setPage(next.id);
                  requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
                };
                if (event.key === 'ArrowDown') go(1);
                else if (event.key === 'ArrowUp') go(-1);
                else if (event.key === 'F2' || event.key === 'Enter') {
                  event.preventDefault();
                  setRenaming(page.id);
                }
              }}>
              <span className="dz-page-check" aria-hidden="true">{selected && <IconCheck />}</span>
              {renaming === page.id
                ? <PageName initial={page.name} onDone={value => rename(page.id, value)} />
                : divider ? <span className="dz-page-divider-line" aria-hidden="true" /> : <span className="dz-page-name">{page.name}</span>}
            </div>
          );
        })}
        {drop !== null && <div className="dz-page-drop" style={{transform: `translateY(${drop * ROW - 1}px)`}} aria-hidden="true" />}
      </div>
      <div role="separator" aria-orientation="horizontal" aria-label="Page list height" tabIndex={0} className="dz-pages-divider"
        onPointerDown={dividerDown} onPointerMove={dividerMove} onPointerUp={dividerUp} onLostPointerCapture={dividerUp} onKeyDown={dividerKey}
        onDoubleClick={resetHeight} onContextMenu={dividerMenu} />
      {menu.element}
      {confirm && (
        <Dialog title="Delete page?" onClose={() => setConfirm(null)} width={360}
          footer={<>
            <Button size={32} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button size={32} variant="danger" data-autofocus="" onClick={() => {
              const page = confirm;
              setConfirm(null);
              remove(page, true);
            }}>Delete</Button>
          </>}>
          <p>Page "{confirm.name}" has layers — they will be deleted with it. You can bring the page back with undo ({formatShortcut('Mod+KeyZ')}).</p>
        </Dialog>
      )}
    </div>
  );
});

function PageName({initial, onDone}: {initial: string; onDone: (value: string | null) => void}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  useLayoutEffect(() => {
    input.current?.focus({preventScroll: true});
    input.current?.select();
  }, []);
  return <TextInput className="dz-page-rename" value={value} onChange={setValue} inputRef={input} aria-label="Page name"
    onCommit={finish} onCancel={() => finish(null)} onBlur={event => finish(event.currentTarget.value)} />;
}
