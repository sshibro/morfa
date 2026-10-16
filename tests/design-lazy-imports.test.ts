import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Every lazy import of the design tool is a module-level function (`const load = () => import('./x')`, `lazy(() => import(…))`).
// The bundler's preload helper keeps the function that first asked for a chunk with a stylesheet: the stylesheet's `<link>`
// stays in the page with listeners whose closures reach that function. An `import()` written inside a component, a hook or a
// command therefore kept everything that function closed over alive for the rest of the tab — measured on 2026-10-07: after
// leaving a 20 000-layer file for another one, the first file's store, document and history (about 35 MB) stayed in memory,
// held by the realtime chunk's stylesheet through OpenedEditor's effect.

const ROOT = path.join(import.meta.dirname, '..', 'src', 'design');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const FUNCTIONS = new Set([
  ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);

/** `import()` calls that are not the body of a function written at module level, as `file:line`. */
export function nestedLazyImports(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const enclosing: ts.Node[] = [];
      for (let up = node.parent; up; up = up.parent) if (FUNCTIONS.has(up.kind)) enclosing.push(up);
      const fn = enclosing[0];
      // A module-level `() => …` with an expression body: no parameters or locals for the bundler's thunk to close over.
      const thunk = enclosing.length === 1 && ts.isArrowFunction(fn) && !fn.parameters.length && !ts.isBlock(fn.body);
      if (!thunk) out.push(`${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

test('lazy imports of the design tool are module-level functions, so no closed file stays in memory', () => {
  const found = sources(ROOT).flatMap(file => nestedLazyImports(file, readFileSync(file, 'utf8')));
  assert.deepEqual(found, [], 'move each into a module-level `const load… = () => import(…)`');
});

test('the check sees an import inside a component, a hook, a command and an async handler', () => {
  const code = `
    const ok = () => import('./a');
    const Lazy = lazy(() => import('./b').then(m => ({default: m.B})));
    const list = [() => import('./c')];
    function Component() { useEffect(() => { void import('./d'); }, []); }
    export async function save(doc) { await import('./e'); }
    const command = {run: async () => (await import('./f')).go()};
    const once = () => (cached ??= import('./g').then(m => m.go).catch(() => null));
    const handler = {run: async ctx => (await import('./h')).go(ctx)};
  `;
  assert.deepEqual(nestedLazyImports(path.join(ROOT, 'x.tsx'), code).map(each => each.split(':')[1]), ['5', '6', '9']);
});
