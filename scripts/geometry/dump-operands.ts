// Lane G tooling: writes the boolean bench operands as JSON for `crates/geometry/examples/bool_bench.rs`, with the
// TypeScript union's digest beside them. Sets: `l1` (scripts/bench/geometry.ts, 200 operands, TARGETS E4) and `core`
// (scripts/bench/modules-core.ts, 100 operands) and `bool200` (scripts/bench/gen-file.ts, the edit-ops E4 file).
//   npx tsx scripts/geometry/dump-operands.ts <l1|core|bool200> <count> <out.json>
import {writeFileSync} from 'node:fs';
import type {PathCommand, VectorPath} from '../../shared/design/types';
import * as P from '../../shared/design/paths';
import * as S from '../../shared/design/shapes';
import * as G from '../../shared/design/geometry';
import {createNode} from '../../shared/design/defaults';
import {mulberry32, randomPathData} from './fuzz-docs';
import {shapesFile} from '../bench/gen-file';

const [set, countArg, out] = process.argv.slice(2);
const count = Number(countArg);
const closed = (commands: PathCommand[]): PathCommand[] => (commands.length && commands[commands.length - 1].type !== 'Z' ? [...commands, {type: 'Z'}] : commands);

function l1(seed: number): VectorPath[][] {
  const r = mulberry32(seed);
  const ops: VectorPath[][] = [];
  for (let k = 0; k < count; k++) {
    const x = r() * 900, y = r() * 900, w = 20 + r() * 160, h = 20 + r() * 160;
    const kind = Math.floor(r() * 5);
    const node = createNode(['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON', 'VECTOR'][kind] as 'RECTANGLE', {
      id: `o${k}`, x, y, width: w, height: h, rotation: r() * 360 - 180,
      cornerRadius: kind === 0 || kind === 3 ? r() * 30 : undefined, pointCount: kind === 2 || kind === 3 ? 3 + Math.floor(r() * 6) : undefined,
      arcData: kind === 1 && r() < 0.3 ? {startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5} : undefined,
      vectorPaths: kind === 4 ? [{windingRule: 'NONZERO', commands: closed(P.parsePathData(randomPathData(r, 80, false)))}] : undefined,
    });
    ops.push(P.transformPaths(S.nodeGeometry(node), G.localMatrix(node)));
  }
  return ops;
}

function core(seed: number): VectorPath[][] {
  const r = mulberry32(seed);
  const ops: VectorPath[][] = [];
  for (let k = 0; k < count; k++) {
    const kind = Math.floor(r() * 5);
    const node = createNode(['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON', 'VECTOR'][kind] as 'RECTANGLE', {
      id: `o${k}`, x: r() * 900, y: r() * 900, width: 20 + r() * 160, height: 20 + r() * 160, rotation: r() * 360 - 180,
      cornerRadius: kind === 0 || kind === 3 ? r() * 30 : undefined, pointCount: kind === 2 || kind === 3 ? 3 + Math.floor(r() * 6) : undefined,
      vectorPaths: kind === 4 ? [{windingRule: 'NONZERO', commands: closed(P.parsePathData(randomPathData(r, 80, false)))}] : undefined,
    });
    ops.push(P.transformPaths(S.nodeGeometry(node), G.localMatrix(node)));
  }
  return ops;
}

function bool200(): VectorPath[][] {
  const doc = shapesFile(count, 1);
  return (doc.nodes.board.children ?? []).map(id => P.transformPaths(S.nodeGeometry(doc.nodes[id]), G.localMatrix(doc.nodes[id])));
}

writeFileSync(out, JSON.stringify(set === 'core' ? core(7) : set === 'bool200' ? bool200() : l1(7)));
