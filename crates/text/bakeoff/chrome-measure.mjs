// Chrome's measureText as the oracle for the T1 rows (docs/decisions/text-shaper.md).
//   node crates/text/bakeoff/chrome-measure.mjs <woff2> <upem> <wght|0> <text>…      one face, prints units
//   node crates/text/bakeoff/chrome-measure.mjs --json <rows.json> <out.json>         every row of --dump-json
// Each face loads as a FontFace from a data URL in headless Chromium (playwright-core); textRendering is
// geometricPrecision as src/design/engine/fonts.ts sets it; widths measured at 1000 px become font units.
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';

const args = process.argv.slice(2);
const browser = await chromium.launch({headless: true});
const page = await browser.newPage();
await page.setContent('<canvas id="c" width="8" height="8"></canvas>');

/** Measures `texts` with the face in `data` (base64 woff2) at `wght`; returns units and the rounded metrics. */
async function measure(data, name, upem, wght, texts) {
  return page.evaluate(
    async ({data, name, wght, texts, upem}) => {
      if (!document.fonts.check(`400 10px "${name}"`) || !window.__loaded?.has(name)) {
        const face = new FontFace(name, `url(data:font/woff2;base64,${data})`, {weight: '1 1000'});
        document.fonts.add(face);
        await face.load();
        (window.__loaded ??= new Set()).add(name);
      }
      const ctx = document.getElementById('c').getContext('2d');
      ctx.textRendering = 'geometricPrecision';
      ctx.font = `${wght || 400} 1000px "${name}"`;
      return texts.map(text => {
        const m = ctx.measureText(text);
        return {units: (m.width / 1000) * upem, ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent};
      });
    },
    {data, name, wght, texts, upem},
  );
}

if (args[0] === '--json') {
  const rows = JSON.parse(readFileSync(args[1], 'utf8'));
  const byFace = new Map();
  for (const row of rows) {
    const key = `${row.file}|${row.wght}`;
    if (!byFace.has(key)) byFace.set(key, []);
    byFace.get(key).push(row);
  }
  const root = path.resolve('public/fonts');
  let done = 0;
  for (const [key, list] of byFace) {
    const [file] = key.split('|');
    const data = readFileSync(file.startsWith('public/') ? path.resolve(file) : path.join(root, file)).toString('base64');
    const name = 'F' + file.replace(/[^a-z0-9]/gi, '_');
    const measured = await measure(data, name, list[0].upem, list[0].wght, list.map(r => r.text));
    list.forEach((row, i) => Object.assign(row, {chrome: measured[i].units, ascent: measured[i].ascent, descent: measured[i].descent}));
    if (++done % 50 === 0) console.error(`chrome-measure: ${done}/${byFace.size} faces`);
  }
  writeFileSync(args[2], JSON.stringify(rows));
  console.error(`chrome-measure: ${rows.length} rows → ${args[2]}`);
} else {
  const [file, upemArg, wghtArg, ...texts] = args;
  const data = readFileSync(file).toString('base64');
  const measured = await measure(data, 'Probe', Number(upemArg), Number(wghtArg), texts);
  texts.forEach((text, i) => console.log(JSON.stringify(text), 'chrome', measured[i].units.toFixed(1), 'ascent', measured[i].ascent, 'descent', measured[i].descent));
}
await browser.close();
