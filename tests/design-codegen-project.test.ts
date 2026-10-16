import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync, strFromU8} from 'fflate';
import {PROJECT_VERSIONS, pageLayers, projectFiles, projectZip, type Project} from '../shared/design/codegen/project';
import {PRODUCT_NAME} from '../shared/design/product';
import {createDocument} from '../shared/design/defaults';
import {add} from './design-codegen-fixture';
import type {Styling} from '../shared/design/codegen/react';
import {measurer, showcaseFile} from './design-codegen-fixture';

// "Export to React…": the project is a real Vite + React + TypeScript app. Each styling is written to
// a temporary folder and type-checked by this repository's TypeScript with the strict settings the
// project ships (noUnusedLocals included), against this repository's React types.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');

function writeProject(project: Project): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-react-export-'));
  for (const file of project.files) {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, file.contents);
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

function typeCheck(dir: string): string {
  try {
    execFileSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], {encoding: 'utf8', stdio: 'pipe', timeout: 120_000});
    return '';
  } catch (error) {
    const failed = error as {stdout?: string; stderr?: string; message: string};
    return failed.stdout || failed.stderr || failed.message;
  }
}

for (const styling of ['css-modules', 'tailwind', 'inline'] as Styling[]) {
  test(`the exported project type-checks on its own (${styling})`, {timeout: 180_000}, () => {
    const project = projectFiles(showcaseFile(), ['p'], {name: 'Beans landing', styling, measurer});
    const dir = writeProject(project);
    try {
      assert.equal(typeCheck(dir), '', `tsc in ${dir}`);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
}

test('the project carries the app shell, screens, components, tokens, assets and an English README', () => {
  const project = projectFiles(showcaseFile(), ['p'], {name: 'Beans landing', measurer});
  assert.equal(project.folder, 'beans-landing');
  const paths = project.files.map(file => file.path);
  for (const expected of ['package.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'README.md', 'src/main.tsx', 'src/App.tsx', 'src/index.css', 'src/app.css', 'src/vite-env.d.ts',
    'src/tokens.css', 'src/tokens.ts', 'src/screens/Home.tsx', 'src/screens/ProductCard.tsx', 'src/components/Button.tsx', 'src/components/IconArrow.tsx', 'src/components/IconPlus.tsx']) {
    assert.ok(paths.includes(expected), `${expected} in ${paths.join(', ')}`);
  }
  assert.deepEqual(project.code.assets, [{path: 'src/assets/bean-photo.webp', ref: 'img1', url: '/uploads/dz-1.webp'}]);
  const file = (p: string) => project.files.find(f => f.path === p)!.contents;
  const pkg = JSON.parse(file('package.json'));
  assert.deepEqual(pkg.dependencies, {react: PROJECT_VERSIONS.react, 'react-dom': PROJECT_VERSIONS['react-dom']});
  assert.equal(pkg.devDependencies.vite, PROJECT_VERSIONS.vite);
  assert.equal(pkg.scripts.dev, 'vite');
  assert.match(file('src/main.tsx'), /import '\.\/tokens\.css';/);
  assert.match(file('src/App.tsx'), /\{name: "Home", render: \(\) => <Home \/>\},/);
  assert.match(file('src/App.tsx'), /<Button size="small">Buy<\/Button>/, 'the components page shows every look, with its label');
  assert.doesNotMatch(file('src/App.tsx'), /state=/, 'hover is CSS, not a prop');
  assert.equal(file('src/lib/cx.ts'), `/** Joins class names, leaving out the empty ones. */\nexport function cx(...names: (string | false | null | undefined)[]): string {\n  return names.filter(Boolean).join(' ');\n}\n`);
  assert.match(file('src/index.css'), /\*, \*::before, \*::after \{\n  box-sizing: border-box;\n\}/, 'the reset the components rely on');
  assert.ok(file('README.md').startsWith(`# Beans landing\n\nThis project was built from a design in ${PRODUCT_NAME}`));
  assert.match(file('README.md'), /npm install\nnpm run dev/);
  assert.match(file('index.html'), /fonts\.googleapis\.com\/css2\?family=Inter:wght@400;600;700&amp;display=swap/);
});

test('the Tailwind project brings Tailwind and a theme of the design\'s tokens: colours, text styles, shadows, the base family', () => {
  const project = projectFiles(showcaseFile(), ['card'], {name: 'card', styling: 'tailwind', measurer});
  const file = (p: string) => project.files.find(f => f.path === p)!.contents;
  assert.ok(JSON.parse(file('package.json')).devDependencies.tailwindcss);
  assert.match(file('vite.config.ts'), /plugins: \[react\(\), tailwindcss\(\)\]/);
  assert.equal(file('src/index.css'), "@import 'tailwindcss';\n@import './theme.css';\n");
  const theme = file('src/theme.css');
  assert.match(theme, /@theme \{[^}]*--color-surface-card: #FFFFFF;/);
  assert.match(theme, /--text-headings-h2: 24px;[^\n]*\n  --text-headings-h2--line-height: 32px;\n  --text-headings-h2--font-weight: 600;\n  --text-headings-h2--letter-spacing: -0\.01em;/, 'a text style is one text-* utility');
  assert.match(theme, /--shadow-card: 0 8px 24px rgba\(0, 0, 0, 0\.12\);/);
  assert.match(theme, /--font-sans: 'Inter', sans-serif;/, 'the family most texts use is the base: no text names it');
  assert.match(theme, /\[data-theme='dark'\] \{\n  --color-surface-card: #1A1A1A;/);
  const card = file('src/screens/ProductCard.tsx');
  assert.match(card, /bg-surface-card rounded-2xl shadow-card/);
  assert.match(card, /text-headings-h2 text-text-primary/);
  assert.doesNotMatch(card, /font-family-|\[font:|box-border|m-0/, 'no family repeated, no shorthand in brackets, nothing preflight does');
});

test('versions in the project are the ones this app runs on', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(PROJECT_VERSIONS)) {
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
    assert.equal(version, installed, `${name}: the project pins what node_modules has`);
    const range = pkg.dependencies[name] ?? pkg.devDependencies[name];
    assert.ok(range, `${name} is a dependency of the app`);
    assert.equal(version.split('.')[0], range.replace(/^[\^~]/, '').split('.')[0], `${name}: same major as package.json`);
  }
});

test('the zip holds every file under the project folder, pictures included', () => {
  const project = projectFiles(showcaseFile(), ['card'], {name: 'Card', measurer});
  const picture = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
  const zip = unzipSync(projectZip(project, new Map([['src/assets/bean-photo.webp', picture]])));
  assert.equal(project.folder, 'card');
  assert.deepEqual(Object.keys(zip).sort(), [...project.files.map(file => `card/${file.path}`), 'card/src/assets/bean-photo.webp'].sort());
  assert.deepEqual([...zip['card/src/assets/bean-photo.webp']], [...picture]);
  assert.equal(strFromU8(zip['card/package.json']), project.files.find(file => file.path === 'package.json')!.contents);
  // Deterministic: the same document zips to the same bytes.
  assert.deepEqual(projectZip(project, new Map()), projectZip(projectFiles(showcaseFile(), ['card'], {name: 'Card', measurer}), new Map()));
});

test('"Export to React…" offers a page’s screens in reading order, as the switcher lists them', () => {
  // Arrange: three screens drawn in the order "Profile", "Login", "Feed", laid out left to right as "Login", "Feed", "Profile",
  // and a hidden one and a slice that are not offered.
  let doc = createDocument('p', 'Screens');
  doc = add(doc, 'FRAME', {id: 'profile', parentId: 'p', name: 'Profile', x: 900, y: 0, width: 390, height: 844});
  doc = add(doc, 'FRAME', {id: 'login', parentId: 'p', name: 'Login', x: 0, y: 10, width: 390, height: 844});
  doc = add(doc, 'FRAME', {id: 'feed', parentId: 'p', name: 'Feed', x: 450, y: 0, width: 390, height: 844});
  doc = add(doc, 'FRAME', {id: 'hidden', parentId: 'p', name: 'Draft', x: 1400, y: 0, width: 390, height: 844, visible: false});
  doc = add(doc, 'SLICE', {id: 'slice', parentId: 'p', name: 'Slice', x: 0, y: 0, width: 100, height: 100});
  doc = add(doc, 'FRAME', {id: 'below', parentId: 'p', name: 'Settings', x: 0, y: 1000, width: 390, height: 844});

  // Act
  const offered = pageLayers(doc, 'p').map(node => node.name);

  // Assert: rows from the top, each from the left; the screens of the project's App follow the same order.
  assert.deepEqual(offered, ['Login', 'Feed', 'Profile', 'Settings']);
  const project = projectFiles(doc, pageLayers(doc, 'p').map(node => node.id), {name: 'Order', measurer});
  const app = project.files.find(file => file.path === 'src/App.tsx')!.contents;
  const order = ['Login', 'Feed', 'Profile', 'Settings'].map(name => app.indexOf(`name: "${name}"`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), app);
});
