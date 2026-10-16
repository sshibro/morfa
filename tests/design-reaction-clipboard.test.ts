import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {Reaction} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {adaptReactions, parseReactions, reactionsText} from '../src/design/prototype/reaction-clipboard';

// Copying an interaction to other layers (help.figma.com "Connect your prototype"): the clipboard text round-trips; on paste,
// actions to layers this file lacks (or to the layer itself) drop, and an interaction left without actions drops.

const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};
const go = (to: string) => ({type: 'NODE', navigation: 'NAVIGATE', destinationId: to, transition: {type: 'INSTANT'}}) as Reaction['actions'][number];

test('should round-trip interactions through the clipboard text, and ignore other text', () => {
  const reactions: Reaction[] = [{trigger: {type: 'ON_CLICK'}, actions: [go('a')]} as Reaction];
  assert.deepEqual(parseReactions(reactionsText(reactions)), reactions);
  assert.equal(parseReactions('Hello'), null);
  assert.equal(parseReactions('morfa-interactions:{oops'), null);
});

test('should drop actions to missing layers or to the layer itself', () => {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'a'}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'r'}), 'page');
  const doc = tx.commit({measurer}).doc;
  const reactions = [
    {trigger: {type: 'ON_CLICK'}, actions: [go('a'), go('gone'), {type: 'BACK'}]},
    {trigger: {type: 'ON_HOVER'}, actions: [go('r')]},
  ] as Reaction[];
  assert.deepEqual(adaptReactions(doc, 'r', reactions), [{trigger: {type: 'ON_CLICK'}, actions: [go('a'), {type: 'BACK'}]}]);
});
