// What one editor's screen does while many people work in its file (docs/design-tool.md "Collaborative editing"): the built
// editor with `?bench=1` on the laptop stand-in (scripts/bench/lib/browser.ts, CPU ×2), its file shared in a team with `--peers`
// simulated people. Each of them is a real account with its own live stream (GET /:id/events), posts its presence the way the
// editor does (a cursor gliding over the visible part of the page ~16 times a second, a selection of a few layers that changes
// every 1.5 s, its viewport) and, in the edit phases, moves one of its own layers once a second through PATCH /:id/document.
//
//   tsx scripts/bench/multiplayer-canvas.ts [--peers 10] [--fixture f20k] [--seconds 10] [--out output/bench/multiplayer.json]
//                                           [--shots <dir>] [--trace <dir>] [--profile <dir>]
//
// Phases, each `--seconds` long, measured in the watching editor: `still` (everyone connected, nobody moves), `pan-alone` (this
// editor pans, nobody else moves: the baseline of `pan`), `cursors` (cursors and selections), `edits` (cursors, selections and
// edits), `pan` (all of that while this editor pans with the wheel). `--trace` writes a Chrome trace of each phase, `--profile`
// its main thread's JS profile (CDP Profiler; build the app unminified for names, see profile.ts) with the hot functions. Per phase:
// frame intervals (rAF to rAF: fps, p95, p99, longest), long tasks (count, total), scene renders, and the main thread's busy share
// (CDP Performance metrics: TaskDuration over wall time) with its script, style and layout parts. Needs the isolated test cluster's
// env (docs/dev.md), like every bench server; PLAYWRIGHT_CHROMIUM names the browser when Playwright's own build is missing.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {apply, localMatrix, multiply} from '../../shared/design/geometry';
import type {DesignDocument, Matrix, NodeId, SceneNode} from '../../shared/design/types';
import {newTab, openFile, openStand, settle, type Tab} from './lib/browser';
import {accounts, api, cookieOf, createFile, fixtureDocument, team, type Account} from './lib/fixtures';
import {formatHot, hotSpots, type CpuProfile} from './lib/cpuprofile';
import {summary} from './lib/stats';
import type {BenchServer} from './lib/server';
import {ROOT} from './lib/targets';

const {values: args} = parseArgs({
  options: {
    peers: {type: 'string', default: '10'},
    fixture: {type: 'string', default: 'f20k'},
    seconds: {type: 'string', default: '10'},
    out: {type: 'string', default: 'output/bench/multiplayer-canvas.json'},
    shots: {type: 'string'},
    trace: {type: 'string'},
    profile: {type: 'string'},
  },
});
const PEERS = Number(args.peers), SECONDS = Number(args.seconds);
const log = (line: string) => console.log(`[multiplayer] ${line}`);
/** The view the editor watches from: 25 % over the top-left of the content, thousands of layers in view (canvas.ts WORK_VIEW). */
const VIEW = {x: -100, y: -100, zoom: 0.25};
/** The canvas of a 1440 × 900 window between the two panels, roughly. */
const CANVAS = {width: 960, height: 820};
const PRESENCE_MS = 60;
const SELECTION_MS = 1_500;
const EDIT_MS = 1_000;

type Rect = {x: number; y: number; width: number; height: number};

/** The page's groups whose box lies in `view` (page space), with their children: each simulated person works in one. */
function groupsInView(doc: DesignDocument, view: Rect): {group: NodeId; children: NodeId[]}[] {
  const world = new Map<NodeId, Matrix>();
  const worldOf = (id: NodeId): Matrix => {
    const known = world.get(id);
    if (known) return known;
    const node = doc.nodes[id];
    const m: Matrix = node.type === 'PAGE' || node.parentId === null ? [[1, 0, 0], [0, 1, 0]] : multiply(worldOf(node.parentId), localMatrix(node));
    world.set(id, m);
    return m;
  };
  const out: {group: NodeId; children: NodeId[]}[] = [];
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'GROUP' || !node.children?.length) continue;
    const corner = apply(worldOf(node.id), {x: 0, y: 0});
    if (corner.x < view.x || corner.y < view.y || corner.x + node.width > view.x + view.width || corner.y + node.height > view.y + view.height) continue;
    out.push({group: node.id, children: [...node.children]});
  }
  return out;
}

type Peer = {
  account: Account;
  token: string;
  connection: string;
  version: number;
  stop(): void;
  received: number;
};

