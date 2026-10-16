// Runs the compiler over one planned program in its own process, under the heap cap, and reads
// back how much memory the check needed.
import {spawn} from 'node:child_process';
import path from 'node:path';

export type Limits = {heapMb: number; spareMb: number};
export type ProgramResult = {
  name: string;
  passed: boolean;
  files: number | null;
  memoryMb: number | null;
  seconds: number;
  text: string;
};

const KB_PER_MB = 1024;
const OUT_OF_MEMORY = /heap out of memory|Reached heap limit/;
// A row of the compiler's --diagnostics table: "Memory used:    2017675K", "Total time:   27.10s".
const DIAGNOSTICS_ROW = /^[A-Z][A-Za-z/ ]*:\s+[\d.]+[Ks]?$/;

/** Takes the --diagnostics table out of the compiler output and returns what it says. */
export function readDiagnostics(output: string): {files: number | null; memoryMb: number | null; text: string} {
  const lines = output.split('\n');
  const number = (label: string) => {
    const row = lines.find(line => DIAGNOSTICS_ROW.test(line) && line.startsWith(`${label}:`));
    return row ? Number.parseInt(row.slice(label.length + 1), 10) : null;
  };
  const memoryKb = number('Memory used');
  const kept = lines.filter(line => !DIAGNOSTICS_ROW.test(line)).join('\n');
  return {
    files: number('Files'),
    memoryMb: memoryKb === null ? null : Math.round(memoryKb / KB_PER_MB),
    text: kept.replace(/\n{2,}$/, '\n'),
  };
}

/** Why a program that passed still fails the check: it left less spare memory than required. */
export function memoryVerdict(name: string, memoryMb: number, {heapMb, spareMb}: Limits): string | null {
  const allowed = heapMb - spareMb;
  if (memoryMb <= allowed) return null;
  return [
    `The ${name} program needed ${memoryMb} MB; the limit is ${allowed} MB (a ${heapMb} MB heap less ${spareMb} MB to spare).`,
    'Make the programs smaller instead of raising the heap: see "When a program outgrows its limit" in docs/dev.md (§Type check).',
  ].join('\n');
}

export function runProgram(
  repo: string,
  name: string,
  config: string,
  limits: Limits,
  pretty: boolean,
): Promise<ProgramResult> {
  const started = Date.now();
  const compiler = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  // --expose-gc lets the compiler collect garbage before it reports "Memory used", so the number is
  // what the check has to keep, not what happened to be uncollected.
  const args = [
    `--max-old-space-size=${limits.heapMb}`,
    '--expose-gc',
    compiler,
    '-p',
    config,
    '--noEmit',
    '--diagnostics',
    '--pretty',
    String(pretty),
  ];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {cwd: repo, stdio: ['ignore', 'pipe', 'pipe']});
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.on('close', code => {
      const output = Buffer.concat(chunks).toString('utf8');
      const seconds = Math.round((Date.now() - started) / 1000);
      const {files, memoryMb, text} = readDiagnostics(output);
      if (OUT_OF_MEMORY.test(output)) {
        const advice = `The ${name} program ran out of its ${limits.heapMb} MB heap. Make the programs smaller instead of raising the heap: see "When a program outgrows its limit" in docs/dev.md (§Type check).`;
        resolve({name, passed: false, files, memoryMb, seconds, text: advice});
        return;
      }
      const verdict = code === 0 && memoryMb !== null ? memoryVerdict(name, memoryMb, limits) : null;
      const unread = code === 0 && memoryMb === null ? `The ${name} program did not report its memory.\n` : '';
      resolve({
        name,
        passed: code === 0 && !verdict && !unread,
        files,
        memoryMb,
        seconds,
        text: [text.trim(), verdict, unread.trim()].filter(Boolean).join('\n'),
      });
    });
  });
}
