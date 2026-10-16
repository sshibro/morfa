import '../styles/live.css';
import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties} from 'react';
import {DESIGN_LIVE_COLORS, type DesignPeer} from '../../../shared/design/live';
import {multiply, localMatrix, apply as applyMatrix} from '../../../shared/design/geometry';
import type {DesignDocument, Matrix, NodeId} from '../../../shared/design/types';
import {currentViewport, type DesignStore} from '../engine/store';
import {useDesignStore} from '../engine/useDesignStore';
import {pageToScreen} from '../engine/viewport';
import type {CanvasController} from '../editor/CanvasView';
import {useMenuTrigger, type MenuItem} from '../ui/Menu';
import {useTooltip} from '../ui/Tooltip';
import {IconClose, IconEye} from '../ui/icons';
import {POINTER_PATH} from '../ui/pointer';
import type {LiveSession} from './live-session';
import {initials, type RosterEntry} from './presence';

// The people in the file, Figma's way: their avatars in the right panel's header (a click follows them), their cursors
// with names and their selections on the canvas in their colour. Nothing here re-renders on a cursor move: the avatars
// read the roster (who, which page), the canvas layer draws on animation frames straight into the DOM.

const colorOf = (index: number) => DESIGN_LIVE_COLORS[((index % DESIGN_LIVE_COLORS.length) + DESIGN_LIVE_COLORS.length) % DESIGN_LIVE_COLORS.length];
const MAX_AVATARS = 5;

const samePages = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
};

/** The avatars in the right panel's header: up to five people, "+N" for the rest; a click follows ("follow"). */
export const PresenceAvatars = memo(function PresenceAvatars({live, store}: {live: LiveSession; store: DesignStore}) {
  const roster = useSyncExternalStore(live.peers.subscribeRoster, live.peers.roster);
  const following = useSyncExternalStore(live.peers.subscribeFollowing, live.peers.following);
  const pageId = useDesignStore(state => state.pageId, Object.is, {store, slice: 'page'});
  const pageNames = useDesignStore(state => Object.fromEntries(state.doc.pages.map(id => [id, state.doc.nodes[id]?.name ?? ''])), samePages, {store, slice: 'doc'});
  const follow = useCallback((entry: RosterEntry) => {
    const connection = entry.connections[0];
    live.peers.follow(entry.connections.includes(following ?? '') ? null : connection);
  }, [live, following]);
  const group = useRef<HTMLDivElement>(null);
  const capacity = useHeaderRoom(group, roster.length > 0);
  const shown = roster.length > capacity ? roster.slice(0, capacity - 1) : roster;
  const rest = roster.slice(shown.length);
  const items = useCallback((): MenuItem[] => [
    {type: 'label', label: 'In this file'},
    ...roster.map((entry): MenuItem => ({
      id: entry.user,
      label: entry.self ? `${entry.name} (you, another tab)` : entry.name,
      description: entry.page ? pageNames[entry.page] || undefined : undefined,
      checked: entry.connections.includes(following ?? ''),
      icon: <span className="dz-live-avatar is-small" style={{'--dz-live-color': colorOf(entry.color)} as CSSProperties} aria-hidden="true">{initials(entry.name)}</span>,
      onSelect: () => follow(entry),
    })),
  ], [roster, pageNames, following, follow]);
  const more = useMenuTrigger({items, placement: 'bottom-end', label: 'People in this file', minWidth: 220});
  if (!roster.length) return null;
  return (
    <div className="dz-live-avatars" role="group" aria-label="People in this file" ref={group}>
      {shown.map(entry => (
        <Avatar key={entry.user} entry={entry} following={entry.connections.includes(following ?? '')} elsewhere={!!entry.page && entry.page !== pageId}
          pageName={entry.page ? pageNames[entry.page] : undefined} onFollow={follow} />
      ))}
      {rest.length > 0 && (
        <button type="button" className="dz-live-avatar is-more" {...more.triggerProps} aria-label={`${rest.length} more: everyone in this file`}>+{rest.length}</button>
      )}
      {more.element}
    </div>
  );
});

/** An avatar is 24 px and the next overlaps it by 2. */
const AVATAR = 24, STEP = 22;

/**
 * How many avatars (the "+N" counted) fit in the header beside its other controls (▶, "Export"), at
 * most five and at least one, measured again when the panel is resized or a control appears.
 */
function useHeaderRoom(group: React.RefObject<HTMLDivElement | null>, mounted: boolean): number {
  const [room, setRoom] = useState(MAX_AVATARS);
  useLayoutEffect(() => {
    const element = group.current, header = element?.parentElement;
    if (!mounted || !element || !header) return;
    const measure = () => {
      const style = getComputedStyle(header);
      const gap = parseFloat(style.columnGap) || 0;
      let used = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      for (const child of header.children) if (child !== element && child instanceof HTMLElement && child.offsetParent !== null) used += child.offsetWidth + gap;
      const available = header.clientWidth - used - 2;
      setRoom(Math.max(1, Math.min(MAX_AVATARS, Math.floor((available - AVATAR) / STEP) + 1)));
    };
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      for (const child of header.children) if (child !== element) sizes.observe(child);
    };
    sizes.observe(header);
    watch();
    const children = new MutationObserver(() => {
      watch();
      measure();
    });
    children.observe(header, {childList: true});
    measure();
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, [group, mounted]);
  return room;
}

