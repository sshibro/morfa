// Performance Loop: the number strip under each published card frame and the winner badge of an A/B test (docs/marketplaces.md
// §Performance Loop), drawn by the canvas overlay (../overlay.ts) under the selection. Quiet on purpose: the frame titles' grey, one line
// of 11 px type that gives up its words as the frame gets narrow on screen, a small red dot when CTR is under 2 %, and a green
// "Winner" pill above the frame that won. The numbers come from ./cards-store.ts, which this draw starts reading for the open file.

import {worldBox} from '../../../../shared/design/geometry';
import {cardsOnPage} from '../../../../shared/design/marketplace/meta';
import {LABEL_FONT} from '../../engine/overlay';
import {pageRectToScreen} from '../../engine/viewport';
import type {MarketplaceOverlayScene} from '../overlay';
import {fileCardsEntry, openFileId, watchFileCards, winnerFrames} from './cards-store';
import {lowCtr, stripTexts} from './format';

const TEXT = '#757575';
const LOW = '#F24822';
const WINNER = '#14AE5C';
const GAP = 6;
/** Under a selected frame the engine's "900 × 1200" badge sits at the bottom edge (engine/overlay.ts): the strip goes below it. */
const GAP_SELECTED = 30;
const DOT = 6;
const BADGE_HEIGHT = 16;

/** The strips drawn last, for the browser tests (`navigator.webdriver` only): frame id → text. */
let lastDrawn = '';

export function drawCardMetrics(ctx: CanvasRenderingContext2D, scene: MarketplaceOverlayScene): void {
  const fileId = openFileId();
  if (!fileId) return;
  const {doc, pageId, selection} = scene.state;
  const cards = cardsOnPage(doc, pageId);
  if (!cards.length) return;
  watchFileCards(fileId);
  const entry = fileCardsEntry(fileId);
  if (entry?.state !== 'ready' || !entry.cards) return;
  const frames = new Map(entry.cards.frames.map(frame => [frame.nodeId, frame]));
  const winners = winnerFrames(entry.cards);
  const drawn: Record<string, string> = {};
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'top';
  for (const {id} of cards) {
    const numbers = frames.get(id);
    const winner = winners.has(id);
    if ((!numbers || !numbers.days) && !winner) continue;
    if (doc.nodes[id]?.visible === false) continue;
    const box = pageRectToScreen(scene.viewport, worldBox(doc, id));
    if (box.x > scene.size.width || box.x + box.width < 0 || box.y - BADGE_HEIGHT - 8 > scene.size.height || box.y + box.height + 24 < 0) continue;
    if (numbers && numbers.days) {
      const low = lowCtr(numbers.totals);
      const room = box.width - (low ? DOT + 4 : 0);
      const text = stripTexts(numbers.totals).find(candidate => ctx.measureText(candidate).width <= room);
      if (text) {
        let x = Math.round(box.x);
        const y = Math.round(box.y + box.height + (selection.includes(id) ? GAP_SELECTED : GAP));
        if (low) {
          ctx.fillStyle = LOW;
          ctx.beginPath();
          ctx.arc(x + DOT / 2, y + 6.5, DOT / 2, 0, Math.PI * 2);
          ctx.fill();
          x += DOT + 4;
        }
        ctx.fillStyle = TEXT;
        ctx.fillText(text, x, y);
        drawn[id] = (low ? '● ' : '') + text;
      }
    }
    if (winner) {
      const label = 'Winner';
      const width = Math.ceil(ctx.measureText(label).width) + 12;
      if (width <= box.width) {
        const x = Math.round(box.x + box.width - width), y = Math.round(box.y - BADGE_HEIGHT - 4);
        ctx.fillStyle = WINNER;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, width, BADGE_HEIGHT, 4);
        else ctx.rect(x, y, width, BADGE_HEIGHT);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + 6, y + BADGE_HEIGHT / 2 + 0.5);
        ctx.textBaseline = 'top';
        drawn[id] = (drawn[id] ? drawn[id] + ' | ' : '') + label;
      }
    }
  }
  if (typeof navigator !== 'undefined' && navigator.webdriver) {
    const next = JSON.stringify(drawn);
    if (next !== lastDrawn) (window as unknown as {__morfaMarketplaceStrips?: Record<string, string>}).__morfaMarketplaceStrips = drawn;
    lastDrawn = next;
  }
}
