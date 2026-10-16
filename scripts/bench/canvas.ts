// C-rows of docs/TARGETS.md §1 on the laptop stand-in (scripts/bench/lib/browser.ts): the built editor with `?bench=1`, frames
// from requestAnimationFrame timestamps while synthetic wheel events pan or zoom (one per frame, as a trackpad sends them),
// input-to-pixel from real pointer input (CDP) to the frame after it is handled, memory from
// performance.measureUserAgentSpecificMemory (cross-origin isolated, after gc()).
//
//   tsx scripts/bench/canvas.ts --machine laptop [--only C1,C2] [--quick]
//
// `?engine=` is passed through (BENCH_ENGINE=ts|wasm|both) for when the engine switch lands; main has the TS engine only.
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fillNa, runStandalone, wants, type Bench, type BenchContext} from './lib/context';
import {benchFile, newTab, openFile, openStand, settle, takeBrowserLock, CPU_THROTTLE, type Stand, type Tab} from './lib/browser';
import {summary} from './lib/stats';
import type {RowResult} from './lib/targets';
import {fixtureDocument} from './lib/fixtures';
import type {DesignDocument, NodeId} from '../../shared/design/types';

/** Frame intervals (rAF to rAF: what the screen shows, never below the 16.7 ms of a 60 Hz display) and frame work (the frame's
 *  start to the end of the editor's drawing in it: input handled, scene and overlay drawn), the measure for the rows whose target
 *  is under a display frame (C5 ≤ 12 ms). */
type Frames = {fps: number; p95: number; p99: number; frames: number; longest: number; workP95: number; workP99: number; workFrames: number; phases?: PhaseSummary};
/** The scene renderer's own time per frame by phase (`RenderStats.phases`, src/design/engine/render/scene-renderer.ts):
 *  p50/p95 of each, ms, and which renderer drew. */
type PhaseSummary = {engine: string; frames: number; [phase: string]: {p50: number; p95: number} | string | number};

function framesOf(times: number[], work: number[] = [], phases: Record<string, number | string>[] = []): Frames {
  const deltas = times.slice(1).map((t, i) => t - times[i]);
  const s = summary(deltas), w = summary(work);
  const span = times[times.length - 1] - times[0];
  const out: Frames = {fps: ((times.length - 1) / span) * 1000, p95: s.p95, p99: s.p99, frames: deltas.length, longest: s.max, workP95: w.p95, workP99: w.p99, workFrames: w.count};
  if (phases.length) {
    const summed: PhaseSummary = {engine: String(phases[phases.length - 1].engine), frames: phases.length};
    for (const key of ['sync', 'raster', 'sprites', 'frame', 'titles']) {
      const values = phases.map(p => Number(p[key])).filter(Number.isFinite);
      if (!values.length) continue;
      const v = summary(values);
      summed[key] = {p50: v.p50, p95: v.p95};
    }
    out.phases = summed;
  }
  return out;
}

