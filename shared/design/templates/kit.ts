import type {
  ArcData, BlendMode, Constraints, DesignDocument, Effect, LayoutGrid, NodeId, NodeType, Paint, Reaction, RGB, RGBA, SceneNode, StrokeAlign,
  StrokeCap, StrokeJoin, Style, StyleId, TextCase, TextDecoration, TextProps, TextStyle, Variable, VariableCollection, VariableId, VariableValue,
  WindingRule,
} from '../types';
import {DESIGN_SCHEMA_VERSION} from '../types';
import {createNode, defaultAutoLayout, defaultTextProps, newId} from '../defaults';
import {normalizeDocument} from '../normalize';
import type {TextMeasurer} from '../text-layout';
import {parsePathData, transformPath} from '../paths';
import {
  addComponentProperty, bindProperty, createComponent, createInstance, propertyDefinitionsOf, propertyName, setInstanceProperty, withOverrideTracking,
  type DesignEdit,
} from '../components';
import {arrangeVariants, combineAsVariants} from '../variants';
import type {Marketplace} from '../marketplace/specs';

// The small vocabulary the starter templates are written in (shared/design/templates). A builder owns one
// document while it is made: nodes are added with `createNode` defaults, auto layout and sizing are
// spelled the way the design panel shows them ("Hug contents", "Fill container"), and components, variants,
// properties, instances and overrides go through the same operations the editor uses
// (shared/design/components.ts, variants.ts), so a template file is exactly what a designer could
// have built by hand. `finish` normalizes the whole file with the given measurer.

// ── Colours ──────────────────────────────────────────────────────────────────────────────────────

/** '#RRGGBB' → 0..1 channels. */
export function hex(value: string): RGB {
  const clean = value.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
  return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
}
export const hexa = (value: string, a = 1): RGBA => ({...hex(value), a});

/** A colour as a design token: its value, and the colour style or variable it stands for. */
export type ColorToken = {hex: string; opacity?: number; style?: StyleId; variable?: VariableId};
export type Ink = string | ColorToken | Paint;

const isPaint = (ink: Ink): ink is Paint => typeof ink === 'object' && 'type' in ink;

export function paintOf(ink: Ink): Paint {
  if (isPaint(ink)) return ink;
  const token = typeof ink === 'string' ? {hex: ink} : ink;
  const paint: Paint = {type: 'SOLID', color: hex(token.hex), opacity: token.opacity ?? 1, visible: true, blendMode: 'NORMAL'};
  if (token.variable) paint.boundVariables = {color: {type: 'VARIABLE_ALIAS', id: token.variable}};
  return paint;
}
const styleOf = (ink: Ink | undefined): StyleId | undefined => (ink && typeof ink === 'object' && !isPaint(ink) ? ink.style : undefined);

/** A linear gradient from `angle` degrees (0 = left to right, 90 = top to bottom). */
export function linear(stops: [string, number?][], angle = 90): Paint {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians) / 2, dy = Math.sin(radians) / 2;
  return {
    type: 'GRADIENT_LINEAR', opacity: 1, visible: true, blendMode: 'NORMAL',
    gradientStops: stops.map(([color, alpha = 1], i) => ({position: stops.length > 1 ? i / (stops.length - 1) : 0, color: hexa(color, alpha)})),
    gradientHandlePositions: [{x: 0.5 - dx, y: 0.5 - dy}, {x: 0.5 + dx, y: 0.5 + dy}, {x: 0.5 - dy, y: 0.5 + dx}],
  };
}
export function radial(stops: [string, number?][], center = {x: 0.5, y: 0.5}, radius = 0.5): Paint {
  return {
    type: 'GRADIENT_RADIAL', opacity: 1, visible: true, blendMode: 'NORMAL',
    gradientStops: stops.map(([color, alpha = 1], i) => ({position: stops.length > 1 ? i / (stops.length - 1) : 0, color: hexa(color, alpha)})),
    gradientHandlePositions: [center, {x: center.x + radius, y: center.y}, {x: center.x, y: center.y + radius}],
  };
}

export const shadow = (y: number, blur: number, alpha: number, spread = 0, color = '#0F1115'): Effect =>
  ({type: 'DROP_SHADOW', color: hexa(color, alpha), offset: {x: 0, y}, radius: blur, spread, visible: true, blendMode: 'NORMAL'});

