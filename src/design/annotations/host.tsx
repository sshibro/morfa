import {lazy, memo, Suspense, useEffect, useState, useSyncExternalStore} from 'react';
import type {DesignDocument} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import {useDesignStore} from '../engine/useDesignStore';
import {ANNOTATION_TOOL, annotationsState, MEASURE_TOOL} from './state';
import type {DevNotesProps} from './ui/DevNotes';

// The canvas layer of notes and measurements loads the first time there is something to show: notes or measurements on
// the page while they are shown, or one of their tools in hand. Until then the editor carries none of it.

const AnnotationsLayer = lazy(() => import('./ui/AnnotationsLayer').then(module => ({default: module.AnnotationsLayer})));
const DevNotes = lazy(() => import('./ui/DevNotes').then(module => ({default: module.DevNotes})));

/** Whether the file holds notes or measurements anywhere (stops at the first). */
function hasDevNotes(doc: DesignDocument): boolean {
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (node.annotations?.length || node.measurements?.length) return true;
  }
  return false;
}

export const AnnotationsHost = memo(function AnnotationsHost({store, readOnly}: {store: DesignStore; readOnly: boolean}) {
  const state = annotationsState(store);
  const ui = useSyncExternalStore(state.subscribe, state.get);
  const tool = useDesignStore(s => s.tool, Object.is, {store, slice: 'tool'});
  const [loaded, setLoaded] = useState(false);
  // The file is looked through once; after that only the layers each change touches (a co-editor's note, an undo).
  useEffect(() => {
    if (loaded) return;
    if (hasDevNotes(store.getState().doc)) {
      setLoaded(true);
      return;
    }
    return store.onDocument(change => {
      for (const id of change.changed) {
        const node = change.doc.nodes[id];
        if (node?.annotations?.length || node?.measurements?.length) {
          setLoaded(true);
          return;
        }
      }
    });
  }, [store, loaded]);
  const wanted = loaded || tool === ANNOTATION_TOOL || tool === MEASURE_TOOL || !!ui.editing;
  if (!wanted) return null;
  return <Suspense fallback={null}><AnnotationsLayer store={store} readOnly={readOnly} /></Suspense>;
});

/** The "Code" tab's notes and measurements (loaded with the tab). */
export function DevNotesSection(props: DevNotesProps) {
  return <Suspense fallback={null}><DevNotes {...props} /></Suspense>;
}
