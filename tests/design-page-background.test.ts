import test from 'node:test';
import assert from 'node:assert/strict';
import {PAGE_BACKGROUND, PAGE_BACKGROUND_DARK, createDocument, createNode, defaultPageBackground, pageBackground} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {validateDocument} from '../shared/design/schema';
import type {TextMeasurer} from '../shared/design/text-layout';

// A page's canvas colour (shared/design/defaults.ts): a page that never had its own colour follows the editor's theme
// (#F5F5F5 light, #1E1E1E dark, as in Figma); a colour the designer picked stays in both themes, and files made before
// keep the colour they stored. The canvas, the version preview and component thumbnails pass the theme's default; file
// thumbnails and template cards use the light one.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const hex = ({r, g, b}: {r: number; g: number; b: number}) => [r, g, b].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

test('a new file and a new page store no background: the canvas follows the theme', () => {
  const doc = createDocument('page');
  assert.equal('backgroundColor' in doc.nodes.page, false);
  assert.equal('backgroundColor' in createNode('PAGE', {id: 'p2'}), false);
  assert.equal(hex(pageBackground(doc.nodes.page)), 'F5F5F5');
  assert.equal(hex(pageBackground(doc.nodes.page, defaultPageBackground('light'))), 'F5F5F5');
  assert.equal(hex(pageBackground(doc.nodes.page, defaultPageBackground('dark'))), '1E1E1E');
  assert.equal(hex(PAGE_BACKGROUND), 'F5F5F5');
  assert.equal(hex(PAGE_BACKGROUND_DARK), '1E1E1E');
  assert.ok(validateDocument(doc).ok, 'a page without a background is a valid document');
});

test('a colour of its own wins in both themes, including the old stored #F5F5F5', () => {
  const pink = {r: 1, g: 0.88, b: 0.88};
  const page = createNode('PAGE', {id: 'p', backgroundColor: pink});
  assert.equal(hex(pageBackground(page, defaultPageBackground('dark'))), 'FFE0E0');
  assert.equal(hex(pageBackground(page, defaultPageBackground('light'))), 'FFE0E0');
  // A file made before this change stored the light default: it stays light, as stored.
  const old = createNode('PAGE', {id: 'old', backgroundColor: {...PAGE_BACKGROUND}});
  assert.equal(hex(pageBackground(old, defaultPageBackground('dark'))), 'F5F5F5');
});

test('"Default color" removes the page colour in one undoable step', () => {
  const doc = createDocument('page');
  const set = beginTransaction(doc);
  set.update('page', {backgroundColor: {r: 1, g: 0.88, b: 0.88}});
  const coloured = set.commit({measurer}).doc;
  const reset = beginTransaction(coloured);
  reset.update('page', {backgroundColor: undefined});
  const {doc: back, inverse} = reset.commit({measurer});
  assert.equal('backgroundColor' in back.nodes.page, false);
  assert.equal(hex(pageBackground(back.nodes.page, defaultPageBackground('dark'))), '1E1E1E');
  assert.ok(validateDocument(back).ok);
  // The inverse patch brings the colour back (undo).
  assert.equal(hex(inverse.nodes?.page?.backgroundColor ?? PAGE_BACKGROUND_DARK), 'FFE0E0');
});
