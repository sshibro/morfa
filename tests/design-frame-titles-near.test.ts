import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DesignDocument, NodeId, Vec} from '../shared/design/types';
import {frameTitleAt, titleBoxes} from '../src/design/engine/frame-titles';
import type {Viewport} from '../src/design/engine/contracts';
import {FIXTURES} from '../scripts/goldens/fixtures';

// The hover's quick look (lane K): `frameTitleAt` builds boxes only for the titles whose edge is within a box's reach of
// the point. It must answer exactly as a scan of every title's box does, at any zoom, turn and point.

function everyBox(doc: DesignDocument, pageId: NodeId, screen: Vec, viewport: Viewport): NodeId | null {
  const boxes = titleBoxes(doc, pageId, viewport);
  for (let k = boxes.length - 1; k >= 0; k--) {
    const box = boxes[k];
    const dx = screen.x - box.origin.x, dy = screen.y - box.origin.y;
    const u = dx * box.along.x + dy * box.along.y, v = dx * box.down.x + dy * box.down.y;
    if (u >= 0 && u <= box.width && v >= box.top && v <= box.bottom) return box.id;
  }
  return null;
}

/** A deterministic sequence in [0, 1). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('the hover finds the same title as a scan of every title, on the fixtures, at any zoom, turned or not', () => {
  let probes = 0, hits = 0;
  for (const fixture of FIXTURES.filter(f => f.name.startsWith('template-') || f.name === 'effects')) {
    const built = fixture.build();
    // The same page with every top-level frame turned a little, so titles run at an angle too.
    const turned: DesignDocument = {...built, nodes: {...built.nodes}};
    for (const pageId of built.pages) for (const id of built.nodes[pageId].children ?? []) turned.nodes[id] = {...turned.nodes[id], rotation: ((id.length * 7) % 30) - 15};
    for (const doc of [built, turned]) for (const pageId of doc.pages) {
      const next = random(probes + 1);
      const tops = (doc.nodes[pageId].children ?? []).map(id => doc.nodes[id]);
      for (let k = 0; k < 300; k++) {
        const zoom = [0.05, 0.13, 0.25, 0.5, 1, 2, 4][k % 7];
        const frame = tops[k % Math.max(1, tops.length)];
        // Points around the frames' top edges, where titles are, and anywhere.
        const anchor = frame ? {x: frame.x + next() * frame.width, y: frame.y + (next() - 0.7) * 60 / zoom} : {x: 0, y: 0};
        const viewport = {x: anchor.x - 300 / zoom, y: anchor.y - 200 / zoom, zoom};
        const screen = k % 5 === 0 ? {x: next() * 1440, y: next() * 900} : {x: 300 + (next() - 0.5) * 30, y: 200 + (next() - 0.5) * 30};
        const quick = frameTitleAt(doc, pageId, screen, viewport), full = everyBox(doc, pageId, screen, viewport);
        assert.equal(quick, full, `${fixture.name}/${pageId} zoom ${zoom} at ${JSON.stringify(screen)}`);
        probes++;
        if (full) hits++;
      }
    }
  }
  assert.ok(hits > 100, `${hits} of ${probes} probes found a title`);
});
