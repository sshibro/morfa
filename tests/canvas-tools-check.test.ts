import test from 'node:test';
import assert from 'node:assert/strict';
import {CANVAS_SPEC_CAPS, CANVAS_TOOL_CAPS, type CanvasNodeSpec} from '../shared/design/canvas-tools';
import {checkCanvasTool} from '../shared/design/canvas-tools-check';
import {checkNodeSpecs, normalizeColor} from '../shared/design/canvas-tools-spec';

// The canvas tools' inputs are checked before anything reaches a document: schema, caps, colours, fonts of the catalogue, parents that
// are earlier frames, and no URL, markup or control character anywhere (shared/design/canvas-tools-check.ts, canvas-tools-spec.ts).
// Slips a model really makes (a short colour, a size of 0, a text inside a shape, ids with dots, numbers as strings) are read as meant.

const FONTS = new Map(['Inter', 'Manrope', 'Montserrat'].map(family => [family.toLowerCase(), family]));
const font = (family: string) => FONTS.get(family.trim().toLowerCase()) ?? null;

type Spec = Record<string, unknown>;
const layout = (mode: string, gap: number, pad: number, primary = 'MIN', counter = 'CENTER') => ({mode, gap, padding: {top: pad, right: pad, bottom: pad, left: pad}, primaryAlign: primary, counterAlign: counter, wrap: false});
const textOf = (characters: string, fontSize: number, fontWeight = 400, color = '#141414', extra: Spec = {}) => ({characters, fontFamily: 'Inter', fontWeight, fontSize, lineHeight: null, letterSpacing: null, align: 'CENTER', color, ...extra});
const base = (id: string, parent: string | null, type: string, name: string, width: number, height: number, extra: Spec = {}): Spec => ({
  id, parent, type, name, x: 0, y: 0, width, height, fill: null, stroke: null, cornerRadius: null, opacity: null, layout: null, sizing: null, text: null, image: null, ...extra,
});

/** The specs of a valid login screen, as the spec schema asks (every field present). */
function loginScreen(): Spec[] {
  return [
    base('screen', null, 'FRAME', 'Sign in — Flora', 390, 844, {fill: '#FFFFFF', layout: layout('VERTICAL', 24, 32, 'CENTER'), sizing: {horizontal: 'FIXED', vertical: 'FIXED'}}),
    base('logo', 'screen', 'FRAME', 'Logo', 160, 48, {layout: layout('HORIZONTAL', 12, 0, 'CENTER'), sizing: {horizontal: 'HUG', vertical: 'HUG'}}),
    base('logo_mark', 'logo', 'ELLIPSE', 'Mark', 48, 48, {fill: '#E0457B'}),
    base('logo_word', 'logo', 'TEXT', 'Name', 96, 32, {sizing: {horizontal: 'HUG', vertical: 'HUG'}, text: textOf('Flora', 28, 700, '#141414')}),
    base('title', 'screen', 'TEXT', 'Heading', 326, 34, {sizing: {horizontal: 'FILL', vertical: 'HUG'}, text: textOf('Sign in with your phone number', 24, 600)}),
    base('phone', 'screen', 'FRAME', 'Phone field', 326, 56, {fill: '#F4F4F6', stroke: {color: '#E4E4E7', weight: 1}, cornerRadius: 12, layout: layout('HORIZONTAL', 8, 16, 'MIN'), sizing: {horizontal: 'FILL', vertical: 'FIXED'}}),
    base('phone_text', 'phone', 'TEXT', 'Number', 200, 24, {sizing: {horizontal: 'HUG', vertical: 'HUG'}, text: textOf('+7 (999) 000-00-00', 17, 400, '#6B6B76', {align: 'LEFT'})}),
    base('button', 'screen', 'FRAME', 'Button "Get code"', 326, 56, {fill: '#E0457B', cornerRadius: 28, layout: layout('HORIZONTAL', 8, 16, 'CENTER'), sizing: {horizontal: 'FILL', vertical: 'FIXED'}}),
    base('button_label', 'button', 'TEXT', 'Label', 140, 24, {sizing: {horizontal: 'HUG', vertical: 'HUG'}, text: textOf('Get code', 17, 600, '#FFFFFF')}),
    base('picture', 'screen', 'IMAGE', 'Bouquet', 326, 200, {cornerRadius: 20, image: {description: 'peony bouquet in kraft paper'}}),
  ];
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const at = (specs: Spec[], id: string) => specs.find(spec => spec.id === id)!;

function accepted(specs: unknown[]): CanvasNodeSpec[] {
  const checked = checkNodeSpecs(specs, font);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.problems.join(' '));
  if (!checked.ok) throw Error('refused');
  return checked.specs;
}

