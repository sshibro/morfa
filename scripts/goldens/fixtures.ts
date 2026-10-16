// The fixture documents the golden images are made from. Browser-safe: only
// shared/design and the test helpers are imported, so the harness page (harness.ts) and the node driver
// (render.ts) share one list. Deterministic: ids are counters, nothing reads Math.random or Date.now.
//
// The set: the 20 041-layer page and the product file of tests/helpers/design-big-files.ts, every starter
// template of shared/design/templates, and `effects` (below), which puts every paint, effect, mask and
// stroke kind the painter knows on one page so the SSIM bars have something to bite on.

import type {BlendMode, DesignDocument, Effect, NodeId, NodeType, Paint, RGB, RGBA, SceneNode, Vec} from '../../shared/design/types';
import {createDocument, createNode, defaultTextProps, solid} from '../../shared/design/defaults';
import {normalizeDocument} from '../../shared/design/normalize';
import {DESIGN_TEMPLATES} from '../../shared/design/templates/index';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';

export type Fixture = {name: string; source: string; build: () => DesignDocument};

/** The picture every IMAGE paint of the `effects` fixture points at; render.ts writes it before serving. */
export const EFFECTS_IMAGE_URL = '/fixtures/goldens/assets/photo.png';
export const EFFECTS_IMAGE_SIZE = {width: 400, height: 300};

const counter = (prefix: string) => {
  let n = 0;
  return () => `${prefix}${(++n).toString(36)}`;
};

const rgb = (r: number, g: number, b: number): RGB => ({r: r / 255, g: g / 255, b: b / 255});
const rgba = (r: number, g: number, b: number, a: number): RGBA => ({r: r / 255, g: g / 255, b: b / 255, a});
const INK = rgb(30, 30, 30);
const LIME = rgb(200, 255, 80);
const CORAL = rgb(255, 110, 90);
const SKY = rgb(90, 160, 255);
const PLUM = rgb(120, 60, 160);

const BLEND_MODES: BlendMode[] = ['NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'];

const gradient = (type: Paint['type'] & `GRADIENT_${string}`, stops: [number, RGBA][], handles: [Vec, Vec, Vec] = [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}]): Paint =>
  ({type, opacity: 1, visible: true, blendMode: 'NORMAL', gradientStops: stops.map(([position, color]) => ({position, color})), gradientHandlePositions: handles});
