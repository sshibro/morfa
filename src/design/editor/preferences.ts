import {useSyncExternalStore} from 'react';
import type {EditorUI} from '../engine/store';

// The designer's own settings in this browser (Figma's "Preferences"): nudge steps, snapping, the size
// badge on hover, the view toggles that survive a reload, and the quick actions used last. They are
// conveniences, so they live in localStorage and the editor works the same when storage is blocked.
// The theme has its own store (ui/theme.ts) because the file browser reads it too.

export type Preferences = {
  /** Arrow keys move the selection by this many px… */
  nudgeSmall: number;
  /** …and by this many with Shift held. */
  nudgeLarge: number;
  /** Smart guides: edges and centres of other layers attract a dragged selection. */
  snapToObjects: boolean;
  /** "Show sizes on hover": a size badge under the hovered layer. */
  hoverSizes: boolean;
  /** "Property labels" (the zoom menu, Figma's Property labels): captions over the "Design" panel's fields. Off, as in Figma. */
  propertyLabels: boolean;
  /** View toggles kept between visits (View ▸). */
  view: Pick<EditorUI, 'pixelGrid' | 'snapToPixel' | 'layoutGrids' | 'rulers' | 'pixelPreview' | 'minimizeUI' | 'multiplayerCursors'>;
  /** Quick actions run last, newest first. */
  recentCommands: string[];
};

export const DEFAULT_PREFERENCES: Preferences = {
  nudgeSmall: 1,
  nudgeLarge: 10,
  snapToObjects: true,
  hoverSizes: false,
  propertyLabels: false,
  view: {pixelGrid: true, snapToPixel: true, layoutGrids: true, rulers: false, pixelPreview: false, minimizeUI: false, multiplayerCursors: true},
  recentCommands: [],
};

const KEY = 'morfa-design-preferences';
const RECENT_LIMIT = 8;
const NUDGE_MAX = 1000;

const listeners = new Set<() => void>();
let current: Preferences | null = null;

const finiteStep = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(NUDGE_MAX, Math.round(value * 100) / 100) : fallback;
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** Reads stored preferences, keeping only well-formed values (anything else falls back to the default). */
export function parsePreferences(raw: unknown): Preferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const view = (value.view && typeof value.view === 'object' ? value.view : {}) as Record<string, unknown>;
  const defaults = DEFAULT_PREFERENCES;
  return {
    nudgeSmall: finiteStep(value.nudgeSmall, defaults.nudgeSmall),
    nudgeLarge: finiteStep(value.nudgeLarge, defaults.nudgeLarge),
    snapToObjects: flag(value.snapToObjects, defaults.snapToObjects),
    hoverSizes: flag(value.hoverSizes, defaults.hoverSizes),
    propertyLabels: flag(value.propertyLabels, defaults.propertyLabels),
    view: {
      pixelGrid: flag(view.pixelGrid, defaults.view.pixelGrid),
      snapToPixel: flag(view.snapToPixel, defaults.view.snapToPixel),
      layoutGrids: flag(view.layoutGrids, defaults.view.layoutGrids),
      rulers: flag(view.rulers, defaults.view.rulers),
      pixelPreview: flag(view.pixelPreview, defaults.view.pixelPreview),
      minimizeUI: flag(view.minimizeUI, defaults.view.minimizeUI),
      multiplayerCursors: flag(view.multiplayerCursors, defaults.view.multiplayerCursors),
    },
    recentCommands: Array.isArray(value.recentCommands)
      ? value.recentCommands.filter((id): id is string => typeof id === 'string' && id.length < 100).slice(0, RECENT_LIMIT)
      : [],
  };
}

function read(): Preferences {
  try {
    const stored = localStorage.getItem(KEY);
    return parsePreferences(stored ? JSON.parse(stored) : null);
  } catch {
    return parsePreferences(null);
  }
}

export const getPreferences = (): Preferences => (current ??= read());

export function setPreferences(partial: Partial<Preferences>) {
  const next = parsePreferences({...getPreferences(), ...partial});
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: the choice holds for this visit.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const usePreferences = (): Preferences => useSyncExternalStore(subscribePreferences, getPreferences, getPreferences);

/** Puts a command at the front of "recent" in quick actions. */
export function rememberCommand(id: string) {
  const recent = getPreferences().recentCommands;
  if (recent[0] === id) return;
  setPreferences({recentCommands: [id, ...recent.filter(each => each !== id)].slice(0, RECENT_LIMIT)});
}

/** Test hook: forget the cached copy (the next read goes to storage again). */
export function resetPreferencesCache() {
  current = null;
}

/** Whether the "Design" panel shows its property captions ("Property labels"). */
export const usePropertyLabels = (): boolean => usePreferences().propertyLabels;
