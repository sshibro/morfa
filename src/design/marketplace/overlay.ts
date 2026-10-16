// "Marketplaces" on the canvas (docs/marketplaces.md): what the editor draws over card frames, under the selection. Two layers, each
// owned by its module: the marketplaces' badge zones (Card Canvas, ./canvas/zones-overlay.ts) and the sales numbers and winner badges
// (Performance Loop, ./loop/metrics-overlay.ts). The overlay is 2D on both renderers and never reaches an export. Both painters load
// the first time a page with a card is drawn, then the canvas draws again: a file without cards never downloads them.

import {cardsOnPage} from '../../../shared/design/marketplace/meta';
import type {EditorState} from '../engine/store';
import type {Viewport} from '../engine/contracts';

export type MarketplaceOverlayScene = {
  state: EditorState;
  viewport: Viewport;
  size: {width: number; height: number};
};

type Painters = {
  drawCardZones: (ctx: CanvasRenderingContext2D, scene: MarketplaceOverlayScene) => void;
  drawCardMetrics: (ctx: CanvasRenderingContext2D, scene: MarketplaceOverlayScene) => void;
};
let painters: Painters | null = null;
let loading = false;
const loadZones = () => import('./canvas/zones-overlay');
const loadMetrics = () => import('./loop/metrics-overlay');
function loadPainters() {
  if (loading) return;
  loading = true;
  Promise.all([loadZones(), loadMetrics()]).then(
    ([zones, metrics]) => {
      painters = {drawCardZones: zones.drawCardZones, drawCardMetrics: metrics.drawCardMetrics};
      notifyMarketplaceOverlay();
    },
    // A failed download (offline, a new release): the next frame with a card tries again.
    () => {
      loading = false;
    },
  );
}

export function drawMarketplaceOverlay(ctx: CanvasRenderingContext2D, scene: MarketplaceOverlayScene) {
  if (!painters) {
    if (cardsOnPage(scene.state.doc, scene.state.pageId).length) loadPainters();
    return;
  }
  const {drawCardZones, drawCardMetrics} = painters;
  ctx.save();
  try {
    drawCardZones(ctx, scene);
  } finally {
    ctx.restore();
  }
  ctx.save();
  try {
    drawCardMetrics(ctx, scene);
  } finally {
    ctx.restore();
  }
}

// Data the overlay draws that lives outside the store (sales numbers fetched from the server): its owner calls
// `notifyMarketplaceOverlay()` when it changes and every open canvas redraws its overlay.
const listeners = new Set<() => void>();
export function onMarketplaceOverlayChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function notifyMarketplaceOverlay() {
  for (const listener of listeners) listener();
}
