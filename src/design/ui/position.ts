// Where a floating element (menu, popover, tooltip) goes next to its anchor: the preferred side,
// flipped to the opposite side when that has more room, then shifted to stay inside the viewport.
// Pure, so node tests cover it; components measure and call it once per open (not per frame).

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Placement = Side | `${Side}-start` | `${Side}-end`;
export type Rect = {x: number; y: number; width: number; height: number};
export type Size = {width: number; height: number};
export type Placed = {
  x: number;
  y: number;
  side: Side;
  /** CSS transform-origin in px relative to the floating element, pointing at the anchor (origin-aware popovers). */
  origin: string;
  /** Height left between the element's top and the viewport's bottom padding (long menus scroll). */
  maxHeight: number;
};

const OPPOSITE: Record<Side, Side> = {top: 'bottom', bottom: 'top', left: 'right', right: 'left'};

export function placeFloating(anchor: Rect, floating: Size, viewport: Size, placement: Placement, offset = 4, padding = 8): Placed {
  const [preferred, align = 'center'] = placement.split('-') as [Side, 'start' | 'end' | undefined];
  const room: Record<Side, number> = {
    top: anchor.y - padding,
    bottom: viewport.height - (anchor.y + anchor.height) - padding,
    left: anchor.x - padding,
    right: viewport.width - (anchor.x + anchor.width) - padding,
  };
  const needed = (side: Side) => (side === 'top' || side === 'bottom' ? floating.height : floating.width) + offset;
  let side = preferred;
  if (room[side] < needed(side) && room[OPPOSITE[side]] > room[side]) side = OPPOSITE[side];

  let x: number;
  let y: number;
  if (side === 'top' || side === 'bottom') {
    y = side === 'bottom' ? anchor.y + anchor.height + offset : anchor.y - offset - floating.height;
    x = align === 'start' ? anchor.x : align === 'end' ? anchor.x + anchor.width - floating.width : anchor.x + anchor.width / 2 - floating.width / 2;
  } else {
    x = side === 'right' ? anchor.x + anchor.width + offset : anchor.x - offset - floating.width;
    y = align === 'start' ? anchor.y : align === 'end' ? anchor.y + anchor.height - floating.height : anchor.y + anchor.height / 2 - floating.height / 2;
  }
  x = clamp(x, padding, viewport.width - floating.width - padding);
  y = clamp(y, padding, viewport.height - floating.height - padding);

  const originX = clamp(anchor.x + anchor.width / 2 - x, 0, floating.width);
  const originY = clamp(anchor.y + anchor.height / 2 - y, 0, floating.height);
  const origin = side === 'bottom' ? `${originX}px 0px` : side === 'top' ? `${originX}px ${floating.height}px` : side === 'right' ? `0px ${originY}px` : `${floating.width}px ${originY}px`;
  return {x: Math.round(x), y: Math.round(y), side, origin, maxHeight: Math.max(80, viewport.height - padding - Math.max(padding, y))};
}

/** Clamp that prefers the lower bound when the range is empty (an element larger than the viewport stays at its start). */
export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

export const rectOf = (element: Element): Rect => {
  const box = element.getBoundingClientRect();
  return {x: box.left, y: box.top, width: box.width, height: box.height};
};

export const viewportSize = (): Size => ({width: window.innerWidth, height: window.innerHeight});
