import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

// Initial JavaScript per route, gzip level 9, in KiB: the ceilings the design tool is held to (docs/design-tool.md §Performance).
export const CEILINGS_KIB = {designFiles: 230, designEditor: 700};
const routes = {
  // The file browser (#designs), then an open file (#design/<id>): the boot entry (index.html → src/main.tsx), the shell
  // (src/App.tsx) and the design code it loads on demand. An entry bundled into its importer is found through build-graph.json.
  designFiles: {root: 'dist/app', entries: ['index.html', 'src/App.tsx', 'src/design/DesignRoot.tsx']},
  designEditor: {root: 'dist/app', entries: ['index.html', 'src/App.tsx', 'src/design/DesignRoot.tsx', 'src/design/editor/DesignEditor.tsx']},
};
export function resolveRouteEntries(manifest, graph, entries) {
  return entries.map(entry => {
    if (manifest[entry]) return entry;
    const chunks = graph.chunks.filter(chunk => chunk.facade === entry || chunk.modules.includes(entry));
    if (chunks.length !== 1) throw Error(`Expected one emitted chunk containing ${entry}; found ${chunks.length}.`);
    const keys = Object.keys(manifest).filter(key => manifest[key].file === chunks[0].file);
    if (keys.length !== 1) throw Error(`Expected one manifest key for ${entry} (${chunks[0].file}); found ${keys.length}.`);
    return keys[0];
  });
}
export function initialDependencies(manifest, entries) {
  const visited = new Set(), js = new Set(), css = new Set(), assets = new Set();
  const visit = key => {
    if (visited.has(key)) return;
    const chunk = manifest[key];
    if (!chunk) throw Error(`Initial route entry is absent from the build manifest: ${key}`);
    visited.add(key);
    if (/\.m?js$/.test(chunk.file)) js.add(chunk.file);
    (chunk.css || []).forEach(file => css.add(file));
    (chunk.assets || []).forEach(file => assets.add(file));
    (chunk.imports || []).forEach(visit);
  };
  entries.forEach(visit);
  return {js: [...js].sort(), css: [...css].sort(), assets: [...assets].sort()};
}
const baselinePath = 'scripts/performance/initial-js-baseline.json';
const gzipBytes = async (root, files) => {
  const rows = await Promise.all(files.map(async file => {const bytes = await fs.readFile(path.join(root, file)); return {file, raw: bytes.length, gzip: gzipSync(bytes, {level: 9}).length};}));
  return {raw: rows.reduce((sum, row) => sum + row.raw, 0), gzip: rows.reduce((sum, row) => sum + row.gzip, 0), files: rows};
};

export async function measureInitialRoutes() {
  const results = {};
  for (const [name, route] of Object.entries(routes)) {
    const manifest = JSON.parse(await fs.readFile(path.join(route.root, '.vite/manifest.json'), 'utf8'));
    const graph = JSON.parse(await fs.readFile(path.join(route.root, 'build-graph.json'), 'utf8'));
    const resolvedEntries = resolveRouteEntries(manifest, graph, route.entries);
    const dependencies = initialDependencies(manifest, resolvedEntries);
    const [js, css, assets] = await Promise.all([gzipBytes(route.root, dependencies.js), gzipBytes(route.root, dependencies.css), gzipBytes(route.root, dependencies.assets)]);
    results[name] = {entries: route.entries, resolvedEntries, ceilingKiB: CEILINGS_KIB[name] ?? null, js, css, assets};
  }
  return {routes: results, method: 'gzip level 9, each distinct initial JS file once per route; parent entry plus requested route and all static dependencies. Dynamic features are excluded until explicitly requested. CSS and fonts are reported separately.'};
}

export function budgetFailures(report, baseline) {
  const failures = [];
  for (const [name, ceiling] of Object.entries(CEILINGS_KIB)) {
    const bytes = report.routes[name].js.gzip;
    if (bytes > ceiling * 1024) failures.push(`${name}: ${(bytes / 1024).toFixed(2)} KiB exceeds ${ceiling} KiB initial JS ceiling.`);
    if (baseline?.routes?.[name] !== undefined) {
      const accepted = baseline.routes[name], allowance = Math.max(10 * 1024, accepted * .05);
      if (bytes > accepted + allowance) failures.push(`${name}: growth ${(bytes - accepted).toLocaleString('en')} bytes exceeds max(10 KiB, 5% of accepted baseline).`);
    }
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const report = await measureInitialRoutes();
    const accept = process.argv.includes('--accept-baseline');
    const baseline = await fs.readFile(baselinePath, 'utf8').then(JSON.parse).catch(() => null);
    const failures = budgetFailures(report, accept ? null : baseline);
    if (!accept && !baseline) failures.push('No accepted initial-JS baseline. Review current measurements, then explicitly run with --accept-baseline.');
    report.failures = failures;
    await fs.mkdir('output/performance', {recursive: true});
    await fs.writeFile('output/performance/initial-route-budgets.json', JSON.stringify(report, null, 2) + '\n');
    for (const [name, value] of Object.entries(report.routes)) console.log(`${name.padEnd(12)} JS ${(value.js.gzip / 1024).toFixed(2)} KiB · CSS ${(value.css.gzip / 1024).toFixed(2)} KiB · ${value.js.files.length} initial JS files`);
    if (failures.length) throw Error(failures.join('\n'));
    if (accept) {
      await fs.writeFile(baselinePath, JSON.stringify({version: 1, ceilingsKiB: CEILINGS_KIB, routes: Object.fromEntries(Object.keys(CEILINGS_KIB).map(name => [name, report.routes[name].js.gzip]))}, null, 2) + '\n');
      console.log('Accepted current measured baseline; fixed ceilings remain unchanged.');
    }
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
