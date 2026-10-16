import {memo, useEffect, useRef} from 'react';
import type {NodeId} from '../../../../shared/design/types';
import {currentViewport, type DesignStore} from '../../engine/store';
import {pageToScreen} from '../../engine/viewport';
import type {BoardBadge} from '../meeting';
import type {BoardObjects} from '../objects';

// ── Badges (the meeting slot's votes and reactions) ───────────────────────────────────────────────

/** Badges at the top-right corners of board objects, over the canvas: written on animation frames when the view, the document
 *  or the badges change (no React render per pan). */
export const BadgeLayer = memo(function BadgeLayer({store, objects}: {store: DesignStore; objects: BoardObjects}) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = layer.current;
    if (!element) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const state = store.getState();
      const viewport = currentViewport(state);
      const stacked = new Map<NodeId, number>();
      const fragments: HTMLElement[] = [];
      for (const [source, list] of objects.badges()) {
        for (const badge of list) {
          if (!badge.count) continue;
          const box = objects.objectBounds(badge.id, 'page');
          if (!box) continue;
          const corner = pageToScreen(viewport, {x: box.x + box.width, y: box.y});
          const offset = stacked.get(badge.id) ?? 0;
          stacked.set(badge.id, offset + 1);
          fragments.push(badgeElement(badge, source, corner.x - offset * 30, corner.y));
        }
      }
      element.replaceChildren(...fragments);
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    draw();
    const offStore = store.subscribe(request, {slice: ['viewport', 'doc', 'page']});
    const offBadges = objects.subscribeBadges(request);
    return () => {
      offStore();
      offBadges();
      cancelAnimationFrame(frame);
    };
  }, [store, objects]);
  return <div ref={layer} className="bd-badges" aria-live="polite" />;
});

function badgeElement(badge: BoardBadge, source: string, x: number, y: number): HTMLElement {
  const element = document.createElement('span');
  element.className = `bd-badge is-${badge.tone ?? 'accent'}`;
  element.dataset.source = source;
  element.dataset.node = badge.id;
  element.textContent = badge.count > 99 ? '99+' : String(badge.count);
  if (badge.label) {
    element.title = badge.label;
    element.setAttribute('aria-label', badge.label);
  }
  element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
  return element;
}