/** A live stream of `account` on the file: the hello, then every change's version (and the bytes, to keep the stream flowing). */
async function connect(base: string, fileId: string, account: Account): Promise<Peer> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/design-files/${encodeURIComponent(fileId)}/events`, {headers: {cookie: cookieOf(account), accept: 'text/event-stream'}, signal: controller.signal});
  if (!response.ok || !response.body) throw Error(`stream: ${response.status} ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resolveHello: (peer: Peer) => void = () => {}, rejectHello: (error: unknown) => void = () => {};
  const hello = new Promise<Peer>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const peer: Peer = {account, token: '', connection: '', version: 0, received: 0, stop: () => controller.abort()};
  void (async () => {
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        peer.received += value.byteLength;
        buffer += decoder.decode(value, {stream: true});
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let name = '', data = '', id = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('id: ')) id = line.slice(4);
          }
          if (name === 'hello') {
            const value = JSON.parse(data) as {token: string; connection: string; version: number};
            Object.assign(peer, {token: value.token, connection: value.connection, version: value.version});
            resolveHello(peer);
          } else if (name === 'change' && id) peer.version = Math.max(peer.version, Number(id));
          else if (name === 'bye') throw Error(`stream closed: ${data}`);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        log(`stream of ${account.id.slice(0, 8)} ended: ${String(error)}`);
        rejectHello(error);
      }
    }
  })();
  return hello;
}

type Counts = {presence: number; presenceRefused: number; edits: number; editsRefused: number; editStatuses: Record<string, number>};

/** One simulated person: presence ~16 times a second along its own curve over `view`, a new selection every 1.5 s, an edit a
 *  second when `editing()` says so. Returns the stop. */
function work(server: BenchServer, fileId: string, page: NodeId, peer: Peer, index: number, nodes: SceneNode[], view: Rect, active: () => {moving: boolean; editing: boolean}, counts: Counts): () => void {
  const local = new Map(nodes.map(node => [node.id, node]));
  const ids = nodes.map(node => node.id);
  let stopped = false, inflight = false, selection: NodeId[] = [], selectedAt = 0, editedAt = 0, editing = false;
  const started = performance.now();
  const base = server.base;
  const headers = {cookie: cookieOf(peer.account), 'content-type': 'application/json', origin: base};
  const post = async () => {
    if (stopped) return;
    const now = performance.now();
    const state = active();
    if (state.moving && !inflight) {
      const t = (now - started) / 1000;
      // A Lissajous curve per person: every cursor keeps moving, none on the same path.
      const cursor = {
        x: view.x + view.width * (0.5 + 0.42 * Math.sin(t * (0.7 + index * 0.13) + index)),
        y: view.y + view.height * (0.5 + 0.42 * Math.sin(t * (0.9 + index * 0.11) + index * 2)),
      };
      if (now - selectedAt > SELECTION_MS) {
        selectedAt = now;
        const at = Math.floor(Math.random() * Math.max(1, ids.length - 5));
        selection = ids.slice(at, at + 1 + Math.floor(Math.random() * 5));
      }
      inflight = true;
      const body = {token: peer.token, cursor, page, selection, selectionCount: selection.length, viewport: {...VIEW, width: CANVAS.width, height: CANVAS.height}};
      fetch(`${base}/api/design-files/${encodeURIComponent(fileId)}/presence`, {method: 'POST', headers, body: JSON.stringify(body)})
        .then(response => {
          counts.presence++;
          if (response.status !== 204) counts.presenceRefused++;
          return response.arrayBuffer();
        })
        .catch(() => counts.presenceRefused++)
        .finally(() => (inflight = false));
    }
    if (state.editing && !editing && now - editedAt > EDIT_MS) {
      editedAt = now;
      editing = true;
      const id = selection[0] ?? ids[index % ids.length];
      const before = local.get(id)!;
      const next = {...before, x: before.x + (Math.random() < 0.5 ? -4 : 4), y: before.y + (Math.random() < 0.5 ? -3 : 3)};
      api(server, peer.account, 'PATCH', `/api/design-files/${encodeURIComponent(fileId)}/document`, {baseVersion: peer.version, patch: {nodes: {[id]: next}}, before: {[id]: before}, client: peer.connection})
        .then(answer => {
          counts.edits++;
          counts.editStatuses[answer.status] = (counts.editStatuses[answer.status] ?? 0) + 1;
          if (answer.status === 200) {
            local.set(id, next);
            peer.version = Math.max(peer.version, (JSON.parse(answer.text) as {version: number}).version);
          } else counts.editsRefused++;
        })
        .catch(() => counts.editsRefused++)
        .finally(() => (editing = false));
    }
    setTimeout(post, PRESENCE_MS);
  };
  setTimeout(post, (index * PRESENCE_MS) / Math.max(1, PEERS));
  return () => void (stopped = true);
}

