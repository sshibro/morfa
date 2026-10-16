import {deflateSync, zipSync} from 'fflate';

// .fig files for tests, written the way Figma's "Save local copy" writes them: a ZIP with canvas.fig (a kiwi schema
// and message, deflated) and images/<sha1 hex>. The schema is a small subset of Figma's own with Figma's field names,
// so the reader (src/figma-import/fig-file) meets the same shapes as in a real file; the reader takes every name
// from the file, so field numbers here need not match Figma's.

type FieldSpec = [name: string, type: string, isArray?: boolean];
type Definition = {name: string; kind: 'ENUM' | 'STRUCT' | 'MESSAGE'; fields: FieldSpec[] | string[]};

const enumOf = (name: string, values: string[]): Definition => ({name, kind: 'ENUM', fields: values});
const struct = (name: string, fields: FieldSpec[]): Definition => ({name, kind: 'STRUCT', fields});
const message = (name: string, fields: FieldSpec[]): Definition => ({name, kind: 'MESSAGE', fields});

export const FIG_SCHEMA: Definition[] = [
  enumOf('MessageType', ['JOIN_START', 'NODE_CHANGES']),
  enumOf('NodePhase', ['CREATED', 'REMOVED']),
  enumOf('NodeType', ['NONE', 'DOCUMENT', 'CANVAS', 'GROUP', 'FRAME', 'BOOLEAN_OPERATION', 'VECTOR', 'STAR', 'LINE', 'ELLIPSE', 'RECTANGLE', 'REGULAR_POLYGON', 'ROUNDED_RECTANGLE', 'TEXT', 'SLICE', 'SYMBOL', 'INSTANCE', 'SECTION', 'VARIABLE']),
  enumOf('PaintType', ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE']),
  enumOf('ImageScaleMode', ['STRETCH', 'FIT', 'FILL', 'TILE']),
  enumOf('StackMode', ['NONE', 'HORIZONTAL', 'VERTICAL']),
  enumOf('StackSize', ['FIXED', 'RESIZE_TO_FIT', 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE']),
  enumOf('StackAlign', ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN', 'BASELINE']),
  enumOf('StackAlignSelf', ['AUTO', 'STRETCH']),
  enumOf('ConstraintType', ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']),
  enumOf('WindingRule', ['NONZERO', 'ODD']),
  enumOf('NumberUnits', ['RAW', 'PIXELS', 'PERCENT']),
  enumOf('TextAutoResize', ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT']),
  enumOf('StyleType', ['NONE', 'FILL', 'TEXT', 'EFFECT', 'GRID']),
  enumOf('ComponentPropType', ['BOOL', 'TEXT', 'COLOR', 'INSTANCE_SWAP', 'VARIANT', 'NUMBER']),
  enumOf('ComponentPropNodeField', ['VISIBLE', 'TEXT_DATA', 'OVERRIDDEN_SYMBOL_ID']),
  enumOf('EffectType', ['INNER_SHADOW', 'DROP_SHADOW', 'FOREGROUND_BLUR', 'BACKGROUND_BLUR']),
  struct('GUID', [['sessionID', 'uint'], ['localID', 'uint']]),
  struct('Color', [['r', 'float'], ['g', 'float'], ['b', 'float'], ['a', 'float']]),
  struct('Vector', [['x', 'float'], ['y', 'float']]),
  struct('Matrix', [['m00', 'float'], ['m01', 'float'], ['m02', 'float'], ['m10', 'float'], ['m11', 'float'], ['m12', 'float']]),
  message('ParentIndex', [['guid', 'GUID'], ['position', 'string']]),
  message('Image', [['hash', 'byte', true], ['name', 'string']]),
  message('ColorStop', [['color', 'Color'], ['position', 'float']]),
  message('Paint', [['type', 'PaintType'], ['color', 'Color'], ['opacity', 'float'], ['visible', 'bool'], ['image', 'Image'], ['transform', 'Matrix'], ['stops', 'ColorStop', true], ['imageScaleMode', 'ImageScaleMode']]),
  message('Effect', [['type', 'EffectType'], ['color', 'Color'], ['offset', 'Vector'], ['radius', 'float'], ['spread', 'float'], ['visible', 'bool']]),
  message('Path', [['windingRule', 'WindingRule'], ['commandsBlob', 'uint'], ['styleID', 'uint']]),
  message('FontName', [['family', 'string'], ['style', 'string'], ['postscript', 'string']]),
  message('Number', [['value', 'float'], ['units', 'NumberUnits']]),
  message('TextData', [['characters', 'string'], ['characterStyleIDs', 'uint', true], ['styleOverrideTable', 'NodeChange', true]]),
  message('GUIDPath', [['guids', 'GUID', true]]),
  message('StyleId', [['guid', 'GUID']]),
  message('ComponentPropValue', [['boolValue', 'bool'], ['textValue', 'TextData'], ['guidValue', 'GUID']]),
  message('ComponentPropAssignment', [['defID', 'GUID'], ['value', 'ComponentPropValue']]),
  message('ComponentPropRef', [['defID', 'GUID'], ['componentPropNodeField', 'ComponentPropNodeField']]),
  message('ComponentPropDef', [['id', 'GUID'], ['name', 'string'], ['type', 'ComponentPropType'], ['initialValue', 'ComponentPropValue'], ['parentPropDefId', 'GUID']]),
  message('VariantPropSpec', [['propDefId', 'GUID'], ['value', 'string']]),
  message('PrototypeStartingPoint', [['name', 'string'], ['description', 'string'], ['position', 'string']]),
  message('SymbolData', [['symbolID', 'GUID'], ['symbolOverrides', 'NodeChange', true]]),
  message('NodeChange', [
    ['guid', 'GUID'], ['phase', 'NodePhase'], ['parentIndex', 'ParentIndex'], ['type', 'NodeType'], ['name', 'string'], ['visible', 'bool'], ['opacity', 'float'],
    ['size', 'Vector'], ['transform', 'Matrix'], ['fillPaints', 'Paint', true], ['strokePaints', 'Paint', true], ['strokeWeight', 'float'], ['effects', 'Effect', true],
    ['cornerRadius', 'float'], ['stackMode', 'StackMode'], ['stackSpacing', 'float'], ['stackHorizontalPadding', 'float'], ['stackVerticalPadding', 'float'],
    ['stackPaddingRight', 'float'], ['stackPaddingBottom', 'float'], ['stackPrimarySizing', 'StackSize'], ['stackCounterSizing', 'StackSize'], ['stackPrimaryAlignItems', 'StackAlign'],
    ['stackChildAlignSelf', 'StackAlignSelf'], ['stackChildPrimaryGrow', 'float'], ['horizontalConstraint', 'ConstraintType'], ['verticalConstraint', 'ConstraintType'],
    ['resizeToFit', 'bool'], ['frameMaskDisabled', 'bool'], ['fillGeometry', 'Path', true], ['strokeGeometry', 'Path', true],
    ['textData', 'TextData'], ['fontName', 'FontName'], ['fontSize', 'float'], ['lineHeight', 'Number'], ['letterSpacing', 'Number'], ['textAutoResize', 'TextAutoResize'],
    ['styleID', 'uint'], ['styleType', 'StyleType'], ['styleIdForFill', 'StyleId'], ['styleIdForText', 'StyleId'],
    ['symbolData', 'SymbolData'], ['derivedSymbolData', 'NodeChange', true], ['guidPath', 'GUIDPath'], ['overriddenSymbolID', 'GUID'],
    ['componentPropDefs', 'ComponentPropDef', true], ['componentPropRefs', 'ComponentPropRef', true], ['componentPropAssignments', 'ComponentPropAssignment', true],
    ['variantPropSpecs', 'VariantPropSpec', true], ['isStateGroup', 'bool'], ['internalOnly', 'bool'], ['isSoftDeleted', 'bool'], ['symbolDescription', 'string'],
    ['prototypeStartingPoint', 'PrototypeStartingPoint'], ['overrideKey', 'GUID'],
  ]),
  message('Blob', [['bytes', 'byte', true]]),
  message('Message', [['type', 'MessageType'], ['nodeChanges', 'NodeChange', true], ['blobs', 'Blob', true]]),
];

const NATIVE = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'];

class Writer {
  bytes: number[] = [];
  byte(value: number) {
    this.bytes.push(value & 255);
  }
  uint(value: number) {
    do {
      const byte = value & 127;
      value >>>= 7;
      this.byte(value ? byte | 128 : byte);
    } while (value);
  }
  int(value: number) {
    this.uint((value << 1) ^ (value >> 31));
  }
  float(value: number) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    let bits = view.getInt32(0, true);
    bits = (bits >>> 23) | (bits << 9);
    if ((bits & 255) === 0) return this.byte(0);
    for (let i = 0; i < 4; i++) this.byte(bits >>> (i * 8));
  }
  string(value: string) {
    for (const byte of new TextEncoder().encode(value)) this.byte(byte);
    this.byte(0);
  }
}

export function encodeSchema(definitions: readonly Definition[] = FIG_SCHEMA): Uint8Array {
  const writer = new Writer();
  const index = new Map(definitions.map((definition, i) => [definition.name, i]));
  writer.uint(definitions.length);
  for (const definition of definitions) {
    writer.string(definition.name);
    writer.byte(KINDS.indexOf(definition.kind));
    writer.uint(definition.fields.length);
    definition.fields.forEach((field, i) => {
      if (typeof field === 'string') {
        writer.string(field);
        writer.int(NATIVE.indexOf('uint') ^ -1);
        writer.byte(0);
        writer.uint(i);
        return;
      }
      const [name, type, isArray] = field;
      writer.string(name);
      writer.int(NATIVE.includes(type) ? ~NATIVE.indexOf(type) : index.get(type)!);
      writer.byte(isArray ? 1 : 0);
      writer.uint(i + 1);
    });
  }
  return new Uint8Array(writer.bytes);
}

// The test objects are loose on purpose: the reader takes whatever the file holds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Value = any;

export function encodeMessage(value: Value, root = 'Message', definitions: readonly Definition[] = FIG_SCHEMA): Uint8Array {
  const writer = new Writer();
  const byName = new Map(definitions.map(definition => [definition.name, definition]));
  const one = (type: string, item: Value) => {
    switch (type) {
      case 'bool': return writer.byte(item ? 1 : 0);
      case 'byte': return writer.byte(item);
      case 'int': return writer.int(item);
      case 'uint': return writer.uint(item);
      case 'float': return writer.float(item);
      case 'string': return writer.string(item);
    }
    const definition = byName.get(type)!;
    if (definition.kind === 'ENUM') {
      const at = (definition.fields as string[]).indexOf(item);
      if (at < 0) throw new Error(`${type} has no ${item}`);
      return writer.uint(at);
    }
    const fields = definition.fields as FieldSpec[];
    if (definition.kind === 'STRUCT') {
      for (const [name, fieldType] of fields) one(fieldType, item[name] ?? 0);
      return;
    }
    fields.forEach(([name, fieldType, isArray], i) => {
      if (item[name] === undefined) return;
      writer.uint(i + 1);
      if (!isArray) return one(fieldType, item[name]);
      const list = item[name] as Value[] | Uint8Array;
      writer.uint(list.length);
      for (const entry of list) one(fieldType, entry);
    });
    writer.uint(0);
  };
  one(root, value);
  return new Uint8Array(writer.bytes);
}

/** canvas.fig: "fig-kiwi", a version, then the deflated schema and message. */
export function canvasFig(value: Value, magic = 'fig-kiwi'): Uint8Array {
  const chunks = [deflateSync(encodeSchema()), deflateSync(encodeMessage(value))];
  const size = 12 + chunks.reduce((sum, chunk) => sum + 4 + chunk.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(magic.padEnd(8, '.').slice(0, 8)), 0);
  view.setUint32(8, 48, true);
  let offset = 12;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.length, true);
    out.set(chunk, offset + 4);
    offset += 4 + chunk.length;
  }
  return out;
}

/** The ZIP "Save local copy" writes. */
export function figZip(value: Value, images: Record<string, Uint8Array> = {}): Uint8Array {
  const entries: Record<string, Uint8Array> = {'canvas.fig': canvasFig(value), 'meta.json': new TextEncoder().encode('{"file_name":"Test"}')};
  for (const [hash, bytes] of Object.entries(images)) entries['images/' + hash] = bytes;
  return zipSync(entries, {level: 0});
}

// ── Node changes ───────────────────────────────────────────────────────────────────────────────

export const guid = (id: string) => {
  const [sessionID, localID] = id.split(':').map(Number);
  return {sessionID, localID};
};
export const at = (x: number, y: number) => ({m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y});
export const solid = (r: number, g: number, b: number, a = 1) => ({type: 'SOLID', color: {r, g, b, a}, opacity: 1, visible: true});

/** A node change under `parent` at sibling `position` (Figma's fractional index: later sorts above). */
export function node(id: string, parent: string | null, position: string, type: string, extra: Value = {}): Value {
  return {guid: guid(id), phase: 'CREATED', ...(parent ? {parentIndex: {guid: guid(parent), position}} : {}), type, name: extra.name ?? `${type} ${id}`, visible: true, opacity: 1, ...extra};
}

/** A path blob: move to the first point, lines to the rest, closed. */
export function polygonBlob(points: [number, number][]): Uint8Array {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(4));
  const push = (value: number) => {
    view.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) out.push(view.getUint8(i));
  };
  points.forEach(([x, y], i) => {
    out.push(i ? 2 : 1);
    push(x);
    push(y);
  });
  out.push(0);
  return new Uint8Array(out);
}

/** The smallest valid PNG (1×1, transparent). */
export const TINY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), char => char.charCodeAt(0));

