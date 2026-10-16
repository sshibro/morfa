// E-rows of docs/TARGETS.md §2 on the laptop stand-in (scripts/bench/lib/browser.ts): edits in the built editor (`?bench=1`),
// each commit timed in the page around the store's own call (transaction + normalize + patch, and everything the store runs
// synchronously for it: autosave's patch, the panels' listeners), the frame it lands in counted from the editor's scene renders,
// keystrokes and shortcuts also through the Event Timing API (input → next paint).
//
//   tsx scripts/bench/edit-ops.ts --machine laptop [--only E1,E2] [--quick]
//
// The engine mode (`?engine=ts|wasm|both`) is passed through from BENCH_ENGINE once the engine switch lands; main runs the TS engine.
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fillNa, runStandalone, wants, type Bench, type BenchContext} from './lib/context';
import {benchFile, newTab, openFile, openStand, settle, takeBrowserLock, CPU_THROTTLE, type Stand, type Tab} from './lib/browser';
import {fixtureDocument} from './lib/fixtures';
import {summary} from './lib/stats';
import type {RowResult} from './lib/targets';
import {createNode, defaultTextProps} from '../../shared/design/defaults';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';

type Timing = {kind: string; label: string; ms: number};
type StoreLike = {
  getState(): {doc: DesignDocument; pageId: NodeId; selection: NodeId[]; viewports: Record<string, {x: number; y: number; zoom: number}>; editing: unknown};
  transact(label: string, recipe: (tx: {update(id: NodeId, partial: Partial<SceneNode>): void; create(node: SceneNode, parent: NodeId, index?: number): void}) => void, options?: unknown): unknown;
  undo(): boolean;
  redo(): boolean;
  setSelection(ids: NodeId[]): void;
  setViewport(v: {x: number; y: number; zoom: number}): void;
};
type PageWindow = {__morfaBench: {store: StoreLike; renders: number}; __timings: Timing[]; __events: {name: string; duration: number}[]};

/** Times the store's calls from now on (window.__timings) and collects Event Timing entries of keys (window.__events). */
async function instrument(tab: Tab) {
  await tab.page.evaluate(() => {
    const host = window as unknown as PageWindow;
    const store = host.__morfaBench.store as unknown as Record<string, (...args: unknown[]) => unknown>;
    host.__timings = [];
    host.__events = [];
    for (const kind of ['transact', 'undo', 'redo', 'setSelection']) {
      const original = store[kind];
      if ((original as {benched?: boolean}).benched) continue;
      const timed = (...args: unknown[]) => {
        const started = performance.now();
        const result = original(...args);
        host.__timings.push({kind, label: kind === 'transact' ? String(args[0]) : kind, ms: performance.now() - started});
        return result;
      };
      (timed as {benched?: boolean}).benched = true;
      store[kind] = timed;
    }
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) host.__events.push({name: entry.name, duration: entry.duration});
    }).observe({type: 'event', durationThreshold: 16, buffered: false} as PerformanceObserverInit);
  });
}
const takeTimings = (tab: Tab) => tab.page.evaluate(() => (window as unknown as PageWindow).__timings.splice(0));
const takeEvents = (tab: Tab) => tab.page.evaluate(() => (window as unknown as PageWindow).__events.splice(0));
const selectIds = (tab: Tab, ids: NodeId[]) => tab.page.evaluate(list => (window as unknown as PageWindow).__morfaBench.store.setSelection(list), ids);

/** `count` commits of `update(id) → partial(i)` in the page, each followed by the frame it lands in. */
async function commits(tab: Tab, id: NodeId, count: number, field: 'x' | 'width', from: number, label: string): Promise<{commit: number[]; frames: number[]}> {
  return tab.page.evaluate(async ({id, count, field, from, label}) => {
    const host = window as unknown as PageWindow;
    const store = host.__morfaBench.store;
    const commit: number[] = [], frames: number[] = [];
    for (let i = 1; i <= count; i++) {
      const renders = host.__morfaBench.renders;
      const started = performance.now();
      store.transact(label, tx => tx.update(id, {[field]: from + (i % 2 ? i : -i) * 0.5} as never));
      commit.push(performance.now() - started);
      let n = 0;
      while (host.__morfaBench.renders === renders && n < 60) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        n++;
      }
      frames.push(n);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return {commit, frames};
  }, {id, count, field, from, label});
}

