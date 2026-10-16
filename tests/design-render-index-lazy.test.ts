import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNode} from '../shared/design/defaults';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {Rect} from '../shared/design/geometry';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore} from '../src/design/engine/store';
import {SpatialIndex} from '../src/design/engine/render/spatial-index';
import {FIXTURES, generatedPage} from '../scripts/goldens/fixtures';

// The spatial index built lazily by page root: a root that clips its content keeps only
// its own box until something asks about it. Every answer — bounds, mask flags, queries, and once complete the background
// blur's reach — must equal an index built whole, on every fixture and on f20k, and stay equal through edits with the
// store's hints, whichever roots were asked about in between.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const sorted = (ids: Iterable<NodeId>) => [...ids].sort();

/** A deterministic sequence in [0, 1). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function onPage(doc: DesignDocument, pageId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack = [...(doc.nodes[pageId].children ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    out.push(id);
    for (const child of node.children ?? []) stack.push(child);
  }
  return out;
}

/** The page's extent, for queries that cover it in pieces. */
function extent(index: SpatialIndex, ids: NodeId[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const r = index.bounds(id);
    if (!r || !Number.isFinite(r.x + r.y + r.width + r.height)) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return x0 <= x1 ? {x: x0, y: y0, width: x1 - x0, height: y1 - y0} : {x: 0, y: 0, width: 100, height: 100};
}

/** `lazy` answers as an index built whole on `doc` does. Queries go first (in pieces, as tiles ask), so some roots are
 *  indexed by them and some by `bounds`, `hasMask` or `complete` after. */
function sameAsWhole(lazy: SpatialIndex, doc: DesignDocument, pageId: NodeId, label: string, next: () => number) {
  const whole = new SpatialIndex({eager: true});
  whole.sync(doc, pageId, measurer);
  const ids = onPage(doc, pageId);
  const area = extent(whole, ids);
  for (let k = 0; k < 12; k++) {
    const w = area.width * (0.05 + next() * 0.3), h = area.height * (0.05 + next() * 0.3);
    const rect = {x: area.x + next() * area.width - w / 2, y: area.y + next() * area.height - h / 2, width: w, height: h};
    assert.deepEqual(sorted(lazy.query(rect)), sorted(whole.query(rect)), `${label}: query ${JSON.stringify(rect)}`);
  }
  for (const id of ids) {
    if (next() < 0.5) continue;
    const a = lazy.bounds(id), b = whole.bounds(id);
    if (!a || !b) assert.equal(a, b, `${label}: bounds of ${id}`);
    else for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `${label}: ${id}.${key} ${a[key]} vs ${b[key]}`);
    assert.equal(lazy.hasMask(id), whole.hasMask(id), `${label}: mask flag of ${id}`);
  }
  lazy.complete();
  assert.equal(lazy.unindexed, 0);
  assert.equal(lazy.blurMargin, whole.blurMargin, `${label}: background blur reach`);
  for (const id of ids) {
    const a = lazy.bounds(id), b = whole.bounds(id);
    if (!a || !b) assert.equal(a, b, `${label}: bounds of ${id} (complete)`);
    else for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `${label}: ${id}.${key} (complete)`);
    assert.equal(lazy.hasMask(id), whole.hasMask(id), `${label}: mask flag of ${id} (complete)`);
  }
  const everywhere = {x: area.x - 1e4, y: area.y - 1e4, width: area.width + 2e4, height: area.height + 2e4};
  assert.deepEqual(sorted(lazy.query(everywhere)), sorted(whole.query(everywhere)), `${label}: everything`);
}

test('built lazily, the index answers as one built whole: every fixture page and f20k', () => {
  let roots = 0;
  const docs = [...FIXTURES.map(f => ({name: f.name, doc: f.build()})), {name: 'f20k', doc: generatedPage(20_041)}];
  for (const {name, doc} of docs) {
    for (const pageId of doc.pages) {
      const lazy = new SpatialIndex();
      lazy.sync(doc, pageId, measurer);
      roots += lazy.unindexed;
      sameAsWhole(lazy, doc, pageId, `${name}/${pageId}`, random(roots + 7));
    }
  }
  assert.ok(roots > 50, `${roots} roots were left for later`);
});

