import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid, BLACK} from '../shared/design/defaults';
import type {AutoLayout, DesignDocument, NodeType, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {layoutText, textBoxSize} from '../shared/design/text-layout';
import {normalizeDocument} from '../shared/design/normalize';
import {boundsOf} from '../shared/design/constraints';
import {canFill, canHug, effectiveSizing, layoutFrame, layoutSizingUpdates, sizingFixes, textSizing} from '../shared/design/layout';

// Auto layout against Figma's behaviour. Text sizes come from the text-layout module itself, so
// the expectations hold whichever line breaker is installed; the fake measurer gives every
// character half the font size and puts 80 % of the size above the baseline.

const measurer: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.5,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

function build() {
  const doc = createDocument('page');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: string}, parentId = 'page') => {
    const node = createNode(type, {...props, parentId});
    doc.nodes[node.id] = node;
    doc.nodes[parentId].children!.push(node.id);
    return node;
  };
  return {doc, add};
}

const auto = (mode: 'HORIZONTAL' | 'VERTICAL', props: Partial<AutoLayout> = {}): AutoLayout => ({...defaultAutoLayout(mode), ...props});
const hug = {layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'} as const;
const text = (characters: string, size = 16) => ({text: {...defaultTextProps(characters), style: {...defaultTextProps().style, fontSize: size}}});
const everything = (doc: DesignDocument) => new Set(Object.keys(doc.nodes));
const normalize = (doc: DesignDocument) => normalizeDocument(doc, everything(doc), {measurer});
const natural = (node: SceneNode) => textBoxSize({...node, text: {...node.text!, textAutoResize: 'WIDTH_AND_HEIGHT'}}, measurer);

function near(actual: number, expected: number, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≠ ${expected}`);
}
function nearBox(node: SceneNode, expected: Partial<Record<'x' | 'y' | 'width' | 'height', number>>, label = node.id) {
  for (const [key, value] of Object.entries(expected)) near(node[key as 'x'], value, `${label}.${key}`);
}

test('a hugging row: padding, spacing, centred cross axis, text at its natural size', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', x: 100, y: 50, ...hug, autoLayout: auto('HORIZONTAL', {paddingLeft: 10, paddingRight: 12, paddingTop: 5, paddingBottom: 7, itemSpacing: 8, counterAxisAlignItems: 'CENTER'})});
  add('RECTANGLE', {id: 'a', width: 20, height: 30}, 'f');
  const t = add('TEXT', {id: 't', ...text('Hello')}, 'f');
  add('RECTANGLE', {id: 'b', width: 40, height: 10}, 'f');
  const out = normalize(doc);
  const size = natural(t);
  const inner = Math.max(30, size.height, 10);
  nearBox(out.nodes.f, {x: 100, y: 50, width: 10 + 20 + 8 + size.width + 8 + 40 + 12, height: 5 + inner + 7});
  nearBox(out.nodes.a, {x: 10, y: 5 + (inner - 30) / 2, width: 20, height: 30});
  nearBox(out.nodes.t, {x: 38, y: 5 + (inner - size.height) / 2, width: size.width, height: size.height});
  nearBox(out.nodes.b, {x: 38 + size.width + 8, y: 5 + (inner - 10) / 2});
  assert.equal(normalize(out), out, 'normalizing a laid-out document changes nothing');
});

test('a fixed column aligns on both axes and SPACE_BETWEEN spreads the leftover', () => {
  for (const [align, first] of [['MIN', 10], ['CENTER', 10 + (200 - 20 - 60 - 10) / 2], ['MAX', 200 - 10 - 60 - 10]] as const) {
    const {doc, add} = build();
    add('FRAME', {id: 'f', width: 120, height: 200, autoLayout: auto('VERTICAL', {paddingTop: 10, paddingBottom: 10, itemSpacing: 10, primaryAxisAlignItems: align, counterAxisAlignItems: 'MAX'})});
    add('RECTANGLE', {id: 'a', width: 50, height: 20}, 'f');
    add('RECTANGLE', {id: 'b', width: 30, height: 40}, 'f');
    const out = normalize(doc);
    nearBox(out.nodes.f, {width: 120, height: 200});
    nearBox(out.nodes.a, {x: 70, y: first}, `a@${align}`);
    nearBox(out.nodes.b, {x: 90, y: first + 30}, `b@${align}`);
  }
  const {doc, add} = build();
  add('FRAME', {id: 'f', width: 300, height: 40, autoLayout: auto('HORIZONTAL', {itemSpacing: 99, primaryAxisAlignItems: 'SPACE_BETWEEN'})});
  for (const id of ['a', 'b', 'c']) add('RECTANGLE', {id, width: 40, height: 40}, 'f');
  const out = normalize(doc);
  assert.deepEqual(['a', 'b', 'c'].map(id => out.nodes[id].x), [0, 130, 260]);
});

test('FILL children share the free main-axis space equally and stretch across', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', width: 300, height: 100, autoLayout: auto('HORIZONTAL', {itemSpacing: 10, paddingTop: 10, paddingBottom: 10})});
  add('RECTANGLE', {id: 'fixed', width: 50, height: 20}, 'f');
  add('RECTANGLE', {id: 'one', width: 5, height: 20, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL'}, 'f');
  add('RECTANGLE', {id: 'two', width: 500, height: 20, layoutSizingHorizontal: 'FILL'}, 'f');
  const out = normalize(doc);
  nearBox(out.nodes.one, {x: 60, y: 10, width: 115, height: 80});
  nearBox(out.nodes.two, {x: 185, width: 115, height: 20});
});

test('min and max widths clamp FILL children and the rest take what they leave', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', width: 300, height: 20, autoLayout: auto('HORIZONTAL')});
  add('RECTANGLE', {id: 'capped', layoutSizingHorizontal: 'FILL', maxWidth: 50}, 'f');
  add('RECTANGLE', {id: 'b', layoutSizingHorizontal: 'FILL'}, 'f');
  add('RECTANGLE', {id: 'c', layoutSizingHorizontal: 'FILL'}, 'f');
  let out = normalize(doc);
  assert.deepEqual(['capped', 'b', 'c'].map(id => out.nodes[id].width), [50, 125, 125]);

  const second = build();
  second.add('FRAME', {id: 'f', width: 300, height: 20, autoLayout: auto('HORIZONTAL')});
  second.add('RECTANGLE', {id: 'wide', layoutSizingHorizontal: 'FILL', minWidth: 200}, 'f');
  second.add('RECTANGLE', {id: 'b', layoutSizingHorizontal: 'FILL'}, 'f');
  second.add('RECTANGLE', {id: 'c', layoutSizingHorizontal: 'FILL', minWidth: 60}, 'f');
  out = normalize(second.doc);
  assert.deepEqual(['wide', 'b', 'c'].map(id => out.nodes[id].width), [200, 40, 60]);
  assert.deepEqual(['wide', 'b', 'c'].map(id => out.nodes[id].x), [0, 200, 240]);
});

test('a hugging frame clamps to its min and max, and a FIXED child to its limits', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', ...hug, minWidth: 100, autoLayout: auto('HORIZONTAL', {primaryAxisAlignItems: 'CENTER'})});
  add('RECTANGLE', {id: 'a', width: 20, height: 10}, 'f');
  add('FRAME', {id: 'g', ...hug, maxWidth: 30, autoLayout: auto('HORIZONTAL')});
  add('RECTANGLE', {id: 'b', width: 50, height: 10, maxHeight: 4}, 'g');
  const out = normalize(doc);
  nearBox(out.nodes.f, {width: 100, height: 10});
  nearBox(out.nodes.a, {x: 40});
  nearBox(out.nodes.g, {width: 30, height: 4});
  nearBox(out.nodes.b, {width: 50, height: 4});
});

test('a hugging column takes the widest content and FILL children stretch to it', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'list', ...hug, autoLayout: auto('VERTICAL', {paddingLeft: 8, paddingRight: 8, itemSpacing: 4})});
  const title = add('TEXT', {id: 'title', ...text('A long heading')}, 'list');
  add('LINE', {id: 'rule', width: 3, layoutSizingHorizontal: 'FILL'}, 'list');
  add('RECTANGLE', {id: 'box', width: 10, height: 10}, 'list');
  const out = normalize(doc);
  const size = natural(title);
  nearBox(out.nodes.list, {width: size.width + 16, height: size.height + 4 + 0 + 4 + 10});
  nearBox(out.nodes.rule, {x: 8, y: size.height + 4, width: size.width, height: 0});
  nearBox(out.nodes.box, {x: 8, y: size.height + 8});
});

test('nested auto layout: a hugging parent sizes a FILL child, whose text wraps at the width it gets', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'card', ...hug, autoLayout: auto('VERTICAL', {paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16, itemSpacing: 8})});
  const heading = add('TEXT', {id: 'heading', ...text('Card heading', 24)}, 'card');
  add('FRAME', {id: 'row', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', autoLayout: auto('HORIZONTAL', {itemSpacing: 6})}, 'card');
  add('RECTANGLE', {id: 'icon', width: 16, height: 16}, 'row');
  const body = add('TEXT', {id: 'body', ...text('Description that takes up the rest of the row'), layoutSizingHorizontal: 'FILL'}, 'row');
  const out = normalize(doc);
  const width = natural(heading).width;
  nearBox(out.nodes.row, {x: 16, width});
  const bodyWidth = width - 16 - 6;
  const bodyHeight = textBoxSize({...body, width: bodyWidth, text: {...body.text!, textAutoResize: 'HEIGHT'}}, measurer).height;
  nearBox(out.nodes.body, {x: 22, width: bodyWidth, height: bodyHeight});
  assert.equal(out.nodes.body.text!.textAutoResize, 'HEIGHT', 'a text filling the width grows in height');
  nearBox(out.nodes.card, {width: width + 32, height: 16 + natural(heading).height + 8 + Math.max(16, bodyHeight) + 16});
  assert.equal(normalize(out), out);
});

test('wrap breaks rows by width and stacks them with the row gap or spreads them', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', width: 100, layoutSizingVertical: 'HUG', autoLayout: auto('HORIZONTAL', {layoutWrap: 'WRAP', itemSpacing: 10, counterAxisSpacing: 5})});
  for (const id of ['a', 'b', 'c', 'd', 'e']) add('RECTANGLE', {id, width: 40, height: id === 'b' ? 30 : 20}, 'f');
  let out = normalize(doc);
  nearBox(out.nodes.f, {width: 100, height: 30 + 5 + 20 + 5 + 20});
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(id => [out.nodes[id].x, out.nodes[id].y]), [[0, 0], [50, 0], [0, 35], [50, 35], [0, 60]]);

  const spread = build();
  spread.add('FRAME', {id: 'f', width: 100, height: 100, autoLayout: auto('HORIZONTAL', {layoutWrap: 'WRAP', itemSpacing: 10, counterAxisSpacing: 5, counterAxisAlignContent: 'SPACE_BETWEEN', counterAxisAlignItems: 'CENTER', primaryAxisAlignItems: 'MAX'})});
  for (const id of ['a', 'b', 'c']) spread.add('RECTANGLE', {id, width: 40, height: id === 'b' ? 30 : 20}, 'f');
  out = normalize(spread.doc);
  assert.deepEqual(['a', 'b', 'c'].map(id => [out.nodes[id].x, out.nodes[id].y]), [[10, 5], [60, 0], [60, 80]]);
});

test('FILL children in a wrapping row break at their min width and share each row', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'grid', width: 330, layoutSizingVertical: 'HUG', autoLayout: auto('HORIZONTAL', {layoutWrap: 'WRAP', itemSpacing: 10, counterAxisSpacing: 10})});
  for (const id of ['a', 'b', 'c', 'd']) add('RECTANGLE', {id, height: 50, layoutSizingHorizontal: 'FILL', minWidth: 100}, 'grid');
  const out = normalize(doc);
  near(out.nodes.a.width, 310 / 3, 'a');
  near(out.nodes.c.x, 2 * (310 / 3 + 10), 'c.x');
  near(out.nodes.d.width, 330, 'd fills its own row');
  near(out.nodes.d.y, 60, 'd.y');
  near(out.nodes.grid.height, 110, 'grid');
});

test('absolute children skip the flow and follow constraints as a hugging frame grows', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'button', width: 50, height: 20, ...hug, autoLayout: auto('HORIZONTAL')});
  add('RECTANGLE', {id: 'label', width: 50, height: 20}, 'button');
  add('ELLIPSE', {id: 'badge', x: 40, y: -5, width: 10, height: 10, layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'MAX', vertical: 'MIN'}}, 'button');
  let out = normalize(doc);
  nearBox(out.nodes.button, {width: 50, height: 20});
  nearBox(out.nodes.badge, {x: 40, y: -5});
  const grown = structuredClone(out);
  const extra = createNode('RECTANGLE', {id: 'extra', parentId: 'button', width: 30, height: 20});
  grown.nodes.extra = extra;
  grown.nodes.button.children = ['label', 'extra', 'badge'];
  out = normalizeDocument(grown, new Set(['extra', 'button']), {measurer});
  nearBox(out.nodes.button, {width: 80});
  nearBox(out.nodes.extra, {x: 50});
  nearBox(out.nodes.badge, {x: 70, y: -5});
});

test('hidden children take no space and no gap', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', ...hug, autoLayout: auto('HORIZONTAL', {itemSpacing: 10})});
  add('RECTANGLE', {id: 'a', width: 10, height: 10}, 'f');
  add('RECTANGLE', {id: 'hidden', width: 99, height: 99, visible: false}, 'f');
  add('RECTANGLE', {id: 'b', width: 10, height: 10}, 'f');
  const out = normalize(doc);
  nearBox(out.nodes.f, {width: 30, height: 10});
  nearBox(out.nodes.b, {x: 20});
});

test('strokes included in layout count the frame\'s inside stroke and the children\'s outside strokes', () => {
  const {doc, add} = build();
  const stroke = [solid(BLACK)];
  add('FRAME', {id: 'f', ...hug, strokes: stroke, strokeWeight: 2, strokeAlign: 'INSIDE', autoLayout: auto('HORIZONTAL', {itemSpacing: 4, strokesIncludedInLayout: true})});
  add('RECTANGLE', {id: 'a', width: 10, height: 10, strokes: stroke, strokeWeight: 3, strokeAlign: 'OUTSIDE'}, 'f');
  add('RECTANGLE', {id: 'b', width: 10, height: 10, strokes: stroke, strokeWeight: 4, strokeAlign: 'CENTER'}, 'f');
  let out = normalize(doc);
  nearBox(out.nodes.a, {x: 5, y: 5});
  nearBox(out.nodes.b, {x: 2 + 3 + 10 + 3 + 4 + 2, y: 2 + 2});
  nearBox(out.nodes.f, {width: 2 + 16 + 4 + 14 + 2, height: 2 + 16 + 2});
  out = normalize({...doc, nodes: {...doc.nodes, f: {...doc.nodes.f, autoLayout: auto('HORIZONTAL', {itemSpacing: 4})}}});
  nearBox(out.nodes.a, {x: 0, y: 0});
  nearBox(out.nodes.f, {width: 24, height: 10});
});

test('a rotated child takes its rotated bounding box in the flow', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', ...hug, autoLayout: auto('HORIZONTAL', {paddingLeft: 5, itemSpacing: 2})});
  add('RECTANGLE', {id: 'turned', width: 20, height: 10, rotation: 90}, 'f');
  add('RECTANGLE', {id: 'tilted', width: 10, height: 10, rotation: 45, layoutSizingHorizontal: 'FILL'}, 'f');
  add('RECTANGLE', {id: 'flat', width: 10, height: 5}, 'f');
  const out = normalize(doc);
  const turned = boundsOf(out.nodes.turned), tilted = boundsOf(out.nodes.tilted);
  near(turned.x, 5, 'turned.x');
  near(turned.y, 0, 'turned.y');
  near(turned.width, 10, 'turned.width');
  near(turned.height, 20, 'turned.height');
  near(tilted.x, 17, 'tilted.x');
  near(tilted.width, Math.SQRT2 * 10, 'tilted stays its size: a turned child cannot fill');
  assert.equal(out.nodes.tilted.layoutSizingHorizontal, 'FIXED');
  near(out.nodes.flat.x, 17 + Math.SQRT2 * 10 + 2, 'flat.x');
  near(out.nodes.f.height, 20, 'f.height');
});

test('BASELINE lines up the first baselines of texts of different sizes; shapes sit on it', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', ...hug, autoLayout: auto('HORIZONTAL', {itemSpacing: 8, counterAxisAlignItems: 'BASELINE', paddingTop: 4})});
  const small = add('TEXT', {id: 'small', ...text('Price', 14)}, 'f');
  const big = add('TEXT', {id: 'big', ...text('$990', 40)}, 'f');
  add('RECTANGLE', {id: 'dot', width: 6, height: 6}, 'f');
  const out = normalize(doc);
  const baseline = (node: SceneNode) => layoutText(node, measurer, null).lines[0].baseline;
  const line = out.nodes.big.y + baseline(big);
  near(out.nodes.big.y, 4, 'the tallest ascent sets the line');
  near(out.nodes.small.y + baseline(small), line, 'small text');
  near(out.nodes.dot.y + 6, line, 'a shape sits on the baseline by its bottom');
});

test('text sizing follows Figma: HUG is auto width, FILL width is auto height, max width wraps', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', width: 400, ...{layoutSizingVertical: 'HUG'}, autoLayout: auto('VERTICAL')});
  const capped = add('TEXT', {id: 'capped', ...text('Text that runs into the maximum'), maxWidth: 120}, 'f');
  add('TEXT', {id: 'filled', ...text('Full width'), layoutSizingHorizontal: 'FILL'}, 'f');
  add('TEXT', {id: 'tall', ...text('Height'), layoutSizingVertical: 'FILL'}, 'f');
  const out = normalize(doc);
  near(out.nodes.capped.width, 120, 'capped width');
  near(out.nodes.capped.height, textBoxSize({...capped, width: 120, text: {...capped.text!, textAutoResize: 'HEIGHT'}}, measurer).height, 'capped height');
  near(out.nodes.filled.width, 400, 'filled width');
  assert.equal(out.nodes.filled.text!.textAutoResize, 'HEIGHT');
  assert.equal(out.nodes.tall.text!.textAutoResize, 'NONE', 'a text filling the height is fixed');
  assert.deepEqual(textSizing(out.nodes.tall, out.nodes.f), {textAutoResize: 'NONE', horizontal: 'FIXED', vertical: 'FILL'});
});

test('a frame that hugs its main axis gives FILL children their content size', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'pill', ...hug, autoLayout: auto('HORIZONTAL', {paddingLeft: 12, paddingRight: 12})});
  const label = add('TEXT', {id: 'label', ...text('Button'), layoutSizingHorizontal: 'FILL'}, 'pill');
  const out = normalize(doc);
  near(out.nodes.label.width, natural(label).width, 'label');
  near(out.nodes.pill.width, natural(label).width + 24, 'pill');
  assert.equal(normalize(out), out);
});

test('negative spacing overlaps items; VERTICAL ignores WRAP', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'avatars', ...hug, autoLayout: auto('HORIZONTAL', {itemSpacing: -8})});
  for (const id of ['a', 'b', 'c']) add('ELLIPSE', {id, width: 32, height: 32}, 'avatars');
  add('FRAME', {id: 'col', width: 10, layoutSizingVertical: 'HUG', autoLayout: auto('VERTICAL', {layoutWrap: 'WRAP'})});
  for (const id of ['d', 'e']) add('RECTANGLE', {id, width: 10, height: 10}, 'col');
  const out = normalize(doc);
  near(out.nodes.avatars.width, 32 * 3 - 16, 'avatars');
  near(out.nodes.c.x, 48, 'c');
  near(out.nodes.col.height, 20, 'col');
});

test('layoutFrame lays out one chain and reports only the fields that changed', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', width: 10, height: 10, ...hug, autoLayout: auto('HORIZONTAL', {itemSpacing: 5})});
  add('RECTANGLE', {id: 'a', x: 99, y: 99, width: 10, height: 10}, 'f');
  add('RECTANGLE', {id: 'b', x: 15, y: 0, width: 10, height: 10}, 'f');
  add('RECTANGLE', {id: 'outside', x: 500, width: 10, height: 10});
  const updates = layoutFrame(doc, 'f', measurer);
  assert.deepEqual(Object.fromEntries(updates), {f: {width: 25}, a: {x: 0, y: 0}});
});

test('sizing options and their corrections', () => {
  const {doc, add} = build();
  const frame = add('FRAME', {id: 'f', autoLayout: auto('HORIZONTAL')});
  const plain = add('FRAME', {id: 'plain', layoutSizingHorizontal: 'HUG'});
  const label = add('TEXT', {id: 't', ...text('Hi')}, 'f');
  const line = add('LINE', {id: 'line'}, 'f');
  const free = add('RECTANGLE', {id: 'free', layoutSizingHorizontal: 'FILL'});
  assert.equal(canHug(frame), true);
  assert.equal(canHug(plain), false);
  assert.equal(canHug(label), true);
  assert.equal(canFill(label, frame), true);
  assert.equal(canFill(line, frame, 'vertical'), false);
  assert.equal(canFill(free, doc.nodes.page), false);
  assert.equal(effectiveSizing(plain, doc.nodes.page, 'horizontal'), 'FIXED');
  assert.deepEqual(sizingFixes(free, doc.nodes.page), {layoutSizingHorizontal: 'FIXED'});
  assert.equal(sizingFixes(label, frame), null);

  let updates = layoutSizingUpdates(doc, 't', 'horizontal', 'FIXED');
  assert.deepEqual(updates.get('t'), {layoutSizingHorizontal: 'FIXED', text: {...label.text!, textAutoResize: 'HEIGHT'}});
  updates = layoutSizingUpdates(doc, 't', 'vertical', 'FIXED');
  assert.equal(updates.get('t')!.text!.textAutoResize, 'NONE');
  assert.equal(updates.get('t')!.layoutSizingHorizontal, 'FIXED');
  assert.equal(layoutSizingUpdates(doc, 'plain', 'horizontal', 'HUG').size, 0, 'no HUG without auto layout');

  // A new document, as every edit makes one (the engine's shadow follows documents, not in-place writes).
  const hugging = {...doc, nodes: {...doc.nodes, f: {...doc.nodes.f, ...hug}}};
  updates = layoutSizingUpdates(hugging, 't', 'horizontal', 'FILL');
  assert.equal(updates.get('t')!.layoutSizingHorizontal, 'FILL');
  assert.equal(updates.get('f')!.layoutSizingHorizontal, 'FIXED', 'filling a hugging parent\'s main axis makes it fixed');
  updates = layoutSizingUpdates(hugging, 't', 'vertical', 'FILL');
  assert.equal(updates.has('f'), false, 'the cross axis may hug around filling children');
});

test('a change deep in hugging frames re-lays-out the chain up to the first fixed frame', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'page-frame', width: 800, height: 600, autoLayout: auto('VERTICAL', {itemSpacing: 10})});
  add('FRAME', {id: 'outer', ...hug, autoLayout: auto('VERTICAL', {paddingLeft: 4, paddingRight: 4})}, 'page-frame');
  add('FRAME', {id: 'inner', ...hug, autoLayout: auto('HORIZONTAL')}, 'outer');
  add('TEXT', {id: 't', ...text('ab')}, 'inner');
  add('RECTANGLE', {id: 'below', width: 10, height: 10}, 'page-frame');
  const laidOut = normalize(doc);
  const edited = structuredClone(laidOut);
  edited.nodes.t.text!.characters = 'abcdefgh';
  const out = normalizeDocument(edited, new Set(['t']), {measurer});
  const size = natural(out.nodes.t);
  near(out.nodes.inner.width, size.width, 'inner');
  near(out.nodes.outer.width, size.width + 8, 'outer');
  near(out.nodes.below.y, size.height + 10, 'the fixed frame moves the next child');
  nearBox(out.nodes['page-frame'], {width: 800, height: 600});
});

test('edge cases: one child under SPACE_BETWEEN, only-filling children in a hugging frame, filled heights in wrapped rows', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'one', width: 200, height: 20, autoLayout: auto('HORIZONTAL', {primaryAxisAlignItems: 'SPACE_BETWEEN'})});
  add('RECTANGLE', {id: 'only', width: 20, height: 20}, 'one');
  add('FRAME', {id: 'fills', ...hug, autoLayout: auto('VERTICAL')});
  add('RECTANGLE', {id: 'f1', width: 30, height: 10, layoutSizingHorizontal: 'FILL'}, 'fills');
  add('RECTANGLE', {id: 'f2', width: 50, height: 10, layoutSizingHorizontal: 'FILL'}, 'fills');
  add('FRAME', {id: 'rows', width: 100, layoutSizingVertical: 'HUG', autoLayout: auto('HORIZONTAL', {layoutWrap: 'WRAP'})});
  add('RECTANGLE', {id: 'tall', width: 60, height: 40}, 'rows');
  add('RECTANGLE', {id: 'stretched', width: 40, height: 5, layoutSizingVertical: 'FILL'}, 'rows');
  add('RECTANGLE', {id: 'next', width: 60, height: 10}, 'rows');
  add('RECTANGLE', {id: 'stretched2', width: 40, height: 5, layoutSizingVertical: 'FILL'}, 'rows');
  const out = normalize(doc);
  near(out.nodes.only.x, 0, 'a single child starts at the start');
  near(out.nodes.fills.width, 50, 'filling children keep the frame at the widest of them');
  near(out.nodes.f1.width, 50, 'and fill it');
  nearBox(out.nodes.stretched, {x: 60, y: 0, height: 40}, 'stretched');
  nearBox(out.nodes.stretched2, {x: 60, y: 40, height: 10}, 'stretched2');
  near(out.nodes.rows.height, 50, 'rows');
  assert.equal(normalize(out), out);
});

test('instances and components lay out like frames; a hidden frame still lays out', () => {
  const {doc, add} = build();
  add('COMPONENT', {id: 'button', ...hug, autoLayout: auto('HORIZONTAL', {paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8})});
  add('RECTANGLE', {id: 'icon', width: 20, height: 20}, 'button');
  add('INSTANCE', {id: 'copy', ...hug, visible: false, componentId: 'button', autoLayout: auto('VERTICAL', {itemSpacing: 4}), overrides: ['autoLayout']});
  add('RECTANGLE', {id: 'copy;icon', width: 20, height: 20, mainId: 'icon'}, 'copy');
  add('RECTANGLE', {id: 'copy;extra', width: 30, height: 10}, 'copy');
  const out = normalize(doc);
  nearBox(out.nodes.button, {width: 52, height: 36});
  nearBox(out.nodes.copy, {width: 30, height: 34});
  nearBox(out.nodes['copy;extra'], {y: 24});
});