/** The picture's hash in sampleFig. */
export const SAMPLE_HASH = 'aa'.repeat(20);
const hashBytes = Uint8Array.from({length: 20}, () => 0xaa);

/** A small design: a page with an auto-layout card (picture, text with a shared style), a group with a vector,
 *  a component with a text and a visibility property and a nested instance, and an instance of it with a text value,
 *  an override two levels deep and Figma's layout for its resized copy; a hidden page holds the style. */
export function sampleFig() {
  return {
    type: 'NODE_CHANGES',
    blobs: [{bytes: polygonBlob([[0, 0], [20, 0], [10, 20]])}],
    nodeChanges: [
      node('0:0', null, '', 'DOCUMENT', {name: 'Document'}),
      node('0:1', '0:0', '!', 'CANVAS', {name: 'Screens'}),
      node('0:2', '0:0', '~', 'CANVAS', {name: 'Internal Only Canvas', internalOnly: true, visible: false}),
      node('1:1', '0:1', '!', 'FRAME', {
        name: 'Card', size: {x: 200, y: 120}, transform: at(10, 20), fillPaints: [solid(1, 1, 1)],
        stackMode: 'VERTICAL', stackSpacing: 8, stackHorizontalPadding: 16, stackVerticalPadding: 12, stackPaddingRight: 20, stackPaddingBottom: 24, stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
        prototypeStartingPoint: {name: 'Login', position: '!'},
      }),
      // Listed out of order: the position decides, "!" below '"'.
      node('1:3', '1:1', '"', 'TEXT', {
        name: 'Title', size: {x: 168, y: 29}, transform: at(16, 72), fillPaints: [solid(0, 0, 0)],
        textData: {characters: 'Hello'}, fontName: {family: 'Inter', style: 'Regular', postscript: 'Inter-Regular'}, fontSize: 12,
        lineHeight: {value: 100, units: 'PERCENT'}, letterSpacing: {value: 10, units: 'PERCENT'}, textAutoResize: 'HEIGHT', styleIdForText: {guid: guid('5:1')},
      }),
      node('1:2', '1:1', '!', 'ROUNDED_RECTANGLE', {
        name: 'Photo', size: {x: 168, y: 52}, transform: at(16, 12), cornerRadius: 8, stackChildAlignSelf: 'STRETCH',
        fillPaints: [{type: 'IMAGE', opacity: 1, visible: true, image: {hash: hashBytes, name: 'photo'}, imageScaleMode: 'FILL', transform: at(0, 0)}],
      }),
      node('1:4', '0:1', '"', 'FRAME', {name: 'Mark', resizeToFit: true, size: {x: 40, y: 30}, transform: at(300, 40), frameMaskDisabled: true}),
      node('1:5', '1:4', '!', 'VECTOR', {name: 'Triangle', size: {x: 20, y: 20}, transform: at(10, 5), fillPaints: [solid(1, 0, 0)], fillGeometry: [{windingRule: 'NONZERO', commandsBlob: 0}]}),
      node('2:1', '0:1', '#', 'SYMBOL', {
        name: 'Button', size: {x: 100, y: 40}, transform: at(0, 300), fillPaints: [solid(0.2, 0.2, 0.9)],
        componentPropDefs: [
          {id: guid('3:1'), name: 'Label', type: 'TEXT', initialValue: {textValue: {characters: 'OK'}}},
          {id: guid('3:2'), name: 'Icon', type: 'BOOL', initialValue: {boolValue: true}},
        ],
      }),
      node('2:2', '2:1', '!', 'TEXT', {
        name: 'Label', size: {x: 50, y: 20}, transform: at(10, 10), textData: {characters: 'OK'}, fontName: {family: 'Inter', style: 'Bold', postscript: ''}, fontSize: 14,
        componentPropRefs: [{defID: guid('3:1'), componentPropNodeField: 'TEXT_DATA'}],
      }),
      node('2:3', '2:1', '"', 'INSTANCE', {
        name: 'Icon', size: {x: 20, y: 20}, transform: at(70, 10), symbolData: {symbolID: guid('4:1')},
        componentPropRefs: [{defID: guid('3:2'), componentPropNodeField: 'VISIBLE'}],
      }),
      node('4:1', '0:1', '$', 'SYMBOL', {name: 'Dot', size: {x: 20, y: 20}, transform: at(200, 300)}),
      node('4:2', '4:1', '!', 'ELLIPSE', {name: 'Fill', size: {x: 20, y: 20}, transform: at(0, 0), fillPaints: [solid(1, 0, 0)]}),
      node('2:9', '0:1', '%', 'INSTANCE', {
        name: 'Save', size: {x: 140, y: 40}, transform: at(0, 400), fillPaints: [solid(0.2, 0.2, 0.9)],
        symbolData: {symbolID: guid('2:1'), symbolOverrides: [{guidPath: {guids: [guid('2:3'), guid('4:2')]}, fillPaints: [solid(0, 0, 1)]}]},
        derivedSymbolData: [{guidPath: {guids: [guid('2:3')]}, transform: at(110, 10)}],
        componentPropAssignments: [{defID: guid('3:1'), value: {textValue: {characters: 'Save'}}}],
      }),
      node('5:1', '0:2', '!', 'TEXT', {name: 'Heading', styleType: 'TEXT', fontName: {family: 'Inter', style: 'Bold', postscript: 'Inter-Bold'}, fontSize: 24, textData: {characters: 'Ag'}}),
      node('6:1', '0:1', '&', 'FRAME', {name: 'Deleted', isSoftDeleted: true, size: {x: 10, y: 10}, transform: at(0, 0)}),
    ],
  };
}

