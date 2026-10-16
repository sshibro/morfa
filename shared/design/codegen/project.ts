import {strToU8, zipSync, type Zippable} from 'fflate';
import type {DesignDocument, NodeId, SceneNode} from '../types';
import {readingOrder} from '../pdf-export';
import {PRODUCT_NAME} from '../product';
import {slugName} from './names';
import {toReact, type GeneratedFile, type ReactOptions, type ReactResult, type Styling} from './react';

// "Export to React…": a Vite + React + TypeScript project around the generated components and
// screens, ready for `npm install && npm run dev`. The versions are the ones this app is built with
// (tests/design-codegen-project.test.ts keeps them in step with package.json), so the project
// starts on a stack we know works.

export const PROJECT_VERSIONS = {
  react: '19.2.8',
  'react-dom': '19.2.8',
  '@types/react': '19.2.18',
  '@types/react-dom': '19.2.7',
  '@vitejs/plugin-react': '4.7.0',
  typescript: '5.9.3',
  vite: '6.4.3',
} as const;

/** Tailwind is not part of this app; these are the current major's releases at the time of writing. */
export const TAILWIND_VERSIONS = {tailwindcss: '^4.1.0', '@tailwindcss/vite': '^4.1.0'} as const;

export type ProjectOptions = ReactOptions & {
  /** The project's name (the folder and package name are made from it). */
  name: string;
  styling?: Styling;
};

