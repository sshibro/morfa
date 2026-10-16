import '../styles/actions.css';
import {Fragment, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import type {Style} from '../../../shared/design/types';
import {applyStyle, styleDisplayName} from '../../../shared/design/styles';
import {getCommand, isEnabled, type CommandContext} from '../engine/commands';
import {useDesignStore} from '../engine/useDesignStore';
import {userUpdate} from '../engine/user-edit';
import {LibraryAssets} from '../libraries/host';
import {ComponentsSection, StylePreview} from '../panels/left/AssetsPanel';
import {foldText} from '../panels/left/layer-rows';
import {IconButton} from '../ui/Button';
import {IconActions, IconSearch} from '../ui/icons';
import {Portal} from '../ui/layer';
import {PanelSection} from '../ui/PanelSection';
import {formatShortcut} from '../ui/shortcuts';
import {actionSections} from './actions-model';
import {commandAvailable, listedCommands, paletteEntries, runSafely, type PaletteEntry} from './command-bridge';
import {getPreferences, rememberCommand} from './preferences';
import {useEditorServices} from './services';

// "Actions" (⌘K; ⌘/ and ⌘P too), Figma's Actions menu: one search over every command and tool (by name or keyword),
// recent ones first while it is empty, and the file's and its libraries' components and styles under
// "Assets". It stands over the toolbar, as wide as the bar, and grows out of its button when that opened it (150 ms, ease-out); from
// the keyboard it is there at once (emil-design-eng: a palette opened dozens of times a day never animates from a shortcut).

type Tab = 'all' | 'assets';
const TABS: readonly {id: Tab; label: string}[] = [{id: 'all', label: 'All'}, {id: 'assets', label: 'Assets'}];

/** The toolbar's "Actions" button: the menu's trigger, lit while it is open. */
export function ActionsButton({open, onToggle}: {open: boolean; onToggle: () => void}) {
  return (
    <IconButton size={32} tone="toolbar" label="Actions" shortcut="Mod+KeyK" tooltip={open ? false : {placement: 'top'}}
      className="dz-actions-button" aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
      <IconActions size={24} strokeWidth={1} />
    </IconButton>
  );
}

/** `height` is fixed, so the search field stays where it is while the results change under it. */
type Placement = {left: number; width: number; bottom: number | null; top: number | null; height: number; origin: string};

/** Over the toolbar, its width (at least 480 px), its left edge; centred near the top when the toolbar is hidden (⌘\). */
function placement(): Placement {
  const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
  const bar = document.querySelector<HTMLElement>('.dz-editor .dz-toolbar');
  const rect = bar?.getBoundingClientRect();
  if (!rect || !rect.width) {
    const width = Math.min(560, viewportWidth - 32);
    return {left: (viewportWidth - width) / 2, width, top: 64, bottom: null, height: Math.min(480, viewportHeight - 96), origin: 'top center'};
  }
  const width = Math.min(Math.max(rect.width, 480), viewportWidth - 32);
  const left = Math.min(Math.max(16, rect.left), viewportWidth - 16 - width);
  const bottom = viewportHeight - rect.top + 8;
  const button = bar!.querySelector<HTMLElement>('.dz-actions-button')?.getBoundingClientRect();
  const origin = button ? `${Math.round(button.left + button.width / 2 - left)}px calc(100% + ${Math.round(button.top + button.height / 2 - rect.top + 8)}px)` : 'bottom center';
  return {left, width, top: null, bottom, height: Math.min(480, rect.top - 8 - 16), origin};
}

/** `listed`: which commands the menu offers (a board passes its own list, docs/board.md §Chrome); all of them by default. */
export function ActionsMenu({context, onClose, onError, listed}: {context: () => CommandContext; onClose: () => void; onError: (error: unknown) => void; listed?: (id: string) => boolean}) {
  const id = useId();
  const services = useEditorServices();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const assets = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [place] = useState(placement);

  // Read once per opening: what is registered and what can run now does not change while it is open.
  const [commands] = useState<PaletteEntry[]>(() => paletteEntries(listedCommands().filter(command => command.id !== 'app.quick-actions' && (!listed || listed(command.id)))));
  const [state] = useState(() => {
    const ctx = context();
    const runnable = new Map<string, boolean>();
    for (const entry of commands) {
      const command = getCommand(entry.id);
      runnable.set(entry.id, !!command && commandAvailable(entry.id) && isEnabled(command, ctx));
    }
    return {runnable, recent: getPreferences().recentCommands};
  });
  const canRun = useCallback((entryId: string) => !!state.runnable.get(entryId), [state.runnable]);
  const sections = useMemo(() => actionSections(commands, query, state.recent, canRun), [commands, query, state.recent, canRun]);
  const rows = useMemo(() => sections.flatMap(section => section.entries), [sections]);

  useLayoutEffect(() => {
    input.current?.focus({preventScroll: true});
  }, []);
  // The first row that can run, so Enter does something.
  const firstRunnable = Math.max(0, rows.findIndex(entry => canRun(entry.id)));
  useEffect(() => setActive(firstRunnable), [query, tab, firstRunnable]);
  // The arrows keep the active row in view; the row chosen on opening leaves the list at its top.
  const stepped = useRef(false);
  useEffect(() => {
    if (!stepped.current) return;
    stepped.current = false;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block: 'nearest'});
  }, [active]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The toolbar's button toggles the menu itself; menus and popovers it opened are its own.
      if (box.current?.contains(target) || target?.closest?.('.dz-actions-button, [data-dz-menu], .dz-asset-ghost')) return;
      onClose();
    };
    const blur = () => onClose();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', blur);
    };
  }, [onClose]);

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry || !canRun(entry.id)) return;
    onClose();
    rememberCommand(entry.id);
    const command = getCommand(entry.id);
    if (command) runSafely(command, context(), onError);
  };

  const move = (step: number) => {
    if (!rows.length) return;
    stepped.current = true;
    setActive(index => (index + step + rows.length) % rows.length);
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    input.current?.focus({preventScroll: true});
  };
  /** The asset rows and tiles the arrows walk through, in reading order. */
  const assetTargets = () => [...(assets.current?.querySelectorAll<HTMLElement>('.dz-asset-item, .dz-style-row[tabindex="0"]') ?? [])];

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Tab') switchTab(tab === 'all' ? 'assets' : 'all');
    else if (event.key === 'Escape') onClose();
    else if (tab === 'assets') {
      if (event.key !== 'ArrowDown') return;
      assetTargets()[0]?.focus({preventScroll: false});
    } else if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'PageDown') move(8);
    else if (event.key === 'PageUp') move(-8);
    else if (event.key === 'Enter') run(rows[active]);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  // In "Assets": arrows step through the tiles and rows, Enter (the tile's own) places, Tab goes back to "All", Escape closes.
  const onAssetsKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('input, textarea')) return;
    const targets = assetTargets();
    const at = targets.indexOf(event.target as HTMLElement);
    if (event.key === 'Escape') onClose();
    else if (event.key === 'Tab') switchTab('all');
    else if (at >= 0 && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) targets[Math.min(targets.length - 1, at + 1)]?.focus();
    else if (at >= 0 && (event.key === 'ArrowUp' || event.key === 'ArrowLeft')) {
      if (at === 0) input.current?.focus({preventScroll: true});
      else targets[at - 1]?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  // A placed asset closes the menu (a click places it at the view's centre, a drag where it is dropped); while one is dragged
  // the menu steps aside so the canvas under it shows.
  const press = useRef<{x: number; y: number} | null>(null);
  const onAssetsPointerDown = (event: ReactPointerEvent) => {
    press.current = (event.target as Element).closest('.dz-asset-item') && event.button === 0 ? {x: event.clientX, y: event.clientY} : null;
  };
  const onAssetsPointerMove = (event: ReactPointerEvent) => {
    if (!press.current || dragging || !event.buttons) return;
    if (Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) >= 4) setDragging(true);
  };
  const onAssetsPointerUp = () => {
    const placed = !!press.current;
    press.current = null;
    setDragging(false);
    // The tile's own handler ran first (it holds the pointer); the instance is in the file now.
    if (placed) onClose();
  };

  let index = 0;
  const style = {left: place.left, width: place.width, height: place.height, ...(place.bottom !== null ? {bottom: place.bottom} : {top: place.top ?? 64}), '--dz-origin': place.origin} as unknown as CSSProperties;
  return (
    <Portal>
      <div ref={box} className={`dz-actions ${dragging ? 'is-dragging' : ''}`.trim()} role="dialog" aria-label="Actions" style={style}>
        <label className="dz-actions-search">
          <IconSearch />
          <input ref={input} value={query} placeholder={tab === 'all' ? 'Search actions' : 'Search assets'} spellCheck={false} autoComplete="off"
            role="combobox" aria-expanded="true" aria-controls={tab === 'all' ? id + '-list' : id + '-assets'} aria-autocomplete="list"
            aria-activedescendant={tab === 'all' && rows.length ? `${id}-${active}` : undefined}
            onChange={event => setQuery(event.currentTarget.value)} onKeyDown={onSearchKey} />
        </label>
        <div className="dz-actions-tabs" role="tablist" aria-label="Sections">
          {(listed ? TABS.slice(0, 1) : TABS).map(each => (
            <button key={each.id} type="button" role="tab" id={`${id}-tab-${each.id}`} aria-selected={tab === each.id} tabIndex={-1}
              aria-controls={each.id === 'all' ? id + '-list' : id + '-assets'} className="dz-actions-tab" onClick={() => switchTab(each.id)}>
              {each.label}
            </button>
          ))}
        </div>
        {tab === 'all' ? (
          <div ref={list} id={id + '-list'} className="dz-actions-list" role="listbox" aria-labelledby={`${id}-tab-all`}>
            {!rows.length && <p className="dz-actions-empty">Nothing found</p>}
            {sections.map(section => (
              <Fragment key={section.id}>
                {section.title && (
                  <div className="dz-actions-heading" role="presentation">
                    <span>{section.title}</span>
                  </div>
                )}
                {section.entries.map(entry => {
                  const at = index++;
                  const usable = canRun(entry.id);
                  const unavailable = !commandAvailable(entry.id);
                  return (
                    <div key={`${section.id}:${entry.id}`} id={`${id}-${at}`} data-index={at} data-action={entry.id} role="option" aria-selected={at === active} aria-disabled={!usable || undefined}
                      className={`dz-actions-item ${at === active ? 'is-active' : ''}`.trim()}
                      onPointerMove={() => {
                        if (active !== at) setActive(at);
                      }}
                      onClick={() => run(entry)}>
                      <span className="dz-actions-label">{entry.label}</span>
                      {unavailable ? <span className="dz-actions-note is-off">Not available yet</span>
                        : entry.shortcut && <span className="dz-actions-shortcut">{formatShortcut(entry.shortcut)}</span>}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        ) : (
          <div ref={assets} id={id + '-assets'} className="dz-actions-assets dz-assets" role="tabpanel" aria-labelledby={`${id}-tab-assets`}
            onKeyDown={onAssetsKey} onPointerDown={onAssetsPointerDown} onPointerMove={onAssetsPointerMove} onPointerUp={onAssetsPointerUp} onPointerCancel={() => {
              press.current = null;
              setDragging(false);
            }}>
            <ComponentsSection query={query} view="grid" />
            <LocalStyles query={query} onApplied={onClose} />
            <Suspense fallback={null}><LibraryAssets query={query} view="grid" /></Suspense>
          </div>
        )}
      </div>
    </Portal>
  );
}

/** The file's own styles: a click applies one to the selection, as a library's style does ("Assets" of the left panel edits them). */
function LocalStyles({query, onApplied}: {query: string; onApplied: () => void}) {
  const services = useEditorServices();
  const {store} = services;
  const styles = useDesignStore(state => state.doc.styles, Object.is, {store, slice: 'doc'});
  const needle = foldText(query.trim());
  const shown = Object.values(styles).filter(style => !style.remote && (!needle || foldText(style.name).includes(needle)));
  if (!shown.length) return null;
  const apply = (style: Style) => {
    const ids = store.getState().selection;
    if (!ids.length) {
      services.toast('Select layers to apply the style.');
      return;
    }
    store.transact('Apply style', tx => {
      for (const [nodeId, patch] of applyStyle(tx.doc, ids, style.id)) userUpdate(tx, nodeId, patch);
    });
    onApplied();
  };
  return (
    <PanelSection title="Styles" collapsible className="dz-assets-section">
      <div className="dz-assets-body">
        <div className="dz-asset-list" style={{'--dz-depth': 0} as CSSProperties}>
          {shown.map(style => (
            <div key={style.id} role="button" tabIndex={0} className="dz-style-row" title={style.description || undefined} data-style-id={style.id}
              onClick={() => apply(style)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                apply(style);
              }}>
              <StylePreview style={style} />
              <span className="dz-asset-name">{styleDisplayName(style)}</span>
            </div>
          ))}
        </div>
      </div>
    </PanelSection>
  );
}
