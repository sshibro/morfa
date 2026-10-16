import {lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import type {NodeId, Style, StyleId, StyleType} from '../../../../shared/design/types';
import {groupStyles, removeStyleUpdates, styleDisplayName, type StyleGroup} from '../../../../shared/design/styles';
import {frameAtPoint} from '../../../../shared/design/tree';
import type {DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {userUpdate} from '../../engine/user-edit';
import {useEditorServices, type EditorServices} from '../../editor/services';
import {Button, IconButton} from '../../ui/Button';
import {IconBook, IconChevronRight, IconEffects, IconGrid, IconImage, IconList, IconSearch, IconVariables, IconClose} from '../../ui/icons';
import {LIBRARIES_DIALOG, LibraryAssets, useLibraryUpdateCount} from '../../libraries/host';
import {Portal} from '../../ui/layer';
import {useContextMenu} from '../../ui/Menu';
import {PanelSection} from '../../ui/PanelSection';
import {Popover} from '../../ui/Popover';
import {formatShortcut} from '../../ui/shortcuts';
import {SegmentedControl} from '../../ui/Tabs';
import {TextInput} from '../../ui/TextInput';
import {useTooltip} from '../../ui/Tooltip';
import {placeInstanceAt, showMainComponent} from './assets-actions';
import {paintBackground, textStyleSummary, variablesSummary} from './assets-model';
import {componentIndex, folderTree, type AssetFolder, type ComponentEntry, type ComponentIndex} from './component-index';
import {foldText} from './layer-rows';
import {currentIndex, pagePointAt, viewportCentre} from './panel-context';
import {StyleEditor} from './StyleEditor';
import {ThumbnailPainter} from './thumbnails';
import '../../styles/panel-left.css';

// "Assets": the file's components (by page, then by "/" folders, as thumbnails in a list or a grid),
// its styles (colour, text, effect and grid, by "/" folders) and its variables (the dialog). A click
// on a component places an instance at the centre of the view; dragging one onto the canvas places
// it where it is dropped, inside the frame under the pointer. Then one section per shared library the
// file enabled (src/design/libraries, loaded lazily), and "Libraries" (the book) beside the search.

export const ASSETS_VIEW_KEY = 'morfa-design-assets-view';
type View = 'list' | 'grid';

function readView(): View {
  try {
    return localStorage.getItem(ASSETS_VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

// The variables table (VariablesDialog.tsx, variables-table.ts) loads with its first opening: the editor's first load stays under its budget.
export const VariablesDialog = lazy(() => import('./VariablesDialog').then(module => ({default: module.VariablesDialog})));
const painters = new WeakMap<DesignStore, ThumbnailPainter>();
const painterFor = (services: EditorServices) => {
  let painter = painters.get(services.store);
  if (!painter) painters.set(services.store, (painter = new ThumbnailPainter(services)));
  return painter;
};

export const AssetsPanel = memo(function AssetsPanel() {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(readView);
  const [variables, setVariables] = useState(false);
  const changeView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(ASSETS_VIEW_KEY, next);
    } catch {
      // The choice holds for this visit.
    }
  };
  return (
    <div className="dz-assets">
      <div className="dz-assets-toolbar">
        <TextInput icon={<IconSearch />} value={query} onChange={setQuery} placeholder="Search assets" aria-label="Search assets" onCancel={() => setQuery('')}
          end={query ? <button type="button" className="dz-layers-clear" aria-label="Clear" onClick={() => setQuery('')}><IconClose size={12} /></button> : undefined} />
        <SegmentedControl aria-label="View" value={view} onChange={changeView}
          options={[{value: 'list', label: 'List', icon: <IconList />}, {value: 'grid', label: 'Grid', icon: <IconGrid />}]} />
        <LibrariesButton />
      </div>
      <ComponentsSection query={query} view={view} />
      <StylesSection query={query} />
      <VariablesSection onOpen={() => setVariables(true)} />
      <Suspense fallback={null}><LibraryAssets query={query} view={view} /></Suspense>
      {variables && <Suspense fallback={null}><VariablesDialog onClose={() => setVariables(false)} /></Suspense>}
    </div>
  );
});

/** "Libraries": the dialog that enables the team's (or the account's) libraries; a dot while updates wait. */
function LibrariesButton() {
  const {openDialog} = useEditorServices();
  const updates = useLibraryUpdateCount();
  return (
    <IconButton label={updates ? `Libraries — updates available: ${updates}` : 'Libraries'} className="dz-assets-libraries" onClick={() => openDialog(LIBRARIES_DIALOG)}>
      <IconBook />
      {updates > 0 && <span className="dz-assets-libraries-dot" aria-hidden="true" />}
    </IconButton>
  );
}

// ── Folders ────────────────────────────────────────────────────────────────────────────────────

function FolderRow({label, open, depth, onToggle, strong = false}: {label: string; open: boolean; depth: number; onToggle: () => void; strong?: boolean}) {
  return (
    <button type="button" className={`dz-asset-folder ${strong ? 'is-page' : ''}`.trim()} aria-expanded={open} style={{'--dz-depth': depth} as CSSProperties} onClick={onToggle}>
      <span className={`dz-layer-caret ${open ? 'is-open' : ''}`} aria-hidden="true"><IconChevronRight size={12} /></span>
      <span className="dz-asset-folder-name">{label}</span>
    </button>
  );
}

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }), []);
  return [collapsed, toggle] as const;
}

