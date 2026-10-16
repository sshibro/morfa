import '../styles/find.css';
import {lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode} from 'react';
import {worldBox} from '../../../shared/design/geometry';
import {uploadDesignImage} from '../api';
import {
  FindSession, findBar, MAX_MATCHES, registerFindCommands, replaceAllIn, replaceMatch, type FindBarState, type FindMatch, type FindOptions,
} from '../engine/commands/find';
import {connectHelp, GUIDE_DIALOG, registerHelpCommands} from '../engine/commands/help';
import {connectLinks, registerLinkCommands, selectNode} from '../engine/commands/link';
import {registerPasteReplaceCommands} from '../engine/commands/paste-replace';
import {registerPropertyCommands} from '../engine/commands/properties';
import {connectRasterize, registerRasterizeCommands} from '../engine/commands/rasterize';
import {currentViewport, type DesignStore} from '../engine/store';
import {fitRect, FIT_PADDING} from '../engine/viewport';
import {Button, IconButton} from '../ui/Button';
import {IconArrowDown, IconArrowUp, IconChevronDown, IconChevronRight, IconClose, IconMatchCase, IconSearch, IconWholeWord, layerIcon} from '../ui/icons';
import {useMenuTrigger} from '../ui/Menu';
import type {MenuItem} from '../ui/menu-model';
import {TextInput} from '../ui/TextInput';
import {registerEditorDialog, useEditorServices, type EditorServices} from './services';

// "Find and replace" (⌘F) as a compact bar over the canvas, and the host of the menu commands that
// came with it: "Copy/Paste properties", "Paste over selection", "Rasterize selection",
// "Copy link to selection", "Guide", "Contact support". DesignEditor imports this module
// (the commands register) and mounts <FindReplace /> in the canvas overlay, where it connects the open
// file's services to those commands and renders the bar while it is open.
//
// The bar: what to find, a count, ↑/↓ (⇧Enter/Enter) through the matches — each jump selects the layer,
// switches its page and brings it into view —, "Replace" / "Replace all" for text (one undo step),
// "Match case" and "Match whole word", where to look (this page or all, text and/or names). Esc
// closes it. It appears without animation: it opens from the keyboard, many times a day.

registerFindCommands();
registerPropertyCommands();
registerPasteReplaceCommands();
registerRasterizeCommands();
registerLinkCommands();
registerHelpCommands();
// "Guide" loads with its first opening (its text stays out of the editor's chunk).
const GuideDialog = lazy(() => import('./GuideDialog'));
registerEditorDialog(GUIDE_DIALOG, ({params, onClose}) => <Suspense fallback={null}><GuideDialog params={params} onClose={onClose} /></Suspense>);

export const FindReplace = memo(function FindReplace() {
  const services = useEditorServices();
  const {store, fileId, fonts, images, toast, openDialog} = services;
  useEffect(() => {
    const off = [
      connectRasterize(store, {fonts, images, upload: (image, name) => uploadDesignImage(fileId, image, name)}),
      connectLinks(store, {fileId, toast}),
      connectHelp(store, {openDialog}),
    ];
    return () => off.forEach(fn => fn());
  }, [store, fileId, fonts, images, toast, openDialog]);
  const bar = findBar(store);
  const state = useSyncExternalStore(bar.subscribe, bar.get);
  if (!state.open) return null;
  return <FindBarView store={store} state={state} services={services} />;
});

// ── The bar ──────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const count = (n: number) => n.toLocaleString('en-US');

/** The current match's layer stays readable: a layer smaller than this on screen gets zoomed to. */
const MIN_ON_SCREEN = 8;

