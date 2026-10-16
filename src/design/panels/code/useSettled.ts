import {useEffect, useState} from 'react';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import type {DesignStore} from '../../engine/store';

// The document and selection the "Code" tab describes. Code is regenerated when they settle, never
// while a gesture runs: a drag changes the document every frame, and the panel must stay quiet
// then (docs/design-tool.md §Performance). Other slices (viewport, hover, tool) are not watched.

export type Settled = {doc: DesignDocument; selection: readonly NodeId[]; pageId: NodeId};

const SETTLE_MS = 140;

export function useSettled(store: DesignStore): Settled {
  const [settled, setSettled] = useState<Settled>(() => {
    const state = store.getState();
    return {doc: state.doc, selection: state.selection, pageId: state.pageId};
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const take = () => {
      timer = undefined;
      const state = store.getState();
      if (state.live.size) return;
      setSettled(previous => (previous.doc === state.doc && previous.selection === state.selection && previous.pageId === state.pageId ? previous : {doc: state.doc, selection: state.selection, pageId: state.pageId}));
    };
    let seen = store.getState();
    const unsubscribe = store.subscribe(() => {
      const state = store.getState();
      const picked = state.selection !== seen.selection || state.pageId !== seen.pageId;
      seen = state;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (state.live.size) return;
      // A new selection shows at once; edits to the document settle first.
      if (picked) take();
      else timer = setTimeout(take, SETTLE_MS);
    }, {slice: ['doc', 'selection', 'live', 'page']});
    take();
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [store]);
  return settled;
}
