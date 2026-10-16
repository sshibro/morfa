import assert from 'node:assert/strict';
import test from 'node:test';
import {iconTextsOf, replaceIconTexts} from '../src/design/import/figma/icon-texts';
import {importFigmaFile, withUploadedImages, figmaPages, matchFigmaFont, pageOfNode, utf8Length, COMPONENTS_PAGE_ID, type FigmaFile, type FigmaNode} from '../shared/design/figma-import';
import {validateDocument} from '../shared/design/schema';
import {worldBox, worldMatrix, apply} from '../shared/design/geometry';
import {groupFitUpdates} from '../shared/design/group-fit';
import type {DesignDocument, GradientPaint, ImagePaint, SceneNode} from '../shared/design/types';

// Hand-written answers of GET /v1/files/:key?geometry=paths, shaped as Figma's REST reference
// documents them: relativeTransform + size per node (children of groups in the containing frame's
// space), absoluteBoundingBox in page space, defaults omitted the way Figma omits them.

type T = [[number, number, number], [number, number, number]];
const mul = (m: T, n: T): T => [
  [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
  [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]],
];
/** Figma's matrix for a node at (x, y) turned `deg` counter-clockwise (the panel's rotation). */
const at = (x: number, y: number, deg = 0): T => {
  const r = (deg * Math.PI) / 180;
  return [[Math.cos(r), Math.sin(r), x], [-Math.sin(r), Math.cos(r), y]];
};
const black = {r: 0, g: 0, b: 0, a: 1};
const solid = (r: number, g: number, b: number, extra: object = {}) => ({blendMode: 'NORMAL', type: 'SOLID', color: {r, g, b, a: 1}, ...extra});

function N(type: string, id: string, name: string, transform: T, w: number, h: number, extra: Partial<FigmaNode> = {}): FigmaNode {
  return {
    id, name, type, scrollBehavior: 'SCROLLS', blendMode: type === 'FRAME' || type === 'GROUP' || type === 'INSTANCE' || type === 'COMPONENT' ? 'PASS_THROUGH' : 'PASS_THROUGH',
    relativeTransform: transform, size: {x: w, y: h}, constraints: {vertical: 'TOP', horizontal: 'LEFT'},
    fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', effects: [], ...extra,
  } as FigmaNode;
}

