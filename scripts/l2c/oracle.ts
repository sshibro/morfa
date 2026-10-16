// S2's shared stage oracle (tests/helpers/stage-diff.ts `stageDiff`, through the shadow's `normalize_stage`) on lane
// L2c's two stages: S2's fuzzed documents and edits, the dirty ids each edit's patch touches.
//
//   npx tsx scripts/l2c/oracle.ts [--docs 200] [--edits 20]

import {fuzzDocument, fuzzEdit} from '../../tests/helpers/design-fuzz';
import {stageDiff} from '../../tests/helpers/stage-diff';

const argv = process.argv.slice(2);
const option = (name: string, fallback: number) => (argv.includes('--' + name) ? Number(argv[argv.indexOf('--' + name) + 1]) : fallback);
const DOCS = option('docs', 200), EDITS = option('edits', 20);
let runs = 0, differences = 0;
for (let d = 0; d < DOCS; d++) {
  const base = fuzzDocument(4_000_037 + d, {nodes: 300});
  for (let k = 0; k <= EDITS; k++) {
    const {doc, patch} = k ? fuzzEdit(base, d * 1000 + k) : {doc: base, patch: {nodes: base.nodes}};
    const dirty = new Set([...Object.keys(patch.nodes ?? {}), ...Object.keys(patch.variables ?? {}), ...Object.keys(patch.variableModes ?? {})]);
    for (const name of ['instances', 'variables'] as const) {
      runs++;
      const diff = stageDiff(name, doc, dirty);
      if (diff.path !== null && ++differences <= 10) console.log(diff.message);
    }
  }
}
console.log(`oracle: ${runs} stage runs on ${DOCS} documents, ${differences} differences`);
if (differences) process.exit(1);