export function columns(count: number, gutter: number, margin: number, color = '#FF3B30', alpha = 0.08): LayoutGrid {
  return {pattern: 'COLUMNS', alignment: 'STRETCH', count, gutterSize: gutter, offset: margin, sectionSize: 0, visible: true, color: hexa(color, alpha)};
}

// ── Type ─────────────────────────────────────────────────────────────────────────────────────────

/** One step of a type scale: family, weight, size, line height in px, tracking in %. */
export type Font = {family: string; weight: number; size: number; line: number; tracking?: number; case?: TextCase; italic?: boolean; style?: StyleId};

export const textStyleOf = (font: Font): TextStyle => ({
  fontFamily: font.family,
  fontWeight: font.weight,
  italic: font.italic ?? false,
  fontSize: font.size,
  lineHeight: {unit: 'PIXELS', value: font.line},
  letterSpacing: {unit: 'PERCENT', value: font.tracking ?? 0},
  textDecoration: 'NONE',
  textCase: font.case ?? 'ORIGINAL',
});

// ── Boxes ────────────────────────────────────────────────────────────────────────────────────────

/** A size on one axis: px (fixed), "Hug contents" or "Fill container". */
export type Size = number | 'hug' | 'fill';

export type Box = {
  name?: string;
  x?: number;
  y?: number;
  w?: Size;
  h?: Size;
  minW?: number;
  maxW?: number;
  fill?: Ink | Ink[] | null;
  stroke?: Ink | null;
  strokeWeight?: number;
  strokeAlign?: StrokeAlign;
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  dash?: number[];
  radius?: number | [number, number, number, number];
  smoothing?: number;
  /** Auto layout direction. */
  layout?: 'row' | 'col';
  wrap?: boolean;
  /** Gap between items; 'auto' spreads them ("Auto", space between). */
  gap?: number | 'auto';
  rowGap?: number;
  /** All sides, [vertical, horizontal] or [top, right, bottom, left]. */
  pad?: number | [number, number] | [number, number, number, number];
  main?: 'start' | 'center' | 'end';
  cross?: 'start' | 'center' | 'end' | 'baseline';
  clip?: boolean;
  effects?: Effect[];
  effectStyle?: StyleId;
  opacity?: number;
  /** Placed by constraints inside an auto-layout parent instead of the flow. */
  absolute?: boolean;
  constraints?: Partial<Constraints>;
  grids?: LayoutGrid[];
  visible?: boolean;
  rotation?: number;
  blend?: BlendMode;
};

export type TextBox = Omit<Box, 'fill' | 'layout'> & {
  color?: Ink;
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  valign?: 'TOP' | 'CENTER' | 'BOTTOM';
  /** Lines before the ellipsis. */
  maxLines?: number;
  paragraphSpacing?: number;
  /** Extra styled ranges: [start, end, font changes, colour]. */
  runs?: {start: number; end: number; font?: Partial<Font>; color?: Ink; decoration?: TextDecoration}[];
};

export type VectorBox = Box & {
  /** The box the path data is drawn in (24 for 24-unit icons, or [width, height]); scaled to w×h. */
  viewBox?: number | [number, number];
  windingRule?: WindingRule;
};

const sides = (pad: Box['pad']): [number, number, number, number] => {
  if (pad === undefined) return [0, 0, 0, 0];
  if (typeof pad === 'number') return [pad, pad, pad, pad];
  return pad.length === 2 ? [pad[0], pad[1], pad[0], pad[1]] : pad;
};
const ALIGN = {start: 'MIN', center: 'CENTER', end: 'MAX'} as const;
const sizing = (size: Size | undefined, fallback: 'FIXED' | 'HUG') => (size === 'fill' ? 'FILL' : size === 'hug' ? 'HUG' : typeof size === 'number' ? 'FIXED' : fallback);
const inks = (value: Ink | Ink[] | null | undefined): Ink[] => (value == null ? [] : Array.isArray(value) ? value : [value]);

