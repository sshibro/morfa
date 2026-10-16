// Summarises chrome-measure.mjs --json output: per candidate, strings within 1/64 em of Chrome.
import {readFileSync} from 'node:fs';
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const names = {rb: 'rustybuzz+ttf-parser', hr: 'harfrust+skrifa', sw: 'swash'};
const skip = new Set(['\t']);
const total = {rb: 0, hr: 0, sw: 0}, fail = {rb: 0, hr: 0, sw: 0}, worst = {rb: 0, hr: 0, sw: 0};
const failures = {rb: [], hr: [], sw: []};
for (const row of rows) {
  if (skip.has(row.text) || typeof row.chrome !== 'number' || !row.covered) continue;
  for (const k of ['rb', 'hr', 'sw']) {
    const diff64 = Math.abs(row[k] - row.chrome) / row.upem * 64;
    total[k]++;
    worst[k] = Math.max(worst[k], diff64);
    if (diff64 > 1) {
      fail[k]++;
      if (failures[k].length < 12) failures[k].push(`${row.file} wght=${row.wght} ${JSON.stringify(row.text)}: ${k}=${row[k].toFixed(0)} chrome=${row.chrome.toFixed(0)} (${diff64.toFixed(1)}/64 em)`);
    }
  }
}
console.log(`Rows: ${rows.length}; compared (every character in the face's cmap, no tab): ${rows.filter(r => r.covered && !skip.has(r.text)).length}\n`);
console.log('| Candidate | Strings (face × weight × text) | Outside 1/64 em of Chrome | Worst (1/64 em) |');
console.log('|---|---|---|---|');
for (const k of ['rb', 'hr', 'sw']) console.log(`| ${names[k]} | ${total[k]} | ${fail[k]} (${(100 * fail[k] / total[k]).toFixed(2)} %) | ${worst[k].toFixed(2)} |`);
for (const k of ['rb', 'hr', 'sw']) if (failures[k].length) console.log(`\nFirst failures, ${names[k]}:\n- ` + failures[k].join('\n- '));