test('a valid login screen passes as it is', () => {
  const specs = accepted(loginScreen());
  assert.equal(specs.length, 10);
  assert.equal(specs.find(spec => spec.id === 'button_label')!.text!.characters, 'Get code');
  assert.deepEqual(specs.find(spec => spec.id === 'picture')!.image, {description: 'peony bouquet in kraft paper'});
});

test('the plausible slips of a real screen are normalised, never refused', () => {
  const specs = loginScreen();
  // A logo drawn as an ellipse holding its letter; a button as a rectangle holding its label.
  specs.splice(3, 0, base('logo_letter', 'logo_mark', 'TEXT', 'Letter', 20, 28, {text: textOf('F', 24, 700, '#FFF')}));
  Object.assign(at(specs, 'button'), {type: 'RECTANGLE', layout: null});
  // Colours in their usual other forms; an empty fill.
  Object.assign(at(specs, 'screen'), {fill: 'white'});
  Object.assign(at(specs, 'phone'), {fill: '#f4f4f6', stroke: {color: 'rgba(0, 0, 0, 0.08)', weight: 1}});
  Object.assign(at(specs, 'logo'), {fill: ''});
  // Sizes of 0 on hugging texts, a pill's radius of 9 999, an opacity in percent, a line height as a multiplier.
  Object.assign(at(specs, 'logo_word'), {width: 0, height: 0});
  Object.assign(at(specs, 'button'), {cornerRadius: 9999, opacity: 100});
  (at(specs, 'title').text as Spec).lineHeight = 1.3;
  const checked = accepted(specs);
  const spec = (id: string) => checked.find(item => item.id === id)!;
  assert.equal(spec('logo_mark').type, 'FRAME', 'an ellipse that holds a layer is a frame of the same look');
  assert.equal(spec('logo_mark').cornerRadius, 24);
  assert.equal(spec('logo_letter').parent, 'logo_mark');
  assert.equal(spec('logo_letter').text!.color, '#FFFFFF');
  assert.equal(spec('button').type, 'FRAME');
  assert.equal(spec('button_label').parent, 'button');
  assert.equal(spec('screen').fill, '#FFFFFF');
  assert.deepEqual([spec('phone').fill, spec('phone').stroke], ['#F4F4F6', {color: '#00000014', weight: 1}]);
  assert.equal(spec('logo').fill, null);
  assert.deepEqual([spec('logo_word').width, spec('logo_word').height], [1, 1]);
  assert.deepEqual([spec('button').cornerRadius, spec('button').opacity], [5000, 1]);
  assert.equal(spec('title').text!.lineHeight, 31.2);
});

test('ids, order and parents as a model may write them: made safe, unique, parents first, unknown or circular parents on the page', () => {
  const specs = loginScreen();
  // Children before their parents, ids with dots, Cyrillic and spaces (the Cyrillic id is kept on purpose), a duplicate, an unknown parent, a circle.
  const button = at(specs, 'button'),
    label = at(specs, 'button_label');
  const reordered = [label, ...specs.filter(spec => spec !== label)];
  Object.assign(button, {id: 'screen.button'});
  Object.assign(label, {id: 'кнопка текст', parent: 'screen.button'});
  reordered.push(base('title', 'screen', 'TEXT', 'Another heading', 100, 20, {text: textOf('Hello', 14)}));
  reordered.push(base('orphan', 'nowhere', 'RECTANGLE', 'Orphan', 10, 10, {fill: '#000000'}));
  reordered.push(base('a', 'b', 'FRAME', 'A', 10, 10), base('b', 'a', 'FRAME', 'B', 10, 10));
  const checked = accepted(reordered);
  const ids = checked.map(spec => spec.id);
  assert.equal(new Set(ids).size, ids.length, 'unique');
  assert.ok(ids.every(id => /^[A-Za-z0-9_-]{1,40}$/.test(id)));
  const buttonSpec = checked.find(spec => spec.name === 'Button "Get code"')!;
  const labelSpec = checked.find(spec => spec.name === 'Label')!;
  assert.equal(labelSpec.parent, buttonSpec.id);
  assert.ok(ids.indexOf(buttonSpec.id) < ids.indexOf(labelSpec.id), 'the parent first');
  assert.equal(checked.find(spec => spec.name === 'Orphan')!.parent, null);
  assert.equal(checked.filter(spec => spec.name === 'A' || spec.name === 'B').filter(spec => spec.parent === null).length, 1, 'the circle broken once');
});

