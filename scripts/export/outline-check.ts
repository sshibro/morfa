// The outline-text check: every top-level frame of the starter
// templates exported twice, text as text and text as paths (`outlineText`, crates/export with the text crate's glyph
// outlines), both rasterised by Chromium with the catalogue fonts, and SSIM computed per text layer's region.
// Passes when every region is ≥ 0.98.
//
//   npx tsx scripts/export/outline-check.ts [--scale 2] [--out output/L5/outline]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {exportSvgPage} from '../../shared/design/svg-export';
import {worldBox} from '../../shared/design/geometry';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import {DESIGN_TEMPLATES} from '../../shared/design/templates';
import {productFile, testMeasurer} from '../../tests/helpers/design-big-files';
import {closeBrowser, exportModuleFor, familiesOf, renderSvg, ssim} from './lib';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const scale = Number(arg('scale', '2'));
const out = arg('out', 'output/L5/outline');
fs.mkdirSync(out, {recursive: true});

type Row = {doc: string; frame: NodeId; text: NodeId; ssim: number};
const rows: Row[] = [];
let crops = 0;

function textsUnder(doc: DesignDocument, id: NodeId): NodeId[] {
  const found: NodeId[] = [];
  const stack = [id];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node || !node.visible) continue;
    if (node.type === 'TEXT' && node.text?.characters.trim()) found.push(node.id);
    stack.push(...(node.children ?? []));
  }
  return found;
}

async function check(name: string, doc: DesignDocument, frames: NodeId[]): Promise<void> {
  exportModuleFor(doc);
  const families = familiesOf(doc);
  for (const frame of frames) {
    const texts = textsUnder(doc, frame);
    if (!texts.length) continue;
    const plain = exportSvgPage(doc, [frame], {measurer: testMeasurer});
    const outlined = exportSvgPage(doc, [frame], {measurer: testMeasurer, outlineText: true});
    const {width, height} = plain.bounds;
    if (width * height * scale * scale > 40e6) continue;
    const a = await renderSvg(plain.svg, width, height, scale, families);
    const b = await renderSvg(outlined.svg, width, height, scale, families);
    let worst = 1;
    for (const id of texts) {
      const box = worldBox(doc, id);
      const region = {x: (box.x - plain.bounds.x - 2) * scale, y: (box.y - plain.bounds.y - 2) * scale, width: (box.width + 4) * scale, height: (box.height + 4) * scale};
      const value = ssim(a, b, region);
      rows.push({doc: name, frame, text: id, ssim: value});
      if (value < 0.98 && crops++ < 40) {
        const left = Math.max(0, Math.floor(region.x)), top = Math.max(0, Math.floor(region.y));
        const cut = {left, top, width: Math.min(a.width - left, Math.ceil(region.width)), height: Math.min(a.height - top, Math.ceil(region.height))};
        if (cut.width > 0 && cut.height > 0) {
          const pa = await sharp(a.data, {raw: {width: a.width, height: a.height, channels: 4}}).extract(cut).png().toBuffer();
          const pb = await sharp(b.data, {raw: {width: b.width, height: b.height, channels: 4}}).extract(cut).png().toBuffer();
          await sharp({create: {width: cut.width, height: cut.height * 2 + 2, channels: 4, background: '#ff0000'}})
            .composite([{input: pa, left: 0, top: 0}, {input: pb, left: 0, top: cut.height + 2}])
            .png()
            .toFile(path.join(out, `crop-${value.toFixed(4)}-${name}-${id}.png`.replace(/[^\w.-]+/g, '_')));
        }
      }
      worst = Math.min(worst, value);
    }
    if (worst < 0.98) {
      const base = path.join(out, `${name}-${frame}`.replace(/[^\w.-]+/g, '_'));
      await sharp(a.data, {raw: {width: a.width, height: a.height, channels: 4}}).png().toFile(`${base}-text.png`);
      await sharp(b.data, {raw: {width: b.width, height: b.height, channels: 4}}).png().toFile(`${base}-paths.png`);
    }
  }
}

for (const template of DESIGN_TEMPLATES) {
  if (template.id === 'blank') continue;
  const doc = template.build({measurer: testMeasurer});
  const frames = doc.pages.flatMap(page => doc.nodes[page]?.children ?? []);
  await check(template.id, doc, frames);
}
const product = productFile();
await check('productFile', product, (product.nodes[product.pages[0]].children ?? []).slice(0, 6));
await closeBrowser();

const failing = rows.filter(row => row.ssim < 0.98);
const min = rows.reduce((m, row) => Math.min(m, row.ssim), 1);
const mean = rows.reduce((s, row) => s + row.ssim, 0) / Math.max(1, rows.length);
console.log(`outline-check: ${rows.length} text regions, ${rows.length - failing.length} ≥ 0.98, min ${min.toFixed(4)}, mean ${mean.toFixed(4)} (Chromium, ${scale}× device pixels)`);
for (const row of failing.sort((p, q) => p.ssim - q.ssim).slice(0, 30)) console.log(`  ${row.ssim.toFixed(4)}  ${row.doc} ${row.frame} ${row.text}`);
fs.writeFileSync(path.join(out, 'regions.json'), JSON.stringify(rows, null, 1));
process.exit(failing.length ? 1 : 0);
