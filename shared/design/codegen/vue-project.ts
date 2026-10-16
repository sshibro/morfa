import type {DesignDocument, NodeId} from '../types';
import {PRODUCT_NAME} from '../product';
import {slugName} from './names';
import {APP_CSS, PROJECT_VERSIONS, TAILWIND_VERSIONS, escapeHtml, fontsUsed, googleFontsUrl, indexCss, json, type Project, type ProjectOptions} from './project';
import {toVue, type GeneratedFile, type ReactResult, type Styling} from './react';
import {vueText} from './vue';

// "Export to Vue…": a Vite + Vue 3 + TypeScript project around the generated single-file components, ready for
// `npm install && npm run dev`, the twin of the React project (project.ts): the same shell styles, screen switcher, component
// page and README sections. Vue and vue-tsc are this repository's dev dependencies (tests/design-codegen-vue.test.ts
// type-checks every exported project with them and keeps the versions in step with package.json).

export const VUE_PROJECT_VERSIONS = {
  vue: '3.5.43',
  '@vitejs/plugin-vue': '6.0.9',
  typescript: PROJECT_VERSIONS.typescript,
  vite: PROJECT_VERSIONS.vite,
  'vue-tsc': '3.3.13',
} as const;

/** Every file of the Vue project, paths relative to its folder. */
export function vueProjectFiles(doc: DesignDocument, rootIds: readonly NodeId[], options: ProjectOptions): Project {
  const styling = options.styling ?? 'css-modules';
  const code = toVue(doc, rootIds, {...options, styling, tokens: 'always'});
  const folder = slugName(options.name, 'design-export');
  const title = options.name.trim() || `Export from ${PRODUCT_NAME}`;
  const files: GeneratedFile[] = [...code.files];
  const hasTokens = code.files.some(file => file.path === 'src/tokens.css');
  const hasTheme = code.files.some(file => file.path === 'src/theme.css');
  const screens = code.entries.filter(entry => entry.kind === 'screen');
  const components = code.entries.filter(entry => entry.kind === 'component');
  const tailwind = styling === 'tailwind';

  const devDependencies: Record<string, string> = {
    '@vitejs/plugin-vue': VUE_PROJECT_VERSIONS['@vitejs/plugin-vue'],
    ...(tailwind ? TAILWIND_VERSIONS : {}),
    typescript: VUE_PROJECT_VERSIONS.typescript,
    vite: VUE_PROJECT_VERSIONS.vite,
    'vue-tsc': VUE_PROJECT_VERSIONS['vue-tsc'],
  };
  files.push({path: 'package.json', contents: json({
    name: folder, private: true, version: '0.1.0', type: 'module',
    scripts: {dev: 'vite', build: 'vue-tsc --noEmit && vite build', preview: 'vite preview'},
    dependencies: {vue: VUE_PROJECT_VERSIONS.vue}, devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))),
  })});

  const fontsUrl = googleFontsUrl(fontsUsed(doc, code.components.map(info => info.nodeId)));
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
    '    <div id="app"></div>',
    '    <script type="module" src="/src/main.ts"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')});

  files.push({path: 'tsconfig.json', contents: json({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'preserve',
      strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, skipLibCheck: true,
      isolatedModules: true, noEmit: true, types: [],
    },
    include: ['src/**/*.ts', 'src/**/*.vue'],
  })});
  files.push({path: 'vite.config.ts', contents: [
    "import {defineConfig} from 'vite';",
    "import vue from '@vitejs/plugin-vue';",
    ...(tailwind ? ["import tailwindcss from '@tailwindcss/vite';"] : []),
    '',
    `export default defineConfig({plugins: [vue()${tailwind ? ', tailwindcss()' : ''}]});`,
    '',
  ].join('\n')});
  files.push({path: 'src/vite-env.d.ts', contents: '/// <reference types="vite/client" />\n'});
  files.push({path: 'src/index.css', contents: indexCss(tailwind, hasTheme)});
  files.push({path: 'src/app.css', contents: APP_CSS});

  // The component page: each component in its looks. Its examples may pass other components into slots, so it imports every
  // component they name.
  const pages = screens.map(screen => ({name: doc.nodes[screen.nodeId]?.name ?? screen.name, component: screen.name}));
  if (components.length) {
    const named = new Set(components.flatMap(component => (component.examples?.length ? component.examples : [`<${component.name} />`]).flatMap(example => [...example.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)].map(match => match[1]))));
    const imports = code.components.filter(info => info.kind === 'component' && named.has(info.name)).sort((a, b) => a.name.localeCompare(b.name))
      .map(info => `import ${info.name} from './${(info.files[0] ?? `src/components/${info.name}.vue`).replace(/^src\//, '')}';`);
    const sections = components.flatMap(component => [
      '    <section>',
      `      <h2>${vueText(doc.nodes[component.nodeId]?.name ?? component.name)}</h2>`,
      '      <div class="app-examples">',
      ...(component.examples?.length ? component.examples : [`<${component.name} />`]).map(example => `        ${example}`),
      '      </div>',
      '    </section>',
    ]);
    files.push({path: 'src/ComponentsPage.vue', contents: [
      '<script setup lang="ts">',
      ...imports,
      '</script>',
      '',
      '<template>',
      '  <div class="app-components">',
      ...sections,
      '  </div>',
      '</template>',
      '',
    ].join('\n')});
    pages.push({name: 'Components', component: 'ComponentsPage'});
  }
  files.push({path: 'src/App.vue', contents: [
    '<script setup lang="ts">',
    "import {ref, type Component} from 'vue';",
    ...screens.map(screen => `import ${screen.name} from './screens/${screen.name}.vue';`),
    ...(components.length ? ["import ComponentsPage from './ComponentsPage.vue';"] : []),
    '',
    'const pages: {name: string; component: Component}[] = [',
    ...pages.map(page => `  {name: ${JSON.stringify(page.name)}, component: ${page.component}},`),
    '];',
    'const current = ref(0);',
    '</script>',
    '',
    '<template>',
    '  <nav class="app-nav" aria-label="Screens">',
    '    <button v-for="(page, index) in pages" :key="page.name" type="button" :aria-current="index === current ? \'page\' : undefined" @click="current = index">',
    '      {{ page.name }}',
    '    </button>',
    '  </nav>',
    '  <div class="app-screen">',
    '    <component :is="pages[current].component" v-if="pages[current]" />',
    '  </div>',
    '</template>',
    '',
  ].join('\n')});
  files.push({path: 'src/main.ts', contents: [
    "import {createApp} from 'vue';",
    "import './index.css';",
    ...(hasTokens ? ["import './tokens.css';"] : []),
    "import './app.css';",
    "import App from './App.vue';",
    '',
    "createApp(App).mount('#app');",
    '',
  ].join('\n')});

  files.push({path: 'README.md', contents: readme({title, folder, styling, code, fontsUrl, hasTokens})});
  return {folder, files: files.sort((a, b) => a.path.localeCompare(b.path)), code};
}

