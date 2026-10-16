import {useSyncExternalStore} from 'react';

// Values that change many times a second (zoom while pinching, the save state while typing) reach
// the one component that shows them through a subscription, so the chrome around it never
// re-renders for them. The engine's store fits this shape: {get: () => store.getState().viewport.zoom,
// subscribe: store.subscribe}.

export type ExternalValue<T> = {get(): T; subscribe(listener: () => void): () => void};

export const useExternalValue = <T>(value: ExternalValue<T>): T => useSyncExternalStore(value.subscribe, value.get, value.get);

/** A value that never changes (placeholders, tests). */
export const constantValue = <T>(value: T): ExternalValue<T> => ({get: () => value, subscribe: () => () => {}});