test('numbers as strings, weights by name, enums in another case or by a synonym, extra and missing fields are read as meant', () => {
  const specs = loginScreen();
  Object.assign(at(specs, 'screen'), {width: '390', height: '844px', layout: {...layout('vertical', 24, 32, 'center', 'center'), gap: '24'}, shadow: {blur: 12}, sizing: {horizontal: 'fixed', vertical: 'fill_container'}});
  Object.assign(at(specs, 'phone'), {layout: layout('row', 8, 16, 'start', 'center')});
  Object.assign(at(specs, 'button'), {layout: layout('HORIZONTAL', 8, 16, 'space-between', 'middle')});
  Object.assign(at(specs, 'title').text as Spec, {fontWeight: 'semibold', fontSize: '24', align: 'center'});
  const picture = at(specs, 'picture');
  delete picture.stroke;
  delete picture.opacity;
  Object.assign(picture, {type: 'image'});
  specs.push(base('divider', 'screen', 'LINE', 'Divider', 326, 1, {fill: '#E4E4E7'}));
  const checked = accepted(specs);
  const spec = (id: string) => checked.find(item => item.id === id)!;
  assert.deepEqual([spec('screen').width, spec('screen').height, spec('screen').layout!.mode, spec('screen').layout!.gap, spec('screen').layout!.primaryAlign], [390, 844, 'VERTICAL', 24, 'CENTER']);
  assert.equal(spec('phone').layout!.mode, 'HORIZONTAL');
  assert.equal(spec('phone').layout!.primaryAlign, 'MIN');
  assert.deepEqual([spec('button').layout!.primaryAlign, spec('button').layout!.counterAlign], ['SPACE_BETWEEN', 'CENTER']);
  assert.deepEqual([spec('title').text!.fontWeight, spec('title').text!.fontSize, spec('title').text!.align], [600, 24, 'CENTER']);
  assert.equal(spec('picture').type, 'IMAGE');
  assert.equal(spec('divider').type, 'RECTANGLE');
  assert.equal('shadow' in spec('screen'), false, 'an unknown field never gets through');
});

test('a text layer without its text, an image without its description, over-long texts and too many layers are fixed, not refused', () => {
  const specs = loginScreen();
  Object.assign(at(specs, 'title'), {text: null});
  Object.assign(at(specs, 'picture'), {image: null});
  (at(specs, 'phone_text').text as Spec).characters = 'a'.repeat(CANVAS_SPEC_CAPS.chars + 500);
  const many = Array.from({length: CANVAS_SPEC_CAPS.nodes + 20}, (_, i) => base('dot' + i, 'screen', 'RECTANGLE', 'Dot', 4, 4, {fill: '#000000'}));
  const checked = accepted([...specs, ...many]);
  const spec = (id: string) => checked.find(item => item.id === id)!;
  assert.equal(spec('title').text!.characters, 'Heading', 'its name as its text');
  assert.equal(spec('picture').image!.description, 'Bouquet');
  assert.equal([...spec('phone_text').text!.characters].length, CANVAS_SPEC_CAPS.chars);
  assert.equal(checked.length, CANVAS_SPEC_CAPS.nodes);
  const unknownFont = clone(loginScreen());
  (at(unknownFont, 'title').text as Spec).fontFamily = 'Comic Sans MS';
  assert.equal(accepted(unknownFont).find(spec => spec.id === 'title')!.text!.fontFamily, 'Inter', 'an unknown family becomes the default one');
});

