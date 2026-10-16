// Where the time under one function goes, from a .cpuprofile (profile.ts writes them): the samples whose stack holds
// a frame matching `root`, split by the functions under it (inclusive, once per stack) and by self time.
//
//   tsx scripts/bench/profile-tree.ts <file.cpuprofile> <root regex> [--top 30]
//
// Several roots separated by `|` in the regex are one root: the outermost matching frame of a stack counts.
import {readProfile} from './lib/cpuprofile';

const [file, rootArg] = process.argv.slice(2);
if (!file || !rootArg) {
  console.error('usage: profile-tree.ts <file.cpuprofile> <root regex> [--top 30]');
  process.exit(2);
}
const topIndex = process.argv.indexOf('--top');
const top = topIndex >= 0 ? Number(process.argv[topIndex + 1]) : 30;
const root = new RegExp(`^(?:${rootArg})$`);
const profile = readProfile(file);
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const time = new Map<number, number>();
const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
for (let i = 0; i < samples.length; i++) time.set(samples[i], (time.get(samples[i]) ?? 0) + (deltas[i + 1] ?? deltas[i] ?? 0) / 1000);
const name = (id: number) => {
  const frame = byId.get(id)!.callFrame;
  return `${frame.functionName || '(anonymous)'} ${frame.url.replace(/^.*\/(src|shared|assets)\//, '$1/')}:${frame.lineNumber + 1}`;
};
let busy = 0, under = 0;
const inclusive = new Map<string, number>(), self = new Map<string, number>();
for (const [id, ms] of time) {
  const fn = byId.get(id)!.callFrame.functionName;
  if (fn !== '(idle)') busy += ms;
  const stack: number[] = [];
  for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) stack.push(at);
  // Outermost matching frame.
  let hit = -1;
  for (let k = stack.length - 1; k >= 0; k--) if (root.test(byId.get(stack[k])!.callFrame.functionName)) {
    hit = k;
    break;
  }
  if (hit < 0) continue;
  under += ms;
  self.set(name(id), (self.get(name(id)) ?? 0) + ms);
  const seen = new Set<string>();
  for (let k = hit; k >= 0; k--) {
    const n = name(stack[k]);
    if (seen.has(n)) continue;
    seen.add(n);
    inclusive.set(n, (inclusive.get(n) ?? 0) + ms);
  }
}
const fmt = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).slice(0, top)
  .map(([n, ms]) => `${((100 * ms) / Math.max(1e-9, under)).toFixed(1).padStart(5)} %  ${ms.toFixed(1).padStart(8)} ms  ${n}`).join('\n');
console.log(`${file}\nunder /${rootArg}/: ${under.toFixed(1)} ms of ${busy.toFixed(1)} ms busy (${((100 * under) / Math.max(1e-9, busy)).toFixed(1)} %)`);
console.log(`\n### inclusive (share of the root's time)\n${fmt(inclusive)}`);
console.log(`\n### self\n${fmt(self)}`);
