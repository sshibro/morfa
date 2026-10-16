import assert from 'node:assert/strict';
import test from 'node:test';
import {importFigmaFile, missingComponents, COMPONENTS_PAGE_ID, type FigmaFile, type FigmaNode} from '../shared/design/figma-import';
import {validateDocument} from '../shared/design/schema';
import {syncInstances} from '../shared/design/components';
import {sameValue} from '../shared/design/constraints';
import {worldBox} from '../shared/design/geometry';
import type {DesignDocument, SceneNode} from '../shared/design/types';

// Components, variants, instances with overrides, nested and swapped instances, a library instance,
// as GET /v1/files/:key?geometry=paths returns them: copies inside instances have ids
// "I<instance>;<node of its main>", nested ones chain further ("I5:10;2:31;2:7;2:11").

type T = [[number, number, number], [number, number, number]];
const at = (x: number, y: number): T => [[1, 0, x], [0, 1, y]];
const solid = (r: number, g: number, b: number) => ({blendMode: 'NORMAL', type: 'SOLID', color: {r, g, b, a: 1}});
const mul = (m: T, n: T): T => [
  [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
  [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]],
];

function N(type: string, id: string, name: string, transform: T, w: number, h: number, extra: Partial<FigmaNode> = {}): FigmaNode {
  return {
    id, name, type, blendMode: 'PASS_THROUGH', relativeTransform: transform, size: {x: w, y: h}, constraints: {vertical: 'TOP', horizontal: 'LEFT'},
    fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', effects: [], ...extra,
  } as FigmaNode;
}

function finalize(file: FigmaFile): FigmaFile {
  const visit = (node: FigmaNode, parentAbs: T) => {
    const abs = mul(parentAbs, node.relativeTransform as T);
    node.absoluteBoundingBox = {x: abs[0][2], y: abs[1][2], width: node.size!.x, height: node.size!.y};
    for (const child of node.children ?? []) visit(child, abs);
  };
  for (const page of file.document!.children!) for (const child of page.children ?? []) visit(child, [[1, 0, 0], [0, 1, 0]]);
  return file;
}

