import {EngineDiffError, engineCalls, firstDifference, resetEngineCalls, resetShadow, setEngine, shadowFor, valueAt} from '../../shared/design/engine-switch';
import {normalizeDetailed} from '../../shared/design/normalize';
import type {DesignDocument} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';
import {fuzzCommits, fuzzDocument} from '../../tests/helpers/design-fuzz';

// Lane S2: the normalize flip's differential run. normalize.ts `normalizeDetailed` in `both` mode (TypeScript, then
// crates/layout/src/normalize.rs on the shadow, compared entry by entry) on fuzzed documents (tests/helpers/
// design-fuzz.ts): each whole (every id dirty, no origin: the shadow brought to the document; once more with a
// measurer that is not the fixed-width fake, which Rust asks through JavaScript), then through fuzzed
// commits (transactions: the shadow at the base, the transaction's writes as a patch), and heavyPage() and
// productFile() whole. Any difference is printed with its seed; exit 1 on a difference or when nothing reached Rust.
//
//   npx tsx scripts/engine/normalize-flip.ts [--seeds 200] [--nodes 300] [--commits 10] [--wasm-path]
//
// `--wasm-path` (lane E1) also runs each seed's commits in `wasm` mode, the shadow following each committed document
// (its state carried between calls: the normalize's own final nodes taken back by `apply_patch_with`, the converted
// nodes and text layouts kept), and compares every step's document with the same commits in `ts` mode: `both` never
// takes that path (it returns TypeScript's objects, so the shadow never keeps Rust's).

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const SEEDS = option('--seeds', 200), NODES = option('--nodes', 300), COMMITS = option('--commits', 10);

setEngine('*', 'ts');
setEngine('normalize', 'both');
resetEngineCalls();
const diffs: string[] = [];
const run = (label: string, work: () => void) => {
  try {
    work();
  } catch (error) {
    if (!(error instanceof EngineDiffError)) throw error;
    diffs.push(`${label}: ${error.message}`);
  }
};
const whole = (doc: DesignDocument, measurer: TextMeasurer = testMeasurer) => normalizeDetailed(doc, new Set(Object.keys(doc.nodes)), {measurer});
/** A measurer that is not the fixed-width fake (lane E1): widths by character, weight and slant, with a revision, so
 *  Rust measures through it (normalize.ts `measurerFunction`) instead of with its own fake. */
const oddMeasurer: TextMeasurer = {
  revision: 1,
  width: (text, font) => {
    let width = 0;
    for (let i = 0; i < text.length; i++) width += (((text.charCodeAt(i) * 7) % 13) + 3) / 16;
    return width * font.size * (font.weight > 500 ? 1.1 : 1) * (font.italic ? 0.97 : 1);
  },
  metrics: font => ({ascent: font.size * 0.77, descent: font.size * 0.23}),
};

const wellFormed = (_: string, value: unknown) => (typeof value === 'string' ? (value as string & {toWellFormed(): string}).toWellFormed() : value);
const plain = (doc: DesignDocument): DesignDocument => JSON.parse(JSON.stringify(doc), wellFormed) as DesignDocument;
const firstNodeDifference = (a: DesignDocument, b: DesignDocument): string | null => {
  const ids = new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)]);
  for (const id of ids) {
    const path = firstDifference(a.nodes[id] ?? null, b.nodes[id] ?? null, 0, `.nodes[${JSON.stringify(id)}]`);
    if (path !== null) return `${path}: ts ${JSON.stringify(valueAt(a, path))}, wasm ${JSON.stringify(valueAt(b, path))}`;
  }
  return firstDifference(a.variableModes ?? {}, b.variableModes ?? {}, 0, '.variableModes');
};
let wasmPathSteps = 0;
const wasmPath = (seed: number, doc: DesignDocument) => {
  const chain = (mode: 'ts' | 'wasm') => {
    const restore = setEngine('normalize', mode);
    try {
      resetShadow();
      const docs: DesignDocument[] = [];
      let last: DesignDocument | null = null;
      for (const step of fuzzCommits(doc, COMMITS, seed)) {
        docs.push(step.doc);
        if (mode === 'wasm') shadowFor(step.doc);
        last = step.doc;
      }
      // Lane N1: the shadow took the normalize's own results back without JSON (`apply_patch_with`, the store path
      // replays a journal entry); after the chain it must hold exactly the store's document.
      if (mode === 'wasm' && last) {
        const held = JSON.parse(shadowFor(last).to_json()) as DesignDocument;
        // Compared as plain JSON: −0 is 0 and a lone UTF-16 surrogate is U+FFFD on both sides (S1's documented
        // difference: the model cannot hold one), as the stage oracle compares.
        const path = firstNodeDifference(plain(last), held);
        if (path !== null) diffs.push(`seed ${seed} shadow after the wasm path: ${path}`);
      }
      return docs;
    } finally {
      restore();
    }
  };
  const ts = chain('ts'), wasm = chain('wasm');
  for (let step = 0; step < ts.length; step++) {
    wasmPathSteps++;
    const path = firstNodeDifference(ts[step], wasm[step]);
    if (path !== null) return void diffs.push(`seed ${seed} wasm path step ${step}: ${path}`);
  }
};

const started = performance.now();
for (let seed = 1; seed <= SEEDS; seed++) {
  resetShadow();
  const doc = fuzzDocument(seed, {nodes: NODES});
  run(`seed ${seed} whole`, () => whole(doc));
  run(`seed ${seed} whole, measured through JavaScript`, () => whole(doc, oddMeasurer));
  shadowFor(doc);
  run(`seed ${seed} commits`, () => {
    for (const _ of fuzzCommits(doc, COMMITS, seed));
  });
  if (args.includes('--wasm-path')) wasmPath(seed, doc);
}
for (const [label, make] of [
  ['heavyPage', heavyPage],
  ['productFile', () => productFile()],
] as const) {
  resetShadow();
  const doc = make();
  run(label, () => whole(doc));
  run(`${label}, measured through JavaScript`, () => whole(doc, oddMeasurer));
}
const calls = engineCalls('normalize');
console.log(
  `normalize flip: ${SEEDS} fuzzed documents × (whole + ${COMMITS} commits) + heavyPage + productFile in ${((performance.now() - started) / 1000).toFixed(1)} s: ` +
    `${calls.both} compared, ${calls.fallback} fallbacks, ${diffs.length} diffs` +
    (args.includes('--wasm-path') ? `; wasm path: ${wasmPathSteps} commits compared` : ''),
);
for (const line of diffs.slice(0, 20)) console.log(`  ${line}`);
process.exit(diffs.length || !calls.both ? 1 : 0);
