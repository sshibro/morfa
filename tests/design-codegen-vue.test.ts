import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build, type Plugin} from 'esbuild';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import type {Styling} from '../shared/design/codegen';
import {pageLayers} from '../shared/design/codegen/project';
import {toReact, toVue} from '../shared/design/codegen/react';
import {VUE_PROJECT_VERSIONS, vueProjectFiles} from '../shared/design/codegen/vue-project';
import {vueExpr, vueText} from '../shared/design/codegen/vue';
import {templateById, type TemplateId} from '../shared/design/templates';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {DesignDocument} from '../shared/design/types';
import {createDocument, defaultTextProps} from '../shared/design/defaults';
import {fontFallback} from '../src/design/engine/commands/code';
import {add, buttonFile, measurer as fixtureMeasurer, showcaseFile} from './design-codegen-fixture';

// "Export to Vue…": the React export's pipeline written as Vue 3 single-file components. Every starter template and the
// fixture file, in every styling, is written to disk as the developer gets it and checked by vue-tsc with the project's own
// tsconfig (strict, no unused locals; templates type-checked against the props); then every component is compiled by Vue's
// SFC compiler, bundled, and its screens and component page rendered by Vue's server renderer, and any Vue warning (a
// missing prop, an unresolved component, a bad slot) fails the test.

const repository = fileURLToPath(new URL('..', import.meta.url));
const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.56, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const STYLINGS: Styling[] = ['css-modules', 'tailwind', 'inline'];
const vueTsc = path.join(repository, 'node_modules/vue-tsc/bin/vue-tsc.js');

function templateDoc(id: TemplateId): DesignDocument {
  let seq = 0;
  return templateById(id)!.build({measurer, newId: () => `n${(seq++).toString(36)}`});
}

const SOURCES: {name: string; doc: () => DesignDocument}[] = [
  ...(['ui-kit', 'mobile', 'site', 'presentation', 'social'] as TemplateId[]).map(id => ({name: id, doc: () => templateDoc(id)})),
  {name: 'fixture', doc: () => showcaseFile()},
  {name: 'buttons', doc: () => buttonFile().doc},
];

