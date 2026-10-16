// Splits the files of tsconfig.json into programs that are type-checked one after another, each in
// its own process, so no single check holds the whole repository in memory (docs/dev.md, §Type check).
//
// Source files go by directory. A test goes to the program that already loads most of what it
// imports. Every program is checked together with everything it imports, so no file is ever checked
// against anything but the real sources.

/** Repository-relative file → the repository files it imports. */
export type ImportGraph = ReadonlyMap<string, readonly string[]>;

export type PlannedProgram = {name: string; files: string[]};

export type SourceProgram = {
  name: string;
  /** Root files under these directories are checked in this program. */
  dirs: readonly string[];
  /** How many programs share this program's tests. Raise it when run.ts says the program is too big. */
  testPrograms: number;
};

export type PlanInput = {
  /** The root files of tsconfig.json, repository-relative. */
  roots: readonly string[];
  imports: ImportGraph;
  bytes: (file: string) => number;
  programs?: readonly SourceProgram[];
};

// The first matching directory decides, so src/design/ is listed before src/. Roots outside these
// directories (tests, vite.config.ts, playwright.config.ts) are placed by what they import, and on a
// tie the earlier program takes them: a test that only needs shared/ stays out of the bigger programs.
export const SOURCE_PROGRAMS: readonly SourceProgram[] = [
  // The document model, geometry, codegen and the rest of shared/design, with the few shared helpers.
  {name: 'shared', dirs: ['shared/'], testPrograms: 1},
  // The API (server/design, accounts, PostgreSQL) and the repository's scripts.
  {name: 'server', dirs: ['server/', 'scripts/'], testPrograms: 1},
  // The editor (src/design, docs/design-tool.md), the largest program, with the tests that need it.
  {name: 'design', dirs: ['src/design/'], testPrograms: 1},
  // Everything else the browser loads: the shell and sign-in.
  {name: 'client', dirs: ['src/'], testPrograms: 1},
];

// Declaration files hold ambient types (import.meta.env, asset modules) that files use without
// importing them, so every program gets them, as the single program did.
const isAmbient = (file: string) => file.endsWith('.d.ts');

/** Adds to `loaded` every file the seeds reach and returns the files that were new. */
function load(imports: ImportGraph, loaded: Set<string>, seeds: readonly string[]): string[] {
  const added: string[] = [];
  const queue = [...seeds];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (loaded.has(file)) continue;
    loaded.add(file);
    added.push(file);
    queue.push(...(imports.get(file) ?? []));
  }
  return added;
}

/** Cuts a sorted list into at most `count` runs of about equal size. */
function runs(files: readonly string[], bytes: (file: string) => number, count: number): string[][] {
  const share = files.reduce((sum, file) => sum + bytes(file), 0) / count;
  const cut: string[][] = [[]];
  let filled = 0;
  for (const file of files) {
    if (cut[cut.length - 1].length && cut.length < count && filled >= share * cut.length) cut.push([]);
    cut[cut.length - 1].push(file);
    filled += bytes(file);
  }
  return cut;
}

export function planPrograms({roots, imports, bytes, programs = SOURCE_PROGRAMS}: PlanInput): PlannedProgram[] {
  const sorted = [...roots].sort();
  const ambient = sorted.filter(isAmbient);
  const homeOf = (file: string) => programs.find(({dirs}) => dirs.some(dir => file.startsWith(dir)))?.name;
  const sizeOf = (files: readonly string[]) => files.reduce((sum, file) => sum + bytes(file), 0);
  const planned = programs.map(({name, testPrograms}) => {
    const sources = sorted.filter(file => !isAmbient(file) && homeOf(file) === name);
    const loaded = new Set<string>();
    load(imports, loaded, sources);
    return {name, testPrograms, sources, loaded, placed: [] as string[]};
  });
  // In path order, so the plan is the same on every machine: each remaining root joins the program
  // that has to load the least for it, counting what earlier roots already brought in.
  for (const file of sorted.filter(root => !isAmbient(root) && !homeOf(root))) {
    const needed = load(imports, new Set(), [file]);
    const extra = planned.map(program => sizeOf(needed.filter(dependency => !program.loaded.has(dependency))));
    const home = planned[extra.indexOf(Math.min(...extra))];
    load(imports, home.loaded, [file]);
    home.placed.push(file);
  }
  return planned.flatMap(({name, testPrograms, sources, placed}) => {
    if (!sources.length && !placed.length) return [];
    return runs(placed, bytes, testPrograms).map((run, index) => ({
      name: index ? `${name}-${index + 1}` : name,
      files: [...ambient, ...(index ? [] : sources), ...run].sort(),
    }));
  });
}
