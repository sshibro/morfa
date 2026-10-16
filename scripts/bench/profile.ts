// The profiles behind "Further wins" (docs/TARGETS.md §10): where the time goes inside a measured window.
//
//   tsx scripts/bench/profile.ts server pair|cursors|crowd [--machine dev-4|laptop] [--quick]
//        the bench server's CPU (node:inspector) while a collab-load scenario runs
//   tsx scripts/bench/profile.ts canvas f20k|f100k|product [pan|move|resize|type] [--quick]
//        the editor's main thread (CDP Profiler) at 2× CPU throttle while it pans the file (canvas.ts's driver), moves one layer
//        40 times (E1), resizes the first top frame 40 times (E2) or types into a 2 000-character, 40-run text (E5)
//
// Prints the functions by self time and by total time, and writes the .cpuprofile (open it in Chrome DevTools). For readable
// names in the canvas profiles build the app unminified first and point the stand at it:
//   npx vite build --mode app --minify false --outDir dist/app-profile && BENCH_APP_DIR=dist/app-profile tsx scripts/bench/profile.ts canvas …
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {SCENARIOS, runScenario, type Scenario} from './collab-load';
import {formatHot, hotSpots, type CpuProfile} from './lib/cpuprofile';
import {benchFile, newTab, openFile, openStand, settle, takeBrowserLock} from './lib/browser';
import {bench} from './lib/fixtures';
import {startServer} from './lib/server';
import {ROOT, type Machine} from './lib/targets';
import type {BenchContext} from './lib/context';
import {fixtureDocument} from './lib/fixtures';
import {createNode, defaultTextProps} from '../../shared/design/defaults';
import type {NodeId, SceneNode} from '../../shared/design/types';

const [kind, what, actionArg] = process.argv.slice(2);
const action = actionArg && !actionArg.startsWith('--') ? actionArg : 'pan';
const quick = process.argv.includes('--quick');
const machineIndex = process.argv.indexOf('--machine');
const machine = (machineIndex >= 0 ? process.argv[machineIndex + 1] : kind === 'canvas' ? 'laptop' : 'dev-4') as Machine;
const outDir = path.join(ROOT, 'output/bench', `profile-${kind}-${what}${kind === 'canvas' ? '-' + action : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, {recursive: true});
const log = (line: string) => console.error(line);

function report(profile: CpuProfile, label: string) {
  const file = path.join(outDir, `${label}.cpuprofile`);
  writeFileSync(file, JSON.stringify(profile));
  const hot = hotSpots(profile, 30);
  console.log(`\n## ${label}: ${(hot.profileMs / 1000).toFixed(1)} s profiled, ${(hot.idleShare * 100).toFixed(0)} % idle; shares are of the busy time\n`);
  console.log('### self time\n```\n' + formatHot(hot.self, 'self') + '\n```');
  console.log('### total time\n```\n' + formatHot(hot.total, 'total') + '\n```');
  console.log(`\n(${path.relative(ROOT, file)})`);
  writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(hot, null, 1));
}

