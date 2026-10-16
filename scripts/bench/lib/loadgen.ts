// Runs crates/loadgen (built when missing) and reads its report; `/usr/bin/time` gives its CPU and memory from outside.
import {execFile, spawn} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import os, {homedir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {ROOT} from './targets';
import type {HistogramJson} from './histogram';

const exec = promisify(execFile);
export const TARGET_DIR = process.env.CARGO_TARGET_DIR || path.join(homedir(), '.cache/morfa-target/B0');
export const LOADGEN = process.env.BENCH_LOADGEN || path.join(TARGET_DIR, 'release/loadgen');

export type LoadgenEditor = {cookie?: string; role?: 'editor' | 'viewer'; nodes?: unknown[]; readBytesPerSecond?: number; ticket?: string; clientId?: string; quiet?: boolean};
export type LoadgenConfig = {
  mode: 'legacy' | 'ws';
  base: string;
  origin?: string;
  durationMs: number;
  warmupMs?: number;
  rampMs?: number;
  opIntervalMs?: number;
  cursorHz?: number;
  wsPath?: string;
  recordAcked?: boolean;
  presenceProbe?: boolean;
  threads?: number;
  files: {id: string; version: number; editors: LoadgenEditor[]}[];
};
export type LoadgenReport = {
  mode: string;
  editors: number;
  viewers: number;
  files: number;
  durationMs: number;
  wallMs: number;
  ack: HistogramJson & {p50: number; p95: number; p99: number};
  arrival: HistogramJson & {p50: number; p95: number; p99: number};
  presenceRtt: HistogramJson & {p50: number; p95: number; p99: number};
  presenceDelivery: HistogramJson & {p50: number; p95: number; p99: number};
  statuses: Record<string, number>;
  presenceStatuses: Record<string, number>;
  byes: Record<string, number>;
  opsSent: number;
  opsAcked: number;
  opsCoalesced: number;
  presenceSent: number;
  presenceCoalesced: number;
  bytesIn: number;
  bytesOut: number;
  changesReceived: number;
  presenceFrames: number;
  presenceEntries: number;
  receiverHzMedian: number | null;
  receiverHzMax: number | null;
  streamEnds: number;
  reconnects: number;
  resyncs: number;
  errors: number;
  peakStreams: number;
  acksPerSecond: number[];
  errorsPerSecond: number[];
  selfCpuMs: number | null;
  selfCores: number | null;
  acked: {file: string; editor: number; ops: [number, number, number][]}[];
  /** From /usr/bin/time around the process. */
  time?: {realS: number; userS: number; sysS: number; maxRssMb: number; cores: number};
};

export async function ensureLoadgen(log?: (line: string) => void): Promise<string> {
  if (existsSync(LOADGEN) && !process.env.BENCH_LOADGEN_REBUILD) return LOADGEN;
  log?.('building crates/loadgen (cargo build --release -p morfa-loadgen)');
  const env = {...process.env, CARGO_TARGET_DIR: TARGET_DIR, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4', PATH: `${homedir()}/.cargo/bin:${process.env.PATH}`};
  await exec('cargo', ['build', '--release', '-p', 'morfa-loadgen'], {cwd: ROOT, env, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000});
  return LOADGEN;
}

function parseTime(stderr: string): LoadgenReport['time'] | undefined {
  const times = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(stderr);
  const rss = /(\d+)\s+maximum resident set size/.exec(stderr);
  if (times) {
    const [realS, userS, sysS] = times.slice(1).map(Number);
    return {realS, userS, sysS, maxRssMb: rss ? Number(rss[1]) / 2 ** 20 : NaN, cores: (userS + sysS) / realS};
  }
  // GNU time -v
  const user = /User time \(seconds\): ([\d.]+)/.exec(stderr), sys = /System time \(seconds\): ([\d.]+)/.exec(stderr);
  const wall = /Elapsed \(wall clock\) time.*: (?:(\d+):)?(\d+):([\d.]+)/.exec(stderr), max = /Maximum resident set size \(kbytes\): (\d+)/.exec(stderr);
  if (user && sys && wall) {
    const realS = Number(wall[1] ?? 0) * 3600 + Number(wall[2]) * 60 + Number(wall[3]);
    return {realS, userS: Number(user[1]), sysS: Number(sys[1]), maxRssMb: max ? Number(max[1]) / 1024 : NaN, cores: (Number(user[1]) + Number(sys[1])) / realS};
  }
  return undefined;
}

// ── loadgen on the ru-net VM (lane B5) ────────────────────────────────────────────────────────────
// On bench-ru (scripts/deploy/bench-run.sh) loadgen runs on the ru-net VM over SSH: BENCH_LOADGEN_SSH=bench@<ru-net>, its binary
// at BENCH_LOADGEN_REMOTE (copied there before the run), and every 127.0.0.1 address of the config becomes BENCH_PUBLIC_HOST
// (bench-ru as ru-net reaches it). Every run's loadgen CPU is kept: a row whose loadgen used more than 70 % of its host's cores
// is marked loadgen-bound (scripts/bench/targets.ts).
export const REMOTE = process.env.BENCH_LOADGEN_SSH || '';
const REMOTE_BIN = process.env.BENCH_LOADGEN_REMOTE || 'bin/loadgen';
const PUBLIC_HOST = process.env.BENCH_PUBLIC_HOST || '';
/** Cores of the machine loadgen runs on (ru-net: 2). */
export const LOADGEN_HOST_CORES = Number(process.env.BENCH_LOADGEN_CORES) || (REMOTE ? 2 : os.cpus().length);
export const LOADGEN_BOUND_SHARE = 0.7;
export type LoadgenRun = {name: string; cores: number; share: number; host: string};
/** Every loadgen run of this process, in order (targets.ts reads the ones of each bench). */
export const loadgenRuns: LoadgenRun[] = [];

/** The config as ru-net sees bench-ru: loopback addresses of the server and the collab nodes become bench-ru's public one. */
export function remoteConfig<T>(config: T, host = PUBLIC_HOST): T {
  if (!host) return config;
  const rewrite = (value: unknown, key?: string): unknown => {
    // The Origin header stays what the server allows (its APP_ORIGIN).
    if (typeof value === 'string') return key === 'origin' ? value : value.replace(/^(wss?|https?):\/\/(?:127\.0\.0\.1|localhost)(?=[:/]|$)/, `$1://${host}`);
    if (Array.isArray(value)) return value.map(item => rewrite(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]));
    return value;
  };
  return rewrite(config) as T;
}

const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15'];

export async function runLoadgen(config: LoadgenConfig, file: string, log?: (line: string) => void): Promise<LoadgenReport> {
  if (REMOTE) return runRemoteLoadgen(config, file, log);
  const binary = await ensureLoadgen(log);
  writeFileSync(file, JSON.stringify(config));
  const out = file.replace(/\.json$/, '') + '.report.json';
  const timeFlag = process.platform === 'darwin' ? '-l' : '-v';
  const command = `ulimit -n 65536 2>/dev/null || ulimit -n 10240; exec /usr/bin/time ${timeFlag} '${binary}' --config '${file}' --out '${out}'`;
  return finishRun(file, out, await capture('sh', ['-c', command], log), log);
}

async function runRemoteLoadgen(config: LoadgenConfig, file: string, log?: (line: string) => void): Promise<LoadgenReport> {
  writeFileSync(file, JSON.stringify(remoteConfig(config)));
  const out = file.replace(/\.json$/, '') + '.report.json';
  const name = path.basename(file).replace(/[^A-Za-z0-9_.-]/g, '_');
  const remoteDir = `runs/${process.pid}`;
  await exec('ssh', [...sshArgs, REMOTE, `mkdir -p ${remoteDir}`], {timeout: 60_000});
  await exec('scp', ['-q', ...sshArgs, file, `${REMOTE}:${remoteDir}/${name}`], {timeout: 120_000});
  const remoteOut = `${remoteDir}/${name.replace(/\.json$/, '')}.report.json`;
  const command = `ulimit -n 65536 2>/dev/null || ulimit -n 10240; exec /usr/bin/time -v ${REMOTE_BIN} --config ${remoteDir}/${name} --out ${remoteOut}`;
  const stderr = await capture('ssh', [...sshArgs, REMOTE, command], log);
  await exec('scp', ['-q', ...sshArgs, `${REMOTE}:${remoteOut}`, out], {timeout: 120_000});
  return finishRun(file, out, stderr, log);
}

function capture(command: string, args: string[], log?: (line: string) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', chunk => (err += chunk.toString()));
    child.stdout.on('data', chunk => log?.(`[loadgen] ${chunk.toString().trim()}`));
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve(err) : reject(Error(`loadgen exited ${code}: ${err.slice(-2000)}`))));
  });
}