/** Sibling positions that sort in order (Figma's fractional indexes are compared as strings). */
const positionOf = (i: number) => [Math.floor(i / 8100), Math.floor(i / 90) % 90, i % 90].map(part => String.fromCharCode(33 + part)).join('');

/**
 * A generated UI kit as a .fig (the shape of tests/helpers/figma-kit.ts `figmaKit`, Nuxt-UI-like): a page per component, each with
 * a component set of variants (a label and parts) and documentation frames of instances of them (`borrow`: of the previous page's
 * variants), and picture fills on a "Cover" page. Instances are listed without their insides, as Figma saves them: the reader copies
 * those from the main. `layers` counts what the reader makes of it (the pages not counted).
 */
export function figKit(shape: {pages: number; variants: number; layersPerVariant: number; docFrames: number; instancesPerFrame: number; pictures: number; borrow?: boolean}) {
  const changes: Value[] = [node('0:0', null, '', 'DOCUMENT', {name: 'Document'}), node('0:1', '0:0', positionOf(0), 'CANVAS', {name: 'Cover'})];
  const images: Record<string, Uint8Array> = {};
  let next = 10;
  const id = () => `1:${next++}`;
  const font = {family: 'Inter', style: 'Medium', postscript: 'Inter-Medium'};
  for (let k = 0; k < shape.pictures; k++) {
    const hash = Uint8Array.from({length: 20}, (_, i) => (i === 19 ? k : 0xbb));
    images[Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')] = TINY_PNG;
    changes.push(node(id(), '0:1', positionOf(k), 'RECTANGLE', {
      name: `Picture ${k}`, size: {x: 400, y: 300}, transform: at(k * 420, 0),
      fillPaints: [{type: 'IMAGE', opacity: 1, visible: true, image: {hash, name: `picture ${k}`}, imageScaleMode: 'FILL', transform: at(0, 0)}],
    }));
  }
  let layers = shape.pictures;
  let previous: string[] = [];
  for (let p = 0; p < shape.pages; p++) {
    const pageId = `0:${p + 2}`;
    changes.push(node(pageId, '0:0', positionOf(p + 1), 'CANVAS', {name: `Component ${p}`}));
    const setId = id();
    changes.push(node(setId, pageId, positionOf(0), 'FRAME', {name: `Component ${p}`, isStateGroup: true, size: {x: 1200, y: Math.ceil(shape.variants / 10) * 48}, transform: at(0, 0)}));
    const variants: string[] = [];
    for (let v = 0; v < shape.variants; v++) {
      const variantId = id();
      variants.push(variantId);
      changes.push(node(variantId, setId, positionOf(v), 'SYMBOL', {
        name: `color=${v % 8}, size=${v % 5}, state=${v % 3}`, size: {x: 100, y: 36}, transform: at((v % 10) * 120, Math.floor(v / 10) * 48), fillPaints: [solid(0.2, 0.4, 0.9)],
      }));
      changes.push(node(id(), variantId, positionOf(0), 'TEXT', {name: 'Label', size: {x: 60, y: 20}, transform: at(12, 8), textData: {characters: 'Button'}, fontName: font, fontSize: 14}));
      for (let k = 1; k < shape.layersPerVariant - 1; k++)
        changes.push(node(id(), variantId, positionOf(k), 'RECTANGLE', {name: `Part ${k}`, size: {x: 16, y: 16}, transform: at(4 * k, 4), fillPaints: [solid(0.2, 0.4, 0.9)]}));
    }
    for (let f = 0; f < shape.docFrames; f++) {
      const frameId = id();
      changes.push(node(frameId, pageId, positionOf(f + 1), 'FRAME', {name: `Examples ${f}`, size: {x: 640, y: 560}, transform: at(0, 2000 + f * 600)}));
      for (let k = 0; k < shape.instancesPerFrame; k++) {
        const source = shape.borrow && previous.length ? previous : variants;
        const main = source[(f * shape.instancesPerFrame + k) % source.length];
        changes.push(node(id(), frameId, positionOf(k), 'INSTANCE', {name: 'Button', size: {x: 100, y: 36}, transform: at((k % 5) * 120, Math.floor(k / 5) * 48), symbolData: {symbolID: guid(main)}}));
      }
    }
    // The set, its variants with their insides, the frames, and each instance with the copy of its main's insides.
    layers += 1 + shape.variants * shape.layersPerVariant + shape.docFrames * (1 + shape.instancesPerFrame * shape.layersPerVariant);
    previous = variants;
  }
  return {zip: figZip({type: 'NODE_CHANGES', blobs: [], nodeChanges: changes}, images), layers};
}