function writeProject(files: readonly {path: string; contents: string}[], assets: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'morfa-vue-'));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file.path)), {recursive: true});
    writeFileSync(path.join(dir, file.path), file.contents);
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  for (const asset of assets) {
    mkdirSync(path.dirname(path.join(dir, asset)), {recursive: true});
    writeFileSync(path.join(dir, asset), png);
  }
  symlinkSync(path.join(repository, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** vue-tsc's verdict on the project, with its own tsconfig (vite/client for the asset and CSS imports). */
function typeErrors(dir: string): string {
  try {
    execFileSync(process.execPath, [vueTsc, '--noEmit', '-p', path.join(dir, 'tsconfig.json'), '--types', 'vite/client'], {cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 170_000});
    return '';
  } catch (error) {
    const failed = error as {stdout?: string; stderr?: string; message: string};
    return failed.stdout || failed.stderr || failed.message;
  }
}

/** esbuild loads a .vue file as Vite's plugin does: script and template compiled by Vue, a `<style module>`'s classes as
 *  `$style` (named as they are: the test checks rendering, not class hashing). */
const vuePlugin: Plugin = {
  name: 'vue',
  setup(builder) {
    builder.onLoad({filter: /\.vue$/}, args => {
      const source = readFileSync(args.path, 'utf8');
      const {descriptor, errors} = parse(source, {filename: args.path});
      if (errors.length) throw new Error(`${args.path}: ${errors.map(String).join('\n')}`);
      const id = path.basename(args.path);
      const module = descriptor.styles.find(style => style.module);
      const classes = module ? Object.fromEntries([...module.content.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => [match[1], match[1]])) : null;
      const css = classes ? `__sfc.__cssModules = {$style: ${JSON.stringify(classes)}};\n` : '';
      if (!descriptor.script && !descriptor.scriptSetup) {
        const compiled = compileTemplate({source: descriptor.template!.content, filename: args.path, id});
        if (compiled.errors.length) throw new Error(`${args.path}: ${compiled.errors.map(String).join('\n')}`);
        return {contents: `${compiled.code}\nconst __sfc = {render};\n${css}export default __sfc;\n`, loader: 'ts'};
      }
      const script = compileScript(descriptor, {id, inlineTemplate: true});
      return {contents: `${script.content.replace('export default ', 'const __sfc = ')}\n${css}export default __sfc;\n`, loader: 'ts'};
    });
  },
};

for (const source of SOURCES) {
  for (const styling of STYLINGS) {
    test(`${source.name} as ${styling}: the Vue project type-checks with vue-tsc, compiles, and renders without a Vue warning`, {timeout: 240_000}, async () => {
      const doc = source.doc();
      const roots = doc.pages.flatMap(pageId => pageLayers(doc, pageId).map(node => node.id));
      const project = vueProjectFiles(doc, roots, {name: `Check ${source.name}`, styling, measurer: source.name === 'fixture' || source.name === 'buttons' ? fixtureMeasurer : measurer, fontFallback});
      const dir = writeProject(project.files, project.code.assets.map(asset => asset.path));
      try {
        assert.equal(typeErrors(dir), '', `vue-tsc errors in ${dir}`);

        const screens = project.code.components.filter(info => info.kind === 'screen');
        const hasComponents = project.files.some(file => file.path === 'src/ComponentsPage.vue');
        const entry = [
          "import {createSSRApp, type Component} from 'vue';",
          "import {renderToString} from 'vue/server-renderer';",
          ...screens.map(info => `import ${info.name} from './src/screens/${info.name}.vue';`),
          ...(hasComponents ? ["import ComponentsPage from './src/ComponentsPage.vue';"] : []),
          'export const warnings: string[] = [];',
          'export async function render(): Promise<[string, string][]> {',
          `  const pages: [string, Component][] = [${[...screens.map(info => `[${JSON.stringify(info.name)}, ${info.name}]`), ...(hasComponents ? ["['ComponentsPage', ComponentsPage]"] : [])].join(', ')}];`,
          '  const out: [string, string][] = [];',
          '  for (const [name, page] of pages) {',
          '    const app = createSSRApp(page);',
          '    app.config.warnHandler = (message, _instance, trace) => warnings.push(`${name}: ${message}${trace}`);',
          '    out.push([name, await renderToString(app)]);',
          '  }',
          '  return out;',
          '}',
        ].join('\n');
        writeFileSync(path.join(dir, 'render.ts'), entry);
        await build({
          entryPoints: [path.join(dir, 'render.ts')], outfile: path.join(dir, 'out', 'render.mjs'), bundle: true, platform: 'node', format: 'esm',
          external: ['vue', 'vue/server-renderer'], loader: {'.png': 'file', '.webp': 'file', '.jpg': 'file', '.gif': 'file', '.avif': 'file'}, logLevel: 'silent',
          plugins: [vuePlugin], define: {'process.env.NODE_ENV': '"development"'},
        });
        const rendering = await import(pathToFileURL(path.join(dir, 'out', 'render.mjs')).href) as {render(): Promise<[string, string][]>; warnings: string[]};
        const rendered = await rendering.render();
        assert.deepEqual(rendering.warnings, [], `Vue warnings while rendering ${dir}`);
        assert.equal(rendered.length, screens.length + (hasComponents ? 1 : 0));
        for (const [name, html] of rendered) assert.ok(html.length > 0, `${name} rendered nothing`);
      } finally {
        if (existsSync(dir) && !process.env.KEEP_CODEGEN) rmSync(dir, {recursive: true, force: true});
      }
    });
  }
}

const file = (files: readonly {path: string; contents: string}[], p: string) => {
  const found = files.find(f => f.path === p);
  assert.ok(found, `${p} in ${files.map(f => f.path).join(', ')}`);
  return found.contents;
};

test('a component is one single-file component: an exported props type, defaults, slots for the label and the swap, data attributes for variants', () => {
  const {files} = toVue(showcaseFile(), ['p'], {measurer: fixtureMeasurer});
  const button = file(files, 'src/components/Button.vue');
  assert.ok(!files.some(f => /\.(tsx|module\.css)$/.test(f.path) || f.path === 'src/lib/cx.ts'), 'no React files, no class joiner: Vue binds class arrays itself');
  assert.match(button, /^<!-- "Button" from Morfa\. -->\n<script lang="ts">\nexport type ButtonProps = \{\n/);
  assert.match(button, /size\?: 'large' \| 'small';/);
  assert.match(button, /withDefaults\(defineProps<ButtonProps>\(\), \{size: 'large', showIcon: true\}\);/);
  assert.match(button, /<button type="button" :class="\$style\.root" :data-size="size">/);
  assert.match(button, /<span v-if="showIcon" :class="\$style\.glyph"><slot name="glyph"><IconArrow \/><\/slot><\/span>/, 'a swap with a default is a named slot with that default; its toggle stays a prop');
  assert.match(button, /<span :class="\$style\.label"><slot>Buy<\/slot><\/span>/, 'the label is the default slot');
  assert.match(button, /<style module>\n\.root \{[\s\S]*\.root\[data-size='small'\] \{\n  padding: 8px 16px;\n\}[\s\S]*\.root:hover \{/, 'hover is CSS in the component\'s own <style module>');
  assert.doesNotMatch(button, /className|\{\.\.\.props\}|ReactNode/);

  const home = file(files, 'src/screens/Home.vue');
  assert.match(home, /import Button from '\.\.\/components\/Button\.vue';/);
  assert.match(home, /<Button size="small">\n\s+<template #glyph><IconPlus \/><\/template>\n\s+Learn more\n\s+<\/Button>/, 'a swapped instance passes the slot');
  assert.match(home, /<Button :showIcon="false">Buy<\/Button>/, 'a hidden swap turns its toggle off');
});

test('a text keeps its inline runs on one line, so the template adds no spaces; links, lists and pictures as in React', () => {
  const {files} = toVue(showcaseFile(), ['card'], {measurer: fixtureMeasurer});
  const card = file(files, 'src/screens/ProductCard.vue');
  assert.match(card, /\n {6}Notes: <span :class="\$style\.descriptionSpan">jasmine and bergamot<\/span>\. Learn more <a href="https:\/\/zerno\.example" target="_blank" rel="noopener noreferrer" :class="\$style\.descriptionLink">on the site<\/a>\n/);
  assert.match(card, /<img :class="\$style\.beanPhoto" :src="beanPhotoSrc" alt="Bean photo" \/>/);
  assert.match(card, /import beanPhotoSrc from '\.\.\/assets\/bean-photo\.webp';/);
  assert.match(card, /<div :class="\$style\.root" data-theme="dark">/, 'a picked variable mode is its attribute');
});

test('Tailwind: fixed classes as class, variant maps and the usage\'s class merged by Vue; inline: a typed styles object with units', () => {
  const tailwind = file(toVue(showcaseFile(), ['p'], {styling: 'tailwind', measurer: fixtureMeasurer}).files, 'src/components/Button.vue');
  assert.match(tailwind, /const rootSize = \{large: 'px-6 py-3', small: 'px-4 py-2'\};/);
  assert.match(tailwind, /<button type="button" class="inline-flex [^"]*hover:bg-\[#007BE5\]" :class="rootSize\[size\]">/);
  const inline = file(toVue(showcaseFile(), ['p'], {styling: 'inline', measurer: fixtureMeasurer}).files, 'src/components/Button.vue');
  assert.match(inline, /import \{type CSSProperties\} from 'vue';/);
  assert.match(inline, /root: \{border: '0', [^}]*gap: '8px', padding: '12px 24px'/, 'Vue writes numbers as they are: lengths keep px');
  assert.match(inline, /:style="\[styles\.root, size === 'small' \? styles\.rootSizeSmall : undefined\]"/);
});

test('the Vue project: Vite, Vue 3, vue-tsc, a screen switcher, a component page and an English README', () => {
  const project = vueProjectFiles(showcaseFile(), ['p'], {name: 'Beans landing', measurer: fixtureMeasurer});
  assert.equal(project.folder, 'beans-landing');
  const paths = project.files.map(f => f.path);
  for (const expected of ['package.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'README.md', 'src/main.ts', 'src/App.vue', 'src/ComponentsPage.vue', 'src/index.css', 'src/app.css',
    'src/vite-env.d.ts', 'src/tokens.css', 'src/tokens.ts', 'src/screens/Home.vue', 'src/screens/ProductCard.vue', 'src/components/Button.vue', 'src/components/IconArrow.vue']) {
    assert.ok(paths.includes(expected), `${expected} in ${paths.join(', ')}`);
  }
  const pkg = JSON.parse(file(project.files, 'package.json'));
  assert.deepEqual(pkg.dependencies, {vue: VUE_PROJECT_VERSIONS.vue});
  assert.equal(pkg.scripts.build, 'vue-tsc --noEmit && vite build');
  assert.deepEqual(Object.keys(pkg.devDependencies), ['@vitejs/plugin-vue', 'typescript', 'vite', 'vue-tsc']);
  assert.match(file(project.files, 'vite.config.ts'), /plugins: \[vue\(\)\]/);
  assert.match(file(project.files, 'index.html'), /<div id="app"><\/div>\n {4}<script type="module" src="\/src\/main\.ts"><\/script>/);
  assert.match(file(project.files, 'src/main.ts'), /import '\.\/tokens\.css';\nimport '\.\/app\.css';\nimport App from '\.\/App\.vue';\n\ncreateApp\(App\)\.mount\('#app'\);/);
  assert.match(file(project.files, 'src/App.vue'), /\{name: "Home", component: Home\},/);
  const page = file(project.files, 'src/ComponentsPage.vue');
  assert.match(page, /<Button size="small">Buy<\/Button>/, 'every look, with its label');
  assert.match(page, /import IconArrow from '\.\/components\/IconArrow\.vue';/);
  const readme = file(project.files, 'README.md');
  assert.match(readme, /Vue 3, TypeScript and Vite/);
  assert.match(readme, /`npm run build` checks the types \(vue-tsc\)/);
  const tailwind = vueProjectFiles(showcaseFile(), ['card'], {name: 'card', styling: 'tailwind', measurer: fixtureMeasurer});
  assert.match(file(tailwind.files, 'vite.config.ts'), /plugins: \[vue\(\), tailwindcss\(\)\]/);
  assert.equal(file(tailwind.files, 'src/index.css'), "@import 'tailwindcss';\n@import './theme.css';\n");
});

test('versions in the Vue project are the ones this repository type-checks it with', () => {
  const pkg = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
  for (const name of ['vue', 'vue-tsc', 'typescript', 'vite'] as const) {
    const version = VUE_PROJECT_VERSIONS[name];
    const installed = JSON.parse(readFileSync(path.join(repository, 'node_modules', name, 'package.json'), 'utf8')).version;
    assert.equal(version, installed, `${name}: the project pins what node_modules has`);
    const range = pkg.dependencies[name] ?? pkg.devDependencies[name];
    assert.ok(range, `${name} is a dependency of the app`);
    assert.equal(version.split('.')[0], range.replace(/^[\^~]/, '').split('.')[0], `${name}: same major as package.json`);
  }
});

test('texts and names from a hostile file stay text in a template', () => {
  let doc = createDocument('p');
  doc = add(doc, 'FRAME', {id: 'f', parentId: 'p', name: 'Screen --> <script>alert(1)</script>', width: 300, height: 200});
  doc = add(doc, 'TEXT', {id: 't', parentId: 'f', name: 'Text', text: defaultTextProps('{{ constructor.constructor("alert(1)")() }} <b>x</b> & "q"')});
  const vue = toVue(doc, ['f'], {measurer: fixtureMeasurer}).files.find(f => f.path.endsWith('.vue'))!.contents;
  assert.match(vue, /^<!-- "Screen - -> <script>alert\(1\)<\/script>" from Morfa\. -->\n<template>/, 'a name cannot end the comment');
  assert.ok(vue.includes(`{{ '\\x7b\\x7b constructor.constructor("alert(1)")() \\x7d\\x7d \\x3cb>x\\x3c/b> & "q"' }}`), `mustaches and tags in a text are a string, not an expression:\n${vue}`);
  const {descriptor, errors} = parse(vue, {filename: 'x.vue'});
  assert.deepEqual(errors, []);
  const compiled = compileTemplate({source: descriptor.template!.content, filename: 'x.vue', id: 'x'});
  assert.deepEqual(compiled.errors, []);
  assert.doesNotMatch(compiled.code, /_ctx\.constructor/, 'nothing of the text is read as an expression');
});

test('template expressions: strings in single quotes inside attributes, members and keys left alone, slot names renamed', () => {
  assert.equal(vueExpr('size === "small" ? "a\\"b" : label', {attr: true}), "size === 'small' ? 'a&quot;b' : label");
  assert.equal(vueExpr('icon && item.icon', {rename: name => (name === 'icon' ? '$slots.icon' : undefined)}), '$slots.icon && item.icon');
  assert.equal(vueExpr("{icon: 'x'}[icon]", {rename: name => (name === 'icon' ? 'I' : undefined)}), "{icon: 'x'}[I]");
  assert.equal(vueText('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(vueText(' edge ', true), "{{ ' edge ' }}");
});

test('React output is unchanged by the Vue mode', () => {
  const react = toReact(showcaseFile(), ['p'], {measurer: fixtureMeasurer});
  assert.ok(react.files.some(f => f.path === 'src/components/Button.tsx') && !react.files.some(f => f.path.endsWith('.vue')));
});
