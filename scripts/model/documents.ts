// Hand-built documents for the fixture set (scripts/fixtures/design-documents.ts): what the templates and the big files never
// carry. A "kitchen sink" that sets every optional field of a layer and every variant of every union of types.ts, a board with
// every board object, a file that copied components, styles and variables from a shared library, the unit tests' small
// documents (schema, instances, deep nesting) and the results of a Figma and an SVG import. Every builder is deterministic
// given the seeded ids the generator installs. The few Cyrillic strings left (a URL path, a picture name, some text contents, the
// 'п' name filler and the imported files' text) are deliberate non-ASCII data for the Rust/TypeScript parity checks.

import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid, BLACK, WHITE} from '../../shared/design/defaults';
import type {
  Action, AnnotationPropertyType, DesignDocument, Effect, LayoutGrid, NodeId, NodeType, Paint, PathCommand, Reaction, SceneNode, Style, TextStyle, Transition, Trigger,
} from '../../shared/design/types';
import {LIBRARY_PAGE_ID} from '../../shared/design/types';
import {sceneNodeSchema, designDocumentSchema} from '../../shared/design/schema';
import {normalizeDocument} from '../../shared/design/normalize';
import {addComponentProperty, bindProperty, createInstance, setInstanceProperty, withOverrideTracking} from '../../shared/design/components';
import {combineAsVariants, setVariantProperty} from '../../shared/design/variants';
import {beginTransaction} from '../../shared/design/transaction';
import {applyLibraryImport, buildLibrarySnapshot, snapshotPart, validateLibraryImport, type LibraryImport} from '../../shared/design/libraries';
import {createBoardDocument} from '../../shared/design/board/document';
import {installBoardSteps} from '../../shared/design/board/install';
import {
  createBoardSection, createBoardText, createConnector, createShape, createStamp, createSticker, createSticky, createStroke, createTable, createWashi,
  insertPieces, type NewId,
} from '../../shared/design/board/create';
import {BOARD_FLOWCHART_SHAPES, BOARD_SHAPES} from '../../shared/design/board/shapes';
import {STAMPS, STICKERS} from '../../shared/design/board/art';
// Types only: the module itself is loaded by the generator (it needs shared/fonts.ts, which the extraction may not have brought yet).
import type {FigmaFile, FigmaNode, UploadedImage} from '../../shared/design/figma-import';
type FigmaModule = typeof import('../../shared/design/figma-import');
import {importSvg, type SvgNode} from '../../shared/design/svg-import';
import {DESIGN_FIELD_LIMITS as L} from '../../shared/design/document-limits';
import {testMeasurer} from '../../tests/helpers/design-big-files';
import {defOf, objectShape, unwrap, type Schema} from './schema-walk';

const measurer = testMeasurer;
const normalized = (doc: DesignDocument) => normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer});

/** The values of an enum field of a layer (or of a nested object), read from the schema so the cycle stays complete. */
function enumAt(schema: Schema, ...path: string[]): string[] {
  let at = schema;
  for (const name of path) at = unwrap(objectShape(unwrap(at).core)[name]).core;
  return defOf(at).values as string[];
}
const nodeEnum = (...path: string[]) => enumAt(sceneNodeSchema, ...path);
const pick = <T>(list: readonly T[], i: number): T => list[((i % list.length) + list.length) % list.length];

type Doc = DesignDocument;
function adder(doc: Doc) {
  return (type: NodeType, id: NodeId, parentId: NodeId, props: Partial<SceneNode> = {}): SceneNode => {
    const node = createNode(type, {...props, id, parentId});
    doc.nodes[id] = node;
    doc.nodes[parentId].children!.push(id);
    return node;
  };
}

const alias = (id: string) => ({type: 'VARIABLE_ALIAS' as const, id});
const rgba = (r: number, g: number, b: number, a = 1) => ({r, g, b, a});

// ── Paints, effects, grids, prototypes: every variant ───────────────────────────────────────────

const BLEND = nodeEnum('blendMode');
const GRADIENTS = ['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'] as const;
const SCALE_MODES = ['FILL', 'FIT', 'CROP', 'TILE'] as const;

function gradient(type: (typeof GRADIENTS)[number], i: number): Paint {
  return {
    type, opacity: 0.25 + (i % 4) * 0.25, visible: i % 5 !== 4, blendMode: pick(BLEND, i) as Paint['blendMode'],
    gradientStops: [{position: 0, color: rgba(1, 0, 0)}, {position: 0.5, color: rgba(0, 1, 0, 0.5)}, {position: 1, color: rgba(0, 0, 1, 0)}],
    gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}],
  };
}
function image(ref: string, scaleMode: (typeof SCALE_MODES)[number], i: number): Paint {
  const paint: Paint = {type: 'IMAGE', imageRef: ref, scaleMode, opacity: 1, visible: true, blendMode: pick(BLEND, i + 3) as Paint['blendMode']};
  if (scaleMode === 'CROP') paint.imageTransform = [[0.5, 0, 0.25], [0, 0.5, 0.1]];
  if (scaleMode === 'TILE') paint.scalingFactor = 0.5;
  paint.rotation = pick([0, 90, 180, 270], i);
  if (i % 2 === 0) paint.filters = {exposure: 0.2, contrast: -0.1, saturation: 0.3, temperature: -0.4, tint: 0.5, highlights: -0.6, shadows: 0.7};
  return paint;
}
const shadow = (type: 'DROP_SHADOW' | 'INNER_SHADOW', i: number): Effect => ({
  type, color: rgba(0, 0, 0, 0.2), offset: {x: i, y: 2 + i}, radius: 4 + i, spread: i - 2, visible: i % 3 !== 2, blendMode: pick(BLEND, i + 5) as never,
  ...(type === 'DROP_SHADOW' && i % 2 ? {showShadowBehindNode: true} : {}),
});
const blur = (type: 'LAYER_BLUR' | 'BACKGROUND_BLUR', radius: number): Effect => ({type, radius, visible: true});

/** Every paint variant with every blend mode (17 solids, 17 gradients, 17 pictures): one list fits any paint field (100 max). */
function paintMatrix(): Paint[] {
  const out: Paint[] = [];
  BLEND.forEach((blendMode, i) => {
    const solidPaint: Paint = {...solid({r: i / 17, g: 0.5, b: 1 - i / 17}, (i % 4) / 4 + 0.25), blendMode: blendMode as never, visible: i % 6 !== 5};
    if (i % 3 === 0) solidPaint.boundVariables = {color: alias('vColor')};
    if (i % 3 === 1) solidPaint.boundVariables = {};
    out.push(solidPaint, {...gradient(pick(GRADIENTS, i), i), blendMode: blendMode as never}, {...image(i % 5 === 4 ? '' : pick(['img1', 'img-2'], i), pick(SCALE_MODES, i), i), blendMode: blendMode as never});
  });
  return out;
}
/** Shadows of both kinds with every blend mode, and both blurs. */
const effectMatrix = (): Effect[] => [...BLEND.map((blendMode, i) => ({...shadow(i % 2 ? 'INNER_SHADOW' : 'DROP_SHADOW', i), blendMode: blendMode as never})), blur('LAYER_BLUR', 2), blur('BACKGROUND_BLUR', 12)];

const GRIDS: LayoutGrid[] = [
  {pattern: 'GRID', sectionSize: 8, visible: true, color: rgba(1, 0, 0, 0.1)},
  {pattern: 'COLUMNS', alignment: 'STRETCH', count: 12, gutterSize: 24, offset: 120, sectionSize: 76, visible: true, color: rgba(1, 0, 0, 0.08)},
  {pattern: 'ROWS', alignment: 'MIN', count: 4, gutterSize: 16, offset: 0, sectionSize: 100, visible: false, color: rgba(0, 0, 1, 0.08)},
  {pattern: 'COLUMNS', alignment: 'MAX', count: 3, gutterSize: 10, offset: 5, sectionSize: 50, visible: true, color: rgba(0, 1, 0, 0.1)},
  {pattern: 'ROWS', alignment: 'CENTER', count: 2, gutterSize: 0, offset: 0, sectionSize: 20, visible: true, color: rgba(0, 1, 1, 0.1)},
];

