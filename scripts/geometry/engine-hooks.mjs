// Lane L1: module hooks that put the WASM geometry behind the TypeScript exports while S2's engine switch
// (shared/design/engine-switch.ts) does not exist yet. For each module listed in WIRED, every listed function's
// declaration is renamed `__ts_<name>` in the compiled module and the name is re-bound to
// `__engine(<module>, <name>, __ts_<name>)` (scripts/geometry/engine.ts), so callers inside the module go through
// the switch too: exactly what the `withEngine('geometry', …)` lines will do. No source file changes.
//
//   MORFA_ENGINE_GEOMETRY=wasm|both|ts node --import ./scripts/geometry/engine-register.mjs --test tests/…

import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineUrl = pathToFileURL(path.join(root, 'scripts/geometry/engine.ts')).href;

/** module (repository path) → the exports routed through the switch. */
export const WIRED = {
  'shared/design/geometry.ts': ['multiply', 'invert', 'localMatrixTs', 'worldMatrix', 'transformRect', 'boundsOfPoints', 'unionRects', 'worldBoxTs', 'decompose'],
  'shared/design/paths.ts': [
    'parsePathData', 'svgArcToCubics', 'ellipseArcCubics', 'formatNumber', 'serializePathData', 'transformPath', 'pathSegments', 'reversePath',
    'splitCubicAt', 'subCubic', 'pathBounds', 'pathsBounds', 'cubicSteps', 'flattenPath', 'windingNumber', 'distanceToPath', 'pathLength', 'fitCubics',
  ],
  'shared/design/shapes.ts': ['rectanglePath', 'ellipsePaths', 'polygonPath', 'starPath', 'nodeGeometry'],
  'shared/design/boolean.ts': ['fillArea', 'combineAreas', 'areaToPaths', 'combinePaths', 'combinePathsLive', 'booleanTolerance'],
  'shared/design/outline-stroke.ts': ['dashPolylines', 'strokeTolerance', 'strokeArea', 'polygonsToSmoothPaths'],
  'src/design/engine/hit-test.ts': ['flattenCommands', 'nodeOutline', 'hitsNode', 'hitTest', 'boxIntersectsRect', 'nodesInRect'],
};

const byUrl = new Map(Object.entries(WIRED).map(([file, names]) => [pathToFileURL(path.join(root, file)).href, {file, names}]));

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const wired = byUrl.get(url.split('?')[0]);
  if (!wired || process.env.MORFA_ENGINE_GEOMETRY === 'ts' || !process.env.MORFA_ENGINE_GEOMETRY) return result;
  let source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
  const tail = [`import {__engine as __morfa_engine} from ${JSON.stringify(engineUrl)};`];
  for (const name of wired.names) {
    // tsx may emit minified code (one line, `;` between statements, `const a=__name(…)`), or one statement a line.
    const fn = new RegExp(`(^|[\\n;}])(export )?function ${name}\\(`);
    const arrow = new RegExp(`(^|[\\n;}])(export )?const ${name} ?= ?`);
    let exported;
    if (fn.test(source)) {
      source = source.replace(fn, (_, start, exp) => { exported = !!exp; return `${start}function __ts_${name}(`; });
    } else if (arrow.test(source)) {
      source = source.replace(arrow, (_, start, exp) => { exported = !!exp; return `${start}const __ts_${name} = `; });
    } else throw new Error(`engine-hooks: ${name} not found in ${wired.file}`);
    // esbuild's keepNames call names the declaration right after it; it must name the renamed one (the re-bound
    // const is not initialised yet at that point).
    source = source.replace(`__name(${name},"${name}")`, `__name(__ts_${name},"${name}")`);
    // An `export { name }` list at the end (esbuild's form for some exports) still names the new binding.
    tail.push(`${exported ? 'export ' : ''}const ${name} = __morfa_engine(${JSON.stringify(wired.file)}, ${JSON.stringify(name)}, __ts_${name});`);
  }
  // The re-bound names come last: function declarations were hoisted, these are not, so a module that calls one
  // of them while it is still evaluating would fail loudly (none does).
  return {...result, source: `${source}\n${tail.join('\n')}\n`};
}
