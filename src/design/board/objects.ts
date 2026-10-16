import type {NodeId, Vec} from '../../../shared/design/types';
import {worldBox, type Rect} from '../../../shared/design/geometry';
import {boardObjectOf, isVotable} from '../../../shared/design/board/model';
import type {SpatialIndex} from '../../../shared/design/tree';
import {HIT_TOLERANCE_PX, pickAt} from '../engine/hit-test';
import {currentViewport, type DesignStore} from '../engine/store';
import {pageToScreen} from '../engine/viewport';
import type {BoardBadge, BoardClick, BoardObjectsApi} from './meeting';

// The board-objects API the meeting module builds on (docs/board.md §Meeting slot): which object is under a point, where it is,
// what can be voted on, badges drawn over the canvas, and clicks offered to the meeting first. One per open board.

export type BoardObjects = BoardObjectsApi & {
  /** Badges of every source, for the badge layer. */
  badges(): ReadonlyMap<string, readonly BoardBadge[]>;
  subscribeBadges(listener: () => void): () => void;
  /** The canvas host calls this for a primary press; true: a handler took it. */
  offerClick(event: PointerEvent): boolean;
};

export type BoardObjectsDeps = {
  store: DesignStore;
  /** The canvas element (client px ↔ canvas px). */
  host: () => HTMLElement | null;
  index: () => SpatialIndex | null;
};

export function createBoardObjects({store, host, index}: BoardObjectsDeps): BoardObjects {
  const badgeSources = new Map<string, readonly BoardBadge[]>();
  const badgeListeners = new Set<() => void>();
  const interceptors: ((click: BoardClick) => boolean)[] = [];

  const objectAtPage = (point: Vec): NodeId | null => {
    const state = store.getState();
    const tolerance = HIT_TOLERANCE_PX / currentViewport(state).zoom;
    const picked = pickAt(state.doc, state.pageId, point, {tolerance, index: index()});
    if (!picked) return null;
    const get = (id: NodeId | null | undefined) => (id ? state.doc.nodes[id] : undefined);
    const object = boardObjectOf(get, picked) ?? get(picked);
    if (!object || object.type === 'SECTION' || object.type === 'PAGE') return null;
    return object.id;
  };
  const toPage = (clientX: number, clientY: number): Vec | null => {
    const element = host();
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left || clientY < rect.top || clientX > rect.right || clientY > rect.bottom) return null;
    const viewport = currentViewport(store.getState());
    return {x: viewport.x + (clientX - rect.left) / viewport.zoom, y: viewport.y + (clientY - rect.top) / viewport.zoom};
  };

  return {
    objectAtPage,
    objectAtClient(clientX, clientY) {
      const page = toPage(clientX, clientY);
      return page ? objectAtPage(page) : null;
    },
    objectBounds(id, space = 'page') {
      const state = store.getState();
      const node = state.doc.nodes[id];
      if (!node) return null;
      let up = node;
      while (up.parentId && state.doc.nodes[up.parentId]) up = state.doc.nodes[up.parentId];
      if (up.id !== state.pageId) return null;
      const box = worldBox(state.doc, id);
      if (space === 'page') return box;
      const element = host();
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const viewport = currentViewport(state);
      const a = pageToScreen(viewport, {x: box.x, y: box.y});
      return {x: rect.left + a.x, y: rect.top + a.y, width: box.width * viewport.zoom, height: box.height * viewport.zoom} satisfies Rect;
    },
    votableObjects() {
      const {doc, pageId} = store.getState();
      const out: NodeId[] = [];
      const visit = (id: NodeId) => {
        for (const childId of doc.nodes[id]?.children ?? []) {
          const child = doc.nodes[childId];
          if (!child?.visible) continue;
          if (child.type === 'SECTION') visit(childId);
          else if (isVotable(child)) out.push(childId);
        }
      };
      visit(pageId);
      return out;
    },
    setBadges(source, badges) {
      if (badges.length) badgeSources.set(source, [...badges]);
      else badgeSources.delete(source);
      for (const listener of [...badgeListeners]) listener();
    },
    interceptClicks(handler) {
      interceptors.push(handler);
      return () => {
        const at = interceptors.indexOf(handler);
        if (at >= 0) interceptors.splice(at, 1);
      };
    },
    pageId: () => store.getState().pageId,
    onPageChange(listener) {
      let page = store.getState().pageId;
      return store.subscribe(() => {
        const next = store.getState().pageId;
        if (next === page) return;
        page = next;
        listener(next);
      }, {slice: 'page'});
    },
    badges: () => badgeSources,
    subscribeBadges(listener) {
      badgeListeners.add(listener);
      return () => badgeListeners.delete(listener);
    },
    offerClick(event) {
      if (!interceptors.length || event.button !== 0) return false;
      const page = toPage(event.clientX, event.clientY);
      if (!page) return false;
      const click: BoardClick = {
        id: objectAtPage(page), page, clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, altKey: event.altKey,
        mod: /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey,
      };
      for (let i = interceptors.length - 1; i >= 0; i--) if (interceptors[i](click)) return true;
      return false;
    },
  };
}
