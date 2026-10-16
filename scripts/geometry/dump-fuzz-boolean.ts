// Lane G tooling: writes one fuzz document's boolean operands (scripts/geometry/diff.ts's randomDocument) as JSON for
// crates/geometry/examples/live_check.rs, with the boolean's operation and tolerance.
//   npx tsx scripts/geometry/dump-fuzz-boolean.ts <seed> <node id> <out.json>
import {writeFileSync} from 'node:fs';
import * as P from '../../shared/design/paths';
import * as S from '../../shared/design/shapes';
import * as G from '../../shared/design/geometry';
import * as B from '../../shared/design/boolean';
import {randomDocument} from './fuzz-docs';

const [seed, id, out] = process.argv.slice(2);
const doc = randomDocument(Number(seed), d => P.parsePathData(d));
const node = doc.nodes[id];
const operands = (node.children ?? []).map(c => doc.nodes[c]).filter(c => c && c.visible && c.type !== 'BOOLEAN_OPERATION' && c.type !== 'GROUP')
  .map(c => P.transformPaths(S.nodeGeometry(c), G.localMatrix(c)));
writeFileSync(out, JSON.stringify(operands));
console.log(`${node.booleanOperation} of ${operands.length}, tolerance ${B.booleanTolerance(node.width, node.height)}`);