const image = (scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE', extra: Partial<Paint> = {}): Paint =>
  ({type: 'IMAGE', opacity: 1, visible: true, blendMode: 'NORMAL', imageRef: 'photo', scaleMode, ...extra} as Paint);
const drop = (offset: Vec, radius: number, spread: number, color: RGBA, extra: Partial<Effect> = {}): Effect =>
  ({type: 'DROP_SHADOW', color, offset, radius, spread, visible: true, blendMode: 'NORMAL', ...extra} as Effect);
const inner = (offset: Vec, radius: number, spread: number, color: RGBA): Effect => ({type: 'INNER_SHADOW', color, offset, radius, spread, visible: true, blendMode: 'NORMAL'});

/** One page, 1 280 × 1 720, twelve labelled rows of cases. */
export function effectsFixture(): DesignDocument {
  const doc = createDocument('page', 'Effects');
  doc.images = {photo: {url: EFFECTS_IMAGE_URL, ...EFFECTS_IMAGE_SIZE}};
  const page = doc.nodes.page;
  page.backgroundColor = rgb(245, 245, 245);
  const nextId = counter('e');
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>): NodeId => {
    const id = nextId();
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  const label = (parent: NodeId, x: number, y: number, text: string, size = 13) =>
    add('TEXT', parent, {x, y, width: 400, height: 20, fills: [solid(INK)], text: {...defaultTextProps(text), style: {...defaultTextProps('').style, fontSize: size, fontWeight: 500}, textAutoResize: 'NONE'}});
  const row = (y: number, title: string): NodeId => {
    label('page', 24, y, title, 15);
    return add('FRAME', 'page', {name: title, x: 24, y: y + 28, width: 1232, height: 110, fills: [solid(rgb(255, 255, 255))], clipsContent: false, cornerRadius: 8});
  };

  // 1. Blend modes: coloured discs over a lime→sky gradient band.
  let frame = row(16, 'Blend modes');
  add('RECTANGLE', frame, {x: 0, y: 30, width: 1232, height: 50, fills: [gradient('GRADIENT_LINEAR', [[0, rgba(200, 255, 80, 1)], [0.5, rgba(255, 110, 90, 1)], [1, rgba(90, 160, 255, 1)]])]});
  BLEND_MODES.forEach((mode, k) => add('ELLIPSE', frame, {x: 12 + k * 76, y: 15, width: 60, height: 80, blendMode: mode, fills: [solid(k % 2 ? PLUM : rgb(255, 200, 40))]}));

  // 2. Drop shadows: radius, spread, offset, behind-node, on an ellipse, a stroke-only shape, text and a picture.
  frame = row(170, 'Drop shadows');
  add('RECTANGLE', frame, {x: 20, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(rgb(255, 255, 255))], effects: [drop({x: 0, y: 8}, 24, 0, rgba(0, 0, 0, 0.25))]});
  add('RECTANGLE', frame, {x: 150, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(LIME)], effects: [drop({x: 12, y: 12}, 0, 0, rgba(30, 30, 30, 1))]});
  add('RECTANGLE', frame, {x: 280, y: 20, width: 90, height: 60, cornerRadius: 30, fills: [solid(SKY)], effects: [drop({x: 0, y: 0}, 10, 10, rgba(90, 160, 255, 0.6))]});
  add('RECTANGLE', frame, {x: 410, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(CORAL, 0.5)], effects: [drop({x: 6, y: 6}, 6, 0, rgba(0, 0, 0, 0.6), {showShadowBehindNode: true})]});
  add('RECTANGLE', frame, {x: 540, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(CORAL, 0.5)], effects: [drop({x: 6, y: 6}, 6, 0, rgba(0, 0, 0, 0.6))]});
  add('ELLIPSE', frame, {x: 670, y: 20, width: 70, height: 70, fills: [solid(PLUM)], effects: [drop({x: 0, y: 6}, 16, -4, rgba(120, 60, 160, 0.8))]});
  add('RECTANGLE', frame, {x: 790, y: 20, width: 90, height: 60, fills: [], strokes: [solid(INK)], strokeWeight: 4, strokeAlign: 'CENTER', effects: [drop({x: 4, y: 4}, 8, 0, rgba(0, 0, 0, 0.5))]});
  add('TEXT', frame, {x: 920, y: 28, width: 140, height: 50, fills: [solid(INK)], text: {...defaultTextProps('Shadow'), style: {...defaultTextProps('').style, fontSize: 36, fontWeight: 700}, textAutoResize: 'NONE'}, effects: [drop({x: 3, y: 3}, 6, 0, rgba(255, 110, 90, 0.9))]});
  add('RECTANGLE', frame, {x: 1100, y: 15, width: 110, height: 80, cornerRadius: 10, fills: [image('FILL')], effects: [drop({x: 0, y: 10}, 20, 0, rgba(0, 0, 0, 0.35))]});

  // 3. Inner shadows: plain, with spread, offset to a side, on an ellipse, under a gradient, two at once.
  frame = row(324, 'Inner shadows');
  add('RECTANGLE', frame, {x: 20, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(rgb(255, 255, 255))], effects: [inner({x: 0, y: 4}, 12, 0, rgba(0, 0, 0, 0.35))]});
  add('RECTANGLE', frame, {x: 150, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(LIME)], effects: [inner({x: 0, y: 0}, 6, 6, rgba(30, 30, 30, 0.6))]});
  add('RECTANGLE', frame, {x: 280, y: 20, width: 90, height: 60, cornerRadius: 0, fills: [solid(SKY)], effects: [inner({x: 20, y: 0}, 10, 0, rgba(0, 0, 0, 0.5))]});
  add('ELLIPSE', frame, {x: 410, y: 15, width: 80, height: 80, fills: [solid(CORAL)], effects: [inner({x: -6, y: -6}, 14, 0, rgba(0, 0, 0, 0.5))]});
  add('RECTANGLE', frame, {x: 540, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [gradient('GRADIENT_RADIAL', [[0, rgba(255, 255, 255, 1)], [1, rgba(120, 60, 160, 1)]])], effects: [inner({x: 0, y: -8}, 10, 0, rgba(0, 0, 0, 0.5))]});
  add('RECTANGLE', frame, {x: 670, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(rgb(255, 255, 255))], effects: [inner({x: 0, y: 6}, 8, 0, rgba(0, 0, 0, 0.3)), inner({x: 0, y: -6}, 8, 0, rgba(90, 160, 255, 0.6))]});
  add('STAR', frame, {x: 800, y: 15, width: 80, height: 80, fills: [solid(LIME)], effects: [inner({x: 0, y: 4}, 8, 0, rgba(0, 0, 0, 0.5))]});
  add('TEXT', frame, {x: 920, y: 28, width: 200, height: 50, fills: [solid(PLUM)], text: {...defaultTextProps('Inside'), style: {...defaultTextProps('').style, fontSize: 36, fontWeight: 800}, textAutoResize: 'NONE'}, effects: [inner({x: 2, y: 2}, 3, 0, rgba(0, 0, 0, 0.7))]});

  // 4. Blur: layer blur on shapes and text, background blur over a picture and over gradient text.
  frame = row(478, 'Blur');
  add('RECTANGLE', frame, {x: 20, y: 20, width: 90, height: 60, cornerRadius: 12, fills: [solid(CORAL)], effects: [{type: 'LAYER_BLUR', radius: 8, visible: true}]});
  add('ELLIPSE', frame, {x: 150, y: 15, width: 80, height: 80, fills: [solid(SKY)], effects: [{type: 'LAYER_BLUR', radius: 20, visible: true}]});
  add('TEXT', frame, {x: 280, y: 28, width: 200, height: 50, fills: [solid(INK)], text: {...defaultTextProps('Soft'), style: {...defaultTextProps('').style, fontSize: 36, fontWeight: 700}, textAutoResize: 'NONE'}, effects: [{type: 'LAYER_BLUR', radius: 3, visible: true}]});
  add('RECTANGLE', frame, {x: 520, y: 5, width: 200, height: 100, fills: [image('FILL')]});
  add('RECTANGLE', frame, {x: 560, y: 25, width: 120, height: 60, cornerRadius: 16, fills: [solid(rgb(255, 255, 255), 0.35)], strokes: [solid(rgb(255, 255, 255), 0.7)], strokeWeight: 1, effects: [{type: 'BACKGROUND_BLUR', radius: 12, visible: true}]});
  add('RECTANGLE', frame, {x: 760, y: 5, width: 200, height: 100, fills: [gradient('GRADIENT_ANGULAR', [[0, rgba(200, 255, 80, 1)], [0.33, rgba(255, 110, 90, 1)], [0.66, rgba(90, 160, 255, 1)], [1, rgba(200, 255, 80, 1)]])]});
  add('ELLIPSE', frame, {x: 800, y: 15, width: 120, height: 80, fills: [solid(rgb(255, 255, 255), 0.2)], effects: [{type: 'BACKGROUND_BLUR', radius: 24, visible: true}]});
  const blurGroup = add('GROUP', frame, {x: 1000, y: 10, width: 200, height: 90, effects: [{type: 'LAYER_BLUR', radius: 6, visible: true}], opacity: 0.8});
  add('RECTANGLE', blurGroup, {x: 0, y: 0, width: 90, height: 90, fills: [solid(PLUM)]});
  add('ELLIPSE', blurGroup, {x: 60, y: 0, width: 90, height: 90, fills: [solid(LIME)]});

  // 5. Masks: alpha (a gradient-faded ellipse), vector (a star), luminance (a gradient), and a hidden mask.
  frame = row(632, 'Masks');
  const masked = (x: number, mask: Partial<SceneNode>, maskType: SceneNode['maskType']) => {
    const group = add('GROUP', frame, {x, y: 10, width: 180, height: 90});
    add(mask.type ?? 'ELLIPSE', group, {...mask, x: 0, y: 0, isMask: true, maskType});
    add('RECTANGLE', group, {x: 0, y: 0, width: 180, height: 90, fills: [image('FILL')]});
    add('TEXT', group, {x: 10, y: 20, width: 160, height: 50, fills: [solid(rgb(255, 255, 255))], text: {...defaultTextProps('Mask'), style: {...defaultTextProps('').style, fontSize: 32, fontWeight: 800}, textAutoResize: 'NONE'}});
  };
  masked(20, {type: 'ELLIPSE', width: 180, height: 90, fills: [gradient('GRADIENT_RADIAL', [[0, rgba(0, 0, 0, 1)], [1, rgba(0, 0, 0, 0)]], [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}])]}, 'ALPHA');
  masked(240, {type: 'STAR', width: 180, height: 90, pointCount: 6, fills: [solid(INK)]}, 'VECTOR');
  masked(460, {type: 'RECTANGLE', width: 180, height: 90, fills: [gradient('GRADIENT_LINEAR', [[0, rgba(255, 255, 255, 1)], [1, rgba(0, 0, 0, 1)]])]}, 'LUMINANCE');
  masked(680, {type: 'ELLIPSE', width: 180, height: 90, fills: [solid(INK)], visible: false}, 'ALPHA');
  masked(900, {type: 'RECTANGLE', width: 140, height: 70, cornerRadius: 24, rotation: 10, fills: [solid(INK, 0.5)]}, 'ALPHA');

  // 6. Gradients: linear, radial, angular, diamond; off-centre handles; translucent stops.
  frame = row(786, 'Gradients');
  const stops: [number, RGBA][] = [[0, rgba(200, 255, 80, 1)], [0.5, rgba(255, 110, 90, 1)], [1, rgba(90, 160, 255, 1)]];
  add('RECTANGLE', frame, {x: 20, y: 10, width: 160, height: 90, fills: [gradient('GRADIENT_LINEAR', stops, [{x: 0, y: 0}, {x: 1, y: 1}, {x: -0.5, y: 0.5}])]});
  add('RECTANGLE', frame, {x: 220, y: 10, width: 160, height: 90, cornerRadius: 20, fills: [gradient('GRADIENT_RADIAL', stops, [{x: 0.3, y: 0.4}, {x: 1, y: 0.4}, {x: 0.3, y: 1}])]});
  add('ELLIPSE', frame, {x: 420, y: 10, width: 160, height: 90, fills: [gradient('GRADIENT_ANGULAR', [...stops, [1, rgba(200, 255, 80, 1)]], [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}])]});
  add('RECTANGLE', frame, {x: 620, y: 10, width: 160, height: 90, fills: [gradient('GRADIENT_DIAMOND', stops, [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}])]});
  add('RECTANGLE', frame, {x: 820, y: 10, width: 160, height: 90, fills: [solid(INK), gradient('GRADIENT_LINEAR', [[0, rgba(255, 255, 255, 0)], [1, rgba(255, 255, 255, 0.9)]])]});
  add('RECTANGLE', frame, {x: 1020, y: 10, width: 190, height: 90, rotation: -8, fills: [gradient('GRADIENT_LINEAR', stops, [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}])], strokes: [gradient('GRADIENT_LINEAR', [[0, rgba(30, 30, 30, 1)], [1, rgba(120, 60, 160, 1)]])], strokeWeight: 6, strokeAlign: 'INSIDE'});

  // 7. Pictures: fill, fit, crop, tile, rotated, with filters, under opacity.
  frame = row(940, 'Images');
  add('RECTANGLE', frame, {x: 20, y: 10, width: 160, height: 90, fills: [image('FILL')]});
  add('RECTANGLE', frame, {x: 220, y: 10, width: 160, height: 90, fills: [solid(INK), image('FIT')]});
  add('RECTANGLE', frame, {x: 420, y: 10, width: 160, height: 90, fills: [image('CROP', {imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]]} as Partial<Paint>)]});
  add('RECTANGLE', frame, {x: 620, y: 10, width: 160, height: 90, fills: [image('TILE', {scalingFactor: 0.15} as Partial<Paint>)]});
  add('RECTANGLE', frame, {x: 820, y: 10, width: 160, height: 90, cornerRadius: 45, fills: [image('FILL', {rotation: 90} as Partial<Paint>)]});
  add('RECTANGLE', frame, {x: 1020, y: 10, width: 190, height: 90, opacity: 0.6, fills: [image('FILL', {filters: {exposure: 0.3, saturation: -0.6, contrast: 0.2}} as Partial<Paint>)]});

  // 8. Text: weights, families, decoration, case, letter spacing, a run of another colour, stroked text. The Cyrillic strings in this row
  // are glyph-coverage data for the Cyrillic fonts (Golos Text, Cormorant Garamond) and the run offsets below count their letters: they stay Russian.
  frame = row(1094, 'Text');
  const base = defaultTextProps('').style;
  add('TEXT', frame, {x: 20, y: 12, width: 220, height: 90, fills: [solid(INK)], text: {...defaultTextProps('Съешь же ещё этих мягких французских булок'), style: {...base, fontSize: 15}, textAutoResize: 'NONE'}});
  add('TEXT', frame, {x: 260, y: 12, width: 220, height: 90, fills: [solid(INK)], text: {...defaultTextProps('Manrope 800 wide'), style: {...base, fontFamily: 'Manrope', fontWeight: 800, fontSize: 22, letterSpacing: {unit: 'PERCENT', value: 8}}, textAutoResize: 'NONE'}});
  add('TEXT', frame, {x: 500, y: 12, width: 220, height: 90, fills: [solid(PLUM)], text: {...defaultTextProps('Подчёркнуто и зачёркнуто'), style: {...base, fontFamily: 'Golos Text', fontSize: 16, textDecoration: 'UNDERLINE'}, runs: [{start: 14, end: 24, style: {textDecoration: 'STRIKETHROUGH'}, fills: [solid(CORAL)]}], textAutoResize: 'NONE'}});
  add('TEXT', frame, {x: 740, y: 12, width: 220, height: 90, fills: [solid(INK)], text: {...defaultTextProps('капитель и верхний'), style: {...base, fontFamily: 'Cormorant Garamond', fontSize: 20, textCase: 'UPPER'}, textAutoResize: 'NONE', textAlignHorizontal: 'CENTER'}});
  add('TEXT', frame, {x: 980, y: 20, width: 230, height: 70, fills: [solid(LIME)], strokes: [solid(INK)], strokeWeight: 2, strokeAlign: 'OUTSIDE', text: {...defaultTextProps('Stroke'), style: {...base, fontSize: 40, fontWeight: 900}, textAutoResize: 'NONE'}});

  // 9. Strokes: align, dashes with caps and joins, per-side weights, markers, variable width.
  frame = row(1248, 'Strokes');
  add('RECTANGLE', frame, {x: 20, y: 20, width: 90, height: 60, strokes: [solid(INK)], strokeWeight: 8, strokeAlign: 'INSIDE', fills: [solid(LIME)]});
  add('RECTANGLE', frame, {x: 150, y: 20, width: 90, height: 60, strokes: [solid(INK)], strokeWeight: 8, strokeAlign: 'CENTER', fills: [solid(LIME)]});
  add('RECTANGLE', frame, {x: 280, y: 20, width: 90, height: 60, strokes: [solid(INK)], strokeWeight: 8, strokeAlign: 'OUTSIDE', fills: [solid(LIME)], cornerRadius: 16});
  add('ELLIPSE', frame, {x: 410, y: 15, width: 80, height: 80, fills: [], strokes: [solid(PLUM)], strokeWeight: 4, strokeAlign: 'CENTER', dashPattern: [12, 8], strokeCap: 'ROUND'});
  add('RECTANGLE', frame, {x: 540, y: 20, width: 90, height: 60, fills: [], strokes: [solid(SKY)], strokeWeight: 3, strokeAlign: 'CENTER', dashPattern: [6, 6], strokeJoin: 'ROUND'});
  add('RECTANGLE', frame, {x: 670, y: 20, width: 90, height: 60, fills: [solid(rgb(255, 255, 255))], strokes: [solid(INK)], strokeWeight: 2, strokeAlign: 'INSIDE', individualStrokeWeights: {top: 2, right: 8, bottom: 14, left: 0}, cornerRadius: 10});
  add('LINE', frame, {x: 800, y: 50, width: 110, height: 0, strokes: [solid(INK)], strokeWeight: 3, strokeStartMarker: 'CIRCLE', strokeEndMarker: 'TRIANGLE_ARROW'});
  add('LINE', frame, {x: 800, y: 80, width: 110, height: 0, strokes: [solid(CORAL)], strokeWeight: 2, strokeStartMarker: 'DIAMOND', strokeEndMarker: 'LINE_ARROW', dashPattern: [4, 4]});
  add('VECTOR', frame, {x: 940, y: 15, width: 120, height: 80, fills: [], strokes: [solid(PLUM)], strokeWeight: 10, strokeAlign: 'CENTER', strokeCap: 'ROUND', vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 70}, {type: 'C', x1: 30, y1: -20, x2: 80, y2: 110, x: 120, y: 10}]}]});
  add('VECTOR', frame, {x: 1090, y: 15, width: 120, height: 80, fills: [], strokes: [solid(INK)], strokeWeight: 14, strokeAlign: 'CENTER', strokeCap: 'ROUND', strokeWidthProfile: 'TAPER', vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 40}, {type: 'C', x1: 40, y1: 0, x2: 80, y2: 80, x: 120, y: 40}]}]} as Partial<SceneNode>);

  // 10. Composition: group opacity, nested blend, clipped frame with rotation, boolean operations, corner smoothing.
  frame = row(1402, 'Composition');
  const group = add('GROUP', frame, {x: 20, y: 10, width: 150, height: 90, opacity: 0.5});
  add('RECTANGLE', group, {x: 0, y: 0, width: 90, height: 60, fills: [solid(CORAL)]});
  add('ELLIPSE', group, {x: 50, y: 20, width: 90, height: 70, fills: [solid(SKY)]});
  const clipped = add('FRAME', frame, {x: 220, y: 10, width: 150, height: 90, rotation: 6, cornerRadius: 20, clipsContent: true, fills: [solid(LIME)]});
  add('ELLIPSE', clipped, {x: 100, y: 40, width: 120, height: 120, fills: [solid(PLUM)], blendMode: 'MULTIPLY'});
  add('RECTANGLE', clipped, {x: -20, y: -20, width: 80, height: 80, fills: [solid(CORAL)]});
  const union = add('BOOLEAN_OPERATION', frame, {x: 420, y: 10, width: 150, height: 90, booleanOperation: 'UNION', fills: [solid(INK)]});
  add('RECTANGLE', union, {x: 0, y: 0, width: 90, height: 60, cornerRadius: 10, fills: [solid(INK)]});
  add('ELLIPSE', union, {x: 60, y: 30, width: 90, height: 60, fills: [solid(INK)]});
  const subtract = add('BOOLEAN_OPERATION', frame, {x: 620, y: 10, width: 150, height: 90, booleanOperation: 'SUBTRACT', fills: [solid(PLUM)]});
  add('RECTANGLE', subtract, {x: 0, y: 0, width: 120, height: 90, cornerRadius: 10, fills: [solid(PLUM)]});
  add('ELLIPSE', subtract, {x: 60, y: 20, width: 90, height: 60, fills: [solid(PLUM)]});
  add('RECTANGLE', frame, {x: 820, y: 10, width: 90, height: 90, cornerRadius: 30, cornerSmoothing: 0.6, fills: [solid(SKY)]});
  add('RECTANGLE', frame, {x: 930, y: 10, width: 90, height: 90, rectangleCornerRadii: [0, 40, 0, 40], fills: [solid(CORAL)]});
  add('POLYGON', frame, {x: 1040, y: 10, width: 90, height: 90, pointCount: 6, cornerRadius: 8, fills: [solid(LIME)], strokes: [solid(INK)], strokeWeight: 3, strokeAlign: 'CENTER'});
  add('ELLIPSE', frame, {x: 1140, y: 10, width: 80, height: 90, fills: [solid(PLUM)], arcData: {startingAngle: 0.3, endingAngle: 4.5, innerRadius: 0.5}});

  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}