function Avatar({entry, following, elsewhere, pageName, onFollow}: {entry: RosterEntry; following: boolean; elsewhere: boolean; pageName?: string; onFollow(entry: RosterEntry): void}) {
  const who = entry.self ? `${entry.name} (you, another tab)` : entry.name;
  const where = elsewhere && pageName ? ` · ${pageName}` : '';
  const tooltip = useTooltip({label: `${who}${where}`, shortcut: undefined, placement: 'bottom'});
  return (
    <button type="button" className={`dz-live-avatar${following ? ' is-following' : ''}${elsewhere ? ' is-elsewhere' : ''}`}
      style={{'--dz-live-color': colorOf(entry.color)} as CSSProperties} aria-pressed={following}
      aria-label={`${following ? 'Stop following' : 'Follow'}: ${who}${where}`} onClick={() => onFollow(entry)} {...tooltip}>
      {initials(entry.name)}
    </button>
  );
}

// ── On the canvas ────────────────────────────────────────────────────────────────────────────────

type Drawn = {
  cursor: HTMLDivElement; label: HTMLSpanElement; outline: SVGPathElement; x: number; y: number; shown: boolean; color: string; name: string;
  /** What the outline was drawn from: it is drawn again only when these, the document or the view change. */
  ids: readonly NodeId[]; d: string; editing: boolean;
};

/** Screen-space corners of each node's box, as one path ("M…Z" per node). Rotation and nesting included. */
function outlinePath(doc: DesignDocument, ids: readonly NodeId[], toScreen: (x: number, y: number) => {x: number; y: number}): string {
  let d = '';
  const matrices = new Map<NodeId, Matrix>();
  const worldOf = (id: NodeId): Matrix | null => {
    const known = matrices.get(id);
    if (known) return known;
    const node = doc.nodes[id];
    if (!node) return null;
    if (node.type === 'PAGE' || node.parentId === null) return [[1, 0, 0], [0, 1, 0]];
    const parent = worldOf(node.parentId);
    if (!parent) return null;
    const m = multiply(parent, localMatrix(node));
    matrices.set(id, m);
    return m;
  };
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node || node.type === 'PAGE') continue;
    const m = worldOf(id);
    if (!m) continue;
    const corners = [{x: 0, y: 0}, {x: node.width, y: 0}, {x: node.width, y: node.height}, {x: 0, y: node.height}].map(point => {
      const world = applyMatrix(m, point);
      return toScreen(world.x, world.y);
    });
    d += `M${corners.map(point => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('L')}Z`;
  }
  return d;
}

const SVG = 'http://www.w3.org/2000/svg';
/** Read once per frame while cursors move: the query list is made once and its `matches` follows the setting. */
let motionQuery: MediaQueryList | null | undefined;
const reducedMotion = () => {
  if (motionQuery === undefined) motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return !!motionQuery?.matches;
};
const sameIds = (a: readonly NodeId[], b: readonly NodeId[]) => a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
const NO_IDS: readonly NodeId[] = [];
/** How quickly a drawn cursor reaches its target: about 90 % in 120 ms, so 16 updates a second glide. */
const GLIDE_MS = 52;

/**
 * Cursors, selections and the follow frame over the canvas. One animation-frame loop while something moves: each peer's
 * cursor glides toward the last position it sent (in page space, so panning here moves it with the canvas at once), and
 * selections redraw when a peer, the viewport or the document changes. Never takes a pointer event.
 */
