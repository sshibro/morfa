import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BLACK, defaultTextProps, solid} from '../shared/design/defaults';
import {assertWasmRan, engineCalls, engineFor, resetEngineCalls, setEngine} from '../shared/design/engine-switch';
import {caretAt, layoutText, layoutTextMany, moveCaret, offsetAt, selectionRects, type FontSpec, type TextMeasurer} from '../shared/design/text-layout';
import {graphemeBoundaries, wordAt} from '../shared/design/text-segment';

// The text module on the engine switch: under `both` every result of the Rust
// twin in crates/text is compared with the TypeScript oracle by `withEngine` (a difference throws
// EngineDiffError); under `wasm` the counters prove the Rust side answered. The differential corpus runs here
// in every suite mode, forced to `both` for the test, so it needs the text wasm build
// (scripts/wasm-text-build.sh) like every other test under MORFA_ENGINE=both.

const unitWidth = (ch: string) => (ch === ' ' || ch === '\u00a0' ? 0.25 : /[\p{M}\u200d\ufe0f]/u.test(ch) ? 0 : 0.5);
const measurer: TextMeasurer = {
  width(text: string, font: FontSpec) {
    let width = 0;
    for (const ch of text) width += unitWidth(ch) * font.size;
    return width;
  },
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

// Cyrillic is kept on purpose: this corpus is text-shaping data (line breaking, graphemes, case, emoji) for both engines.
const CORPUS = [
  'Съешь же ещё этих мягких французских булок, да выпей чаю.',
  'Figma-класс редактор Morfa: 20 041 nodes, 60 fps — быстро',
  'северо-запад и 2-3 x/y «ёлочки» — тире\nвторой абзац\n\nчетвёртый',
  'ff fi ffl office д’Артаньян don\'t 👍🏽 🇷🇺 👨\u200d👩\u200d👧 е\u0301',
  'ПРОПИСНЫЕ и строчные Mixed Case ß straße',
  'tab\tbetween\tsoft\u00adhyphen\u00adwords\u2028after separator',
];

const node = (characters: string, props: Partial<ReturnType<typeof defaultTextProps>> = {}, width = 0) => ({
  width,
  height: 0,
  fills: [solid(BLACK)],
  text: {...defaultTextProps(characters), ...props},
});

const variants = (characters: string) => [
  node(characters, {textAutoResize: 'WIDTH_AND_HEIGHT'}),
  node(characters, {textAutoResize: 'HEIGHT'}, 90),
  node(characters, {textAutoResize: 'HEIGHT', textAlignHorizontal: 'JUSTIFIED'}, 120),
  node(characters, {textAutoResize: 'TRUNCATE', textAlignVertical: 'CENTER'}, 100),
  node(characters, {textAutoResize: 'HEIGHT', style: {...defaultTextProps('').style, textCase: 'SMALL_CAPS', letterSpacing: {unit: 'PIXELS', value: 1}}}, 140),
  node(characters, {textAutoResize: 'HEIGHT', listTypes: ['ORDERED', 'UNORDERED', 'ORDERED'], paragraphSpacing: 4, paragraphIndent: 6}, 110),
  node(characters, {textAutoResize: 'HEIGHT', runs: [{start: 2, end: 9, style: {fontSize: 24, italic: true}, fills: [solid({r: 1, g: 0, b: 0})]}, {start: 12, end: 20, style: {textCase: 'UPPER'}}]}, 100),
];

test('the wasm twin agrees with the TypeScript layout and carets on the corpus (both mode)', () => {
  const restore = setEngine('text', 'both');
  resetEngineCalls('text');
  try {
    for (const characters of CORPUS) {
      for (const n of variants(characters)) {
        const layout = layoutText(n, measurer);
        for (const offset of [0, 1, 3, 7, Math.floor(characters.length / 2), characters.length - 1, characters.length]) {
          caretAt(layout, offset);
          caretAt(layout, offset, 'upstream');
          moveCaret(layout, characters, offset, 'down');
          moveCaret(layout, characters, offset, 'wordRight');
          moveCaret(layout, characters, offset, 'lineEnd');
        }
        offsetAt(layout, {x: 30, y: 10});
        offsetAt(layout, {x: -5, y: 1000});
        selectionRects(layout, 2, Math.max(3, characters.length - 2));
        wordAt(characters, 5);
        graphemeBoundaries(characters);
      }
    }
    const calls = assertWasmRan('text');
    assert.equal(calls.diffs, 0);
    assert.ok(calls.both > 500, `${calls.both} compared calls`);
  } finally {
    restore();
  }
});

test('under MORFA_ENGINE_TEXT=wasm the layout, the batch and the carets come from the engine', t => {
  if (engineFor('text') !== 'wasm') {
    t.skip('the text module is not in wasm mode');
    return;
  }
  resetEngineCalls('text');
  // 8 px per letter: "Button " is 52 px, "Headline" 64 px — two lines in 80 px.
  const layout = layoutText(node('Button Headline', {textAutoResize: 'HEIGHT'}, 80), measurer);
  assert.equal(layout.lines.length, 2);
  caretAt(layout, 3);
  const many = layoutTextMany([node('one'), node('two six', {textAutoResize: 'HEIGHT'}, 30)], measurer);
  assert.equal(many[1].lines.length, 2);
  const calls = assertWasmRan('text');
  assert.ok(calls.wasm >= 3 && calls.ts === 0, `wasm ${calls.wasm}, ts ${calls.ts}`);
  assert.equal(engineCalls('text').fallback, 0);
});
