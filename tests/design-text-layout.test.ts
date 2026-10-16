import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultTextProps, solid, BLACK} from '../shared/design/defaults';
import type {TextProps} from '../shared/design/types';
import {
  caretAt, forgetMeasurements, layoutText, lineRange, moveCaret, offsetAt, paragraphAt, selectionRects, textBoxSize, wordAt,
  type FontSpec, type TextLayout, type TextMeasurer,
} from '../shared/design/text-layout';
import {graphemeBoundaries, nextGraphemeBoundary, prevGraphemeBoundary, snapToGrapheme, wordEndAfter, wordStartBefore} from '../shared/design/text-segment';
import {budget} from './helpers/speed';

// A deterministic measurer: every visible grapheme is half an em, spaces a quarter, combining marks
// and joiners nothing; ascent 0.8 em and descent 0.2 em, so AUTO line height is exactly 1 em.
// At 16 px a letter is 8 px and a space 4 px.
const unitWidth = (ch: string) => (ch === ' ' || ch === '\u00a0' || ch === '\u202f' ? 0.25 : /[\p{M}\u200d\ufe0f]/u.test(ch) ? 0 : 0.5);
function fakeMeasurer(metrics = true): TextMeasurer & {calls: number} {
  const measurer = {
    calls: 0,
    width(text: string, font: FontSpec) {
      measurer.calls++;
      let width = 0;
      for (const ch of text) width += unitWidth(ch) * font.size;
      return width;
    },
    metrics(font: FontSpec) {
      return metrics ? {ascent: font.size * 0.8, descent: font.size * 0.2} : {ascent: 0, descent: 0};
    },
  };
  return measurer;
}
const measurer = fakeMeasurer();

