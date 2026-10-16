import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {LayoutMode, NodeId, NodeType} from '../../../../shared/design/types';
import type {CommandContext} from '../../engine/commands/registry';
import {useDesignStore} from '../../engine/useDesignStore';
import {useEditorServices} from '../../editor/services';
import {IconButton} from '../../ui/Button';
import {IconClose, IconCollapseAll, IconSearch, layerIcon} from '../../ui/icons';
import {TextInput} from '../../ui/TextInput';
import {LayersTree} from './LayersTree';
import {LAYER_KINDS, layerPath, searchLayers, type LayerKind} from './layer-rows';
import {selectFromPanel} from './panel-context';
import {layerTreeState} from './tree-state';
import '../../styles/panel-left.css';

// The "Layers" part of the left panel: a title row with search and "Collapse all layers", then either the
// tree or, while searching, the matching layers with the path to each.

export type LayersPanelProps = {
  /** The canvas controller's command context, for the row menu (a panel context otherwise). */
  commandContext?: () => CommandContext;
};

export const LayersPanel = memo(function LayersPanel({commandContext}: LayersPanelProps) {
  const {store} = useEditorServices();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<LayerKind>>(() => new Set());
  const field = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    setSearching(false);
    setQuery('');
    setKinds(new Set());
  }, []);
  useLayoutEffect(() => {
    if (searching) field.current?.focus();
  }, [searching]);
  const filtering = searching && (query.trim() !== '' || kinds.size > 0);

  return (
    <section className="dz-layers" aria-label="Layers">
      <div className="dz-layers-header">
        <h3 className="dz-layers-title">Layers</h3>
        <IconButton label="Find layer" pressed={searching} onClick={() => (searching ? close() : setSearching(true))}><IconSearch /></IconButton>
        <IconButton label="Collapse all layers" shortcut="Alt+KeyL" onClick={() => layerTreeState(store).collapseAll()}><IconCollapseAll /></IconButton>
      </div>
      {searching && (
        <div className="dz-layers-search">
          <TextInput icon={<IconSearch />} value={query} onChange={setQuery} inputRef={field} placeholder="Layer name" aria-label="Find layer"
            onCancel={close}
            end={query ? <button type="button" className="dz-layers-clear" aria-label="Clear" onClick={() => setQuery('')}><IconClose size={12} /></button> : undefined} />
          <div className="dz-layers-kinds" role="group" aria-label="Layer type">
            {LAYER_KINDS.map(kind => (
              <button key={kind.id} type="button" className="dz-chip" aria-pressed={kinds.has(kind.id)}
                onClick={() => setKinds(current => {
                  const next = new Set(current);
                  if (next.has(kind.id)) next.delete(kind.id);
                  else next.add(kind.id);
                  return next;
                })}>
                {kind.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {filtering ? <SearchResults query={query} kinds={kinds} /> : <LayersTree commandContext={commandContext} />}
    </section>
  );
});

const RESULT_HEIGHT = 40;

/** Matching layers of the page, virtualized like the tree; refreshed as the document changes (not during a drag). */
function SearchResults({query, kinds}: {query: string; kinds: ReadonlySet<LayerKind>}) {
  const services = useEditorServices();
  const {store} = services;
  const [results, setResults] = useState<NodeId[]>(() => {
    const {doc, pageId} = store.getState();
    return searchLayers(doc, pageId, query, kinds);
  });
  useEffect(() => {
    const run = () => {
      const {doc, pageId} = store.getState();
      setResults(searchLayers(doc, pageId, query, kinds));
    };
    run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = store.subscribe(() => {
      if (store.getState().live.size) return;
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    }, {slice: ['doc', 'page', 'live']});
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [store, query, kinds]);

  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({start: 0, end: 30});
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const start = Math.max(0, Math.floor(element.scrollTop / RESULT_HEIGHT) - 6);
    const end = Math.ceil((element.scrollTop + element.clientHeight) / RESULT_HEIGHT) + 6;
    setRange(current => (current.start === start && current.end === end ? current : {start, end}));
  }, []);
  useLayoutEffect(measure, [measure, results]);

  const selection = useDesignStore(state => state.selection, Object.is, {store, slice: 'selection'});
  const hoverId = useDesignStore(state => state.hoverId, Object.is, {store, slice: 'hover'});
  const shown = results.slice(range.start, Math.min(range.end, results.length));

  if (!results.length) return <p className="dz-layers-empty">Nothing found.</p>;
  return (
    <div ref={scroller} className="dz-layers-scroll" onScroll={measure} role="listbox" aria-label="Found layers" onPointerLeave={() => store.setHover(null)}>
      <div className="dz-layers-content" style={{height: results.length * RESULT_HEIGHT + 8}}>
        <div className="dz-layers-window" style={{transform: `translateY(${range.start * RESULT_HEIGHT}px)`}}>
          {shown.map(id => <SearchRow key={id} id={id} selected={selection.includes(id)} hovered={hoverId === id}
            onSelect={() => selectFromPanel(services, [id], id)} onReveal={() => services.revealNodes([id])} onHover={() => store.setHover(id)} />)}
        </div>
      </div>
    </div>
  );
}

const SearchRow = memo(function SearchRow({id, selected, hovered, onSelect, onReveal, onHover}: {id: NodeId; selected: boolean; hovered: boolean; onSelect: () => void; onReveal: () => void; onHover: () => void}) {
  const {store} = useEditorServices();
  const info = useDesignStore(state => {
    const node = state.doc.nodes[id];
    if (!node) return '';
    const path = layerPath(state.doc, id) || (state.doc.nodes[state.pageId]?.name ?? '');
    const image = node.fills.some(fill => fill.type === 'IMAGE') ? 1 : 0;
    return `${node.type}\u0000${node.name}\u0000${path}\u0000${node.isMask ? 1 : 0}\u0000${node.autoLayout?.layoutMode ?? ''}\u0000${image}`;
  }, Object.is, {store, slice: 'doc'});
  if (!info) return null;
  const [type, name, path, mask, layout, image] = info.split('\u0000');
  const Icon = layerIcon(type as NodeType, {mask: mask === '1', image: image === '1', layout: (layout || undefined) as LayoutMode | undefined});
  const component = type === 'COMPONENT' || type === 'COMPONENT_SET' || type === 'INSTANCE';
  return (
    <div role="option" aria-selected={selected} className={`dz-layer-result ${selected ? 'is-selected' : ''} ${hovered ? 'is-hovered' : ''} ${component ? 'is-component' : ''}`.trim()}
      onPointerDown={event => event.button === 0 && onSelect()} onDoubleClick={onReveal} onPointerEnter={onHover}>
      <span className="dz-layer-icon" aria-hidden="true"><Icon /></span>
      <span className="dz-layer-result-text">
        <span className="dz-layer-name">{name}</span>
        <span className="dz-layer-path">{path}</span>
      </span>
    </div>
  );
});