function FindBarView({store, state, services}: {store: DesignStore; state: FindBarState; services: EditorServices}) {
  const bar = findBar(store);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  /** Selects the match's layer, switches to its page and brings it into view. */
  const land = useCallback((match: FindMatch) => {
    if (!selectNode(store, match.id)) return;
    services.revealNodes([match.id]);
    const view = services.canvas?.()?.view;
    const {doc} = store.getState();
    if (!view || !doc.nodes[match.id]) return;
    const box = worldBox(doc, match.id), size = view.size(), viewport = currentViewport(store.getState());
    if (size.width && size.height && Math.min(box.width || Infinity, box.height || Infinity) * viewport.zoom < MIN_ON_SCREEN) store.setViewport(fitRect(size, box, FIT_PADDING, 1));
  }, [store, services]);
  const landRef = useRef(land);
  landRef.current = land;

  const [session] = useState(() => new FindSession(store, {onLand: match => landRef.current(match)}));
  useEffect(() => () => session.dispose(), [session]);
  const snap = useSyncExternalStore(session.subscribe, session.snapshot);

  // Search as the query or the options change; again (keeping the place) after edits and page switches.
  useEffect(() => session.run(state.query, state.options), [session, state.query, state.options]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = store.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => session.refresh(), 120);
    }, {slice: ['doc', 'page']});
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [store, session]);

  // ⌘F (again) puts the caret in the field with the query selected.
  useLayoutEffect(() => {
    findInput.current?.focus({preventScroll: true});
    findInput.current?.select();
  }, [state.focus]);

  const close = useCallback(() => {
    if (root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    bar.set({open: false});
  }, [bar]);

  const go = useCallback((delta: 1 | -1) => {
    const match = session.go(delta);
    if (match) land(match);
  }, [session, land]);

  const setOptions = (partial: Partial<FindOptions>) => bar.set({options: {...state.options, ...partial}});

  const replaceOne = () => {
    const {query, replacement, options} = bar.get();
    const current = session.currentMatch();
    if (!current || current.field !== 'text') {
      // Nothing to replace here yet: go to the next text match first, as editors do.
      const from = snap.current;
      for (let step = 1; step <= snap.matches.length; step++) {
        const index = (Math.max(from, -1) + step) % snap.matches.length;
        if (snap.matches[index].field !== 'text') continue;
        const match = session.select(index);
        if (match) land(match);
        return;
      }
      return;
    }
    let replaced = false;
    store.transact('Replace text', tx => {
      replaced = replaceMatch(tx, current, query, replacement, options);
    });
    if (replaced) session.landAt(snap.current);
    else session.refresh();
  };

  const replaceAll = () => {
    const {query, replacement, options} = bar.get();
    let result = {occurrences: 0, layers: 0};
    store.transact('Replace all', tx => {
      result = replaceAllIn(tx, store.getState().pageId, query, replacement, options);
    });
    session.refresh();
    // The buttons go disabled with nothing left: keep the keyboard in the bar.
    replaceInput.current?.focus({preventScroll: true});
    if (!result.occurrences) services.toast('Nothing to replace: no matches in text.');
    else services.toast(`Replaced ${count(result.occurrences)} ${plural(result.occurrences, 'match', 'matches')} in ${count(result.layers)} ${plural(result.layers, 'layer', 'layers')}`, 'success');
  };

  const scope = useMenuTrigger({
    label: 'Search in',
    minWidth: 200,
    items: () => {
      const options = bar.get().options;
      const items: MenuItem[] = [
        {type: 'label', label: 'Search in'},
        {id: 'find.scope-page', label: 'On this page', radio: true, checked: options.scope === 'page', onSelect: () => setOptions({scope: 'page'})},
        {id: 'find.scope-all', label: 'On all pages', radio: true, checked: options.scope === 'all', onSelect: () => setOptions({scope: 'all'})},
        {type: 'separator'},
        {type: 'label', label: 'Search for'},
        {id: 'find.in-text', label: 'Text in layers', checked: options.text, disabled: options.text && !options.names, onSelect: () => setOptions({text: !options.text})},
        {id: 'find.in-names', label: 'Layer names', checked: options.names, disabled: options.names && !options.text, onSelect: () => setOptions({names: !options.names})},
      ];
      return items;
    },
  });

  // Keys inside the bar stay in it (Enter on a button must not also open the selected text on the
  // canvas); ⌘-combinations pass, so undo and the menus keep working.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (mod && event.code === 'KeyF') {
      event.preventDefault();
      event.stopPropagation();
      findInput.current?.focus();
      findInput.current?.select();
      return;
    }
    if (event.altKey && !mod && (event.code === 'KeyC' || event.code === 'KeyW')) {
      event.preventDefault();
      if (event.code === 'KeyC') setOptions({caseSensitive: !state.options.caseSensitive});
      else setOptions({wholeWord: !state.options.wholeWord});
    }
    if (!mod) event.stopPropagation();
  };

  const query = state.query;
  // Big files: pages the store does not hold are not searched until they are loaded.
  const unloaded = useSyncExternalStore(
    useCallback((notify: () => void) => store.subscribe(notify, {slice: ['pages', 'doc']}), [store]),
    () => {
      const {pages, doc} = store.getState();
      return pages ? doc.pages.filter(id => !pages.loaded.has(id)).length : 0;
    },
  );
  const [loadingAll, setLoadingAll] = useState(false);
  const total = snap.total;
  const shownTotal = total > MAX_MATCHES ? `${count(MAX_MATCHES)}+` : count(total);
  const status = !query ? '' : !snap.done && !total ? 'Searching…' : !total ? 'No matches' : snap.current >= 0 ? `${count(snap.current + 1)} of ${shownTotal}` : `Found: ${shownTotal}`;
  const canStep = snap.matches.length > 0;
  const canReplace = !!query && snap.textMatches > 0 && state.options.text;
  const current = snap.current >= 0 ? snap.matches[snap.current] : null;

  return (
    <div ref={root} className={`dz-find ${state.showReplace ? 'has-replace' : ''}`.trim()} role="search" aria-label="Find and replace" onKeyDown={onKeyDown}>
      <div className="dz-find-row">
        <IconButton label={state.showReplace ? 'Hide replace' : 'Show replace'} className="dz-find-toggle" aria-expanded={state.showReplace}
          onClick={() => bar.set({showReplace: !state.showReplace})}>
          {state.showReplace ? <IconChevronDown /> : <IconChevronRight />}
        </IconButton>
        <TextInput className="dz-find-field" inputRef={findInput} value={query} onChange={value => bar.set({query: value})} icon={<IconSearch />}
          placeholder="Find" aria-label="Find" aria-describedby={status ? 'dz-find-status' : undefined}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          }}
          end={status ? <span id="dz-find-status" className={`dz-find-count ${!total && snap.done ? 'is-none' : ''}`.trim()} aria-live="polite">{status}</span> : undefined} />
        <IconButton label="Match case" shortcut="Alt+KeyC" pressed={state.options.caseSensitive} onClick={() => setOptions({caseSensitive: !state.options.caseSensitive})}><IconMatchCase /></IconButton>
        <IconButton label="Match whole word" shortcut="Alt+KeyW" pressed={state.options.wholeWord} onClick={() => setOptions({wholeWord: !state.options.wholeWord})}><IconWholeWord /></IconButton>
        <span className="dz-find-divider" aria-hidden="true" />
        <IconButton label="Previous match" shortcut="Shift+Enter" disabled={!canStep} onClick={() => go(-1)}><IconArrowUp /></IconButton>
        <IconButton label="Next match" shortcut="Enter" disabled={!canStep} onClick={() => go(1)}><IconArrowDown /></IconButton>
        <IconButton label="Close" shortcut="Escape" onClick={close}><IconClose /></IconButton>
      </div>
      {state.showReplace && (
        <div className="dz-find-row">
          <span className="dz-find-gutter" aria-hidden="true" />
          <TextInput className="dz-find-field" inputRef={replaceInput} value={state.replacement} onChange={value => bar.set({replacement: value})}
            placeholder="Replace with" aria-label="Replace with"
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || !canReplace) return;
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) replaceAll();
              else replaceOne();
            }} />
          <Button className="dz-find-action" disabled={!canReplace} onClick={replaceOne}>Replace</Button>
          <Button className="dz-find-action" disabled={!canReplace} onClick={replaceAll}>Replace all</Button>
        </div>
      )}
      {unloaded > 0 && (
        <div className="dz-find-row is-status">
          <span className="dz-find-gutter" aria-hidden="true" />
          <span className="dz-find-note">Pages not loaded: {count(unloaded)}. Search covers the loaded ones.</span>
          <Button className="dz-find-action" disabled={loadingAll} onClick={() => {
            setLoadingAll(true);
            setOptions({scope: 'all'});
            void store.ensureAllPages().finally(() => setLoadingAll(false));
          }}>Search all pages</Button>
        </div>
      )}
      <div className="dz-find-row is-status">
        <button type="button" className="dz-find-scope" {...scope.triggerProps}>
          {state.options.scope === 'page' ? 'On this page' : 'On all pages'}
          {!state.options.text ? ' · names' : !state.options.names ? ' · text' : ''}
          <IconChevronDown />
        </button>
        {current && <MatchPreview store={store} match={current} onClick={() => land(current)} />}
      </div>
      {scope.element}
    </div>
  );
}

