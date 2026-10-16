import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultTextProps, solid, BLACK} from '../shared/design/defaults';
import type {Paint, TextProps, TextStyle} from '../shared/design/types';
import {
  applyFillsToRange, applyStyleToRange, caretStyleAt, deleteRange, hyperlinkAt, insertText, MIXED, normalizeRuns, sameValue, setListType,
  styleAtRange, transformCase, type RunOverride,
} from '../shared/design/text-edit';

const RED = solid({r: 1, g: 0, b: 0});
const BLUE = solid({r: 0, g: 0, b: 1});
const NODE_FILLS: Paint[] = [solid(BLACK)];
const text = (characters: string, props: Partial<TextProps> = {}): TextProps => ({...defaultTextProps(characters), ...props});
const bold: Partial<TextStyle> = {fontWeight: 700};
const LINK = {type: 'URL' as const, url: 'https://foo.test'};

/** Every character's resolved style and paint, the ground truth runs must reproduce. */
function resolved(props: TextProps, nodeFills: Paint[] = NODE_FILLS) {
  return [...Array(props.characters.length).keys()].map(i => {
    const run = props.runs.find(r => r.start <= i && i < r.end);
    return {style: {...props.style, ...(run?.style ?? {})}, fills: run?.fills ?? nodeFills};
  });
}

/** The invariants every operation keeps (docs/design-tool.md §The document). */
function assertNormalized(props: TextProps, nodeFills?: Paint[]) {
  const {runs, characters, style} = props;
  runs.forEach((run, i) => {
    assert.ok(run.start >= 0 && run.end <= characters.length && run.start < run.end, `run ${i} inside the text and not empty`);
    if (i) assert.ok(runs[i - 1].end <= run.start, `run ${i} sorted and not overlapping`);
    for (const [key, value] of Object.entries(run.style)) {
      assert.ok(!sameValue(value, (style as Record<string, unknown>)[key] ?? (key === 'hyperlink' ? null : undefined)), `run ${i} repeats the base ${key}`);
    }
    assert.ok(Object.keys(run.style).length || run.fills || run.textStyleId, `run ${i} says something`);
    if (nodeFills && run.fills) assert.ok(!sameValue(run.fills, nodeFills), `run ${i} repeats the node fills`);
    const previous = runs[i - 1];
    if (previous && previous.end === run.start) {
      assert.ok(!(sameValue(previous.style, run.style) && sameValue(previous.fills, run.fills) && previous.textStyleId === run.textStyleId), `runs ${i - 1} and ${i} should merge`);
    }
  });
  if (props.listTypes) {
    const paragraphs = characters.split('\n').length;
    assert.ok(props.listTypes.length <= paragraphs && props.listTypes.length > 0 && props.listTypes.at(-1) !== 'NONE', 'listTypes trimmed');
  }
}

test('typing inside and right after a run continues it; at a paragraph start the paragraph decides', () => {
  const base = text('four two\nsix', {runs: [{start: 5, end: 8, style: bold}]});
  const inside = insertText(base, 6, 6, 'ZZ');
  assert.equal(inside.characters, 'four tZZwo\nsix');
  assert.deepEqual(inside.runs, [{start: 5, end: 10, style: bold}]);
  const after = insertText(base, 8, 8, '!');
  assert.deepEqual(after.runs, [{start: 5, end: 9, style: bold}]);
  const before = insertText(base, 5, 5, 'x');
  assert.deepEqual(before.runs, [{start: 6, end: 9, style: bold}]);
  // At the start of the bold second paragraph the first character's style wins over the newline's.
  const second = text('a\nb', {runs: [{start: 2, end: 3, style: bold}]});
  assert.deepEqual(insertText(second, 2, 2, 'c').runs, [{start: 2, end: 4, style: bold}]);
  // An empty paragraph's style is its line break's.
  const empty = text('a\n\nb', {runs: [{start: 2, end: 3, style: {fontSize: 40}}]});
  assert.deepEqual(insertText(empty, 2, 2, 'c').runs, [{start: 2, end: 4, style: {fontSize: 40}}]);
  // Typing over a selection takes its first character's style.
  assert.deepEqual(insertText(base, 4, 8, 'X').runs, []);
  assert.deepEqual(insertText(base, 5, 9, 'X').runs, [{start: 5, end: 6, style: bold}]);
});