export const CanvasPresence = memo(function CanvasPresence({live, store, canvas}: {live: LiveSession; store: DesignStore; canvas: () => CanvasController | null}) {
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const following = useSyncExternalStore(live.peers.subscribeFollowing, live.peers.following);
  const followed = following ? live.peers.peers().get(following) ?? null : null;

  useEffect(() => {
    const host = root.current, layer = svg.current;
    if (!host || !layer) return;
    const drawn = new Map<string, Drawn>();
    let frame = 0, last = 0, outlinesDirty = true;
    const make = (peer: DesignPeer): Drawn => {
      const cursor = document.createElement('div');
      cursor.className = 'dz-live-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      // "Meeting" hangs this person's cursor chat and waving hand on their cursor (src/design/meeting/overlay.ts).
      cursor.dataset.connection = peer.connection;
      const arrow = document.createElementNS(SVG, 'svg');
      arrow.setAttribute('class', 'dz-live-cursor-arrow');
      arrow.setAttribute('width', '24');
      arrow.setAttribute('height', '24');
      arrow.setAttribute('viewBox', '0 0 24 24');
      const tip = document.createElementNS(SVG, 'path');
      // Figma's collaborator cursor: the pointer without a tail, its corners rounded by the white outline; tip at (2.5, 2.5).
      tip.setAttribute('d', POINTER_PATH);
      arrow.append(tip);
      cursor.append(arrow);
      const label = document.createElement('span');
      label.className = 'dz-live-cursor-label';
      cursor.append(label);
      host.append(cursor);
      const outline = document.createElementNS(SVG, 'path');
      outline.setAttribute('class', 'dz-live-outline');
      layer.append(outline);
      return {cursor, label, outline, x: peer.cursor?.x ?? 0, y: peer.cursor?.y ?? 0, shown: false, color: '', name: '', ids: NO_IDS, d: '', editing: false};
    };
    const remove = (id: string) => {
      const item = drawn.get(id);
      if (!item) return;
      item.cursor.remove();
      item.outline.remove();
      drawn.delete(id);
    };
    const draw = (time: number) => {
      frame = 0;
      const dt = last ? Math.min(100, time - last) : 16;
      last = time;
      const state = store.getState();
      const viewport = currentViewport(state);
      const toScreen = (x: number, y: number) => pageToScreen(viewport, {x, y});
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt / GLIDE_MS);
      let moving = false;
      const peers = live.peers.peers();
      for (const id of [...drawn.keys()]) if (!peers.has(id)) remove(id);
      for (const peer of peers.values()) {
        const item = drawn.get(peer.connection) ?? (drawn.set(peer.connection, make(peer)), drawn.get(peer.connection)!);
        const color = colorOf(peer.color);
        if (item.color !== color) {
          item.color = color;
          item.cursor.style.setProperty('--dz-live-color', color);
          item.outline.style.setProperty('--dz-live-color', color);
        }
        if (item.name !== peer.name) {
          item.name = peer.name;
          item.label.textContent = peer.name;
        }
        const here = peer.page === state.pageId;
        const target = here && state.ui.multiplayerCursors ? peer.cursor : null;
        if (target) {
          if (!item.shown) {
            // Appearing: in place at once, no glide from where it vanished.
            item.x = target.x;
            item.y = target.y;
          } else {
            item.x += (target.x - item.x) * k;
            item.y += (target.y - item.y) * k;
            if (Math.abs(target.x - item.x) * viewport.zoom > 0.3 || Math.abs(target.y - item.y) * viewport.zoom > 0.3) moving = true;
            else {
              item.x = target.x;
              item.y = target.y;
            }
          }
          const at = toScreen(item.x, item.y);
          item.cursor.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
        }
        if (item.shown !== !!target) {
          item.shown = !!target;
          item.cursor.classList.toggle('is-shown', item.shown);
        }
        // A cursor moving changes no outline: each is drawn again when its person's selection changes, or the document or
        // this view does (outlinesDirty), and written only when its path differs.
        const ids = here ? (peer.editing && !peer.selection.includes(peer.editing) ? [...peer.selection, peer.editing] : peer.selection) : NO_IDS;
        if (outlinesDirty || !sameIds(ids, item.ids)) {
          item.ids = ids;
          const d = ids.length ? outlinePath(state.doc, ids, toScreen) : '';
          if (d !== item.d) {
            item.d = d;
            item.outline.setAttribute('d', d);
          }
        }
        const editing = !!peer.editing && here;
        if (editing !== item.editing) {
          item.editing = editing;
          item.outline.classList.toggle('is-editing', editing);
        }
      }
      outlinesDirty = false;
      if (moving) frame = requestAnimationFrame(draw);
      else last = 0;
    };
    const request = (outlines: boolean) => {
      if (outlines) outlinesDirty = true;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const offMotion = live.peers.subscribeMotion(() => request(false));
    const offStore = store.subscribe(() => request(true), {slice: ['viewport', 'page', 'doc', 'ui']});
    request(true);
    return () => {
      offMotion();
      offStore();
      cancelAnimationFrame(frame);
      for (const id of [...drawn.keys()]) remove(id);
    };
  }, [live, store, canvas]);

  const color = followed ? colorOf(followed.color) : undefined;
  const style = useMemo(() => (color ? ({'--dz-live-color': color} as CSSProperties) : undefined), [color]);
  return (
    <div className="dz-live-layer" ref={root} aria-hidden={followed ? undefined : true}>
      <svg className="dz-live-outlines" ref={svg} aria-hidden="true" />
      {followed && (
        <div className="dz-live-follow" style={style}>
          <div className="dz-live-follow-pill" role="status">
            <IconEye size={14} />
            <span>Following: {followed.name}</span>
            <button type="button" className="dz-live-follow-stop" aria-label="Stop following" onClick={() => live.peers.follow(null)}><IconClose size={12} /></button>
          </div>
        </div>
      )}
    </div>
  );
});