function leaves(doc: DesignDocument, count: number): NodeId[] {
  const out: NodeId[] = [];
  const walk = (id: NodeId) => {
    if (out.length >= count) return;
    const node = doc.nodes[id];
    if (!node.children?.length) {
      if (node.type !== 'PAGE') out.push(id);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(doc.pages[0]);
  return out;
}

const engine = process.env.BENCH_ENGINE;

async function open(stand: Stand, fixture: string): Promise<Tab> {
  const id = await benchFile(stand, fixture);
  const tab = await newTab(stand);
  await openFile(tab, stand, id, 'design', 600_000);
  await settle(tab, 60_000);
  await instrument(tab);
  return tab;
}

const run: Bench = async (ctx: BenchContext) => {
  if (ctx.machine !== 'laptop') return fillNa(ctx, [], 'edit rows run on the laptop (stand-in: this Mac, Chromium at 2× CPU throttle): --machine laptop');
  const results: RowResult[] = [];
  const n = ctx.quick ? 10 : 40;
  const note = (text: string) => `stand-in: Playwright Chromium on this Mac, CPU ${CPU_THROTTLE}× throttled${engine ? `, ?engine=${engine}` : ''}, TS engine; ${text}`;
  const release = await takeBrowserLock('B0 edit-ops.ts', ctx.log);
  let stand: Stand | null = null;
  try {
    stand = await openStand(ctx.log);
    const s = stand;
    if (wants(ctx, 'E1', 'E5', 'E7', 'E8')) {
      const f100k = fixtureDocument('f100k');
      const tab = await open(s, 'f100k');
      try {
        if (wants(ctx, 'E1')) {
          const [layer] = leaves(f100k, 1);
          const moved = await commits(tab, layer, n, 'x', f100k.nodes[layer].x, 'Move');
          const c = summary(moved.commit), f = summary(moved.frames);
          results.push({id: 'E1', values: {commitP95: c.p95, frames: f.p95}, notes: [note(`E1: one leaf layer of f100k moved ${n} times, commit p50 ${c.p50.toFixed(2)} ms, max ${c.max.toFixed(1)} ms`)]});
        }
        if (wants(ctx, 'E5')) {
          // (The Cyrillic text and the typed 'ы' are text-shaping test data and stay Russian.)
          // A 2 000-character text with 40 runs in the first screen, then typing into it with the text editor.
          const characters = Array.from({length: 40}, (_, k) => `Абзац ${k + 1}: `.padEnd(50, 'текст ')).join('').slice(0, 2000);
          const base = defaultTextProps(characters);
          const runs = Array.from({length: 40}, (_, k) => ({start: k * 50, end: (k + 1) * 50, style: {fontWeight: k % 2 ? 700 : 400}}));
          const node = createNode('TEXT', {id: 'bench-long-text', name: 'Long text', x: 40, y: 40, width: 1200, height: 400, text: {...base, runs, textAutoResize: 'HEIGHT'}});
          const screen = f100k.nodes[f100k.pages[0]].children![0];
          await tab.page.evaluate(({node, screen}) => {
            const store = (window as unknown as PageWindow).__morfaBench.store;
            store.transact('Text', tx => tx.create(node as SceneNode, screen));
            store.setSelection([node.id]);
          }, {node, screen});
          await settle(tab);
          await tab.page.keyboard.press('Enter');
          await tab.page.waitForFunction(() => !!(window as unknown as PageWindow).__morfaBench.store.getState().editing, undefined, {timeout: 10_000});
          await tab.page.keyboard.press('End');
          await takeTimings(tab);
          await takeEvents(tab);
          for (let k = 0; k < n; k++) {
            await tab.page.keyboard.type('ы');
            await tab.page.waitForTimeout(60);
          }
          await settle(tab);
          const timings = (await takeTimings(tab)).filter(t => t.kind === 'transact');
          const events = (await takeEvents(tab)).filter(e => e.name === 'keydown' || e.name === 'keypress' || e.name === 'input' || e.name === 'beforeinput');
          const length = await tab.page.evaluate(() => (window as unknown as PageWindow).__morfaBench.store.getState().doc.nodes['bench-long-text']?.text?.characters.length ?? 0);
          await tab.page.keyboard.press('Escape');
          const c = summary(timings.map(t => t.ms));
          const slowest = events.length ? summary(events.map(e => e.duration)).p95 : 0;
          // Event Timing reports only events over 16 ms: none means each keystroke reached the screen within its frame.
          const frames = Math.max(1, Math.ceil(slowest / (1000 / 60)));
          results.push(timings.length >= n / 2
            ? {id: 'E5', values: {commitP95: c.p95, frames}, notes: [note(`E5: ${timings.length} keystrokes into a 2 000-character, 40-run text in f100k (now ${length} characters), commit p50 ${c.p50.toFixed(2)} ms; ${events.length} input events over 16 ms (p95 ${slowest.toFixed(0)} ms)`)]}
            : {id: 'E5', na: `typing did not reach the text editor (${timings.length} commits for ${n} keys, ${length} characters)`});
        }
        if (wants(ctx, 'E7')) {
          await selectIds(tab, []);
          await settle(tab);
          await takeTimings(tab);
          await takeEvents(tab);
          await tab.page.keyboard.press('Meta+KeyA');
          await settle(tab, 30_000);
          const timings = (await takeTimings(tab)).filter(t => t.kind === 'setSelection');
          const events = (await takeEvents(tab)).filter(e => e.name === 'keydown');
          const selected = await tab.page.evaluate(() => (window as unknown as PageWindow).__morfaBench.store.getState().selection.length);
          const select = events.length ? Math.max(...events.map(e => e.duration)) : Math.max(0, ...timings.map(t => t.ms));
          // The pan with everything selected (canvas.ts's driver, inline: one wheel event a frame).
          const times = await tab.page.evaluate(async ms => {
            const canvas = document.querySelector('canvas.dz-canvas__overlay') as HTMLCanvasElement;
            const box = canvas.getBoundingClientRect();
            const out: number[] = [];
            return new Promise<number[]>(resolve => {
              let start = 0;
              const step = (t: number) => {
                if (!start) start = t;
                out.push(t);
                if (t - start >= ms) return resolve(out);
                canvas.dispatchEvent(new WheelEvent('wheel', {deltaX: Math.sin((t - start) / 600) * 14, deltaY: 4, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true}));
                requestAnimationFrame(step);
              };
              requestAnimationFrame(step);
            });
          }, ctx.quick ? 3_000 : 10_000);
          const deltas = summary(times.slice(1).map((t, i) => t - times[i]));
          results.push({id: 'E7', values: {select, frameP95: deltas.p95}, notes: [note(`E7: ⌘A on f100k selects ${selected} layers (the page's top level, as Figma); select = keydown → next paint (Event Timing), the store's setSelection ${Math.max(0, ...timings.map(t => t.ms)).toFixed(1)} ms; pan p99 ${deltas.p99.toFixed(1)} ms`)]});
          await selectIds(tab, []);
        }
        if (wants(ctx, 'E8')) {
          const ids = leaves(f100k, 5000);
          const pasted = await tab.page.evaluate(async ids => {
            const store = (window as unknown as PageWindow).__morfaBench.store;
            store.setSelection(ids);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const data = new DataTransfer();
            document.dispatchEvent(new ClipboardEvent('copy', {clipboardData: data, bubbles: true, cancelable: true}));
            const bytes = data.getData('text/plain').length;
            store.setSelection([]);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const before = Object.keys(store.getState().doc.nodes).length;
            const started = performance.now();
            document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
            const ms = performance.now() - started;
            return {ms, bytes, added: Object.keys(store.getState().doc.nodes).length - before};
          }, ids);
          const commit = (await takeTimings(tab)).filter(t => t.kind === 'transact').at(-1);
          results.push(pasted.added >= 5000
            ? {id: 'E8', values: {commit: pasted.ms}, notes: [note(`E8: 5 000 leaf layers of f100k copied (${(pasted.bytes / 2 ** 20).toFixed(1)} MB on the clipboard) and pasted: ${pasted.added} layers added; the paste's own transaction ${commit?.ms.toFixed(0) ?? '–'} ms of the ${pasted.ms.toFixed(0)} ms`)]}
            : {id: 'E8', na: `the paste added ${pasted.added} layers (copied ${pasted.bytes} characters)`});
        }
      } finally {
        await tab.context.close();
      }
    }
    if (wants(ctx, 'E2', 'E6')) {
      const product = fixtureDocument('product');
      const tab = await open(s, 'product');
      try {
        const screen = product.nodes[product.pages[0]].children![0];
        let descendants = 0;
        const walk = (id: NodeId) => {
          for (const child of product.nodes[id].children ?? []) {
            descendants++;
            walk(child);
          }
        };
        walk(screen);
        const resized = await commits(tab, screen, n, 'width', product.nodes[screen].width, 'Resize');
        const c = summary(resized.commit);
        if (wants(ctx, 'E2')) results.push({id: 'E2', values: {commitP95: c.p95}, notes: [note(`E2: the first screen of product (${descendants} descendants in nested auto layout) resized ${n} times, commit p50 ${c.p50.toFixed(1)} ms, frame p95 ${summary(resized.frames).p95}`)]});
        if (wants(ctx, 'E6')) {
          await takeTimings(tab);
          const steps = await tab.page.evaluate(async count => {
            const store = (window as unknown as PageWindow).__morfaBench.store;
            const out: number[] = [];
            for (let i = 0; i < count; i++) {
              const a = performance.now();
              store.undo();
              out.push(performance.now() - a);
              await new Promise(resolve => requestAnimationFrame(resolve));
              const b = performance.now();
              store.redo();
              out.push(performance.now() - b);
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
            return out;
          }, Math.min(n, 20));
          const u = summary(steps);
          results.push({id: 'E6', values: {commitP95: u.p95}, notes: [note(`E6: undo and redo of E2's resize, ${steps.length} steps, p50 ${u.p50.toFixed(1)} ms`)]});
        }
      } finally {
        await tab.context.close();
      }
    }
    if (wants(ctx, 'E3')) {
      const tab = await open(s, 'instances1k');
      try {
        const colors = await tab.page.evaluate(async count => {
          const store = (window as unknown as PageWindow).__morfaBench.store;
          const out: number[] = [];
          for (let i = 0; i < count; i++) {
            const started = performance.now();
            store.transact('Fill', tx => tx.update('card-img', {fills: [{type: 'SOLID', color: {r: (i % 10) / 10, g: 0.5, b: 0.7}, opacity: 1, visible: true, blendMode: 'NORMAL'}]} as never));
            out.push(performance.now() - started);
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          const doc = store.getState().doc;
          const synced = Object.values(doc.nodes).filter(node => node.type === 'INSTANCE').length;
          return {out, synced};
        }, n);
        const c = summary(colors.out);
        results.push({id: 'E3', values: {commitP95: c.p95}, notes: [note(`E3: the fill of a layer of a component with ${colors.synced} instances changed ${n} times (instance sync in normalize), p50 ${c.p50.toFixed(1)} ms`)]});
      } finally {
        await tab.context.close();
      }
    }
    if (wants(ctx, 'E4')) {
      const shapes = fixtureDocument('bool200');
      const tab = await open(s, 'bool200');
      try {
        const operands = shapes.nodes.board.children ?? [];
        const walls: number[] = [];
        const commitsMs: number[] = [];
        for (let k = 0; k < (ctx.quick ? 2 : 5); k++) {
          await selectIds(tab, operands);
          await settle(tab);
          await takeTimings(tab);
          await takeEvents(tab);
          await tab.page.keyboard.press('Alt+Shift+KeyU');
          await settle(tab, 30_000);
          const events = (await takeEvents(tab)).filter(e => e.name === 'keydown');
          const timing = (await takeTimings(tab)).filter(t => t.kind === 'transact').at(-1);
          const made = await tab.page.evaluate(() => {
            const s = (window as unknown as PageWindow).__morfaBench.store.getState();
            return s.selection.length === 1 && s.doc.nodes[s.selection[0]]?.type === 'BOOLEAN_OPERATION';
          });
          if (!made) throw Error('the union did not make a boolean');
          walls.push(events.length ? Math.max(...events.map(e => e.duration)) : timing?.ms ?? NaN);
          if (timing) commitsMs.push(timing.ms);
          await tab.page.evaluate(() => (window as unknown as PageWindow).__morfaBench.store.undo());
        }
        const w = summary(walls);
        results.push({id: 'E4', values: {wall: w.p50}, notes: [note(`E4: ⌥⇧U over 200 seeded overlapping shapes (rectangles, ellipses, stars, polygons; L1's fuzz set replaces them), wall = keydown → the frame that shows the union (Event Timing), median of ${walls.length}; the transaction alone ${summary(commitsMs).p50.toFixed(0)} ms; today's budget BOOLEAN_TIME_BUDGET_MS 1 500`)]});
      } finally {
        await tab.context.close();
      }
    }
  } finally {
    await stand?.close();
    release();
  }
  writeFileSync(path.join(ctx.outDir, 'edit-ops.json'), JSON.stringify(results, null, 1));
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('edit-ops', run, import.meta.url);