/** The node fields a box spells. */
function boxFields(box: Box, type: NodeType): Partial<SceneNode> {
  const out: Partial<SceneNode> = {};
  if (box.name !== undefined) out.name = box.name;
  if (box.x !== undefined) out.x = box.x;
  if (box.y !== undefined) out.y = box.y;
  if (typeof box.w === 'number') out.width = box.w;
  if (typeof box.h === 'number') out.height = box.h;
  if (box.minW !== undefined) out.minWidth = box.minW;
  if (box.maxW !== undefined) out.maxWidth = box.maxW;
  if (box.fill !== undefined) {
    const list = inks(box.fill);
    out.fills = list.map(paintOf);
    const style = list.length === 1 ? styleOf(list[0]) : undefined;
    if (style) out.fillStyleId = style;
  }
  if (box.stroke !== undefined) {
    out.strokes = inks(box.stroke).map(paintOf);
    const style = box.stroke ? styleOf(box.stroke) : undefined;
    if (style) out.strokeStyleId = style;
  }
  if (box.strokeWeight !== undefined) out.strokeWeight = box.strokeWeight;
  if (box.strokeAlign !== undefined) out.strokeAlign = box.strokeAlign;
  if (box.strokeCap !== undefined) out.strokeCap = box.strokeCap;
  if (box.strokeJoin !== undefined) out.strokeJoin = box.strokeJoin;
  if (box.dash !== undefined) out.dashPattern = box.dash;
  if (box.radius !== undefined) {
    if (typeof box.radius === 'number') out.cornerRadius = box.radius;
    else {
      out.cornerRadius = box.radius[0];
      out.rectangleCornerRadii = box.radius;
    }
  }
  if (box.smoothing !== undefined) out.cornerSmoothing = box.smoothing;
  if (box.effects !== undefined) out.effects = box.effects;
  if (box.effectStyle !== undefined) out.effectStyleId = box.effectStyle;
  if (box.opacity !== undefined) out.opacity = box.opacity;
  if (box.visible !== undefined) out.visible = box.visible;
  if (box.rotation !== undefined) out.rotation = box.rotation;
  if (box.blend !== undefined) out.blendMode = box.blend;
  if (box.clip !== undefined) out.clipsContent = box.clip;
  if (box.grids !== undefined) out.layoutGrids = box.grids;
  if (box.absolute) out.layoutPositioning = 'ABSOLUTE';
  if (box.constraints) out.constraints = {horizontal: box.constraints.horizontal ?? 'MIN', vertical: box.constraints.vertical ?? 'MIN'};
  const flow = type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE';
  if (box.layout && flow) {
    const [top, right, bottom, left] = sides(box.pad);
    out.autoLayout = {
      ...defaultAutoLayout(box.layout === 'row' ? 'HORIZONTAL' : 'VERTICAL'),
      layoutWrap: box.wrap ? 'WRAP' : 'NO_WRAP',
      paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left,
      itemSpacing: typeof box.gap === 'number' ? box.gap : 0,
      counterAxisSpacing: box.rowGap ?? (typeof box.gap === 'number' ? box.gap : 0),
      primaryAxisAlignItems: box.gap === 'auto' ? 'SPACE_BETWEEN' : ALIGN[box.main ?? 'start'],
      counterAxisAlignItems: box.cross === 'baseline' ? 'BASELINE' : ALIGN[box.cross ?? 'start'],
    };
  }
  out.layoutSizingHorizontal = sizing(box.w, box.layout && flow ? 'HUG' : 'FIXED');
  out.layoutSizingVertical = sizing(box.h, box.layout && flow ? 'HUG' : 'FIXED');
  return out;
}

// ── The builder ──────────────────────────────────────────────────────────────────────────────────

export type BuildOptions = {
  /** Measures text while the file is laid out: the editor's font registry, or a fake in tests. */
  measurer: TextMeasurer;
  /** Ids of new nodes, styles and variables (default: random, as the editor makes them). */
  newId?: () => string;
  /** "Marketplace card" (marketplace.ts): for which marketplace, one card or the six slides. Default: one WB card. */
  marketplaceCard?: {marketplace: Marketplace; set: 'single' | 'kit'};
};

export class TemplateBuilder {
  doc: DesignDocument;
  readonly measurer: TextMeasurer;
  readonly id: () => string;

