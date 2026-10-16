import type {NodeId} from '../../../shared/design/types';
import {DESIGN_LIVE, type DesignViewportPresence} from '../../../shared/design/live';
import {currentViewport, type DesignStore} from '../engine/store';
import {clampZoom} from '../engine/viewport';
import type {Viewport} from '../engine/contracts';
import type {CanvasController} from '../editor/CanvasView';
import type {LocalPresence, PeerStore} from './presence';

// What ties presence to the editor: this editor's pointer, page, selection, viewport and text editing go out (throttled
// in presence.ts), and "follow" makes this viewport follow someone else's until the designer moves it (Figma's rule).

type Canvas = () => CanvasController | null;

/** This editor's presence follows its store and the pointer over the canvas host. */
export function publishPresence(options: {store: DesignStore; presence: LocalPresence; host: () => HTMLElement | null; canvas: Canvas}): () => void {
  const {store, presence, canvas} = options;
  const offs: (() => void)[] = [];
  const viewportNow = (): DesignViewportPresence | null => {
    const view = canvas()?.view;
    if (!view) return null;
    const size = view.size();
    if (!size.width || !size.height) return null;
    const viewport = currentViewport(store.getState());
    return {x: viewport.x, y: viewport.y, zoom: viewport.zoom, width: size.width, height: size.height};
  };
  const selectionOf = (ids: readonly NodeId[]) => ({selection: ids.slice(0, DESIGN_LIVE.maxSelection), selectionCount: ids.length});
  const state = store.getState();
  presence.set({page: state.pageId, ...selectionOf(state.selection), editing: state.editing?.kind === 'text' ? state.editing.id : null, viewport: viewportNow()});
  offs.push(store.select(next => next.pageId, page => presence.set({page, viewport: viewportNow()}), {slice: 'page'}));
  offs.push(store.select(next => next.selection, ids => presence.set(selectionOf(ids)), {slice: 'selection'}));
  offs.push(store.select(next => (next.editing?.kind === 'text' ? next.editing.id : null), editing => presence.set({editing}), {slice: 'editing'}));
  offs.push(store.subscribe(() => presence.set({viewport: viewportNow()}), {slice: 'viewport'}));
  // The canvas's size changes with the window and the panels.
  const resize = () => presence.set({viewport: viewportNow()});
  window.addEventListener('resize', resize);
  offs.push(() => window.removeEventListener('resize', resize));

  // The pointer: page coordinates under it while it is over the canvas.
  let element: HTMLElement | null = null;
  const move = (event: PointerEvent) => {
    const view = canvas()?.view;
    if (!view || !element) return;
    const rect = element.getBoundingClientRect();
    const point = view.screenToPage({x: event.clientX - rect.left, y: event.clientY - rect.top});
    presence.set({cursor: {x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100}});
  };
  const leave = () => presence.set({cursor: null});
  const hidden = () => {
    if (document.visibilityState === 'hidden') presence.set({cursor: null});
  };
  const attach = () => {
    const next = options.host();
    if (next === element) return;
    element?.removeEventListener('pointermove', move);
    element?.removeEventListener('pointerleave', leave);
    element = next;
    element?.addEventListener('pointermove', move, {passive: true});
    element?.addEventListener('pointerleave', leave, {passive: true});
  };
  attach();
  // The host mounts with the canvas, a moment after the editor.
  const retry = window.setInterval(() => {
    attach();
    if (element) window.clearInterval(retry);
  }, 250);
  document.addEventListener('visibilitychange', hidden);
  offs.push(() => {
    window.clearInterval(retry);
    element?.removeEventListener('pointermove', move);
    element?.removeEventListener('pointerleave', leave);
    document.removeEventListener('visibilitychange', hidden);
  });
  return () => {
    for (const off of offs) off();
  };
}

/** The viewport that shows what `theirs` shows, fitted to a canvas of `size`, centred on the same point. */
export function followedViewport(theirs: DesignViewportPresence, size: {width: number; height: number}): Viewport {
  const shownWidth = theirs.width / theirs.zoom, shownHeight = theirs.height / theirs.zoom;
  const zoom = clampZoom(Math.min(size.width / shownWidth, size.height / shownHeight));
  const centre = {x: theirs.x + shownWidth / 2, y: theirs.y + shownHeight / 2};
  return {x: centre.x - size.width / 2 / zoom, y: centre.y - size.height / 2 / zoom, zoom};
}

/**
 * "Follow": while a peer is followed, this editor shows their page and what their viewport shows. Panning, zooming or
 * switching the page here stops it, as does Escape, the peer leaving, or the stream closing.
 */
export function followPeers(options: {store: DesignStore; peers: PeerStore; canvas: Canvas}): () => void {
  const {store, peers, canvas} = options;
  let applying = false;
  const apply = () => {
    const following = peers.following();
    if (!following) return;
    const peer = peers.peers().get(following);
    if (!peer) return;
    applying = true;
    try {
      if (peer.page && peer.page !== store.getState().pageId && store.getState().doc.nodes[peer.page]?.type === 'PAGE') store.setPage(peer.page);
      const size = canvas()?.view.size();
      if (peer.viewport && size?.width && size.height) store.setViewport(followedViewport(peer.viewport, size));
    } finally {
      applying = false;
    }
  };
  const offMotion = peers.subscribeMotion(apply);
  const offFollow = peers.subscribeFollowing(apply);
  // The designer's own move ends it.
  const offView = store.subscribe(() => {
    if (!applying && peers.following()) peers.follow(null);
  }, {slice: ['viewport', 'page']});
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && peers.following()) peers.follow(null);
  };
  window.addEventListener('keydown', escape);
  return () => {
    offMotion();
    offFollow();
    offView();
    window.removeEventListener('keydown', escape);
  };
}
