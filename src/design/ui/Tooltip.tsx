import {cloneElement, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FocusEvent, type PointerEvent, type ReactElement} from 'react';
import {createPortal} from 'react-dom';
import {formatShortcut} from './shortcuts';
import {useLayer} from './layer';
import {placeFloating, rectOf, viewportSize, type Placement, type Placed} from './position';

// One tooltip at a time, drawn by a single TooltipLayer: buttons only report hover and focus,
// so a toolbar of thirty buttons mounts no thirty portals. The first tooltip waits 500 ms;
// moving to a neighbour within 600 ms shows the next one at once and without animation
// (emil-design-eng: instant tooltips after the first one is open).

export type TooltipContent = {label: string; shortcut?: string; placement?: Placement};
type Request = TooltipContent & {anchor: Element; layer: HTMLElement | null; instant: boolean};

const DELAY_MS = 500;
const WARM_MS = 600;
let current: Request | null = null;
let pending: ReturnType<typeof setTimeout> | undefined;
let hiddenAt = 0;
/** Pressing a button hides its tooltip until the pointer leaves it. */
let suppressed: Element | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function showTooltip(anchor: Element, content: TooltipContent, layer: HTMLElement | null, immediate = false) {
  if (suppressed === anchor) return;
  clearTimeout(pending);
  const warm = !!current || Date.now() - hiddenAt < WARM_MS;
  const show = () => {
    if (!anchor.isConnected) return;
    current = {...content, anchor, layer, instant: warm || immediate};
    emit();
  };
  if (warm || immediate) show();
  else pending = setTimeout(show, DELAY_MS);
}

export function hideTooltip(anchor?: Element) {
  clearTimeout(pending);
  if (anchor && current && current.anchor !== anchor) return;
  if (current) {
    current = null;
    hiddenAt = Date.now();
    emit();
  }
}

/** Props that give an element a tooltip. Spread them onto any focusable element. */
export function useTooltip(content: TooltipContent | null) {
  const layer = useLayer();
  const contentRef = useRef(content);
  contentRef.current = content;
  if (!content) return {};
  return {
    onPointerEnter: (event: PointerEvent<Element>) => {
      if (event.pointerType === 'mouse' && contentRef.current) showTooltip(event.currentTarget, contentRef.current, layer);
    },
    onPointerLeave: (event: PointerEvent<Element>) => {
      if (suppressed === event.currentTarget) suppressed = null;
      hideTooltip(event.currentTarget);
    },
    onPointerDown: (event: PointerEvent<Element>) => {
      suppressed = event.currentTarget;
      hideTooltip();
    },
    onFocus: (event: FocusEvent<Element>) => {
      if (contentRef.current && event.currentTarget.matches(':focus-visible')) showTooltip(event.currentTarget, contentRef.current, layer, true);
    },
    onBlur: (event: FocusEvent<Element>) => hideTooltip(event.currentTarget),
  };
}

/** Wraps one element (which must accept pointer and focus handlers) with a tooltip. */
export function Tooltip({label, shortcut, placement, children}: TooltipContent & {children: ReactElement<Record<string, unknown>>}) {
  const handlers = useTooltip({label, shortcut, placement});
  const merged: Record<string, unknown> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    const own = children.props[name] as ((event: unknown) => void) | undefined;
    merged[name] = (event: unknown) => {
      own?.(event);
      (handler as (event: unknown) => void)(event);
    };
  }
  return cloneElement(children, merged);
}

/** Mounted once by DesignRoot. */
export function TooltipLayer() {
  const request = useSyncExternalStore(subscribe, () => current, () => null);
  useLayoutEffect(() => {
    if (!request) return;
    const hide = () => hideTooltip();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [request]);
  if (!request || !request.layer) return null;
  return createPortal(<TooltipBubble key={tooltipKey(request)} request={request} />, request.layer);
}

const keys = new WeakMap<Element, number>();
let nextKey = 1;
const tooltipKey = (request: Request) => {
  if (!keys.has(request.anchor)) keys.set(request.anchor, nextKey++);
  return keys.get(request.anchor)! + ':' + request.label;
};

function TooltipBubble({request}: {request: Request}) {
  const bubble = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    const element = bubble.current;
    if (!element) return;
    setPlaced(placeFloating(rectOf(request.anchor), {width: element.offsetWidth, height: element.offsetHeight}, viewportSize(), request.placement ?? 'bottom', 6));
  }, [request]);
  return (
    <div ref={bubble} role="tooltip" className="dz-tooltip" data-instant={request.instant || undefined} data-side={placed?.side}
      style={placed ? {left: placed.x, top: placed.y, '--dz-origin': placed.origin} as CSSProperties : {visibility: 'hidden'}}>
      <div className="dz-tooltip-body">
        <span>{request.label}</span>
        {request.shortcut && <span className="dz-tooltip-shortcut">{formatShortcut(request.shortcut)}</span>}
      </div>
    </div>
  );
}
