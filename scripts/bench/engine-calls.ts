import {setEngine, type EngineModule} from '../../shared/design/engine-switch';
import type {Row} from './engine-core';

// The per-call bench: each named operation timed in `ts` and in
// `wasm` mode of the switch, in whatever runtime runs it (Node, or headless Chrome through scripts/bench/engine.ts
// --core <name>). A module writes scripts/bench/<module>-core.ts exporting `bench(options): Row[]` built with this:
//
//   export const bench = () => compareModes('geometry', [{name: 'worldBox', run: i => worldBox(doc, ids[i % n])}]);

export type BenchCase = {name: string; run: (i: number) => unknown; prepare?: () => void};

/** `run` repeated for about `ms`: ns per call (best of `rounds`). */
export function nsPerCall(run: (i: number) => unknown, ms = 200, rounds = 3): number {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    let calls = 0;
    const started = performance.now();
    let elapsed = 0;
    while (elapsed < ms / rounds) {
      for (let i = 0; i < 256; i++) run(calls + i);
      calls += 256;
      elapsed = performance.now() - started;
    }
    best = Math.min(best, (elapsed * 1e6) / calls);
  }
  return best;
}

/** Every case in ts then wasm: rows `module.case (ts)`, `(wasm)` and the speed-up (ts ÷ wasm). */
export function compareModes(module: EngineModule, cases: readonly BenchCase[], options: {ms?: number} = {}): Row[] {
  const rows: Row[] = [];
  for (const each of cases) {
    const times: Record<'ts' | 'wasm', number> = {ts: 0, wasm: 0};
    for (const mode of ['ts', 'wasm'] as const) {
      const restore = setEngine(module, mode);
      try {
        each.prepare?.();
        times[mode] = nsPerCall(each.run, options.ms);
      } finally {
        restore();
      }
      rows.push({name: `${module}: ${each.name} (${mode})`, value: times[mode], unit: 'ns/call'});
    }
    rows.push({name: `${module}: ${each.name} speed-up`, value: times.ts / times.wasm, unit: '× ts', note: times.ts > times.wasm ? 'wasm faster' : 'ts faster'});
  }
  return rows;
}