const STAR_PATH = 'M10 0L13 7L20 7L14 12L16 20L10 15L4 20L6 12L0 7L7 7Z';
const vector = (id: string, fill = solid(0, 0, 0)) => N('VECTOR', id, 'Star shape', at(2, 2), 20, 20, {fills: [fill], fillGeometry: [{path: STAR_PATH, windingRule: 'NONZERO'}]});
const label = (id: string, characters: string, width: number, extra: Partial<FigmaNode> = {}) =>
  N('TEXT', id, 'Label', at(48, 12), width, 20, {
    fills: [solid(1, 1, 1)], characters, componentPropertyReferences: {characters: 'Label#1:0'},
    style: {fontFamily: 'Inter', fontWeight: 600, fontSize: 16, textAutoResize: 'WIDTH_AND_HEIGHT', lineHeightUnit: 'INTRINSIC_%', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP'},
    layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', ...extra,
  });
const icon = (id: string, children: FigmaNode[], extra: Partial<FigmaNode> = {}) =>
  N('INSTANCE', id, 'Icon/Star', at(16, 10), 24, 24, {componentId: '2:10', componentProperties: {}, componentPropertyReferences: {visible: 'Show icon#1:1', mainComponent: 'Icon#1:2'}, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', children, ...extra});
const buttonFrame = {
  layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO', layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
  paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 10, itemSpacing: 8, counterAxisAlignItems: 'CENTER', cornerRadius: 8, clipsContent: false,
} as Partial<FigmaNode>;
const buttonProps = (state: string, text: string) => ({
  State: {type: 'VARIANT', value: state}, 'Label#1:0': {type: 'TEXT', value: text}, 'Show icon#1:1': {type: 'BOOLEAN', value: true}, 'Icon#1:2': {type: 'INSTANCE_SWAP', value: '2:10'},
});

function componentsPage(): FigmaNode {
  return {
    id: '0:2', name: 'Components', type: 'CANVAS', children: [
      N('COMPONENT_SET', '2:1', 'Button', at(0, 0), 360, 84, {
        componentPropertyDefinitions: {
          State: {type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Hover']},
          'Label#1:0': {type: 'TEXT', defaultValue: 'Button'},
          'Show icon#1:1': {type: 'BOOLEAN', defaultValue: true},
          'Icon#1:2': {type: 'INSTANCE_SWAP', defaultValue: '2:10', preferredValues: [{type: 'COMPONENT', key: 'kHeart'}]},
        },
        children: [
          N('COMPONENT', '2:2', 'State=Default', at(20, 20), 140, 44, {...buttonFrame, fills: [solid(0.05, 0.6, 1)], children: [icon('2:4', [vector('I2:4;2:11')], {isExposedInstance: true}), label('2:3', 'Button', 76)]}),
          N('COMPONENT', '2:5', 'State=Hover', at(200, 20), 140, 44, {...buttonFrame, fills: [solid(0, 0.45, 0.8)], children: [icon('2:7', [vector('I2:7;2:11')]), label('2:6', 'Button', 76)]}),
        ],
      }),
      N('COMPONENT', '2:10', 'Icon/Star', at(0, 400), 24, 24, {children: [vector('2:11')]}),
      N('COMPONENT', '2:20', 'Icon/Heart', at(40, 400), 24, 24, {children: [N('VECTOR', '2:21', 'Heart', at(2, 3), 20, 18, {fills: [solid(1, 0, 0)], fillGeometry: [{path: 'M0 0L20 0L10 18Z', windingRule: 'NONZERO'}]})]}),
      N('COMPONENT', '2:30', 'Card', at(0, 200), 300, 160, {
        fills: [solid(1, 1, 1)], clipsContent: true,
        componentPropertyDefinitions: {},
        children: [
          N('RECTANGLE', '2:32', 'Background', at(0, 0), 300, 160, {fills: [solid(0.95, 0.95, 0.97)], constraints: {horizontal: 'LEFT_RIGHT', vertical: 'TOP_BOTTOM'}}),
          N('TEXT', '2:34', 'Title', at(16, 16), 268, 24, {fills: [solid(0, 0, 0)], characters: 'Plan', constraints: {horizontal: 'LEFT_RIGHT', vertical: 'TOP'}, style: {fontFamily: 'Inter', fontSize: 20, textAutoResize: 'HEIGHT', lineHeightUnit: 'INTRINSIC_%'}}),
          N('INSTANCE', '2:31', 'Button', at(16, 100), 140, 44, {
            ...buttonFrame, fills: [solid(0.05, 0.6, 1)], componentId: '2:2', componentProperties: buttonProps('Default', 'Button'),
            children: [icon('I2:31;2:4', [vector('I2:31;2:4;2:11')]), label('I2:31;2:3', 'Button', 76)],
          }),
        ],
      }),
    ],
  } as FigmaNode;
}

function screensPage(): FigmaNode {
  return {
    id: '0:1', name: 'Screens', type: 'CANVAS', children: [
      // A button with its label property set, a green fill, and the hug width the longer label gives.
      N('INSTANCE', '5:1', 'Buy', at(100, 100), 160, 44, {
        ...buttonFrame, fills: [solid(0.1, 0.7, 0.3)], componentId: '2:2', componentProperties: buttonProps('Default', 'Buy now'),
        children: [icon('I5:1;2:4', [vector('I5:1;2:4;2:11')]), label('I5:1;2:3', 'Buy now', 96)],
      }),
      // A card resized wider, with its title changed and its nested button switched to the Hover variant.
      N('INSTANCE', '5:10', 'Card', at(100, 300), 400, 160, {
        fills: [solid(1, 1, 1)], clipsContent: true, componentId: '2:30', componentProperties: {},
        children: [
          N('RECTANGLE', 'I5:10;2:32', 'Background', at(0, 0), 400, 160, {fills: [solid(0.95, 0.95, 0.97)], constraints: {horizontal: 'LEFT_RIGHT', vertical: 'TOP_BOTTOM'}}),
          N('TEXT', 'I5:10;2:34', 'Title', at(16, 16), 368, 24, {fills: [solid(0, 0, 0)], characters: 'Plan "Pro"', constraints: {horizontal: 'LEFT_RIGHT', vertical: 'TOP'}, style: {fontFamily: 'Inter', fontSize: 20, textAutoResize: 'HEIGHT', lineHeightUnit: 'INTRINSIC_%'}}),
          N('INSTANCE', 'I5:10;2:31', 'Button', at(16, 100), 140, 44, {
            ...buttonFrame, fills: [solid(0, 0.45, 0.8)], componentId: '2:5', componentProperties: buttonProps('Hover', 'Details'),
            children: [icon('I5:10;2:31;2:7', [vector('I5:10;2:31;2:7;2:11')]), label('I5:10;2:31;2:6', 'Details', 76)],
          }),
        ],
      }),
      // An instance of a library component, with a local icon inside.
      N('INSTANCE', '5:20', 'Library button', at(100, 500), 120, 40, {
        componentId: '9:100', fills: [solid(0.2, 0.2, 0.2)], componentProperties: {},
        children: [
          N('RECTANGLE', 'I5:20;9:101', 'Bg', at(0, 0), 120, 40, {fills: [solid(0.9, 0.9, 0.9)]}),
          N('INSTANCE', 'I5:20;9:103', 'Icon/Star', at(8, 8), 24, 24, {componentId: '2:10', componentProperties: {}, children: [vector('I5:20;9:103;2:11', solid(0.5, 0, 0.5))]}),
        ],
      }),
    ],
  } as FigmaNode;
}

const META = {
  components: {
    '2:2': {key: 'kDefault', name: 'State=Default', componentSetId: '2:1', description: ''},
    '2:5': {key: 'kHover', name: 'State=Hover', componentSetId: '2:1', description: ''},
    '2:10': {key: 'kStar', name: 'Icon/Star', description: 'Star'},
    '2:20': {key: 'kHeart', name: 'Icon/Heart', description: ''},
    '2:30': {key: 'kCard', name: 'Card', description: 'Plan card'},
    '9:100': {key: 'libkey', name: 'Library button', remote: true, description: ''},
  },
  componentSets: {'2:1': {key: 'kButton', name: 'Button', description: 'Buttons'}},
};

const kitFile = (): FigmaFile => finalize({name: 'Kit', document: {children: [screensPage(), componentsPage()]}, ...META});

function assertSyncKeeps(doc: DesignDocument) {
  const instances = Object.values(doc.nodes).filter(node => node.type === 'INSTANCE').map(node => node.id);
  const synced = syncInstances(doc, new Set(instances));
  for (const [id, node] of Object.entries(doc.nodes)) {
    const after = synced.nodes[id];
    assert.ok(after, `sync removed ${id}`);
    const a = node as unknown as Record<string, unknown>, b = after as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) assert.ok(sameValue(a[key], b[key]), `sync changes ${id}.${key}: ${JSON.stringify(a[key])} → ${JSON.stringify(b[key])}`);
  }
  assert.equal(Object.keys(synced.nodes).length, Object.keys(doc.nodes).length);
}

test('instances keep Figma\'s copies under our `${instance};${main}` ids', () => {
  const {doc, report} = importFigmaFile(kitFile());
  const valid = validateDocument(structuredClone(doc));
  assert.ok(valid.ok, valid.ok ? '' : `${valid.error} at ${valid.path}`);
  const expect = (id: string, type: SceneNode['type'], mainId?: string) => {
    const node = doc.nodes[id];
    assert.ok(node, 'missing ' + id);
    assert.equal(node.type, type, id);
    assert.equal(node.mainId, mainId, id + ' mainId');
  };
  expect('5:1', 'INSTANCE');
  expect('5:1;2:3', 'TEXT', '2:3');
  expect('5:1;2:4', 'INSTANCE', '2:4');
  expect('5:1;2:4;2:11', 'VECTOR', '2:4;2:11');
  expect('2:4;2:11', 'VECTOR', '2:11');
  expect('2:31;2:4;2:11', 'VECTOR', '2:4;2:11');
  // A swapped nested instance owns the ids of its copies.
  expect('5:10;2:31', 'INSTANCE', '2:31');
  expect('5:10;2:31;2:6', 'TEXT', '2:6');
  expect('5:10;2:31;2:7', 'INSTANCE', '2:7');
  expect('5:10;2:31;2:7;2:11', 'VECTOR', '2:7;2:11');
  assert.equal(doc.nodes['5:1'].componentId, '2:2');
  assert.equal(doc.nodes['5:10;2:31'].componentId, '2:5');
  assert.deepEqual(doc.nodes['5:1'].componentProperties, {State: 'Default', 'Label#1:0': 'Buy now', 'Show icon#1:1': true, 'Icon#1:2': '2:10'});
  assert.equal(report.instances, 6, 'top-level instances: two on the screens, the icons in the variants, the button in the card, the icon in the library frame');
  assert.equal(report.components, 5);
});

test('overrides are recorded so syncing from the mains changes nothing', () => {
  const {doc} = importFigmaFile(kitFile());
  assertSyncKeeps(doc);
  const buy = doc.nodes['5:1'];
  assert.ok(buy.overrides!.includes('componentProperties.Label#1:0'));
  assert.ok(buy.overrides!.includes('fills'));
  assert.ok(!buy.overrides!.includes('width'), 'a hugging width belongs to layout');
  assert.equal(doc.nodes['5:1;2:3'].overrides, undefined, 'the label follows its property, not an override');
  const card = doc.nodes['5:10'];
  assert.ok(card.overrides!.includes('width'));
  assert.deepEqual(doc.nodes['5:10;2:34'].overrides, ['text.characters']);
  assert.equal(doc.nodes['5:10;2:32'].overrides, undefined, 'stretched by its constraints');
  const nested = doc.nodes['5:10;2:31'];
  assert.ok(nested.overrides!.includes('componentId'));
  assert.ok(nested.overrides!.includes('componentProperties.Label#1:0'));
  assert.equal(doc.nodes['5:10;2:31;2:6'].text!.characters, 'Details');
});

test('variant sets, property definitions and references', () => {
  const {doc} = importFigmaFile(kitFile());
  const set = doc.nodes['2:1'];
  assert.equal(set.type, 'COMPONENT_SET');
  assert.equal(set.description, 'Buttons');
  assert.deepEqual(set.componentPropertyDefinitions, {
    State: {type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Hover']},
    'Label#1:0': {type: 'TEXT', defaultValue: 'Button'},
    'Show icon#1:1': {type: 'BOOLEAN', defaultValue: true},
    'Icon#1:2': {type: 'INSTANCE_SWAP', defaultValue: '2:10', preferredValues: ['2:20']},
  });
  assert.deepEqual(doc.nodes['2:3'].componentPropertyReferences, {characters: 'Label#1:0'});
  assert.deepEqual(doc.nodes['2:4'].componentPropertyReferences, {visible: 'Show icon#1:1', mainComponent: 'Icon#1:2'});
  assert.equal(doc.nodes['2:4'].isExposedInstance, true, 'an exposed nested instance stays exposed');
  assert.equal(doc.nodes['2:10'].description, 'Star');
  assert.equal(doc.nodes['2:2'].autoLayout!.layoutMode, 'HORIZONTAL');
  assert.equal(doc.nodes['2:2'].layoutSizingHorizontal, 'HUG');
});

test('a library instance becomes a frame; a local instance inside it stays an instance', () => {
  const {doc, report} = importFigmaFile(kitFile());
  const frame = doc.nodes['5:20'];
  assert.equal(frame.type, 'FRAME');
  assert.equal(frame.componentId, undefined);
  assert.equal(frame.pluginData?.figmaComponent, 'Library button');
  assert.deepEqual(frame.children, ['I5:20,9:101', 'I5:20,9:103']);
  assert.equal(doc.nodes['I5:20,9:101'].mainId, undefined);
  const icon = doc.nodes['I5:20,9:103'];
  assert.equal(icon.type, 'INSTANCE');
  assert.equal(icon.componentId, '2:10');
  assert.equal(doc.nodes['I5:20,9:103;2:11'].mainId, '2:11');
  assert.ok(doc.nodes['I5:20,9:103;2:11'].overrides!.includes('fills'));
  const item = report.items.find(entry => entry.key === 'detached-remote');
  assert.ok(item);
  assert.deepEqual(item.examples, ['Library button']);
  assertSyncKeeps(doc);
});

test('mains on pages that were not chosen are lifted onto a "Components" page', () => {
  const file = kitFile();
  const {doc, report} = importFigmaFile(file, {pageIds: ['0:1']});
  assert.deepEqual(doc.pages, ['0:1', COMPONENTS_PAGE_ID]);
  const lifted = doc.nodes[COMPONENTS_PAGE_ID].children!;
  assert.deepEqual([...lifted].sort(), ['2:1', '2:10', '2:30']);
  assert.equal(doc.nodes['2:20'], undefined, 'nothing uses the heart');
  assert.equal(doc.nodes['2:1'].componentPropertyDefinitions!['Icon#1:2'].preferredValues, undefined);
  assert.ok(report.items.some(item => item.key === 'components-lifted' && item.count === 3));
  assert.equal(doc.nodes['5:1'].type, 'INSTANCE');
  assertSyncKeeps(doc);
  // Lifted units sit on a shelf without overlapping.
  const boxes = lifted.map(id => worldBox(doc, id));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'overlap');
    }
  assert.ok(validateDocument(structuredClone(doc)).ok);
});

test('a file read page by page: missing mains are listed, fetched on their own, and placed', () => {
  const full = kitFile();
  const pageOnly: FigmaFile = {name: full.name, document: {children: [full.document!.children![0]]}, ...META};
  assert.deepEqual(missingComponents(pageOnly, ['0:1']).sort(), ['2:1', '2:10', '2:30']);
  const components = full.document!.children![1].children!;
  const extra = components.filter(node => ['2:1', '2:10', '2:30'].includes(node.id));
  assert.deepEqual(missingComponents(pageOnly, ['0:1'], extra), []);
  const {doc} = importFigmaFile(pageOnly, {pageIds: ['0:1'], extraNodes: extra});
  assert.equal(doc.nodes['5:10;2:31'].type, 'INSTANCE');
  assert.ok(doc.nodes[COMPONENTS_PAGE_ID].children!.includes('2:30'));
  const card = worldBox(doc, '2:30');
  assert.equal(card.width, 300);
  assertSyncKeeps(doc);
});

test('an instance whose copies do not match its main is detached, not mangled', () => {
  const file = kitFile();
  const buy = file.document!.children![0].children![0];
  buy.children!.pop();
  const {doc, report} = importFigmaFile(file);
  assert.equal(doc.nodes['5:1'].type, 'FRAME');
  assert.ok(report.items.some(item => item.key === 'detached-mismatch'));
  assertSyncKeeps(doc);
});