// ── Components ─────────────────────────────────────────────────────────────────────────────────

/** The file's components by page and folder (also "Actions" ▸ "Assets", src/design/editor/ActionsMenu.tsx). */
export function ComponentsSection({query, view}: {query: string; view: View}) {
  const services = useEditorServices();
  const {store} = services;
  const index = componentIndex(store);
  useSyncExternalStore(index.subscribe, index.getRevision, index.getRevision);
  const pageNames = useDesignStore(state => state.doc.pages.map(id => state.doc.nodes[id]?.name ?? '').join('\u0000'), Object.is, {store, slice: 'doc'});
  const pages = useDesignStore(state => state.doc.pages, Object.is, {store, slice: 'doc'});
  const [collapsed, toggle] = useCollapsed();
  const [renaming, setRenaming] = useState<NodeId | null>(null);
  const menu = useContextMenu();
  const painter = painterFor(services);

  // Pictures and fonts that finish loading redraw the thumbnails (once per burst).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => index.invalidateThumbnails(), 150);
    };
    const offImages = services.images.onChange(bump);
    const offFonts = services.fonts.onLoad(bump);
    return () => {
      offImages();
      offFonts();
      clearTimeout(timer);
    };
  }, [services, index]);

  const needle = foldText(query.trim());
  const list = index.components().filter(entry => !needle || foldText(entry.name).includes(needle));
  const names = pageNames.split('\u0000');
  const byPage = new Map<NodeId, ComponentEntry[]>();
  for (const entry of list) {
    const group = byPage.get(entry.pageId);
    if (group) group.push(entry);
    else byPage.set(entry.pageId, [entry]);
  }

  // `menu` is a new object every render; its `open` is stable, so the items (memoized) keep their props on every edit.
  const {open: openContextMenu} = menu;
  const openMenu = useCallback((event: ReactMouseEvent, entry: ComponentEntry) => {
    openContextMenu(event, [
      {id: 'asset.main', label: 'Go to main component', onSelect: () => showMainComponent(services, entry.id)},
      {id: 'asset.rename', label: 'Rename', onSelect: () => setRenaming(entry.id)},
    ]);
  }, [openContextMenu, services]);
  const rename = useCallback((id: NodeId, value: string | null) => {
    setRenaming(null);
    const name = value?.trim();
    const node = store.getState().doc.nodes[id];
    if (node && name && name !== node.name) store.transact('Rename', tx => userUpdate(tx, id, {name}));
  }, [store]);

  const renderFolder = (folder: AssetFolder<ComponentEntry>, depth: number): ReactNode => (
    <>
      {folder.folders.map(child => {
        const open = !!needle || !collapsed.has(child.key);
        return (
          <div key={child.key} className="dz-asset-group">
            <FolderRow label={child.name} open={open} depth={depth} onToggle={() => toggle(child.key)} />
            {open && renderFolder(child, depth + 1)}
          </div>
        );
      })}
      {folder.items.length > 0 && (
        <div className={view === 'grid' ? 'dz-asset-grid' : 'dz-asset-list'} style={{'--dz-depth': depth} as CSSProperties}>
          {folder.items.map(({entry, name}) => (
            <ComponentItem key={entry.id} entry={entry} name={name} view={view} index={index} painter={painter}
              renaming={renaming === entry.id} onRename={rename} onStartRename={setRenaming} onMenu={openMenu} />
          ))}
        </div>
      )}
    </>
  );

  let body: ReactNode;
  if (!index.components().length) {
    body = <p className="dz-assets-note">No components in this file yet. Select layers and press {formatShortcut('Alt+Mod+KeyK')} — the component will appear here.</p>;
  } else if (!list.length) {
    body = <p className="dz-assets-note">Nothing found.</p>;
  } else {
    body = pages.filter(pageId => byPage.has(pageId)).map(pageId => {
      const key = `page:${pageId}`;
      const open = !!needle || !collapsed.has(key);
      return (
        <div key={pageId} className="dz-asset-group">
          <FolderRow label={names[pages.indexOf(pageId)] || 'Page'} open={open} depth={0} strong onToggle={() => toggle(key)} />
          {open && renderFolder(folderTree(byPage.get(pageId)!, key), 1)}
        </div>
      );
    });
  }
  return (
    <PanelSection title="Components" collapsible className="dz-assets-section">
      <div className="dz-assets-body">{body}</div>
      {menu.element}
    </PanelSection>
  );
}

