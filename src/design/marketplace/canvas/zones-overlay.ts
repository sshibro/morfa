// Card Canvas: the marketplace's badge, price and favourite zones drawn over each card frame (docs/marketplaces.md §Badge zones).
// The zones are the spec's fractions of the frame (shared/design/marketplace/specs.ts `safeZones`), so they follow the frame at any
// size, rotation or zoom: a dashed outline and a faint tint, named only on the selected card and only when the zoom leaves room
// for the name. The overlay canvas never reaches an export; "View ▸ Marketplace badge zones" (`ui.cardZones`) hides it.

import {apply, multiply, worldMatrix} from '../../../../shared/design/geometry';
import {cardOf, cardsOnPage, type CardMeta} from '../../../../shared/design/marketplace/meta';
import {marketplaceSpec, type SafeZone} from '../../../../shared/design/marketplace/specs';
import type {DesignDocument, Matrix, NodeId, Vec} from '../../../../shared/design/types';
import {LABEL_FONT, OVERLAY_COLORS, screenMatrix} from '../../engine/overlay';
import type {MarketplaceOverlayScene} from '../overlay';

/** The guides' red: what a marketplace lays over the card is a warning, not a part of the design. */
const ZONE_STROKE = OVERLAY_COLORS.guide;
const ZONE_FILL = 'rgba(242, 72, 34, 0.07)';
const ZONE_DASH = [4, 3];
/** A label needs this much of the zone on screen (px), with its pill's padding. */
const LABEL_HEIGHT = 18;
const LABEL_INSET = 4;

/** The cards on a page, worked out again only when the document or the page changes (a pan redraws the overlay every frame). */
let cards: {doc: DesignDocument; pageId: NodeId; value: {id: NodeId; meta: CardMeta}[]} | null = null;
function pageCards(doc: DesignDocument, pageId: NodeId) {
  if (cards?.doc !== doc || cards.pageId !== pageId) cards = {doc, pageId, value: cardsOnPage(doc, pageId)};
  return cards.value;
}

/** A zone's corners on screen, clockwise from its top-left. */
export function zoneCorners(m: Matrix, frame: {width: number; height: number}, zone: SafeZone): Vec[] {
  const x = zone.x * frame.width, y = zone.y * frame.height, width = zone.width * frame.width, height = zone.height * frame.height;
  return [{x, y}, {x: x + width, y}, {x: x + width, y: y + height}, {x, y: y + height}].map(point => apply(m, point));
}

const axisAligned = (m: Matrix) => Math.abs(m[0][1]) < 1e-9 && Math.abs(m[1][0]) < 1e-9;

export function drawCardZones(ctx: CanvasRenderingContext2D, scene: MarketplaceOverlayScene): void {
  const {state, viewport, size} = scene;
  if (!state.ui.cardZones) return;
  const doc = state.doc;
  const list = pageCards(doc, state.pageId);
  if (!list.length) return;
  const selected = new Set<NodeId>();
  for (const id of state.selection.slice(0, 50)) {
    const card = cardOf(doc, id);
    if (card) selected.add(card.id);
  }
  const view = screenMatrix(viewport);
  ctx.lineWidth = 1;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  for (const {id, meta} of list) {
    const frame = doc.nodes[id];
    if (!frame?.visible) continue;
    const m = multiply(view, worldMatrix(doc, id));
    const outline = zoneCorners(m, frame, {id: '', label: '', x: 0, y: 0, width: 1, height: 1});
    // Off screen: nothing to draw.
    const xs = outline.map(p => p.x), ys = outline.map(p => p.y);
    if (Math.max(...xs) < 0 || Math.min(...xs) > size.width || Math.max(...ys) < 0 || Math.min(...ys) > size.height) continue;
    const straight = axisAligned(m);
    for (const zone of marketplaceSpec(meta.marketplace).safeZones) {
      const corners = zoneCorners(m, frame, zone).map(p => (straight ? {x: Math.round(p.x) + 0.5, y: Math.round(p.y) + 0.5} : p));
      ctx.beginPath();
      corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = ZONE_FILL;
      ctx.fill();
      ctx.strokeStyle = ZONE_STROKE;
      ctx.setLineDash(ZONE_DASH);
      ctx.stroke();
      if (selected.has(id) && straight) drawZoneLabel(ctx, corners, zone.label);
    }
  }
  ctx.setLineDash([]);
}

/** The zone's name in a pill in its middle (clear of the frame's corner handles), when the zone is large enough on screen. */
function drawZoneLabel(ctx: CanvasRenderingContext2D, corners: Vec[], label: string) {
  const left = Math.min(...corners.map(p => p.x)), right = Math.max(...corners.map(p => p.x));
  const top = Math.min(...corners.map(p => p.y)), bottom = Math.max(...corners.map(p => p.y));
  const width = Math.ceil(ctx.measureText(label).width) + 8;
  if (right - left < width + LABEL_INSET * 2 || bottom - top < LABEL_HEIGHT + LABEL_INSET * 2) return;
  const x = Math.round((left + right - width) / 2), y = Math.round((top + bottom - LABEL_HEIGHT) / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, LABEL_HEIGHT, 3);
  ctx.fillStyle = ZONE_STROKE;
  ctx.fill();
  ctx.fillStyle = OVERLAY_COLORS.labelText;
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 4, y + LABEL_HEIGHT / 2 + 0.5);
}