/** A page like `heavyPage()` with any layer count (B0's gen-file `--kind page` shape: screens of 10 sections
 *  of a group of 48 layers, 501 layers a screen, 8 screens a row). `layers` counts every node but the page. */
export function generatedPage(layers: number): DesignDocument {
  const doc = createDocument('page', `Page ${layers}`);
  let n = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>) => {
    const id = `n${++n}`;
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  const kinds: NodeType[] = ['RECTANGLE', 'TEXT', 'ELLIPSE', 'VECTOR', 'RECTANGLE', 'LINE'];
  const screens = Math.max(1, Math.round(layers / 501));
  for (let s = 0; s < screens; s++) {
    const screen = add('FRAME', 'page', {name: `Screen ${s + 1}`, x: (s % 8) * 1600, y: Math.floor(s / 8) * 2200, width: 1440, height: 2000});
    for (let k = 0; k < 10; k++) {
      const section = add('FRAME', screen, {name: `Section ${k + 1}`, x: 0, y: k * 200, width: 1440, height: 200});
      const group = add('GROUP', section, {name: `Group ${k + 1}`, x: 20, y: 20, width: 1400, height: 160});
      for (let i = 0; i < 48; i++) {
        const type = kinds[i % kinds.length];
        add(type, group, {x: 20 + (i % 12) * 110, y: 20 + Math.floor(i / 12) * 38, width: 100, height: type === 'LINE' ? 0 : 30, ...(type === 'TEXT' ? {text: defaultTextProps('Text')} : {})});
      }
    }
  }
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}

export const FIXTURES: readonly Fixture[] = [
  {name: 'effects', source: 'scripts/goldens/fixtures.ts effectsFixture()', build: effectsFixture},
  {name: 'heavy-page', source: 'tests/helpers/design-big-files.ts heavyPage()', build: heavyPage},
  {name: 'product-file', source: 'tests/helpers/design-big-files.ts productFile()', build: () => productFile()},
  ...DESIGN_TEMPLATES.map(template => ({
    name: `template-${template.id}`,
    source: `shared/design/templates "${template.name}"`,
    build: () => template.build({measurer: testMeasurer, newId: counter('t')}),
  })),
];

export const fixtureByName = (name: string): Fixture | undefined => FIXTURES.find(fixture => fixture.name === name);