if (kind === 'server') {
  const spec = (SCENARIOS as Record<string, Scenario>)[what];
  if (!spec) throw Error(`scenario: ${Object.keys(SCENARIOS).join('|')}`);
  const ctx: BenchContext = {machine, rows: [], quick, target: machine === 'laptop' ? 'local' : 'dev-4', source: ROOT, outDir, log, shared: new Map(), netem: true};
  const server = await startServer({target: ctx.target, log});
  try {
    // The profile covers the run's measurement window: started when loadgen's window opens.
    const started = setTimeout(() => void bench(server, 'profile/start', {}), quick ? 6_000 : 12_000);
    await runScenario(ctx, server, spec);
    clearTimeout(started);
    const profile = await bench<CpuProfile>(server, 'profile/stop', {});
    report(profile, `server-${what}`);
  } finally {
    await server.stop();
  }
} else if (kind === 'canvas') {
  const release = await takeBrowserLock('B0 profile.ts', log);
  const stand = await openStand(log);
  try {
    const id = await benchFile(stand, what);
    const tab = await newTab(stand);
    await openFile(tab, stand, id, 'design', 600_000);
    await settle(tab, 60_000);
    // The engine's shadow document loads at idle after the editor is ready (lane N1: normalize answers from wasm only
    // once it is in): the profile starts after that, as a user's edits a few seconds into a file do.
    await tab.page.waitForFunction(() => !!(window as unknown as {__MORFA_ENGINE_REPORT__?: () => {shadow: unknown}}).__MORFA_ENGINE_REPORT__?.().shadow, undefined, {timeout: 60_000, polling: 100}).catch(() => {});
    await settle(tab, 15_000);
    type Store = {getState(): {doc: {nodes: Record<string, SceneNode>; pages: NodeId[]}; editing: unknown}; transact(label: string, recipe: (tx: {update(id: string, p: object): void; create(n: SceneNode, parent: string): void}) => void): void; setSelection(ids: string[]): void; setViewport(v: object): void};
    const doc = fixtureDocument(what);
    const firstLeaf = (() => {
      let id = doc.pages[0];
      while (doc.nodes[id].children?.length) id = doc.nodes[id].children![0];
      return id;
    })();
    const topFrame = doc.nodes[doc.pages[0]].children![0];
    if (action === 'type') {
      // (The Cyrillic text and the typed 'ы' are text-shaping test data and stay Russian.)
      const characters = Array.from({length: 40}, (_, k) => `Абзац ${k + 1}: `.padEnd(50, 'текст ')).join('').slice(0, 2000);
      const node = createNode('TEXT', {id: 'bench-long-text', name: 'Long text', x: 40, y: 40, width: 1200, height: 400, text: {...defaultTextProps(characters), runs: Array.from({length: 40}, (_, k) => ({start: k * 50, end: (k + 1) * 50, style: {fontWeight: k % 2 ? 700 : 400}})), textAutoResize: 'HEIGHT'}});
      await tab.page.evaluate(({node, parent}) => {
        const store = (window as unknown as {__morfaBench: {store: Store}}).__morfaBench.store;
        store.transact('Text', tx => tx.create(node, parent));
        store.setSelection([node.id]);
      }, {node, parent: topFrame});
      await settle(tab);
      await tab.page.keyboard.press('Enter');
      await tab.page.keyboard.press('End');
    }
    await tab.cdp.send('Profiler.enable');
    await tab.cdp.send('Profiler.setSamplingInterval', {interval: 200});
    await tab.cdp.send('Profiler.start');
    if (action === 'pan')
      await tab.page.evaluate(async ms => {
        const canvas = document.querySelector('canvas.dz-canvas__overlay') as HTMLCanvasElement;
        const box = canvas.getBoundingClientRect();
        await new Promise<void>(resolve => {
          let start = 0;
          const step = (t: number) => {
            if (!start) start = t;
            if (t - start >= ms) return resolve();
            canvas.dispatchEvent(new WheelEvent('wheel', {deltaX: Math.sin((t - start) / 600) * 14, deltaY: 4, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true}));
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
      }, quick ? 3_000 : 10_000);
    else if (action === 'move' || action === 'resize')
      await tab.page.evaluate(async ({id, field, from}) => {
        const store = (window as unknown as {__morfaBench: {store: Store}}).__morfaBench.store;
        for (let i = 1; i <= 40; i++) {
          store.transact('bench', tx => tx.update(id, {[field]: from + (i % 2 ? i : -i) * 0.5}));
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      }, action === 'move' ? {id: firstLeaf, field: 'x', from: doc.nodes[firstLeaf].x} : {id: topFrame, field: 'width', from: doc.nodes[topFrame].width});
    else if (action === 'type')
      for (let k = 0; k < 30; k++) {
        await tab.page.keyboard.type('ы');
        await tab.page.waitForTimeout(60);
      }
    else throw Error('action: pan|move|resize|type');
    const {profile} = (await tab.cdp.send('Profiler.stop')) as unknown as {profile: CpuProfile};
    report(profile, `canvas-${action}-${what}`);
    await tab.context.close();
  } finally {
    await stand.close();
    release();
  }
} else {
  console.error('usage: profile.ts server pair|cursors|crowd | canvas f20k|f100k|product [pan|move|resize|type]');
  process.exit(2);
}
