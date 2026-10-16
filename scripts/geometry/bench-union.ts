// Lane G tooling: combinePaths UNION on dumped operand sets (scripts/geometry/dump-operands.ts) in TypeScript and in
// the WASM build (scripts/geometry/build.sh), median of `runs`, and whether both answers are the same to the bit; then
// the live-drawing union in WASM (combinePathsLive) and its symmetric difference with TypeScript's over the box.
//   npx tsx scripts/geometry/bench-union.ts <ops.json>... [--runs 9]
import {readFileSync} from 'node:fs';
import type {VectorPath} from '../../shared/design/types';
import * as B from '../../shared/design/boolean';
import * as W from './wasm-geometry';

const args = process.argv.slice(2);
const at = args.indexOf('--runs');
const runs = at >= 0 ? Number(args[at + 1]) : 9;
const files = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));

function median(run: () => unknown): number {
  run();
  const samples: number[] = [];
  for (let k = 0; k < runs; k++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

for (const file of files) {
  const ops = JSON.parse(readFileSync(file, 'utf8')) as VectorPath[][];
  const same = JSON.stringify(B.combinePaths('UNION', ops, 0.01)) === JSON.stringify(W.combinePaths('UNION', ops, 0.01));
  const ts = median(() => B.combinePaths('UNION', ops, 0.01));
  const wasm = median(() => W.combinePaths('UNION', ops, 0.01));
  const live = median(() => W.combinePathsLive('UNION', ops, 0.01));
  // Against the exact WASM answer (TypeScript's to the bit, and never cut short by the time budget on a slow machine).
  const d = B.liveAreaDifference(W.combinePaths('UNION', ops, 0.01), W.combinePathsLive('UNION', ops, 0.01), 0.01);
  console.log(`${file.split('/').pop()?.padEnd(16)} TS ${ts.toFixed(1).padStart(7)} ms   WASM ${wasm.toFixed(1).padStart(7)} ms   bit-identical: ${same}   live WASM ${live.toFixed(1).padStart(6)} ms, △ ${(d.symmetric / d.boxArea).toExponential(2)} of the box, areas ${(Math.abs(d.areaA - d.areaB) / d.areaA).toExponential(2)} apart`);
}
