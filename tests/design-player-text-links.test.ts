import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {linkAt, linkSpotsOf} from '../src/design/prototype/player/text-links';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function screen() {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'f', width: 400, height: 300}), 'page');
  const text = createNode('TEXT', {id: 't', x: 10, y: 20, width: 300, height: 20});
  text.text = {...text.text!, characters: 'Open my site', textAutoResize: 'NONE', runs: [{start: 8, end: 12, style: {hyperlink: {type: 'URL', url: 'https://example.com/'}}}]};
  tx.create(text, 'f');
  tx.create(createNode('TEXT', {id: 'plain', x: 10, y: 100, width: 300, height: 20}), 'f');
  return tx.commit({measurer}).doc;
}

test('a click on linked words in the player finds their address; the words beside them and the empty box find none', () => {
  const doc = screen();
  const spots = linkSpotsOf(doc, 'f', {}, {width: 400, height: 300});
  assert.deepEqual(spots.map(spot => spot.id), ['t'], 'only texts with a link are looked at');
  const size = doc.nodes.t.text!.style.fontSize;
  const char = size * 0.5;
  const at = (index: number) => ({x: 10 + (index + 0.5) * char, y: 20 + size / 2});
  assert.deepEqual(linkAt(doc, spots, at(9), measurer)?.hyperlink, {type: 'URL', url: 'https://example.com/'});
  assert.equal(linkAt(doc, spots, at(2), measurer), null, '"Open" has no link');
  assert.equal(linkAt(doc, spots, {x: 10 + 14 * char + 20, y: 20 + size / 2}, measurer), null, 'past the end of the line');
});

test('a link scrolled out of a clipping frame or hidden is not clickable', () => {
  const doc = screen();
  assert.equal(linkSpotsOf(doc, 'f', {f: {x: 0, y: 400}}, {width: 400, height: 300}).length, 0);
  const hidden = {...doc, nodes: {...doc.nodes, t: {...doc.nodes.t, visible: false}}};
  assert.equal(linkSpotsOf(hidden, 'f', {}, {width: 400, height: 300}).length, 0);
});
