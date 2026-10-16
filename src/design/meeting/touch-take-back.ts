import type {DesignStore} from '../engine/store';

// Taking a vote back by touch on a board (lane PH): a finger has no ⌥, so the voting bar's "Remove vote" (ui/CanvasLayer.tsx)
// makes the next taps on an object take one of your votes back (board-adapter.ts). One switch per editor (store).

const takingBack = new WeakMap<DesignStore, boolean>();

export const voteTakesBack = (store: DesignStore): boolean => takingBack.get(store) ?? false;

export function setVoteTakesBack(store: DesignStore, on: boolean): void {
  takingBack.set(store, on);
}