/** Pans for `ms` with one wheel event per frame (`dx` CSS px a frame, turning every 2 s); answers the rAF timestamps. */
async function pan(tab: Tab, ms: number, dx = 12): Promise<Frames> {
  const viewport = () => tab.page.evaluate(() => {
    const s = (window as unknown as BenchWindow).__morfaBench.store.getState();
    return s.viewports[s.pageId] ?? {x: 0, y: 0, zoom: 1};
  });
  const before = await viewport();
  let travelled = 0;
  const {times, work, phases} = await tab.page.evaluate(async ({ms, dx}) => {
    // The renderers append each drawn frame's phases here while it is set (scene-renderer.ts `notePhases`).
    const sink: Record<string, number | string>[] = [];
    (window as unknown as {__morfaRenderPhases?: unknown}).__morfaRenderPhases = sink;
    const canvas = document.querySelector('canvas.dz-canvas__overlay') as HTMLCanvasElement;
    const bench = (window as unknown as {__morfaBench: {drawnAt: number}}).__morfaBench;
    const box = canvas.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const out: number[] = [], work: number[] = [];
    let direction = 1;
    return new Promise<{times: number[]; work: number[]; phases: Record<string, number | string>[]}>(resolve => {
      let start = 0, turned = 0;
      const step = (t: number) => {
        // The editor's draw callback was asked for while the previous step's wheel event was handled, before this step: in
        // this frame it already ran, so its end minus the frame's start is the frame's work.
        if (out.length && bench.drawnAt >= t) work.push(bench.drawnAt - t);
        if (!start) start = turned = t;
        out.push(t);
        if (t - start >= ms) {
          delete (window as unknown as {__morfaRenderPhases?: unknown}).__morfaRenderPhases;
          return resolve({times: out, work, phases: sink});
        }
        if (t - turned > 2000) {
          direction = -direction;
          turned = t;
        }
        canvas.dispatchEvent(new WheelEvent('wheel', {deltaX: dx * direction, deltaY: dx * 0.3 * direction, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true}));
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, {ms, dx});
  const after = await viewport();
  travelled = Math.hypot(after.x - before.x, after.y - before.y) + Math.abs(after.zoom - before.zoom);
  // The wheel turns every 2 s, so the view may come back near its start; a pan that never moved it measured nothing.
  if (!travelled && times.length > 10) {
    const moved = await tab.page.evaluate(() => (window as unknown as BenchWindow).__morfaBench.store.getState().viewports);
    if (!Object.keys(moved).length) throw Error('the pan did not move the viewport');
  }
  return framesOf(times, work, phases);
}

/** Pinch-zoom 1× → 4× → 1× over `ms` (ctrl + wheel, as Chrome reports a trackpad pinch), around the canvas centre. */
async function pinch(tab: Tab, ms: number): Promise<Frames> {
  const {times, work, phases} = await tab.page.evaluate(async ms => {
    // The renderers append each drawn frame's phases here while it is set (scene-renderer.ts `notePhases`).
    const sink: Record<string, number | string>[] = [];
    (window as unknown as {__morfaRenderPhases?: unknown}).__morfaRenderPhases = sink;
    const canvas = document.querySelector('canvas.dz-canvas__overlay') as HTMLCanvasElement;
    const bench = (window as unknown as {__morfaBench: {drawnAt: number}}).__morfaBench;
    const box = canvas.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const out: number[] = [], work: number[] = [];
    return new Promise<{times: number[]; work: number[]; phases: Record<string, number | string>[]}>(resolve => {
      let start = 0, last = 0;
      const step = (t: number) => {
        // As the pan: the editor's drawing for the previous step's event ran in this frame.
        if (out.length && bench.drawnAt >= t) work.push(bench.drawnAt - t);
        if (!start) start = last = t;
        out.push(t);
        const elapsed = t - start;
        if (elapsed >= ms) {
          delete (window as unknown as {__morfaRenderPhases?: unknown}).__morfaRenderPhases;
          return resolve({times: out, work, phases: sink});
        }
        // ×4 over half the time: the zoom factor per ms; wheelToViewport turns deltaY into exp(−deltaY × 0.01).
        const perMs = Math.log(4) / (ms / 2);
        const sign = elapsed < ms / 2 ? 1 : -1;
        const delta = (-(sign * perMs * (t - last))) / 0.01;
        last = t;
        canvas.dispatchEvent(new WheelEvent('wheel', {deltaY: delta, ctrlKey: true, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true}));
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, ms);
  return framesOf(times, work, phases);
}

type BenchWindow = {__morfaBench: {store: {getState(): {doc: DesignDocument; pageId: NodeId; viewports: Record<string, {x: number; y: number; zoom: number}>}; setSelection(ids: NodeId[]): void; setViewport(v: {x: number; y: number; zoom: number}): void}; renders: number}};

const setView = (tab: Tab, viewport: {x: number; y: number; zoom: number}) => tab.page.evaluate(v => (window as unknown as BenchWindow).__morfaBench.store.setViewport(v), viewport);
/** The pans run at a working zoom over the top-left of the content (25 %: a few screens, thousands of layers in view), not at
 *  the fit-to-page zoom a big file opens at, where level of detail skips almost everything. */
export const WORK_VIEW = {x: -100, y: -100, zoom: 0.25};
async function workView(tab: Tab) {
  await setView(tab, WORK_VIEW);
  await settle(tab, 30_000);
}
const select = (tab: Tab, ids: NodeId[]) => tab.page.evaluate(list => (window as unknown as BenchWindow).__morfaBench.store.setSelection(list), ids);

/** The first `count` leaf layers of the page, in order. */
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

/** Drags one layer with real pointer input for `ms`; input-to-pixel = event time → the frame after it was handled. */
async function drag(tab: Tab, nodeId: NodeId, ms: number): Promise<{p50: number; p95: number; count: number}> {
  const point = await tab.page.evaluate(id => {
    const state = (window as unknown as BenchWindow).__morfaBench.store.getState();
    const viewport = state.viewports[state.pageId];
    let x = 0, y = 0;
    let node = state.doc.nodes[id];
    const {width, height} = node;
    while (node && node.type !== 'PAGE') {
      x += node.x;
      y += node.y;
      node = state.doc.nodes[node.parentId!];
    }
    const canvas = document.querySelector('canvas.dz-canvas__overlay') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    return {x: box.left + (x + width / 2 - viewport.x) * viewport.zoom, y: box.top + (y + height / 2 - viewport.y) * viewport.zoom};
  }, nodeId);
  await tab.page.evaluate(() => {
    const samples: number[] = [];
    (window as unknown as {__inputToPixel: number[]}).__inputToPixel = samples;
    let pending: number | null = null;
    addEventListener('pointermove', event => {
      if (pending !== null) return;
      pending = event.timeStamp;
      requestAnimationFrame(() => {
        // After this frame's rendering steps: the next task (a MessageChannel message runs before timers).
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          samples.push(performance.now() - pending!);
          pending = null;
        };
        channel.port2.postMessage(0);
      });
    }, {capture: true});
  });
  await tab.page.mouse.move(point.x, point.y);
  await tab.page.mouse.down();
  const started = Date.now();
  for (let k = 1; Date.now() - started < ms; k++) {
    await tab.page.mouse.move(point.x + 40 * Math.sin(k / 15) + k * 0.2, point.y + 30 * Math.cos(k / 20));
    await tab.page.waitForTimeout(8);
  }
  await tab.page.mouse.up();
  const samples = await tab.page.evaluate(() => (window as unknown as {__inputToPixel: number[]}).__inputToPixel.splice(0));
  const s = summary(samples.slice(3));
  return {p50: s.p50, p95: s.p95, count: s.count};
}

async function memoryMb(tab: Tab): Promise<{mb: number; breakdown: string}> {
  return tab.page.evaluate(async () => {
    (globalThis as {gc?: () => void}).gc?.();
    const measure = (performance as unknown as {measureUserAgentSpecificMemory?: () => Promise<{bytes: number; breakdown: {bytes: number; types: string[]}[]}>}).measureUserAgentSpecificMemory;
    if (!crossOriginIsolated || !measure) return {mb: NaN, breakdown: `crossOriginIsolated ${crossOriginIsolated}`};
    const result = await measure.call(performance);
    const types = new Map<string, number>();
    for (const entry of result.breakdown) for (const type of entry.types.length ? entry.types : ['other']) types.set(type, (types.get(type) ?? 0) + entry.bytes / entry.types.length || 0);
    return {mb: result.bytes / 2 ** 20, breakdown: [...types].map(([type, bytes]) => `${type} ${(bytes / 2 ** 20).toFixed(0)} MB`).join(', ')};
  });
}

const engine = process.env.BENCH_ENGINE;

const run: Bench = async (ctx: BenchContext) => {
  if (ctx.machine !== 'laptop') return fillNa(ctx, [], 'canvas rows run on the laptop (stand-in: this Mac, Chromium at 2× CPU throttle): --machine laptop');
  const results: RowResult[] = [];
  const quick = ctx.quick;
  const panMs = quick ? 3_000 : 10_000;
  const release = await takeBrowserLock('B0 canvas.ts', ctx.log);
  let stand: Stand | null = null;
  // Which scene renderer drew (lane L4: `gpu` on WebGPU behind ?engine=wasm, else `canvas2d` and why), read from the
  // editor's bench hook once a tab has painted; in the notes of every row after it.
  let renderer = '';
  const noteRenderer = async (tab: Tab) => {
    const seen = await tab.page.evaluate(() => (window as unknown as {__morfaBench?: {renderer?: {engine: string; reason?: string}}}).__morfaBench?.renderer ?? null);
    if (seen) {
      renderer = `scene renderer ${seen.engine}${seen.reason ? ` (${seen.reason})` : ''}`;
      ctx.log(`canvas: ${renderer}`);
    }
  };
  const notes = (extra: string) => `stand-in: Playwright Chromium (new headless) on this Mac, CPU ${CPU_THROTTLE}× throttled, 1440×900 at DPR 2${engine ? `, ?engine=${engine}` : ''}${renderer ? `, ${renderer}` : ''}; ${extra}`;
  try {
    stand = await openStand(ctx.log);
    const stand_ = stand;
    ctx.log(`canvas: browser ${stand.browser.version()}, WebGL renderer ${stand.gpu}`);
    const f20k = fixtureDocument('f20k');

    if (wants(ctx, 'C9', 'C1', 'C5')) {
      const id = await benchFile(stand_, 'f20k');
      const tab = await newTab(stand_);
      try {
        const cold = await openFile(tab, stand_, id);
        await noteRenderer(tab);
        if (wants(ctx, 'C9')) {
          await settle(tab);
          await tab.page.reload({waitUntil: 'commit'});
          const warm = await openFile(tab, stand_, id);
          results.push({id: 'C9', values: {interactiveCold: cold.interactive, interactiveWarm: warm.interactive}, notes: [notes(`C9: f20k (15.9 MB) from the bench server on loopback, no network shaping; cold = a new browser profile, warm = a reload with the app's code cached (legacy keeps no checkpoint in IndexedDB); first paint ${cold.firstPaint.toFixed(0)} / ${warm.firstPaint.toFixed(0)} ms, document loaded at ${cold.documentLoaded.toFixed(0)} ms`)]});
        }
        await workView(tab);
        if (wants(ctx, 'C1')) {
          const frames = await pan(tab, panMs);
          results.push({id: 'C1', values: {fps: frames.fps, frameP99: frames.p99}, notes: [notes(`C1: f20k at 25 % zoom over its first screens, ${frames.frames} frames, p95 ${frames.p95.toFixed(1)} ms, longest ${frames.longest.toFixed(0)} ms; the editor's work per frame p95 ${frames.workP95.toFixed(1)} ms`)], extra: frames});
        }
        if (wants(ctx, 'C5')) {
          await select(tab, leaves(f20k, 5000));
          await workView(tab);
          const frames = await pan(tab, panMs);
          results.push({id: 'C5', values: {frameP95: frames.workP95}, notes: [notes(`C5: 5 000 leaf layers of f20k selected, 25 % zoom; frame p95 = the frame's work (start → the editor's drawing done, ${frames.workFrames} frames; a 60 Hz interval is never under 16.7 ms), intervals p95 ${frames.p95.toFixed(1)} ms, fps ${frames.fps.toFixed(1)}`)], extra: frames});
          await select(tab, []);
        }
      } finally {
        await tab.context.close();
      }
    }

    if (wants(ctx, 'C7')) {
      // Cold over 50 Mbit/s + 20 ms (CDP network emulation) in a new profile.
      const id = await benchFile(stand_, 'f100k');
      const tab = await newTab(stand_, {network: {downloadMbps: 50, latencyMs: 20}});
      try {
        const cold = await openFile(tab, stand_, id, 'design', 240_000);
        await noteRenderer(tab);
        results.push({id: 'C7', values: {firstPaint: cold.firstPaint, interactive: cold.interactive}, notes: [notes(`C7: f100k (79.6 MB JSON, 100 201 layers) served from disk past the legacy caps (scripts/bench/server.ts override), 50 Mbit/s + 20 ms through CDP; document loaded at ${cold.documentLoaded.toFixed(0)} ms`)]});
      } catch (error) {
        const message = String((error as Error).message);
        const gaveUp = message.includes('taking too long to respond');
        results.push(gaveUp
          ? {id: 'C7', values: {firstPaint: Infinity, interactive: Infinity}, text: 'never: the editor gives up on the 80 MB read after 3 × 10 s (src/api-read.ts readApi timeoutMs 10 000, "The server is taking too long to respond"); at 50 Mbit/s the body alone needs 12.7 s', notes: [notes('C7: f100k cold over 50 Mbit/s + 20 ms (CDP): the open fails in the client, see the actual')]}
          : {id: 'C7', na: `the open failed: ${message.slice(0, 200)}`});
      } finally {
        await tab.context.close();
      }
    }

    if (wants(ctx, 'C2', 'C4', 'C6', 'C8', 'C10')) {
      const f100k = fixtureDocument('f100k');
      const id = await benchFile(stand_, 'f100k');
      const tab = await newTab(stand_);
      try {
        await openFile(tab, stand_, id, 'design', 600_000);
        await noteRenderer(tab);
        await settle(tab, 60_000);
        if (wants(ctx, 'C8')) {
          await tab.page.reload({waitUntil: 'commit'});
          const warm = await openFile(tab, stand_, id, 'design', 600_000);
          results.push({id: 'C8', na: `needs the IndexedDB checkpoint and the compiled WASM cache (B3, L4): legacy reloads f100k whole; a warm reload today: first paint ${warm.firstPaint.toFixed(0)} ms, interactive ${warm.interactive.toFixed(0)} ms`});
          await settle(tab, 60_000);
        }
        if (wants(ctx, 'C2')) {
          await workView(tab);
          const frames = await pan(tab, panMs);
          results.push({id: 'C2', values: {fps: frames.fps, frameP99: frames.p99}, notes: [notes(`C2: f100k at 25 % zoom over its first screens, ${frames.frames} frames, p95 ${frames.p95.toFixed(1)} ms, longest ${frames.longest.toFixed(0)} ms; the editor's work per frame p95 ${frames.workP95.toFixed(1)} ms`)], extra: frames});
        }
        if (wants(ctx, 'C4')) {
          const state = await tab.page.evaluate(() => {
            const s = (window as unknown as BenchWindow).__morfaBench.store.getState();
            return s.viewports[s.pageId];
          });
          await setView(tab, {x: state.x, y: state.y, zoom: 1});
          await settle(tab, 30_000);
          const frames = await pinch(tab, 4_000);
          results.push({id: 'C4', values: {frameP99: frames.p99}, notes: [notes(`C4: f100k pinch 1× → 4× → 1× in 4 s, ${frames.frames} frames, fps ${frames.fps.toFixed(1)}, longest ${frames.longest.toFixed(0)} ms; the editor's work per frame p95 ${frames.workP95.toFixed(1)} ms`)], extra: frames});
        }
        if (wants(ctx, 'C6')) {
          const [layer] = leaves(f100k, 1);
          const view = await tab.page.evaluate(() => {
            const s = (window as unknown as BenchWindow).__morfaBench.store.getState();
            return s.viewports[s.pageId];
          });
          await setView(tab, {x: -100, y: -100, zoom: Math.max(0.5, view.zoom)});
          await select(tab, [layer]);
          await settle(tab, 30_000);
          const input = await drag(tab, layer, quick ? 2_000 : 5_000);
          results.push(input.count ? {id: 'C6', values: {inputToPixelP95: input.p95}, notes: [notes(`C6: one layer of f100k dragged with CDP pointer input, ${input.count} frames, p50 ${input.p50.toFixed(1)} ms`)]} : {id: 'C6', na: 'no pointer frame measured'});
          await tab.page.keyboard.press('Escape');
        }
        if (wants(ctx, 'C10')) {
          const idleMs = quick ? 20_000 : 5 * 60_000;
          await select(tab, []);
          await settle(tab, 30_000);
          await tab.page.waitForTimeout(idleMs);
          const memory = await memoryMb(tab);
          results.push(Number.isFinite(memory.mb)
            ? {id: 'C10', values: {memory: memory.mb}, notes: [notes(`C10: f100k open ${idleMs / 60_000} min idle, measureUserAgentSpecificMemory after gc(): ${memory.breakdown}; canvas tiles in the GPU process are not in this number`)]}
            : {id: 'C10', na: `measureUserAgentSpecificMemory unavailable (${memory.breakdown})`});
        }
      } finally {
        await tab.context.close();
      }
    }

    if (wants(ctx, 'C12')) {
      const board = fixtureDocument('board2k');
      const id = await benchFile(stand_, 'board2k', 'board');
      const tab = await newTab(stand_);
      try {
        await openFile(tab, stand_, id);
        await settle(tab);
        await select(tab, board.nodes[board.pages[0]].children ?? []);
        await workView(tab);
        const frames = await pan(tab, panMs);
        results.push({id: 'C12', values: {frameP95: frames.workP95}, notes: [notes(`C12: board2k (2 000 stickies) all selected, 25 % zoom; frame p95 = the frame's work (${frames.workFrames} frames), intervals p95 ${frames.p95.toFixed(1)} ms, fps ${frames.fps.toFixed(1)}`)], extra: frames});
      } finally {
        await tab.context.close();
      }
    }
    if (wants(ctx, 'C3', 'C11')) {
      // f500k (one page of 499 999 layers, 399 MB of JSON) through the editor with big files off: the
      // bench server streams it from disk past the legacy caps, the editor parses it whole (~33 s to the first paint in the cloud container, the renderer's RSS peaking at ~2.1 GB during the parse).
      const id = await benchFile(stand_, 'f500k');
      const tab = await newTab(stand_);
      try {
        const opened = await openFile(tab, stand_, id, 'design', 15 * 60_000);
        await noteRenderer(tab);
        await settle(tab, 120_000);
        const openNote = `the open: ${Number.isFinite(opened.documentLoaded) ? `document at ${(opened.documentLoaded / 1000).toFixed(1)} s, ` : ''}first paint ${(opened.firstPaint / 1000).toFixed(1)} s, interactive ${(opened.interactive / 1000).toFixed(1)} s`;
        if (wants(ctx, 'C3')) {
          await workView(tab);
          const frames = await pan(tab, panMs);
          // The GPU renderer names itself once its device is up, after the open: read it again for this row.
          await noteRenderer(tab);
          results.push({id: 'C3', values: {fps: frames.fps, frameP99: frames.p99}, notes: [notes(`C3: f500k through the editor (big files off), 25 % zoom over its first screens, ${frames.frames} frames, p95 ${frames.p95.toFixed(1)} ms, longest ${frames.longest.toFixed(0)} ms; the editor's work per frame p95 ${frames.workP95.toFixed(1)} ms; ${openNote}`)], extra: frames});
        }
        if (wants(ctx, 'C11')) {
          const idleMs = quick ? 20_000 : 60_000;
          await select(tab, []);
          await settle(tab, 60_000);
          await tab.page.waitForTimeout(idleMs);
          const memory = await memoryMb(tab);
          await noteRenderer(tab);
          results.push(Number.isFinite(memory.mb)
            ? {id: 'C11', values: {memory: memory.mb}, notes: [notes(`C11: f500k open (big files off) ${idleMs / 1000} s idle, measureUserAgentSpecificMemory after gc(): ${memory.breakdown}; canvas tiles in the GPU process are not in this number; ${openNote}`)]}
            : {id: 'C11', na: `measureUserAgentSpecificMemory unavailable (${memory.breakdown})`});
        }
      } catch (error) {
        const message = String((error as Error).message).slice(0, 200);
        for (const row of ['C3', 'C11']) if (wants(ctx, row)) results.push({id: row, na: `f500k did not open through the editor: ${message}`});
      } finally {
        await tab.context.close();
      }
    }
  } finally {
    await stand?.close();
    release();
  }
  writeFileSync(path.join(ctx.outDir, 'canvas.json'), JSON.stringify(results, null, 1));
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('canvas', run, import.meta.url);