  constructor(options: BuildOptions) {
    this.measurer = options.measurer;
    this.id = options.newId ?? newId;
    this.doc = {schemaVersion: DESIGN_SCHEMA_VERSION, pages: [], nodes: {}, styles: {}, images: {}, variableCollections: {}, variables: {}};
  }

  // Low level: the builder replaces node objects (never mutates them), and owns its nodes map.
  private adopt(result: DesignEdit | {doc: DesignDocument}) {
    this.doc = {...result.doc, nodes: {...result.doc.nodes}};
  }

  node(id: NodeId): SceneNode {
    const node = this.doc.nodes[id];
    if (!node) throw Error(`template: no node ${id}`);
    return node;
  }

  update(id: NodeId, partial: Partial<SceneNode>) {
    this.doc.nodes[id] = {...this.node(id), ...partial};
  }

  /** The first descendant of `rootId` (depth first, top layers first) that matches. */
  find(rootId: NodeId, match: (node: SceneNode) => boolean): NodeId {
    const stack = [...(this.node(rootId).children ?? [])].reverse();
    while (stack.length) {
      const node = this.doc.nodes[stack.shift()!];
      if (!node) continue;
      if (match(node)) return node.id;
      stack.unshift(...[...(node.children ?? [])].reverse());
    }
    throw Error(`template: nothing matches under ${rootId}`);
  }

  /** The first descendant named `name`. */
  named(rootId: NodeId, name: string): NodeId {
    return this.find(rootId, node => node.name === name);
  }

  /** Adds a node made elsewhere (a slide kit's) under `parentId`, as the editor's `tx.create` does: a container starts empty and
   *  its children are adopted after it. */
  insertNode(node: SceneNode, parentId: NodeId): NodeId {
    return this.insert({...node, parentId, ...(node.children ? {children: []} : {})}, parentId);
  }

  private insert(node: SceneNode, parentId: NodeId | null) {
    this.doc.nodes[node.id] = node;
    if (parentId) {
      const parent = this.node(parentId);
      this.doc.nodes[parentId] = {...parent, children: [...(parent.children ?? []), node.id]};
    }
    return node.id;
  }

  page(name: string, background = '#F5F5F5'): NodeId {
    const id = this.id();
    this.doc = {...this.doc, pages: [...this.doc.pages, id]};
    return this.insert(createNode('PAGE', {id, name, backgroundColor: hex(background)}), null);
  }

  add(type: NodeType, parentId: NodeId, box: Box = {}, extra: Partial<SceneNode> = {}): NodeId {
    const id = this.id();
    return this.insert(createNode(type, {id, parentId, ...boxFields(box, type), ...extra}), parentId);
  }

  /** A frame; with `layout` an auto-layout frame that hugs its content unless sized. */
  frame(parentId: NodeId, box: Box = {}): NodeId {
    return this.add('FRAME', parentId, {fill: null, clip: false, ...box});
  }

  rect(parentId: NodeId, box: Box = {}): NodeId {
    return this.add('RECTANGLE', parentId, box);
  }

  ellipse(parentId: NodeId, box: Box & {arc?: ArcData} = {}): NodeId {
    const {arc, ...rest} = box;
    return this.add('ELLIPSE', parentId, rest, arc ? {arcData: arc} : {});
  }

  /** A path (SVG path data in a `viewBox`-unit square, default the box size) scaled into the box. */
  vector(parentId: NodeId, data: string | readonly string[], box: VectorBox = {}): NodeId {
    const {viewBox, windingRule = 'NONZERO', ...rest} = box;
    const width = typeof rest.w === 'number' ? rest.w : 24, height = typeof rest.h === 'number' ? rest.h : width;
    const [vw, vh] = viewBox === undefined ? [width, height] : typeof viewBox === 'number' ? [viewBox, viewBox] : viewBox;
    const scale = width / vw, scaleY = height / vh;
    const paths = (typeof data === 'string' ? [data] : data).map(d => ({
      windingRule,
      commands: transformPath(parsePathData(d), [[scale, 0, 0], [0, scaleY, 0]]),
    }));
    return this.add('VECTOR', parentId, {fill: null, strokeAlign: 'CENTER', ...rest, w: width, h: height}, {vectorPaths: paths});
  }