/** The current match: the layer's icon and name, and for text the words around the match. */
function MatchPreview({store, match, onClick}: {store: DesignStore; match: FindMatch; onClick: () => void}) {
  const node = store.getState().doc.nodes[match.id];
  if (!node) return null;
  const Icon = layerIcon(node.type, {mask: node.isMask, image: node.fills.some(fill => fill.type === 'IMAGE'), layout: node.autoLayout?.layoutMode});
  let body: ReactNode;
  if (match.field === 'text' && node.text) {
    const chars = node.text.characters.replace(/[\n\u2028]/g, ' ');
    const from = Math.max(0, match.start - 16), to = Math.min(chars.length, match.end + 40);
    body = (
      <span className="dz-find-snippet">
        {from > 0 && '…'}{chars.slice(from, match.start)}<mark>{chars.slice(match.start, match.end)}</mark>{chars.slice(match.end, to)}{to < chars.length && '…'}
      </span>
    );
  } else {
    body = <span className="dz-find-snippet"><mark>{node.name}</mark></span>;
  }
  return (
    <button type="button" className="dz-find-preview" onClick={onClick} title={match.field === 'name' ? 'Layer name' : node.name}>
      <Icon />
      {match.field === 'text' ? body : <>{body}<span className="dz-find-kind">layer name</span></>}
    </button>
  );
}
