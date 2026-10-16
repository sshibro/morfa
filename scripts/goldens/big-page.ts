// One big page through the renderer's document (the one-page f500k is for the renderer-and-store
// work): a generated page of N layers (the bench files' shape) loaded into crates/render-wasm's RenderDoc (the nodejs
// build, vello_cpu) — how long the load, a first bounds sync, a tile-sized render at 1× and at the overview zoom, a
// 1440 × 900 view at 25 %, one patch and its bounds sync take, and what it holds in memory. Where the time goes at
// 500 000 layers is what C3/C11 on the Mac's GPU will meet on the store's side too (the shadow document is the same).
//
//   npx tsx scripts/goldens/big-page.ts [--layers 20041,100000,500000] [--out output/big-page]
//
// Needs the nodejs build (scripts/wasm-render-build.sh). Numbers from a cloud container are provisional (the load
// average is written beside them).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderWasm, renderWasmAvailable} from '../../shared/design/render-engine';
import {engineWasm} from '../../shared/design/engine-switch';
import {generatedPage} from './fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const layersList = arg('layers', '20041,100000,500000').split(',').map(Number);
const out = path.resolve(arg('out', 'output/big-page'));

type Row = {layers: number; nodes: number; jsonMb: number; buildMs: number; loadMs: number; bytesMb: number; encodeMs: number; decodeMs: number; wasmBytesMb: number; wasmJsonMb: number; boundsMs: number; blurMarginMs: number; firstTileMs: number; tile1xMs: number; tileAfterPatchMs: number; tileQuarterMs: number; viewQuarterMs: number; viewQuarterNodes: number; patchMs: number; rePatchBoundsMs: number; wasmStats: unknown; rssMb: number};

const ms = (started: number) => Math.round((performance.now() - started) * 10) / 10;

async function main(): Promise<void> {
  if (!renderWasmAvailable()) throw new Error('server/design/wasm-render is missing: run scripts/wasm-render-build.sh');
  const {RenderDoc} = renderWasm();
  const rows: Row[] = [];
  console.log(`big-page: nodejs build of crates/render-wasm (vello_cpu); load ${os.loadavg().map(l => l.toFixed(1)).join(' ')}`);
  console.log(['layers', 'nodes', 'JSON MB', 'build ms', 'load ms', 'bytes MB', 'encode ms', 'decode ms', 'wasm MB after bytes', 'wasm MB after JSON too', 'bounds ms', 'blur reach ms', 'first tile ms', 'tile 1× ms', 'tile after patch ms', 'tile ¼× ms', 'view ¼× ms', 'view nodes', 'patch ms', 'patch+bounds ms', 'RSS MB'].join('\t'));
  for (const layers of layersList) {
    let t = performance.now();
    const document = generatedPage(layers);
    const buildMs = ms(t);
    const json = JSON.stringify(document);
    const page = document.pages[0];
    // The binary path first (DESIGN_BIG_FILES): the engine shadow's encode, the renderer's decode — no JSON on the way;
    // the renderer's wasm memory after it is the path's whole footprint (the memory never shrinks, so the JSON load's
    // parse peak is read after it as the extra it costs).
    const engine = new (engineWasm().MorfaDoc)(json);
    t = performance.now();
    const bytes = engine.encode();
    const encodeMs = ms(t);
    engine.free();
    t = performance.now();
    const fromBytes = RenderDoc.decode(bytes);
    const decodeMs = ms(t);
    const wasmBytesMb = (JSON.parse(fromBytes.stats()) as {memoryBytes: number}).memoryBytes / 1048576;
    fromBytes.free();
    t = performance.now();
    const doc = new RenderDoc(json);
    const loadMs = ms(t);
    const wasmJsonMb = (JSON.parse(doc.stats()) as {memoryBytes: number}).memoryBytes / 1048576;
    t = performance.now();
    const area = Array.from(doc.page_area(page));
    const boundsMs = ms(t);
    const options = JSON.stringify({minSize: 0.5, spriteScale: 1});
    t = performance.now();
    doc.blur_margin(page);
    const blurMarginMs = ms(t);
    // A 512 px tile at 1× over the first screen, then one over the same place at the overview zoom.
    t = performance.now();
    doc.render!(page, area[0], area[1], 512, 512, 1, 1, 1, 1, options);
    const firstTileMs = ms(t);
    // The same tile again: the first render carries one-time costs (the backend's first allocations, the blur reach).
    t = performance.now();
    doc.render!(page, area[0], area[1], 512, 512, 1, 1, 1, 1, options);
    const tile1xMs = ms(t);
    t = performance.now();
    doc.render!(page, area[0], area[1], 2048, 2048, 0.25, 1, 1, 1, JSON.stringify({minSize: 0.5, spriteScale: 0.25}));
    const tileQuarterMs = ms(t);
    // The editor's view at 25 %: 1440 × 900 device px = 5760 × 3600 page px.
    t = performance.now();
    doc.render!(page, area[0], area[1], 5760, 3600, 0.25, 1, 1, 1, JSON.stringify({minSize: 0.5, spriteScale: 0.25}));
    const viewQuarterMs = ms(t);
    const counters = JSON.parse(doc.last_counters()) as {nodes: number};
    // One layer moves (the store's patch): the document steps a version and the next bounds ask re-syncs the page.
    const moved = document.nodes[page].children![0];
    const first = document.nodes[moved].children![0];
    t = performance.now();
    // The store's patch carries whole nodes.
    doc.apply_patch(JSON.stringify({nodes: {[first]: {...document.nodes[first], x: document.nodes[first].x + 10}}}));
    const patchMs = ms(t);
    t = performance.now();
    doc.bounds(page, first);
    const rePatchBoundsMs = ms(t);
    // The tile again after the edit: what one keystroke costs the renderer on this page.
    t = performance.now();
    doc.render!(page, area[0], area[1], 512, 512, 1, 1, 1, 1, options);
    const tileAfterPatchMs = ms(t);
    const row: Row = {layers, nodes: Object.keys(document.nodes).length, jsonMb: json.length / 1048576, buildMs, loadMs, bytesMb: bytes.length / 1048576, encodeMs, decodeMs, wasmBytesMb, wasmJsonMb, boundsMs, blurMarginMs, firstTileMs, tile1xMs, tileAfterPatchMs, tileQuarterMs, viewQuarterMs, viewQuarterNodes: counters.nodes, patchMs, rePatchBoundsMs, wasmStats: JSON.parse(doc.stats()), rssMb: process.memoryUsage().rss / 1048576};
    rows.push(row);
    console.log([layers, row.nodes, row.jsonMb.toFixed(1), buildMs, loadMs, row.bytesMb.toFixed(1), encodeMs, decodeMs, wasmBytesMb.toFixed(0), wasmJsonMb.toFixed(0), boundsMs, blurMarginMs, firstTileMs, tile1xMs, tileAfterPatchMs, tileQuarterMs, viewQuarterMs, counters.nodes, patchMs, rePatchBoundsMs, row.rssMb.toFixed(0)].join('\t'));
    doc.free();
  }
  fs.mkdirSync(out, {recursive: true});
  const file = path.join(out, `big-page-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify({generated: new Date().toISOString(), host: `${os.type()} ${os.arch()}, ${os.cpus().length} cores`, loadavg: os.loadavg(), provisional: true, rows}, null, 2) + '\n');
  console.log(`written to ${path.relative(repo, file)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