/** Fills absoluteBoundingBox the way Figma reports it (groups are not containing parents). */
function finalize(file: FigmaFile): FigmaFile {
  const visit = (node: FigmaNode, containing: T, parentAbs: T, parentType: string) => {
    const own = node.relativeTransform as T;
    const base = parentType === 'GROUP' || parentType === 'BOOLEAN_OPERATION' ? containing : parentAbs;
    const abs = mul(base, own);
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

function landingFile(): FigmaFile {
  // A rotated group: the group turns 30°, its children are written in the frame's space.
  const group = at(900, 200, 30);
  const rectInGroup = mul(group, at(0, 0));
  const ellipseInGroup = mul(group, at(120, 40));
  const desktop: FigmaNode = N('FRAME', '1:2', 'Desktop', at(0, 0), 1440, 900, {
    clipsContent: true,
    fills: [solid(1, 1, 1)],
    layoutGrids: [{pattern: 'COLUMNS', sectionSize: 76, visible: true, color: {r: 1, g: 0, b: 0, a: 0.1}, alignment: 'STRETCH', gutterSize: 24, offset: 120, count: 12}],
    exportSettings: [{suffix: '@2x', format: 'PNG', constraint: {type: 'SCALE', value: 2}}],
    styles: {fill: '3:1'},
    children: [
      N('TEXT', '1:3', 'Title', at(120, 80), 420, 58, {
        fills: [solid(0.07, 0.07, 0.07)],
        characters: 'Hello, world!',
        style: {fontFamily: 'Inter', fontPostScriptName: 'Inter-Regular', fontWeight: 400, fontSize: 48, textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', letterSpacing: -0.96, lineHeightPx: 58.09, lineHeightPercent: 100, lineHeightUnit: 'INTRINSIC_%', textAutoResize: 'WIDTH_AND_HEIGHT'},
        characterStyleOverrides: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2],
        styleOverrideTable: {
          1: {fontFamily: 'Inter', fontWeight: 700, fills: [solid(0.05, 0.6, 1)]},
          2: {fontFamily: 'Poppins', fontWeight: 600, fontSize: 24, lineHeightPx: 30, lineHeightUnit: 'PIXELS'},
        },
        lineTypes: ['NONE'],
        lineIndentations: [0],
        styles: {text: '3:2'},
      }),
      N('RECTANGLE', '1:4', 'Photo', at(120, 200), 480, 320, {
        fills: [{blendMode: 'NORMAL', type: 'IMAGE', scaleMode: 'STRETCH', imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.1]], imageRef: IMAGE_HASH, filters: {exposure: 0.2, contrast: -0.1}}],
        cornerRadius: 12, rectangleCornerRadii: [12, 12, 0, 0], cornerSmoothing: 0.6,
        effects: [
          {type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.25}, blendMode: 'NORMAL', offset: {x: 0, y: 4}, radius: 12, spread: 2, showShadowBehindNode: true},
          {type: 'INNER_SHADOW', visible: true, color: {r: 1, g: 1, b: 1, a: 0.5}, blendMode: 'NORMAL', offset: {x: 0, y: 1}, radius: 0, spread: 0},
          {type: 'LAYER_BLUR', visible: false, radius: 4},
          {type: 'NOISE', visible: true, radius: 1},
        ],
        constraints: {vertical: 'TOP_BOTTOM', horizontal: 'LEFT_RIGHT'},
      }),
      N('GROUP', '1:5', 'Rotated group', group, 200, 100, {
        children: [
          N('RECTANGLE', '1:6', 'Square', rectInGroup, 100, 100, {fills: [solid(1, 0.3, 0.2)]}),
          N('ELLIPSE', '1:7', 'Dot', ellipseInGroup, 60, 60, {fills: [solid(0.1, 0.4, 1)], arcData: {startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.4}}),
        ],
      }),
      N('RECTANGLE', '1:16', 'Gradient', at(700, 600), 200, 120, {
        fills: [
          {blendMode: 'NORMAL', type: 'GRADIENT_LINEAR', gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}], gradientStops: [{color: {r: 1, g: 0, b: 0, a: 1}, position: 0}, {color: {r: 0, g: 0, b: 1, a: 0.5}, position: 1}]},
          {blendMode: 'MULTIPLY', type: 'GRADIENT_RADIAL', opacity: 0.5, gradientHandlePositions: [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}], gradientStops: [{color: black, position: 0}, {color: {r: 1, g: 1, b: 1, a: 0}, position: 1}]},
          {blendMode: 'NORMAL', type: 'VIDEO', videoRef: 'x'} as never,
        ],
        strokes: [solid(0, 0, 0)], strokeWeight: 2, strokeAlign: 'OUTSIDE', strokeDashes: [4, 2], individualStrokeWeights: {top: 1, right: 0, bottom: 4, left: 0},
        blendMode: 'LINEAR_BURN',
      }),
      N('LINE', '1:13', 'Arrow', at(100, 700, -45), 200, 0, {strokes: [solid(0, 0, 0)], strokeWeight: 2, strokeAlign: 'CENTER', strokeCap: 'TRIANGLE_ARROW'}),
      N('VECTOR', '1:14', 'Blob', at(400, 650), 100, 80, {
        fills: [solid(0.2, 0.8, 0.4)], strokes: [solid(0, 0, 0)], strokeAlign: 'CENTER', strokeJoin: 'ROUND',
        fillGeometry: [{path: 'M0 40C0 17.9 22.4 0 50 0C77.6 0 100 17.9 100 40C100 62.1 77.6 80 50 80C22.4 80 0 62.1 0 40Z', windingRule: 'NONZERO'}],
        strokeGeometry: [{path: 'M0 0L1 1Z', windingRule: 'NONZERO'}],
      }),
      N('VECTOR', '1:15', 'Squiggle', at(520, 650), 100, 40, {
        strokes: [solid(0.9, 0.1, 0.4)], strokeWeight: 3, strokeAlign: 'CENTER', strokeCap: 'ROUND',
        fillGeometry: [],
        strokeGeometry: [{path: 'M0 18.5L100 18.5L100 21.5L0 21.5Z', windingRule: 'NONZERO'}],
      }),
      N('STAR', '1:17', 'Star', at(1000, 600), 80, 80, {fills: [solid(1, 0.8, 0)], fillGeometry: [{path: 'M40 0L49 30L80 30L55 49L64 80L40 61L16 80L25 49L0 30L31 30Z', windingRule: 'NONZERO'}]}),
      N('REGULAR_POLYGON', '1:18', 'Triangle', at(1100, 600), 80, 70, {fills: [solid(0.5, 0.5, 0.5)], pointCount: 3, cornerRadius: 4}),
      N('BOOLEAN_OPERATION', '1:12', 'Ring', at(1200, 600), 100, 100, {
        booleanOperation: 'SUBTRACT', fills: [solid(0.3, 0.3, 0.9)],
        children: [
          N('ELLIPSE', '1:19', 'Outer', at(1200, 600), 100, 100, {fills: [solid(0, 0, 0)]}),
          N('ELLIPSE', '1:20', 'Inner', at(1225, 625), 50, 50, {fills: [solid(0, 0, 0)]}),
        ],
      }),
      N('FRAME', '1:21', 'Masked', at(120, 560), 160, 120, {
        clipsContent: false,
        children: [
          N('ELLIPSE', '1:22', 'Mask', at(0, 0), 120, 120, {isMask: true, maskType: 'VECTOR', fills: [solid(0, 0, 0)]}),
          N('RECTANGLE', '1:23', 'Masked fill', at(0, 0), 160, 120, {fills: [solid(0.9, 0.5, 0.1)]}),
        ],
      }),
      N('FRAME', '1:24', 'Button', at(1200, 80), 120, 40, {
        fills: [solid(0.05, 0.6, 1)], cornerRadius: 8,
        interactions: [
          {trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', destinationId: '1:30', navigation: 'NAVIGATE', transition: {type: 'SMART_ANIMATE', easing: {type: 'EASE_OUT'}, duration: 0.30000001192092896}, preserveScrollPosition: false}]},
          {trigger: {type: 'ON_HOVER'}, actions: [{type: 'NODE', destinationId: '9:99', navigation: 'OVERLAY', transition: null}]},
          {trigger: {type: 'ON_KEY_DOWN', keyCodes: [16, 75], device: 'KEYBOARD'}, actions: [{type: 'URL', url: 'https://foo.test/'}]},
          {trigger: {type: 'ON_CLICK'}, actions: [{type: 'SET_VARIABLE'} as never, {type: 'URL', url: 'javascript:alert(1)'}]},
          {trigger: {type: 'AFTER_TIMEOUT', timeout: 800}, actions: [{type: 'BACK'}]},
          {trigger: {type: 'MOUSE_UP'}, actions: [{type: 'BACK'}]},
        ],
      }),
    ],
  });
  const second = N('FRAME', '1:30', 'Second', at(1600, 0), 375, 812, {fills: [solid(1, 1, 1)], clipsContent: true, overflowDirection: 'VERTICAL_SCROLLING'});
  const unsupported = N('WIDGET', '1:40', 'Widget', at(2100, 0), 100, 100);
  return finalize({
    name: 'Landing',
    document: {id: '0:0', children: [{id: '0:1', name: 'Home', type: 'CANVAS', backgroundColor: {r: 0.96, g: 0.96, b: 0.96, a: 1}, flowStartingPoints: [{nodeId: '1:2', name: 'Main'}, {nodeId: '7:7', name: 'Missing'}], children: [desktop, second, unsupported]} as FigmaNode]},
    components: {},
    componentSets: {},
    styles: {
      '3:1': {key: 'k1', name: 'Background/White', styleType: 'FILL', remote: false, description: ''},
      '3:2': {key: 'k2', name: 'Headings/H1', styleType: 'TEXT', remote: false, description: 'Main heading'},
      '3:3': {key: 'k3', name: 'Unused', styleType: 'EFFECT', remote: false, description: ''},
    },
  });
}

