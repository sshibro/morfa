// Copies the fonts used by shared/fonts.ts from installed @fontsource
// packages into public/fonts. Runs before dev, build and test.
import fs from 'node:fs';
import path from 'node:path';
import {allFontFiles} from '../shared/fonts';

const root = path.resolve('public/fonts');
const packageDirs = ['@fontsource', '@fontsource-variable'].map(scope => path.resolve('node_modules', scope));

function sourceFor(relative: string): string {
  const vendored = path.resolve('assets/fonts', relative);
  if (fs.existsSync(vendored)) return vendored;
  const [dir, file] = relative.split('/');
  for (const scope of packageDirs) {
    const candidate = path.join(scope, dir, 'files', file);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Font file not found in node_modules: ${relative}. Run npm install.`);
}

let copied = 0;
for (const relative of allFontFiles()) {
  const source = sourceFor(relative);
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const fresh = !fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size;
  if (fresh) {
    fs.copyFileSync(source, target);
    copied += 1;
  }
}
console.log(`fonts: ${allFontFiles().length} files ready in public/fonts (${copied} copied)`);