export type Project = {
  /** Folder inside the zip, e.g. "zerno-landing". */
  folder: string;
  files: GeneratedFile[];
  code: ReactResult;
};

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EXPORTABLE = new Set<SceneNode['type']>(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'GROUP', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']);

/** What "Export to React…" offers of a page: its visible layers in reading order (rows from the top, each from the left),
 *  the order the project's screen switcher lists them in, as a designer lays the flow out. */
export function pageLayers(doc: DesignDocument, pageId: NodeId): SceneNode[] {
  const ids = (doc.nodes[pageId]?.children ?? []).filter(id => {
    const node = doc.nodes[id];
    return !!node && node.visible !== false && EXPORTABLE.has(node.type);
  });
  return readingOrder(doc, ids).map(id => doc.nodes[id]);
}

/** Families and weights the exported layers set type in (for the fonts link). */
export function fontsUsed(doc: DesignDocument, roots: readonly NodeId[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const stack = [...roots];
  const seen = new Set<NodeId>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.text) {
      for (const style of [node.text.style, ...node.text.runs.map(run => ({...node.text!.style, ...run.style}))]) {
        let weights = out.get(style.fontFamily);
        if (!weights) out.set(style.fontFamily, weights = new Set());
        weights.add(style.fontWeight);
      }
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return out;
}

export function googleFontsUrl(fonts: Map<string, Set<number>>): string | null {
  const families = [...fonts].filter(([family]) => /^[A-Za-z0-9 ]+$/.test(family)).sort(([a], [b]) => a.localeCompare(b));
  if (!families.length) return null;
  const params = families.map(([family, weights]) => `family=${family.trim().replace(/ /g, '+')}:wght@${[...weights].sort((a, b) => a - b).join(';')}`);
  return `https://fonts.googleapis.com/css2?${params.join('&')}&display=swap`;
}

/** The shell's reset: Tailwind's preflight, or box sizing, no body margin and block pictures (shared with the Vue project). */
export function indexCss(tailwind: boolean, hasTheme: boolean): string {
  return (tailwind ? [
    "@import 'tailwindcss';",
    ...(hasTheme ? ["@import './theme.css';"] : []),
  ] : [
    '/* Padding and borders sit inside an element\'s size, as in the design; pictures are blocks, not text. */',
    '*, *::before, *::after {',
    '  box-sizing: border-box;',
    '}',
    '',
    'body {',
    '  margin: 0;',
    '}',
    '',
    'img, svg {',
    '  display: block;',
    '}',
  ]).join('\n') + '\n';
}

/** The screen switcher's styles (shared with the Vue project). */
export const APP_CSS = [
  'body {',
  '  background: #f5f5f5;',
  "  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;",
  '}',
  '',
  '.app-nav {',
  '  position: sticky;',
  '  top: 0;',
  '  z-index: 10;',
  '  display: flex;',
  '  gap: 4px;',
  '  padding: 8px;',
  '  overflow-x: auto;',
  '  background: rgb(255 255 255 / 0.9);',
  '  backdrop-filter: blur(8px);',
  '  box-shadow: 0 1px 0 rgb(0 0 0 / 0.08);',
  '}',
  '',
  '.app-nav button {',
  '  flex: none;',
  '  padding: 6px 12px;',
  '  border: 0;',
  '  border-radius: 6px;',
  '  background: transparent;',
  '  color: #1e1e1e;',
  '  font: inherit;',
  '  font-size: 13px;',
  '  cursor: pointer;',
  '}',
  '',
  '.app-nav button[aria-current="page"] {',
  '  background: #1e1e1e;',
  '  color: #fff;',
  '}',
  '',
  '.app-screen {',
  '  display: flex;',
  '  justify-content: center;',
  '  padding: 24px;',
  '}',
  '',
  '.app-components {',
  '  display: flex;',
  '  flex-direction: column;',
  '  gap: 32px;',
  '}',
  '',
  '.app-components h2 {',
  '  margin: 0 0 12px;',
  '  font-size: 13px;',
  '  font-weight: 600;',
  '  color: #757575;',
  '}',
  '',
  '.app-examples {',
  '  display: flex;',
  '  flex-wrap: wrap;',
  '  align-items: flex-start;',
  '  gap: 16px;',
  '}',
  '',
].join('\n');

/** Every file of the project, paths relative to its folder. */
export function projectFiles(doc: DesignDocument, rootIds: readonly NodeId[], options: ProjectOptions): Project {
  const styling = options.styling ?? 'css-modules';
  const code = toReact(doc, rootIds, {...options, styling, tokens: 'always'});
  const folder = slugName(options.name, 'design-export');
  const title = options.name.trim() || `Export from ${PRODUCT_NAME}`;
  const files: GeneratedFile[] = [...code.files];
  const hasTokens = code.files.some(file => file.path === 'src/tokens.css');
  const hasTheme = code.files.some(file => file.path === 'src/theme.css');
  const screens = code.entries.filter(entry => entry.kind === 'screen');
  const components = code.entries.filter(entry => entry.kind === 'component');
  const tailwind = styling === 'tailwind';

  const dependencies = {react: PROJECT_VERSIONS.react, 'react-dom': PROJECT_VERSIONS['react-dom']};
  const devDependencies: Record<string, string> = {
    '@types/react': PROJECT_VERSIONS['@types/react'],
    '@types/react-dom': PROJECT_VERSIONS['@types/react-dom'],
    '@vitejs/plugin-react': PROJECT_VERSIONS['@vitejs/plugin-react'],
    ...(tailwind ? TAILWIND_VERSIONS : {}),
    typescript: PROJECT_VERSIONS.typescript,
    vite: PROJECT_VERSIONS.vite,
  };
  files.push({path: 'package.json', contents: json({
    name: folder, private: true, version: '0.1.0', type: 'module',
    scripts: {dev: 'vite', build: 'tsc --noEmit && vite build', preview: 'vite preview'},
    dependencies, devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))),
  })});

  const fontRoots = [...code.components.map(info => info.nodeId)];
  const fontsUrl = googleFontsUrl(fontsUsed(doc, fontRoots));
  files.push({path: 'index.html', contents: [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${escapeHtml(title)}</title>`,
    ...(fontsUrl ? ['    <link rel="preconnect" href="https://fonts.googleapis.com" />', '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />', `    <link rel="stylesheet" href="${escapeHtml(fontsUrl)}" />`] : []),
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')});

  files.push({path: 'tsconfig.json', contents: json({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx',
      strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, skipLibCheck: true,
      isolatedModules: true, noEmit: true, types: [],
    },
    include: ['src'],
  })});
  files.push({path: 'vite.config.ts', contents: [
    "import {defineConfig} from 'vite';",
    "import react from '@vitejs/plugin-react';",
    ...(tailwind ? ["import tailwindcss from '@tailwindcss/vite';"] : []),
    '',
    `export default defineConfig({plugins: [react()${tailwind ? ', tailwindcss()' : ''}]});`,
    '',
  ].join('\n')});
  files.push({path: 'src/vite-env.d.ts', contents: '/// <reference types="vite/client" />\n'});

  // Styles of the shell: a reset (Tailwind's preflight is its own; the theme comes from the design's tokens) and the switcher.
  files.push({path: 'src/index.css', contents: indexCss(tailwind, hasTheme)});
  files.push({path: 'src/app.css', contents: APP_CSS});

  // The switcher: every screen, then one page with the components and their variants.
  const imports = [
    ...screens.map(screen => `import {${screen.name}} from './screens/${screen.name}';`),
    ...components.map(component => `import {${component.name}} from './${(component.files[0] ?? `src/components/${component.name}.tsx`).replace(/^src\//, '').replace(/\.tsx$/, '')}';`),
  ];
  const pages = [
    ...screens.map(screen => `  {name: ${JSON.stringify(doc.nodes[screen.nodeId]?.name ?? screen.name)}, render: () => <${screen.name} />},`),
  ];
  if (components.length) {
    const blocks = components.map(component => {
      const examples = component.examples?.length ? component.examples : [`<${component.name} />`];
      return [
        '      <section>',
        `        <h2>${jsxText(doc.nodes[component.nodeId]?.name ?? component.name)}</h2>`,
        '        <div className="app-examples">',
        ...examples.map(example => `          ${example}`),
        '        </div>',
        '      </section>',
      ].join('\n');
    });
    pages.push(`  {name: 'Components', render: () => (\n    <div className="app-components">\n${blocks.join('\n')}\n    </div>\n  )},`);
  }
  files.push({path: 'src/App.tsx', contents: [
    "import {useState} from 'react';",
    ...imports,
    '',
    'const pages = [',
    ...pages,
    '];',
    '',
    'export function App() {',
    '  const [current, setCurrent] = useState(0);',
    '  const page = pages[current] ?? pages[0];',
    '  return (',
    '    <>',
    '      <nav className="app-nav" aria-label="Screens">',
    '        {pages.map((item, index) => (',
    "          <button key={item.name} type=\"button\" aria-current={index === current ? 'page' : undefined} onClick={() => setCurrent(index)}>",
    '            {item.name}',
    '          </button>',
    '        ))}',
    '      </nav>',
    '      <div className="app-screen">{page ? page.render() : null}</div>',
    '    </>',
    '  );',
    '}',
    '',
  ].join('\n')});
  files.push({path: 'src/main.tsx', contents: [
    "import {StrictMode} from 'react';",
    "import {createRoot} from 'react-dom/client';",
    "import './index.css';",
    ...(hasTokens ? ["import './tokens.css';"] : []),
    "import './app.css';",
    "import {App} from './App';",
    '',
    "createRoot(document.getElementById('root')!).render(",
    '  <StrictMode>',
    '    <App />',
    '  </StrictMode>,',
    ');',
    '',
  ].join('\n')});

  files.push({path: 'README.md', contents: readme({title, folder, styling, code, fontsUrl, hasTokens})});
  return {folder, files: files.sort((a, b) => a.path.localeCompare(b.path)), code};
}

const jsxText = (text: string) => (/[{}<>&]/.test(text) ? `{${JSON.stringify(text)}}` : text);

function readme(options: {title: string; folder: string; styling: Styling; code: ReactResult; fontsUrl: string | null; hasTokens: boolean}): string {
  const {title, folder, styling, code} = options;
  const screens = code.entries.filter(entry => entry.kind === 'screen');
  const components = code.components.filter(entry => entry.kind === 'component');
  const stylingText = styling === 'tailwind' ? 'Tailwind CSS 4 (classes right in the markup)' : styling === 'inline' ? 'inline styles (`styles` objects in each file)' : 'CSS Modules (a `.module.css` file next to each component)';
  const lines = [
    `# ${title}`,
    '',
    `This project was built from a design in ${PRODUCT_NAME}: React 19, TypeScript and Vite.`,
    '',
    '### How to run',
    '',
    'Node.js 20 or newer is required.',
    '',
    '```bash',
    `cd ${folder}`,
    'npm install',
    'npm run dev',
    '```',
    '',
    'Open the address Vite shows (usually http://localhost:5173). At the top is a screen switcher.',
    '',
    '`npm run build` checks the types and builds the production version into the `dist` folder.',
    '',
    '### What is inside',
    '',
    `- Styles: ${stylingText}.`,
    ...(screens.length ? [`- \`src/screens\`: screens (${screens.map(s => s.name).join(', ')}).`] : []),
    ...(components.length ? [`- \`src/components\`: components (${components.map(c => c.name).join(', ')}). Component properties became typed props and variants became union types.`] : []),
    ...(code.files.some(file => file.path.startsWith('src/icons/')) ? ['- `src/icons`: icons from the design, one component per picture (`aria-hidden` by default, the color comes from `color`).'] : []),
    ...(options.hasTokens ? ['- `src/tokens.css` and `src/tokens.ts`: design tokens, the design\'s styles and variables as CSS variables. Variable modes are switched with an attribute, for example `data-theme="dark"`.'] : []),
    ...(styling === 'tailwind' && code.files.some(file => file.path === 'src/theme.css') ? ['- `src/theme.css`: the Tailwind theme built from the design\'s styles and variables: `bg-*`, `text-*` (a whole text style), `shadow-*`, `font-family-*`.'] : []),
    ...(code.assets.length ? ['- `src/assets`: images from the design.'] : []),
    '- `src/App.tsx`: the screen switcher; you can delete it once the screens are in your app.',
    '',
    '### How the code works',
    '',
    '- Components accept the props of their element (`ComponentPropsWithRef<\'button\'>` and the like): `onClick`, `disabled`, `aria-*` and `ref` are passed through as they are. A button\'s label is `children`.',
    '- Hover, pressed, focus and disabled states from variants became CSS (`:hover`, `:active`, `:focus-visible`, `:disabled`) instead of props.',
    '- Auto layout became flexbox and constraints became absolute positioning; identical elements in a row became a data array and `.map()`.',
    '- Screens take the window width up to the design width and at least the window height; nested sizes come from the design in pixels.',
    ...(options.fontsUrl ? ['- Fonts are loaded from Google Fonts in `index.html`. If a font is not there, or you need to work without external requests, add the font files yourself.'] : []),
  ];
  if (code.warnings.length) {
    lines.push('', '### What to carry over by hand', '', ...code.warnings.map(warning => `- ${warning}`));
  }
  lines.push('');
  return lines.join('\n');
}

/** The project as a zip (files under `folder/`). `assets` holds the bytes of each picture by its path. */
export function projectZip(project: Project, assets: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const tree: Zippable = {};
  const mtime = new Date('2026-01-01T00:00:00Z');
  for (const file of project.files) tree[`${project.folder}/${file.path}`] = [strToU8(file.contents), {mtime}];
  for (const asset of project.code.assets) {
    const bytes = assets.get(asset.path);
    if (bytes) tree[`${project.folder}/${asset.path}`] = [bytes, {mtime, level: 0}];
  }
  return zipSync(tree, {level: 6});
}

/** Just the files of a component or a selection (no project around them), zipped flat. */
export function filesZip(files: readonly GeneratedFile[], assets: ReadonlyMap<string, Uint8Array> = new Map()): Uint8Array {
  const tree: Zippable = {};
  const mtime = new Date('2026-01-01T00:00:00Z');
  for (const file of files) tree[file.path.replace(/^src\//, '')] = [strToU8(file.contents), {mtime}];
  for (const [path, bytes] of assets) tree[path.replace(/^src\//, '')] = [bytes, {mtime, level: 0}];
  return zipSync(tree, {level: 6});
}
