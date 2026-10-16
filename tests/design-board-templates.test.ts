import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoardDocument} from '../shared/design/board/document';
import {installBoardSteps} from '../shared/design/board/install';
import {beginTransaction} from '../shared/design/transaction';
import {validateDocument} from '../shared/design/schema';
import {worldBox} from '../shared/design/geometry';
import {childPart} from '../shared/design/board/model';
import {BOARD_TEMPLATES, BOARD_TEMPLATE_GROUPS, boardTemplate, buildBoardTemplate, insertBoardTemplate, type BoardTemplateId} from '../shared/design/board/templates';
import type {DesignDocument, NodeId, PathCommand} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';

// "Board" (docs/board.md §Templates): the built-in templates land as ordinary board objects — valid documents, connectors
// routed between their objects, sections around their notes — at the point asked for.

installBoardSteps();
const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
let serial = 0;
const ids = () => 't' + ++serial;
const get = (doc: DesignDocument) => (id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined);

function placed(id: BoardTemplateId, at = {x: 1000, y: -400}) {
  const doc = createBoardDocument('page');
  const built = buildBoardTemplate(id, ids);
  const tx = beginTransaction(doc);
  const roots = insertBoardTemplate(tx, built, 'page', at);
  return {doc: tx.commit({measurer}).doc, roots, built};
}

test('the brief\'s ten templates, each in a group of the «+» sheet', () => {
  const names = BOARD_TEMPLATES.map(template => template.name);
  for (const name of ['Brainstorm', 'Retrospective', 'Kanban', 'Mind map', 'Flowchart', 'Meeting notes', 'Icebreaker', '5 whys', 'Crazy 8s', 'Customer journey map']) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(new Set(BOARD_TEMPLATES.map(template => template.id)).size, BOARD_TEMPLATES.length);
  for (const template of BOARD_TEMPLATES) {
    assert.ok(BOARD_TEMPLATE_GROUPS[template.group], template.id);
    assert.equal(boardTemplate(template.id), template);
  }
});

for (const template of BOARD_TEMPLATES) {
  test(`«${template.name}» lands as a valid board where it was asked, with its connectors routed`, () => {
    const at = {x: 1000, y: -400};
    const {doc, roots, built} = placed(template.id, at);
    const result = validateDocument(doc);
    assert.ok(result.ok, result.ok ? '' : `${result.error} at ${result.path}`);
    assert.ok(roots.length > 3, 'a template has a title and objects');
    // Every top-level object is on the page, and the template's top-left corner is the point.
    const page = doc.nodes.page;
    for (const id of roots) assert.equal(doc.nodes[id]?.parentId, 'page', id);
    const boxes = roots.filter(id => doc.nodes[id].board?.kind !== 'connector').map(id => worldBox(doc, id));
    assert.equal(Math.round(Math.min(...boxes.map(box => box.x))), at.x);
    assert.equal(Math.round(Math.min(...boxes.map(box => box.y))), at.y);
    assert.equal(page.children!.length, roots.length);
    assert.ok(built.bounds.width > 0 && built.bounds.height > 0);
    // Sections do not overlap one another, and each note inside one fits within it.
    const sections = roots.filter(id => doc.nodes[id].type === 'SECTION');
    for (let i = 0; i < sections.length; i++) for (let j = i + 1; j < sections.length; j++) {
      const a = worldBox(doc, sections[i]), b = worldBox(doc, sections[j]);
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!overlap, `${doc.nodes[sections[i]].name} and ${doc.nodes[sections[j]].name} overlap`);
    }
    for (const id of sections) {
      const section = doc.nodes[id];
      for (const childId of section.children ?? []) {
        const child = doc.nodes[childId];
        assert.ok(child.x >= 0 && child.y >= 0 && child.x + child.width <= section.width + 0.5 && child.y + child.height <= section.height + 0.5, `${child.name} sticks out of «${section.name}»`);
      }
    }
    // Connectors run from one object's edge to the other's.
    for (const id of roots.filter(rootId => doc.nodes[rootId].board?.kind === 'connector')) {
      const meta = doc.nodes[id].board!;
      assert.equal(meta.kind, 'connector');
      if (meta.kind !== 'connector') continue;
      const line = childPart(get(doc), doc.nodes[id], 'line')!;
      const points = line.vectorPaths![0].commands.filter((c): c is Extract<PathCommand, {x: number}> => c.type !== 'Z');
      const box = worldBox(doc, line.id);
      const first = {x: box.x + points[0].x, y: box.y + points[0].y}, last = {x: box.x + points.at(-1)!.x, y: box.y + points.at(-1)!.y};
      assert.ok(Math.hypot(last.x - first.x, last.y - first.y) > 20, 'a routed line has length');
      for (const [end, point] of [[meta.start, first], [meta.end, last]] as const) {
        assert.ok('node' in end, 'template connectors sit on objects');
        if (!('node' in end)) continue;
        const object = worldBox(doc, end.node);
        const onEdge = Math.abs(point.x - object.x) < 1 || Math.abs(point.x - (object.x + object.width)) < 1 || Math.abs(point.y - object.y) < 1 || Math.abs(point.y - (object.y + object.height)) < 1;
        assert.ok(onEdge, `${template.id}: an end sits on its object's side`);
      }
    }
  });
}

test('a template placed twice gets fresh ids and leaves the first alone', () => {
  const doc = createBoardDocument('page');
  let tx = beginTransaction(doc);
  const first = insertBoardTemplate(tx, buildBoardTemplate('kanban', ids), 'page', {x: 0, y: 0});
  const once = tx.commit({measurer}).doc;
  tx = beginTransaction(once);
  const second = insertBoardTemplate(tx, buildBoardTemplate('kanban', ids), 'page', {x: 4000, y: 0});
  const twice = tx.commit({measurer}).doc;
  assert.equal(new Set([...first, ...second]).size, first.length + second.length);
  for (const id of first) assert.deepEqual(twice.nodes[id], once.nodes[id]);
});
