import {memo, useEffect, useState} from 'react';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import type {SpatialIndex} from '../../../../shared/design/tree';
import {currentViewport, type DesignStore} from '../../engine/store';
import {visiblePageRect} from '../../engine/viewport';

// "Back to board" (FigJam's Recenter, help.figma.com "Pan and zoom in FigJam": "If you scroll far away from the starting point of
// your file, a Recenter button will appear above the bottom toolbar"): shown while nothing of the page is in view, it zooms to fit
// what the page holds. Checked on an animation frame when the view or the document changes.

/** True when the page holds something and none of it meets `view` (an index query, no measuring). */
export function offBoard(doc: DesignDocument, pageId: NodeId, view: Rect, index: SpatialIndex | null): boolean {
  if (!index || !doc.nodes[pageId]?.children?.length) return false;
  for (const _ of index.query(view)) return false;
  return true;
}

export const Recenter = memo(function Recenter({store, index, host, onFit}: {store: DesignStore; index: () => SpatialIndex | null; host: () => HTMLElement | null; onFit: () => void}) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const element = host();
      if (!element) return;
      const state = store.getState();
      const view = visiblePageRect(currentViewport(state), {width: element.clientWidth, height: element.clientHeight});
      setAway(offBoard(state.doc, state.pageId, view, index()));
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    request();
    const off = store.subscribe(request, {slice: ['viewport', 'doc', 'page']});
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [store, index, host]);
  if (!away) return null;
  return <button type="button" className="bd-recenter" onClick={onFit}>Back to board</button>;
});
