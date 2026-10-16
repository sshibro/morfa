// Reads a V8 .cpuprofile (node --cpu-prof, or CDP Profiler.stop) into the functions that took the time: self time (the
// function's own samples) and total time (its samples and its callees'), as shares of the profile.
import {readFileSync} from 'node:fs';

type ProfileNode = {id: number; callFrame: {functionName: string; url: string; lineNumber: number; columnNumber: number}; hitCount?: number; children?: number[]};
export type CpuProfile = {nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[]};
export type Hot = {name: string; where: string; selfMs: number; selfShare: number; totalMs: number; totalShare: number};

const shortUrl = (url: string) => url.replace(/^file:\/\//, '').replace(/^.*\/(node_modules\/)/, '$1').replace(/^.*\/(server|shared|src|scripts)\//, '$1/');

export function hotSpots(profile: CpuProfile, top = 25): {self: Hot[]; total: Hot[]; profileMs: number; idleShare: number} {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  // Sample time per node: the time deltas when present, hit counts otherwise.
  const time = new Map<number, number>();
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
      time.set(profile.samples[i], (time.get(profile.samples[i]) ?? 0) + dt);
    }
  } else {
    const interval = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0));
    for (const node of profile.nodes) time.set(node.id, (node.hitCount ?? 0) * interval);
  }
  const profileMs = [...time.values()].reduce((a, b) => a + b, 0);
  const key = (node: ProfileNode) => `${node.callFrame.functionName || '(anonymous)'}\u0000${shortUrl(node.callFrame.url)}:${node.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>(), total = new Map<string, number>();
  let idle = 0;
  for (const [id, ms] of time) {
    const node = byId.get(id)!;
    if (['(idle)', '(program)', '(garbage collector)'].includes(node.callFrame.functionName)) {
      if (node.callFrame.functionName === '(idle)') idle += ms;
    }
    self.set(key(node), (self.get(key(node)) ?? 0) + ms);
    // Inclusive time: once per distinct function on the stack.
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const k = key(byId.get(at)!);
      if (seen.has(k)) continue;
      seen.add(k);
      total.set(k, (total.get(k) ?? 0) + ms);
    }
  }
  const busy = Math.max(1e-9, profileMs - idle);
  const list = (map: Map<string, number>, other: Map<string, number>, selfFirst: boolean) =>
    [...map].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(root)')).sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, ms]) => {
      const [name, where] = k.split('\u0000');
      const o = other.get(k) ?? 0;
      return selfFirst
        ? {name, where, selfMs: ms, selfShare: ms / busy, totalMs: o, totalShare: o / busy}
        : {name, where, selfMs: o, selfShare: o / busy, totalMs: ms, totalShare: ms / busy};
    });
  return {self: list(self, total, true), total: list(total, self, false), profileMs, idleShare: idle / Math.max(1e-9, profileMs)};
}

export const readProfile = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as CpuProfile;

export function formatHot(rows: Hot[], by: 'self' | 'total'): string {
  return rows.map(row => `${(100 * (by === 'self' ? row.selfShare : row.totalShare)).toFixed(1).padStart(5)} %  ${(by === 'self' ? row.selfMs : row.totalMs).toFixed(0).padStart(6)} ms  ${row.name}  ${row.where}`).join('\n');
}