type ItemProps = {
  entry: ComponentEntry;
  name: string;
  view: View;
  index: ComponentIndex;
  painter: ThumbnailPainter;
  renaming: boolean;
  onRename: (id: NodeId, value: string | null) => void;
  onStartRename: (id: NodeId) => void;
  onMenu: (event: ReactMouseEvent, entry: ComponentEntry) => void;
};

const THUMB = {list: 24, grid: 64} as const;

const ComponentItem = memo(function ComponentItem({entry, name, view, index, painter, renaming, onRename, onStartRename, onMenu}: ItemProps) {
  const services = useEditorServices();
  const canvas = useRef<HTMLCanvasElement>(null);
  const item = useRef<HTMLDivElement>(null);
  const version = useSyncExternalStore(index.subscribe, () => index.thumbnailVersion(entry.id), () => 0);
  const [visible, setVisible] = useState(false);
  const [ghost, setGhost] = useState<{x: number; y: number} | null>(null);
  const press = useRef<{x: number; y: number; id: number; dragging: boolean} | null>(null);
  const size = THUMB[view];
  const tip = useTooltip(view === 'grid' ? {label: entry.description ? `${entry.name} — ${entry.description}` : entry.name} : entry.description ? {label: entry.description} : null);

  // Paint only while on screen.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(each => each.isIntersecting)), {rootMargin: '64px'});
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    return () => {
      if (element) painter.cancel(element);
    };
  }, [painter]);
  useLayoutEffect(() => {
    if (visible && canvas.current) painter.draw(canvas.current, entry.id, version, size, size);
  }, [visible, version, size, entry.id, painter]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    tip.onPointerDown?.(event);
    if (event.button !== 0 || renaming) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = {x: event.clientX, y: event.clientY, id: event.pointerId, dragging: false};
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = press.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.dragging && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return;
    state.dragging = true;
    setGhost({x: event.clientX, y: event.clientY});
    // The frame it would land in lights up on the canvas (the canvas's own hover outline).
    const point = pagePointAt(services, event.clientX, event.clientY, item.current);
    const {doc, pageId} = services.store.getState();
    services.store.setHover(point ? frameAtPoint(doc, pageId, point, new Set(), currentIndex(services)) : null);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = press.current;
    if (!state || state.id !== event.pointerId) return;
    press.current = null;
    setGhost(null);
    if (state.dragging) services.store.setHover(null);
    if (!state.dragging) {
      placeInstanceAt(services, entry.id, viewportCentre(services, item.current));
      return;
    }
    const point = pagePointAt(services, event.clientX, event.clientY, item.current);
    if (point) placeInstanceAt(services, entry.id, point);
  };
  const cancel = () => {
    if (press.current?.dragging) services.store.setHover(null);
    press.current = null;
    setGhost(null);
  };

  return (
    <div ref={item} className={`dz-asset-item is-${view} ${ghost ? 'is-dragging' : ''}`.trim()} role="button" tabIndex={0}
      aria-label={view === 'grid' ? entry.name : undefined} data-asset-id={entry.id}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel} onLostPointerCapture={() => press.current?.dragging || cancel()}
      onContextMenu={event => onMenu(event, entry)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          placeInstanceAt(services, entry.id, viewportCentre(services, item.current));
        } else if (event.key === 'F2') {
          event.preventDefault();
          onStartRename(entry.id);
        }
      }}
      onPointerEnter={tip.onPointerEnter} onPointerLeave={tip.onPointerLeave} onFocus={tip.onFocus} onBlur={tip.onBlur}>
      <span className="dz-asset-thumb" style={{width: size, height: size}}>
        <canvas ref={canvas} style={{width: size, height: size}} aria-hidden="true" />
      </span>
      {view === 'list' && (renaming
        ? <InlineName initial={entry.name} onDone={value => onRename(entry.id, value)} />
        : <span className="dz-asset-name">{name}</span>)}
      {view === 'grid' && renaming && item.current && (
        <Popover anchor={item.current} onClose={() => onRename(entry.id, null)} aria-label="Rename component" placement="bottom">
          <div className="dz-asset-rename-popover"><InlineName initial={entry.name} onDone={value => onRename(entry.id, value)} /></div>
        </Popover>
      )}
      {ghost && <DragGhost source={canvas.current} x={ghost.x} y={ghost.y} />}
    </div>
  );
});