test('a pending caret style applies to typed text; null types in the base style', () => {
  const base = text('ab', {runs: [{start: 0, end: 2, style: bold}]});
  const pending: RunOverride = {style: {fontWeight: 700, italic: true}};
  assert.deepEqual(insertText(base, 2, 2, 'c', pending).runs, [{start: 0, end: 2, style: bold}, {start: 2, end: 3, style: {fontWeight: 700, italic: true}}]);
  assert.deepEqual(insertText(base, 2, 2, 'c', null).runs, [{start: 0, end: 2, style: bold}]);
  assert.deepEqual(caretStyleAt(base, 1), {style: bold});
  assert.equal(caretStyleAt(text(''), 0), null);
});

test('typing right after a link does not extend it', () => {
  const linked = text('site is', {runs: [{start: 0, end: 4, style: {hyperlink: LINK}}]});
  const typed = insertText(linked, 4, 4, '!');
  assert.deepEqual(typed.runs, [{start: 0, end: 4, style: {hyperlink: LINK}}]);
  assert.deepEqual(insertText(linked, 2, 2, 'y').runs, [{start: 0, end: 5, style: {hyperlink: LINK}}]);
  assert.deepEqual(hyperlinkAt(typed, 2), {hyperlink: LINK, start: 0, end: 4});
  assert.deepEqual(hyperlinkAt(typed, 4), {hyperlink: LINK, start: 0, end: 4});
  assert.equal(hyperlinkAt(typed, 6), null);
});

test('deleting merges equal neighbours and joins list paragraphs', () => {
  const runs = text('aaBBcc', {runs: [{start: 0, end: 2, style: bold}, {start: 4, end: 6, style: bold}]});
  assert.deepEqual(deleteRange(runs, 2, 4), {...runs, characters: 'aacc', runs: [{start: 0, end: 4, style: bold}]});
  assert.deepEqual(deleteRange(runs, 1, 5).runs, [{start: 0, end: 2, style: bold}]);
  const list = text('a\nb\nc', {listTypes: ['ORDERED', 'NONE', 'UNORDERED']});
  assert.deepEqual(deleteRange(list, 1, 2).listTypes, ['ORDERED', 'UNORDERED']);
  assert.deepEqual(deleteRange(list, 0, 5).listTypes, ['ORDERED'], 'the paragraph left keeps the first one’s list type');
  assert.equal(deleteRange(text('a\nb', {listTypes: ['NONE', 'ORDERED']}), 0, 3).listTypes, undefined);
  // Enter in a list item makes another item of the same kind.
  assert.deepEqual(insertText(list, 1, 1, '\n').listTypes, ['ORDERED', 'ORDERED', 'NONE', 'UNORDERED']);
  assert.deepEqual(insertText(list, 4, 5, 'x\ny').listTypes, ['ORDERED', 'NONE', 'UNORDERED', 'UNORDERED']);
});

test('applyStyleToRange splits runs, merges equal ones, and over all text moves to the base style', () => {
  const base = text('four two six');
  const middle = applyStyleToRange(base, 5, 8, bold);
  assert.deepEqual(middle.runs, [{start: 5, end: 8, style: bold}]);
  const wider = applyStyleToRange(middle, 3, 10, {italic: true});
  assert.deepEqual(wider.runs, [
    {start: 3, end: 5, style: {italic: true}},
    {start: 5, end: 8, style: {fontWeight: 700, italic: true}},
    {start: 8, end: 10, style: {italic: true}},
  ]);
  const back = applyStyleToRange(wider, 0, 12, {italic: false});
  assert.deepEqual(back.runs, [{start: 5, end: 8, style: bold}]);
  assert.equal(back.style.italic, false);
  const all = applyStyleToRange(middle, 0, 12, {fontWeight: 300, fontSize: 24});
  assert.deepEqual(all.runs, []);
  assert.equal(all.style.fontWeight, 300);
  assert.equal(all.style.fontSize, 24);
  // Undoing the change by hand leaves no redundant run.
  assert.deepEqual(applyStyleToRange(middle, 5, 8, {fontWeight: 400}).runs, []);
  // A collapsed caret in non-empty text changes nothing; in empty text it styles the base.
  assert.equal(applyStyleToRange(base, 3, 3, bold), base);
  assert.equal(applyStyleToRange(text(''), 0, 0, bold).style.fontWeight, 700);
});

