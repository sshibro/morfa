import {createContext, createElement, useCallback, useContext, useRef, useSyncExternalStore, type ReactNode} from 'react';
import type {DesignStore, EditorState, StoreSlice} from './store';

// React access to the design store. Components read a slice of the state through a selector; a
// change re-renders a component only when its selected value changes (by `isEqual`). Passing
// `slice` narrows which changes even run the selector: a panel that reads the document passes
// 'doc' (and 'selection'), so panning and zooming never touch it, and a drag only re-renders the
// panels whose values actually move.

const StoreContext = createContext<DesignStore | null>(null);

export function DesignStoreProvider({store, children}: {store: DesignStore; children?: ReactNode}) {
  return createElement(StoreContext.Provider, {value: store}, children);
}

export function useStoreApi(): DesignStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStoreApi() needs a <DesignStoreProvider>');
  return store;
}

/** The store when one is provided; null in a chrome rendered on its own (a test of the layout). */
export function useOptionalStoreApi(): DesignStore | null {
  return useContext(StoreContext);
}

/** Equal when both are the same, or arrays/plain objects with the same entries by identity. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const keysA = Object.keys(a), keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every(key => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export type UseDesignStoreOptions = {
  /** Only these changes run the selector. Default: every change. */
  slice?: StoreSlice | readonly StoreSlice[];
  /** A store outside the provider (the canvas passes its own). */
  store?: DesignStore;
};

export function useDesignStore<T>(selector: (state: EditorState) => T, isEqual: (a: T, b: T) => boolean = Object.is, options: UseDesignStoreOptions = {}): T {
  const provided = useContext(StoreContext);
  const store = options.store ?? provided;
  if (!store) throw new Error('useDesignStore() needs a <DesignStoreProvider> or a store');
  const {slice} = options;
  const sliceKey = slice === undefined ? '*' : typeof slice === 'string' ? slice : slice.join(',');
  // `sliceKey` stands for the slice list, which callers usually pass as a fresh array literal.
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener, {slice}), [store, sliceKey]);
  const memo = useRef<{state: EditorState; selector: (state: EditorState) => T; value: T} | null>(null);
  const getSnapshot = () => {
    const state = store.getState();
    const last = memo.current;
    if (last && last.state === state && last.selector === selector) return last.value;
    const value = selector(state);
    if (last && isEqual(last.value, value)) {
      memo.current = {state, selector, value: last.value};
      return last.value;
    }
    memo.current = {state, selector, value};
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