/** What follows the pointer while a component is dragged onto the canvas. */
function DragGhost({source, x, y}: {source: HTMLCanvasElement | null; x: number; y: number}) {
  const copy = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const target = copy.current;
    if (!target || !source) return;
    target.width = source.width;
    target.height = source.height;
    target.getContext('2d')?.drawImage(source, 0, 0);
  }, [source]);
  const size = 64;
  return (
    <Portal>
      <div className="dz-asset-ghost" style={{transform: `translate(${x - size / 2}px, ${y - size / 2}px)`}} aria-hidden="true">
        <canvas ref={copy} style={{width: size, height: size}} />
      </div>
    </Portal>
  );
}

function InlineName({initial, onDone}: {initial: string; onDone: (value: string | null) => void}) {
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
  return <TextInput className="dz-asset-rename" value={value} onChange={setValue} inputRef={input} aria-label="Name"
    onCommit={finish} onCancel={() => finish(null)} onBlur={event => finish(event.currentTarget.value)}
    onPointerDown={event => event.stopPropagation()} />;
}

// ── Styles ─────────────────────────────────────────────────────────────────────────────────────

const STYLE_SECTIONS: readonly {type: StyleType; label: string}[] = [
  {type: 'FILL', label: 'Colors'},
  {type: 'TEXT', label: 'Text'},
  {type: 'EFFECT', label: 'Effects'},
  {type: 'GRID', label: 'Grids'},
];

export function StylePreview({style}: {style: Style}) {
  if (style.type === 'FILL') {
    const background = paintBackground(style.paints);
    if (!background) return <span className="dz-style-icon" aria-hidden="true"><IconImage /></span>;
    return <span className="dz-style-chip" style={{'--dz-paint': background} as CSSProperties} aria-hidden="true" />;
  }
  if (style.type === 'TEXT') {
    const text = style.text;
    return <span className="dz-style-text" aria-hidden="true" style={{fontWeight: Math.min(700, Math.max(400, text?.fontWeight ?? 400)), fontStyle: text?.italic ? 'italic' : undefined}}>Ag</span>;
  }
  return <span className="dz-style-icon" aria-hidden="true">{style.type === 'EFFECT' ? <IconEffects /> : <IconGrid />}</span>;
}

export function deleteStyle(store: DesignStore, id: StyleId) {
  const {doc} = store.getState();
  if (!doc.styles[id]) return;
  const updates = removeStyleUpdates(doc, id);
  store.transact('Delete style', tx => {
    tx.removeStyle(id);
    for (const [nodeId, patch] of updates) tx.update(nodeId, patch);
  });
}

