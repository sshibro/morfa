// The Performance Loop's clock: every instant it writes (publications' live hours, tests' swaps and ends, syncs) is read here, so the
// e2e server can move a two-week rotation forward in seconds (scripts/e2e-server.ts). Only a test process may move it.

let offsetMs = 0;

/** Now, as the loop counts it (ms). */
export const loopNow = (): number => Date.now() + offsetMs;
export const loopDate = (): Date => new Date(loopNow());

/** Moves the loop's clock forward by `ms` (tests and the e2e server only). */
export function advanceLoopClock(ms: number): void {
  if (process.env.NODE_ENV !== 'test') throw Error('The loop clock moves in tests only.');
  offsetMs += ms;
}
