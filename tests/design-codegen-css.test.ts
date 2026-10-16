import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, defaultAutoLayout, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, Effect, GradientPaint, ImagePaint, SceneNode} from '../shared/design/types';
import {cssForLayers, nodeToCss, type Decl} from '../shared/design/codegen/css';
import {gradientCss} from '../shared/design/codegen/values';
import {add} from './design-codegen-fixture';

// The CSS of one layer, as dev mode shows it: every property family, and how sizing and constraints
// become flexbox and absolute positioning.

const RED = {r: 1, g: 0, b: 0};
const BLUE = {r: 0, g: 0, b: 1};

/** prop → value of a layer's declarations. */
function css(doc: DesignDocument, id: string): Record<string, string> {
  return Object.fromEntries(nodeToCss(doc, id, {tokens: false}).map((decl: Decl) => [decl.prop, decl.value]));
}

function frame(props: Partial<Omit<SceneNode, 'id' | 'parentId'>> = {}): DesignDocument {
  return add(createDocument('p'), 'FRAME', {id: 'f', parentId: 'p', width: 400, height: 300, fills: [], ...props});
}

const autoLayout = (props: Partial<SceneNode['autoLayout'] & object> = {}) => ({...defaultAutoLayout('HORIZONTAL'), ...props});

test('auto layout becomes flex: direction, gap, padding, alignment', () => {
  const doc = frame({autoLayout: autoLayout({layoutMode: 'VERTICAL', itemSpacing: 12, paddingTop: 24, paddingBottom: 24, paddingLeft: 16, paddingRight: 16, primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'MAX'})});
  const out = css(doc, 'f');
  assert.equal(out.display, 'flex');
  assert.equal(out['flex-direction'], 'column');
  assert.equal(out.gap, '12px');
  assert.equal(out.padding, '24px 16px');
  assert.equal(out['justify-content'], 'center');
  assert.equal(out['align-items'], 'flex-end');
  assert.equal(out['box-sizing'], undefined, 'the reset sets border-box once for every element');
  // A top-level frame is a root: no position.
  assert.equal(out.position, undefined);
});

test('space-between drops the gap; wrap sets rows, row gap and content alignment', () => {
  assert.equal(css(frame({autoLayout: autoLayout({itemSpacing: 20, primaryAxisAlignItems: 'SPACE_BETWEEN'})}), 'f').gap, undefined);
  assert.equal(css(frame({autoLayout: autoLayout({itemSpacing: 20, primaryAxisAlignItems: 'SPACE_BETWEEN'})}), 'f')['justify-content'], 'space-between');
  const wrap = css(frame({autoLayout: autoLayout({layoutWrap: 'WRAP', itemSpacing: 8, counterAxisSpacing: 16, counterAxisAlignContent: 'SPACE_BETWEEN'})}), 'f');
  assert.equal(wrap['flex-wrap'], 'wrap');
  assert.equal(wrap.gap, '16px 8px', 'row gap, then column gap');
  assert.equal(wrap['align-content'], 'space-between');
  const padded = css(frame({autoLayout: autoLayout({paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4})}), 'f');
  assert.equal(padded.padding, '1px 2px 3px 4px');
});

