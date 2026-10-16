import {useEffect, useMemo} from 'react';
import type {NodeId, Paint, SceneNode} from '../../../../../shared/design/types';
import type {Transaction} from '../../../../../shared/design/transaction';
import type {DesignStore, Gesture} from '../../../engine/store';
import {useStoreApi} from '../../../engine/useDesignStore';
import {userUpdate} from '../../../engine/user-edit';
import {refillRange} from '../../../engine/text-editor/style-ops';
import type {PaintField} from './paints';

// How the paint panel writes: one transaction per discrete edit (a click, a typed value), one store
// gesture per drag (the picker's area and sliders, scrubbing, a stop) whose frames are coalesced to
// animation frames, so a fast pointer never runs normalization more than once a frame and the whole
// drag is one undo step. Changes are absolute (they set values, never add to them): a gesture re-runs
// the latest one from the document it started on.

export type Recipe = (tx: Transaction) => void;
/** A change that writes on its own (the text commands' `applyTextOp`): given the open gesture it
 *  shows a frame of it, without one it makes its own undo step. */
export type Runner = {run: (gesture: Gesture | null, label: string) => void};
export type Change = Recipe | Runner;

export interface Committer {
  /** One step now, or the next frame of the open gesture. */
  set(label: string, change: Change): void;
  /** Opens a gesture; `set` feeds it until `end`. */
  begin(label: string): void;
  /** Commits the gesture (one undo step). */
  end(): void;
  /** Puts the document back as it was before the gesture. */
  cancel(): void;
  readonly active: boolean;
}

export function createCommitter(store: DesignStore): Committer {
  let gesture: Gesture | null = null;
  let pending: {label: string; change: Change} | null = null;
  let frame = 0;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback: () => void) => setTimeout(callback, 16) as unknown as number;
  const unraf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id: number) => clearTimeout(id);
  const flush = () => {
    frame = 0;
    const next = pending;
    pending = null;
    if (!next || !gesture?.active) return;
    if (typeof next.change === 'function') gesture.update(next.change);
    else next.change.run(gesture, next.label);
  };
  return {
    get active() {
      return !!gesture?.active;
    },
    set(label, change) {
      if (gesture?.active) {
        pending = {label, change};
        if (!frame) frame = raf(flush);
        return;
      }
      if (typeof change === 'function') store.transact(label, change);
      else change.run(null, label);
    },
    begin(label) {
      if (gesture?.active) return;
      gesture = store.gesture(label);
    },
    end() {
      if (frame) unraf(frame);
      flush();
      gesture?.commit();
      gesture = null;
    },
    cancel() {
      if (frame) unraf(frame);
      frame = 0;
      pending = null;
      gesture?.cancel();
      gesture = null;
    },
  };
}

/** A committer for a component's lifetime; an open gesture is committed when it unmounts. */
export function useCommitter(): Committer {
  const store = useStoreApi();
  const committer = useMemo(() => createCommitter(store), [store]);
  useEffect(() => () => committer.end(), [committer]);
  return committer;
}

// ── Writing paint lists ──────────────────────────────────────────────────────────────────────────

/** Rewrites the list of every node with `make` (null leaves a node alone), as a hand edit. A text's fills cover
 *  all of it: words coloured on their own take the new fills too (the text commands' whole-text refill), as in
 *  Figma when a text is filled together with other layers. */
export function writePaints(tx: Transaction, ids: readonly NodeId[], field: PaintField, make: (paints: Paint[], node: SceneNode) => Paint[] | null): void {
  for (const id of ids) {
    const node = tx.get(id);
    if (!node) continue;
    const next = make(node[field], node);
    if (!next) continue;
    if (field === 'fills' && node.type === 'TEXT' && node.text) {
      const patch = refillRange(node, 0, node.text.characters.length, next);
      if (patch) userUpdate(tx, id, patch);
    } else userUpdate(tx, id, {[field]: next});
  }
}
