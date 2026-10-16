import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {Reaction} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {matchingInteractions, sameInteractions} from '../src/design/prototype/matching';

// "Select matching interactions" (help.figma.com «Connect your prototype»): layers at the same place (names down from their
// top-level frame) in the page's other frames, with the same interaction.

const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};
const go = (to: string): Reaction => ({trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: to, transition: {type: 'INSTANT'}}]} as Reaction);

function doc() {
  const tx = beginTransaction(createDocument('page'));
  for (const [screen, button, target] of [['s1', 'b1', 'done'], ['s2', 'b2', 'done'], ['s3', 'b3', 's1']] as const) {
    tx.create(createNode('FRAME', {id: screen, name: 'Screen ' + screen}), 'page');
    tx.create(createNode('FRAME', {id: screen + 'bar', name: 'Bar'}), screen);
    tx.create(createNode('RECTANGLE', {id: button, name: 'Next', reactions: [go(target)]}), screen + 'bar');
  }
  tx.create(createNode('RECTANGLE', {id: 'loose', name: 'Next', reactions: [go('done')]}), 's1');
  tx.create(createNode('FRAME', {id: 'done', name: 'Done'}), 'page');
  return tx.commit({measurer}).doc;
}

test('should find the same interaction at the same place in the other screens', () => {
  assert.deepEqual(matchingInteractions(doc(), 'b1', 0), ['b1', 'b2'], 'b3 goes elsewhere; «loose» sits elsewhere in its screen');
});

test('should tell when several layers share their interactions', () => {
  const d = doc();
  assert.equal(sameInteractions([d.nodes.b1, d.nodes.b2]), true);
  assert.equal(sameInteractions([d.nodes.b1, d.nodes.b3]), false);
});