test('fill, hug and fixed children: flex items and widths', () => {
  let doc = frame({autoLayout: autoLayout({itemSpacing: 8})});
  doc = add(doc, 'RECTANGLE', {id: 'fill', parentId: 'f', width: 100, height: 40, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL'});
  doc = add(doc, 'FRAME', {id: 'hug', parentId: 'f', width: 80, height: 30, autoLayout: autoLayout(), layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'});
  doc = add(doc, 'RECTANGLE', {id: 'fixed', parentId: 'f', width: 50, height: 20});
  const fill = css(doc, 'fill');
  assert.equal(fill.flex, '1', 'fills the main axis');
  assert.equal(fill['align-self'], 'stretch', 'fills the cross axis');
  assert.equal(fill.width, undefined);
  assert.equal(fill.height, undefined);
  const hug = css(doc, 'hug');
  assert.equal(hug.flex, undefined, 'a hugging item needs no flex rule');
  assert.equal(hug['flex-shrink'], undefined);
  assert.equal(hug.width, undefined, 'a hugging frame takes its content size');
  const fixed = css(doc, 'fixed');
  assert.deepEqual([fixed['flex-shrink'], fixed.width, fixed.height], ['0', '50px', '20px'], 'a fixed size never shrinks, as in the design');
  assert.equal(fixed.position, undefined, 'in the flow');
  // A root that hugs its content is inline-flex: it sizes itself, with no width to keep in step.
  const root = css(add(createDocument('p'), 'FRAME', {id: 'h', parentId: 'p', autoLayout: autoLayout(), layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'}), 'h');
  assert.deepEqual([root.display, root.width], ['inline-flex', undefined]);
});

test('children that all fill across leave stretch to CSS: no align-items, no align-self', () => {
  let doc = frame({autoLayout: autoLayout({layoutMode: 'VERTICAL', itemSpacing: 8})});
  doc = add(doc, 'RECTANGLE', {id: 'a', parentId: 'f', width: 100, height: 40, layoutSizingHorizontal: 'FILL'});
  doc = add(doc, 'RECTANGLE', {id: 'b', parentId: 'f', width: 100, height: 40, layoutSizingHorizontal: 'FILL'});
  assert.equal(css(doc, 'f')['align-items'], undefined);
  assert.equal(css(doc, 'a')['align-self'], undefined);
  // One child that does not fill: the container aligns, the filling child stretches itself.
  doc = add(doc, 'RECTANGLE', {id: 'c', parentId: 'f', width: 60, height: 40});
  assert.equal(css(doc, 'f')['align-items'], 'flex-start');
  assert.equal(css(doc, 'a')['align-self'], 'stretch');
});

test('a circle is 50% round and a pill 9999px, so the shape holds at any size', () => {
  assert.equal(css(frame({width: 40, height: 40, cornerRadius: 20}), 'f')['border-radius'], '50%');
  assert.equal(css(frame({width: 120, height: 40, cornerRadius: 20}), 'f')['border-radius'], '9999px');
  assert.equal(css(frame({width: 120, height: 40, cornerRadius: 8}), 'f')['border-radius'], '8px');
});

test('constraints place absolute children: left, right, centre, stretch, scale', () => {
  let doc = frame();
  const place = (id: string, horizontal: SceneNode['constraints']['horizontal'], vertical: SceneNode['constraints']['vertical']) => {
    doc = add(doc, 'RECTANGLE', {id, parentId: 'f', x: 40, y: 30, width: 100, height: 50, constraints: {horizontal, vertical}});
  };
  place('min', 'MIN', 'MIN');
  place('max', 'MAX', 'MAX');
  place('center', 'CENTER', 'CENTER');
  place('stretch', 'STRETCH', 'STRETCH');
  place('scale', 'SCALE', 'SCALE');
  assert.deepEqual(pick(css(doc, 'min'), 'position', 'left', 'top', 'width', 'height'), {position: 'absolute', left: '40px', top: '30px', width: '100px', height: '50px'});
  assert.deepEqual(pick(css(doc, 'max'), 'right', 'bottom'), {right: '260px', bottom: '220px'});
  assert.deepEqual(pick(css(doc, 'center'), 'left', 'top'), {left: 'calc(50% - 160px)', top: 'calc(50% - 120px)'});
  const stretch = css(doc, 'stretch');
  assert.deepEqual(pick(stretch, 'left', 'right', 'top', 'bottom'), {left: '40px', right: '260px', top: '30px', bottom: '220px'});
  assert.equal(stretch.width, undefined);
  assert.deepEqual(pick(css(doc, 'scale'), 'left', 'top', 'width', 'height'), {left: '10%', top: '10%', width: '25%', height: '16.67%'});
  // An absolute child of an auto-layout frame follows its constraints too.
  let flow = frame({autoLayout: autoLayout()});
  flow = add(flow, 'RECTANGLE', {id: 'abs', parentId: 'f', x: 10, y: 10, width: 20, height: 20, layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'MAX', vertical: 'MIN'}});
  assert.deepEqual(pick(css(flow, 'abs'), 'position', 'right', 'top', 'flex'), {position: 'absolute', right: '370px', top: '10px'});
});

test('rotation turns about the centre in CSS, so the box is moved to match', () => {
  const doc = add(frame(), 'RECTANGLE', {id: 'r', parentId: 'f', x: 0, y: 0, width: 100, height: 100, rotation: 90});
  const out = css(doc, 'r');
  assert.equal(out.transform, 'rotate(-90deg)');
  // The model turns about the top-left corner: the centre ends up at (50, -50).
  assert.deepEqual(pick(out, 'left', 'top'), {left: '0', top: '-100px'});
  assert.equal(css(add(frame(), 'RECTANGLE', {id: 'f2', parentId: 'f', flipX: true}), 'f2').transform, 'scaleX(-1)');
});

test('min and max sizes', () => {
  const doc = add(frame({autoLayout: autoLayout()}), 'FRAME', {id: 'c', parentId: 'f', minWidth: 120, maxWidth: 480, minHeight: null, maxHeight: 200});
  assert.deepEqual(pick(css(doc, 'c'), 'min-width', 'max-width', 'min-height', 'max-height'), {'min-width': '120px', 'max-width': '480px', 'max-height': '200px'});
});

test('corner radii: uniform, per corner, ellipse', () => {
  assert.equal(css(frame({cornerRadius: 8}), 'f')['border-radius'], '8px');
  assert.equal(css(frame({rectangleCornerRadii: [8, 8, 0, 0]}), 'f')['border-radius'], '8px 8px 0 0');
  assert.equal(css(frame({rectangleCornerRadii: [1, 2, 3, 4]}), 'f')['border-radius'], '1px 2px 3px 4px');
  assert.equal(css(add(frame(), 'ELLIPSE', {id: 'e', parentId: 'f'}), 'e')['border-radius'], '50%');
});

test('fills: solid colours, translucency, layers top first', () => {
  assert.equal(css(frame({fills: [solid(RED)]}), 'f').background, '#FF0000');
  assert.equal(css(frame({fills: [solid(RED, 0.5)]}), 'f').background, 'rgba(255, 0, 0, 0.5)');
  assert.equal(css(frame({fills: [solid(RED), solid(BLUE, 0.25)]}), 'f').background, 'linear-gradient(rgba(0, 0, 255, 0.25), rgba(0, 0, 255, 0.25)), linear-gradient(#FF0000, #FF0000)');
  assert.equal(css(frame({fills: [{...solid(RED), visible: false}]}), 'f').background, undefined);
});

const gradient = (type: GradientPaint['type'], handles: GradientPaint['gradientHandlePositions']): GradientPaint => ({
  type, gradientHandlePositions: handles, opacity: 1, visible: true, blendMode: 'NORMAL',
  gradientStops: [{position: 0, color: {...RED, a: 1}}, {position: 1, color: {...BLUE, a: 0.5}}],
});

test('gradients: linear angle and stops projected exactly, radial, conic, diamond', () => {
  assert.equal(gradientCss(gradient('GRADIENT_LINEAR', [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}]), 200, 100), 'linear-gradient(90deg, #FF0000 0%, rgba(0, 0, 255, 0.5) 100%)');
  assert.equal(gradientCss(gradient('GRADIENT_LINEAR', [{x: 0.5, y: 0}, {x: 0.5, y: 1}, {x: 1, y: 0}]), 200, 100), 'linear-gradient(180deg, #FF0000 0%, rgba(0, 0, 255, 0.5) 100%)');
  // Handles inside the box: stops move in along the CSS gradient line.
  assert.equal(gradientCss(gradient('GRADIENT_LINEAR', [{x: 0.25, y: 0.5}, {x: 0.75, y: 0.5}, {x: 0.25, y: 1}]), 200, 100), 'linear-gradient(90deg, #FF0000 25%, rgba(0, 0, 255, 0.5) 75%)');
  // A diagonal on a square box: 135deg, corner to corner.
  assert.equal(gradientCss(gradient('GRADIENT_LINEAR', [{x: 0, y: 0}, {x: 1, y: 1}, {x: 1, y: 0}]), 100, 100), 'linear-gradient(135deg, #FF0000 0%, rgba(0, 0, 255, 0.5) 100%)');
  assert.equal(gradientCss(gradient('GRADIENT_RADIAL', [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}]), 200, 100), 'radial-gradient(50% 50% at 50% 50%, #FF0000 0%, rgba(0, 0, 255, 0.5) 100%)');
  assert.equal(gradientCss(gradient('GRADIENT_ANGULAR', [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}]), 100, 100), 'conic-gradient(from 90deg at 50% 50%, #FF0000 0%, rgba(0, 0, 255, 0.5) 100%)');
  assert.match(gradientCss(gradient('GRADIENT_DIAMOND', [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}]), 100, 100), /^radial-gradient\(/);
  assert.match(css(frame({fills: [gradient('GRADIENT_LINEAR', [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}])]}), 'f').background, /^linear-gradient\(90deg/);
});

test('image fills: cover, contain, crop and tile as background layers', () => {
  const image = (scaleMode: ImagePaint['scaleMode'], extra: Partial<ImagePaint> = {}): ImagePaint => ({type: 'IMAGE', imageRef: 'img', scaleMode, opacity: 1, visible: true, blendMode: 'NORMAL', ...extra});
  const doc = (paint: ImagePaint) => {
    const d = frame({fills: [paint]});
    d.images.img = {url: '/uploads/dz-1.webp', width: 400, height: 200, name: 'Photo.jpg'};
    return d;
  };
  assert.equal(css(doc(image('FILL')), 'f').background, 'url(assets/photo.webp) center / cover no-repeat');
  assert.equal(css(doc(image('FIT')), 'f').background, 'url(assets/photo.webp) center / contain no-repeat');
  assert.equal(css(doc(image('TILE', {scalingFactor: 0.5})), 'f').background, 'url(assets/photo.webp) left top / 200px 100px repeat');
  assert.equal(css(doc(image('CROP', {imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.5]]})), 'f').background, 'url(assets/photo.webp) 50% 100% / 200% 200% no-repeat');
});

test('strokes by alignment: inset shadow inside, outline outside and centred, borders for dashes and sides', () => {
  const stroke = {strokes: [solid(RED)], strokeWeight: 2};
  assert.equal(css(frame({...stroke, strokeAlign: 'INSIDE'}), 'f')['box-shadow'], 'inset 0 0 0 2px #FF0000');
  assert.equal(css(frame({...stroke, strokeAlign: 'OUTSIDE'}), 'f').outline, '2px solid #FF0000');
  const center = css(frame({...stroke, strokeAlign: 'CENTER'}), 'f');
  assert.deepEqual(pick(center, 'outline', 'outline-offset'), {outline: '2px solid #FF0000', 'outline-offset': '-1px'});
  const dashed = css(frame({...stroke, strokeAlign: 'INSIDE', dashPattern: [6, 4]}), 'f');
  assert.equal(dashed.border, '2px dashed #FF0000');
  // One side (a divider under a row) is that side's shorthand; several keep the three properties.
  const bottom = css(frame({...stroke, individualStrokeWeights: {top: 0, right: 0, bottom: 1, left: 0}}), 'f');
  assert.equal(bottom['border-bottom'], '1px solid #FF0000');
  const sides = css(frame({...stroke, individualStrokeWeights: {top: 1, right: 0, bottom: 1, left: 0}}), 'f');
  assert.deepEqual(pick(sides, 'border-style', 'border-width', 'border-color'), {'border-style': 'solid', 'border-width': '1px 0', 'border-color': '#FF0000'});
  assert.equal(css(add(frame(), 'LINE', {id: 'l', parentId: 'f', width: 100, height: 0, strokes: [solid(BLUE)], strokeWeight: 2}), 'l')['border-top'], '2px solid #0000FF');
});

test('effects: shadows with spread, inner shadows, layer and background blur at half the radius', () => {
  const shadow = (type: 'DROP_SHADOW' | 'INNER_SHADOW', y: number): Effect => ({type, color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y}, radius: 12, spread: 2, visible: true, blendMode: 'NORMAL'});
  const out = css(frame({effects: [shadow('DROP_SHADOW', 4), shadow('INNER_SHADOW', 1), {type: 'LAYER_BLUR', radius: 8, visible: true}, {type: 'BACKGROUND_BLUR', radius: 20, visible: true}]}), 'f');
  assert.equal(out['box-shadow'], 'inset 0 1px 12px 2px rgba(0, 0, 0, 0.25), 0 4px 12px 2px rgba(0, 0, 0, 0.25)');
  assert.equal(out.filter, 'blur(4px)');
  assert.equal(out['backdrop-filter'], 'blur(10px)');
  assert.equal(out['-webkit-backdrop-filter'], 'blur(10px)');
  // An inside stroke and a shadow share box-shadow.
  assert.equal(css(frame({strokes: [solid(RED)], strokeWeight: 1, effects: [shadow('DROP_SHADOW', 4)]}), 'f')['box-shadow'], 'inset 0 0 0 1px #FF0000, 0 4px 12px 2px rgba(0, 0, 0, 0.25)');
});

