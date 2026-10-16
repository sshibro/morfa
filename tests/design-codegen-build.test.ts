import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';
import {build} from 'esbuild';
import {projectFiles, type Styling} from '../shared/design/codegen';
import {pageLayers} from '../shared/design/codegen/project';
import {templateById, type TemplateId} from '../shared/design/templates';
import type {TextMeasurer} from '../shared/design/text-layout';
import {fontFallback} from '../src/design/engine/commands/code';
import {buttonFile, showcaseFile, measurer as fixtureMeasurer} from './design-codegen-fixture';
import type {DesignDocument} from '../shared/design/types';

// The exported project as a developer gets it: every starter template and the fixture file, in every styling, is
// written to disk and compiled by TypeScript with the project's own tsconfig (strict, no unused locals or parameters)
// against the real React types; then its screens and every look of every component are bundled by esbuild and
// rendered by react-dom/server, and any React warning (an unknown prop reaching the DOM, a missing key, invalid
// nesting React reports) fails the test.

const repository = fileURLToPath(new URL('..', import.meta.url));
const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.56, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const STYLINGS: Styling[] = ['css-modules', 'tailwind', 'inline'];

function templateDoc(id: TemplateId): DesignDocument {
  let seq = 0;
  return templateById(id)!.build({measurer, newId: () => `n${(seq++).toString(36)}`});
}

const SOURCES: {name: string; doc: () => DesignDocument}[] = [
  ...(['ui-kit', 'mobile', 'site', 'presentation', 'social'] as TemplateId[]).map(id => ({name: id, doc: () => templateDoc(id)})),
  {name: 'fixture', doc: () => showcaseFile()},
  {name: 'buttons', doc: () => buttonFile().doc},
];

/** Writes the project to a fresh folder that resolves packages from this repository. */
function writeProject(files: readonly {path: string; contents: string}[], assets: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'morfa-codegen-'));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file.path)), {recursive: true});
    writeFileSync(path.join(dir, file.path), file.contents);
  }
  // A one-pixel PNG stands in for each picture (the zip carries the real bytes).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  for (const asset of assets) {
    mkdirSync(path.dirname(path.join(dir, asset)), {recursive: true});
    writeFileSync(path.join(dir, asset), png);
  }
  symlinkSync(path.join(repository, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** TypeScript's verdict on the project, with its own tsconfig. */
function typeErrors(dir: string): string[] {
  const configPath = path.join(dir, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
  const program = ts.createProgram(parsed.fileNames, {...parsed.options, types: ['vite/client'], typeRoots: [path.join(dir, 'node_modules', '@types'), path.join(dir, 'node_modules')]});
  return ts.getPreEmitDiagnostics(program).map(d => {
    const where = d.file ? `${path.relative(dir, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : '';
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

for (const source of SOURCES) {
  for (const styling of STYLINGS) {
    test(`${source.name} as ${styling}: the project type-checks strictly and every screen and component renders without a React warning`, async () => {
      const doc = source.doc();
      const roots = doc.pages.flatMap(pageId => pageLayers(doc, pageId).map(node => node.id));
      const project = projectFiles(doc, roots, {name: `Check ${source.name}`, styling, measurer: source.name === 'fixture' || source.name === 'buttons' ? fixtureMeasurer : measurer, fontFallback});
      const dir = writeProject(project.files, project.code.assets.map(asset => asset.path));
      try {
        assert.deepEqual(typeErrors(dir), [], `TypeScript errors in ${dir}`);

        // Every screen, and every component in each of its looks (the project's component page shows the same examples).
        const screens = project.code.components.filter(info => info.kind === 'screen');
        const components = project.code.components.filter(info => info.kind === 'component');
        const entry = [
          "import {renderToStaticMarkup} from 'react-dom/server';",
          ...screens.map(info => `import {${info.name}} from './src/screens/${info.name}';`),
          ...components.map(info => `import {${info.name}} from './src/components/${info.name}';`),
          'export const rendered: [string, string][] = [];',
          'const render = (name: string, element: React.ReactElement) => rendered.push([name, renderToStaticMarkup(element)]);',
          ...screens.map(info => `render(${JSON.stringify(info.name)}, <${info.name} />);`),
          ...components.flatMap(info => (info.examples ?? []).map(example => `render(${JSON.stringify(example)}, ${example});`)),
        ].join('\n');
        writeFileSync(path.join(dir, 'render.tsx'), entry);
        await build({
          entryPoints: [path.join(dir, 'render.tsx')], outfile: path.join(dir, 'out', 'render.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
          external: ['react', 'react-dom', 'react/jsx-runtime'], loader: {'.png': 'file', '.webp': 'file', '.jpg': 'file', '.gif': 'file', '.avif': 'file'}, logLevel: 'silent',
          define: {'process.env.NODE_ENV': '"development"'},
        });
        const warnings: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
        let rendered: [string, string][];
        try {
          ({rendered} = await import(pathToFileURL(path.join(dir, 'out', 'render.mjs')).href) as {rendered: [string, string][]});
        } finally {
          console.error = original;
        }
        assert.deepEqual(warnings, [], `React warnings while rendering ${dir}`);
        assert.equal(rendered.length, screens.length + components.reduce((sum, info) => sum + (info.examples?.length ?? 0), 0));
        for (const [name, html] of rendered) assert.ok(html.length > 0, `${name} rendered nothing`);
      } finally {
        if (existsSync(dir) && !process.env.KEEP_CODEGEN) rmSync(dir, {recursive: true, force: true});
      }
    });
  }
}
