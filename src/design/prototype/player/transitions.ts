import type {Transition, Vec} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {directionVector} from '../../../../shared/design/prototype';
import type {AnyCanvas, Ctx2D} from '../../engine/render/canvas';

// Transitions between two pictures: the screens before and after (or an overlay coming and going),
// each a bitmap painted once, moved and faded on the GPU. "Move in" moves the new screen over the
// old, "Push" moves both, "Slide in" moves one and lets the other drift by 30 % (a parallax),
// "Dissolve" fades the new one in. Directions name where the moving screen travels.

const PARALLAX = 0.3;

/** One frame of a screen transition: `e` is the eased progress, the bitmaps fill the canvas. */
export function drawScreenTransition(ctx: Ctx2D, from: AnyCanvas, to: AnyCanvas, transition: Transition, e: number): void {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  const fade = Math.min(1, Math.max(0, e));
  const put = (image: AnyCanvas, dx: number, dy: number, alpha = 1) => {
    if (alpha <= 0) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(image, Math.round(dx), Math.round(dy));
    ctx.globalAlpha = 1;
  };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  switch (transition.type) {
    case 'DISSOLVE':
    case 'SMART_ANIMATE':
      put(from, 0, 0);
      put(to, 0, 0, fade);
      return;
    case 'MOVE_IN':
    case 'MOVE_OUT':
    case 'PUSH':
    case 'SLIDE_IN':
    case 'SLIDE_OUT': {
      const d = directionVector(transition.direction);
      const span = {x: d.x * width, y: d.y * height};
      if (transition.type === 'MOVE_IN') {
        put(from, 0, 0);
        put(to, -span.x * (1 - e), -span.y * (1 - e));
      } else if (transition.type === 'MOVE_OUT') {
        put(to, 0, 0);
        put(from, span.x * e, span.y * e);
      } else if (transition.type === 'PUSH') {
        // One rounded offset for both, so no pixel of backdrop shows at the seam.
        const dx = Math.round(span.x * e), dy = Math.round(span.y * e);
        put(from, dx, dy);
        put(to, dx - span.x, dy - span.y);
      } else if (transition.type === 'SLIDE_IN') {
        put(from, span.x * e * PARALLAX, span.y * e * PARALLAX);
        dim(ctx, width, height, 0.18 * fade);
        put(to, -span.x * (1 - e), -span.y * (1 - e));
      } else {
        put(to, -span.x * (1 - e) * PARALLAX, -span.y * (1 - e) * PARALLAX);
        dim(ctx, width, height, 0.18 * (1 - fade));
        put(from, span.x * e, span.y * e);
      }
      return;
    }
    default:
      put(to, 0, 0);
  }
}

/** At a fractional scale a screen ends inside the bitmap's last column (row) of pixels, which then
 *  blends with the backdrop; moved across the stage ("Push", "Move in") it shows as a hairline.
 *  That column (row) takes its neighbour's pixels instead. `width`/`height`: the screen in pixels. */
export function bleedEdges(ctx: Ctx2D, canvas: AnyCanvas, width: number, height: number): void {
  const w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (w > 1 && width > w - 1 && width < w - 0.01) {
    ctx.clearRect(w - 1, 0, 1, h);
    ctx.drawImage(canvas, w - 2, 0, 1, h, w - 1, 0, 1, h);
  }
  if (h > 1 && height > h - 1 && height < h - 0.01) {
    ctx.clearRect(0, h - 1, w, 1);
    ctx.drawImage(canvas, 0, h - 2, w, 1, 0, h - 1, w, 1);
  }
  ctx.restore();
}

function dim(ctx: Ctx2D, width: number, height: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
  ctx.fillRect(0, 0, width, height);
}

/** Where an overlay is during its transition: an offset from its place (screen units) and an opacity.
 *  `entering` overlays come in from outside the screen against their direction; leaving ones go out
 *  along it. Anything else fades. */
export function overlayMotion(transition: Transition, e: number, rect: Rect, screen: {width: number; height: number}, entering: boolean): {offset: Vec; alpha: number} {
  const fade = Math.min(1, Math.max(0, e));
  const fadeOnly = {offset: {x: 0, y: 0}, alpha: entering ? fade : 1 - fade};
  if (transition.type === 'INSTANT') return {offset: {x: 0, y: 0}, alpha: entering ? 1 : 0};
  if (!('direction' in transition)) return fadeOnly;
  const comesIn = transition.type === 'MOVE_IN' || transition.type === 'PUSH' || transition.type === 'SLIDE_IN';
  if (entering !== comesIn) return fadeOnly;
  const d = directionVector(transition.direction);
  if (entering) {
    // From just past the screen edge it travels towards.
    const dx = d.x < 0 ? screen.width - rect.x : d.x > 0 ? -(rect.x + rect.width) : 0;
    const dy = d.y < 0 ? screen.height - rect.y : d.y > 0 ? -(rect.y + rect.height) : 0;
    return {offset: {x: dx * (1 - e), y: dy * (1 - e)}, alpha: 1};
  }
  const dx = d.x < 0 ? -(rect.x + rect.width) : d.x > 0 ? screen.width - rect.x : 0;
  const dy = d.y < 0 ? -(rect.y + rect.height) : d.y > 0 ? screen.height - rect.y : 0;
  return {offset: {x: dx * e, y: dy * e}, alpha: 1};
}
