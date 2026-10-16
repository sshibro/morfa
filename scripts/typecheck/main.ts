// npm run check: type-checks every file of tsconfig.json, in several smaller programs instead of
// one that needs more than 3 GB of heap. How the files are divided is in plan.ts; the reasons, the
// numbers and what to do when a program grows are in docs/dev.md (§Type check).
//
//   tsx scripts/typecheck/main.ts          check every program, one after another
//   tsx scripts/typecheck/main.ts --plan   only write .typecheck/<program>.json and list the programs;
//                                          any of them runs by hand with `tsc -p .typecheck/<program>.json`
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {importGraph, rootProgram} from './graph';
import {planPrograms, type PlannedProgram} from './plan';
import {runProgram, type Limits, type ProgramResult} from './run';

// The gate shares the Mac with other sessions, and a deploy image may build on a small machine. Each program has to
// pass under heapMb with spareMb left over, so growth shows up here as a clear failure long before a build runs out of memory.
const LIMITS: Limits = {heapMb: 2560, spareMb: 300};
const CONFIG_DIR = '.typecheck';

const repo = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

// Two checks can run in one checkout at the same moment (an agent's and a build's), so a config is
// replaced in one step and never removed while another run may be reading it.
function writeConfigs(programs: readonly PlannedProgram[]): Map<string, string> {
  fs.mkdirSync(path.join(repo, CONFIG_DIR), {recursive: true});
  return new Map(
    programs.map(({name, files}) => {
      const config = path.join(CONFIG_DIR, `${name}.json`);
      const content = {extends: '../tsconfig.json', include: [], files: files.map(file => `../${file}`)};
      const draft = path.join(repo, `${config}.${process.pid}.tmp`);
      fs.writeFileSync(draft, `${JSON.stringify(content, null, 1)}\n`);
      fs.renameSync(draft, path.join(repo, config));
      return [name, config];
    }),
  );
}

function summary({name, passed, files, memoryMb, seconds}: ProgramResult): string {
  const memory = memoryMb === null ? 'memory unknown' : `${memoryMb} MB of ${LIMITS.heapMb - LIMITS.spareMb} MB`;
  return `type check ${name}: ${passed ? 'ok' : 'FAILED'}, ${files ?? '?'} files, ${memory}, ${seconds} s`;
}

async function main(): Promise<void> {
  const {roots, options} = rootProgram(repo);
  const programs = planPrograms({
    roots,
    imports: importGraph(repo, roots, options),
    bytes: file => fs.statSync(path.join(repo, file)).size,
  });
  const configs = writeConfigs(programs);
  if (process.argv.includes('--plan')) {
    for (const {name, files} of programs) console.log(`${configs.get(name)}: ${files.length} root files`);
    return;
  }
  // One at a time: together the programs would need the memory the split is there to save.
  for (const {name} of programs) {
    const result = await runProgram(repo, name, configs.get(name)!, LIMITS, process.stdout.isTTY === true);
    if (result.text) console.log(result.text);
    console.log(summary(result));
    if (!result.passed) process.exitCode = 1;
  }
}

await main();