function finishRun(file: string, out: string, stderr: string, log?: (line: string) => void): LoadgenReport {
  const report = JSON.parse(readFileSync(out, 'utf8')) as LoadgenReport;
  // serde_json writes NaN (an empty histogram) as null.
  const num = (value: unknown) => (typeof value === 'number' ? value : NaN);
  for (const key of ['ack', 'arrival', 'presenceRtt', 'presenceDelivery'] as const)
    for (const p of ['p50', 'p95', 'p99', 'max', 'min'] as const) report[key][p] = num(report[key][p]);
  report.receiverHzMedian = num(report.receiverHzMedian);
  report.receiverHzMax = num(report.receiverHzMax);
  report.time = parseTime(stderr);
  writeFileSync(out, JSON.stringify(report));
  const cores = report.time?.cores ?? report.selfCores ?? NaN;
  if (Number.isFinite(cores)) {
    const run = {name: path.basename(file), cores, share: cores / LOADGEN_HOST_CORES, host: REMOTE || 'local'};
    loadgenRuns.push(run);
    log?.(`  loadgen ${run.name}: ${cores.toFixed(2)} of ${LOADGEN_HOST_CORES} cores on ${run.host}${run.share > LOADGEN_BOUND_SHARE ? ' — LOADGEN-BOUND' : ''}`);
  }
  return report;
}
