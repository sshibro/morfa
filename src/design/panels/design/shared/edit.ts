import {useCallback, useMemo, useRef} from 'react';
import type {DesignDocument, NodeId, SceneNode} from '../../../../../shared/design/types';
import type {Transaction} from '../../../../../shared/design/transaction';
import type {NodeUpdates} from '../../../../../shared/design/constraints';
import type {Gesture, StoreSlice, EditorState, DesignStore} from '../../../engine/store';
import {useDesignStore} from '../../../engine/useDesignStore';
import {userUpdate} from '../../../engine/user-edit';
import {useEditorServices} from '../../../editor/services';
import type {NumberChangeSource} from '../../../ui/NumberField';

// How "Design" panel controls write to the document. Every hand-made value goes through
// `userUpdate` (styles detach, instance copies record an override); fields the engine derives
// (a resized frame's children follow their constraints) are written as they are. A scrub, a slider
// drag or a picker drag is one gesture: `start` opens it, each change re-runs the recipe from the
// gesture's starting document (so relative edits never drift), `end` makes it one undo step.

/** The open file's store. Panels read it through `usePanelState` so only the slices they name wake them. */
export const usePanelStore = (): DesignStore => useEditorServices().store;

/** `memo` comparison for sections that read the store by `ids` and ignore the host's `nodes`
 *  (fresh on every frame of a drag): they re-render only when their own values change. */
export const sameSectionProps = (a: {ids: readonly NodeId[]}, b: {ids: readonly NodeId[]}) =>
  a.ids === b.ids || (a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]));

/** `useDesignStore` on the open file's store, woken only by the document and the selection by default. */
export function usePanelState<T>(selector: (state: EditorState) => T, isEqual?: (a: T, b: T) => boolean, slice: StoreSlice | readonly StoreSlice[] = DOC_AND_SELECTION): T {
  const store = usePanelStore();
  return useDesignStore(selector, isEqual, {store, slice});
}
const DOC_AND_SELECTION: readonly StoreSlice[] = ['doc', 'selection'];

/** A section's view of its layers (`viewOf(doc, ids)`), worked out once per change: the render that follows a change
 *  reuses what the store's listener just computed, where an inline selector — a new function every render — was asked
 *  again (over a 5 000-layer selection, or on every frame of a drag). */
export function useSectionView<T>(viewOf: (doc: DesignDocument, ids: readonly NodeId[]) => T, ids: readonly NodeId[], isEqual: (a: T, b: T) => boolean): T {
  return usePanelState(useCallback((state: EditorState) => viewOf(state.doc, ids), [viewOf, ids]), isEqual);
}

/** Writes `updates` (node → fields): the nodes in `direct` are the user's own edits, the rest follow. */
export function applyUpdates(tx: Transaction, updates: NodeUpdates, direct: ReadonlySet<NodeId> | ((id: NodeId) => boolean)): void {
  const isDirect = typeof direct === 'function' ? direct : (id: NodeId) => direct.has(id);
  for (const [id, partial] of updates) {
    if (isDirect(id)) userUpdate(tx, id, partial);
    else tx.update(id, partial);
  }
}

/** Where a change comes from: a field (typed, stepped, scrubbed), a gesture the control opened with
 *  `start` (a slider drag), or a stream of changes without a clear end (the system colour picker),
 *  which `coalesce` folds into one undo step while they keep coming within a second. */
export type EditSource = NumberChangeSource | 'gesture' | 'coalesce';

export type PanelEdit = {
  /** Opens a gesture (a scrub or a slider drag begins). */
  start(label: string): void;
  /** One change: inside an open gesture it re-runs from the gesture's start; otherwise one undo step. */
  run(label: string, recipe: (tx: Transaction) => void, source?: EditSource): void;
  /** Edits each node with the fields `make` returns (null skips it). */
  nodes(label: string, ids: readonly NodeId[], make: (node: SceneNode) => Partial<SceneNode> | null, source?: EditSource): void;
  /** Ends the gesture: one undo step, or back to where it began. */
  end(cancelled?: boolean): void;
};

/** The edit helpers of one panel control (each control keeps its own gesture). */
export function usePanelEdit(): PanelEdit {
  const store = usePanelStore();
  const gesture = useRef<Gesture | null>(null);
  return useMemo<PanelEdit>(() => {
    const run: PanelEdit['run'] = (label, recipe, source) => {
      const open = gesture.current;
      if (open?.active && (source === 'scrub' || source === 'gesture')) {
        open.update(recipe);
        return;
      }
      store.transact(label, recipe, source === 'coalesce' ? {coalesce: `panel:${label}`} : undefined);
    };
    return {
      start(label) {
        if (gesture.current?.active) gesture.current.commit();
        gesture.current = store.gesture(label);
      },
      run,
      nodes(label, ids, make, source) {
        if (!ids.length) return;
        run(label, tx => {
          for (const id of ids) {
            const node = tx.get(id);
            const partial = node && make(node);
            if (partial) userUpdate(tx, id, partial);
          }
        }, source);
      },
      end(cancelled = false) {
        const open = gesture.current;
        gesture.current = null;
        if (!open?.active) return;
        if (cancelled) open.cancel();
        else open.commit();
      },
    };
  }, [store]);
}
