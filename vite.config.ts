import {realpathSync} from 'node:fs';
import {defineConfig, loadEnv, searchForWorkspaceRoot} from 'vite';
import react from '@vitejs/plugin-react';
import {webOrigin} from './shared/web-origins';

// The editor: index.html → src/main.tsx, built into dist/app with `--mode app`. Ports: docs/dev.md.
const DEV_PORT = 5400;
const DEV_API = 'http://127.0.0.1:3400';
// A production build without VITE_APP_ORIGIN uses this origin (morfa.example is a placeholder domain); the variable overrides it.
const PRODUCTION_APP_ORIGIN = 'https://app.morfa.example';
// The server answers these paths; the dev server forwards them (the e2e server has its own list: scripts/e2e-server.ts).
// The MCP server's endpoint, its sign-in and their well-known documents (server/mcp) live on the app's origin too.
const API_ROUTES = ['/api', '/uploads', '/fonts', '/mcp', '/oauth', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server'];
// node_modules may be a symlink to a shared install outside the repository; package assets such as @fontsource files
// are served through /@fs/ from that real path, so it has to be an allowed root.
function realNodeModules() {
  try { return realpathSync('node_modules'); } catch { return 'node_modules'; }
}

export default defineConfig(({mode, command}) => {
  const production = command === 'build';
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const app = webOrigin(env.VITE_APP_ORIGIN || (production ? PRODUCTION_APP_ORIGIN : `http://127.0.0.1:${DEV_PORT}`), production);
  return {
    // In the checkout, not in node_modules: that may be one install shared by several checkouts (docs/dev.md).
    cacheDir: `.vite/${mode}`,
    optimizeDeps: {entries: ['index.html']},
    plugins: [react(), {name: 'morfa-entry', transformIndexHtml: {order: 'pre', handler(html) {
      // The application is private: no public metadata, never indexed.
      return html.replace(/<meta (?:name="(?:description|keywords|twitter:[^"]+)"|property="og:[^"]+")[^>]*>\s*/g, '')
        .replace(/<meta name="robots"[^>]*>\s*/g, '')
        .replace('</head>', '<meta name="robots" content="noindex" />\n</head>');
    }}, generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(chunk => chunk.type === 'chunk');
      // Read by scripts/performance/budgets.mjs to find the chunk that holds a lazily loaded route entry.
      this.emitFile({type: 'asset', fileName: 'build-graph.json', source: JSON.stringify({chunks: chunks.map(chunk => ({
        file: chunk.fileName, imports: chunk.imports, dynamicImports: chunk.dynamicImports, isEntry: chunk.isEntry,
        facade: chunk.facadeModuleId?.replace(process.cwd() + '/', '') ?? null,
        modules: Object.keys(chunk.modules).map(id => id.replace(process.cwd() + '/', '')).sort(),
      }))}, null, 2) + '\n'});
    }}],
    define: {'import.meta.env.VITE_APP_ORIGIN': JSON.stringify(app)},
    // VITE_API_PROXY points the dev server at another API (a QA harness); the default is `npm run dev`'s.
    server: {port: DEV_PORT, strictPort: true,
      fs: {allow: [searchForWorkspaceRoot(process.cwd()), realNodeModules()]},
      proxy: Object.fromEntries(API_ROUTES.map(route => [route, process.env.VITE_API_PROXY || DEV_API]))},
    // No source maps: nothing reads them yet, and a served map would publish the source.
    build: {outDir: 'dist/app', sourcemap: false, manifest: true},
  };
});
