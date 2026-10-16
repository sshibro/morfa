// "Board" (docs/board.md §Meeting slot): features that plug into the board editor from their own modules. The board calls
// `loadBoardFeatures()` once it shows; each entry is a lazy import, so a feature's code stays out of the board's chunk and
// out of the editor's first load. A feature's module registers itself when it loads (the meeting module calls
// `registerBoardMeeting` from ./meeting). One line per feature, below.

const FEATURES: (() => Promise<unknown>)[] = [
  // "Meeting": timer with music, voting, emotes, cursor chat, spotlight, high five (docs/board-meeting.md).
  () => import('../meeting/board'),
];

let loading: Promise<void> | null = null;

/** Loads every registered feature once; a feature that fails to load (offline) leaves the board working without it. */
export function loadBoardFeatures(): Promise<void> {
  return (loading ??= Promise.all(FEATURES.map(load => load().catch(() => undefined))).then(() => undefined));
}