const TRIGGERS: Trigger[] = [
  ...(['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'ON_DRAG', 'MOUSE_ENTER', 'MOUSE_LEAVE', 'MOUSE_DOWN', 'MOUSE_UP'] as const).map(type => ({type})),
  {type: 'AFTER_TIMEOUT', timeout: 0.8},
  {type: 'ON_KEY_DOWN', keyCode: 'Shift+K'},
];
const EASINGS = ['LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'EASE_IN_BACK', 'EASE_OUT_BACK', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW'] as const;
const DIRECTIONS = ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'] as const;
function transitions(): Transition[] {
  const out: Transition[] = [{type: 'INSTANT'}];
  EASINGS.forEach((easing, i) => out.push({type: pick(['DISSOLVE', 'SMART_ANIMATE'] as const, i), duration: 0.3 + i / 100, easing}));
  EASINGS.forEach((easing, i) =>
    out.push({type: pick(['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'] as const, i), direction: pick(DIRECTIONS, i), ...(i % 2 ? {matchLayers: i % 4 === 1} : {}), duration: 0.2 + i / 10, easing}));
  return out;
}
const NAVIGATIONS = ['NAVIGATE', 'OVERLAY', 'SWAP', 'SCROLL_TO', 'CHANGE_TO'] as const;
function reactions(destination: NodeId): Reaction[] {
  const all = transitions();
  const actions: Action[] = NAVIGATIONS.map((navigation, i) => ({
    type: 'NODE', navigation, destinationId: destination, transition: pick(all, i * 2),
    ...(i === 0 ? {preserveScrollPosition: true, resetScrollPosition: false} : {}), ...(navigation === 'OVERLAY' ? {overlayRelativePosition: {x: 12, y: -8}} : {}),
  }));
  const more: Action[] = [{type: 'BACK'}, {type: 'CLOSE'}, {type: 'URL', url: 'https://foo.test/путь?q=1', openInNewTab: true}, {type: 'URL', url: 'mailto:hi@foo.test', openInNewTab: false}];
  return TRIGGERS.map((trigger, i) => ({trigger, actions: i === 0 ? actions : i === 1 ? more : i === 2 ? all.map(transition => ({type: 'NODE', navigation: 'NAVIGATE', destinationId: destination, transition})) : [pick([...actions, ...more], i)]}));
}

const MARKERS = nodeEnum('strokeStartMarker');
const PROFILES = ['UNIFORM', 'WEDGE', 'TAPER', 'QUARTER_TAPER', 'EYE', 'MIRRORED_TAPER', 'CUSTOM'] as const;
const CURVE: PathCommand[] = [{type: 'M', x: 0, y: 40}, {type: 'C', x1: 20, y1: 0, x2: 60, y2: 0, x: 80, y: 40}, {type: 'Q', x1: 90, y1: 60, x: 100, y: 40}, {type: 'L', x: 100, y: 0}];

const ANNOTATION_PROPERTIES: AnnotationPropertyType[] = [
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'fills', 'strokes', 'strokeWeight', 'cornerRadius', 'effects', 'opacity',
  'textStyleId', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'layoutMode', 'itemSpacing', 'padding',
  'alignItems', 'mainComponent',
];
const textStyle = (patch: Partial<TextStyle> = {}): TextStyle => ({...defaultTextProps().style, ...patch});

// ── The kitchen sink ─────────────────────────────────────────────────────────────────────────────

/** One file that sets every optional field of a layer and every variant of every union of types.ts at least once. */
export function kitchenSink(): DesignDocument {
  const doc = createDocument('ks', 'Everything');
  const add = adder(doc);
  doc.pages.push('ks2');
  doc.nodes.ks2 = createNode('PAGE', {id: 'ks2', name: 'Prototype'});
  doc.nodes[LIBRARY_PAGE_ID] = createNode('PAGE', {id: LIBRARY_PAGE_ID, name: 'Libraries'});
  Object.assign(doc.nodes.ks, {
    backgroundColor: {r: 0.96, g: 0.96, b: 0.96}, prototypeBackground: {r: 0, g: 0, b: 0},
    guides: [{axis: 'X', offset: 120}, {axis: 'Y', offset: -40.5}], prototypeDevice: {type: 'PRESET', presetId: 'iphone-16', rotation: 90},
    flowStartingPoints: [{nodeId: 'frame', name: 'Main flow'}, {nodeId: 'frame2', name: 'Second'}],
  } satisfies Partial<SceneNode>);
  Object.assign(doc.nodes.ks2, {prototypeDevice: {type: 'PRESET', presetId: 'desktop', rotation: 0}, backgroundColor: {r: 0.1, g: 0.1, b: 0.1}});

  doc.images = {
    img1: {url: '/uploads/img1.png', width: 1200, height: 800, name: 'Фото.jpg'},
    'img-2': {url: '/uploads/0b5c7f3e-1d2a-4c55-9b8e-2f7a1c3d4e5f.webp', width: 64, height: 64},
  };

  // Styles of every type, one copied from a library.
  const remote = {libraryId: '0f1e2d3c-4b5a-4968-8776-655443322110', key: 'k-brand', version: 3};
  const headline = textStyle({fontFamily: 'Manrope', fontWeight: 700, fontSize: 32, lineHeight: {unit: 'PIXELS', value: 40}, letterSpacing: {unit: 'PIXELS', value: -0.5}, textCase: 'UPPER'});
  const styles: Style[] = [
    {id: 'sFill', type: 'FILL', name: 'Brand/Primary', description: 'Main color', paints: [solid({r: 0.05, g: 0.6, b: 1})]},
    {id: 'sStroke', type: 'FILL', name: 'Brand/Stroke', description: '', paints: [gradient('GRADIENT_ANGULAR', 1)], remote},
    {id: 'sText', type: 'TEXT', name: 'Headings/H1', description: '', text: headline},
    {id: 'sLink', type: 'TEXT', name: 'Link', description: '', text: textStyle({textDecoration: 'UNDERLINE', hyperlink: {type: 'URL', url: 'https://example.com'}})},
    {id: 'sNoLink', type: 'TEXT', name: 'No link', description: '', text: textStyle({hyperlink: null})},
    {id: 'sEffect', type: 'EFFECT', name: 'Shadows/Card', description: '', effects: [shadow('DROP_SHADOW', 1), blur('BACKGROUND_BLUR', 8)]},
    {id: 'sGrid', type: 'GRID', name: 'Grids/12', description: '', grids: GRIDS.slice(0, 3)},
    {id: 'sAllPaints', type: 'FILL', name: 'All fills', description: 'Every kind of fill with every blend mode', paints: paintMatrix()},
    {id: 'sAllEffects', type: 'EFFECT', name: 'All effects', description: '', effects: effectMatrix()},
    {id: 'sAllGrids', type: 'GRID', name: 'All grids', description: '', grids: GRIDS},
    ...(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS'] as const).map((textCase, i): Style => ({
      id: 'sCase' + i, type: 'TEXT', name: 'Case/' + textCase, description: '',
      text: textStyle({textCase, textDecoration: pick(['NONE', 'UNDERLINE', 'STRIKETHROUGH'] as const, i), lineHeight: pick([{unit: 'AUTO'}, {unit: 'PIXELS', value: 20}, {unit: 'PERCENT', value: 140}] as const, i), letterSpacing: {unit: pick(['PIXELS', 'PERCENT'] as const, i), value: i - 2}, ...(i === 3 ? {hyperlink: {type: 'NODE', nodeId: 'frame'}} : {})}),
    })),
  ];
  doc.styles = Object.fromEntries(styles.map(style => [style.id, style]));

  // Variables: every type, an alias, two modes, a hidden one and a library copy.
  doc.variableCollections = {
    col: {id: 'col', name: 'Tokens', modes: [{modeId: 'm1', name: 'Light'}, {modeId: 'm2', name: 'Dark'}], defaultModeId: 'm1', variableIds: ['vColor', 'vAlias', 'vGap', 'vLabel', 'vShow']},
    lib: {id: 'lib', name: 'Library', modes: [{modeId: 'lm', name: 'Mode 1'}], defaultModeId: 'lm', variableIds: ['vRemote'], remote: {...remote, key: 'k-col'}},
  };
  doc.variables = {
    vColor: {id: 'vColor', name: 'Color/Background', collectionId: 'col', type: 'COLOR', valuesByMode: {m1: rgba(1, 1, 1), m2: rgba(0.1, 0.1, 0.1)}, description: 'Background'},
    vAlias: {id: 'vAlias', name: 'Color/Card', collectionId: 'col', type: 'COLOR', valuesByMode: {m1: alias('vColor'), m2: alias('vRemote')}, description: ''},
    vGap: {id: 'vGap', name: 'Spacing', collectionId: 'col', type: 'FLOAT', valuesByMode: {m1: 16, m2: 24.5}, description: ''},
    vLabel: {id: 'vLabel', name: 'Caption', collectionId: 'col', type: 'STRING', valuesByMode: {m1: 'Buy', m2: ''}, description: '', hiddenFromPublishing: true},
    vShow: {id: 'vShow', name: 'Show', collectionId: 'col', type: 'BOOLEAN', valuesByMode: {m1: true, m2: false}, description: '', hiddenFromPublishing: false},
    vRemote: {id: 'vRemote', name: 'Remote', collectionId: 'lib', type: 'COLOR', valuesByMode: {lm: rgba(0.5, 0.2, 0.9, 0.8)}, description: '', remote: {...remote, key: 'k-var'}},
  };

  // A frame with every frame-like field, auto layout spelled out, prototype settings and every reaction.
  add('FRAME', 'frame', 'ks', {
    name: 'Screen', x: 0, y: 0, width: 393, height: 852, clipsContent: true, fillStyleId: 'sFill', fills: [solid({r: 0.05, g: 0.6, b: 1})],
    strokeStyleId: 'sStroke', strokes: [gradient('GRADIENT_ANGULAR', 1)], effectStyleId: 'sEffect', effects: [shadow('DROP_SHADOW', 1), blur('BACKGROUND_BLUR', 8)],
    gridStyleId: 'sGrid', layoutGrids: GRIDS, overflowDirection: 'BOTH', overlayPositionType: 'MANUAL',
    overlayBackground: {type: 'SOLID_COLOR', color: rgba(0, 0, 0, 0.5)}, overlayBackgroundInteraction: 'CLOSE_ON_CLICK_OUTSIDE',
    rectangleCornerRadii: [24, 24, 0, 0], cornerRadius: 24, cornerSmoothing: 0.6, individualStrokeWeights: {top: 1, right: 0, bottom: 2, left: 0},
    minWidth: 320, maxWidth: 1440, minHeight: 100, maxHeight: 2000, constrainProportions: true,
    autoLayout: {
      ...defaultAutoLayout('VERTICAL'), layoutWrap: 'WRAP', primaryAxisAlignItems: 'SPACE_BETWEEN', counterAxisAlignItems: 'BASELINE', counterAxisAlignContent: 'SPACE_BETWEEN',
      paddingLeft: 16, paddingRight: 16, paddingTop: 24, paddingBottom: 24, itemSpacing: 12, counterAxisSpacing: 8, itemReverseZIndex: true, strokesIncludedInLayout: true,
    },
    boundVariables: {itemSpacing: alias('vGap'), paddingLeft: alias('vGap'), visible: alias('vShow')},
    exportSettings: [
      {format: 'PNG', suffix: '@2x', constraint: {type: 'SCALE', value: 2}},
      {format: 'JPG', suffix: '', constraint: {type: 'WIDTH', value: 640}},
      {format: 'SVG', suffix: '-svg', constraint: {type: 'SCALE', value: 1}, svgIdAttribute: true},
      {format: 'PDF', suffix: '', constraint: {type: 'HEIGHT', value: 1000}, svgIdAttribute: false},
      {format: 'WEBP', suffix: 'w', constraint: {type: 'SCALE', value: 0.5}},
    ],
    reactions: reactions('frame2'),
    annotations: [
      {id: 'a1', label: 'Paddings from tokens', categoryId: 'development', properties: [{type: 'itemSpacing'}, {type: 'padding'}, {type: 'width'}]},
      {id: 'a2', label: ''},
      {id: 'a3', label: 'All properties', categoryId: 'accessibility', properties: ANNOTATION_PROPERTIES.map(type => ({type}))},
    ],
    pluginData: {'figma:id': '1:2', note: 'import'},
  });
  add('FRAME', 'frame2', 'ks', {
    name: 'Overlay', x: 500, width: 300, height: 200, overlayBackground: {type: 'NONE'}, overlayBackgroundInteraction: 'NONE', overlayPositionType: 'BOTTOM_CENTER',
    rectangleCornerRadii: null, individualStrokeWeights: null, minWidth: null, maxWidth: null, minHeight: null, maxHeight: null, overflowDirection: 'HORIZONTAL',
    clipsContent: false, flipX: true, flipY: false, rotation: 90, opacity: 0.5, blendMode: 'MULTIPLY', locked: true,
  });
  // Children of the scrolling frame: fixed and sticky, absolute, fill and hug sizing, every constraint.
  const CONSTRAINTS = nodeEnum('constraints', 'horizontal');
  add('RECTANGLE', 'fixed', 'frame', {name: 'Header', scrollBehavior: 'FIXED', layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'STRETCH', vertical: 'MIN'}, width: 393, height: 64});
  add('RECTANGLE', 'sticky', 'frame', {name: 'Sticky', scrollBehavior: 'STICKY_SCROLLS', layoutSizingHorizontal: 'FILL', width: 361, height: 48});
  add('FRAME', 'scrolls', 'frame', {name: 'Normal', scrollBehavior: 'SCROLLS', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', autoLayout: defaultAutoLayout('HORIZONTAL'), overflowDirection: 'VERTICAL'});

  // Grid auto layout (lane N1 step 11): every track type, both placement modes, both auto-track modes, every child alignment.
  add('FRAME', 'grid', 'frame', {
    name: 'Grid', width: 361, height: 200, layoutSizingHorizontal: 'FILL', autoLayout: defaultAutoLayout('GRID'),
    grid: {
      rowCount: 2, columnCount: 3, rowGap: 8, columnGap: 12, autoTracks: 'NONE', itemsPositioning: 'MANUAL',
      rowSizes: [{type: 'FIXED', value: 40}, {type: 'FLEX'}], columnSizes: [{type: 'FLEX', value: 2}, {type: 'HUG'}, {type: 'FIXED', value: 100}],
    },
  });
  add('RECTANGLE', 'cell00', 'grid', {name: 'Cell', width: 80, height: 40, gridChild: {rowAnchorIndex: 0, columnAnchorIndex: 0, horizontalAlign: 'CENTER', verticalAlign: 'AUTO'}});
  add('RECTANGLE', 'cell01', 'grid', {name: 'Two columns wide', width: 80, height: 40, layoutSizingHorizontal: 'FILL', gridChild: {rowAnchorIndex: 0, columnAnchorIndex: 1, columnSpan: 2, horizontalAlign: 'MAX', verticalAlign: 'CENTER'}});
  add('RECTANGLE', 'cell10', 'grid', {name: 'Two rows tall', width: 80, height: 100, layoutSizingVertical: 'FILL', gridChild: {rowAnchorIndex: 1, columnAnchorIndex: 0, rowSpan: 1, horizontalAlign: 'AUTO', verticalAlign: 'MIN'}});
  add('FRAME', 'grid-auto', 'frame', {
    name: 'Auto grid', width: 361, height: 120, layoutSizingVertical: 'HUG', autoLayout: {...defaultAutoLayout('GRID'), paddingLeft: 8, paddingTop: 8},
    grid: {rowCount: 1, columnCount: 2, rowGap: 4, columnGap: 4, autoTracks: 'ROWS', itemsPositioning: 'ROW_AUTO_FLOW', rowSizes: [{type: 'HUG'}], columnSizes: [{type: 'FLEX'}, {type: 'HUG'}]},
  });
  for (let i = 0; i < 3; i++) add('RECTANGLE', 'auto' + i, 'grid-auto', {name: 'Auto', width: 60, height: 30, gridChild: i === 2 ? {rowSpan: 1, columnSpan: 2} : i === 1 ? {horizontalAlign: 'MIN', verticalAlign: 'MAX'} : {}});

  // Paints: every gradient, every image scale mode, a pending image, a variable-bound solid; every blend mode on layers and paints.
  add('FRAME', 'paints', 'frame2', {name: 'Fills', width: 600, height: 400, autoLayout: {...defaultAutoLayout('HORIZONTAL'), layoutWrap: 'WRAP', counterAxisAlignItems: 'CENTER', primaryAxisAlignItems: 'MAX', counterAxisAlignContent: 'AUTO'}});
  const leaf = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE'] as const;
  for (let i = 0; i < BLEND.length; i++) {
    const fills: Paint[] = [pick([...GRADIENTS.map(type => gradient(type, i)), image(i % 3 ? 'img1' : 'img-2', pick(SCALE_MODES, i), i)], i)];
    if (i === 0) fills.push({...solid({r: 1, g: 0, b: 0}, 0.5), boundVariables: {color: alias('vAlias')}});
    if (i === 1) fills.push({...solid({r: 0, g: 1, b: 0}), boundVariables: {}});
    if (i === 2) fills.push(image('', 'FILL', 2));
    const type = pick(leaf, i);
    add(type, 'paint' + i, 'paints', {
      name: 'Layer ' + i, blendMode: BLEND[i] as SceneNode['blendMode'], fills, strokes: [solid(BLACK)], strokeWeight: i % 4, dashPattern: i % 2 ? [4, 2] : [],
      strokeAlign: pick(nodeEnum('strokeAlign'), i) as SceneNode['strokeAlign'], strokeCap: pick(nodeEnum('strokeCap'), i) as SceneNode['strokeCap'],
      strokeJoin: pick(nodeEnum('strokeJoin'), i) as SceneNode['strokeJoin'], strokeMiterLimit: 4 + i, x: i * 30, width: 24, height: type === 'LINE' ? 0 : 24,
      constraints: {horizontal: pick(CONSTRAINTS, i) as SceneNode['constraints']['horizontal'], vertical: pick(CONSTRAINTS, i + 2) as SceneNode['constraints']['vertical']},
      effects: [pick([shadow('DROP_SHADOW', i), shadow('INNER_SHADOW', i), blur('LAYER_BLUR', i), blur('BACKGROUND_BLUR', i)], i)],
      ...(type === 'VECTOR' ? {vectorPaths: [{windingRule: i % 2 ? 'EVENODD' : 'NONZERO', commands: [...CURVE, {type: 'Z'}]}]} : {}),
      ...(type === 'POLYGON' ? {pointCount: 3 + i} : {}),
      ...(type === 'STAR' ? {pointCount: 5 + i, innerRadius: 0.4} : {}),
      ...(type === 'ELLIPSE' ? {arcData: {startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.4}} : {}),
    });
  }

  // Shapes with every marker and every width profile.
  add('GROUP', 'lines', 'frame2', {name: 'Lines'});
  MARKERS.forEach((marker, i) => add('LINE', 'line' + i, 'lines', {
    name: 'Line ' + i, x: 0, y: i * 10, width: 100, height: 0, strokeStartMarker: marker as SceneNode['strokeStartMarker'], strokeEndMarker: pick(MARKERS, i + 1) as SceneNode['strokeEndMarker'],
    ...(i < PROFILES.length ? {variableWidthStrokeProperties: PROFILES[i] === 'CUSTOM' ? {widthProfile: 'CUSTOM', variableWidthPoints: [{position: 0, width: 0.2}, {position: 0.5, width: 1.5}, {position: 1, width: 0}]} : {widthProfile: PROFILES[i]}} : {}),
  }));
  PROFILES.forEach((profile, i) => add('VECTOR', 'stroke' + i, 'lines', {
    name: 'Profile ' + profile, y: 100 + i * 50, width: 100, height: 40, fills: [], strokes: [solid(BLACK)], strokeWeight: 6,
    vectorPaths: [{windingRule: 'NONZERO', commands: CURVE}], variableWidthStrokeProperties: profile === 'CUSTOM' ? {widthProfile: 'CUSTOM', variableWidthPoints: []} : {widthProfile: profile},
    strokeStartMarker: 'NONE', strokeEndMarker: pick(MARKERS, i) as SceneNode['strokeEndMarker'],
  }));

  // Masks of every type, booleans of every operation.
  add('FRAME', 'masks', 'frame2', {name: 'Masks', y: 300, width: 300, height: 100, clipsContent: false});
  (['ALPHA', 'VECTOR', 'LUMINANCE'] as const).forEach((maskType, i) => {
    add('ELLIPSE', 'mask' + i, 'masks', {name: 'Mask', isMask: true, maskType, x: i * 100, width: 80, height: 80});
    add('RECTANGLE', 'masked' + i, 'masks', {name: 'Under the mask', x: i * 100, width: 100, height: 60});
  });
  add('GROUP', 'unmasked', 'masks', {name: 'No mask type'});
  add('RECTANGLE', 'mask-plain', 'unmasked', {isMask: true, width: 10, height: 10});
  (['UNION', 'INTERSECT', 'SUBTRACT', 'EXCLUDE'] as const).forEach((operation, i) => {
    add('BOOLEAN_OPERATION', 'bool' + i, 'frame2', {name: operation, booleanOperation: operation, x: i * 60, y: 450});
    add('RECTANGLE', `bool${i}a`, 'bool' + i, {width: 40, height: 40});
    add('ELLIPSE', `bool${i}b`, 'bool' + i, {x: 20, y: 20, width: 40, height: 40});
  });

  // The matrices: every paint variant × blend mode as fills and as strokes, every effect, every overlay position.
  add('RECTANGLE', 'all-fills', 'frame2', {name: 'All fills', y: 520, fills: paintMatrix(), fillStyleId: 'sAllPaints', effects: effectMatrix(), effectStyleId: 'sAllEffects'});
  add('ELLIPSE', 'all-strokes', 'frame2', {name: 'All strokes', y: 520, x: 120, fills: [], strokes: paintMatrix(), strokeWeight: 3});
  nodeEnum('overlayPositionType').forEach((position, i) =>
    add('FRAME', 'overlay' + i, 'ks2', {name: 'Overlay ' + position, x: i * 320, y: 400, width: 300, height: 200, overlayPositionType: position as never, overlayBackground: i % 2 ? {type: 'NONE'} : {type: 'SOLID_COLOR', color: rgba(0, 0, 0, i / 10)}}));

  // Text: runs with fills, styles and both hyperlinks; every alignment, case, decoration, resize, list type; a text on a path.
  const characters = 'Заголовок со ссылкой\nПункт один\nПункт два 😀\nПоследний абзац';
  add('TEXT', 'text', 'frame', {
    name: 'Text', width: 300, height: 120, textStyleId: 'sText', layoutSizingHorizontal: 'FILL',
    text: {
      ...defaultTextProps(characters), style: headline, textAlignHorizontal: 'JUSTIFIED', textAlignVertical: 'BOTTOM', textAutoResize: 'TRUNCATE', maxLines: 3,
      paragraphSpacing: 8, paragraphIndent: 4, listTypes: ['NONE', 'ORDERED', 'UNORDERED', 'NONE'],
      runs: [
        {start: 0, end: 9, style: {fontWeight: 800, italic: true, textCase: 'ORIGINAL', textDecoration: 'NONE', lineHeight: {unit: 'PIXELS', value: 30}}, fills: paintMatrix(), textStyleId: 'sText'},
        {start: 10, end: 11, style: {textCase: 'UPPER'}},
        {start: 12, end: 19, style: {hyperlink: {type: 'URL', url: 'https://foo.test'}, textDecoration: 'UNDERLINE'}},
        {start: 21, end: 31, style: {hyperlink: {type: 'NODE', nodeId: 'frame2'}, textDecoration: 'STRIKETHROUGH', textCase: 'LOWER'}},
        {start: 32, end: 43, style: {hyperlink: null, lineHeight: {unit: 'PERCENT', value: 150}, letterSpacing: {unit: 'PERCENT', value: 2}, textCase: 'TITLE'}},
        {start: 45, end: 60, style: {lineHeight: {unit: 'AUTO'}, letterSpacing: {unit: 'PIXELS', value: 1}, textCase: 'SMALL_CAPS', fontFamily: 'Inter', fontSize: 12}, fills: []},
      ],
    },
  });
  const H = nodeEnum('text', 'textAlignHorizontal'), V = nodeEnum('text', 'textAlignVertical'), R = nodeEnum('text', 'textAutoResize');
  for (let i = 0; i < 5; i++)
    add('TEXT', 'text' + i, 'frame2', {
      name: 'Text ' + i, y: 600 + i * 30,
      text: {
        ...defaultTextProps('Line ' + i), textAlignHorizontal: pick(H, i) as never, textAlignVertical: pick(V, i) as never, textAutoResize: pick(R, i) as never, maxLines: i === 3 ? null : undefined,
        style: textStyle({
          textCase: pick(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS'] as const, i), textDecoration: pick(['NONE', 'UNDERLINE', 'STRIKETHROUGH'] as const, i),
          hyperlink: pick([{type: 'URL', url: 'http://example.com/a?b=c#d'}, {type: 'NODE', nodeId: 'frame'}, null, undefined] as const, i),
        }),
      },
    });
  for (const [i, side] of (['LEFT', 'RIGHT'] as const).entries())
    add('TEXT', 'onpath' + i, 'frame2', {
      name: 'Text on path', y: 800, x: i * 200, width: 160, height: 80, text: {...defaultTextProps('Text on path'), textAlignHorizontal: 'CENTER', textAlignVertical: 'CENTER'},
      textPath: {
        commands: i ? [{type: 'M', x: 0, y: 80}, {type: 'C', x1: 40, y1: 0, x2: 120, y2: 0, x: 160, y: 80}] : [{type: 'M', x: 0, y: 80}, {type: 'L', x: 40, y: 40}, {type: 'Q', x1: 80, y1: 0, x: 120, y: 40}, {type: 'Z'}],
        startOffset: 0.25 * (i + 1), side,
      },
    });

  // SECTION, SLICE, a hidden layer.
  add('SECTION', 'section', 'ks', {name: 'Section', x: 1000, width: 800, height: 600, cornerRadius: 12});
  add('SLICE', 'slice', 'section', {name: 'Slice', width: 200, height: 100, exportSettings: [{format: 'PNG', suffix: '', constraint: {type: 'SCALE', value: 3}}]});
  add('RECTANGLE', 'hidden', 'section', {visible: false, name: 'Hidden'});

  // Components: properties of every kind, references, a variant set, instances with values and overrides, an exposed instance.
  add('COMPONENT', 'icon', 'section', {name: 'Icon/Star', width: 24, height: 24, description: 'Star'});
  add('STAR', 'icon-star', 'icon', {width: 24, height: 24, pointCount: 5});
  add('COMPONENT', 'icon2', 'section', {name: 'Icon/Heart', x: 40, width: 24, height: 24});
  add('ELLIPSE', 'icon2-dot', 'icon2', {width: 24, height: 24});
  add('COMPONENT', 'btn-a', 'section', {name: 'State=Default', y: 100, width: 140, height: 44, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 8, paddingLeft: 16, paddingRight: 16, counterAxisAlignItems: 'CENTER', primaryAxisAlignItems: 'CENTER'}, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'});
  add('TEXT', 'btn-a-label', 'btn-a', {name: 'Caption', text: defaultTextProps('Button')});
  add('COMPONENT', 'btn-b', 'section', {name: 'State=Hover', x: 200, y: 100, width: 140, height: 44, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 8, paddingLeft: 16, paddingRight: 16}, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'});
  add('TEXT', 'btn-b-label', 'btn-b', {name: 'Caption', text: defaultTextProps('Button')});
  let next: DesignDocument = normalized(doc);
  next = createInstance(next, 'icon', {parentId: 'btn-a', newId: 'btn-a-icon'}).doc;
  next = createInstance(next, 'icon', {parentId: 'btn-b', newId: 'btn-b-icon'}).doc;
  next = combineAsVariants(next, ['btn-a', 'btn-b'], 'btn').doc;
  const show = addComponentProperty(next, 'btn', {name: 'Icon', type: 'BOOLEAN', defaultValue: true});
  next = show.doc;
  const label = addComponentProperty(next, 'btn', {name: 'Caption', type: 'TEXT', defaultValue: 'Button'});
  next = label.doc;
  const swap = addComponentProperty(next, 'btn', {name: 'Badge', type: 'INSTANCE_SWAP', defaultValue: 'icon', preferredValues: ['icon', 'icon2']});
  next = swap.doc;
  for (const id of ['btn-a', 'btn-b']) {
    next = bindProperty(next, `${id}-icon`, 'visible', show.key).doc;
    next = bindProperty(next, `${id}-icon`, 'mainComponent', swap.key).doc;
    next = bindProperty(next, `${id}-label`, 'characters', label.key).doc;
  }
  next = {...next, nodes: {...next.nodes, 'btn-a-icon': {...next.nodes['btn-a-icon'], isExposedInstance: true}}};
  next = createInstance(next, 'btn', {parentId: 'frame', newId: 'buy'}).doc;
  next = setVariantProperty(next, 'buy', 'State', 'Hover').doc;
  next = setInstanceProperty(next, 'buy', label.key, 'Buy').doc;
  next = setInstanceProperty(next, 'buy', show.key, false).doc;
  next = setInstanceProperty(next, 'buy', swap.key, 'icon2').doc;
  next = createInstance(next, 'btn', {parentId: 'frame', newId: 'more'}).doc;
  // An override on a copy inside the instance (as the editor records it).
  const copyId = Object.keys(next.nodes).find(id => id.startsWith('more;') && next.nodes[id].type === 'TEXT')!;
  const changes = withOverrideTracking(next, copyId, {fills: [solid({r: 1, g: 0, b: 1})], opacity: 0.8});
  next = {...next, nodes: {...next.nodes, [copyId]: {...next.nodes[copyId], ...changes}}};

  // The library page: a copied component and a copied variant set, each with `remote`.
  const libNodes = {...next.nodes};
  const libAdd = (type: NodeType, id: NodeId, parentId: NodeId, props: Partial<SceneNode> = {}) => {
    libNodes[id] = createNode(type, {...props, id, parentId});
    libNodes[parentId] = {...libNodes[parentId], children: [...libNodes[parentId].children!, id]};
  };
  libAdd('COMPONENT', 'r0f1e2d3c4b5a4968:btn', LIBRARY_PAGE_ID, {name: 'Button', remote: {...remote, key: 'btn'}, description: 'From the library'});
  libAdd('RECTANGLE', 'r0f1e2d3c4b5a4968:bg', 'r0f1e2d3c4b5a4968:btn', {name: 'Background'});
  libAdd('COMPONENT_SET', 'r0f1e2d3c4b5a4968:set', LIBRARY_PAGE_ID, {
    name: 'Tag', remote: {...remote, key: 'set', version: 1}, componentPropertyDefinitions: {Size: {type: 'VARIANT', defaultValue: 'S', variantOptions: ['S', 'M']}},
  });
  libAdd('COMPONENT', 'r0f1e2d3c4b5a4968:s', 'r0f1e2d3c4b5a4968:set', {name: 'Size=S'});
  libAdd('COMPONENT', 'r0f1e2d3c4b5a4968:m', 'r0f1e2d3c4b5a4968:set', {name: 'Size=M', x: 120});
  next = {...next, nodes: libNodes};
  next = createInstance(next, 'r0f1e2d3c4b5a4968:btn', {parentId: 'ks2', newId: 'libuse'}).doc;

  // Measurements of the page (both offsets, free text) and a mode choice per frame.
  next = {
    ...next,
    nodes: {
      ...next.nodes,
      ks: {
        ...next.nodes.ks,
        measurements: [
          {id: 'm1', start: {nodeId: 'frame', side: 'LEFT'}, end: {nodeId: 'frame', side: 'RIGHT'}, offset: {type: 'INNER', relative: 0.5}},
          {id: 'm2', start: {nodeId: 'frame', side: 'TOP'}, end: {nodeId: 'section', side: 'BOTTOM'}, offset: {type: 'OUTER', fixed: -24}, freeText: 'Spacing'},
          {id: 'm3', start: {nodeId: 'frame', side: 'RIGHT'}, end: {nodeId: 'frame2', side: 'LEFT'}, offset: {type: 'OUTER', fixed: 0}, freeText: ''},
          {id: 'm4', start: {nodeId: 'section', side: 'BOTTOM'}, end: {nodeId: 'frame2', side: 'TOP'}, offset: {type: 'INNER', relative: 1}},
        ],
      },
    },
    variableModes: {frame: {col: 'm2'}, frame2: {col: 'm1', lib: 'lm'}},
  };
  return normalized(next);
}

// ── Small documents of the unit tests ──────────────────────────────────────────────────────────

/** tests/design-schema.test.ts `sample()`: a page with a frame holding a rectangle (a picture), a text with a run and a group. */
export function schemaSample(): DesignDocument {
  const doc = createDocument('page');
  const add = adder(doc);
  add('FRAME', 'frame', 'page', {width: 375, height: 812, name: 'Home screen'});
  add('RECTANGLE', 'rect', 'frame', {fills: [{type: 'IMAGE', imageRef: 'dz-1', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  const text = add('TEXT', 'text', 'frame');
  text.text!.characters = 'Привет, дизайн';
  text.text!.runs = [{start: 0, end: 6, style: {fontWeight: 700}, fills: [solid(BLACK)]}];
  add('GROUP', 'group', 'frame');
  add('ELLIPSE', 'ellipse', 'group');
  doc.images['dz-1'] = {url: '/uploads/dz-1.webp', width: 1200, height: 800, name: 'Фото.jpg'};
  doc.nodes.frame.reactions = [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'https://foo.test', openInNewTab: true}]}];
  return doc;
}

/** tests/design-schema.test.ts: instance copies `${instanceId};${mainId}`, a nested instance and its copy (no components behind them). */
export function instanceIds(): DesignDocument {
  const doc = schemaSample();
  const add = adder(doc);
  add('INSTANCE', 'inst', 'frame', {componentId: 'comp'});
  add('RECTANGLE', 'inst;child', 'inst', {mainId: 'child'});
  add('INSTANCE', 'inst;nested', 'inst', {mainId: 'nested', componentId: 'other'});
  add('TEXT', 'inst;nested;leaf', 'inst;nested', {mainId: 'leaf'});
  add('FRAME', 'holder', 'inst');
  add('RECTANGLE', 'inst;deep', 'holder', {mainId: 'deep'});
  return doc;
}

/** Nesting exactly at the depth limit (tests/design-schema.test.ts refuses one more), and edge values that are still valid. */
export function edges(): DesignDocument {
  const doc = createDocument('page', 'п'.repeat(L.name));
  const add = adder(doc);
  let parent = 'page';
  // The page is level 0: 255 containers, then the leaf at level 256 (one more is refused).
  for (let i = 0; i < L.depth - 1; i++) parent = add(i % 2 ? 'GROUP' : 'FRAME', 'deep' + i, parent, {x: -1e9, y: 1e9, width: 1e9, height: 0}).id;
  add('TEXT', 'leaf', parent, {
    name: '😀'.repeat(L.name / 2), opacity: 0, rotation: -1e9, strokeWeight: 1e9, strokeMiterLimit: 0,
    text: {...defaultTextProps('a😀'.repeat(10)), runs: [{start: 0, end: 1, style: {}}, {start: 1, end: 3, style: {fontSize: 0, fontWeight: 1}}, {start: 29, end: 30, style: {fontWeight: 1000, fontSize: 100_000}}], maxLines: 100_000},
  });
  add('POLYGON', 'poly-min', 'page', {pointCount: 3, cornerRadius: 0, cornerSmoothing: 1, innerRadius: 0});
  add('STAR', 'star-max', 'page', {pointCount: 1000, innerRadius: 1, opacity: 1});
  add('RECTANGLE', '-:,._ABCabc0189', 'page', {name: '', fills: Array.from({length: L.paints}, () => solid(WHITE)), dashPattern: Array.from({length: L.dashPattern}, (_, i) => i)});
  add('VECTOR', 'v', 'page', {vectorPaths: [{windingRule: 'NONZERO', commands: Array.from({length: 2000}, (_, i) => ({type: 'L' as const, x: i, y: -i}))}]});
  doc.images['x'.repeat(L.id)] = {url: '/uploads/' + 'a'.repeat(200), width: 1e6, height: Number.MIN_VALUE, name: 'n'.repeat(L.shortText)};
  doc.nodes.page.guides = [{axis: 'X', offset: 1e9}, {axis: 'Y', offset: -1e9}, {axis: 'X', offset: 5e-324}, {axis: 'Y', offset: 0.1 + 0.2}];
  return doc;
}

// ── A file that uses a shared library ────────────────────────────────────────────────────────────

const LIBRARY = '0f1e2d3c-4b5a-4968-8776-655443322110';
function addTo(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}

/** tests/design-libraries.test.ts `libraryDoc()`: a component with a styled background, a variable-bound radius, a picture and a nested
 *  instance whose dot binds a colour aliasing another. */
export function libraryDoc(): DesignDocument {
  const RED = {r: 1, g: 0, b: 0}, BLUE = {r: 0, g: 0, b: 1};
  let doc = createDocument('p');
  doc = {
    ...doc,
    styles: {
      sBrand: {id: 'sBrand', type: 'FILL', name: 'Brand/Primary', description: '', paints: [solid(BLUE)]},
      sTitle: {id: 'sTitle', type: 'TEXT', name: 'Title', description: 'Large', text: defaultTextProps('').style},
    },
    images: {'dz-pic': {url: '/uploads/dz-pic.webp', width: 10, height: 10}},
    variableCollections: {col: {id: 'col', name: 'Tokens', modes: [{modeId: 'm1', name: 'Light'}], defaultModeId: 'm1', variableIds: ['vBase', 'vPrimary', 'vRadius', 'vHidden']}},
    variables: {
      vBase: {id: 'vBase', name: 'Color/Base', collectionId: 'col', type: 'COLOR', valuesByMode: {m1: {...RED, a: 1}}, description: ''},
      vPrimary: {id: 'vPrimary', name: 'Color/Primary', collectionId: 'col', type: 'COLOR', valuesByMode: {m1: alias('vBase')}, description: ''},
      vRadius: {id: 'vRadius', name: 'Radius', collectionId: 'col', type: 'FLOAT', valuesByMode: {m1: 8}, description: ''},
      vHidden: {id: 'vHidden', name: 'Internal', collectionId: 'col', type: 'FLOAT', valuesByMode: {m1: 1}, description: '', hiddenFromPublishing: true},
    },
  };
  doc = addTo(doc, 'COMPONENT', {id: 'icon', parentId: 'p', name: 'Icon', x: 400, y: 0, width: 16, height: 16});
  doc = addTo(doc, 'ELLIPSE', {id: 'dot', parentId: 'icon', name: 'Dot', width: 16, height: 16, fills: [{...solid(RED), boundVariables: {color: alias('vPrimary')}}]});
  doc = addTo(doc, 'COMPONENT', {id: 'btn', parentId: 'p', name: 'Button', x: 40, y: 40, width: 120, height: 40, description: 'Primary button'});
  doc = addTo(doc, 'RECTANGLE', {id: 'bg', parentId: 'btn', name: 'Background', width: 120, height: 40, fills: [solid(BLUE)], fillStyleId: 'sBrand', boundVariables: {cornerRadius: alias('vRadius')}, constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}});
  doc = addTo(doc, 'RECTANGLE', {id: 'pic', parentId: 'btn', name: 'Picture', width: 8, height: 8, fills: [{type: 'IMAGE', imageRef: 'dz-pic', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  doc = addTo(doc, 'TEXT', {id: 'label', parentId: 'btn', name: 'Caption', x: 10, y: 10, width: 60, height: 20, text: defaultTextProps('Button')});
  doc = createInstance(doc, 'icon', {parentId: 'btn', x: 96, y: 12, newId: 'ico'}).doc;
  doc = addTo(doc, 'COMPONENT', {id: 'draft', parentId: 'p', name: '_Draft', x: 0, y: 200});
  return doc;
}

/** A file that copied "Button" (with what it uses), the brand style and the token collection from the library, and placed an instance. */
export function libraryConsumer(): DesignDocument {
  const snapshot = buildLibrarySnapshot(libraryDoc(), {components: ['btn'], styles: ['sBrand'], variableCollections: ['col']}, {version: 1});
  const part = snapshotPart(snapshot, {components: ['btn'], styles: ['sBrand'], variableCollections: ['col']});
  const payload: LibraryImport = {
    libraryId: LIBRARY, version: 1, components: [...part.selection.components], styles: [...part.selection.styles], variableCollections: [...part.selection.variableCollections],
    document: JSON.parse(JSON.stringify(part.document)),
  };
  const checked = validateLibraryImport(payload);
  if (!checked.ok) throw Error('library import: ' + checked.error + ' at ' + checked.path);
  let doc = addTo(createDocument('home', 'Home'), 'FRAME', {id: 'screen', parentId: 'home', name: 'Screen', width: 375, height: 812});
  const tx = beginTransaction(doc);
  const result = applyLibraryImport(tx, checked.value);
  doc = tx.commit({measurer}).doc;
  const component = Object.values(doc.nodes).find(node => node.parentId === LIBRARY_PAGE_ID && node.remote?.key === 'btn');
  if (!component) throw Error('library import: no copied component (' + JSON.stringify(result).slice(0, 200) + ')');
  doc = createInstance(doc, component.id, {parentId: 'screen', x: 20, y: 20, newId: 'use1'}).doc;
  return normalized(doc);
}

// ── A board with every board object ─────────────────────────────────────────────────────────────

/** Every board object kind and every value of its fields: stickies, all shapes (FigJam's flowchart figures too), connectors (every
 *  magnet, ends anywhere on an object, free ends, every line, label places, waypoints), merged table cells, section flags,
 *  every stamp, stickers, a table, the three strokes and every part. */
export function boardEverything(newId: NewId): DesignDocument {
  installBoardSteps();
  const doc = createBoardDocument('board', 'Board');
  const tx = beginTransaction(doc);
  const put = (build: {id: NodeId; pieces: {node: SceneNode; parent: NodeId}[]} | null, parent = 'board') => {
    if (!build) throw Error('board: nothing built');
    insertPieces(tx, build, parent);
    return build.id;
  };
  const section = put(createBoardSection(newId, {x: -100, y: -100, width: 3000, height: 2000, name: 'Section', fill: '#FFF7E0'}));
  // A section's "hide contents" and "lock background only" (lane G step 3).
  tx.update(section, {board: {kind: 'section', hidden: false, backgroundLocked: true}});
  const hiddenSection = put(createBoardSection(newId, {x: 3200, y: -100, width: 400, height: 400, name: 'Hidden', fill: '#E8F3FF'}));
  tx.update(hiddenSection, {board: {kind: 'section', hidden: true}});
  const a = put(createSticky(newId, {x: 0, y: 0, text: 'Idea', author: 'Anna', showAuthor: true}), section);
  const b = put(createSticky(newId, {x: 400, y: 0, text: 'Wide', wide: true, color: 'blue'}));
  put(createSticky(newId, {x: 800, y: 0, text: '', showAuthor: false, family: 'Caveat'}));
  const shapes = [...BOARD_SHAPES, ...BOARD_FLOWCHART_SHAPES].map((shape, i) => put(createShape(newId, {x: (i % 10) * 200, y: 400 + Math.floor(i / 10) * 200, shape: shape.id, text: shape.label, ...(i % 3 ? {} : {stroke: null})})));
  const magnets = ['auto', 'top', 'right', 'bottom', 'left', 'center'] as const;
  const lines = ['straight', 'elbow', 'curved'] as const;
  magnets.forEach((magnet, i) =>
    put(createConnector(newId, {start: {node: shapes[i], magnet}, end: {node: shapes[i + 1], magnet: pick(magnets, i + 2)}, line: pick(lines, i), label: i % 2 ? 'Yes' : undefined, dashed: i === 3, startArrow: i === 4})));
  put(createConnector(newId, {start: {x: -50, y: -50}, end: {node: a, magnet: 'auto'}, line: 'curved'}));
  put(createConnector(newId, {start: {node: b, magnet: 'left'}, end: {x: 1200.5, y: -80}, line: 'straight', endArrow: false}));
  // Lane G step 3: ends anywhere on an object, the label's place along the line, waypoints (every line kind).
  lines.forEach((line, i) => {
    const id = put(createConnector(newId, {start: {node: shapes[10 + i], magnet: 'auto'}, end: {node: shapes[11 + i], magnet: 'auto'}, line, label: 'Label'}));
    const meta = tx.get(id)!.board!;
    if (meta.kind !== 'connector') throw Error('board: not a connector');
    tx.update(id, {board: {...meta, start: {node: shapes[10 + i], at: {x: 0.25, y: 1}}, end: {node: shapes[11 + i], at: {x: 0.5, y: 0.5}}, labelAt: [0, 0.3, 1][i], points: [{x: 2100 + i * 40, y: 900}, {x: 2100 + i * 40, y: 1200.5}]}});
  });
  STAMPS.forEach((stamp, i) => put(createStamp(newId, {x: i * 60, y: 1000, stamp: stamp.id, ...(i % 2 ? {by: 'Anna Smith'} : {})})));
  put(createSticker(newId, {x: 0, y: 1100, sticker: STICKERS[0].id}));
  put(createSticker(newId, {x: 200, y: 1100, sticker: STICKERS[STICKERS.length - 1].id, size: 96}));
  const table = put(createTable(newId, {x: 0, y: 1300, rows: 3, columns: 3, header: true, cells: [['Who', 'What', 'When'], ['Ann', 'Layout', 'Mon'], ['Bob', 'Code', 'Tue']]}));
  // Merged cells (lane G step 3): the header's first cell spans two columns, a body cell two rows.
  const rows = tx.get(table)!.children!;
  tx.update(tx.get(rows[0])!.children![0], {board: {kind: 'part', part: 'cell', colSpan: 2}});
  tx.update(tx.get(rows[1])!.children![2], {board: {kind: 'part', part: 'cell', rowSpan: 2, colSpan: 1}});
  put(createStroke(newId, {tool: 'marker', commands: CURVE, color: '#1E1E1E', weight: 4}));
  put(createStroke(newId, {tool: 'highlighter', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 300, y: 20}], color: '#FFE600', weight: 24}));
  put(createWashi(newId, {from: {x: 0, y: 1700}, to: {x: 400, y: 1750}, color: '#FFB0D0', width: 32}));
  put(createBoardText(newId, {x: 0, y: 1900, text: 'Handwritten', handwriting: true, size: 32}));
  return tx.commit({measurer}).doc;
}

// ── Imports ──────────────────────────────────────────────────────────────────────────────────────

type T = [[number, number, number], [number, number, number]];
const mul = (m: T, n: T): T => [
  [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
  [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]],
];
const at = (x: number, y: number, deg = 0): T => {
  const r = (deg * Math.PI) / 180;
  return [[Math.cos(r), Math.sin(r), x], [-Math.sin(r), Math.cos(r), y]];
};
const fsolid = (r: number, g: number, b: number, extra: object = {}) => ({blendMode: 'NORMAL', type: 'SOLID', color: {r, g, b, a: 1}, ...extra});
function F(type: string, id: string, name: string, transform: T, w: number, h: number, extra: Partial<FigmaNode> = {}): FigmaNode {
  return {
    id, name, type, scrollBehavior: 'SCROLLS', blendMode: 'PASS_THROUGH', relativeTransform: transform, size: {x: w, y: h}, constraints: {vertical: 'TOP', horizontal: 'LEFT'},
    fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', effects: [], ...extra,
  } as FigmaNode;
}
function finalize(file: FigmaFile): FigmaFile {
  const visit = (node: FigmaNode, containing: T, parentAbs: T, parentType: string) => {
    const base = parentType === 'GROUP' || parentType === 'BOOLEAN_OPERATION' ? containing : parentAbs;
    const abs = mul(base, node.relativeTransform as T);
    const w = node.size!.x, h = node.size!.y;
    const xs = [0, w, w, 0].map((x, i) => abs[0][0] * x + abs[0][1] * [0, 0, h, h][i] + abs[0][2]);
    const ys = [0, w, w, 0].map((x, i) => abs[1][0] * x + abs[1][1] * [0, 0, h, h][i] + abs[1][2]);
    node.absoluteBoundingBox = {x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys)};
    const nextContaining = node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION' ? containing : abs;
    for (const child of node.children ?? []) visit(child, nextContaining, abs, node.type);
  };
  const identity: T = [[1, 0, 0], [0, 1, 0]];
  for (const page of file.document!.children!) for (const child of page.children ?? []) visit(child, identity, identity, 'CANVAS');
  return file;
}
const IMAGE_HASH = 'a3f1c9e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a3';

/** tests/design-figma-import.test.ts `landingFile()` and tests/design-figma-import-components.test.ts `kitFile()` in one REST answer:
 *  a rotated group, styled text runs, image, gradient and effect paints, a line, vectors, a star, a polygon, a boolean, a mask, prototype
 *  interactions, a variant set with every property kind, instances with overrides, nested and library instances. */
export function figmaFile(): FigmaFile {
  const group = at(900, 200, 30);
  const desktop = F('FRAME', '1:2', 'Desktop', at(0, 0), 1440, 900, {
    clipsContent: true, fills: [fsolid(1, 1, 1)],
    layoutGrids: [{pattern: 'COLUMNS', sectionSize: 76, visible: true, color: {r: 1, g: 0, b: 0, a: 0.1}, alignment: 'STRETCH', gutterSize: 24, offset: 120, count: 12}],
    exportSettings: [{suffix: '@2x', format: 'PNG', constraint: {type: 'SCALE', value: 2}}],
    styles: {fill: '3:1'},
    children: [
      F('TEXT', '1:3', 'Title', at(120, 80), 420, 58, {
        fills: [fsolid(0.07, 0.07, 0.07)], characters: 'Привет, мир!',
        style: {fontFamily: 'Inter', fontPostScriptName: 'Inter-Regular', fontWeight: 400, fontSize: 48, textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', letterSpacing: -0.96, lineHeightPx: 58.09, lineHeightPercent: 100, lineHeightUnit: 'INTRINSIC_%', textAutoResize: 'WIDTH_AND_HEIGHT'},
        characterStyleOverrides: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2],
        styleOverrideTable: {1: {fontFamily: 'Inter', fontWeight: 700, fills: [fsolid(0.05, 0.6, 1)]}, 2: {fontFamily: 'Poppins', fontWeight: 600, fontSize: 24, lineHeightPx: 30, lineHeightUnit: 'PIXELS'}},
        lineTypes: ['NONE'], lineIndentations: [0], styles: {text: '3:2'},
      }),
      F('RECTANGLE', '1:4', 'Photo', at(120, 200), 480, 320, {
        fills: [{blendMode: 'NORMAL', type: 'IMAGE', scaleMode: 'STRETCH', imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.1]], imageRef: IMAGE_HASH, filters: {exposure: 0.2, contrast: -0.1}}],
        cornerRadius: 12, rectangleCornerRadii: [12, 12, 0, 0], cornerSmoothing: 0.6,
        effects: [
          {type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.25}, blendMode: 'NORMAL', offset: {x: 0, y: 4}, radius: 12, spread: 2, showShadowBehindNode: true},
          {type: 'INNER_SHADOW', visible: true, color: {r: 1, g: 1, b: 1, a: 0.5}, blendMode: 'NORMAL', offset: {x: 0, y: 1}, radius: 0, spread: 0},
          {type: 'LAYER_BLUR', visible: false, radius: 4},
        ],
        constraints: {vertical: 'TOP_BOTTOM', horizontal: 'LEFT_RIGHT'},
      }),
      F('GROUP', '1:5', 'Rotated group', group, 200, 100, {
        children: [
          F('RECTANGLE', '1:6', 'Square', mul(group, at(0, 0)), 100, 100, {fills: [fsolid(1, 0.3, 0.2)]}),
          F('ELLIPSE', '1:7', 'Dot', mul(group, at(120, 40)), 60, 60, {fills: [fsolid(0.1, 0.4, 1)], arcData: {startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.4}}),
        ],
      }),
      F('RECTANGLE', '1:16', 'Gradient', at(700, 600), 200, 120, {
        fills: [
          {blendMode: 'NORMAL', type: 'GRADIENT_LINEAR', gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}], gradientStops: [{color: {r: 1, g: 0, b: 0, a: 1}, position: 0}, {color: {r: 0, g: 0, b: 1, a: 0.5}, position: 1}]},
          {blendMode: 'MULTIPLY', type: 'GRADIENT_RADIAL', opacity: 0.5, gradientHandlePositions: [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}], gradientStops: [{color: {r: 0, g: 0, b: 0, a: 1}, position: 0}, {color: {r: 1, g: 1, b: 1, a: 0}, position: 1}]},
        ],
        strokes: [fsolid(0, 0, 0)], strokeWeight: 2, strokeAlign: 'OUTSIDE', strokeDashes: [4, 2], individualStrokeWeights: {top: 1, right: 0, bottom: 4, left: 0}, blendMode: 'LINEAR_BURN',
      }),
      F('LINE', '1:13', 'Arrow', at(100, 700, -45), 200, 0, {strokes: [fsolid(0, 0, 0)], strokeWeight: 2, strokeAlign: 'CENTER', strokeCap: 'TRIANGLE_ARROW'}),
      F('VECTOR', '1:14', 'Blob', at(400, 650), 100, 80, {
        fills: [fsolid(0.2, 0.8, 0.4)], strokes: [fsolid(0, 0, 0)], strokeAlign: 'CENTER', strokeJoin: 'ROUND',
        fillGeometry: [{path: 'M0 40C0 17.9 22.4 0 50 0C77.6 0 100 17.9 100 40C100 62.1 77.6 80 50 80C22.4 80 0 62.1 0 40Z', windingRule: 'NONZERO'}],
      }),
      F('STAR', '1:17', 'Star', at(1000, 600), 80, 80, {fills: [fsolid(1, 0.8, 0)], fillGeometry: [{path: 'M40 0L49 30L80 30L55 49L64 80L40 61L16 80L25 49L0 30L31 30Z', windingRule: 'NONZERO'}]}),
      F('REGULAR_POLYGON', '1:18', 'Triangle', at(1100, 600), 80, 70, {fills: [fsolid(0.5, 0.5, 0.5)], pointCount: 3, cornerRadius: 4}),
      F('BOOLEAN_OPERATION', '1:12', 'Ring', at(1200, 600), 100, 100, {
        booleanOperation: 'SUBTRACT', fills: [fsolid(0.3, 0.3, 0.9)],
        children: [F('ELLIPSE', '1:19', 'Outer', at(1200, 600), 100, 100, {fills: [fsolid(0, 0, 0)]}), F('ELLIPSE', '1:20', 'Inner', at(1225, 625), 50, 50, {fills: [fsolid(0, 0, 0)]})],
      }),
      F('FRAME', '1:21', 'Masked', at(120, 560), 160, 120, {
        clipsContent: false,
        children: [F('ELLIPSE', '1:22', 'Mask', at(0, 0), 120, 120, {isMask: true, maskType: 'VECTOR', fills: [fsolid(0, 0, 0)]}), F('RECTANGLE', '1:23', 'Masked fill', at(0, 0), 160, 120, {fills: [fsolid(0.9, 0.5, 0.1)]})],
      }),
      F('FRAME', '1:24', 'Button', at(1200, 80), 120, 40, {
        fills: [fsolid(0.05, 0.6, 1)], cornerRadius: 8,
        interactions: [
          {trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', destinationId: '1:30', navigation: 'NAVIGATE', transition: {type: 'SMART_ANIMATE', easing: {type: 'EASE_OUT'}, duration: 0.30000001192092896}, preserveScrollPosition: false}]},
          {trigger: {type: 'ON_KEY_DOWN', keyCodes: [16, 75], device: 'KEYBOARD'}, actions: [{type: 'URL', url: 'https://foo.test/'}]},
          {trigger: {type: 'AFTER_TIMEOUT', timeout: 800}, actions: [{type: 'BACK'}]},
        ],
      }),
    ],
  });
  const second = F('FRAME', '1:30', 'Second', at(1600, 0), 375, 812, {fills: [fsolid(1, 1, 1)], clipsContent: true, overflowDirection: 'VERTICAL_SCROLLING'});

  const STAR_PATH = 'M10 0L13 7L20 7L14 12L16 20L10 15L4 20L6 12L0 7L7 7Z';
  const vector = (id: string, fill = fsolid(0, 0, 0)) => F('VECTOR', id, 'Star shape', at(2, 2), 20, 20, {fills: [fill], fillGeometry: [{path: STAR_PATH, windingRule: 'NONZERO'}]});
  const label = (id: string, characters: string, width: number) =>
    F('TEXT', id, 'Label', at(48, 12), width, 20, {
      fills: [fsolid(1, 1, 1)], characters, componentPropertyReferences: {characters: 'Label#1:0'},
      style: {fontFamily: 'Inter', fontWeight: 600, fontSize: 16, textAutoResize: 'WIDTH_AND_HEIGHT', lineHeightUnit: 'INTRINSIC_%', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP'},
      layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
    });
  const icon = (id: string, children: FigmaNode[], extra: Partial<FigmaNode> = {}) =>
    F('INSTANCE', id, 'Icon/Star', at(16, 10), 24, 24, {componentId: '2:10', componentProperties: {}, componentPropertyReferences: {visible: 'Show icon#1:1', mainComponent: 'Icon#1:2'}, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', children, ...extra});
  const buttonFrame = {
    layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
    paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 10, itemSpacing: 8, counterAxisAlignItems: 'CENTER', cornerRadius: 8, clipsContent: false,
  } as Partial<FigmaNode>;
  const buttonProps = (state: string, text: string) => ({State: {type: 'VARIANT', value: state}, 'Label#1:0': {type: 'TEXT', value: text}, 'Show icon#1:1': {type: 'BOOLEAN', value: true}, 'Icon#1:2': {type: 'INSTANCE_SWAP', value: '2:10'}});
  const components = {
    id: '0:2', name: 'Components', type: 'CANVAS', children: [
      F('COMPONENT_SET', '2:1', 'Button', at(0, 0), 360, 84, {
        componentPropertyDefinitions: {
          State: {type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Hover']},
          'Label#1:0': {type: 'TEXT', defaultValue: 'Button'},
          'Show icon#1:1': {type: 'BOOLEAN', defaultValue: true},
          'Icon#1:2': {type: 'INSTANCE_SWAP', defaultValue: '2:10', preferredValues: [{type: 'COMPONENT', key: 'kHeart'}]},
        },
        children: [
          F('COMPONENT', '2:2', 'State=Default', at(20, 20), 140, 44, {...buttonFrame, fills: [fsolid(0.05, 0.6, 1)], children: [icon('2:4', [vector('I2:4;2:11')], {isExposedInstance: true}), label('2:3', 'Button', 76)]}),
          F('COMPONENT', '2:5', 'State=Hover', at(200, 20), 140, 44, {...buttonFrame, fills: [fsolid(0, 0.45, 0.8)], children: [icon('2:7', [vector('I2:7;2:11')]), label('2:6', 'Button', 76)]}),
        ],
      }),
      F('COMPONENT', '2:10', 'Icon/Star', at(0, 400), 24, 24, {children: [vector('2:11')]}),
      F('COMPONENT', '2:20', 'Icon/Heart', at(40, 400), 24, 24, {children: [F('VECTOR', '2:21', 'Heart', at(2, 3), 20, 18, {fills: [fsolid(1, 0, 0)], fillGeometry: [{path: 'M0 0L20 0L10 18Z', windingRule: 'NONZERO'}]})]}),
    ],
  } as FigmaNode;
  const screens = {
    id: '0:3', name: 'Screens', type: 'CANVAS', children: [
      F('INSTANCE', '5:1', 'Buy', at(100, 1000), 160, 44, {
        ...buttonFrame, fills: [fsolid(0.1, 0.7, 0.3)], componentId: '2:2', componentProperties: buttonProps('Default', 'Buy now'),
        children: [icon('I5:1;2:4', [vector('I5:1;2:4;2:11')]), label('I5:1;2:3', 'Buy now', 96)],
      }),
      F('INSTANCE', '5:20', 'Library button', at(100, 1200), 120, 40, {
        componentId: '9:100', fills: [fsolid(0.2, 0.2, 0.2)], componentProperties: {},
        children: [
          F('RECTANGLE', 'I5:20;9:101', 'Bg', at(0, 0), 120, 40, {fills: [fsolid(0.9, 0.9, 0.9)]}),
          F('INSTANCE', 'I5:20;9:103', 'Icon/Star', at(8, 8), 24, 24, {componentId: '2:10', componentProperties: {}, children: [vector('I5:20;9:103;2:11', fsolid(0.5, 0, 0.5))]}),
        ],
      }),
    ],
  } as FigmaNode;
  return finalize({
    name: 'Landing page',
    document: {
      id: '0:0',
      children: [{id: '0:1', name: 'Home', type: 'CANVAS', backgroundColor: {r: 0.96, g: 0.96, b: 0.96, a: 1}, flowStartingPoints: [{nodeId: '1:2', name: 'Main'}], children: [desktop, second]} as FigmaNode, screens, components],
    } as FigmaNode,
    components: {
      '2:2': {key: 'kDefault', name: 'State=Default', componentSetId: '2:1', description: ''},
      '2:5': {key: 'kHover', name: 'State=Hover', componentSetId: '2:1', description: ''},
      '2:10': {key: 'kStar', name: 'Icon/Star', description: 'Star'},
      '2:20': {key: 'kHeart', name: 'Icon/Heart', description: ''},
      '9:100': {key: 'libkey', name: 'Library button', remote: true, description: ''},
    },
    componentSets: {'2:1': {key: 'kButton', name: 'Button', description: 'Buttons'}},
    styles: {
      '3:1': {key: 'k1', name: 'Background/White', styleType: 'FILL', remote: false, description: ''},
      '3:2': {key: 'k2', name: 'Headings/H1', styleType: 'TEXT', remote: false, description: 'Main heading'},
    },
  } as FigmaFile);
}

/** The Figma import of `figmaFile()`, its picture "uploaded". */
export function figmaImport(figma: FigmaModule): DesignDocument {
  const {doc} = figma.importFigmaFile(figmaFile());
  const uploaded = new Map<string, UploadedImage>([[IMAGE_HASH, {ref: 'figma-photo', asset: {url: '/uploads/figma-photo.png', width: 960, height: 640, name: 'Photo'}}]]);
  return figma.withUploadedImages(doc, uploaded).doc;
}

const svg = (tag: string, attrs: Record<string, string> = {}, children: SvgNode[] = []): SvgNode => ({tag, attrs, children});
/** An SVG (shapes, paths with arcs, gradients, a group transform, a dashed stroke, text) imported into a page. */
export function svgImport(): DesignDocument {
  const tree = svg('svg', {xmlns: 'http://www.w3.org/2000/svg', width: '240', height: '160', viewBox: '0 0 240 160'}, [
    svg('title', {}, [{tag: '#text', attrs: {}, children: [], text: 'Иконки'}]),
    svg('defs', {}, [
      svg('linearGradient', {id: 'g1', x1: '0', y1: '0', x2: '1', y2: '1'}, [svg('stop', {offset: '0', 'stop-color': '#ff0000'}), svg('stop', {offset: '1', 'stop-color': '#0000ff', 'stop-opacity': '0.5'})]),
      svg('radialGradient', {id: 'g2', cx: '0.5', cy: '0.5', r: '0.5'}, [svg('stop', {offset: '0', 'stop-color': '#fff'}), svg('stop', {offset: '1', 'stop-color': '#000'})]),
    ]),
    svg('rect', {x: '10', y: '10', width: '60', height: '40', rx: '6', fill: 'url(#g1)', stroke: '#333', 'stroke-width': '2', 'stroke-dasharray': '4 2'}),
    svg('circle', {cx: '110', cy: '30', r: '20', fill: 'url(#g2)', opacity: '0.8'}),
    svg('ellipse', {cx: '170', cy: '30', rx: '25', ry: '15', fill: 'none', stroke: 'rgb(0, 128, 255)', 'stroke-linecap': 'round'}),
    svg('g', {transform: 'translate(20 80) rotate(15)', fill: '#0a0'}, [
      svg('path', {d: 'M0 0 L40 0 A20 20 0 0 1 40 40 Q20 60 0 40 Z', 'fill-rule': 'evenodd'}),
      svg('polygon', {points: '60,0 80,40 40,40'}),
      svg('polyline', {points: '90,0 110,20 130,0', fill: 'none', stroke: '#a00', 'stroke-linejoin': 'round'}),
      svg('line', {x1: '140', y1: '0', x2: '180', y2: '40', stroke: 'black'}),
    ]),
    svg('text', {x: '10', y: '150', 'font-family': 'Inter', 'font-size': '14', fill: '#111'}, [{tag: '#text', attrs: {}, children: [], text: 'Привет, SVG'}]),
  ]);
  const result = importSvg(tree, {measurer, parentId: 'page', x: 40, y: 40});
  const doc = createDocument('page', 'SVG');
  for (const node of result.nodes) doc.nodes[node.id] = node;
  doc.nodes.page.children!.push(result.rootId);
  return normalized(doc);
}

/** For the coverage report: the document schema itself. */
export const DOCUMENT_SCHEMA = designDocumentSchema;
