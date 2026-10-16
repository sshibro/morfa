// Lane L1 tooling: writes the bench's 1 000 dashed strokeArea cases (scripts/bench/geometry.ts `dashedPaths`, seed 11)
// as JSON for crates/geometry/examples/stroke_case.rs (native profiling).
import {writeFileSync} from 'node:fs';
import * as P from '../../shared/design/paths';
import {mulberry32, randomPathData} from './fuzz-docs';

const r = mulberry32(11);
const cases = [];
for (let k = 0; k < 1000; k++) {
  const commands = P.parsePathData(randomPathData(r, 150, false)).filter(c => c.type !== 'Z');
  cases.push({
    id: k,
    geometry: [{windingRule: 'NONZERO', commands}],
    style: {
      weight: [1, 2, 4, 8][Math.floor(r() * 4)], align: 'CENTER', cap: ['NONE', 'ROUND', 'SQUARE'][Math.floor(r() * 3)],
      join: ['MITER', 'BEVEL', 'ROUND'][Math.floor(r() * 3)], miterLimit: 4, dashPattern: [[10, 5], [4, 4], [20, 8, 4, 8]][Math.floor(r() * 3)],
    },
    start: 'NONE',
    end: 'NONE',
  });
}
writeFileSync(process.argv[2] ?? 'dashed.json', JSON.stringify(cases));
