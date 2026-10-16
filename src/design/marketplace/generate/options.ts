// "Generation"'s choices, one set per editor (per store), kept while the tab closes and opens again or another card is selected: the
// brand kit and the batch's size. Not saved anywhere: a new editor starts from the defaults.

import {useSyncExternalStore} from 'react';
import {VARIANT_COUNT} from '../../../../shared/design/marketplace/generation';
import type {DesignStore} from '../../engine/store';

export type GenerateOptions = {
  /** The chosen brand kit's id; null: none chosen yet (the last changed kit is used), 'none': without a kit. */
  kitId: string | null;
  /** The variant batch: how many. */
  count: number;
};

export const DEFAULT_OPTIONS: GenerateOptions = {kitId: null, count: VARIANT_COUNT.default};

type OptionsStore = {get: () => GenerateOptions; set: (change: Partial<GenerateOptions>) => void; subscribe: (listener: () => void) => () => void};
const stores = new WeakMap<DesignStore, OptionsStore>();

function optionsStore(store: DesignStore): OptionsStore {
  let found = stores.get(store);
  if (found) return found;
  let value = DEFAULT_OPTIONS;
  const listeners = new Set<() => void>();
  found = {
    get: () => value,
    set(change) {
      value = {...value, ...change};
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  stores.set(store, found);
  return found;
}

/** The editor's choices and a setter. */
export function useGenerateOptions(store: DesignStore): [GenerateOptions, (change: Partial<GenerateOptions>) => void] {
  const options = optionsStore(store);
  return [useSyncExternalStore(options.subscribe, options.get), options.set];
}