const node = (characters: string, props: Partial<TextProps> = {}, box: {width?: number; height?: number} = {}) => ({
  width: box.width ?? 0,
  height: box.height ?? 0,
  fills: [solid(BLACK)],
  text: {...defaultTextProps(characters), ...props},
});
const lay = (characters: string, props: Partial<TextProps> = {}, box: {width?: number; height?: number} = {}) => layoutText(node(characters, props, box), measurer);
const texts = (layout: TextLayout) => layout.lines.map(line => line.runs.map(run => run.text).join(''));
const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} expected ${expected}, got ${actual}`);

// Several tests below keep Cyrillic text on purpose (wrapping, no-break spaces, hyphens, case mapping, words): they are about Cyrillic text.
// The rest use English sample text with the same letter counts, so every width and offset stays the same.
test('a Cyrillic paragraph wraps at spaces inside 200 px, greedily', () => {
  const layout = lay('Съешь же ещё этих мягких французских булок, да выпей чаю', {textAutoResize: 'HEIGHT'}, {width: 200});
  assert.deepEqual(texts(layout), ['Съешь же ещё этих мягких ', 'французских булок, да ', 'выпей чаю']);
  assert.deepEqual(layout.lines.map(line => [line.start, line.end, line.wrapped]), [[0, 25, true], [25, 47, true], [47, 56, false]]);
  // 20 letters and 4 inner spaces; the space before «французских» hangs and is not counted.
  assert.equal(layout.lines[0].width, 176);
  assert.ok(layout.lines.every(line => line.width <= 200));
  assert.equal(layout.height, 48);
  assert.equal(layout.width, 200);
});

test('a word wider than the box breaks between letters, and only then', () => {
  const alone = lay('Электроэнцефалографический', {textAutoResize: 'HEIGHT'}, {width: 100});
  assert.deepEqual(texts(alone), ['Электроэнцеф', 'алографическ', 'ий']);
  const after = lay('Это Электроэнцефалографический', {textAutoResize: 'HEIGHT'}, {width: 100});
  assert.deepEqual(texts(after), ['Это ', 'Электроэнцеф', 'алографическ', 'ий']);
});

test('no-break spaces keep a number with its unit and a dash with the word before it', () => {
  assert.deepEqual(texts(lay('Цена 100\u00a0₽ за штуку', {textAutoResize: 'HEIGHT'}, {width: 64})), ['Цена ', '100\u00a0₽ за ', 'штуку']);
  assert.deepEqual(texts(lay('Москва\u00a0— столица', {textAutoResize: 'HEIGHT'}, {width: 64})), ['Москва\u00a0— ', 'столица']);
  // A plain space before a dash does not let the dash start a line either.
  assert.deepEqual(texts(lay('Москва — столица', {textAutoResize: 'HEIGHT'}, {width: 64})), ['Москва — ', 'столица']);
  // Narrow U+202F holds too.
  assert.deepEqual(texts(lay('10\u202fкм дальше', {textAutoResize: 'HEIGHT'}, {width: 50})), ['10\u202fкм ', 'дальше']);
});

test('lines break after hyphens inside words, dashes and slashes, not inside numbers', () => {
  assert.deepEqual(texts(lay('северо-западный ветер', {textAutoResize: 'HEIGHT'}, {width: 80})), ['северо-', 'западный ', 'ветер']);
  assert.deepEqual(texts(lay('страницы 12-15', {textAutoResize: 'HEIGHT'}, {width: 100})), ['страницы ', '12-15']);
  assert.deepEqual(texts(lay('чёрный/белый', {textAutoResize: 'HEIGHT'}, {width: 60})), ['чёрный/', 'белый']);
  assert.deepEqual(texts(lay('слово—слово', {textAutoResize: 'HEIGHT'}, {width: 50})), ['слово—', 'слово']);
});

test('a soft hyphen is invisible until the line breaks at it, then shows as a hyphen', () => {
  const unbroken = lay('elec\u00adtro', {textAutoResize: 'WIDTH_AND_HEIGHT'});
  assert.deepEqual(texts(unbroken), ['electro']);
  assert.equal(unbroken.naturalWidth, 56);
  const broken = lay('electro\u00admagnet', {textAutoResize: 'HEIGHT'}, {width: 80});
  assert.deepEqual(texts(broken), ['electro-', 'magnet']);
  assert.equal(broken.lines[0].width, 64);
  assert.equal(broken.lines[1].start, 8);
});

test('trailing spaces hang: centred lines are centred on their ink', () => {
  const layout = lay('four two', {textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER'}, {width: 40});
  assert.deepEqual(texts(layout), ['four ', 'two']);
  assert.equal(layout.lines[0].width, 32);
  assert.equal(layout.lines[0].x, 4);
  assert.equal(layout.lines[1].x, 8);
  // The caret after the hanging space sits past the ink, at the end of the upper line.
  assert.equal(caretAt(layout, 5, 'upstream').x, 40);
  assert.equal(caretAt(layout, 5, 'upstream').lineIndex, 0);
  assert.equal(caretAt(layout, 5).lineIndex, 1);
  const right = lay('four two', {textAutoResize: 'HEIGHT', textAlignHorizontal: 'RIGHT'}, {width: 40});
  assert.equal(right.lines[0].x, 8);
  assert.equal(right.lines[1].x, 16);
});

test('justified lines stretch their inner spaces; a paragraph’s last line does not', () => {
  const layout = lay('one two six eleven five\nseven nine', {textAutoResize: 'HEIGHT', textAlignHorizontal: 'JUSTIFIED'}, {width: 100});
  assert.deepEqual(texts(layout), ['one two six ', 'eleven five', 'seven nine']);
  const [first, second, third] = layout.lines;
  assert.equal(first.width, 100);
  assert.deepEqual(first.runs.map(run => [run.text, run.x]), [['one ', 0], ['two ', 38], ['six ', 76]]);
  // The last ink reaches the right edge exactly.
  assert.equal(first.runs[2].xs[3], 100);
  assert.equal(second.width, 84);
  assert.equal(third.width, 76);
  assert.equal(caretAt(layout, 4).x, 38);
});

test('letter spacing in percent of the size and in pixels is added after every grapheme', () => {
  const percent = layoutText(node('ABC', {style: {...defaultTextProps().style, fontSize: 20, letterSpacing: {unit: 'PERCENT', value: 10}}}), measurer);
  assert.equal(percent.naturalWidth, 36);
  assert.deepEqual(percent.lines[0].runs[0].xs, [0, 12, 24, 36]);
  assert.equal(percent.lines[0].runs[0].letterSpacing, 2);
  const pixels = layoutText(node('ABC', {style: {...defaultTextProps().style, fontSize: 20, letterSpacing: {unit: 'PIXELS', value: 3}}}), measurer);
  assert.equal(pixels.naturalWidth, 39);
});

test('line height AUTO / PIXELS / PERCENT and the half-leading baseline', () => {
  const style = defaultTextProps().style;
  const auto = lay('a\nb');
  assert.deepEqual(auto.lines.map(line => [line.top, line.height]), [[0, 16], [16, 16]]);
  close(auto.lines[0].baseline, 12.8);
  const pixels = lay('a\nb', {style: {...style, lineHeight: {unit: 'PIXELS', value: 24}}});
  assert.deepEqual(pixels.lines.map(line => [line.top, line.height]), [[0, 24], [24, 24]]);
  close(pixels.lines[0].baseline, 16.8);
  close(pixels.lines[1].baseline, 40.8);
  const percent = lay('a', {style: {...style, lineHeight: {unit: 'PERCENT', value: 150}}});
  assert.equal(percent.lines[0].height, 24);
  close(percent.lines[0].baseline, 16.8);
  // Without font metrics AUTO falls back to 1.2 em.
  const fallback = layoutText(node('a'), fakeMeasurer(false));
  close(fallback.lines[0].height, 19.2);
  close(fallback.lines[0].baseline, 15.36);
});

test('mixed sizes on one line share the baseline; the tallest line height wins', () => {
  const style = defaultTextProps().style;
  const layout = lay('low BIGGEST', {runs: [{start: 4, end: 11, style: {fontSize: 32}}]});
  const [line] = layout.lines;
  assert.equal(line.height, 32);
  close(line.baseline, 25.6);
  assert.deepEqual(line.runs.map(run => [run.text, run.x, run.width, run.style.fontSize]), [['low ', 0, 28, 16], ['BIGGEST', 28, 112, 32]]);
  const fixed = lay('low BIGGEST', {style: {...style, lineHeight: {unit: 'PIXELS', value: 20}}, runs: [{start: 4, end: 11, style: {fontSize: 32, lineHeight: {unit: 'PERCENT', value: 100}}}]});
  assert.equal(fixed.lines[0].height, 32);
  close(fixed.lines[0].baseline, 25.6);
});

test('run fills reach their glyph runs; the node’s fills paint the rest', () => {
  const red = solid({r: 1, g: 0, b: 0});
  const layout = lay('yellow crimson', {runs: [{start: 7, end: 14, style: {}, fills: [red]}]});
  assert.deepEqual(layout.lines[0].runs.map(run => [run.text, run.fills]), [['yellow ', [solid(BLACK)]], ['crimson', [red]]]);
});

test('zero-width spaces break without drawing; tabs and a zero-wide box do not hang the layout', () => {
  const zwsp = lay('between\u200bmoves', {textAutoResize: 'HEIGHT'}, {width: 70});
  assert.deepEqual(texts(zwsp), ['between', 'moves']);
  assert.deepEqual(zwsp.lines.map(line => [line.start, line.end]), [[0, 8], [8, 13]]);
  const tab = lay('a\tb');
  assert.deepEqual(tab.lines[0].runs.map(run => [run.text, run.x, run.width]), [['a', 0, 8], ['', 8, 16], ['b', 24, 8]]);
  const narrow = lay('ab cd', {textAutoResize: 'HEIGHT'}, {width: 0});
  assert.deepEqual(texts(narrow), ['a', 'b ', 'c', 'd']);
});

test('paragraph spacing goes between paragraphs and the indent on their first lines', () => {
  const layout = lay('four two\nsix', {textAutoResize: 'HEIGHT', paragraphSpacing: 10, paragraphIndent: 20}, {width: 60});
  assert.deepEqual(texts(layout), ['four ', 'two', 'six']);
  assert.deepEqual(layout.lines.map(line => [line.x, line.top, line.paragraphIndex]), [[20, 0, 0], [0, 16, 0], [20, 42, 1]]);
  assert.equal(layout.height, 58);
});

test('lists number consecutive ordered paragraphs and hang their wrapped lines', () => {
  const layout = lay('a\nb\nc\nd\ne f g', {listTypes: ['ORDERED', 'ORDERED', 'NONE', 'ORDERED', 'UNORDERED'], textAutoResize: 'HEIGHT'}, {width: 50});
  assert.deepEqual(layout.lines.map(line => line.listMarker ?? null), ['1.', '2.', null, '1.', '•', null]);
  assert.deepEqual(layout.lines.map(line => line.x), [24, 24, 0, 24, 24, 24]);
  assert.equal(layout.lines[0].marker?.x, 0);
  assert.deepEqual(texts(layout).slice(4), ['e f ', 'g']);
  // A long list widens the indent for "10." and keeps every item aligned.
  const ten = lay(Array.from({length: 10}, (_, i) => `p${i}`).join('\n'), {listTypes: Array(10).fill('ORDERED')});
  assert.equal(ten.lines[9].listMarker, '10.');
  assert.ok(ten.lines.every(line => line.x === 32));
});

test('TRUNCATE cuts at the box height or maxLines and fits an ellipsis into the last line', () => {
  const props: Partial<TextProps> = {textAutoResize: 'TRUNCATE'};
  const sentence = 'one two six eleven five seven';
  const byHeight = lay(sentence, props, {width: 100, height: 40});
  assert.deepEqual(texts(byHeight), ['one two six ', 'eleven five…']);
  assert.equal(byHeight.truncated, true);
  assert.equal(byHeight.height, 32);
  assert.equal(byHeight.lines[1].end, 23);
  const byLines = lay(sentence, {...props, maxLines: 1}, {width: 100, height: 400});
  assert.deepEqual(texts(byLines), ['one two six…']);
  const tight = lay(sentence, {...props, maxLines: 1}, {width: 86, height: 400});
  assert.deepEqual(texts(tight), ['one two si…']);
  assert.ok(tight.lines[0].width <= 86);
  const fits = lay(sentence, props, {width: 100, height: 400});
  assert.equal(fits.truncated, false);
  assert.equal(fits.lines.length, 3);
  // Offsets hidden by the cut keep the caret at the visible end.
  assert.equal(caretAt(byLines, 25).x, caretAt(byLines, byLines.lines[0].end).x);
});

test('vertical alignment places the lines inside a fixed box', () => {
  const center = lay('a', {textAutoResize: 'NONE', textAlignVertical: 'CENTER'}, {width: 100, height: 100});
  assert.equal(center.lines[0].top, 42);
  close(center.lines[0].baseline, 54.8);
  const bottom = lay('a', {textAutoResize: 'NONE', textAlignVertical: 'BOTTOM'}, {width: 100, height: 100});
  assert.equal(bottom.lines[0].top, 84);
  // Auto-height text has no free space to distribute.
  const hug = lay('a', {textAutoResize: 'HEIGHT', textAlignVertical: 'BOTTOM'}, {width: 100, height: 100});
  assert.equal(hug.lines[0].top, 0);
});

test('textCase changes what is drawn while caret stops stay on the original offsets', () => {
  const upper = lay('straße ёлочка', {style: {...defaultTextProps().style, textCase: 'UPPER'}});
  assert.deepEqual(texts(upper), ['STRASSE ЁЛОЧКА']);
  const run = upper.lines[0].runs[0];
  assert.deepEqual(run.offsets.slice(0, 7), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(caretAt(upper, 5).x, 48);
  assert.equal(caretAt(upper, 6).x, 56);
  assert.equal(offsetAt(upper, {x: 47, y: 8}).offset, 5);
  assert.equal(offsetAt(upper, {x: 37, y: 8}).offset, 4);
  const title = lay('северо-западный ветер', {style: {...defaultTextProps().style, textCase: 'TITLE'}});
  assert.deepEqual(texts(title), ['Северо-Западный Ветер']);
  const lower = lay('ПРИВЕТ', {style: {...defaultTextProps().style, textCase: 'LOWER'}});
  assert.deepEqual(texts(lower), ['привет']);
  const small = layoutText(node('Ab', {style: {...defaultTextProps().style, fontSize: 20, textCase: 'SMALL_CAPS'}}), measurer);
  assert.deepEqual(small.lines[0].runs.map(r => [r.text, r.style.fontSize, r.font.size, r.width]), [['A', 20, 20, 10], ['B', 16, 16, 8]]);
});

test('caret and click positions round-trip on every offset of multi-line text', () => {
  const layout = lay('First line of the text\nand the second, a bit longer', {textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER'}, {width: 120});
  const length = layout.length;
  for (let offset = 0; offset <= length; offset++) {
    const caret = caretAt(layout, offset);
    const hit = offsetAt(layout, {x: caret.x, y: caret.top + caret.height / 2});
    assert.equal(hit.offset, offset, `offset ${offset}`);
    const upstream = caretAt(layout, offset, 'upstream');
    const back = offsetAt(layout, {x: upstream.x, y: upstream.top + upstream.height / 2});
    assert.equal(back.offset, offset, `upstream offset ${offset}`);
    if (upstream.lineIndex !== caret.lineIndex) assert.equal(back.affinity, 'upstream');
  }
  // Clicks outside the text land on the nearest line's ends.
  assert.equal(offsetAt(layout, {x: -50, y: -50}).offset, 0);
  assert.equal(offsetAt(layout, {x: 1000, y: 1000}).offset, length);
});

test('selection rectangles cover each line and a selected line break', () => {
  const layout = lay('four two\n\nsix', {textAutoResize: 'HEIGHT'}, {width: 40});
  assert.deepEqual(texts(layout), ['four ', 'two', '', 'six']);
  const rects = selectionRects(layout, 2, 13);
  assert.deepEqual(rects.map(rect => rect.lineIndex), [0, 1, 2, 3]);
  assert.deepEqual([rects[0].x, rects[0].width], [16, 20]);
  assert.equal(rects[1].x, 0);
  assert.ok(rects[1].width > 24, 'the selected newline after "two" shows');
  assert.ok(rects[2].width > 0, 'a selected empty line shows');
  assert.deepEqual([rects[3].x, rects[3].width], [0, 24]);
  assert.deepEqual(selectionRects(layout, 3, 3), []);
});

test('moveCaret: ↑/↓ keep the goal column across a short line; Home/End follow visual lines', () => {
  const text = 'aaaaaaaaaa\naa\nb b b b b b';
  const layout = lay(text);
  const down = moveCaret(layout, text, 7, 'down');
  assert.deepEqual(down, {offset: 13, goalX: 56, affinity: 'downstream'});
  const down2 = moveCaret(layout, text, down.offset, 'down', down.goalX);
  assert.equal(down2.offset, 23);
  const up = moveCaret(layout, text, down2.offset, 'up', down2.goalX);
  assert.equal(up.offset, 13);
  assert.equal(moveCaret(layout, text, up.offset, 'up', up.goalX).offset, 7);
  assert.equal(moveCaret(layout, text, 3, 'up').offset, 0);
  assert.equal(moveCaret(layout, text, 20, 'down').offset, text.length);

  const wrapped = 'four two six';
  const box = lay(wrapped, {textAutoResize: 'HEIGHT'}, {width: 40});
  assert.deepEqual(moveCaret(box, wrapped, 2, 'lineEnd'), {offset: 5, goalX: undefined, affinity: 'upstream'});
  assert.equal(moveCaret(box, wrapped, 5, 'lineStart', undefined, 'upstream').offset, 0);
  assert.equal(moveCaret(box, wrapped, 5, 'lineStart').offset, 5);
  assert.deepEqual(lineRange(box, 6), {start: 5, end: 9, lineIndex: 1});
  assert.equal(moveCaret(box, wrapped, 6, 'wordLeft').offset, 5);
  assert.equal(moveCaret(box, wrapped, 6, 'wordRight').offset, 8);
  assert.equal(moveCaret(box, wrapped, 6, 'docEnd').offset, wrapped.length);
});

test('graphemes are never split: emoji sequences, combining accents, flags', () => {
  const family = '👨\u200d👩\u200d👧';
  const text = `${family} e\u0301j 🇷🇺`;
  assert.equal(nextGraphemeBoundary(text, 0), family.length);
  assert.equal(prevGraphemeBoundary(text, family.length), 0);
  assert.equal(nextGraphemeBoundary(text, family.length + 1), family.length + 3);
  assert.equal(prevGraphemeBoundary(text, text.length), text.length - 4);
  assert.equal(snapToGrapheme(text, 3), 0);
  assert.equal(snapToGrapheme(text, 3, true), family.length);
  assert.deepEqual(graphemeBoundaries('ab'), [0, 1, 2]);
  const layout = lay(text);
  assert.deepEqual(layout.lines[0].runs[0].offsets.slice(0, 4), [0, family.length, family.length + 1, family.length + 3]);
  assert.equal(moveCaret(layout, text, 0, 'right').offset, family.length);
  assert.equal(moveCaret(layout, text, family.length + 3, 'left').offset, family.length + 1);
});

test('words and paragraphs: Cyrillic, Latin, digits, apostrophes', () => {
  const text = 'Привет, мир! It’s 2026 год';
  assert.deepEqual(wordAt(text, 2), {start: 0, end: 6});
  assert.deepEqual(wordAt(text, 6), {start: 0, end: 6});
  assert.deepEqual(wordAt(text, 7), {start: 7, end: 8});
  assert.deepEqual(wordAt(text, 14), {start: 13, end: 17});
  assert.deepEqual(wordAt(text, 19), {start: 18, end: 22});
  assert.equal(wordEndAfter(text, 6), 11);
  assert.equal(wordStartBefore(text, 11), 8);
  assert.equal(wordStartBefore(text, 8), 0);
  assert.deepEqual(paragraphAt('раз\nдва\nтри', 5), {start: 4, end: 7, index: 1});
  assert.deepEqual(paragraphAt('раз\nдва\n', 8), {start: 8, end: 8, index: 2});
});

test('empty text keeps one line of the base style for the caret', () => {
  const empty = lay('');
  assert.equal(empty.lines.length, 1);
  assert.deepEqual(caretAt(empty, 0), {x: 0, top: 0, height: 16, baseline: 12.8, lineIndex: 0});
  const centred = lay('', {textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER'}, {width: 100});
  assert.equal(centred.lines[0].x, 50);
  assert.deepEqual(textBoxSize(node(''), measurer), {width: 0, height: 16});
  // A trailing newline leaves an empty last line, sized by that newline's style.
  const trailing = lay('a\n', {runs: [{start: 1, end: 2, style: {fontSize: 32}}]});
  assert.deepEqual(trailing.lines.map(line => [line.start, line.end, line.height]), [[0, 1, 32], [2, 2, 32]]);
});

test('U+2028 breaks the line inside a paragraph: one list item, no justification', () => {
  const layout = lay('four two\u2028six', {listTypes: ['ORDERED'], textAlignHorizontal: 'JUSTIFIED', textAutoResize: 'HEIGHT'}, {width: 200});
  assert.deepEqual(layout.lines.map(line => [line.start, line.end, line.paragraphIndex, line.listMarker ?? null]), [[0, 8, 0, '1.'], [9, 12, 0, null]]);
  assert.equal(layout.lines[0].width, 60);
  assert.equal(layout.lines[1].x, 24);
});

test('textBoxSize follows the auto-resize mode', () => {
  const text = 'Four two six';
  assert.deepEqual(textBoxSize(node(text, {textAutoResize: 'WIDTH_AND_HEIGHT'}, {width: 10, height: 10}), measurer), {width: 88, height: 16});
  assert.deepEqual(textBoxSize(node(text, {textAutoResize: 'HEIGHT'}, {width: 50, height: 10}), measurer), {width: 50, height: 48});
  assert.deepEqual(textBoxSize(node(text, {textAutoResize: 'NONE'}, {width: 50, height: 10}), measurer), {width: 50, height: 10});
  assert.deepEqual(textBoxSize(node(text, {textAutoResize: 'TRUNCATE'}, {width: 50, height: 10}), measurer), {width: 50, height: 10});
  // A text laid out at its own natural width does not wrap.
  const natural = textBoxSize(node('Width exactly fits text', {textAutoResize: 'WIDTH_AND_HEIGHT'}), measurer);
  assert.equal(lay('Width exactly fits text', {textAutoResize: 'HEIGHT'}, {width: natural.width}).lines.length, 1);
});

test('layouts are cached on the text object and dropped when measurements change', () => {
  const counting = fakeMeasurer();
  const shape = node('Layout cache');
  const first = layoutText(shape, counting);
  const calls = counting.calls;
  assert.equal(layoutText(shape, counting), first);
  assert.equal(counting.calls, calls);
  // The same words in another node are measured from the cache.
  layoutText(node('Layout cache'), counting);
  assert.equal(counting.calls, calls);
  forgetMeasurements(counting);
  const again = layoutText(shape, counting);
  assert.notEqual(again, first);
  assert.ok(counting.calls > calls);
  const revisioned = {...fakeMeasurer(), revision: 1};
  const before = layoutText(shape, revisioned);
  revisioned.revision = 2;
  assert.notEqual(layoutText(shape, revisioned), before);
});

test('1 000 short texts lay out in under 50 ms with a cached measurer', () => {
  const fast = fakeMeasurer();
  const words = ['Button', 'Heading', 'cards', 'Learn more', 'price', '$1,990', 'Buy', 'to cart', 'Delivery', 'tomorrow'];
  const make = (i: number) => node(`${words[i % 10]} ${words[(i * 7) % 10]} ${words[(i * 3) % 10]} #${i % 50}`, {textAutoResize: 'HEIGHT'}, {width: 120});
  for (let i = 0; i < 3000; i++) layoutText(make(i), fast);
  // Best of three batches of fresh nodes, so a busy machine does not decide the result.
  let elapsed = Infinity;
  for (let batch = 0; batch < 3; batch++) {
    const nodes = Array.from({length: 1000}, (_, i) => make(i));
    const started = performance.now();
    for (const n of nodes) layoutText(n, fast);
    elapsed = Math.min(elapsed, performance.now() - started);
  }
  assert.ok(elapsed < budget(50), `took ${elapsed.toFixed(1)} ms`);
});
