// The SVG differential: every page, every top-level layer and every
// slice of the fixture documents exported by the TypeScript exporter and by crates/export, compared byte for byte.
// Variants per target: plain, `layerIds`, `print` with an id prefix (pdfPageSvg's flavour), precision 2 and 5.
//
//   npx tsx scripts/export/svg-diff.ts [--seeds 40] [--big] [--only fuzz,templates,…]
//
// Documents: heavyPage(), productFile() (images), the bench generator's instances/shapes/board files, every starter
// template, and S2's fuzz documents (every node type and feature, pictures included). `--big` adds the f20k page. The
// measurer is the fixed-width fake (natively in Rust) and, for the templates, a proportional fake measured through
// the JavaScript callback, so both measuring paths are compared. Exits 1 on any difference and prints the first.
import {exportSvgPage, type SvgExportOptions} from '../../shared/design/svg-export';
import {engineCalls, resetEngineCalls, setEngine, EngineDiffError} from '../../shared/design/engine-switch';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';
import {fuzzDocument} from '../../tests/helpers/design-fuzz';
import {DESIGN_TEMPLATES} from '../../shared/design/templates';
import {generate} from '../bench/gen-file';

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const seeds = Number(arg('seeds') ?? 40);
const only = arg('only')?.split(',');

/** A proportional fake (not the fixed-width one), so Rust measures through the JavaScript callback. */
const proportional: TextMeasurer = {
  width: (text, font) => {
    let w = 0;
    for (let i = 0; i < text.length; i++) w += (0.35 + ((text.charCodeAt(i) * 7) % 11) / 20) * font.size;
    return w * (font.weight >= 600 ? 1.05 : 1) * (font.italic ? 0.98 : 1);
  },
  metrics: font => ({ascent: font.size * 0.93, descent: font.size * 0.24}),
};

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pictures = (doc: DesignDocument): Pick<SvgExportOptions, 'imageData' | 'imageHref'> => {
  const refs = Object.keys(doc.images);
  return {
    imageData: ref => (refs.indexOf(ref) % 3 === 0 ? PNG : undefined),
    imageHref: ref => (refs.indexOf(ref) % 3 === 1 ? `https://cdn.example.test/p/${refs.indexOf(ref)}.png` : refs.indexOf(ref) % 3 === 2 ? 'javascript:alert(1)' : undefined),
  };
};

type Target = {label: string; ids: NodeId[]; crop?: {x: number; y: number; width: number; height: number}};

function targets(doc: DesignDocument): Target[] {
  const out: Target[] = [];
  for (const pageId of doc.pages) {
    const page = doc.nodes[pageId];
    if (!page) continue;
    out.push({label: `page ${pageId}`, ids: [pageId]});
    const children = page.children ?? [];
    out.push({label: `children of ${pageId}`, ids: [...children]});
    for (const id of children) out.push({label: id, ids: [id]});
  }
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'SLICE') continue;
    // A slice's SVG is its page cropped to it (pdf-export.ts pdfPagePlan does the same for PDF pages).
    let page = node;
    while (page.parentId && page.type !== 'PAGE') page = doc.nodes[page.parentId];
    const box = {x: node.x, y: node.y, width: node.width, height: node.height};
    out.push({label: `slice ${node.id}`, ids: [...(page.children ?? [])].filter(id => id !== node.id), crop: box});
  }
  return out;
}

const variants: [string, Partial<SvgExportOptions>][] = [
  ['plain', {}],
  ['layerIds', {layerIds: true}],
  ['print', {print: true, idPrefix: 'p0_'}],
  ['print+layerIds', {print: true, idPrefix: 'p1_', layerIds: true}],
  ['precision 2', {precision: 2}],
  ['precision 5', {precision: 5}],
];

let compared = 0, bytes = 0;
function compare(name: string, doc: DesignDocument, measurer: TextMeasurer, quick = false): void {
  const all = targets(doc);
  const list = quick ? all.filter((_, i) => i < 2 || i % 25 === 0) : all;
  for (const target of list) {
    for (const [variant, extra] of quick ? variants.slice(0, 3) : variants) {
      const options: SvgExportOptions = {measurer, ...pictures(doc), ...extra, crop: target.crop};
      try {
        const page = exportSvgPage(doc, target.ids, options);
        compared++;
        bytes += page.svg.length;
      } catch (error) {
        if (!(error instanceof EngineDiffError)) throw error;
        const ts = error.ts as {svg: string}, wasm = error.wasm as {svg: string};
        console.error(`DIFF ${name} · ${target.label} · ${variant}: ${error.message.slice(0, 300)}`);
        if (typeof ts?.svg === 'string' && typeof wasm?.svg === 'string') {
          let i = 0;
          while (i < ts.svg.length && ts.svg[i] === wasm.svg[i]) i++;
          console.error(`  first difference at byte ${i} of ${ts.svg.length} / ${wasm.svg.length}\n  ts   …${ts.svg.slice(Math.max(0, i - 200), i + 200)}\n  wasm …${wasm.svg.slice(Math.max(0, i - 200), i + 200)}`);
        }
        process.exit(1);
      }
    }
  }
}

setEngine('export', 'both');
resetEngineCalls('export');
const started = performance.now();
const want = (group: string) => !only || only.includes(group);
if (want('big')) {
  compare('heavyPage', heavyPage(), testMeasurer, true);
  compare('productFile', productFile(Object.fromEntries(Array.from({length: 6}, (_, i) => [`img${i}`, {url: `/uploads/x${i}.png`, width: 640, height: 480}]))), testMeasurer, true);
  if (process.argv.includes('--big')) compare('f20k', generate({kind: 'page', layers: 20_041, seed: 3}), testMeasurer, true);
}
if (want('bench')) {
  compare('instances200', generate({kind: 'instances', layers: 200, seed: 0}), testMeasurer);
  compare('bool200', generate({kind: 'shapes', layers: 200, seed: 1}), testMeasurer);
  compare('board300', generate({kind: 'board', layers: 300, seed: 0}), testMeasurer, true);
  compare('page2k-s5', generate({kind: 'page', layers: 2_000, seed: 5}), testMeasurer, true);
}
if (want('templates'))
  for (const template of DESIGN_TEMPLATES) {
    compare(`template ${template.id}`, template.build({measurer: testMeasurer}), testMeasurer);
    compare(`template ${template.id} (proportional)`, template.build({measurer: proportional}), proportional);
  }
if (want('fuzz'))
  for (let seed = 1; seed <= seeds; seed++) {
    compare(`fuzz ${seed}`, fuzzDocument(seed, {nodes: 120 + (seed % 5) * 60}), seed % 2 ? testMeasurer : proportional);
  }
const counts = engineCalls('export');
console.log(`svg-diff: ${compared} exports compared byte for byte (${(bytes / 1e6).toFixed(1)} MB of SVG), 0 differences, ${((performance.now() - started) / 1000).toFixed(1)} s`);
console.log(`  export counters: ${JSON.stringify(counts)}`);
if (!counts.wasm || counts.fallback || counts.diffs) {
  console.error('svg-diff: the wasm side did not answer every call');
  process.exit(1);
}