test('layer: opacity, blend mode, clipping only when it cuts something', () => {
  const out = css(frame({opacity: 0.4, blendMode: 'MULTIPLY'}), 'f');
  assert.equal(out.opacity, '0.4');
  assert.equal(out['mix-blend-mode'], 'multiply');
  assert.equal(css(frame({blendMode: 'PASS_THROUGH'}), 'f')['mix-blend-mode'], undefined);
  const inside = add(frame(), 'RECTANGLE', {id: 'r', parentId: 'f', x: 10, y: 10, width: 50, height: 50});
  assert.equal(css(inside, 'f').overflow, undefined, 'nothing to clip');
  const outside = add(frame(), 'RECTANGLE', {id: 'r', parentId: 'f', x: 380, y: 10, width: 50, height: 50});
  assert.equal(css(outside, 'f').overflow, 'hidden');
  const corner = add(frame({cornerRadius: 24}), 'RECTANGLE', {id: 'r', parentId: 'f', x: 0, y: 0, width: 50, height: 50});
  assert.equal(css(corner, 'f').overflow, 'hidden', 'rounded corners cut the child');
  assert.equal(css(add(frame({clipsContent: false}), 'RECTANGLE', {id: 'r', parentId: 'f', x: 380, y: 10, width: 50, height: 50}), 'f').overflow, undefined);
});

