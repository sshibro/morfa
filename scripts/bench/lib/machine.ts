// Where a bench runs and how busy the machine was (the Mac is shared: TARGETS numbers taken above load 4 are provisional).
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {ROOT} from './targets';

// bench-ru runs nothing else: scripts/deploy/bench-run.sh raises it to its core count (BENCH_PROVISIONAL_LOAD).
export const PROVISIONAL_LOAD = Number(process.env.BENCH_PROVISIONAL_LOAD) || 4;

export function gitHash(): string {
  try {
    const hash = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: ROOT, encoding: 'utf8'}).trim();
    return dirty ? `${hash}+dirty` : hash;
  } catch {
    return 'unknown';
  }
}

export function uptimeLine(): string {
  try {
    return execFileSync('uptime', {encoding: 'utf8'}).trim();
  } catch {
    return `load averages: ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`;
  }
}

/** Samples the 1-minute load average every few seconds while a bench runs; the max decides "provisional". */
export class LoadWatch {
  private samples: number[] = [];
  private timer: ReturnType<typeof setInterval>;
  readonly startLine = uptimeLine();
  endLine = '';
  constructor(everyMs = 5_000) {
    this.samples.push(os.loadavg()[0]);
    this.timer = setInterval(() => this.samples.push(os.loadavg()[0]), everyMs);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.samples.push(os.loadavg()[0]);
    this.endLine = uptimeLine();
    return this.result();
  }
  result() {
    const max = Math.max(...this.samples);
    return {max, mean: this.samples.reduce((a, b) => a + b, 0) / this.samples.length, start: this.startLine, end: this.endLine, provisional: max > PROVISIONAL_LOAD};
  }
}

export function machineInfo() {
  return {host: os.hostname(), cpus: os.cpus().length, model: os.cpus()[0]?.model ?? '?', memoryGb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version};
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
