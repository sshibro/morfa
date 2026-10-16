import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {worldBox} from '../../../../shared/design/geometry';
import {isFrameLikeNode} from '../../../../shared/design/tree';
import type {Viewport} from '../contracts';
import {currentViewport} from '../store';
import {fitPage, fitRect, FIT_PADDING, nodesBounds, zoomAround, zoomStep} from '../viewport';
import type {Command, CommandContext} from './registry';

// Zoom: ⌘+ / ⌘− step through the presets around the canvas centre, ⇧0 is 100 %, ⇧1 fits the
// page, ⇧2 fits the selection, N / ⇧N go to the next / previous frame on the page (as in Figma).
// With nothing selected the arrows pan the canvas, ⇧ further (help.figma.com "Use Figma products with a keyboard");
// with a selection they nudge it: one command per key (arrange.ts) asks `canPan`. Tools: V and H.

const state = (ctx: CommandContext) => ctx.store.getState();

function setZoom(ctx: CommandContext, next: (viewport: Viewport, size: {width: number; height: number}) => Viewport) {
  const size = ctx.canvasSize();
  if (!size.width || !size.height) return;
  ctx.store.setViewport(next(currentViewport(state(ctx)), size));
}

const centre = (size: {width: number; height: number}) => ({x: size.width / 2, y: size.height / 2});

/** Screen px an arrow pans, and with ⇧. */
export const PAN_STEP = 40;
export const PAN_STEP_LARGE = 240;

/** Focus on the page or the canvas: a focused list or panel keeps its arrows (its own scrolling). True outside a browser. */
function focusOnCanvas(): boolean {
  if (typeof document === 'undefined') return true;
  const active = document.activeElement;
  return !active || active === document.body || !!active.closest('[role="application"]');
}

/** Nothing selected, nothing being edited, the canvas focused: the arrows are the canvas's (the nudge commands ask). */
export const canPan = (ctx: CommandContext) => !state(ctx).selection.length && !state(ctx).editing && focusOnCanvas();

/** Pans by `dx`, `dy` arrow steps (each PAN_STEP screen px, or PAN_STEP_LARGE). */
export function panByArrows(ctx: CommandContext, dx: number, dy: number, large: boolean) {
  const step = large ? PAN_STEP_LARGE : PAN_STEP;
  const viewport = currentViewport(state(ctx));
  ctx.store.setViewport({...viewport, x: viewport.x + (dx * step) / viewport.zoom, y: viewport.y + (dy * step) / viewport.zoom});
}

export const VIEW_COMMANDS: Command[] = [
  {
    id: 'zoom-in',
    label: 'Zoom in',
    group: 'view',
    shortcut: {code: 'Equal', mod: true},
    alternates: [{code: 'Equal', mod: true, shift: true}, {code: 'NumpadAdd', mod: true}, {code: 'Equal'}, {code: 'Equal', shift: true}, {code: 'NumpadAdd'}],
    repeat: true,
    run: ctx => setZoom(ctx, (viewport, size) => zoomAround(viewport, centre(size), zoomStep(viewport.zoom, 1))),
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    group: 'view',
    shortcut: {code: 'Minus', mod: true},
    alternates: [{code: 'Minus', mod: true, shift: true}, {code: 'NumpadSubtract', mod: true}, {code: 'Minus'}, {code: 'NumpadSubtract'}],
    repeat: true,
    run: ctx => setZoom(ctx, (viewport, size) => zoomAround(viewport, centre(size), zoomStep(viewport.zoom, -1))),
  },
  {
    id: 'zoom-100',
    label: 'Zoom to 100%',
    group: 'view',
    shortcut: {code: 'Digit0', shift: true},
    run: ctx => setZoom(ctx, (viewport, size) => zoomAround(viewport, centre(size), 1)),
  },
  {
    id: 'zoom-fit',
    label: 'Zoom to fit',
    group: 'view',
    shortcut: {code: 'Digit1', shift: true},
    run: ctx => setZoom(ctx, (_viewport, size) => fitPage(state(ctx).doc, state(ctx).pageId, size)),
  },
  {
    id: 'zoom-selection',
    label: 'Zoom to selection',
    group: 'view',
    shortcut: {code: 'Digit2', shift: true},
    run: ctx => setZoom(ctx, (_viewport, size) => {
      const {doc, pageId, selection} = state(ctx);
      const bounds = nodesBounds(doc, selection);
      return bounds ? fitRect(size, bounds, FIT_PADDING) : fitPage(doc, pageId, size);
    }),
  },
  {id: 'view.next-frame', label: 'Next frame', group: 'view', shortcut: {code: 'KeyN'}, repeat: true, enabled: ctx => pageFrames(state(ctx).doc, state(ctx).pageId).length > 0, run: ctx => goToFrame(ctx, 1)},
  {id: 'view.previous-frame', label: 'Previous frame', group: 'view', shortcut: {code: 'KeyN', shift: true}, repeat: true, enabled: ctx => pageFrames(state(ctx).doc, state(ctx).pageId).length > 0, run: ctx => goToFrame(ctx, -1)},
  {id: 'tool-move', label: 'Move', group: 'tools', shortcut: {code: 'KeyV'}, run: ctx => ctx.store.setTool('move')},
  {id: 'tool-hand', label: 'Hand', group: 'tools', shortcut: {code: 'KeyH'}, run: ctx => ctx.store.setTool('hand')},
];

/** The frames standing on the page (in sections too), in reading order: rows from the top, then
 *  left to right; frames whose tops are within half the shorter one's height share a row. */
export function pageFrames(doc: DesignDocument, pageId: NodeId): NodeId[] {
  const out: {id: NodeId; x: number; y: number; height: number}[] = [];
  const visit = (ids: readonly NodeId[] | undefined) => {
    for (const id of ids ?? []) {
      const node = doc.nodes[id];
      if (!node?.visible) continue;
      if (node.type === 'SECTION') visit(node.children);
      else if (isFrameLikeNode(node)) {
        const box = worldBox(doc, id);
        out.push({id, x: box.x, y: box.y, height: box.height});
      }
    }
  };
  visit(doc.nodes[pageId]?.children);
  out.sort((a, b) => (Math.abs(a.y - b.y) <= Math.min(a.height, b.height) / 2 ? a.x - b.x : a.y - b.y));
  return out.map(each => each.id);
}

/** N / ⇧N: selects the next (previous) frame after the one the selection is in and fits it on screen. */
function goToFrame(ctx: CommandContext, step: 1 | -1) {
  const {doc, pageId, selection} = state(ctx);
  const frames = pageFrames(doc, pageId);
  if (!frames.length) return;
  // The frame the selection is in (or is), if any.
  let at = -1;
  for (let node = doc.nodes[selection[0] ?? '']; node && node.type !== 'PAGE' && at < 0; node = doc.nodes[node.parentId ?? '']) at = frames.indexOf(node.id);
  const next = frames[at < 0 ? (step > 0 ? 0 : frames.length - 1) : (at + step + frames.length) % frames.length];
  ctx.store.setContext(null);
  ctx.store.setSelection([next]);
  setZoom(ctx, (_viewport, size) => fitRect(size, worldBox(doc, next), FIT_PADDING));
}
