import {useSyncExternalStore} from 'react';
import type {NodeId} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';

// What the "Prototype" tab and the connections on the canvas share and nothing saves: which
// interaction is open (a click on a noodle opens it in the panel). One per open file's store.

export type InteractionRef = {nodeId: NodeId; reactionIndex: number};
export type PrototypeUiState = {
  /** The interaction whose details are open. */
  open: InteractionRef | null;
  /** The connection under the pointer on the canvas. */
  hover: InteractionRef | null;
};

export interface PrototypeUi {
  get(): PrototypeUiState;
  set(partial: Partial<PrototypeUiState>): void;
  subscribe(listener: () => void): () => void;
}

const uis = new WeakMap<DesignStore, PrototypeUi>();
const sameRef = (a: InteractionRef | null, b: InteractionRef | null) => a === b || (!!a && !!b && a.nodeId === b.nodeId && a.reactionIndex === b.reactionIndex);

export function prototypeUi(store: DesignStore): PrototypeUi {
  let ui = uis.get(store);
  if (ui) return ui;
  let state: PrototypeUiState = {open: null, hover: null};
  const listeners = new Set<() => void>();
  ui = {
    get: () => state,
    set(partial) {
      const next = {...state, ...partial};
      if (sameRef(next.open, state.open) && sameRef(next.hover, state.hover)) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  uis.set(store, ui);
  return ui;
}

/** The open interaction only: hovering curves on the canvas does not re-render the panel. */
export function useOpenInteraction(store: DesignStore): InteractionRef | null {
  const ui = prototypeUi(store);
  const open = () => ui.get().open;
  return useSyncExternalStore(ui.subscribe, open, open);
}
