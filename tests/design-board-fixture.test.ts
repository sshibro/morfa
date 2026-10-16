import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installBoardSteps} from '../shared/design/board/install';
import {validateDocument} from '../shared/design/schema';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument} from '../shared/design/types';
import {createDesignStore} from '../src/design/engine/store';
import {buildFixtureBoard, fixtureMeasurer} from './helpers/board-fixture';

// A board made before the board's later fields: every object kind and two templates, saved as JSON. It must stay valid,
// open with every node exactly as saved, and the factories must still make it the same way.

installBoardSteps();
const saved = JSON.parse(readFileSync(new URL('./fixtures/board-before-fj.json', import.meta.url), 'utf8')) as DesignDocument;

test('should validate when a board saved before lane FJ is read back', () => {
  assert.equal(validateDocument(saved).ok, true);
  assert.equal(saved.board, true);
});

test('should keep every node as saved when the board opens and normalizes again', () => {
  const store = createDesignStore({doc: structuredClone(saved), measurer: fixtureMeasurer});
  const recommitted = beginTransaction(store.getState().doc).commit({measurer: fixtureMeasurer}).doc;
  assert.deepEqual(recommitted.nodes, saved.nodes);
});

/** What the factories changed on purpose since the fixture was saved, taken off before comparing: a board section's border
 *  (FigJam's board picture, lane FJ's sections slice). Old sections keep opening without one (the test above). */
function withoutSectionBorders(doc: DesignDocument): DesignDocument {
  const nodes = Object.fromEntries(Object.entries(doc.nodes).map(([id, node]) => {
    if (node.type !== 'SECTION') return [id, node];
    const {strokes: _strokes, strokeWeight: _weight, strokeAlign: _align, ...rest} = node;
    return [id, rest];
  }));
  return {...doc, nodes} as DesignDocument;
}

test('should build the same board when the factories make it today, but for the sections\' new border', () => {
  assert.deepEqual(withoutSectionBorders(JSON.parse(JSON.stringify(buildFixtureBoard()))), withoutSectionBorders(saved));
});
