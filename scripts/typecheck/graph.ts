// Reads which repository files import which, for planning the type-check programs (plan.ts).
// Only the import statements are scanned, so this takes a second or two and little memory.
import path from 'node:path';
import ts from 'typescript';
import type {ImportGraph} from './plan';

const posix = (file: string) => file.split(path.sep).join('/');

/** The root files and compiler options of `<repo>/tsconfig.json`, files repository-relative. */
export function rootProgram(repo: string): {roots: string[]; options: ts.CompilerOptions} {
  const failed = (diagnostic: ts.Diagnostic): never => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(repo, 'tsconfig.json'),
    {},
    {...ts.sys, onUnRecoverableConfigFileDiagnostic: failed},
  );
  if (!parsed) throw new Error(`Could not read ${path.join(repo, 'tsconfig.json')}.`);
  if (parsed.errors.length) failed(parsed.errors[0]);
  return {roots: parsed.fileNames.map(file => posix(path.relative(repo, file))), options: parsed.options};
}

/**
 * The files each root reaches through relative imports, `import()`, `require` and reference paths,
 * resolved the way the compiler resolves them. Package imports are not followed: nothing in
 * node_modules imports this repository.
 */
export function importGraph(repo: string, roots: readonly string[], options: ts.CompilerOptions): ImportGraph {
  const cache = ts.createModuleResolutionCache(repo, file => file, options);
  const inRepo = (file: string) => !path.relative(repo, file).startsWith('..') && !file.includes('/node_modules/');
  const importsOf = (file: string): string[] => {
    if (!/\.[cm]?tsx?$/.test(file)) return [];
    const absolute = path.join(repo, file);
    const {importedFiles, referencedFiles} = ts.preProcessFile(ts.sys.readFile(absolute) ?? '', true, true);
    const imported = importedFiles
      .filter(({fileName}) => fileName.startsWith('.'))
      .map(
        ({fileName}) =>
          ts.resolveModuleName(fileName, absolute, options, ts.sys, cache).resolvedModule?.resolvedFileName,
      );
    const referenced = referencedFiles.map(({fileName}) => path.resolve(path.dirname(absolute), fileName));
    const targets = [...imported, ...referenced].filter(
      (target): target is string => target !== undefined && inRepo(target),
    );
    return [...new Set(targets.map(target => posix(path.relative(repo, target))))];
  };
  const graph = new Map<string, string[]>();
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (graph.has(file)) continue;
    const imported = importsOf(file);
    graph.set(file, imported);
    queue.push(...imported);
  }
  return graph;
}