test('a link, markup or a control character is refused, wherever it hides; a carriage return is a line break', () => {
  for (const characters of ['Read more at https://evil.example', '<img src=x onerror=alert(1)>', 'Price‮per', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=']) {
    const specs = loginScreen();
    (at(specs, 'button_label').text as Spec).characters = characters;
    const checked = checkNodeSpecs(specs, font);
    assert.equal(checked.ok, false, characters);
    assert.ok(!checked.ok && checked.problems.every(problem => problem.startsWith('create[8].text.characters')), JSON.stringify(!checked.ok && checked.problems));
  }
  const named = loginScreen();
  at(named, 'title').name = 'www.evil.example';
  assert.equal(checkNodeSpecs(named, font).ok, false, 'in a name');
  const described = loginScreen();
  at(described, 'picture').image = {description: 'see http://x.example/a.png'};
  assert.equal(checkNodeSpecs(described, font).ok, false, 'in a picture description');
  // Ordinary text with a colon, a time or an English label is not a URL.
  const fine = loginScreen();
  (at(fine, 'title').text as Spec).characters = 'Data: 10:30, File: report.pdf\nfoo.test';
  assert.equal(checkNodeSpecs(fine, font).ok, true);
  const crlf = loginScreen();
  (at(crlf, 'title').text as Spec).characters = 'Sign in\r\nwith a phone';
  assert.equal(accepted(crlf).find(spec => spec.id === 'title')!.text!.characters, 'Sign in\nwith a phone');
});

test('one odd layer is left out and the rest stays; a list that is not a list is the schema\'s refusal', () => {
  const odd = loginScreen();
  odd.push({id: 'broken', type: 42});
  assert.equal(accepted(odd).length, 10);
  const checked = checkCanvasTool('create_layers', 'x', {parent: null, layers: 'all of it'}, font);
  assert.deepEqual(!checked.ok && checked.problems, ['layers: a list.']);
});

test('colours in the forms a model writes', () => {
  assert.deepEqual(['#fff', '#FFFA', 'e0457b', '#E0457B80', 'rgb(224, 69, 123)', 'rgba(0,0,0,0.5)', 'rgba(0 0 0 / 50%)', 'Black', 'transparent'].map(normalizeColor),
    ['#FFFFFF', '#FFFFFFAA', '#E0457B', '#E0457B80', '#E0457B', '#00000080', '#00000080', '#000000', '#00000000']);
  assert.deepEqual(['bad', 'fff', '#12345', 'hsl(0,0%,0%)', ''].map(normalizeColor), [null, null, null, null, null]);
});

test('create_layers: missing optional fields get their neutral values, and a section may fill the frame it is built into', () => {
  const layers = [
    {id: 'a', type: 'FRAME', width: 100, height: 50, layout: {mode: 'VERTICAL'}, sizing: {horizontal: 'FILL', vertical: 'HUG'}},
    {id: 'b', parent: 'a', type: 'TEXT', width: 80, height: 20, text: {characters: 'Hi'}},
  ];
  const onPage = checkCanvasTool('create_layers', 'c1', {parent: null, layers}, font);
  assert.ok(onPage.ok && onPage.call.name === 'create_layers');
  if (!onPage.ok || onPage.call.name !== 'create_layers') return;
  const [a, b] = onPage.call.input.layers;
  assert.deepEqual(a!.sizing, {horizontal: 'FIXED', vertical: 'HUG'}, 'FILL needs a parent with a layout: fixed on the page');
  assert.deepEqual(a!.layout, {mode: 'VERTICAL', gap: 0, padding: {top: 0, right: 0, bottom: 0, left: 0}, primaryAlign: 'MIN', counterAlign: 'MIN', wrap: false});
  assert.equal(b!.name, 'TEXT');
  assert.deepEqual([b!.text!.fontFamily, b!.text!.fontSize, b!.text!.color], ['Inter', 16, '#111111']);
  const inFrame = checkCanvasTool('create_layers', 'c2', {parent: 'L12', layers}, font);
  assert.ok(inFrame.ok && inFrame.call.name === 'create_layers' && inFrame.call.input.layers[0]!.sizing!.horizontal === 'FILL', 'kept inside an existing frame');
});

test('update_layers and the other tools: ranges, aliases, fonts of the catalogue and the caps', () => {
  const bad = checkCanvasTool('update_layers', 'u', {updates: [{id: 'screen', width: 0, fill: 'red', text: {fontFamily: 'Papyrus'}}, {id: 'L1'}]}, font);
  assert.equal(bad.ok, false);
  const problems = !bad.ok ? bad.problems.join(' ') : '';
  assert.match(problems, /updates\[0\]\.id: a layer id such as "L12"/);
  assert.match(problems, /width: a number from 1 to 10000/);
  assert.match(problems, /fill: a colour is #RRGGBB/);
  assert.match(problems, /fontFamily: a family of the font catalogue/);
  assert.match(problems, /updates\[1\]: no field to change/);
  const good = checkCanvasTool('update_layers', 'u', {updates: [{id: 'L1', fill: '#abcdef', text: {fontFamily: 'manrope', fontWeight: 640}}]}, font);
  assert.ok(good.ok && good.call.name === 'update_layers');
  if (good.ok && good.call.name === 'update_layers') assert.deepEqual(good.call.input.updates[0], {id: 'L1', fill: '#ABCDEF', text: {fontFamily: 'Manrope', fontWeight: 600}});
  assert.equal(checkCanvasTool('delete_layers', 'd', {ids: Array.from({length: CANVAS_TOOL_CAPS.deletes + 1}, (_, i) => `L${i + 1}`)}, font).ok, false);
  assert.equal(checkCanvasTool('duplicate_layers', 'd', {ids: ['L1', 'nope']}, font).ok, false);
  const palette = checkCanvasTool('add_color_styles', 'p', {colors: [{name: '', color: '#abc123'}]}, font);
  assert.ok(palette.ok && palette.call.name === 'add_color_styles');
  if (palette.ok && palette.call.name === 'add_color_styles') assert.deepEqual(palette.call.input, {group: 'Palette', colors: [{name: 'Color 1', color: '#ABC123'}]});
  assert.deepEqual(!checkCanvasTool('paint', 'x', {}, font).ok && 'refused', 'refused');
});