const byName = (doc: DesignDocument, name: string): SceneNode => {
  const found = Object.values(doc.nodes).find(node => node.name === name);
  assert.ok(found, `no layer «${name}»`);
  return found;
};
const close = (actual: number, expected: number, epsilon = 0.01, label = '') => assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} ≠ ${expected}`);
const figmaById = (file: FigmaFile, id: string): FigmaNode => {
  const stack = [...file.document!.children!];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    stack.push(...(node.children ?? []));
  }
  throw new Error('no ' + id);
};

test('a link to a frame finds the page the frame is on', () => {
  const file: FigmaFile = {document: {id: '0:0', children: [
    {id: '0:1', name: 'Cover', type: 'CANVAS', children: [{id: '1:2', name: 'Cover', type: 'FRAME'}]},
    {id: '0:2', name: 'Icons', type: 'CANVAS', children: [{id: '12:34', name: 'Set', type: 'FRAME', children: [{id: '12:35', name: 'Arrow', type: 'VECTOR'}]}]},
    {id: '0:3', name: 'Large', type: 'CANVAS'},
  ]}};
  assert.equal(pageOfNode(file, '12:34'), '0:2', 'a frame on "Icons"');
  assert.equal(pageOfNode(file, '12:35'), '0:2', 'a layer inside it');
  assert.equal(pageOfNode(file, '0:3'), '0:3', 'a page itself, listed without its content');
  assert.equal(pageOfNode(file, '99:1'), null, 'a layer the read does not show');
});

test('a whole file maps into a valid document with pages, ids and every node family', () => {
  const file = landingFile();
  const {doc, report, imageRefs} = importFigmaFile(file);
  const valid = validateDocument(structuredClone(doc));
  assert.ok(valid.ok, valid.ok ? '' : `${valid.error} at ${valid.path}`);
  assert.deepEqual(doc.pages, ['0:1']);
  const page = doc.nodes['0:1'];
  assert.equal(page.type, 'PAGE');
  assert.equal(page.name, 'Home');
  close(page.backgroundColor!.r, 0.96);
  assert.deepEqual(page.flowStartingPoints, [{nodeId: '1:2', name: 'Main'}]);
  assert.deepEqual(page.children, ['1:2', '1:30']);
  assert.equal(doc.nodes['1:2'].type, 'FRAME');
  assert.equal(doc.nodes['1:17'].type, 'VECTOR', 'a star without its point count keeps its exact outline');
  assert.equal(doc.nodes['1:18'].type, 'POLYGON');
  assert.equal(doc.nodes['1:18'].pointCount, 3);
  assert.equal(doc.nodes['1:12'].type, 'BOOLEAN_OPERATION');
  assert.equal(doc.nodes['1:12'].booleanOperation, 'SUBTRACT');
  assert.equal(doc.nodes['1:13'].type, 'LINE');
  assert.equal(doc.nodes['1:40'], undefined);
  assert.ok(report.items.some(item => item.key === 'unsupported-WIDGET'));
  assert.deepEqual(imageRefs, [IMAGE_HASH]);
  assert.equal(report.pages, 1);
  assert.equal(report.nodes, Object.keys(doc.nodes).length - 1);
});

test('every node lands where Figma drew it: rotated groups, booleans, lines', () => {
  const file = landingFile();
  const {doc} = importFigmaFile(file);
  for (const id of ['1:4', '1:6', '1:7', '1:13', '1:14', '1:19', '1:20', '1:22', '1:3']) {
    const box = worldBox(doc, id);
    const figma = figmaById(file, id).absoluteBoundingBox!;
    close(box.x, figma.x, 0.02, id + ' x');
    close(box.y, figma.y, 0.02, id + ' y');
    close(box.width, figma.width, 0.02, id + ' w');
    close(box.height, figma.height, 0.02, id + ' h');
  }
  const group = doc.nodes['1:5'];
  close(group.rotation, 30, 0.01, 'group rotation');
  // The group's box is the union of its children in its own space, as our groups keep it.
  assert.equal(groupFitUpdates(doc, ['1:5', '1:12']).updates.size, 0);
  const square = doc.nodes['1:6'];
  close(square.rotation, 0, 0.01, 'child rotation is relative to the group');
  close(square.x, 0, 0.01);
  close(doc.nodes['1:7'].x, 120, 0.01);
  close(doc.nodes['1:13'].rotation, -45, 0.01);
  assert.equal(doc.nodes['1:13'].height, 0);
  // A world point of the ellipse matches Figma's matrix.
  const m = worldMatrix(doc, '1:7');
  const corner = apply(m, {x: 60, y: 60});
  const figma = mul(at(900, 200, 30), at(120, 40));
  close(corner.x, figma[0][0] * 60 + figma[0][1] * 60 + figma[0][2]);
  close(corner.y, figma[1][0] * 60 + figma[1][1] * 60 + figma[1][2]);
});

test('a child placed in its group\'s own space (older answers) is recognised by its bounding box', () => {
  const file = landingFile();
  const group = figmaById(file, '1:5');
  // Rewrite the children as if Figma had given them relative to the group, keeping the bounds.
  group.children![0].relativeTransform = at(0, 0);
  group.children![1].relativeTransform = at(120, 40);
  const {doc} = importFigmaFile(file);
  for (const id of ['1:6', '1:7']) {
    const box = worldBox(doc, id);
    const figma = figmaById(file, id).absoluteBoundingBox!;
    close(box.x, figma.x, 0.02, id);
    close(box.y, figma.y, 0.02, id);
  }
});

test('nested turned groups and a turned, mirrored layer inside them land on Figma\'s bounds', () => {
  const outer = at(300, 120, 20);
  const inner = mul(outer, at(40, 30, -35));
  const mirrored: T = mul(inner, [[-Math.cos(0.3), Math.sin(0.3), 90], [Math.sin(0.3), Math.cos(0.3), 10]]);
  const file = finalize({
    name: 'Groups', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [
      N('FRAME', '1:1', 'Frame', at(50, 50), 800, 600, {children: [
        N('GROUP', '1:2', 'Outer', outer, 260, 200, {children: [
          N('RECTANGLE', '1:3', 'A', mul(outer, at(0, 0)), 80, 40),
          N('GROUP', '1:4', 'Inner', inner, 150, 120, {children: [
            N('ELLIPSE', '1:5', 'B', mul(inner, at(0, 0)), 50, 50),
            N('RECTANGLE', '1:6', 'C', mirrored, 60, 30),
          ]}),
        ]}),
      ]}),
    ]} as FigmaNode]},
  });
  const {doc} = importFigmaFile(file);
  for (const id of ['1:3', '1:5', '1:6']) {
    const box = worldBox(doc, id);
    const figma = figmaById(file, id).absoluteBoundingBox!;
    close(box.x, figma.x, 0.02, id + ' x');
    close(box.y, figma.y, 0.02, id + ' y');
    close(box.width, figma.width, 0.02, id + ' w');
    close(box.height, figma.height, 0.02, id + ' h');
  }
  assert.equal(doc.nodes['1:6'].flipX, true);
  // The whole matrix matches, not only the bounds: a point of the mirrored layer lands where Figma puts it.
  const figma = mul(at(50, 50), mirrored);
  const point = apply(worldMatrix(doc, '1:6'), {x: 10, y: 5});
  close(point.x, figma[0][0] * 10 + figma[0][1] * 5 + figma[0][2], 0.02, 'point x');
  close(point.y, figma[1][0] * 10 + figma[1][1] * 5 + figma[1][2], 0.02, 'point y');
  assert.equal(groupFitUpdates(doc, ['1:2', '1:4']).updates.size, 0);
  assert.ok(validateDocument(structuredClone(doc)).ok);
});

test('a layer with «Constrain proportions» in Figma keeps its ratio lock', () => {
  const file = finalize({
    name: 'Ratio', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [N('RECTANGLE', '1:1', 'R', [[1, 0, 0], [0, 1, 0]], 120, 80, {fills: [solid(0, 0, 0)], preserveRatio: true})]} as FigmaNode]},
  });
  const {doc} = importFigmaFile(file);
  assert.equal(doc.nodes['1:1'].constrainProportions, true);
  assert.ok(validateDocument(structuredClone(doc)).ok);
});

test('flips: a mirrored layer keeps its place and reads as flipX', () => {
  const flipped: T = [[-1, 0, 300], [0, 1, 50]];
  const file = finalize({
    name: 'Flip', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [N('RECTANGLE', '1:1', 'R', flipped, 100, 40, {fills: [solid(0, 0, 0)]})]} as FigmaNode]},
  });
  const {doc} = importFigmaFile(file);
  const node = doc.nodes['1:1'];
  assert.equal(node.flipX, true);
  assert.equal(node.constrainProportions, undefined, 'no ratio lock unless Figma had one');
  close(node.rotation, 0, 0.01);
  close(node.x, 200);
  const box = worldBox(doc, '1:1');
  close(box.x, 200);
  close(box.width, 100);
});

test('paints, strokes, effects, blend modes, corners, masks and grids', () => {
  const {doc, report} = importFigmaFile(landingFile());
  const photo = doc.nodes['1:4'];
  const image = photo.fills[0] as ImagePaint;
  assert.equal(image.type, 'IMAGE');
  assert.equal(image.scaleMode, 'CROP');
  assert.deepEqual(image.imageTransform, [[0.5, 0, 0.25], [0, 0.5, 0.1]]);
  assert.deepEqual(image.filters, {exposure: 0.2, contrast: -0.1});
  assert.deepEqual(photo.rectangleCornerRadii, [12, 12, 0, 0]);
  assert.equal(photo.cornerSmoothing, 0.6);
  assert.deepEqual(photo.constraints, {horizontal: 'STRETCH', vertical: 'STRETCH'});
  assert.equal(photo.effects.length, 3);
  assert.deepEqual(photo.effects[0], {type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 4}, radius: 12, spread: 2, visible: true, blendMode: 'NORMAL', showShadowBehindNode: true});
  assert.equal(photo.effects[2].visible, false);
  assert.ok(report.items.some(item => item.key === 'effect-NOISE' && item.examples.includes('Photo')));

  const gradient = doc.nodes['1:16'];
  assert.equal(gradient.fills.length, 2, 'the video paint is left out');
  const linear = gradient.fills[0] as GradientPaint;
  assert.equal(linear.type, 'GRADIENT_LINEAR');
  assert.deepEqual(linear.gradientHandlePositions, [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}]);
  assert.deepEqual(linear.gradientStops[1], {position: 1, color: {r: 0, g: 0, b: 1, a: 0.5}});
  assert.equal(gradient.fills[1].blendMode, 'MULTIPLY');
  assert.equal(gradient.fills[1].opacity, 0.5);
  assert.equal(gradient.blendMode, 'COLOR_BURN', 'linear burn is approximated');
  assert.deepEqual(gradient.dashPattern, [4, 2]);
  assert.equal(gradient.strokeAlign, 'OUTSIDE');
  assert.deepEqual(gradient.individualStrokeWeights, {top: 1, right: 0, bottom: 4, left: 0});
  assert.ok(report.items.some(item => item.key === 'paint-video'));
  assert.ok(report.items.some(item => item.key === 'blend-LINEAR_BURN'));

  assert.equal(doc.nodes['1:2'].blendMode, 'PASS_THROUGH');
  assert.equal(doc.nodes['1:4'].blendMode, 'NORMAL', 'a leaf never passes through');
  assert.equal(doc.nodes['1:22'].isMask, true);
  assert.equal(doc.nodes['1:22'].maskType, 'VECTOR');
  assert.equal(doc.nodes['1:21'].clipsContent, false);
  assert.equal(doc.nodes['1:2'].clipsContent, true);
  assert.deepEqual(doc.nodes['1:2'].layoutGrids, [{pattern: 'COLUMNS', alignment: 'STRETCH', count: 12, gutterSize: 24, offset: 120, sectionSize: 76, visible: true, color: {r: 1, g: 0, b: 0, a: 0.1}}]);
  assert.deepEqual(doc.nodes['1:2'].exportSettings, [{format: 'PNG', suffix: '@2x', constraint: {type: 'SCALE', value: 2}}]);
  assert.deepEqual(doc.nodes['1:7'].arcData, {startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.4});
  assert.equal(doc.nodes['1:30'].overflowDirection, 'VERTICAL');
});

test('vectors: fill geometry becomes paths, open stroked paths their outline, arrows markers', () => {
  const {doc, report} = importFigmaFile(landingFile());
  const blob = doc.nodes['1:14'];
  assert.equal(blob.vectorPaths!.length, 1);
  assert.equal(blob.vectorPaths![0].windingRule, 'NONZERO');
  assert.equal(blob.vectorPaths![0].commands[0].type, 'M');
  assert.equal(blob.strokes.length, 1, 'a closed path keeps its live stroke');
  assert.equal(blob.strokeJoin, 'ROUND');
  const squiggle = doc.nodes['1:15'];
  assert.equal(squiggle.strokes.length, 0);
  assert.equal(squiggle.fills.length, 1);
  assert.equal(squiggle.vectorPaths!.length, 1);
  assert.ok(report.items.some(item => item.key === 'vector-outline' && item.examples.includes('Squiggle')));
  const arrow = doc.nodes['1:13'];
  assert.equal(arrow.strokeEndMarker, 'TRIANGLE_ARROW');
  assert.equal(arrow.strokeStartMarker, 'NONE');
  assert.equal(arrow.strokeCap, 'NONE');
  assert.equal(doc.nodes['1:17'].vectorPaths![0].commands.length, 11);
});

test('text: base style, mixed runs, line height units, fonts substituted and kept by name', () => {
  const {doc, report} = importFigmaFile(landingFile());
  const title = doc.nodes['1:3'];
  const text = title.text!;
  assert.equal(text.characters, 'Hello, world!');
  assert.equal(text.style.fontFamily, 'Inter');
  assert.equal(text.style.fontSize, 48);
  assert.deepEqual(text.style.lineHeight, {unit: 'AUTO'});
  assert.deepEqual(text.style.letterSpacing, {unit: 'PIXELS', value: -0.96});
  assert.equal(text.textAutoResize, 'WIDTH_AND_HEIGHT');
  assert.equal(title.layoutSizingHorizontal, 'HUG');
  assert.equal(text.runs.length, 2);
  assert.deepEqual(text.runs[0].start, 8);
  assert.deepEqual(text.runs[0].end, 11);
  assert.equal(text.runs[0].style.fontWeight, 700);
  assert.equal(text.runs[0].fills?.[0].type, 'SOLID');
  assert.deepEqual(text.runs[1], {start: 11, end: 12, style: {fontFamily: 'Montserrat', fontWeight: 600, fontSize: 24, lineHeight: {unit: 'PIXELS', value: 30}}});
  assert.equal(title.pluginData?.figmaFont, 'Poppins');
  assert.deepEqual(report.fonts, [{from: 'Poppins', to: 'Montserrat', layers: 1}]);
  assert.equal(title.fills.length, 1);
});

test('text: truncation, lists, paragraph spacing, hyperlinks and text cases', () => {
  const file = finalize({
    name: 'Text', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [
      N('TEXT', '1:1', 'List', at(0, 0), 300, 100, {
        fills: [solid(0, 0, 0)],
        characters: 'First\nSecond\nThird',
        style: {fontFamily: 'Roboto', fontWeight: 500, fontSize: 14, textCase: 'SMALL_CAPS_FORCED', textDecoration: 'UNDERLINE', paragraphSpacing: 8, paragraphIndent: 12, lineHeightUnit: 'FONT_SIZE_%', lineHeightPercentFontSize: 150, lineHeightPx: 21, textAutoResize: 'HEIGHT', textTruncation: 'ENDING', maxLines: 2, hyperlink: {type: 'URL', url: 'https://example.com'}},
        lineTypes: ['UNORDERED', 'UNORDERED', 'NONE'],
        lineIndentations: [1, 2, 0],
      }),
      N('TEXT', '1:2', 'Bad link', at(0, 200), 300, 20, {characters: 'x', style: {fontFamily: 'SF Pro Display', fontSize: 14, hyperlink: {type: 'URL', url: 'javascript:alert(1)'}, textAutoResize: 'NONE'}}),
    ]} as FigmaNode]},
  });
  const {doc, report} = importFigmaFile(file);
  const list = doc.nodes['1:1'].text!;
  assert.equal(list.style.fontFamily, 'Roboto');
  assert.equal(list.style.fontWeight, 500);
  assert.equal(list.style.textCase, 'SMALL_CAPS');
  assert.equal(list.style.textDecoration, 'UNDERLINE');
  assert.deepEqual(list.style.lineHeight, {unit: 'PERCENT', value: 150});
  assert.deepEqual(list.style.hyperlink, {type: 'URL', url: 'https://example.com'});
  assert.equal(list.paragraphSpacing, 8);
  assert.equal(list.paragraphIndent, 12);
  assert.equal(list.textAutoResize, 'TRUNCATE');
  assert.equal(list.maxLines, 2);
  assert.deepEqual(list.listTypes, ['UNORDERED', 'UNORDERED', 'NONE']);
  assert.ok(report.items.some(item => item.key === 'list-nesting'));
  const bad = doc.nodes['1:2'].text!;
  assert.equal(bad.style.hyperlink, undefined);
  assert.equal(bad.style.fontFamily, 'Inter');
  assert.ok(report.items.some(item => item.key === 'link-unsafe'));
  assert.deepEqual(report.fonts, [{from: 'SF Pro Display', to: 'Inter', layers: 1}]);
  assert.ok(validateDocument(structuredClone(doc)).ok);
});

test('font matching: exact names, weights in names, lookalikes and classes', () => {
  assert.deepEqual(matchFigmaFont('Inter'), {family: 'Inter', substituted: false});
  assert.deepEqual(matchFigmaFont('roboto'), {family: 'Roboto', substituted: false});
  assert.deepEqual(matchFigmaFont('Montserrat SemiBold'), {family: 'Montserrat', substituted: false});
  assert.deepEqual(matchFigmaFont('Poppins'), {family: 'Montserrat', substituted: true});
  assert.deepEqual(matchFigmaFont('Lato'), {family: 'Open Sans', substituted: true});
  assert.deepEqual(matchFigmaFont('Source Sans Pro'), {family: 'Source Sans 3', substituted: true});
  assert.deepEqual(matchFigmaFont('Helvetica Neue'), {family: 'Inter', substituted: true});
  assert.deepEqual(matchFigmaFont('Some Fancy Serif'), {family: 'PT Serif', substituted: true});
  assert.deepEqual(matchFigmaFont('Operator Mono'), {family: 'JetBrains Mono', substituted: true});
  assert.deepEqual(matchFigmaFont('Totally Unknown'), {family: 'Inter', substituted: true});
});

test('auto layout: direction, padding, spacing, wrap, alignment and fill/hug children', () => {
  const card = N('FRAME', '1:8', 'Card', at(0, 0), 320, 236, {
    layoutMode: 'VERTICAL', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED',
    paddingLeft: 16, paddingRight: 16, paddingTop: 24, paddingBottom: 24, itemSpacing: 12, counterAxisAlignItems: 'CENTER', itemReverseZIndex: true, strokesIncludedInLayout: true,
    fills: [solid(1, 1, 1)], clipsContent: false,
    children: [
      N('TEXT', '1:9', 'Heading', at(16, 24), 288, 24, {characters: 'Title', style: {fontFamily: 'Inter', fontSize: 20, fontWeight: 600, textAutoResize: 'HEIGHT', lineHeightUnit: 'INTRINSIC_%'}, layoutAlign: 'STRETCH', layoutGrow: 0, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'}),
      N('RECTANGLE', '1:10', 'Image', at(60, 60), 200, 100, {layoutAlign: 'INHERIT', layoutGrow: 0, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', fills: [solid(0.8, 0.8, 0.8)]}),
      N('FRAME', '1:11', 'Row', at(16, 172), 288, 40, {
        layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'SPACE_BETWEEN', counterAxisAlignItems: 'CENTER', layoutWrap: 'WRAP', counterAxisSpacing: null, itemSpacing: 8,
        // An older answer: sizing comes from layoutAlign/layoutGrow and the sizing modes.
        layoutAlign: 'STRETCH', layoutGrow: 0, primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'AUTO',
        children: [
          N('RECTANGLE', '1:25', 'A', at(0, 0), 40, 40, {layoutGrow: 1}),
          N('RECTANGLE', '1:26', 'B', at(248, 0), 40, 40, {layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'RIGHT', vertical: 'BOTTOM'}}),
        ],
      }),
    ],
  });
  const file = finalize({name: 'AL', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [card]} as FigmaNode]}});
  const {doc, report} = importFigmaFile(file);
  const frame = doc.nodes['1:8'];
  assert.deepEqual(frame.autoLayout, {
    layoutMode: 'VERTICAL', layoutWrap: 'NO_WRAP', primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'CENTER', counterAxisAlignContent: 'AUTO',
    paddingLeft: 16, paddingRight: 16, paddingTop: 24, paddingBottom: 24, itemSpacing: 12, counterAxisSpacing: 12, itemReverseZIndex: true, strokesIncludedInLayout: true,
  });
  assert.equal(frame.layoutSizingHorizontal, 'FIXED');
  assert.equal(frame.layoutSizingVertical, 'HUG');
  assert.equal(doc.nodes['1:9'].layoutSizingHorizontal, 'FILL');
  assert.equal(doc.nodes['1:9'].layoutSizingVertical, 'HUG');
  assert.equal(doc.nodes['1:9'].text!.textAutoResize, 'HEIGHT');
  const row = doc.nodes['1:11'];
  assert.equal(row.autoLayout!.primaryAxisAlignItems, 'SPACE_BETWEEN');
  assert.equal(row.autoLayout!.layoutWrap, 'WRAP');
  assert.equal(row.autoLayout!.counterAxisSpacing, 8, 'null row spacing follows the item spacing');
  assert.equal(row.layoutSizingHorizontal, 'FILL', 'layoutAlign STRETCH in a column fills the width');
  assert.equal(row.layoutSizingVertical, 'HUG');
  assert.equal(doc.nodes['1:25'].layoutSizingHorizontal, 'FILL', 'layoutGrow fills the row');
  assert.equal(doc.nodes['1:26'].layoutPositioning, 'ABSOLUTE');
  assert.deepEqual(doc.nodes['1:26'].constraints, {horizontal: 'MAX', vertical: 'MAX'});
  assert.equal(report.items.length, 0);
  assert.ok(validateDocument(structuredClone(doc)).ok);
});

test('prototype: reactions, transitions, keys, overflow and what is left out', () => {
  const {doc, report} = importFigmaFile(landingFile());
  const button = doc.nodes['1:24'];
  assert.deepEqual(button.reactions[0], {trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: '1:30', transition: {type: 'SMART_ANIMATE', duration: 0.30000001192092896, easing: 'EASE_OUT'}}]});
  assert.deepEqual(button.reactions[1], {trigger: {type: 'ON_KEY_DOWN', keyCode: 'KeyK'}, actions: [{type: 'URL', url: 'https://foo.test/', openInNewTab: true}]});
  assert.deepEqual(button.reactions[2], {trigger: {type: 'AFTER_TIMEOUT', timeout: 800}, actions: [{type: 'BACK'}]});
  assert.deepEqual(button.reactions[3], {trigger: {type: 'MOUSE_UP'}, actions: [{type: 'BACK'}]}, '"Mouse up" is kept as it is');
  assert.equal(button.reactions.length, 4, 'the hover to a missing frame and the variable + javascript click are dropped');
  for (const key of ['proto-destination', 'proto-variables', 'proto-url', 'proto-combo']) assert.ok(report.items.some(item => item.key === key), key);
});

test('styles: local styles from the layers that use them; unused ones reported', () => {
  const {doc, report} = importFigmaFile(landingFile());
  const fill = doc.styles['S3:1'];
  assert.equal(fill.type, 'FILL');
  assert.equal(fill.name, 'Background/White');
  assert.deepEqual(fill.paints, doc.nodes['1:2'].fills);
  assert.equal(doc.nodes['1:2'].fillStyleId, 'S3:1');
  const heading = doc.styles['S3:2'];
  assert.equal(heading.type, 'TEXT');
  assert.equal(heading.description, 'Main heading');
  assert.equal(heading.text!.fontSize, 48);
  assert.equal(doc.nodes['1:3'].textStyleId, 'S3:2');
  assert.ok(report.items.some(item => item.key === 'styles-unused' && item.count === 1));
});

test('pictures: Figma hashes are swapped for stored ones; a lost picture leaves a grey fill', () => {
  const {doc} = importFigmaFile(landingFile());
  const stored = withUploadedImages(doc, new Map([[IMAGE_HASH, {ref: 'dz-abc', asset: {url: '/uploads/dz-abc.webp', width: 1200, height: 800}}]]));
  assert.equal(stored.missing, 0);
  assert.equal((stored.doc.nodes['1:4'].fills[0] as ImagePaint).imageRef, 'dz-abc');
  assert.deepEqual(stored.doc.images['dz-abc'], {url: '/uploads/dz-abc.webp', width: 1200, height: 800});
  assert.ok(validateDocument(structuredClone(stored.doc)).ok);
  assert.equal((doc.nodes['1:4'].fills[0] as ImagePaint).imageRef, IMAGE_HASH, 'the mapped document is not changed');
  const lost = withUploadedImages(doc, new Map());
  assert.equal(lost.missing, 1);
  assert.equal(lost.doc.nodes['1:4'].fills[0].type, 'SOLID');
});

test('caps: layers beyond the node cap are left out with a report, never half an instance', () => {
  const children = Array.from({length: 30}, (_, i) => N('RECTANGLE', `1:${i + 1}`, `R${i}`, at(i * 10, 0), 8, 8, {fills: [solid(0, 0, 0)]}));
  const file = finalize({name: 'Big', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children} as FigmaNode]}});
  const {doc, report} = importFigmaFile(file, {caps: {nodes: 20}});
  assert.ok(Object.keys(doc.nodes).length <= 20);
  assert.equal(doc.nodes['0:1'].children!.length, 18);
  const item = report.items.find(entry => entry.key === 'cap-nodes');
  assert.ok(item);
  assert.equal(item.count, 12);
  assert.ok(validateDocument(structuredClone(doc)).ok);

  const bytes = importFigmaFile(file, {caps: {bytes: 12_000}});
  assert.ok(bytes.bytes <= 12_000);
  assert.ok(bytes.report.items.some(entry => entry.key === 'cap-bytes'));
  // Cyrillic on purpose: the byte count of 1-, 2-, 3- and 4-byte UTF-8 characters.
  assert.equal(utf8Length('aя€😀'), 1 + 2 + 3 + 4);
});

test('pages: the picker summary and choosing pages', () => {
  const file = landingFile();
  file.document!.children!.push({id: '0:2', name: 'Draft', type: 'CANVAS', children: [N('RECTANGLE', '4:1', 'R', at(0, 0), 10, 10)]} as FigmaNode);
  finalize(file);
  const pages = figmaPages(file);
  assert.deepEqual(pages.map(page => [page.id, page.name, page.frames]), [['0:1', 'Home', 3], ['0:2', 'Draft', 1]]);
  const {doc} = importFigmaFile(file, {pageIds: ['0:2']});
  assert.deepEqual(doc.pages, ['0:2']);
  assert.equal(doc.nodes[COMPONENTS_PAGE_ID], undefined);
});

test('sections, slices, overlays, scroll behaviour and page prototype settings', () => {
  const file = finalize({
    name: 'S', document: {children: [{
      id: '0:1', name: 'P', type: 'CANVAS', backgroundColor: {r: 0.1, g: 0.1, b: 0.1, a: 1},
      prototypeDevice: {type: 'PRESET', presetIdentifier: 'APPLE_IPHONE_15', rotation: 'CCW_90'},
      prototypeBackgrounds: [{type: 'SOLID', color: {r: 0, g: 0, b: 0, a: 1}}],
      children: [
        N('SECTION', '1:1', 'Onboarding', at(0, 0), 900, 700, {fills: [solid(0.9, 0.95, 1)], children: [
          N('FRAME', '1:2', 'Step 1', at(40, 60), 375, 600, {
            fills: [solid(1, 1, 1)], overflowDirection: 'HORIZONTAL_AND_VERTICAL_SCROLLING', overlayPositionType: 'BOTTOM_CENTER',
            overlayBackground: {type: 'SOLID_COLOR', color: {r: 0, g: 0, b: 0, a: 0.4}}, overlayBackgroundInteraction: 'CLOSE_ON_CLICK_OUTSIDE',
            children: [
              N('FRAME', '1:3', 'Header', at(0, 0), 375, 64, {scrollBehavior: 'STICKY_SCROLLS', fills: [solid(1, 1, 1)]}),
              N('SLICE', '1:4', 'Export', at(0, 0), 375, 300, {exportSettings: [{suffix: '', format: 'JPG', constraint: {type: 'WIDTH', value: 750}}, {suffix: '', format: 'SVG', constraint: {type: 'SCALE', value: 1}}]}),
            ],
          }),
        ]}),
      ],
    } as FigmaNode]},
  });
  const {doc} = importFigmaFile(file);
  const section = doc.nodes['1:1'];
  assert.equal(section.type, 'SECTION');
  assert.deepEqual(section.children, ['1:2']);
  assert.equal(doc.nodes['1:2'].x, 40);
  const frame = doc.nodes['1:2'];
  assert.equal(frame.overflowDirection, 'BOTH');
  assert.equal(frame.overlayPositionType, 'BOTTOM_CENTER');
  assert.deepEqual(frame.overlayBackground, {type: 'SOLID_COLOR', color: {r: 0, g: 0, b: 0, a: 0.4}});
  assert.equal(frame.overlayBackgroundInteraction, 'CLOSE_ON_CLICK_OUTSIDE');
  assert.equal(doc.nodes['1:3'].scrollBehavior, 'STICKY_SCROLLS');
  assert.equal(doc.nodes['1:4'].type, 'SLICE');
  assert.deepEqual(doc.nodes['1:4'].exportSettings.map(setting => [setting.format, setting.constraint.type, setting.constraint.value]), [['JPG', 'WIDTH', 750], ['SVG', 'SCALE', 1]]);
  const page = doc.nodes['0:1'];
  assert.deepEqual(page.prototypeDevice, {type: 'PRESET', presetId: 'APPLE_IPHONE_15', rotation: 90});
  assert.deepEqual(page.prototypeBackground, {r: 0, g: 0, b: 0});
  close(page.backgroundColor!.r, 0.1);
  assert.ok(validateDocument(structuredClone(doc)).ok);
});

test('hostile input: junk values become defaults, the result still validates', () => {
  const junk = {
    name: 'Junk', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [
      {id: '1:1', type: 'FRAME', name: 'x'.repeat(2000), relativeTransform: [[NaN, 0, 1e12], [0, 1, 0]], size: {x: -5, y: 'a'}, opacity: 7, fills: [{type: 'SOLID', color: {r: 9, g: -1, b: 'x'}}, null, 5], effects: 'no', children: [null, {id: '1:2', type: 'TEXT', characters: 42, style: null}]},
      {id: '__proto__', type: 'RECTANGLE', name: 'p', relativeTransform: [[1, 0, 0], [0, 1, 0]], size: {x: 1, y: 1}},
    ]}]},
  } as unknown as FigmaFile;
  const {doc} = importFigmaFile(junk);
  const valid = validateDocument(structuredClone(doc));
  assert.ok(valid.ok, valid.ok ? '' : `${valid.error} at ${valid.path}`);
});

test('text on a path keeps its path, and Dev Mode measurements come along with the page', () => {
  const style = {fontFamily: 'Inter', fontWeight: 400, fontSize: 20, textAlignHorizontal: 'LEFT', textAlignVertical: 'BOTTOM', letterSpacing: 0, lineHeightUnit: 'INTRINSIC_%'};
  const file: FigmaFile = finalize({
    name: 'Paths', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', measurements: [
      {id: 'x', start: {nodeId: '1:1', side: 'LEFT'}, end: {nodeId: '1:3', side: 'RIGHT'}, offset: {type: 'OUTER', fixed: 24}, freeText: 'Width'},
      {id: 'y', start: {nodeId: '9:9', side: 'TOP'}, end: {nodeId: '1:3', side: 'BOTTOM'}, offset: {type: 'INNER', relative: 0.5}},
    ], children: [
      N('TEXT_PATH', '1:1', 'Arc', at(10, 20), 200, 100, {fills: [solid(0, 0, 0)], characters: 'Along the arc', style,
        fillGeometry: [{path: 'M 0 100 C 50 0 150 0 200 100', windingRule: 'NONZERO'}]}),
      N('TEXT_PATH', '1:2', 'Lost', at(10, 200), 200, 100, {fills: [solid(0, 0, 0)], characters: 'No outline', style}),
      N('RECTANGLE', '1:3', 'Box', at(300, 20), 50, 50, {fills: [solid(1, 0, 0)]}),
    ]} as FigmaNode]},
  } as FigmaFile);
  const {doc, report} = importFigmaFile(file);
  const valid = validateDocument(structuredClone(doc));
  assert.ok(valid.ok, valid.ok ? '' : `${valid.error} at ${valid.path}`);
  const arc = doc.nodes['1:1'];
  assert.equal(arc.type, 'TEXT');
  assert.equal(arc.textPath?.commands.length, 2);
  assert.equal(arc.textPath?.startOffset, 0);
  assert.equal(arc.text?.textAutoResize, 'NONE');
  assert.equal(doc.nodes['1:2'].textPath, undefined);
  assert.ok(report.items.some(item => item.key === 'text-path-start'));
  assert.ok(report.items.some(item => item.key === 'text-path'));
  // The measurement whose layer did not come along is left out.
  assert.deepEqual(doc.nodes['0:1'].measurements, [{id: 'm1', start: {nodeId: '1:1', side: 'LEFT'}, end: {nodeId: '1:3', side: 'RIGHT'}, offset: {type: 'OUTER', fixed: 24}, freeText: 'Width'}]);
});

test('icon-font texts are marked for their SVG render; a text Figma cannot render stays as mapped', async () => {
  const file = finalize({
    name: 'Icons', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [
      N('TEXT', '2:1', 'gas', at(0, 0), 24, 24, {fills: [solid(0, 0, 0)], characters: 'gas_station', style: {fontFamily: 'Material Symbols Rounded', fontSize: 24, textAutoResize: 'NONE'}}),
      N('TEXT', '2:2', 'label', at(40, 0), 120, 20, {fills: [solid(0, 0, 0)], characters: 'GAS', style: {fontFamily: 'Inter', fontSize: 14, textAutoResize: 'NONE'}}),
    ]}]},
  } as FigmaFile);
  const {doc} = importFigmaFile(file);
  const icons = iconTextsOf(doc);
  assert.deepEqual(icons.map(icon => icon.figmaId), ['2:1']);
  const outcome = await replaceIconTexts(doc, icons, {render: async ids => Object.fromEntries(ids.map(id => [id, null])), download: async () => new Blob([])});
  assert.deepEqual(outcome, {replaced: 0, failed: 1});
  assert.equal(doc.nodes[icons[0].id].type, 'TEXT');
});

test('grid auto layout: the REST shape (counts, gaps, CSS track strings, anchored children) becomes a GRID frame', () => {
  const grid = N('FRAME', '2:1', 'Grid', at(0, 0), 400, 300, {
    layoutMode: 'GRID', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    gridRowCount: 2, gridColumnCount: 3, gridRowGap: 12, gridColumnGap: 8, gridRowsSizing: '40px auto', gridColumnsSizing: '1fr 2fr 100px',
    paddingLeft: 10, paddingRight: 10, paddingTop: 10, paddingBottom: 10,
    children: [
      N('RECTANGLE', '2:2', 'A', at(10, 10), 50, 40, {gridRowAnchorIndex: 0, gridColumnAnchorIndex: 0, gridRowSpan: 1, gridColumnSpan: 2, gridChildHorizontalAlign: 'CENTER', gridChildVerticalAlign: 'AUTO'}),
      N('RECTANGLE', '2:3', 'B', at(200, 60), 50, 40, {gridRowAnchorIndex: 1, gridColumnAnchorIndex: 2, gridChildHorizontalAlign: 'MAX', gridChildVerticalAlign: 'MIN'}),
      N('RECTANGLE', '2:4', 'Abs', at(300, 200), 20, 20, {layoutPositioning: 'ABSOLUTE', gridRowAnchorIndex: 0, gridColumnAnchorIndex: 0}),
    ],
  });
  const file = finalize({name: 'Grid', document: {children: [{id: '0:1', name: 'P', type: 'CANVAS', children: [grid]} as FigmaNode]}});
  const {doc, report} = importFigmaFile(file);
  const frame = doc.nodes['2:1'];
  assert.equal(frame.autoLayout!.layoutMode, 'GRID');
  assert.deepEqual(frame.grid, {
    rowCount: 2, columnCount: 3, rowGap: 12, columnGap: 8,
    rowSizes: [{type: 'FIXED', value: 40}, {type: 'HUG'}], columnSizes: [{type: 'FLEX'}, {type: 'FLEX', value: 2}, {type: 'FIXED', value: 100}],
    autoTracks: 'NONE', itemsPositioning: 'MANUAL',
  });
  assert.deepEqual(doc.nodes['2:2'].gridChild, {rowAnchorIndex: 0, columnAnchorIndex: 0, columnSpan: 2, horizontalAlign: 'CENTER'});
  assert.deepEqual(doc.nodes['2:3'].gridChild, {rowAnchorIndex: 1, columnAnchorIndex: 2, horizontalAlign: 'MAX', verticalAlign: 'MIN'});
  assert.equal(doc.nodes['2:4'].gridChild, undefined, 'an absolute child has no cell');
  assert.ok(!report.items.some(item => item.key === 'layout-grid'), 'no «carried as fixed placement» note any more');
});