function StylesSection({query}: {query: string}) {
  const services = useEditorServices();
  const {store} = services;
  const styles = useDesignStore(state => state.doc.styles, Object.is, {store, slice: 'doc'});
  const [collapsed, toggle] = useCollapsed();
  const [editing, setEditing] = useState<{id: StyleId; anchor: Element} | null>(null);
  const [renaming, setRenaming] = useState<StyleId | null>(null);
  const menu = useContextMenu();
  const needle = foldText(query.trim());
  useEffect(() => setEditing(null), [needle]);
  // A shared library's styles are listed under their library.
  const all = Object.values(styles).filter(style => !style.remote);
  const shown = all.filter(style => !needle || foldText(style.name).includes(needle));

  const rename = (id: StyleId, value: string | null) => {
    setRenaming(null);
    const style = store.getState().doc.styles[id];
    const name = value?.trim();
    if (style && name && name !== style.name) store.transact('Rename style', tx => tx.setStyle({...style, name}));
  };
  const openMenu = (event: ReactMouseEvent, style: Style) => {
    const anchor = event.currentTarget as Element;
    menu.open(event, [
      {id: 'style.edit', label: 'Edit', onSelect: () => setEditing({id: style.id, anchor})},
      {id: 'style.rename', label: 'Rename', onSelect: () => setRenaming(style.id)},
      {type: 'separator'},
      {id: 'style.delete', label: 'Delete', danger: true, onSelect: () => deleteStyle(store, style.id)},
    ]);
  };

  const renderGroup = (group: StyleGroup, depth: number, prefix: string): ReactNode => (
    <>
      {group.groups.map(child => {
        const key = `${prefix}/${child.path}`;
        const open = !!needle || !collapsed.has(key);
        return (
          <div key={key} className="dz-asset-group">
            <FolderRow label={child.name} open={open} depth={depth} onToggle={() => toggle(key)} />
            {open && renderGroup(child, depth + 1, prefix)}
          </div>
        );
      })}
      {group.styles.length > 0 && (
        <div className="dz-asset-list" style={{'--dz-depth': depth} as CSSProperties}>
          {group.styles.map(style => (
            <div key={style.id} role="button" tabIndex={0} className={`dz-style-row ${editing?.id === style.id ? 'is-open' : ''}`.trim()}
              title={style.description || undefined}
              onClick={event => {
                if (renaming !== style.id) setEditing({id: style.id, anchor: event.currentTarget});
              }}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setEditing({id: style.id, anchor: event.currentTarget});
                } else if (event.key === 'F2') {
                  event.preventDefault();
                  setRenaming(style.id);
                }
              }}
              onContextMenu={event => openMenu(event, style)}>
              <StylePreview style={style} />
              {renaming === style.id
                ? <InlineName initial={style.name} onDone={value => rename(style.id, value)} />
                : <>
                  <span className="dz-asset-name">{styleDisplayName(style)}</span>
                  {style.type === 'TEXT' && <span className="dz-style-meta">{textStyleSummary(style)}</span>}
                </>}
            </div>
          ))}
        </div>
      )}
    </>
  );

  let body: ReactNode;
  if (!all.length) body = <p className="dz-assets-note">No styles in this file yet.</p>;
  else if (!shown.length) body = <p className="dz-assets-note">Nothing found.</p>;
  else body = STYLE_SECTIONS.map(section => {
    const ofType = shown.filter(style => style.type === section.type);
    if (!ofType.length) return null;
    const key = `type:${section.type}`;
    const open = !!needle || !collapsed.has(key);
    return (
      <div key={section.type} className="dz-asset-group">
        <FolderRow label={section.label} open={open} depth={0} strong onToggle={() => toggle(key)} />
        {open && renderGroup(groupStyles(ofType), 1, key)}
      </div>
    );
  });

  const editingStyle = editing ? styles[editing.id] : undefined;
  return (
    <PanelSection title="Styles" collapsible className="dz-assets-section">
      <div className="dz-assets-body">{body}</div>
      {menu.element}
      {editing && editingStyle && <StyleEditor style={editingStyle} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </PanelSection>
  );
}

// ── Variables ──────────────────────────────────────────────────────────────────────────────────

function VariablesSection({onOpen}: {onOpen: () => void}) {
  const {store} = useEditorServices();
  const summary = useDesignStore(state => variablesSummary(state.doc), Object.is, {store, slice: 'doc'});
  return (
    <PanelSection title="Variables" className="dz-assets-section">
      <p className="dz-assets-note is-tight">{summary}</p>
      <Button icon={<IconVariables />} onClick={onOpen} className="dz-assets-open">Open variables</Button>
    </PanelSection>
  );
}