type Phase = {
  name: string;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  longest: number;
  frames: number;
  over33: number;
  longTasks: number;
  longTaskMs: number;
  renders: number;
  busy: number;
  script: number;
  style: number;
  layout: number;
  cursorsShown: number;
  /** BENCH_COUNT_DRAWS=1: 2D context calls per canvas (its class) in the window. */
  draws?: Record<string, number>;
};

/** The watching editor for `ms`: its frames (while it pans with the wheel when `pan`), long tasks, renders and CPU. */
async function measure(tab: Tab, name: string, ms: number, pan: boolean): Promise<Phase> {
  const metrics = async () => Object.fromEntries(((await tab.cdp.send('Performance.getMetrics')) as {metrics: {name: string; value: number}[]}).metrics.map(m => [m.name, m.value]));
  const before = await metrics();
  const wallStart = Date.now();
  const result = await tab.page.evaluate(
    async ({ms, pan}) => {
      const bench = (window as unknown as {__morfaBench: {renders: number}}).__morfaBench;
      const renders = bench.renders;
      const long: number[] = [];
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) long.push(entry.duration);
      });
      observer.observe({type: 'longtask'});
      const canvas = document.querySelector('canvas.dz-canvas__overlay') as HTMLCanvasElement;
      const box = canvas.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      const times: number[] = [];
      let direction = 1;
      await new Promise<void>(resolve => {
        let start = 0, turned = 0;
        const step = (t: number) => {
          if (!start) start = turned = t;
          times.push(t);
          if (t - start >= ms) return resolve();
          if (pan) {
            if (t - turned > 2000) {
              direction = -direction;
              turned = t;
            }
            canvas.dispatchEvent(new WheelEvent('wheel', {deltaX: 12 * direction, deltaY: 4 * direction, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true}));
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      observer.disconnect();
      const draws = (window as unknown as {__draws?: Record<string, number>}).__draws;
      const counted = draws ? {...draws} : null;
      if (draws) for (const key of Object.keys(draws)) delete draws[key];
      return {times, long, renders: bench.renders - renders, cursorsShown: document.querySelectorAll('.dz-live-cursor.is-shown').length, draws: counted};
    },
    {ms, pan},
  );
  const after = await metrics();
  const wall = (Date.now() - wallStart) / 1000;
  const share = (key: string) => (after[key] - before[key]) / wall;
  const deltas = result.times.slice(1).map((t, i) => t - result.times[i]);
  const s = summary(deltas);
  const span = result.times[result.times.length - 1] - result.times[0];
  return {
    name,
    fps: ((result.times.length - 1) / span) * 1000,
    p50: s.p50,
    p95: s.p95,
    p99: s.p99,
    longest: s.max,
    frames: deltas.length,
    over33: deltas.filter(d => d > 33.4).length,
    longTasks: result.long.length,
    longTaskMs: result.long.reduce((a, b) => a + b, 0),
    renders: result.renders,
    busy: share('TaskDuration'),
    script: share('ScriptDuration'),
    style: share('RecalcStyleDuration'),
    layout: share('LayoutDuration'),
    cursorsShown: result.cursorsShown,
    ...(result.draws ? {draws: result.draws} : {}),
  };
}

const stand = await openStand(log);
const stops: (() => void)[] = [];
try {
  const doc = fixtureDocument(args.fixture!);
  const page = doc.pages[0];
  const view = {x: VIEW.x, y: VIEW.y, width: CANVAS.width / VIEW.zoom, height: CANVAS.height / VIEW.zoom};
  const groups = groupsInView(doc, view);
  if (groups.length < PEERS) log(`only ${groups.length} groups in view for ${PEERS} people: some share one`);
  const people = await accounts(stand.server, PEERS, 'mp');
  const teamId = await team(stand.server, stand.account, people.map(account => ({account, role: 'editor' as const})));
  const file = await createFile(stand.server, stand.account, args.fixture!, teamId);
  log(`file ${file.id} (${args.fixture}, ${Object.keys(doc.nodes).length} layers), ${PEERS} people, ${groups.length} groups in view`);

  const tab = await newTab(stand);
  if (process.env.BENCH_COUNT_DRAWS === '1')
    await tab.context.addInitScript({
      content: `(() => { const draws = (window.__draws = {}); const proto = CanvasRenderingContext2D.prototype;
        for (const name of ['clearRect', 'fillRect', 'drawImage', 'fill', 'stroke', 'fillText', 'putImageData']) {
          const original = proto[name];
          proto[name] = function (...a) { const key = (this.canvas.className || this.canvas.parentElement?.className || 'canvas') + ' ' + name; draws[key] = (draws[key] || 0) + 1; return original.apply(this, a); };
        } })();`,
    });
  await tab.cdp.send('Performance.enable', {timeDomain: 'timeTicks'});
  const opened = await openFile(tab, stand, file.id);
  log(`opened: first paint ${opened.firstPaint.toFixed(0)} ms`);
  await tab.page.evaluate(v => (window as unknown as {__morfaBench: {store: {setViewport(v: unknown): void}}}).__morfaBench.store.setViewport(v), VIEW);
  await settle(tab, 30_000);

  const peers: Peer[] = [];
  for (const account of people) peers.push(await connect(stand.server.base, file.id, account));
  for (const peer of peers) stops.push(peer.stop);
  const state = {moving: false, editing: false};
  const counts: Counts = {presence: 0, presenceRefused: 0, edits: 0, editsRefused: 0, editStatuses: {}};
  peers.forEach((peer, index) => {
    const nodes = groups[index % Math.max(1, groups.length)].children.map(id => doc.nodes[id]);
    stops.push(work(stand.server, file.id, page, peer, index, nodes, view, () => state, counts));
  });
  await settle(tab, 10_000);

  const phases: Phase[] = [];
  const run = async (name: string, moving: boolean, editing: boolean, pan: boolean) => {
    state.moving = moving;
    state.editing = editing;
    // A second to get going (streams, the first edits' answers) before the window.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    if (pan) await tab.page.evaluate(v => (window as unknown as {__morfaBench: {store: {setViewport(v: unknown): void}}}).__morfaBench.store.setViewport(v), VIEW);
    if (args.trace) {
      mkdirSync(args.trace, {recursive: true});
      await stand.browser.startTracing(tab.page, {path: path.join(args.trace, `${name}.json`), categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink', 'cc', 'gpu']});
    }
    if (args.profile) {
      await tab.cdp.send('Profiler.enable');
      await tab.cdp.send('Profiler.setSamplingInterval', {interval: 200});
      await tab.cdp.send('Profiler.start');
    }
    const phase = await measure(tab, name, SECONDS * 1000, pan);
    if (args.trace) await stand.browser.stopTracing();
    if (args.profile) {
      const {profile} = (await tab.cdp.send('Profiler.stop')) as {profile: CpuProfile};
      mkdirSync(args.profile, {recursive: true});
      writeFileSync(path.join(args.profile, `${name}.cpuprofile`), JSON.stringify(profile));
      const hot = hotSpots(profile, 18);
      log(`  JS ${name}: ${((1 - hot.idleShare) * 100).toFixed(0)} % busy of ${(hot.profileMs / 1000).toFixed(1)} s\n${formatHot(hot.self, 'self')}`);
    }
    phases.push(phase);
    log(
      `${name.padEnd(9)} ${phase.fps.toFixed(1)} fps · p95 ${phase.p95.toFixed(1)} ms · p99 ${phase.p99.toFixed(1)} ms · longest ${phase.longest.toFixed(0)} ms · ` +
        `>33 ms ${phase.over33}/${phase.frames} · long tasks ${phase.longTasks} (${phase.longTaskMs.toFixed(0)} ms) · renders ${phase.renders} · ` +
        `main thread ${(phase.busy * 100).toFixed(0)} % (script ${(phase.script * 100).toFixed(0)}, style ${(phase.style * 100).toFixed(0)}, layout ${(phase.layout * 100).toFixed(0)}) · cursors ${phase.cursorsShown}`,
    );
    if (phase.draws) log(`  draws ${JSON.stringify(phase.draws)}`);
    if (args.shots) {
      mkdirSync(args.shots, {recursive: true});
      await tab.page.screenshot({path: path.join(args.shots, `${name}.png`)});
    }
  };
  await run('still', false, false, false);
  await run('pan-alone', false, false, true);
  await run('cursors', true, false, false);
  await run('edits', true, true, false);
  await run('pan', true, true, true);
  state.moving = state.editing = false;
  log(`presence posts ${counts.presence} (refused ${counts.presenceRefused}), edits ${counts.edits} (statuses ${JSON.stringify(counts.editStatuses)})`);
  const out = path.resolve(ROOT, args.out!);
  mkdirSync(path.dirname(out), {recursive: true});
  writeFileSync(out, JSON.stringify({fixture: args.fixture, peers: PEERS, seconds: SECONDS, gpu: stand.gpu, phases, counts}, null, 2));
  log(`written ${path.relative(ROOT, out)}`);
} finally {
  for (const stop of stops) stop();
  await stand.close();
}