function readme(options: {title: string; folder: string; styling: Styling; code: ReactResult; fontsUrl: string | null; hasTokens: boolean}): string {
  const {title, folder, styling, code} = options;
  const screens = code.entries.filter(entry => entry.kind === 'screen');
  const components = code.components.filter(entry => entry.kind === 'component');
  const stylingText = styling === 'tailwind' ? 'Tailwind CSS 4 (classes right in the template)' : styling === 'inline' ? 'inline styles (`styles` objects in each component)' : 'CSS Modules (a `<style module>` block in each component, classes via `$style`)';
  const lines = [
    `# ${title}`,
    '',
    `This project was built from a design in ${PRODUCT_NAME}: Vue 3, TypeScript and Vite.`,
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
    '`npm run build` checks the types (vue-tsc) and builds the production version into the `dist` folder.',
    '',
    '### What is inside',
    '',
    `- Styles: ${stylingText}.`,
    ...(screens.length ? [`- \`src/screens\`: screens (${screens.map(s => s.name).join(', ')}).`] : []),
    ...(components.length ? [`- \`src/components\`: components (${components.map(c => c.name).join(', ')}). Component properties became typed props (\`defineProps\`) and variants became union types.`] : []),
    ...(code.files.some(file => file.path.startsWith('src/icons/')) ? ['- `src/icons`: icons from the design, one component per picture (`aria-hidden` by default, the color comes from `color`).'] : []),
    ...(options.hasTokens ? ['- `src/tokens.css` and `src/tokens.ts`: design tokens, the design\'s styles and variables as CSS variables. Variable modes are switched with an attribute, for example `data-theme="dark"`.'] : []),
    ...(styling === 'tailwind' && code.files.some(file => file.path === 'src/theme.css') ? ['- `src/theme.css`: the Tailwind theme built from the design\'s styles and variables: `bg-*`, `text-*` (a whole text style), `shadow-*`, `font-family-*`.'] : []),
    ...(code.assets.length ? ['- `src/assets`: images from the design.'] : []),
    '- `src/App.vue`: the screen switcher; you can delete it once the screens are in your app.',
    '',
    '### How the code works',
    '',
    '- Single-file components on `<script setup lang="ts">`. Attributes and handlers that are not among the props (`@click`, `disabled`, `aria-*`, `class`) are passed to the root element by Vue itself. A button\'s label is the default slot; an instance swap is a named slot.',
    '- Hover, pressed, focus and disabled states from variants became CSS (`:hover`, `:active`, `:focus-visible`, `:disabled`) instead of props.',
    '- Auto layout became flexbox and constraints became absolute positioning; identical elements in a row became a data array and `v-for`.',
    '- Screens take the window width up to the design width and at least the window height; nested sizes come from the design in pixels.',
    ...(options.fontsUrl ? ['- Fonts are loaded from Google Fonts in `index.html`. If a font is not there, or you need to work without external requests, add the font files yourself.'] : []),
  ];
  if (code.warnings.length) {
    lines.push('', '### What to carry over by hand', '', ...code.warnings.map(warning => `- ${warning}`));
  }
  lines.push('');
  return lines.join('\n');
}
