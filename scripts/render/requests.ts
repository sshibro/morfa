// Lane B4: writes render-service request files (MRR1 bodies, crates/render-service src/request.rs) for the X-rows of
// docs/TARGETS.md §6, so `morfa-render job <file>` times a job on any machine without the api:
//   x4-product.mrr   productFile, 50 frames: Cyrillic text, 6 pictures (JPEG and translucent PNG), 580 shadows/blurs
//   x4-page.mrr      the page generator's 50 screens of 501 layers
//   x3-heavy.mrr     the SVG of heavyPage() (f20k seed 0), every top-level layer
// Text is measured by the tests' fixed-width fake (`measure: fixed`, as L5's benches do) unless --fonts.
//
//   npx tsx scripts/render/requests.ts [--out output/B4/requests] [--fonts]
import fs from 'node:fs';
import path from 'node:path';
import {xRequests} from './fixtures';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const out = path.resolve(arg('out', 'output/B4/requests'));
fs.mkdirSync(out, {recursive: true});
const requests = await xRequests(process.argv.includes('--fonts') ? 'fonts' : 'fixed');
fs.writeFileSync(path.join(out, 'x4-product.mrr'), requests.x4Product);
fs.writeFileSync(path.join(out, 'x4-page.mrr'), requests.x4Page);
fs.writeFileSync(path.join(out, 'x3-heavy.mrr'), requests.x3);
for (const file of fs.readdirSync(out)) console.log(`${path.join(out, file)} ${(fs.statSync(path.join(out, file)).size / 1024).toFixed(0)} KiB`);
