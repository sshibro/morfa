import {useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent} from 'react';
import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {TYPE_NAMES} from '../../../shared/design/defaults';
import {isComponentLike} from '../../../shared/design/tree';
import {IconCheck, IconChevronRight, layerIcon} from '../ui/icons';
import {LayerRows, ROW_HEIGHT, hasChildRows} from '../panels/left/layer-rows';

// "Pages" and "Layers" of a version being previewed (VersionHistory): while a version is shown over the canvas, the
// left panel lists that version's pages, and its layers on the page the preview shows, not the current file's (as
// Figma's version view does). Read only, like the preview: a page click shows that page, containers open and close
// (⌥-click opens everything inside), nothing is selected, renamed or moved. The layers open with the containers the
// current file has open on that page.

const OVERSCAN = 6;
const PAD_TOP = 4;
const PAD_BOTTOM = 12;

const hasImage = (node: SceneNode) => node.fills.some(fill => fill.type === 'IMAGE');

export function VersionLayers({doc, pageId, expanded: initial}: {doc: DesignDocument; pageId: NodeId; expanded?: ReadonlySet<NodeId>}) {
  // The rows model of this version and page; caret clicks change it in place and bump `version`.
  const rows = useMemo(() => new LayerRows(doc, pageId, new Set(initial)), [doc, pageId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, setVersion] = useState(0);
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({start: 0, end: 40});
  const count = rows.length;

  const updateRange = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const top = Math.max(0, element.scrollTop - PAD_TOP);
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((top + element.clientHeight) / ROW_HEIGHT) + OVERSCAN);
    setRange(current => (current.start === start && current.end === end ? current : {start, end}));
  }, [rows]);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setActive(0);
    updateRange();
  }, [rows, updateRange]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateRange);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateRange]);

  const toggle = (id: NodeId, deep: boolean) => {
    if (rows.setExpanded(id, !rows.expanded.has(id), deep)) {
      setVersion(value => value + 1);
      updateRange();
    }
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const caret = (event.target as HTMLElement).closest('[data-caret]');
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!row) return;
    const index = Number(row.dataset.row);
    setActive(index);
    if (caret) toggle(rows.ids[index], event.altKey);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = rows.ids[active];
    let next = active;
    if (event.key === 'ArrowDown') next = Math.min(count - 1, active + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, active - 1);
    else if (event.key === 'ArrowRight' && id && hasChildRows(doc.nodes[id]) && !rows.expanded.has(id)) toggle(id, event.altKey);
    else if (event.key === 'ArrowLeft' && id && rows.expanded.has(id)) toggle(id, event.altKey);
    else return;
    event.preventDefault();
    if (next === active) return;
    setActive(next);
    const element = scroller.current;
    if (!element) return;
    const top = PAD_TOP + next * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top - PAD_TOP;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight + PAD_BOTTOM;
  };

  const start = Math.min(range.start, count), end = Math.min(Math.max(range.end, start), count);
  const items = [];
  for (let index = start; index < end; index++) {
    const id = rows.ids[index], depth = rows.depths[index];
    const node = doc.nodes[id];
    if (!node) continue;
    const Icon = layerIcon(node.type, {mask: node.isMask, image: hasImage(node), layout: node.autoLayout?.layoutMode});
    const container = hasChildRows(node);
    const open = rows.expanded.has(id);
    const top = depth === 0 && (node.type === 'FRAME' || node.type === 'SECTION' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET');
    const classes = ['dz-layer-row', isComponentLike(node) && 'is-component', !node.visible && 'is-hidden', top && 'is-top', index === active && 'is-active'].filter(Boolean).join(' ');
    items.push(
      <div key={id} id={`dz-version-layer-${index}`} role="treeitem" aria-level={depth + 1} aria-selected={false} aria-expanded={container ? open : undefined}
        aria-label={`${node.name}, ${TYPE_NAMES[node.type].toLowerCase()}`} className={classes} style={{'--dz-depth': depth} as CSSProperties} data-row={index}>
        <span className={`dz-layer-caret ${open ? 'is-open' : ''}`.trim()} data-caret={container ? '' : undefined} aria-hidden="true">
          {container && <IconChevronRight size={12} />}
        </span>
        <span className="dz-layer-icon" aria-hidden="true"><Icon /></span>
        <span className="dz-layer-name">{node.name}</span>
      </div>,
    );
  }

  return (
    <section className="dz-layers dz-version-layers" aria-label="Version layers">
      <div className="dz-layers-header">
        <h3 className="dz-layers-title">Layers</h3>
        <span className="dz-version-layers-note">Version</span>
      </div>
      <div ref={scroller} className="dz-version-layers-scroll" role="tree" aria-label="Version layers" aria-readonly="true" tabIndex={0}
        aria-activedescendant={active >= start && active < end ? `dz-version-layer-${active}` : undefined} onScroll={updateRange} onKeyDown={keyDown}>
        {count === 0 ? (
          <p className="dz-layers-empty">This version page is empty.</p>
        ) : (
          <div className="dz-layers-content" style={{height: PAD_TOP + count * ROW_HEIGHT + PAD_BOTTOM}} onClick={click}>
            <div className="dz-layers-window" style={{transform: `translateY(${PAD_TOP + start * ROW_HEIGHT}px)`}}>{items}</div>
          </div>
        )}
      </div>
    </section>
  );
}

/** The version's pages in place of the file's: a click (or the arrows) shows that page of the version. */
export function VersionPages({doc, current, onPick}: {doc: DesignDocument; current: NodeId; onPick: (page: NodeId) => void}) {
  const list = useRef<HTMLDivElement>(null);
  const pages = doc.pages.filter(id => doc.nodes[id]?.type === 'PAGE');
  const pick = (id: NodeId, focus = false) => {
    onPick(id);
    if (focus) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-page="${CSS.escape(id)}"]`)?.focus());
  };
  return (
    <div className="dz-pages dz-version-pages">
      <div className="dz-pages-header">
        <h3 className="dz-pages-title">Pages</h3>
        <span className="dz-version-layers-note">Version</span>
      </div>
      <div ref={list} className="dz-pages-list" role="listbox" aria-label="Version pages">
        {pages.map((id, index) => {
          const selected = id === current;
          return (
            <div key={id} role="option" aria-selected={selected} tabIndex={selected ? 0 : -1} data-page={id} className={`dz-page-row ${selected ? 'is-current' : ''}`.trim()}
              onClick={() => pick(id)}
              onKeyDown={event => {
                const to = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : -1;
                if (to < 0 || to >= pages.length) return;
                event.preventDefault();
                pick(pages[to], true);
              }}>
              <span className="dz-page-check" aria-hidden="true">{selected && <IconCheck />}</span>
              <span className="dz-page-name">{doc.nodes[id]?.name || 'Page'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