test('applyFillsToRange paints runs, or the node when the whole text is painted', () => {
  const base = text('crimson green');
  const part = applyFillsToRange(base, NODE_FILLS, 0, 7, [RED]);
  assert.deepEqual(part.text.runs, [{start: 0, end: 7, style: {}, fills: [RED]}]);
  assert.equal(part.fills, NODE_FILLS);
  const both = applyFillsToRange(part.text, NODE_FILLS, 8, 13, [BLUE]);
  assert.equal(both.text.runs.length, 2);
  const whole = applyFillsToRange(both.text, NODE_FILLS, 0, 13, [BLUE]);
  assert.deepEqual(whole.text.runs, []);
  assert.deepEqual(whole.fills, [BLUE]);
  // Painting a run back to the node's paint removes it.
  assert.deepEqual(applyFillsToRange(part.text, NODE_FILLS, 0, 7, NODE_FILLS).text.runs, []);
});

test('styleAtRange reports common values and marks the differing fields mixed', () => {
  const props = text('four two\nsix', {
    runs: [{start: 5, end: 8, style: {fontWeight: 700, hyperlink: LINK}, fills: [RED]}],
    listTypes: ['ORDERED'],
  });
  const across = styleAtRange(props, 2, 7, NODE_FILLS);
  assert.equal(across.fontWeight, MIXED);
  assert.equal(across.hyperlink, MIXED);
  assert.equal(across.fills, MIXED);
  assert.equal(across.fontFamily, 'Inter');
  assert.equal(across.fontSize, 16);
  assert.deepEqual(across.lineHeight, {unit: 'AUTO'});
  assert.equal(across.listType, 'ORDERED');
  const inside = styleAtRange(props, 5, 8, NODE_FILLS);
  assert.equal(inside.fontWeight, 700);
  assert.deepEqual(inside.fills, [RED]);
  assert.deepEqual(inside.hyperlink, LINK);
  assert.equal(inside.textStyleId, null);
  // A collapsed caret reports what typing there would produce.
  assert.equal(styleAtRange(props, 7, 7, NODE_FILLS).fontWeight, 700);
  assert.equal(styleAtRange(props, 1, 1, NODE_FILLS).hyperlink, null);
  assert.equal(styleAtRange(props, 0, 13, NODE_FILLS).listType, MIXED);
  // A triple-click selection ending after a line break stays in its paragraph.
  assert.equal(styleAtRange(props, 0, 9, NODE_FILLS).listType, 'ORDERED');
});

test('setListType changes the touched paragraphs and trims the list', () => {
  const props = text('a\nb\nc');
  assert.deepEqual(setListType(props, 0, 3, 'UNORDERED').listTypes, ['UNORDERED', 'UNORDERED']);
  assert.deepEqual(setListType(props, 0, 2, 'ORDERED').listTypes, ['ORDERED']);
  assert.deepEqual(setListType(props, 4, 4, 'ORDERED').listTypes, ['NONE', 'NONE', 'ORDERED']);
  const cleared = setListType(setListType(props, 0, 5, 'ORDERED'), 0, 5, 'NONE');
  assert.equal('listTypes' in cleared, false);
});

test('normalizeRuns sorts, clips, de-duplicates and merges; normalized text comes back as is', () => {
  const messy = text('abcdefgh', {
    runs: [
      {start: 6, end: 20, style: {fontWeight: 700}},
      {start: 0, end: 2, style: {fontWeight: 700}},
      {start: 2, end: 4, style: {fontWeight: 700, fontSize: 16}},
      {start: 3, end: 5, style: {italic: true}},
      {start: 5, end: 5, style: {italic: true}},
      {start: 5, end: 6, style: {fontFamily: 'Inter', fills: undefined} as Partial<TextStyle>, fills: NODE_FILLS},
    ],
  });
  const clean = normalizeRuns(messy, NODE_FILLS);
  // Where runs overlap the earlier one keeps the shared characters.
  assert.deepEqual(clean.runs, [{start: 0, end: 4, style: bold}, {start: 4, end: 5, style: {italic: true}}, {start: 6, end: 8, style: bold}]);
  assert.equal(normalizeRuns(clean, NODE_FILLS), clean);
});

