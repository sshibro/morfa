import {useEffect, useRef, useState} from 'react';
import type {SaveState} from './FileTitle';

// What the title shows of autosave (FileTitle.tsx). Autosave saves about a second after each change, so the raw state
// flipped "Saved" ↔ "Saving…" on every edit and the title flickered; Figma shows nothing while saves are quick.
// "Saving…" now shows only once a save has waited `delayMs`, or at once when it follows trouble (no connection, a
// stopped save) or is a retry after a failed request; "Saved" stays steady otherwise. Every other state — "Offline",
// "Not saved", "View only", and "Saved" when a save lands — shows at once.

/** How long a save may run before the title says so. */
export const SAVING_DELAY_MS = 1500;

type Timers = {setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void};

export type SaveIndicator = {
  /** The state autosave is in; `urgent` for a save that is a retry after a failed request. */
  set(state: SaveState, urgent?: boolean): void;
  readonly shown: SaveState;
  dispose(): void;
};

export function createSaveIndicator(initial: SaveState, options: {onChange: (shown: SaveState) => void; delayMs?: number; timers?: Timers}): SaveIndicator {
  const delayMs = options.delayMs ?? SAVING_DELAY_MS;
  const timers: Timers = options.timers ?? {setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: handle => globalThis.clearTimeout(handle as number)};
  let shown: SaveState = initial === 'saving' ? 'saved' : initial;
  let timer: unknown = null;
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const show = (next: SaveState) => {
    clear();
    if (next === shown) return;
    shown = next;
    options.onChange(next);
  };
  return {
    set(state, urgent = false) {
      if (state !== 'saving' || urgent || shown !== 'saved') return show(state);
      // A save from a steady "Saved": said only if it is still running after the delay.
      if (timer === null) timer = timers.setTimeout(() => {
        timer = null;
        show('saving');
      }, delayMs);
    },
    get shown() {
      return shown;
    },
    dispose: clear,
  };
}

/** `state` as the title shows it (see above). */
export function useSteadySaveState(state: SaveState, urgent = false, delayMs = SAVING_DELAY_MS): SaveState {
  const [shown, setShown] = useState<SaveState>(state === 'saving' && !urgent ? 'saved' : state);
  const indicator = useRef<SaveIndicator | null>(null);
  indicator.current ??= createSaveIndicator(shown, {onChange: setShown, delayMs});
  useEffect(() => {
    indicator.current!.set(state, urgent);
  }, [state, urgent]);
  useEffect(() => () => indicator.current?.dispose(), []);
  return shown;
}