  text(parentId: NodeId, characters: string, font: Font, box: TextBox = {}): NodeId {
    const {color = '#0F1115', align = 'LEFT', valign = 'TOP', maxLines, paragraphSpacing = 0, runs = [], ...rest} = box;
    const fixedWidth = typeof rest.w === 'number';
    const textAutoResize: TextProps['textAutoResize'] = maxLines ? 'TRUNCATE' : rest.w === 'fill' || fixedWidth ? 'HEIGHT' : 'WIDTH_AND_HEIGHT';
    const text: TextProps = {
      ...defaultTextProps(characters),
      style: textStyleOf(font),
      textAlignHorizontal: align,
      textAlignVertical: valign,
      textAutoResize,
      paragraphSpacing,
      runs: runs.map(run => ({
        start: run.start,
        end: run.end,
        style: {...(run.font ? styleChanges(run.font) : {}), ...(run.decoration ? {textDecoration: run.decoration} : {})},
        ...(run.color ? {fills: [paintOf(run.color)]} : {}),
      })),
      ...(maxLines ? {maxLines} : {}),
    };
    const fields = boxFields({...rest, fill: color}, 'TEXT');
    // Text sizes itself: auto width hugs, a set or filled width wraps and hugs its height.
    fields.layoutSizingHorizontal = rest.w === 'fill' ? 'FILL' : fixedWidth ? 'FIXED' : 'HUG';
    fields.layoutSizingVertical = maxLines ? 'FIXED' : 'HUG';
    if (maxLines) fields.height = font.line * maxLines;
    // A step of the scale changed on the spot ({...t.body, weight: 700}) no longer matches its style.
    const style = font.style ? this.doc.styles[font.style]?.text : undefined;
    const styled = style && JSON.stringify(style) === JSON.stringify(text.style) ? {textStyleId: font.style} : {};
    return this.add('TEXT', parentId, {}, {...fields, name: box.name ?? characters.split('\n')[0].slice(0, 60), text, ...styled});
  }

  // ── Styles and variables ──

  colorStyle(name: string, value: string, description = ''): ColorToken {
    const id = this.id();
    const style: Style = {id, type: 'FILL', name, description, paints: [paintOf(value)]};
    this.doc = {...this.doc, styles: {...this.doc.styles, [id]: style}};
    return {hex: value, style: id};
  }

  textStyle(name: string, font: Font, description = ''): Font {
    const id = this.id();
    const style: Style = {id, type: 'TEXT', name, description, text: textStyleOf(font)};
    this.doc = {...this.doc, styles: {...this.doc.styles, [id]: style}};
    return {...font, style: id};
  }

  effectStyle(name: string, effects: Effect[], description = ''): StyleId {
    const id = this.id();
    this.doc = {...this.doc, styles: {...this.doc.styles, [id]: {id, type: 'EFFECT', name, description, effects}}};
    return id;
  }

  gridStyle(name: string, grids: LayoutGrid[], description = ''): StyleId {
    const id = this.id();
    this.doc = {...this.doc, styles: {...this.doc.styles, [id]: {id, type: 'GRID', name, description, grids}}};
    return id;
  }

  /** A variable collection with named modes; the first is the default. Returns the collection and mode ids. */
  collection(name: string, modeNames: string[]): {id: string; modes: string[]} {
    const id = this.id();
    const modes = modeNames.map(() => this.id());
    const collection: VariableCollection = {id, name, modes: modes.map((modeId, i) => ({modeId, name: modeNames[i]})), defaultModeId: modes[0], variableIds: []};
    this.doc = {...this.doc, variableCollections: {...this.doc.variableCollections, [id]: collection}};
    return {id, modes};
  }

  /** A colour variable: one hex per mode, in the collection's mode order. The token resolves to the first. */
  colorVariable(collection: {id: string; modes: string[]}, name: string, values: string[], description = ''): ColorToken {
    const id = this.id();
    const valuesByMode: Record<string, VariableValue> = {};
    collection.modes.forEach((modeId, i) => {valuesByMode[modeId] = hexa(values[i] ?? values[0]);});
    const variable: Variable = {id, name, collectionId: collection.id, type: 'COLOR', valuesByMode, description};
    const owner = this.doc.variableCollections[collection.id];
    this.doc = {
      ...this.doc,
      variables: {...this.doc.variables, [id]: variable},
      variableCollections: {...this.doc.variableCollections, [collection.id]: {...owner, variableIds: [...owner.variableIds, id]}},
    };
    return {hex: values[0], variable: id};
  }