test('transformCase rewrites letters and keeps runs on their characters', () => {
  // Cyrillic on purpose: case mapping of non-Latin letters (ё, hyphenated Title Case, sentence case after . and !), beside German ß.
  const props = text('улица straße и ёж', {runs: [{start: 12, end: 13, style: bold}]});
  const upper = transformCase(props, 0, props.characters.length, 'UPPER');
  assert.equal(upper.characters, 'УЛИЦА STRASSE И ЁЖ');
  assert.deepEqual(upper.runs, [{start: 13, end: 14, style: bold}]);
  assert.equal(transformCase(text('ПРИВЕТ, МИР'), 0, 11, 'LOWER').characters, 'привет, мир');
  assert.equal(transformCase(text('северо-западный ветер'), 0, 21, 'TITLE').characters, 'Северо-Западный Ветер');
  assert.equal(transformCase(text('ПЕРВОЕ. ВТОРОЕ! третье'), 0, 22, 'SENTENCE').characters, 'Первое. Второе! Третье');
  assert.equal(transformCase(text('Рим'), 0, 3, 'TITLE').characters, 'Рим');
  const unchanged = text('Рим');
  assert.equal(transformCase(unchanged, 0, 3, 'TITLE'), unchanged);
});

test('random edits keep runs normalized and every character’s style right', () => {
  let seed = 20261006;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const alphabet = ['a', 'b', 'é', 'J', 'x', ' ', '\n', '—', '\u00a0'];
  const partials: Partial<TextStyle>[] = [{fontWeight: 700}, {fontWeight: 400}, {fontSize: 24}, {fontSize: 16}, {italic: true}, {italic: false}, {textDecoration: 'UNDERLINE'}];
  const paints = [[RED], [BLUE], NODE_FILLS];
  for (let round = 0; round < 40; round++) {
    let props = text('Hello, mars');
    let fills = NODE_FILLS;
    let model = resolved(props, fills);
    for (let step = 0; step < 60; step++) {
      const length = props.characters.length;
      const a = Math.floor(random() * (length + 1)), b = Math.floor(random() * (length + 1));
      const [start, end] = a <= b ? [a, b] : [b, a];
      const op = random();
      if (op < 0.35) {
        const inserted = Array.from({length: 1 + Math.floor(random() * 4)}, () => pick(alphabet)).join('');
        const pending = random() < 0.2 ? ({style: pick(partials)} as RunOverride) : undefined;
        const o = pending ?? caretStyleAt(props, start, end);
        const typed = {style: {...props.style, ...(o?.style ?? {})}, fills: o?.fills ?? fills};
        props = insertText(props, start, end, inserted, pending);
        model = [...model.slice(0, start), ...Array.from({length: inserted.length}, () => typed), ...model.slice(end)];
      } else if (op < 0.5) {
        props = deleteRange(props, start, end);
        model = [...model.slice(0, start), ...model.slice(end)];
      } else if (op < 0.85) {
        const partial = pick(partials);
        const before = props;
        props = applyStyleToRange(props, start, end, partial);
        if (start < end || !before.characters.length) model = model.map((entry, i) => (i >= start && i < end ? {...entry, style: {...entry.style, ...partial}} : entry));
        if (!before.characters.length) assert.deepEqual({...props.style}, {...before.style, ...partial});
      } else {
        const paint = pick(paints);
        const result = applyFillsToRange(props, fills, start, end, paint);
        props = result.text;
        if (start < end) model = model.map((entry, i) => (i >= start && i < end ? {...entry, fills: paint} : entry));
        fills = result.fills;
      }
      assertNormalized(props, start === 0 && end === length ? fills : undefined);
      assert.equal(props.characters.length, model.length);
      const actual = resolved(props, fills);
      for (let i = 0; i < model.length; i++) {
        assert.ok(sameValue(actual[i].style, model[i].style), `round ${round} step ${step}: style of character ${i}`);
        assert.ok(sameValue(actual[i].fills, model[i].fills), `round ${round} step ${step}: paint of character ${i}`);
      }
      assert.equal(normalizeRuns(props), props, 'normalized runs are left alone');
    }
  }
});