// Both table modes (as a drag's frames do), and an index
// built whole at the start as well as a lazy one: the incremental path must hold in each.
for (const table of ['copy', 'in-place'] as const) for (const eager of [false, true])
test(`edits with the store's hints keep the ${eager ? 'whole' : 'lazy'} index equal to one built whole (${table}), whichever roots were asked about`, () => {
  for (const fixture of [...FIXTURES.filter(f => f.name.startsWith('template-')).slice(0, 4), {name: 'f20k', build: () => generatedPage(20_041)}]) {
    const doc = fixture.build();
    const pageId = doc.pages.find(id => (doc.nodes[id].children ?? []).length > 1) ?? doc.pages[0];
    const store = createDesignStore({doc, measurer, idle: () => () => {}, table});
    store.setPage(pageId);
    const next = random(fixture.name.length * 31);
    const lazy = new SpatialIndex({eager});
    lazy.sync(store.getState().doc, pageId, measurer);
    let from = store.getState().doc;
    const ids = new Set<NodeId>();
    const off = store.onDocument(change => change.changed.forEach(id => ids.add(id)));
    let created = 0;
    for (let step = 0; step < 40; step++) {
      const state = store.getState().doc;
      const all = onPage(state, pageId).filter(id => state.nodes[id].type !== 'PAGE');
      const roots = state.nodes[pageId].children ?? [];
      const pick = all[Math.floor(next() * all.length)];
      const containers = all.filter(id => ['FRAME', 'GROUP', 'COMPONENT', 'SECTION'].includes(state.nodes[id].type) && !state.nodes[id].componentId);
      const kind = Math.floor(next() * 6);
      if (step % 5 === 2 && pick) {
        // A drag: its frames share one node table (the shared-table path), synced frame by frame.
        const start = state.nodes[pick];
        const drag = store.gesture('drag');
        for (let k = 1; k <= 3; k++) {
          drag.update(tx => tx.update(pick, {x: start.x + 17 * k, y: start.y - 9 * k}));
          const frame = store.getState().doc;
          lazy.sync(frame, pageId, measurer, {from, ids: [...ids]});
          ids.clear();
          from = frame;
        }
        drag.commit();
        const done = store.getState().doc;
        lazy.sync(done, pageId, measurer, {from, ids: [...ids]});
        ids.clear();
        from = done;
        continue;
      }
      try {
        store.transact('edit', tx => {
          if (!pick) return;
          if (kind === 0) tx.update(pick, {x: state.nodes[pick].x + (next() - 0.5) * 300, y: state.nodes[pick].y + (next() - 0.5) * 300});
          else if (kind === 1) tx.update(pick, {width: Math.max(1, state.nodes[pick].width * (0.5 + next())), rotation: (next() - 0.5) * 40});
          else if (kind === 2) tx.remove(pick);
          else if (kind === 3) {
            const parent = containers[Math.floor(next() * containers.length)] ?? pageId;
            tx.create(createNode('RECTANGLE', {id: `new${++created}`, x: next() * 200, y: next() * 200, width: 20 + next() * 80, height: 20 + next() * 80}) as SceneNode, parent);
          } else if (kind === 4) {
            // A layer into another root, or a root into another root, or out to the page.
            const target = next() < 0.3 ? pageId : (roots[Math.floor(next() * roots.length)] ?? pageId);
            if (target !== pick && !onPage(state, pick).includes(target)) tx.move(pick, target, undefined, {keepWorld: true});
          } else tx.update(roots[Math.floor(next() * roots.length)] ?? pick, {x: (next() - 0.5) * 2000, y: (next() - 0.5) * 2000});
        });
      } catch {
        continue; // an edit the document refuses (a component's inside, a cycle): nothing changed
      }
      const doc = store.getState().doc;
      lazy.sync(doc, pageId, measurer, {from, ids: [...ids]});
      ids.clear();
      from = doc;
      // Ask about a few roots now and then, so later edits find some indexed and some not.
      if (step % 7 === 3) {
        const area = extent(lazy, (doc.nodes[pageId].children ?? []).slice(0, 3));
        lazy.query({x: area.x, y: area.y, width: area.width / 2, height: area.height / 2});
      }
      if (step % 10 === 9) {
        // A copy (so `complete` does not hide what the next edits would find unindexed).
        const probe = new SpatialIndex();
        probe.sync(doc, pageId, measurer);
        sameAsWhole(probe, doc, pageId, `${fixture.name} fresh, step ${step}`, random(step));
      }
    }
    off();
    sameAsWhole(lazy, store.getState().doc, pageId, `${fixture.name} after the edits`, random(99));
  }
});

test('a face that arrives re-measures the text of roots still waiting, as of indexed ones', () => {
  const doc = FIXTURES.find(f => f.name === 'template-site')?.build() ?? generatedPage(20_041);
  const pageId = doc.pages.find(id => (doc.nodes[id].children ?? []).length > 1) ?? doc.pages[0];
  let scale = 0.5;
  const fonts = {revision: 1, width: (text: string, font: {size: number}) => text.length * font.size * scale, metrics: (font: {size: number}) => ({ascent: font.size * 0.8, descent: font.size * 0.2})} as TextMeasurer & {revision: number};
  const lazy = new SpatialIndex();
  lazy.sync(doc, pageId, fonts);
  const roots = doc.nodes[pageId].children ?? [];
  // One root asked about, the rest waiting; then wider glyphs arrive.
  const first = lazy.bounds(roots[0]);
  if (first) lazy.query(first);
  scale = 0.9;
  fonts.revision = 2;
  const sync = lazy.sync({...doc}, pageId, fonts, {from: doc, ids: []});
  assert.ok(sync.dirty.length > 0, 'the text that grew is repainted');
  const whole = new SpatialIndex({eager: true});
  whole.sync(doc, pageId, fonts);
  for (const id of onPage(doc, pageId)) {
    const a = lazy.bounds(id), b = whole.bounds(id);
    if (!a || !b) assert.equal(a, b, `bounds of ${id}`);
    else for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `${id}.${key} ${a[key]} vs ${b[key]}`);
  }
  const area = extent(whole, onPage(doc, pageId));
  assert.deepEqual(sorted(lazy.query(area)), sorted(whole.query(area)));
});