  numberVariable(collection: {id: string; modes: string[]}, name: string, values: number[]): VariableId {
    const id = this.id();
    const valuesByMode: Record<string, VariableValue> = {};
    collection.modes.forEach((modeId, i) => {valuesByMode[modeId] = values[i] ?? values[0];});
    const owner = this.doc.variableCollections[collection.id];
    this.doc = {
      ...this.doc,
      variables: {...this.doc.variables, [id]: {id, name, collectionId: collection.id, type: 'FLOAT', valuesByMode, description: ''}},
      variableCollections: {...this.doc.variableCollections, [collection.id]: {...owner, variableIds: [...owner.variableIds, id]}},
    };
    return id;
  }

  /** The frame (and what it contains) shows `modeId` of the collection (a frame's "Variable mode"). */
  setMode(nodeId: NodeId, collectionId: string, modeId: string) {
    this.doc = {...this.doc, variableModes: {...(this.doc.variableModes ?? {}), [nodeId]: {...(this.doc.variableModes?.[nodeId] ?? {}), [collectionId]: modeId}}};
  }

  // ── Components ──

  /** Turns a frame into a main component (in place). */
  component(frameId: NodeId, description = ''): NodeId {
    this.adopt(createComponent(this.doc, [frameId], this.id));
    if (description) this.update(frameId, {description});
    return frameId;
  }

  /** Combines components named "Set/Property=Value, …" into a set; values keep the components' order
   *  left to right (lay them out in that order first). */
  variants(componentIds: NodeId[], description = ''): NodeId {
    const id = this.id();
    this.adopt(combineAsVariants(this.doc, componentIds, id));
    if (description) this.update(id, {description});
    return id;
  }

  /** Re-grids a set after its variants were laid out. */
  arrange(setId: NodeId) {
    this.adopt(arrangeVariants(this.doc, setId));
  }

  /** A BOOLEAN, TEXT or INSTANCE_SWAP (a component id) property on a component (or a set, through any of its variants);
   *  returns its key. */
  property(componentId: NodeId, name: string, type: 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP', defaultValue: string | boolean): string {
    const result = addComponentProperty(this.doc, componentId, {name, type, defaultValue});
    this.adopt(result);
    return result.key;
  }

  /** Lets a property drive a layer inside the component: visible ↔ BOOLEAN, characters ↔ TEXT, an instance's main
   *  component ↔ INSTANCE_SWAP. */
  bind(nodeId: NodeId, field: 'visible' | 'characters' | 'mainComponent', key: string) {
    this.adopt(bindProperty(this.doc, nodeId, field, key));
  }

  /** The key of a component's property by its name ("Text" → "Text#3"). */
  keyOf(componentId: NodeId, name: string): string {
    const key = Object.keys(propertyDefinitionsOf(this.doc, componentId)).find(entry => propertyName(entry) === name);
    if (!key) throw Error(`template: no property ${name}`);
    return key;
  }

  /** Places an instance (a set gives its default variant), then its placement and property values. */
  instance(parentId: NodeId, componentId: NodeId, box: Box = {}, props: Record<string, string | boolean> = {}): NodeId {
    const created = createInstance(this.doc, componentId, {parentId, newId: this.id});
    this.adopt(created);
    const id = created.id;
    this.place(id, box);
    this.props(id, props);
    return id;
  }