test('typography: family with fallback, weight, size, line height, tracking, alignment, case, decoration, colour', () => {
  const doc = add(frame(), 'TEXT', {
    id: 't', parentId: 'f', width: 200, height: 40, fills: [solid({r: 0.2, g: 0.2, b: 0.2})],
    text: {...defaultTextProps('Hello'), textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER', style: {...defaultTextProps().style, fontFamily: 'Playfair Display', fontWeight: 600, italic: true, fontSize: 24, lineHeight: {unit: 'PERCENT', value: 150}, letterSpacing: {unit: 'PERCENT', value: -2}, textCase: 'UPPER', textDecoration: 'UNDERLINE'}},
  });
  const out = nodeToCss(doc, 't', {tokens: false, fontFallback: family => (family === 'Playfair Display' ? 'Georgia, serif' : undefined)});
  const map = Object.fromEntries(out.map(decl => [decl.prop, decl.value]));
  assert.deepEqual(pick(map, 'font-family', 'font-style', 'font-weight', 'font-size', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration', 'color'), {
    'font-family': "'Playfair Display', Georgia, serif", 'font-style': 'italic', 'font-weight': '600', 'font-size': '24px', 'line-height': '150%', 'letter-spacing': '-0.02em',
    'text-align': 'center', 'text-transform': 'uppercase', 'text-decoration': 'underline', color: '#333333',
  });
  assert.equal(map.width, '200px', 'auto height keeps the width');
  assert.equal(map.height, undefined);
  // Without a known fallback the name decides.
  const plain = css(add(frame(), 'TEXT', {id: 't', parentId: 'f', text: defaultTextProps('a')}), 't');
  assert.equal(plain['font-family'], "'Inter', sans-serif");
  assert.equal(plain['white-space'], 'nowrap', 'auto width never wraps');
  assert.equal(plain['line-height'], undefined, 'auto line height stays the font’s');
  assert.equal(plain['letter-spacing'], undefined);
});

test('text: gradient fills clip to the glyphs, truncation, vertical alignment, shadows', () => {
  const doc = add(frame(), 'TEXT', {
    id: 't', parentId: 'f', width: 100, height: 60, fills: [gradient('GRADIENT_LINEAR', [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}])],
    effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.5}, offset: {x: 1, y: 2}, radius: 3, spread: 4, visible: true, blendMode: 'NORMAL'}],
    text: {...defaultTextProps('Long text'), textAutoResize: 'TRUNCATE', maxLines: 2},
  });
  const out = css(doc, 't');
  assert.match(out.background, /^linear-gradient/);
  assert.deepEqual(pick(out, 'background-clip', 'color'), {'background-clip': 'text', color: 'transparent'});
  assert.deepEqual(pick(out, 'overflow', 'text-overflow', '-webkit-line-clamp', 'display'), {overflow: 'hidden', 'text-overflow': 'ellipsis', '-webkit-line-clamp': '2', display: '-webkit-box'});
  assert.equal(out['text-shadow'], '1px 2px 3px rgba(0, 0, 0, 0.5)', 'no spread on text');
  const centred = css(add(frame(), 'TEXT', {id: 't', parentId: 'f', width: 100, height: 60, text: {...defaultTextProps('a'), textAutoResize: 'NONE', textAlignVertical: 'CENTER'}}), 't');
  assert.deepEqual(pick(centred, 'display', 'flex-direction', 'justify-content'), {display: 'flex', 'flex-direction': 'column', 'justify-content': 'center'});
});

