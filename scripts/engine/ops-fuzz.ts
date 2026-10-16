// Lane L2a's both-mode patch-pair fuzz through the engine switch (tests/helpers/ops-fuzz.ts): random documents, two
// concurrent edits, every ported ops function run on the TypeScript and on the Rust and compared exactly.
//
//   npx tsx scripts/engine/ops-fuzz.ts [cases=10000] [seed=1]
//
// Needs the wasm build (scripts/wasm-build.sh). Exits non-zero on the first difference (EngineDiffError names the call,
// the path and a digest of the inputs) or when a call fell back to TypeScript.
import {engineCalls, setEngine} from '../../shared/design/engine-switch';
import {fuzzComparisons, mulberry32, runCase} from '../../tests/helpers/ops-fuzz';

setEngine('ops', 'both');
const cases = Number(process.argv[2] ?? 10_000);
const seed = Number(process.argv[3] ?? 1);
const outcomes = new Map<string, number>();
const started = performance.now();
for (let i = 0; i < cases; i++) {
  const caseSeed = seed * 1_000_003 + i;
  try {
    const outcome = runCase(mulberry32(caseSeed), caseSeed);
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  } catch (error) {
    console.error(`ops fuzz: case ${i} (rng seed ${caseSeed}) failed`);
    throw error;
  }
  if ((i + 1) % 1000 === 0) console.error(`ops fuzz: ${i + 1}/${cases}, ${fuzzComparisons()} comparisons, ${((performance.now() - started) / 1000).toFixed(0)} s`);
}
const counts = engineCalls('ops');
console.log(
  `ops fuzz: ${cases} patch pairs, ${fuzzComparisons()} exact comparisons (switch: ${JSON.stringify(counts)}), outcomes ${JSON.stringify(Object.fromEntries(outcomes))}, ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
if (counts.fallback || counts.diffs) process.exit(1);
