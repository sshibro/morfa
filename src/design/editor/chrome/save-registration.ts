import {createContext, useContext, useEffect, useRef} from 'react';

// Leaving the editor must not lose the last second of work: before App unmounts the design area
// (another route, the back button) it awaits `DesignHandle.save()`. The editor registers the flush of
// its autosave here; DesignRoot answers `save()` with it. A rejected flush keeps the editor open and
// App offers "Try again" for the navigation (the same contract as the site editor's EditorHandle).

export type DesignHandle = {
  /** Resolves once everything typed so far is on the server (or there was nothing to save). */
  save(): Promise<void>;
};

export type SaveFlush = () => Promise<void>;

export const DesignSaveContext = createContext<(flush: SaveFlush | null) => void>(() => {});

/** Registers the editor's autosave flush for as long as the calling component is mounted. */
export function useDesignSave(flush: SaveFlush) {
  const register = useContext(DesignSaveContext);
  const latest = useRef(flush);
  latest.current = flush;
  useEffect(() => {
    register(() => latest.current());
    return () => register(null);
  }, [register]);
}