test('bound styles and variables become var() references', () => {
  let doc = frame({fills: [{...solid(BLUE), boundVariables: {color: {type: 'VARIABLE_ALIAS', id: 'v-brand'}}}], autoLayout: autoLayout({itemSpacing: 16}), boundVariables: {itemSpacing: {type: 'VARIABLE_ALIAS', id: 'v-gap'}}});
  doc.variableCollections.c = {id: 'c', name: 'Colors', modes: [{modeId: 'm', name: 'Light'}], defaultModeId: 'm', variableIds: ['v-brand', 'v-gap']};
  doc.variables['v-brand'] = {id: 'v-brand', name: 'Brand/Primary', collectionId: 'c', type: 'COLOR', valuesByMode: {m: {...BLUE, a: 1}}, description: ''};
  doc.variables['v-gap'] = {id: 'v-gap', name: 'spacing/m', collectionId: 'c', type: 'FLOAT', valuesByMode: {m: 16}, description: ''};
  doc.styles.s = {id: 's', type: 'TEXT', name: 'Heading/H1', description: '', text: {...defaultTextProps().style, fontSize: 40, fontWeight: 700}};
  doc.styles.e = {id: 'e', type: 'EFFECT', name: 'Shadow', description: '', effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.1}, offset: {x: 0, y: 2}, radius: 4, spread: 0, visible: true, blendMode: 'NORMAL'}]};
  doc = {...doc, nodes: {...doc.nodes, f: {...doc.nodes.f, effectStyleId: 'e', effects: doc.styles.e.effects!}}};
  doc = add(doc, 'TEXT', {id: 't', parentId: 'f', textStyleId: 's', text: {...defaultTextProps('H'), style: doc.styles.s.text!}});
  const out = Object.fromEntries(nodeToCss(doc, 'f').map(decl => [decl.prop, decl.value]));
  assert.equal(out.background, 'var(--color-brand-primary)');
  assert.equal(out.gap, 'var(--spacing-m)');
  assert.equal(out['box-shadow'], 'var(--shadow)');
  const text = Object.fromEntries(nodeToCss(doc, 't').map(decl => [decl.prop, decl.value]));
  assert.equal(text.font, 'var(--font-heading-h1)');
  assert.equal(text['font-size'], undefined, 'the style token carries the size');
});

