import type {NodeId} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';

// What dev annotations and measurements (docs/design-tool.md §Dev annotations and measurements) keep beside the document,
// per open file: whether they show on the canvas ("View → Annotations", ⇧Y; remembered on this device), the note being
// written or edited, and the measurement picked with "Measurement" (Delete removes it). Plain state with a subscription;
// React reads it through useSyncExternalStore.

export type AnnotationsUI = {
  /** Notes and measurements drawn on the canvas. Their own tools always show them. */
  visible: boolean;
  /** The note open for writing: a new one on `nodeId` (annotationId null) or one of its notes. */
  editing: {nodeId: NodeId; annotationId: string | null} | null;
  /** The measurement picked with "Measurement". */
  selectedMeasurement: string | null;
  /** The measurement under the pointer in "Measurement". */
  hoverMeasurement: string | null;
};

export type AnnotationsState = {
  get(): AnnotationsUI;
  set(partial: Partial<AnnotationsUI>): void;
  subscribe(listener: () => void): () => void;
};

const VISIBLE_KEY = 'morfa-design-annotations';
export const ANNOTATION_TOOL = 'annotation';
export const MEASURE_TOOL = 'measure';

function readVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) !== '0';
  } catch {
    return true;
  }
}

const states = new WeakMap<DesignStore, AnnotationsState>();

/** The state of the file open in `store` (made on first use). */
export function annotationsState(store: DesignStore): AnnotationsState {
  let state = states.get(store);
  if (state) return state;
  let value: AnnotationsUI = {visible: readVisible(), editing: null, selectedMeasurement: null, hoverMeasurement: null};
  const listeners = new Set<() => void>();
  state = {
    get: () => value,
    set(partial) {
      const next = {...value, ...partial};
      if ((Object.keys(partial) as (keyof AnnotationsUI)[]).every(key => next[key] === value[key])) return;
      if (partial.visible !== undefined && partial.visible !== value.visible) {
        try {
          localStorage.setItem(VISIBLE_KEY, partial.visible ? '1' : '0');
        } catch {
          // Only a convenience.
        }
      }
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  states.set(store, state);
  return state;
}

/** Whether the canvas shows notes and measurements now: the toggle, or one of their tools in hand. */
export const devNotesShown = (store: DesignStore) => {
  const tool = store.getState().tool;
  return annotationsState(store).get().visible || tool === ANNOTATION_TOOL || tool === MEASURE_TOOL;
};
