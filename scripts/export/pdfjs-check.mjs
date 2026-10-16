// pdf.js on PDFs (the second viewer check): every page parsed, its operator list built (fonts,
// images, shadings decoded as pdf.js decodes them for drawing) and its text extracted; every pdf.js warning counted.
// pdf.js is not a dependency of the app: PDFJS_DIST points at an install of pdfjs-dist (`npm install pdfjs-dist`
// in a scratch folder). Prints JSON per file: {file, pages, warnings: [...], text: [...]}.
//   PDFJS_DIST=/path/to/node_modules/pdfjs-dist node scripts/export/pdfjs-check.mjs a.pdf [b.pdf …]
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dist = process.env.PDFJS_DIST;
if (!dist) {
  console.error('pdfjs-check: set PDFJS_DIST to a pdfjs-dist folder');
  process.exit(2);
}
const pdfjs = await import(pathToFileURL(path.join(dist, 'legacy/build/pdf.mjs')).href);
const warnings = [];
const log = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (/^Warning:/.test(text)) warnings.push(text);
  else log(...args);
};
const results = [];
for (const file of process.argv.slice(2)) {
  warnings.length = 0;
  const out = {file, pages: 0, warnings: [], text: [], error: null};
  try {
    const doc = await pdfjs.getDocument({data: new Uint8Array(fs.readFileSync(file)), verbosity: 1, useSystemFonts: false, isEvalSupported: false}).promise;
    out.pages = doc.numPages;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      await page.getOperatorList();
      const content = await page.getTextContent();
      out.text.push(content.items.map(item => item.str + (item.hasEOL ? '\n' : '')).join(''));
    }
    await doc.destroy();
  } catch (error) {
    out.error = String(error?.message ?? error);
  }
  out.warnings = [...warnings];
  results.push(out);
}
log(JSON.stringify(results));