test('"Copy as CSS" names each layer and points vectors to SVG', () => {
  let doc = frame({name: 'Card', fills: [solid(RED)]});
  doc = add(doc, 'STAR', {id: 's', parentId: 'f', name: 'Star', width: 20, height: 20});
  const text = cssForLayers(doc, ['f', 's'], {tokens: false});
  assert.match(text, /^\/\* Card \*\/\n/);
  assert.match(text, /background: #FF0000;/);
  assert.match(text, /\/\* Star \*\/\n\/\* Vector shape: in code it is an SVG/);
  assert.doesNotMatch(text, /Star[\s\S]*background: #D9D9D9/, 'a vector paints in its SVG, not as a CSS background');
});

function pick(record: Record<string, string>, ...keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}

test('grid auto layout becomes CSS grid: tracks, gaps, padding; children carry cells, spans and alignment', () => {
  let doc = frame({
    autoLayout: {...defaultAutoLayout('GRID'), paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8},
    grid: {rowCount: 2, columnCount: 3, rowGap: 12, columnGap: 16, rowSizes: [{type: 'FIXED', value: 40}, {type: 'HUG'}], columnSizes: [{type: 'FLEX', value: 2}, {type: 'FLEX'}], autoTracks: 'NONE', itemsPositioning: 'MANUAL'},
  });
  doc = add(doc, 'RECTANGLE', {id: 'a', parentId: 'f', width: 50, height: 30, gridChild: {rowAnchorIndex: 1, columnAnchorIndex: 2, horizontalAlign: 'CENTER', verticalAlign: 'MAX'}});
  doc = add(doc, 'RECTANGLE', {id: 'b', parentId: 'f', width: 50, height: 30, layoutSizingHorizontal: 'FILL', gridChild: {rowAnchorIndex: 0, columnAnchorIndex: 0, columnSpan: 2}});
  const out = css(doc, 'f');
  assert.equal(out.display, 'grid');
  assert.equal(out['grid-template-columns'], '2fr 1fr 1fr', 'a missing track reads as 1fr');
  assert.equal(out['grid-template-rows'], '40px auto');
  assert.equal(out.gap, '12px 16px', 'row gap, then column gap');
  assert.equal(out.padding, '8px');
  assert.equal(out['flex-direction'], undefined);
  const a = css(doc, 'a');
  assert.equal(a['grid-row'], '2');
  assert.equal(a['grid-column'], '3');
  assert.equal(a['justify-self'], 'center');
  assert.equal(a['align-self'], 'end');
  assert.equal(a.flex, undefined);
  const b = css(doc, 'b');
  assert.equal(b['grid-row'], '1');
  assert.equal(b['grid-column'], '1 / span 2');
  assert.equal(b['justify-self'], undefined, 'a filling child stretches, which is the default');
  assert.equal(b['align-self'], 'start');
  assert.equal(b.width, undefined, 'a filling child has no width of its own');
  // Auto flow: only spans are said; the cells follow CSS's own row flow.
  const flow = add(add(frame({autoLayout: defaultAutoLayout('GRID'), grid: {rowCount: 1, columnCount: 2, rowGap: 0, columnGap: 0, rowSizes: [], columnSizes: [], autoTracks: 'ROWS', itemsPositioning: 'ROW_AUTO_FLOW'}}), 'RECTANGLE', {id: 'c', parentId: 'f', width: 10, height: 10}), 'RECTANGLE', {id: 'd', parentId: 'f', width: 10, height: 10, gridChild: {columnSpan: 2}});
  assert.equal(css(flow, 'f')['grid-template-rows'], '1fr 1fr', 'two rows derived under auto rows; the frame is fixed, so they stay fr');
  assert.equal(css(flow, 'f').gap, undefined);
  assert.equal(css(flow, 'c')['grid-row'], undefined);
  assert.equal(css(flow, 'd')['grid-column'], '1 / span 2');
});
