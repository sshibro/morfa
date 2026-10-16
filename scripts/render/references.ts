// Today's vector PDFs of the X4 fixtures (scripts/render/fixtures.ts), printed by the server's own Chromium
// pipeline (server/design/pdf/, scripts/export/chromium-pdf.ts) — the references scripts/bench/pdf-diff.ts compares
// the render service's PDFs with. Chromium refuses to run as root with its sandbox: run this as an ordinary user.
// The api's database module is loaded on import: any well-formed MORFA_DATABASE_URL
// will do (nothing connects).
//
//   IMPORT_CHROMIUM_PATH=… npx tsx scripts/render/references.ts [--out output/B4/ref] [--only product,page]
import fs from 'node:fs';
import path from 'node:path';
import {testMeasurer, productFile} from '../../tests/helpers/design-big-files';
import {generate} from '../bench/gen-file';
import {chromiumPdf, closePdfBrowser} from '../export/chromium-pdf';
import {frames, pictures} from './fixtures';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const out = path.resolve(arg('out', 'output/B4/ref'));
const only = arg('only', 'product,page').split(',');
fs.mkdirSync(out, {recursive: true});

const {assets, bytes} = await pictures(6);
const files = new Map(Object.values(assets).map((asset, i) => [asset.url.slice('/uploads/'.length), {type: asset.url.endsWith('.png') ? ('image/png' as const) : ('image/jpeg' as const), data: Buffer.from(bytes[i])}]));
try {
  if (only.includes('product')) {
    const doc = productFile(assets);
    const started = performance.now();
    const pdf = await chromiumPdf(doc, frames(doc), testMeasurer, async name => files.get(name) ?? null, 'X4');
    fs.writeFileSync(path.join(out, 'x4-product.pdf'), pdf);
    console.log(`x4-product.pdf ${(pdf.length / 1024).toFixed(0)} KiB in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
  if (only.includes('page')) {
    const doc = generate({kind: 'page', layers: 50 * 501, seed: 7});
    const started = performance.now();
    const pdf = await chromiumPdf(doc, frames(doc), testMeasurer, async () => null, 'X4');
    fs.writeFileSync(path.join(out, 'x4-page.pdf'), pdf);
    console.log(`x4-page.pdf ${(pdf.length / 1024).toFixed(0)} KiB in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
} finally {
  await closePdfBrowser();
}