  /** Placement and size of an instance or copy, recorded as overrides where the editor would record them. */
  place(id: NodeId, box: Box) {
    const node = this.node(id);
    const fields: Partial<SceneNode> = {};
    if (box.name !== undefined) fields.name = box.name;
    if (box.x !== undefined) fields.x = box.x;
    if (box.y !== undefined) fields.y = box.y;
    if (typeof box.w === 'number') fields.width = box.w;
    if (typeof box.h === 'number') fields.height = box.h;
    if (box.w !== undefined) fields.layoutSizingHorizontal = sizing(box.w, 'FIXED');
    if (box.h !== undefined) fields.layoutSizingVertical = sizing(box.h, 'FIXED');
    if (box.absolute) fields.layoutPositioning = 'ABSOLUTE';
    if (box.constraints) fields.constraints = {horizontal: box.constraints.horizontal ?? 'MIN', vertical: box.constraints.vertical ?? 'MIN'};
    if (box.visible !== undefined) fields.visible = box.visible;
    if (box.effects !== undefined) fields.effects = box.effects;
    if (!Object.keys(fields).length) return;
    this.update(id, withOverrideTracking(this.doc, id, fields));
    void node;
  }

  /** Property values of an instance or a nested instance, by property name. */
  props(instanceId: NodeId, values: Record<string, string | boolean>) {
    for (const [name, value] of Object.entries(values)) {
      const componentId = this.node(instanceId).componentId!;
      this.adopt(setInstanceProperty(this.doc, instanceId, this.keyOf(componentId, name), value));
    }
  }

  /** Changes a copy inside an instance the way the editor does: the fields become its overrides. */
  override(copyId: NodeId, partial: Partial<SceneNode>) {
    this.update(copyId, withOverrideTracking(this.doc, copyId, partial));
  }

  /** The text of a copy changed in place (an override of `text.characters`). */
  overrideText(copyId: NodeId, characters: string) {
    const node = this.node(copyId);
    this.override(copyId, {text: {...node.text!, characters, runs: []}});
  }

  // ── Prototype ──

  /** A flow's starting point on a page: "Flows" lists it and ▶ starts the player there. */
  flow(pageId: NodeId, frameId: NodeId, name: string) {
    this.update(pageId, {flowStartingPoints: [...(this.node(pageId).flowStartingPoints ?? []), {nodeId: frameId, name}]});
  }

  /** The device the player shows the page's frames in (a DEVICE_PRESETS id). */
  device(pageId: NodeId, presetId: string) {
    this.update(pageId, {prototypeDevice: {type: 'PRESET', presetId, rotation: 0}});
  }

  /** An interaction on a layer; on a copy inside an instance it is that copy's override, as the "Prototype" tab records it. */
  react(id: NodeId, reaction: Reaction) {
    this.override(id, {reactions: [...this.node(id).reactions, reaction]});
  }

  // ── Finishing ──

  /** Lays the whole file out: text sizes, instances, variables, auto layout, groups. */
  normalize() {
    this.adopt({doc: normalizeDocument(this.doc, new Set(Object.keys(this.doc.nodes)), {measurer: this.measurer})});
  }

  /** Puts top-level layers of a page in a row (or column) by their laid-out sizes. */
  arrangeOnPage(ids: NodeId[], options: {x?: number; y?: number; gap?: number; direction?: 'row' | 'col'} = {}) {
    let at = options.direction === 'col' ? options.y ?? 0 : options.x ?? 0;
    for (const id of ids) {
      const node = this.node(id);
      if (options.direction === 'col') {
        this.update(id, {x: options.x ?? 0, y: at});
        at += node.height + (options.gap ?? 80);
      } else {
        this.update(id, {x: at, y: options.y ?? 0});
        at += node.width + (options.gap ?? 80);
      }
    }
  }

  finish(): DesignDocument {
    this.normalize();
    // A second pass settles what the first one could only see after layout (instances of laid-out mains).
    this.normalize();
    return this.doc;
  }
}

/** The style fields a run changes. */
function styleChanges(font: Partial<Font>): Partial<TextStyle> {
  const out: Partial<TextStyle> = {};
  if (font.family !== undefined) out.fontFamily = font.family;
  if (font.weight !== undefined) out.fontWeight = font.weight;
  if (font.size !== undefined) out.fontSize = font.size;
  if (font.line !== undefined) out.lineHeight = {unit: 'PIXELS', value: font.line};
  if (font.tracking !== undefined) out.letterSpacing = {unit: 'PERCENT', value: font.tracking};
  if (font.italic !== undefined) out.italic = font.italic;
  if (font.case !== undefined) out.textCase = font.case;
  return out;
}
