import type {DesignDocument, NodeId, Vec} from '../../../shared/design/types';
import {unionRects, worldBox, type Rect} from '../../../shared/design/geometry';
import {ZOOM_MAX, ZOOM_MIN, type Viewport} from './contracts';

// The camera of the canvas. A viewport is the page point at the canvas's top-left corner plus a
// zoom: screen = (page − {x, y}) · zoom, in CSS px. Everything here is pure so tools, commands and
// tests share it.

export type Size = {width: number; height: number};

/** Zoom levels ⌘+ and ⌘− step through (powers of two, as designers expect 50 %, 100 %, 200 %). */
export const ZOOM_PRESETS: readonly number[] = [0.02, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];
/** Empty space kept around content by "Zoom to fit" and "Zoom to selection", in CSS px. */
export const FIT_PADDING = 48;

export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(zoom) && zoom > 0 ? zoom : 1));

export const screenToPage = (viewport: Viewport, point: Vec): Vec => ({x: point.x / viewport.zoom + viewport.x, y: point.y / viewport.zoom + viewport.y});
export const pageToScreen = (viewport: Viewport, point: Vec): Vec => ({x: (point.x - viewport.x) * viewport.zoom, y: (point.y - viewport.y) * viewport.zoom});

export function pageRectToScreen(viewport: Viewport, rect: Rect): Rect {
  return {x: (rect.x - viewport.x) * viewport.zoom, y: (rect.y - viewport.y) * viewport.zoom, width: rect.width * viewport.zoom, height: rect.height * viewport.zoom};
}

/** The part of the page the canvas shows. */
export const visiblePageRect = (viewport: Viewport, size: Size): Rect => ({x: viewport.x, y: viewport.y, width: size.width / viewport.zoom, height: size.height / viewport.zoom});

/** The page point at the canvas's centre. */
export const viewportCenter = (viewport: Viewport, size: Size): Vec => screenToPage(viewport, {x: size.width / 2, y: size.height / 2});

/** Zooms to `zoom` keeping the page point under `anchor` (screen px) where it is. */
export function zoomAround(viewport: Viewport, anchor: Vec, zoom: number): Viewport {
  const next = clampZoom(zoom);
  const page = screenToPage(viewport, anchor);
  return {x: page.x - anchor.x / next, y: page.y - anchor.y / next, zoom: next};
}

/** Pans by a screen-space distance (content follows the pointer: dragging right moves the page right). */
export const panBy = (viewport: Viewport, dx: number, dy: number): Viewport => ({...viewport, x: viewport.x - dx / viewport.zoom, y: viewport.y - dy / viewport.zoom});

/** The next preset above (dir 1) or below (dir −1) the current zoom. */
export function zoomStep(zoom: number, dir: 1 | -1): number {
  const epsilon = 1e-6;
  if (dir > 0) return ZOOM_PRESETS.find(preset => preset > zoom * (1 + epsilon)) ?? ZOOM_MAX;
  for (let i = ZOOM_PRESETS.length - 1; i >= 0; i--) if (ZOOM_PRESETS[i] < zoom * (1 - epsilon)) return ZOOM_PRESETS[i];
  return ZOOM_MIN;
}

export type WheelInput = {deltaX: number; deltaY: number; deltaMode?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean};

/** Pixels per wheel line (Firefox reports lines) and per page. */
const LINE_PX = 16;
const PAGE_PX = 800;
/** Zoom speed per wheel pixel; a pinch sends a few px per event, a mouse notch ~100, capped so one notch is about ×1.4. */
const ZOOM_RATE = 0.01;
const ZOOM_DELTA_CAP = 34;

/** The viewport after a wheel event at `point` (screen px):
 *  ⌘/Ctrl + wheel and trackpad pinch (the browser reports it as ctrlKey) zoom around the pointer,
 *  exponentially so equal motions feel equal at every zoom; a plain wheel or two-finger scroll pans;
 *  Shift + wheel pans horizontally. */
export function wheelToViewport(viewport: Viewport, event: WheelInput, point: Vec): Viewport {
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
  let dx = event.deltaX * unit, dy = event.deltaY * unit;
  if (event.ctrlKey || event.metaKey) {
    const delta = Math.max(-ZOOM_DELTA_CAP, Math.min(ZOOM_DELTA_CAP, dy || dx));
    return zoomAround(viewport, point, viewport.zoom * Math.exp(-delta * ZOOM_RATE));
  }
  if (event.shiftKey && !dx) {
    dx = dy;
    dy = 0;
  }
  return {...viewport, x: viewport.x + dx / viewport.zoom, y: viewport.y + dy / viewport.zoom};
}

/** The viewport that shows `rect` (page space) centred in a canvas of `size`, `padding` CSS px from
 *  the edges, zoomed no further than `maxZoom`. A rect with no width or height (a line, a point) is
 *  fitted on the side it has, and a point keeps `maxZoom` capped to 1. */
export function fitRect(size: Size, rect: Rect, padding = FIT_PADDING, maxZoom = ZOOM_MAX): Viewport {
  const room = {width: Math.max(1, size.width - padding * 2), height: Math.max(1, size.height - padding * 2)};
  const zx = rect.width > 0 ? room.width / rect.width : Infinity;
  const zy = rect.height > 0 ? room.height / rect.height : Infinity;
  let zoom = Math.min(zx, zy);
  if (!Number.isFinite(zoom)) zoom = Math.min(1, maxZoom);
  zoom = clampZoom(Math.min(zoom, maxZoom));
  const centre = {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  return {x: centre.x - size.width / 2 / zoom, y: centre.y - size.height / 2 / zoom, zoom};
}

/** Bounds of the visible content of a page (its visible top-level nodes), or null on an empty page. */
export function pageContentBounds(doc: DesignDocument, pageId: NodeId): Rect | null {
  const rects: Rect[] = [];
  for (const id of doc.nodes[pageId]?.children ?? []) {
    const node = doc.nodes[id];
    if (node?.visible) rects.push(worldBox(doc, id));
  }
  return unionRects(rects);
}

/** Bounds of the given nodes in page space. */
export function nodesBounds(doc: DesignDocument, ids: readonly NodeId[]): Rect | null {
  return unionRects(ids.filter(id => doc.nodes[id]).map(id => worldBox(doc, id)));
}

/** ⇧1 "Zoom to fit": everything on the page. `maxZoom` 1 for the first look at a page. */
export function fitPage(doc: DesignDocument, pageId: NodeId, size: Size, maxZoom = ZOOM_MAX): Viewport {
  const bounds = pageContentBounds(doc, pageId);
  if (!bounds) return {x: -size.width / 2, y: -size.height / 2, zoom: 1};
  return fitRect(size, bounds, FIT_PADDING, maxZoom);
}

/** The viewport a page opens with: content fitted but never magnified past 100 %. */
export const initialViewport = (doc: DesignDocument, pageId: NodeId, size: Size): Viewport => fitPage(doc, pageId, size, 1);

/** Snaps tiny float noise so the zoom label reads 100 % rather than 99.99999 %. */
export const zoomPercent = (zoom: number) => Math.round(zoom * 1000) / 10;
