import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BLACK, createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {layoutText, type TextMeasurer} from '../shared/design/text-layout';
import type {DesignDocument, NodeId, NodeType, Paint, SceneNode, TextProps} from '../shared/design/types';
import {
  actionForKey, beginComposition, caretAt, cleanPlainText, composeText, deleteAt, extendByUnit, insertAt, LINE_SEPARATOR, moveSelection, nextBurst,
  paragraphSelection, selectionAfterChange, wordSelection, type Burst, type EditorKey, type TextSelection,
} from '../src/design/engine/text-editor/model';
import {copyRange, parseClip, pasteClip, pastePlain, serializeClip} from '../src/design/engine/text-editor/clipboard';
import {
  boldChange, caseChange, letterSpacingStep, lineHeightStep, linkRange, listRange, normalizeLink, restyleRange, setTextProps, sizeStep, SPACING_STEP, styledPieces, weightStep,
} from '../src/design/engine/text-editor/style-ops';

// The text editor's pure parts (src/design/engine/text-editor): keys → actions, caret moves and
// selections over a real layout, edits with runs, IME drafts, undo bursts, the rich clipboard and
// the formatting patches the commands and the panel write.

const measurer: TextMeasurer = {width: (text, font) => [...text].length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const RED: Paint = solid({r: 1, g: 0, b: 0});
const FILLS: Paint[] = [solid(BLACK)];

const props = (characters: string, extra: Partial<TextProps> = {}): TextProps => ({...defaultTextProps(characters), ...extra});
const textNode = (characters: string, extra: Partial<TextProps> = {}, node: Partial<SceneNode> = {}): SceneNode =>
  createNode('TEXT', {id: 't', parentId: 'p', width: 100, height: 20, fills: FILLS, text: props(characters, extra), ...node});
const layoutOf = (text: TextProps, width: number | null = null) => layoutText({width: width ?? 0, height: 0, fills: FILLS, text: {...text, textAutoResize: width === null ? 'WIDTH_AND_HEIGHT' : 'HEIGHT'}}, measurer, width);
const key = (code: string, mods: Partial<EditorKey> = {}, keyName = code): EditorKey => ({key: keyName, code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods});
const sel = (anchor: number, focus = anchor): TextSelection => ({anchor, focus, affinity: 'downstream'});

test('keys map to editor actions with each platform’s conventions', () => {
  assert.deepEqual(actionForKey(key('ArrowLeft'), true), {type: 'move', to: 'left', extend: false});
  assert.deepEqual(actionForKey(key('ArrowRight', {shiftKey: true}), true), {type: 'move', to: 'right', extend: true});
  assert.deepEqual(actionForKey(key('ArrowLeft', {altKey: true}), true), {type: 'move', to: 'wordLeft', extend: false});
  assert.deepEqual(actionForKey(key('ArrowLeft', {ctrlKey: true}), false), {type: 'move', to: 'wordLeft', extend: false});
  assert.deepEqual(actionForKey(key('ArrowRight', {metaKey: true, shiftKey: true}), true), {type: 'move', to: 'lineEnd', extend: true});
  assert.deepEqual(actionForKey(key('ArrowUp', {metaKey: true}), true), {type: 'move', to: 'docStart', extend: false});
  assert.deepEqual(actionForKey(key('ArrowDown', {altKey: true}), true), {type: 'move', to: 'paragraphEnd', extend: false});
  assert.deepEqual(actionForKey(key('Home'), false), {type: 'move', to: 'lineStart', extend: false});
  assert.deepEqual(actionForKey(key('End', {ctrlKey: true, shiftKey: true}), false), {type: 'move', to: 'docEnd', extend: true});
  assert.deepEqual(actionForKey(key('KeyE', {ctrlKey: true}), true), {type: 'move', to: 'paragraphEnd', extend: false});
  assert.deepEqual(actionForKey(key('Backspace'), true), {type: 'delete', direction: 'backward', unit: 'char'});
  assert.deepEqual(actionForKey(key('Backspace', {altKey: true}), true), {type: 'delete', direction: 'backward', unit: 'word'});
  assert.deepEqual(actionForKey(key('Backspace', {ctrlKey: true}), false), {type: 'delete', direction: 'backward', unit: 'word'});
  assert.deepEqual(actionForKey(key('Backspace', {metaKey: true}), true), {type: 'delete', direction: 'backward', unit: 'line'});
  assert.deepEqual(actionForKey(key('Delete', {altKey: true}), true), {type: 'delete', direction: 'forward', unit: 'word'});
  assert.deepEqual(actionForKey(key('Enter'), true), {type: 'insert', text: '\n'});
  assert.deepEqual(actionForKey(key('Enter', {shiftKey: true}), true), {type: 'insert', text: LINE_SEPARATOR});
  assert.deepEqual(actionForKey(key('Tab'), true), {type: 'insert', text: '\t'});
  assert.deepEqual(actionForKey(key('KeyA', {metaKey: true}), true), {type: 'selectAll'});
  assert.deepEqual(actionForKey(key('KeyA', {ctrlKey: true}), false), {type: 'selectAll'});
  assert.deepEqual(actionForKey(key('KeyZ', {metaKey: true}), true), {type: 'undo'});
  assert.deepEqual(actionForKey(key('KeyZ', {metaKey: true, shiftKey: true}), true), {type: 'redo'});
  assert.deepEqual(actionForKey(key('KeyY', {ctrlKey: true}), false), {type: 'redo'});
  assert.deepEqual(actionForKey(key('Escape'), true), {type: 'exit'});
  // Formatting and letters are not the editor's: they go on to the commands and to the input.
  assert.equal(actionForKey(key('KeyB', {metaKey: true}), true), null);
  // 'а' is the letter the F key types on the Russian ЙЦУКЕН layout (kept on purpose: key layout mapping).
  assert.equal(actionForKey(key('KeyF', {}, 'а'), true), null);
  assert.deepEqual(actionForKey(key('KeyA', {ctrlKey: true}), true), {type: 'move', to: 'paragraphStart', extend: false}, 'Ctrl+A on a Mac is the line start');
});

test('caret moves over graphemes, words, lines and paragraphs; a selection collapses to its edge', () => {
  const text = props('Orange fox\nsecond block');
  const layout = layoutOf(text);
  const chars = text.characters;
  assert.equal(moveSelection(chars, layout, sel(3), 'right', false).focus, 4);
  assert.deepEqual(moveSelection(chars, layout, sel(2, 6), 'left', false), caretAt(2));
  assert.deepEqual(moveSelection(chars, layout, sel(2, 6), 'right', false), caretAt(6));
  assert.equal(moveSelection(chars, layout, sel(0), 'wordRight', false).focus, 6);
  assert.equal(moveSelection(chars, layout, sel(10), 'wordLeft', false).focus, 7);
  const extended = moveSelection(chars, layout, sel(0), 'wordRight', true);
  assert.deepEqual([extended.anchor, extended.focus], [0, 6]);
  assert.equal(moveSelection(chars, layout, sel(3), 'down', false).focus, 14, 'the column is kept on the next line');
  assert.equal(moveSelection(chars, layout, sel(14), 'up', false).focus, 3);
  assert.equal(moveSelection(chars, layout, sel(13), 'lineEnd', false).focus, chars.length);
  assert.equal(moveSelection(chars, layout, sel(13), 'paragraphStart', false).focus, 11);
  assert.equal(moveSelection(chars, layout, sel(11), 'paragraphStart', false).focus, 0, 'again at the edge: the paragraph above');
  assert.equal(moveSelection(chars, layout, sel(5), 'docEnd', false).focus, chars.length);
  // An emoji with a modifier is one step.
  const emoji = props('a👍🏽b');
  assert.equal(moveSelection(emoji.characters, layoutOf(emoji), sel(1), 'right', false).focus, 5);
});

test('double and triple clicks select a word and a paragraph; a drag grows by those units', () => {
  const chars = 'four two six\neleven';
  assert.deepEqual(wordSelection(chars, 6), sel(5, 8));
  assert.deepEqual(paragraphSelection(chars, 3), sel(0, 13));
  const grown = extendByUnit(chars, wordSelection(chars, 6), 10, 'word');
  assert.deepEqual([grown.anchor, grown.focus], [5, 12]);
  const back = extendByUnit(chars, wordSelection(chars, 6), 1, 'word');
  assert.deepEqual([back.anchor, back.focus], [8, 0]);
});

test('typing keeps runs, takes a pending caret style, ends lists on an empty item and respects the limit', () => {
  const bold = props('bolder style', {runs: [{start: 0, end: 6, style: {fontWeight: 700}}]});
  const inside = insertAt(bold, sel(3), 'XX')!;
  assert.equal(inside.text.characters, 'bolXXder style');
  assert.deepEqual(inside.text.runs, [{start: 0, end: 8, style: {fontWeight: 700}}]);
  assert.deepEqual(inside.selection, caretAt(5));
  assert.equal(inside.kind, 'type');

  const pending = insertAt(props('ab'), sel(1), 'X', {style: {italic: true}})!;
  assert.deepEqual(pending.text.runs, [{start: 1, end: 2, style: {italic: true}}]);

  const replaced = insertAt(props('orange fox'), sel(0, 6), 'bye')!;
  assert.equal(replaced.text.characters, 'bye fox');

  const list = props('point\n', {listTypes: ['UNORDERED', 'UNORDERED']});
  const ended = insertAt(list, sel(6), '\n')!;
  assert.equal(ended.text.characters, 'point\n', 'Enter in an empty item takes the marker off instead');
  assert.deepEqual(ended.text.listTypes, ['UNORDERED']);
  const more = insertAt(props('point', {listTypes: ['ORDERED']}), sel(5), '\n')!;
  assert.deepEqual(more.text.listTypes, ['ORDERED', 'ORDERED']);

  const huge = props('x'.repeat(100_000));
  assert.equal(insertAt(huge, sel(5), 'y'), null);
});

test('deleting removes graphemes, words, lines and the selection; Backspace at an item start drops its marker', () => {
  const text = props('Orange fox');
  const layout = layoutOf(text);
  assert.equal(deleteAt(text, layout, sel(6), 'backward', 'char')!.text.characters, 'Orang fox');
  assert.equal(deleteAt(text, layout, sel(6), 'forward', 'char')!.text.characters, 'Orangefox');
  assert.equal(deleteAt(text, layout, sel(10), 'backward', 'word')!.text.characters, 'Orange ');
  assert.equal(deleteAt(text, layout, sel(0), 'forward', 'word')!.text.characters, ' fox');
  assert.equal(deleteAt(text, layout, sel(8), 'backward', 'line')!.text.characters, 'ox');
  assert.equal(deleteAt(text, layout, sel(2, 8), 'forward', 'word')!.text.characters, 'Orox', 'a selection goes whatever the unit');
  assert.equal(deleteAt(text, layout, sel(0), 'backward', 'char'), null);
  const emoji = props('a👍🏽b');
  assert.equal(deleteAt(emoji, layoutOf(emoji), sel(5), 'backward', 'char')!.text.characters, 'ab');
  const list = props('one\ntwo', {listTypes: ['UNORDERED', 'UNORDERED']});
  const unmarked = deleteAt(list, layoutOf(list), sel(4), 'backward', 'char')!;
  assert.equal(unmarked.text.characters, 'one\ntwo');
  assert.deepEqual(unmarked.text.listTypes, ['UNORDERED']);
  assert.equal(unmarked.kind, 'other');
});

test('an IME composition replaces the selection, shows its draft and commits the final characters', () => {
  const text = props('mellow dawn', {runs: [{start: 7, end: 11, style: {fontWeight: 700}}]});
  const begun = beginComposition(text, sel(7, 11));
  assert.equal(begun.text.characters, 'mellow ');
  const draft = composeText(begun.composition, 'ev', undefined);
  assert.equal(draft.text.characters, 'mellow ev');
  assert.deepEqual(draft.range, {start: 7, end: 9});
  assert.deepEqual(draft.selection, caretAt(9));
  const final = composeText(begun.composition, 'evening', undefined);
  assert.equal(final.text.characters, 'mellow evening');
  // An empty draft (the composition was cancelled) leaves the base as it was.
  assert.equal(composeText(begun.composition, '').text, begun.text);
});

test('typing bursts become undo steps at word boundaries and when the kind of edit changes', () => {
  const serials: number[] = [];
  let burst: Burst | null = null;
  for (const ch of 'Orange fox') {
    burst = nextBurst(burst, 'type', ch);
    serials.push(burst.serial);
  }
  assert.deepEqual(serials, [1, 1, 1, 1, 1, 1, 1, 2, 2, 2], '"Orange " then "fox"');
  const deleting = nextBurst(burst, 'delete');
  assert.equal(deleting.serial, 3);
  assert.equal(nextBurst(deleting, 'delete').serial, 3);
  assert.equal(nextBurst(nextBurst(deleting, 'delete'), 'type', 'a').serial, 4);
  assert.equal(nextBurst(null, 'type', 'a', 9).serial, 10, 'a moved caret starts a new step');
  assert.equal(nextBurst(burst, 'other').serial, 3);
});

test('after undo or redo the caret goes to the end of what changed', () => {
  assert.deepEqual(selectionAfterChange('Orange fox', 'Orange ', sel(10)), caretAt(7));
  assert.deepEqual(selectionAfterChange('Orange ', 'Orange fox', sel(7)), caretAt(10));
  assert.deepEqual(selectionAfterChange('abc', 'abc', sel(9)), caretAt(3));
});

test('a rich copy pastes back with its styles and colours; plain text takes the caret style', () => {
  const source = props('Bolder & crimson', {runs: [{start: 0, end: 6, style: {fontWeight: 700}}, {start: 9, end: 16, style: {}, fills: [RED]}]});
  const copied = copyRange(source, FILLS, 0, 16)!;
  assert.equal(copied.plain, 'Bolder & crimson');
  const clip = parseClip(serializeClip(copied.rich), copied.plain)!;
  assert.ok(clip);
  const target = props('[]', {style: {...props('').style, fontSize: 24}});
  const pasted = pasteClip(target, FILLS, 1, 1, clip)!;
  assert.equal(pasted.text.characters, '[Bolder & crimson]');
  assert.equal(pasted.caret, 17);
  const pieces = styledPieces(pasted.text, 0, pasted.text.characters.length);
  const at = (offset: number) => pieces.find(piece => piece.start <= offset && offset < piece.end)!;
  assert.equal(at(1).style.fontWeight, 700);
  assert.equal(at(1).style.fontSize, 16, 'pasted characters keep their own size');
  assert.equal(at(0).style.fontSize, 24);
  assert.deepEqual(at(12).run?.fills, [RED]);
  assert.equal(at(17).style.fontSize, 24);

  const plain = pastePlain(props('ab', {runs: [{start: 0, end: 1, style: {italic: true}}]}), 1, 1, 'X\r\nY')!;
  assert.equal(plain.text.characters, 'aX\nYb');
  assert.deepEqual(plain.text.runs, [{start: 0, end: 4, style: {italic: true}}]);

  // Into an empty text the copy's look becomes the text's own.
  const fresh = pasteClip(props(''), FILLS, 0, 0, parseClip(serializeClip(copyRange(source, FILLS, 9, 16)!.rich), 'crimson')!)!;
  assert.deepEqual(fresh.fills, [RED]);
  assert.deepEqual(fresh.text.runs, []);
});

test('a clip from outside is read field by field and refused when it does not match', () => {
  const good = {v: 1, characters: 'ab', pieces: [{start: 0, end: 2, style: {...props('').style, hyperlink: {type: 'URL', url: 'javascript:alert(1)'}}, fills: [{type: 'IMAGE', imageRef: 'x'}, RED]}]};
  const clip = parseClip(JSON.stringify(good), 'ab')!;
  assert.equal(clip.pieces[0].style.hyperlink, undefined, 'a script link is dropped');
  assert.equal(clip.pieces[0].fills.length, 1, 'only solid colours travel');
  assert.equal(parseClip(JSON.stringify(good), 'other'), null, 'the plain text beside it must match');
  assert.equal(parseClip(JSON.stringify({...good, pieces: [{...good.pieces[0], end: 1}]}), 'ab'), null, 'pieces must cover the text');
  assert.equal(parseClip('{"v":1,"characters":"ab","pieces":"x"}', 'ab'), null);
  assert.equal(parseClip('not json', 'ab'), null);
  const sized = parseClip(JSON.stringify({...good, pieces: [{...good.pieces[0], style: {...good.pieces[0].style, fontSize: 1e12, fontWeight: -5}}]}), 'ab')!;
  assert.equal(sized.pieces[0].style.fontSize, 100_000);
  assert.equal(sized.pieces[0].style.fontWeight, 1);
  assert.equal(cleanPlainText('a\u0000b\r\nc\td'), 'ab\nc\td');
});

test('formatting a range writes runs; the whole text changes the base and detaches its text style', () => {
  const node = textNode('four two', {runs: [{start: 0, end: 4, style: {fontSize: 20}, textStyleId: 'S'}]}, {textStyleId: 'S'});
  const ranged = restyleRange(node, 0, 2, {fontWeight: 700})!;
  assert.equal(ranged.textStyleId, undefined);
  assert.ok(!('textStyleId' in ranged), 'a range keeps the layer’s style');
  assert.deepEqual(ranged.text!.runs.map(run => [run.start, run.end, run.textStyleId ?? null]), [[0, 2, null], [2, 4, 'S']]);
  const whole = restyleRange(node, 0, 8, {fontFamily: 'Roboto'})!;
  assert.ok('textStyleId' in whole && whole.textStyleId === undefined, 'the layer leaves its style');
  assert.equal(whole.text!.style.fontFamily, 'Roboto');
  assert.ok(whole.text!.runs.every(run => !run.textStyleId));
  // A link is not part of a text style.
  assert.ok(!('textStyleId' in restyleRange(node, 0, 8, {hyperlink: {type: 'URL', url: 'https://foo.test/'}})!));
  // Relative steps per piece.
  const stepped = restyleRange(node, 0, 8, sizeStep(1))!;
  const pieces = styledPieces(stepped.text!, 0, 8);
  assert.deepEqual(pieces.map(piece => piece.style.fontSize), [21, 17]);
  assert.equal(restyleRange(node, 3, 3, {italic: true}), null, 'a caret changes nothing in the text');
});

test('⌥⌘> and ⌥⌘< step to the next face the family has', () => {
  const faces = (family: string) => (family === 'Prata' ? [400] : family === 'Golos' ? [400, 500, 600, 700, 800, 900] : null);
  const at = (family: string, fontWeight: number) => ({...defaultTextProps('').style, fontFamily: family, fontWeight});
  const step = (change: ReturnType<typeof weightStep>, family: string, weight: number) => (typeof change === 'function' ? change(at(family, weight)) : change);
  assert.deepEqual(step(weightStep(1, faces), 'Golos', 400), {fontWeight: 500});
  assert.deepEqual(step(weightStep(-1, faces), 'Golos', 400), null, 'nothing lighter than its lightest face');
  assert.deepEqual(step(weightStep(1, faces), 'Prata', 400), null, 'one face: nothing to step to');
  assert.deepEqual(step(weightStep(-1, faces), 'Unknown', 700), {fontWeight: 600}, 'unknown families step by 100');
  assert.deepEqual(step(weightStep(1, faces), 'Unknown', 900), null);
});

test('⌥> ⌥< step letter spacing and ⌥⇧> ⌥⇧< line height by one step in their unit', () => {
  const base = defaultTextProps('').style;
  const run = (change: ReturnType<typeof letterSpacingStep>, style: typeof base) => (typeof change === 'function' ? change(style) : change);
  assert.deepEqual(run(letterSpacingStep(SPACING_STEP), base), {letterSpacing: {unit: base.letterSpacing?.unit ?? 'PERCENT', value: (base.letterSpacing?.value ?? 0) + 1}});
  assert.deepEqual(run(letterSpacingStep(-1), {...base, letterSpacing: {unit: 'PIXELS', value: 0.3}}), {letterSpacing: {unit: 'PIXELS', value: -0.7}}, 'px stay px, no float dust');
  assert.deepEqual(run(lineHeightStep(1, () => 19.36), {...base, lineHeight: {unit: 'AUTO'}}), {lineHeight: {unit: 'PIXELS', value: 20.36}}, '"Auto" steps from the height it stands for');
  assert.deepEqual(run(lineHeightStep(-1, () => 0), {...base, lineHeight: {unit: 'PERCENT', value: 120}}), {lineHeight: {unit: 'PERCENT', value: 119}});
  assert.deepEqual(run(lineHeightStep(-1, () => 0), {...base, lineHeight: {unit: 'PIXELS', value: 0}}), null, 'never below zero');
});

test('the spacing keys reach the text commands while typing, on the Russian layout too', async () => {
  const {createDesignStore} = await import('../src/design/engine/store');
  const {TextEditSession} = await import('../src/design/engine/text-editor/session');
  const {registerTextCommands} = await import('../src/design/engine/commands/text');
  registerTextCommands();
  let doc = createDocument('p');
  doc = add(doc, 'TEXT', {id: 't', parentId: 'p', width: 0, height: 20, text: defaultTextProps('Orange fox'), fills: FILLS, name: 'Text'});
  const store = createDesignStore({doc, measurer});
  store.setSelection(['t']);
  store.setEditing({kind: 'text', id: 't'});
  const session = new TextEditSession(store, 't', {fonts: {} as never, images: {} as never}, {select: {offset: 0}});
  session.perform({type: 'selectAll'});
  const before = store.getState().doc.nodes.t.text!.style;
  // The 'ю' and 'Б' keys below stay Cyrillic on purpose: the Russian layout types them on the same physical keys.
  // ⌥> on Ю (the key is the same, whatever it types): a character is not inserted, the spacing grows.
  assert.equal(session.handleKey(key('Period', {altKey: true}, 'ю')), true);
  let style = store.getState().doc.nodes.t.text!.style;
  assert.equal(store.getState().doc.nodes.t.text!.characters, 'Orange fox');
  assert.deepEqual(style.letterSpacing, {unit: before.letterSpacing?.unit ?? 'PERCENT', value: (before.letterSpacing?.value ?? 0) + 1});
  assert.equal(session.handleKey(key('Comma', {altKey: true, shiftKey: true}, 'Б')), true);
  style = store.getState().doc.nodes.t.text!.style;
  // The test measurer's ascent and descent add up to the font size: "Auto" is that many px.
  assert.equal(before.lineHeight.unit, 'AUTO');
  assert.deepEqual(style.lineHeight, {unit: 'PIXELS', value: before.fontSize - 1});
  // Any other ⌥ key still types (a Mac's accents).
  assert.equal(session.handleKey(key('KeyE', {altKey: true}, '´')), false);
  session.end('commit');
});

test('toggles look at every piece: bold unless all of it is, then back to regular', () => {
  const weights = (family: string) => (family === 'Inter' ? [100, 200, 300, 400, 500, 600, 700, 800, 900] : family === 'Prata' ? [400] : null);
  const mixed = [{...props('').style, fontWeight: 700}, {...props('').style, fontWeight: 400}];
  const make = boldChange(mixed, weights) as (style: typeof mixed[number]) => {fontWeight: number} | null;
  assert.deepEqual(make(mixed[1]), {fontWeight: 700});
  assert.equal(make(mixed[0]), null);
  const unbold = boldChange([mixed[0]], weights) as (style: typeof mixed[number]) => {fontWeight: number} | null;
  assert.deepEqual(unbold(mixed[0]), {fontWeight: 400});
  const prata = {...props('').style, fontFamily: 'Prata'};
  assert.equal((boldChange([prata], weights) as (s: typeof prata) => unknown)(prata), null, 'a family with one face stays as it is');
  assert.deepEqual(caseChange([{...props('').style, textCase: 'UPPER'}], 'UPPER'), {textCase: 'ORIGINAL'});
});

test('lists toggle per paragraph, links follow the caret, auto-resize keeps sizing in step', () => {
  const node = textNode('one\ntwo\nsix');
  const listed = listRange(node, 0, 5, 'UNORDERED', true)!;
  assert.deepEqual(listed.text!.listTypes, ['UNORDERED', 'UNORDERED']);
  const back = listRange({...node, text: listed.text!}, 0, 5, 'UNORDERED', true)!;
  assert.equal(back.text!.listTypes, undefined);
  assert.equal(listRange(node, 0, 0, 'NONE', true), null);

  const linked = textNode('explore site', {runs: [{start: 8, end: 12, style: {hyperlink: {type: 'URL', url: 'https://a.ru/'}}}]});
  const relinked = linkRange(linked, 10, 10, {type: 'URL', url: 'https://b.ru/'})!;
  assert.deepEqual(relinked.text!.runs, [{start: 8, end: 12, style: {hyperlink: {type: 'URL', url: 'https://b.ru/'}}}]);
  assert.equal(linkRange(linked, 2, 2, null), null);
  assert.equal(normalizeLink('foo.test'), 'https://foo.test/');
  // A Cyrillic domain and path are kept on purpose: they must be punycode- and percent-encoded.
  assert.equal(normalizeLink('http://пример.рф/путь'), 'http://xn--e1afmkfd.xn--p1ai/%D0%BF%D1%83%D1%82%D1%8C');
  assert.equal(normalizeLink('javascript:alert(1)'), null);
  assert.equal(normalizeLink('mailto:a@b.ru'), null);
  assert.equal(normalizeLink('   '), null);

  const doc = createDocument('p');
  const filled = textNode('x', {textAutoResize: 'HEIGHT'}, {layoutSizingHorizontal: 'FILL'});
  const patch = setTextProps(doc, filled, {textAutoResize: 'WIDTH_AND_HEIGHT'})!;
  assert.equal(patch.text!.textAutoResize, 'WIDTH_AND_HEIGHT');
  assert.equal(patch.layoutSizingHorizontal, 'HUG');
  assert.equal(setTextProps(doc, filled, {textAutoResize: 'HEIGHT'}), null);
  const truncated = setTextProps(doc, filled, {textAutoResize: 'TRUNCATE', maxLines: 2})!;
  assert.equal(truncated.text!.maxLines, 2);
  assert.equal(truncated.layoutSizingVertical, 'FIXED');
});

// ── The store side: bound text routing ─────────────────────────────────────────────────────────

function add(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}

test('typing into a text a component property drives sets the property on its instance', async () => {
  const {addComponentProperty, bindProperty, createInstance} = await import('../shared/design/components');
  const {createDesignStore} = await import('../src/design/engine/store');
  const {TextEditSession} = await import('../src/design/engine/text-editor/session');
  let doc = createDocument('p');
  doc = add(doc, 'COMPONENT', {id: 'btn', parentId: 'p', width: 120, height: 40});
  doc = add(doc, 'TEXT', {id: 'label', parentId: 'btn', width: 60, height: 20, text: defaultTextProps('Button'), fills: FILLS});
  const property = addComponentProperty(doc, 'btn', {name: 'Text', type: 'TEXT', defaultValue: 'Button'});
  doc = bindProperty(property.doc, 'label', 'characters', property.key).doc;
  doc = createInstance(doc, 'btn', {parentId: 'p', x: 0, y: 100, newId: 'i1'}).doc;
  const store = createDesignStore({doc, measurer});
  store.setEditing({kind: 'text', id: 'i1;label'});
  const deps = {fonts: {} as never, images: {} as never};
  const session = new TextEditSession(store, 'i1;label', deps, {select: {offset: 6}});
  session.insert('!');
  const after = store.getState().doc;
  assert.equal(after.nodes.i1.componentProperties![property.key], 'Button!');
  assert.equal(after.nodes['i1;label'].text!.characters, 'Button!');
  assert.equal(after.nodes.label.text!.characters, 'Button', 'the main keeps its own text');
  assert.ok(!(after.nodes['i1;label'].overrides ?? []).includes('text.characters'), 'no layer override: the property carries it');
  assert.deepEqual(session.range(), {start: 7, end: 7});
  session.end('commit');
  assert.equal(store.getState().editing, null);
  assert.deepEqual(store.getState().selection, ['i1;label']);
});

test('the editor writes typing as coalesced undo steps, and undo puts the caret back', async () => {
  const {createDesignStore} = await import('../src/design/engine/store');
  const {TextEditSession} = await import('../src/design/engine/text-editor/session');
  let doc = createDocument('p');
  doc = add(doc, 'TEXT', {id: 't', parentId: 'p', width: 0, height: 20, text: defaultTextProps(''), fills: FILLS, name: 'Text'});
  const store = createDesignStore({doc, measurer});
  store.setEditing({kind: 'text', id: 't'});
  const session = new TextEditSession(store, 't', {fonts: {} as never, images: {} as never}, {select: {offset: 0}});
  for (const ch of 'Orange fox') session.insert(ch);
  assert.equal(store.getState().doc.nodes.t.text!.characters, 'Orange fox');
  assert.equal(store.getState().doc.nodes.t.name, 'Orange fox', 'an unnamed text is named after its words');
  assert.ok(store.getState().doc.nodes.t.width > 0, 'auto width grows as it is typed');
  session.perform({type: 'undo'});
  assert.equal(store.getState().doc.nodes.t.text!.characters, 'Orange ');
  assert.deepEqual(session.range(), {start: 7, end: 7});
  session.perform({type: 'undo'});
  assert.equal(store.getState().doc.nodes.t.text!.characters, '');
  session.perform({type: 'redo'});
  assert.equal(store.getState().doc.nodes.t.text!.characters, 'Orange ');
  // Leaving a text empty removes it.
  session.perform({type: 'selectAll'});
  session.perform({type: 'delete', direction: 'backward', unit: 'char'});
  session.end('commit');
  assert.equal(store.getState().doc.nodes.t, undefined);
});

test('a new text becomes a layer with its first character; a click that types nothing leaves no trace', async () => {
  const {createDesignStore} = await import('../src/design/engine/store');
  const {TextEditSession} = await import('../src/design/engine/text-editor/session');
  const deps = {fonts: {} as never, images: {} as never};
  const store = createDesignStore({doc: createDocument('p'), measurer});
  const place = (id: string) => {
    const node = createNode('TEXT', {id, parentId: 'p', text: defaultTextProps(''), fills: FILLS});
    const gesture = store.gesture('Text');
    gesture.update(tx => {
      tx.create(node, 'p');
      return {select: [id]};
    });
    store.setEditing({kind: 'text', id});
    return new TextEditSession(store, id, deps, {select: {offset: 0}, creation: {gesture, parentId: 'p', index: undefined, node}});
  };
  const typed = place('a');
  assert.equal(store.getState().history.undo, null, 'nothing is in the history before the first character');
  for (const ch of 'Fresh') typed.insert(ch);
  assert.equal(store.getState().doc.nodes.a.text!.characters, 'Fresh');
  assert.equal(store.getState().history.undo, 'Text', 'the layer and its first word are one step');
  typed.end('commit');
  assert.ok(store.undo());
  assert.equal(store.getState().doc.nodes.a, undefined, 'one undo takes the new text away');
  assert.ok(store.redo());

  const empty = place('b');
  empty.end('commit');
  assert.equal(store.getState().doc.nodes.b, undefined);
  assert.equal(store.getState().history.undo, 'Text', 'an empty text adds no step');
  assert.equal(store.canRedo(), false);

  // Formatting a new text before its first character changes the placeholder, not the history.
  const {applyTextOp} = await import('../src/design/engine/commands/text');
  const styled = place('d');
  assert.ok(applyTextOp(store, {kind: 'style', change: {fontSize: 40, fontFamily: 'Roboto'}}, 'Font size'));
  assert.ok(applyTextOp(store, {kind: 'props', props: {textAlignHorizontal: 'CENTER'}}, 'Alignment'));
  assert.equal(store.getState().history.undo, 'Text', 'still the previous step');
  assert.equal(store.getState().doc.nodes.d.text!.style.fontSize, 40);
  styled.insert('Z');
  assert.deepEqual(store.getState().doc.nodes.d.text!.runs, [], 'typed in the placeholder’s own style');
  assert.equal(store.getState().doc.nodes.d.text!.style.fontFamily, 'Roboto');
  assert.equal(store.getState().doc.nodes.d.text!.textAlignHorizontal, 'CENTER');
  styled.end('commit');
  assert.ok(store.undo());
  assert.equal(store.getState().doc.nodes.d, undefined, 'one step made it');

  // ⌘Z before typing anything just takes the new text away.
  const undone = place('c');
  undone.perform({type: 'undo'});
  assert.ok(undone.isEnded);
  assert.equal(store.getState().doc.nodes.c, undefined);
  assert.equal(store.getState().doc.nodes.a.text!.characters, 'Fresh', 'and undoes nothing else');
});
