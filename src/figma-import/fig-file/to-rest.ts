import type {FigmaFile, FigmaNode} from '../../../shared/design/figma-import';
import type {FigmaComponentMeta, FigmaEffect, FigmaInteraction, FigmaPaint, FigmaPath, FigmaStyleMeta, FigmaTransform, FigmaTypeStyle} from '../../../shared/design/figma-import/rest-types';

// A .fig document (Figma's own node changes) → the JSON Figma's REST API gives for the same file
// (GET /v1/files/:key?geometry=paths), so the importer that already reads REST answers
// (shared/design/figma-import) maps .fig files too. What differs from REST and is settled here:
//
// • The tree comes flat: each node names its parent and a fractional position among its siblings.
// • Groups are frames with `resizeToFit`, component sets frames with `isStateGroup`, components SYMBOL.
// • Transforms are relative to the direct parent; REST places children of groups and boolean
//   operations in the space of the nearest frame above them.
// • An instance holds no children: it names its main (symbolData) and lists overrides and Figma's
//   precomputed layout (derivedSymbolData) by guid path. Its children are copied from the main here,
//   with REST's ids ("I<instance>;<node in main>"), and nested instances expand the same way.
// • Shared styles are nodes on a hidden page and win over the values cached on the layer.
// • Paths are binary blobs, pictures are named by the hex of their hash.
//
// The node changes are untrusted input; the importer checks every value it reads, so nothing here
// validates beyond keeping the walk bounded.

// The decoded kiwi message has no static type: this module reads it field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fig = Record<string, any>;
type Matrix = [[number, number, number], [number, number, number]];

/** Nodes a file may expand to (REST gives the same copies; the importer has its own caps after this). */
export const MAX_FIG_NODES = 2_000_000;
const MAX_INSTANCE_DEPTH = 40;

const IDENTITY: Matrix = [[1, 0, 0], [0, 1, 0]];
const GROUP_LIKE = new Set(['GROUP', 'BOOLEAN_OPERATION']);
const NOT_LAYERS = new Set(['DOCUMENT', 'CANVAS', 'VARIABLE_SET', 'VARIABLE', 'VARIABLE_OVERRIDE', 'CODE_LIBRARY', 'CODE_FILE', 'CODE_COMPONENT', 'CODE_INSTANCE', 'RESPONSIVE_SET', 'ASSISTED_LAYOUT', 'MODULE']);
const TYPES: Record<string, string> = {SYMBOL: 'COMPONENT', ROUNDED_RECTANGLE: 'RECTANGLE', BRUSH: 'VECTOR'};
const H_CONSTRAINTS: Record<string, string> = {MIN: 'LEFT', MAX: 'RIGHT', CENTER: 'CENTER', STRETCH: 'LEFT_RIGHT', SCALE: 'SCALE'};
const V_CONSTRAINTS: Record<string, string> = {MIN: 'TOP', MAX: 'BOTTOM', CENTER: 'CENTER', STRETCH: 'TOP_BOTTOM', SCALE: 'SCALE'};
const EFFECTS: Record<string, string> = {FOREGROUND_BLUR: 'LAYER_BLUR'};
const PROPERTY_TYPES: Record<string, string> = {BOOL: 'BOOLEAN', TEXT: 'TEXT', INSTANCE_SWAP: 'INSTANCE_SWAP', VARIANT: 'VARIANT'};
const EASINGS: Record<string, string> = {
  LINEAR: 'LINEAR', IN_CUBIC: 'EASE_IN', OUT_CUBIC: 'EASE_OUT', INOUT_CUBIC: 'EASE_IN_AND_OUT', IN_BACK_CUBIC: 'EASE_IN_BACK', OUT_BACK_CUBIC: 'EASE_OUT_BACK',
  GENTLE_SPRING: 'GENTLE', SPRING_PRESET_ONE: 'GENTLE', SPRING_PRESET_TWO: 'QUICK', SPRING_PRESET_THREE: 'BOUNCY', SLOW_SPRING: 'SLOW',
};
const MOVES: Record<string, [string, string]> = {
  MOVE_FROM_LEFT: ['MOVE_IN', 'RIGHT'], MOVE_FROM_RIGHT: ['MOVE_IN', 'LEFT'], MOVE_FROM_TOP: ['MOVE_IN', 'BOTTOM'], MOVE_FROM_BOTTOM: ['MOVE_IN', 'TOP'],
  PUSH_FROM_LEFT: ['PUSH', 'RIGHT'], PUSH_FROM_RIGHT: ['PUSH', 'LEFT'], PUSH_FROM_TOP: ['PUSH', 'BOTTOM'], PUSH_FROM_BOTTOM: ['PUSH', 'TOP'],
  MOVE_OUT_TO_LEFT: ['MOVE_OUT', 'LEFT'], MOVE_OUT_TO_RIGHT: ['MOVE_OUT', 'RIGHT'], MOVE_OUT_TO_TOP: ['MOVE_OUT', 'TOP'], MOVE_OUT_TO_BOTTOM: ['MOVE_OUT', 'BOTTOM'],
  SLIDE_FROM_LEFT: ['SLIDE_IN', 'RIGHT'], SLIDE_FROM_RIGHT: ['SLIDE_IN', 'LEFT'], SLIDE_FROM_TOP: ['SLIDE_IN', 'BOTTOM'], SLIDE_FROM_BOTTOM: ['SLIDE_IN', 'TOP'],
  SLIDE_OUT_TO_LEFT: ['SLIDE_OUT', 'LEFT'], SLIDE_OUT_TO_RIGHT: ['SLIDE_OUT', 'RIGHT'], SLIDE_OUT_TO_TOP: ['SLIDE_OUT', 'TOP'], SLIDE_OUT_TO_BOTTOM: ['SLIDE_OUT', 'BOTTOM'],
};
const NAVIGATIONS: Record<string, string> = {NAVIGATE: 'NAVIGATE', OVERLAY: 'OVERLAY', SWAP: 'SWAP', SCROLL_TO: 'SCROLL_TO', SWAP_STATE: 'CHANGE_TO'};
/** Fields of an override or a derived entry that are bookkeeping, not values of the node. */
const NOT_VALUES = new Set(['guidPath', 'overrideLevel', 'componentPropAssignments', 'guid', 'parentIndex', 'symbolData', 'derivedSymbolData', 'overrideKey']);

const isObject = (value: unknown): value is Fig => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
export const guidOf = (guid: unknown): string | undefined => (isObject(guid) && num(guid.sessionID) !== undefined && num(guid.localID) !== undefined ? `${guid.sessionID}:${guid.localID}` : undefined);
/** What overrides name a node by: a component copied in from a library keeps its nodes' guids in the library file as
 *  overrideKey, and instances' overrides use those. */
const keyOf = (fig: Fig): string => guidOf(fig.overrideKey) ?? guidOf(fig.guid)!;
export const hexOf = (bytes: unknown): string | undefined =>
  bytes instanceof Uint8Array && bytes.length ? Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') : undefined;

const matrixOf = (m: unknown): Matrix =>
  isObject(m) ? [[num(m.m00) ?? 1, num(m.m01) ?? 0, num(m.m02) ?? 0], [num(m.m10) ?? 0, num(m.m11) ?? 1, num(m.m12) ?? 0]] : IDENTITY;
const multiply = (a: Matrix, b: Matrix): Matrix => [
  [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
  [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
];
function invert(m: Matrix): Matrix | undefined {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c;
  if (!det || !Number.isFinite(det)) return undefined;
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}
const apply = (m: Matrix, x: number, y: number) => ({x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2]});
function boxOf(m: Matrix, width: number, height: number) {
  const points = [apply(m, 0, 0), apply(m, width, 0), apply(m, 0, height), apply(m, width, height)];
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
}

// ── Paths ──────────────────────────────────────────────────────────────────────────────────────

/** A path blob: a command byte (0 close, 1 move, 2 line, 3 quadratic, 4 cubic) and its float32 points. */
export function pathOf(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const counts = [0, 2, 2, 4, 6];
  const out: string[] = [];
  for (let i = 0; i < bytes.length;) {
    const command = bytes[i++];
    const count = counts[command];
    if (count === undefined || i + count * 4 > bytes.length) return out.length ? out.join(' ') : undefined;
    const values: number[] = [];
    for (let k = 0; k < count; k++, i += 4) values.push(Math.round(view.getFloat32(i, true) * 1e4) / 1e4);
    out.push('ZMLQC'[command] + values.join(' '));
  }
  return out.join(' ') || undefined;
}

// ── The document ───────────────────────────────────────────────────────────────────────────────

type Copy = {
  /** REST ids of the nodes copied here start with it: "I<top-level instance>;", then one guid per nested instance. */
  idBase: string;
  /** The override path of the nearest instance below the top-level one, with a trailing ";" ('' at the top). A path
   *  names one node per instance level (the nested instance in each main, then the node) by its key (keyOf). */
  base: string;
  /** Overrides and Figma's derived layout by guid path below the top-level instance; outer instances win. */
  overrides: Map<string, Fig>;
  derived: Map<string, Fig>;
  /** Property values of the nearest instance, by the main's property id. */
  assignments: Map<string, Fig>;
  /** Mains being expanded, to stop a component that contains itself. */
  active: Set<string>;
  depth: number;
};

type Parent = {page: Matrix; rest: Matrix; type: string; layoutMode?: string};

export class FigDocument {
  readonly byId = new Map<string, Fig>();
  private readonly children = new Map<string, Fig[]>();
  private readonly styleByKey = new Map<string, Fig>();
  /** Component property definitions by id (a variant's own and its set's). */
  private readonly propDefs = new Map<string, Fig>();
  readonly blobs: (Uint8Array | undefined)[];
  /** Pages shown in Figma (not the hidden one holding library components and styles). */
  readonly pages: Fig[] = [];
  /** Mains on the shown pages. */
  private readonly onPages = new Set<string>();
  readonly components: Record<string, FigmaComponentMeta> = {};
  readonly componentSets: Record<string, FigmaComponentMeta> = {};
  readonly styles: Record<string, FigmaStyleMeta> = {};
  readonly imageRefs = new Set<string>();
  nodes = 0;
  truncated = false;

  constructor(message: Fig) {
    const changes: Fig[] = Array.isArray(message.nodeChanges) ? message.nodeChanges : [];
    this.blobs = (Array.isArray(message.blobs) ? message.blobs : []).map(blob => (isObject(blob) && blob.bytes instanceof Uint8Array ? blob.bytes : undefined));
    for (const change of changes) {
      const id = guidOf(change?.guid);
      if (!id || change.phase === 'REMOVED') continue;
      this.byId.set(id, change);
      if (typeof change.key === 'string' && change.styleType) this.styleByKey.set(change.key, change);
      if (Array.isArray(change.componentPropDefs)) for (const def of change.componentPropDefs) {
        const defId = guidOf(def?.id);
        if (defId) this.propDefs.set(defId, def);
      }
    }
    for (const change of this.byId.values()) {
      const parent = guidOf(change.parentIndex?.guid);
      if (!parent || !this.byId.has(parent)) continue;
      let list = this.children.get(parent);
      if (!list) this.children.set(parent, (list = []));
      list.push(change);
    }
    const position = (node: Fig) => (typeof node.parentIndex?.position === 'string' ? node.parentIndex.position : '');
    for (const list of this.children.values()) list.sort((a, b) => (position(a) < position(b) ? -1 : position(a) > position(b) ? 1 : 0));
    const documentNode = [...this.byId.values()].find(node => node.type === 'DOCUMENT');
    for (const page of documentNode ? this.childrenOf(documentNode) : []) if (page.type === 'CANVAS' && !page.internalOnly) this.pages.push(page);
    const mark = (node: Fig) => {
      if (node.type === 'SYMBOL') this.onPages.add(guidOf(node.guid)!);
      if (node.type !== 'INSTANCE') for (const child of this.childrenOf(node)) mark(child);
    };
    for (const page of this.pages) mark(page);
  }

  /** Whether any layer below has a stroke that shows. */
  private stroked(node: Fig): boolean {
    return this.childrenOf(node).some(child => child.visible !== false && ((num(child.strokeWeight) ?? 0) > 0 && Array.isArray(child.strokePaints) && child.strokePaints.some((paint: Fig) => paint?.visible !== false) || this.stroked(child)));
  }

  childrenOf(node: Fig): Fig[] {
    return (this.children.get(guidOf(node.guid) ?? '') ?? []).filter(child => !child.isSoftDeleted);
  }

  /** The REST answer for the whole file. */
  toFile(name: string): FigmaFile {
    const document = {id: '0:0', children: this.pages.map(page => this.page(page))};
    return {name, document, components: this.components, componentSets: this.componentSets, styles: this.styles};
  }

  private page(page: Fig): FigmaNode {
    const id = guidOf(page.guid)!;
    const out: FigmaNode = {id, name: str(page.name) ?? 'Page', type: 'CANVAS'};
    if (isObject(page.backgroundColor)) out.backgroundColor = colorOf(page.backgroundColor, page.backgroundOpacity);
    const parent: Parent = {page: IDENTITY, rest: IDENTITY, type: 'CANVAS'};
    out.children = this.childrenOf(page).flatMap(child => this.layer(child, guidOf(child.guid)!, parent, undefined) ?? []);
    // Prototype flows start on top-level frames, in the order Figma lists them.
    const starts = this.childrenOf(page).filter(child => isObject(child.prototypeStartingPoint) && !child.isSoftDeleted);
    if (starts.length) out.flowStartingPoints = starts
      .sort((a, b) => (str(a.prototypeStartingPoint.position) ?? '') < (str(b.prototypeStartingPoint.position) ?? '') ? -1 : 1)
      .map(child => ({nodeId: guidOf(child.guid)!, name: str(child.prototypeStartingPoint.name) ?? 'Flow'}));
    return out;
  }

  // ── Layers ─────────────────────────────────────────────────────────────────────────────────

  private layer(source: Fig, id: string, parent: Parent, copy: Copy | undefined, path?: string): FigmaNode | undefined {
    if (NOT_LAYERS.has(source.type)) return undefined;
    if (++this.nodes > MAX_FIG_NODES) {
      this.truncated = true;
      return undefined;
    }
    let fig = source;
    if (copy && path !== undefined) {
      fig = {...source};
      applyProperties(fig, copy.assignments);
      const override = copy.overrides.get(path);
      if (override) for (const [key, value] of Object.entries(override)) if (!NOT_VALUES.has(key)) fig[key] = value;
      const derived = copy.derived.get(path);
      if (derived) for (const [key, value] of Object.entries(derived)) if (!NOT_VALUES.has(key)) fig[key] = value;
    }
    // Figma unites its layers' strokes too (an icon drawn as a stroked square comes out a ring); the importer would
    // rebuild it from their fills alone, a solid square. Such a union comes in as the shape Figma computed.
    const flattened = fig.type === 'BOOLEAN_OPERATION' && Array.isArray(fig.fillGeometry) && fig.fillGeometry.length > 0 && this.stroked(source);
    const type = flattened ? 'VECTOR' : typeOf(fig);
    const local = matrixOf(fig.transform);
    const pageMatrix = multiply(parent.page, local);
    // REST: relative to the nearest parent that is not a group or a boolean operation.
    const rest = GROUP_LIKE.has(parent.type) ? multiply(parent.rest, local) : local;
    const node = this.fields(fig, id, type, parent);
    node.relativeTransform = rest as FigmaTransform;
    const width = num(fig.size?.x) ?? 0, height = num(fig.size?.y) ?? 0;
    node.size = {x: width, y: height};
    node.absoluteBoundingBox = boxOf(pageMatrix, width, height);
    const here: Parent = {page: pageMatrix, rest, type, layoutMode: node.layoutMode};

    if (type === 'INSTANCE') {
      const main = guidOf(fig.overriddenSymbolID) ?? guidOf(fig.symbolData?.symbolID);
      if (main) {
        node.componentId = main;
        this.noteComponent(main);
      }
      const top = !copy;
      const inner: Copy = top
        ? {idBase: 'I' + id + ';', base: '', overrides: new Map(), derived: new Map(), assignments: new Map(), active: new Set(), depth: 0}
        : {...copy!, idBase: id + ';', base: path! + ';', assignments: new Map(), depth: copy!.depth + 1};
      const base = inner.base;
      // This instance's own lists; an outer instance's entry for the same path wins.
      for (const [list, into] of [[fig.symbolData?.symbolOverrides, inner.overrides], [source.derivedSymbolData, inner.derived]] as const) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          const guids = Array.isArray(entry?.guidPath?.guids) ? entry.guidPath.guids.map(guidOf) : [];
          if (!guids.length || guids.includes(undefined)) continue;
          const key = base + guids.join(';');
          const outer = into.get(key);
          into.set(key, outer ? {...entry, ...outer} : entry);
        }
      }
      for (const list of [source.componentPropAssignments, top ? undefined : copy!.overrides.get(path!)?.componentPropAssignments]) {
        if (Array.isArray(list)) for (const entry of list) {
          const def = guidOf(entry?.defID);
          if (def && isObject(entry.value)) inner.assignments.set(def, entry.value);
        }
      }
      const symbol = main ? this.byId.get(main) : undefined;
      if (symbol) node.componentProperties = this.propertiesOf(symbol, inner.assignments);
      if (symbol && main && !inner.active.has(main) && inner.depth < MAX_INSTANCE_DEPTH) {
        inner.active = new Set(inner.active).add(main);
        node.children = this.childrenOf(symbol).flatMap(child => this.layer(child, inner.idBase + guidOf(child.guid), here, inner, base + keyOf(child)) ?? []);
      } else node.children = [];
      return node;
    }

    const children = flattened ? [] : this.childrenOf(source);
    if (children.length || CONTAINERS.has(type)) {
      node.children = children.flatMap(child => {
        const childGuid = guidOf(child.guid)!;
        if (!copy) return this.layer(child, childGuid, here, undefined) ?? [];
        return this.layer(child, copy.idBase + childGuid, here, copy, copy.base + keyOf(child)) ?? [];
      });
    }
    if (type === 'COMPONENT' || type === 'COMPONENT_SET') this.describeComponent(fig, type, node);
    return node;
  }

  private fields(fig: Fig, id: string, type: string, parent: Parent): FigmaNode {
    const node: FigmaNode = {id, type, name: str(fig.name) ?? ''};
    if (fig.visible === false) node.visible = false;
    if (fig.locked === true) node.locked = true;
    if (num(fig.opacity) !== undefined && fig.opacity !== 1) node.opacity = fig.opacity;
    if (typeof fig.blendMode === 'string') node.blendMode = fig.blendMode;
    if (fig.mask === true) node.isMask = true;
    if (fig.maskIsOutline === true) node.isMaskOutline = true;
    if (typeof fig.maskType === 'string') node.maskType = fig.maskType;
    if (fig.proportionsConstrained === true) node.preserveRatio = true;

    const fillStyle = this.style(fig.styleIdForFill), strokeStyle = this.style(fig.styleIdForStrokeFill), effectStyle = this.style(fig.styleIdForEffect);
    node.fills = this.paints(fillStyle?.fillPaints ?? fig.fillPaints);
    node.strokes = this.paints(strokeStyle?.fillPaints ?? fig.strokePaints);
    if (num(fig.strokeWeight) !== undefined) node.strokeWeight = fig.strokeWeight;
    if (fig.borderStrokeWeightsIndependent) {
      node.individualStrokeWeights = {top: num(fig.borderTopWeight) ?? 0, right: num(fig.borderRightWeight) ?? 0, bottom: num(fig.borderBottomWeight) ?? 0, left: num(fig.borderLeftWeight) ?? 0};
    }
    if (typeof fig.strokeAlign === 'string') node.strokeAlign = fig.strokeAlign;
    if (typeof fig.strokeCap === 'string') node.strokeCap = fig.strokeCap;
    if (typeof fig.strokeJoin === 'string') node.strokeJoin = fig.strokeJoin;
    if (Array.isArray(fig.dashPattern) && fig.dashPattern.length) node.strokeDashes = fig.dashPattern.filter((value: unknown) => num(value) !== undefined);
    node.effects = effectsOf(effectStyle?.effects ?? fig.effects);
    const styles: Record<string, string> = {};
    for (const [kind, ref, found] of [['fill', fig.styleIdForFill, fillStyle], ['stroke', fig.styleIdForStrokeFill, strokeStyle], ['effect', fig.styleIdForEffect, effectStyle], ['grid', fig.styleIdForGrid, this.style(fig.styleIdForGrid)], ['text', fig.styleIdForText, this.style(fig.styleIdForText)]] as const) {
      const styleId = found ? this.noteStyle(found, ref) : undefined;
      if (styleId) styles[kind] = styleId;
    }
    if (Object.keys(styles).length) node.styles = styles;

    if (num(fig.cornerRadius) !== undefined) node.cornerRadius = fig.cornerRadius;
    if (fig.rectangleCornerRadiiIndependent) {
      node.rectangleCornerRadii = [fig.rectangleTopLeftCornerRadius, fig.rectangleTopRightCornerRadius, fig.rectangleBottomRightCornerRadius, fig.rectangleBottomLeftCornerRadius].map(value => num(value) ?? 0);
    }
    if (num(fig.cornerSmoothing) !== undefined) node.cornerSmoothing = fig.cornerSmoothing;
    const fillGeometry = this.geometry(fig.fillGeometry), strokeGeometry = this.geometry(fig.strokeGeometry);
    if (fillGeometry) node.fillGeometry = fillGeometry;
    if (strokeGeometry) node.strokeGeometry = strokeGeometry;
    const regions = fig.vectorData?.styleOverrideTable;
    if (Array.isArray(regions) && regions.length) {
      const table: Record<string, {fills?: FigmaPaint[]}> = {};
      for (const region of regions) if (num(region?.styleID) !== undefined && Array.isArray(region.fillPaints)) table[region.styleID] = {fills: this.paints(region.fillPaints)};
      node.fillOverrideTable = table;
    }
    if (isObject(fig.arcData)) node.arcData = {startingAngle: num(fig.arcData.startingAngle) ?? 0, endingAngle: num(fig.arcData.endingAngle) ?? 2 * Math.PI, innerRadius: num(fig.arcData.innerRadius) ?? 0};
    if (num(fig.count) !== undefined) node.pointCount = fig.count;
    if (num(fig.starInnerScale) !== undefined) node.innerRadius = fig.starInnerScale;
    if (typeof fig.booleanOperation === 'string') node.booleanOperation = fig.booleanOperation;

    if (FRAME_LIKE.has(type)) {
      node.clipsContent = fig.frameMaskDisabled !== true;
      const mode = fig.stackMode;
      if (mode === 'HORIZONTAL' || mode === 'VERTICAL' || mode === 'GRID') {
        node.layoutMode = mode;
        if (fig.stackWrap === 'WRAP') node.layoutWrap = 'WRAP';
        node.primaryAxisSizingMode = fig.stackPrimarySizing === 'FIXED' || fig.stackPrimarySizing === undefined ? 'FIXED' : 'AUTO';
        node.counterAxisSizingMode = fig.stackCounterSizing === 'FIXED' || fig.stackCounterSizing === undefined ? 'FIXED' : 'AUTO';
        if (typeof fig.stackPrimaryAlignItems === 'string') node.primaryAxisAlignItems = fig.stackPrimaryAlignItems;
        if (typeof fig.stackCounterAlignItems === 'string') node.counterAxisAlignItems = fig.stackCounterAlignItems;
        if (typeof fig.stackCounterAlignContent === 'string') node.counterAxisAlignContent = fig.stackCounterAlignContent;
        node.paddingLeft = num(fig.stackHorizontalPadding) ?? 0;
        node.paddingTop = num(fig.stackVerticalPadding) ?? 0;
        node.paddingRight = num(fig.stackPaddingRight) ?? node.paddingLeft;
        node.paddingBottom = num(fig.stackPaddingBottom) ?? node.paddingTop;
        node.itemSpacing = num(fig.stackSpacing) ?? 0;
        node.counterAxisSpacing = num(fig.stackCounterSpacing) ?? null;
        if (fig.stackReverseZIndex === true) node.itemReverseZIndex = true;
        if (fig.bordersTakeSpace === true) node.strokesIncludedInLayout = true;
      }
    }
    const inFlow = parent.layoutMode === 'HORIZONTAL' || parent.layoutMode === 'VERTICAL';
    if (fig.stackPositioning === 'ABSOLUTE') node.layoutPositioning = 'ABSOLUTE';
    if (inFlow) {
      node.layoutAlign = fig.stackChildAlignSelf === 'STRETCH' ? 'STRETCH' : 'INHERIT';
      node.layoutGrow = num(fig.stackChildPrimaryGrow) ?? 0;
    }
    node.constraints = {horizontal: H_CONSTRAINTS[fig.horizontalConstraint] ?? 'LEFT', vertical: V_CONSTRAINTS[fig.verticalConstraint] ?? 'TOP'};

    if (type === 'TEXT') this.text(fig, node);
    if (Array.isArray(fig.componentPropRefs)) {
      const fields: Record<string, string> = {VISIBLE: 'visible', TEXT_DATA: 'characters', OVERRIDDEN_SYMBOL_ID: 'mainComponent'};
      const references: Record<string, string> = {};
      for (const ref of fig.componentPropRefs) {
        let def = this.propDefs.get(guidOf(ref?.defID) ?? '');
        const parentDef = def && this.propDefs.get(guidOf(def.parentPropDefId) ?? '');
        if (parentDef) def = parentDef;
        const field = fields[ref?.componentPropNodeField];
        if (def && field && typeof def.name === 'string') references[field] = propertyKey(def);
      }
      if (Object.keys(references).length) node.componentPropertyReferences = references;
    }
    const interactions = interactionsOf(fig.prototypeInteractions);
    if (interactions.length) node.interactions = interactions;
    if (Array.isArray(fig.exportSettings) && fig.exportSettings.length) {
      node.exportSettings = fig.exportSettings.map((entry: Fig) => ({
        suffix: str(entry?.suffix) ?? '',
        format: str(entry?.imageType) ?? 'PNG',
        constraint: {type: ({CONTENT_WIDTH: 'WIDTH', CONTENT_HEIGHT: 'HEIGHT'} as Record<string, string>)[entry?.constraint?.type] ?? 'SCALE', value: num(entry?.constraint?.value) ?? 1},
      }));
    }
    return node;
  }

  // ── Text ───────────────────────────────────────────────────────────────────────────────────

  private text(fig: Fig, node: FigmaNode) {
    const data = isObject(fig.textData) ? fig.textData : {};
    node.characters = typeof data.characters === 'string' ? data.characters : '';
    // A shared text style wins over the values cached on the layer.
    const shared = this.style(fig.styleIdForText);
    const base = {...fig, ...(shared ? pick(shared, TEXT_STYLE_FIELDS) : {})};
    const style = typeStyleOf(base, undefined);
    style.textAutoResize = str(fig.textAutoResize) ?? 'NONE';
    style.textAlignHorizontal = str(fig.textAlignHorizontal) ?? 'LEFT';
    style.textAlignVertical = str(fig.textAlignVertical) ?? 'TOP';
    if (fig.textTruncation === 'ENDING') style.textTruncation = 'ENDING';
    if (num(fig.maxLines) !== undefined) style.maxLines = fig.maxLines;
    node.style = style;
    const ids = data.characterStyleIDs;
    if (Array.isArray(ids) && ids.some(value => value)) {
      node.characterStyleOverrides = ids;
      const table: Record<string, FigmaTypeStyle> = {};
      for (const entry of Array.isArray(data.styleOverrideTable) ? data.styleOverrideTable : []) {
        if (num(entry?.styleID) === undefined) continue;
        const ownStyle = entry.styleIdForText && !entry.isOverrideOverTextStyle ? this.style(entry.styleIdForText) : undefined;
        const merged = ownStyle ? {...pick(ownStyle, TEXT_STYLE_FIELDS), ...entry} : entry;
        const runStyle = typeStyleOf(merged, num(merged.fontSize) ?? style.fontSize, true);
        if (Array.isArray(entry.fillPaints)) runStyle.fills = this.paints(entry.fillPaints);
        table[entry.styleID] = runStyle;
      }
      node.styleOverrideTable = table;
    }
    const lines = Array.isArray(data.lines) ? data.lines : [];
    if (lines.length) {
      node.lineTypes = lines.map((line: Fig) => (/UNORDERED/.test(line?.lineType) ? 'UNORDERED' : /ORDERED/.test(line?.lineType) ? 'ORDERED' : 'NONE'));
      node.lineIndentations = lines.map((line: Fig) => num(line?.indentationLevel) ?? 0);
    }
  }

  // ── Paints, styles, geometry ───────────────────────────────────────────────────────────────

  private paints(list: unknown): FigmaPaint[] {
    if (!Array.isArray(list)) return [];
    return list.flatMap(paint => {
      if (!isObject(paint) || typeof paint.type !== 'string') return [];
      const out: FigmaPaint = {type: paint.type};
      if (paint.visible === false) out.visible = false;
      if (num(paint.opacity) !== undefined) out.opacity = paint.opacity;
      if (typeof paint.blendMode === 'string') out.blendMode = paint.blendMode;
      if (paint.type === 'SOLID') out.color = colorOf(paint.color);
      else if (paint.type.startsWith('GRADIENT_')) {
        out.gradientStops = (Array.isArray(paint.stops) ? paint.stops : []).map((stop: Fig) => ({position: num(stop?.position) ?? 0, color: colorOf(stop?.color)}));
        out.gradientHandlePositions = handlesOf(paint.type, matrixOf(paint.transform));
      } else if (paint.type === 'IMAGE') {
        const ref = hexOf(paint.image?.hash);
        if (ref) {
          out.imageRef = ref;
          this.imageRefs.add(ref);
        }
        const mode = paint.imageScaleMode;
        out.scaleMode = mode === 'STRETCH' || mode === 'FIT' || mode === 'TILE' ? mode : 'FILL';
        if (mode === 'STRETCH') out.imageTransform = matrixOf(paint.transform) as FigmaTransform;
        if (mode === 'TILE' && num(paint.scale) !== undefined) out.scalingFactor = paint.scale;
        if (num(paint.rotation)) out.rotation = paint.rotation;
        if (isObject(paint.paintFilter)) {
          const filters: Record<string, number> = {};
          for (const [key, value] of Object.entries(paint.paintFilter)) if (num(value) !== undefined && value !== 0) filters[key] = value as number;
          if (Object.keys(filters).length) out.filters = filters;
        }
      }
      return [out];
    });
  }

  private geometry(list: unknown): FigmaPath[] | undefined {
    if (!Array.isArray(list) || !list.length) return undefined;
    const out = list.flatMap(entry => {
      const path = pathOf(this.blobs[entry?.commandsBlob]);
      if (!path) return [];
      const item: FigmaPath = {path, windingRule: entry.windingRule === 'ODD' ? 'EVENODD' : 'NONZERO'};
      if (num(entry.styleID)) item.overrideID = entry.styleID;
      return [item];
    });
    return out.length ? out : undefined;
  }

  private style(ref: unknown): Fig | undefined {
    if (!isObject(ref)) return undefined;
    const byGuid = guidOf(ref.guid);
    const found = byGuid ? this.byId.get(byGuid) : typeof ref.assetRef?.key === 'string' ? this.styleByKey.get(ref.assetRef.key) : undefined;
    return found?.styleType ? found : undefined;
  }

  private noteStyle(style: Fig, ref: Fig): string | undefined {
    const id = guidOf(style.guid);
    if (!id) return undefined;
    if (!this.styles[id]) {
      const meta: FigmaStyleMeta = {name: str(style.name) ?? 'Style', styleType: style.styleType === 'GRID' ? 'GRID' : String(style.styleType), description: str(style.styleDescription) ?? ''};
      if (typeof style.key === 'string') meta.key = style.key;
      if (ref.assetRef) meta.remote = true;
      this.styles[id] = meta;
    }
    return id;
  }

  // ── Components ─────────────────────────────────────────────────────────────────────────────

  private noteComponent(id: string) {
    if (this.components[id]) return;
    const symbol = this.byId.get(id);
    const meta: FigmaComponentMeta = {name: str(symbol?.name) ?? '', description: str(symbol?.symbolDescription) ?? '', remote: !this.onPages.has(id)};
    if (typeof symbol?.componentKey === 'string') meta.key = symbol.componentKey;
    const parent = symbol ? this.byId.get(guidOf(symbol.parentIndex?.guid) ?? '') : undefined;
    if (parent?.isStateGroup) meta.componentSetId = guidOf(parent.guid);
    this.components[id] = meta;
  }

  private describeComponent(fig: Fig, type: string, node: FigmaNode) {
    const id = node.id;
    if (type === 'COMPONENT') {
      this.noteComponent(id);
      const parent = this.byId.get(guidOf(fig.parentIndex?.guid) ?? '');
      if (!parent?.isStateGroup) node.componentPropertyDefinitions = this.definitionsOf(fig);
    } else {
      this.componentSets[id] = {name: str(fig.name) ?? '', description: str(fig.symbolDescription) ?? '', ...(typeof fig.componentKey === 'string' ? {key: fig.componentKey} : {})};
      node.componentPropertyDefinitions = this.definitionsOf(fig);
    }
  }

  /** The owner of a property: a component set's own definition for a variant's. */
  private definitionOf(owner: Fig, def: Fig): Fig {
    const parentId = guidOf(def?.parentPropDefId);
    if (!parentId) return def;
    const set = this.byId.get(guidOf(owner.parentIndex?.guid) ?? '');
    return (Array.isArray(set?.componentPropDefs) ? set.componentPropDefs : []).find((entry: Fig) => guidOf(entry?.id) === parentId) ?? def;
  }

  private definitionsOf(owner: Fig): Record<string, Fig> {
    const out: Record<string, Fig> = {};
    const orders = Array.isArray(owner.stateGroupPropertyValueOrders) ? owner.stateGroupPropertyValueOrders : [];
    for (const def of Array.isArray(owner.componentPropDefs) ? owner.componentPropDefs : []) {
      const type = PROPERTY_TYPES[def?.type];
      if (!type || typeof def.name !== 'string') continue;
      if (type === 'VARIANT') {
        const order = orders.find((entry: Fig) => entry?.property === def.name);
        out[def.name] = {type, defaultValue: order?.values?.[0] ?? '', variantOptions: Array.isArray(order?.values) ? order.values : []};
      } else out[propertyKey(def)] = {type, defaultValue: valueOf(type, def.initialValue)};
    }
    return out;
  }

  private propertiesOf(symbol: Fig, assignments: Map<string, Fig>): Record<string, {type: string; value: string | boolean}> {
    const out: Record<string, {type: string; value: string | boolean}> = {};
    for (const def of Array.isArray(symbol.componentPropDefs) ? symbol.componentPropDefs : []) {
      const owner = this.definitionOf(symbol, def);
      const type = PROPERTY_TYPES[owner?.type];
      if (!type || type === 'VARIANT' || typeof owner.name !== 'string') continue;
      const assigned = assignments.get(guidOf(def.id) ?? '');
      out[propertyKey(owner)] = {type, value: valueOf(type, assigned ?? def.initialValue ?? owner.initialValue)};
    }
    const set = this.byId.get(guidOf(symbol.parentIndex?.guid) ?? '');
    if (set?.isStateGroup && Array.isArray(symbol.variantPropSpecs)) {
      const defs: Fig[] = Array.isArray(set.componentPropDefs) ? set.componentPropDefs : [];
      for (const spec of symbol.variantPropSpecs) {
        const def = defs.find(entry => guidOf(entry?.id) === guidOf(spec?.propDefId));
        if (def && typeof def.name === 'string' && typeof spec.value === 'string') out[def.name] = {type: 'VARIANT', value: spec.value};
      }
    }
    return out;
  }
}

const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'BOOLEAN_OPERATION']);
const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
const TEXT_STYLE_FIELDS = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'paragraphSpacing', 'paragraphIndent', 'leadingTrim', 'listSpacing'];

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const pick = (from: Fig, keys: readonly string[]) => Object.fromEntries(keys.filter(key => from[key] !== undefined).map(key => [key, from[key]]));
const colorOf = (color: Fig | undefined, alpha?: unknown) => ({r: num(color?.r) ?? 0, g: num(color?.g) ?? 0, b: num(color?.b) ?? 0, a: num(alpha) ?? num(color?.a) ?? 1});
const propertyKey = (def: Fig) => `${def.name}#${guidOf(def.id)}`;

function typeOf(fig: Fig): string {
  if (fig.type === 'FRAME') return fig.isStateGroup ? 'COMPONENT_SET' : fig.resizeToFit ? 'GROUP' : 'FRAME';
  return TYPES[fig.type] ?? String(fig.type);
}

function valueOf(type: string, value: unknown): string | boolean {
  if (!isObject(value)) return type === 'BOOLEAN' ? true : '';
  if (type === 'BOOLEAN') return value.boolValue !== false;
  if (type === 'INSTANCE_SWAP') return guidOf(value.guidValue) ?? '';
  return typeof value.textValue?.characters === 'string' ? value.textValue.characters : '';
}

/** Component property values on a copied node: visibility, text and nested swaps. */
function applyProperties(fig: Fig, assignments: Map<string, Fig>) {
  if (!assignments.size || !Array.isArray(fig.componentPropRefs)) return;
  for (const ref of fig.componentPropRefs) {
    const value = assignments.get(guidOf(ref?.defID) ?? '');
    if (!value) continue;
    if (ref.componentPropNodeField === 'VISIBLE' && typeof value.boolValue === 'boolean') fig.visible = value.boolValue;
    // New characters drop the main's per-character styles unless the value brings its own.
    else if (ref.componentPropNodeField === 'TEXT_DATA' && isObject(value.textValue)) fig.textData = {...fig.textData, characterStyleIDs: undefined, ...value.textValue};
    else if (ref.componentPropNodeField === 'OVERRIDDEN_SYMBOL_ID' && value.guidValue) fig.overriddenSymbolID = value.guidValue;
  }
}

/** REST's three handles in the node's unit square: Figma stores the inverse, unit square → gradient. */
function handlesOf(type: string, transform: Matrix) {
  const inverse = invert(transform) ?? IDENTITY;
  const points: [number, number][] = type === 'GRADIENT_LINEAR' ? [[0, 0.5], [1, 0.5], [0, 1]] : [[0.5, 0.5], [1, 0.5], [0.5, 1]];
  return points.map(([x, y]) => apply(inverse, x, y));
}

function typeStyleOf(fig: Fig, baseSize: number | undefined, partial = false): FigmaTypeStyle {
  const out: FigmaTypeStyle = {};
  const fontSize = num(fig.fontSize) ?? baseSize;
  if (isObject(fig.fontName)) {
    if (typeof fig.fontName.family === 'string') out.fontFamily = fig.fontName.family;
    if (typeof fig.fontName.style === 'string') {
      out.fontStyle = fig.fontName.style;
      out.italic = /italic|oblique/i.test(fig.fontName.style);
    }
    if (typeof fig.fontName.postscript === 'string' && fig.fontName.postscript) out.fontPostScriptName = fig.fontName.postscript;
  }
  if (num(fig.fontSize) !== undefined) out.fontSize = fig.fontSize;
  else if (!partial && fontSize !== undefined) out.fontSize = fontSize;
  if (typeof fig.textCase === 'string') out.textCase = fig.textCase;
  if (typeof fig.textDecoration === 'string') out.textDecoration = fig.textDecoration;
  if (num(fig.paragraphSpacing) !== undefined) out.paragraphSpacing = fig.paragraphSpacing;
  if (num(fig.paragraphIndent) !== undefined) out.paragraphIndent = fig.paragraphIndent;
  if (typeof fig.leadingTrim === 'string') out.leadingTrim = fig.leadingTrim;
  const spacing = fig.letterSpacing;
  if (isObject(spacing) && num(spacing.value) !== undefined) out.letterSpacing = spacing.units === 'PERCENT' ? (spacing.value / 100) * (fontSize ?? 0) : spacing.value;
  const line = fig.lineHeight;
  if (isObject(line) && num(line.value) !== undefined) {
    const value = line.value as number;
    // "Auto" is stored as 100 % (older files) or a raw factor of 1.
    if ((line.units === 'PERCENT' && value === 100) || (line.units === 'RAW' && value === 1)) {
      out.lineHeightUnit = 'INTRINSIC_%';
      if (fontSize) out.lineHeightPx = fontSize * 1.2;
    } else if (line.units === 'PIXELS') {
      out.lineHeightUnit = 'PIXELS';
      out.lineHeightPx = value;
    } else {
      const percent = line.units === 'RAW' ? value * 100 : value;
      out.lineHeightUnit = 'FONT_SIZE_%';
      out.lineHeightPercentFontSize = percent;
      if (fontSize) out.lineHeightPx = (percent / 100) * fontSize;
    }
  }
  if (isObject(fig.hyperlink)) {
    const nodeId = guidOf(fig.hyperlink.guid);
    if (nodeId) out.hyperlink = {type: 'NODE', nodeID: nodeId};
    else if (typeof fig.hyperlink.url === 'string') out.hyperlink = {type: 'URL', url: fig.hyperlink.url};
  }
  return out;
}

function effectsOf(list: unknown): FigmaEffect[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap(effect => {
    if (!isObject(effect) || typeof effect.type !== 'string') return [];
    const out: FigmaEffect = {type: EFFECTS[effect.type] ?? effect.type, visible: effect.visible !== false, radius: num(effect.radius) ?? 0};
    if (isObject(effect.color)) out.color = colorOf(effect.color);
    if (typeof effect.blendMode === 'string') out.blendMode = effect.blendMode;
    if (isObject(effect.offset)) out.offset = {x: num(effect.offset.x) ?? 0, y: num(effect.offset.y) ?? 0};
    if (num(effect.spread) !== undefined) out.spread = effect.spread;
    if (effect.showShadowBehindNode === true) out.showShadowBehindNode = true;
    return [out];
  });
}

function interactionsOf(list: unknown): FigmaInteraction[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap(entry => {
    if (!isObject(entry) || entry.isDeleted || !isObject(entry.event) || typeof entry.event.interactionType !== 'string') return [];
    const event = entry.event;
    const trigger: Fig = {type: event.interactionType};
    if (num(event.transitionTimeout) !== undefined) trigger.timeout = event.transitionTimeout;
    if (Array.isArray(event.keyTrigger?.keyCodes)) trigger.keyCodes = event.keyTrigger.keyCodes;
    const actions = (Array.isArray(entry.actions) ? entry.actions : []).flatMap((action: Fig) => {
      if (!isObject(action)) return [];
      switch (action.connectionType) {
        case 'BACK':
          return [{type: 'BACK'}];
        case 'CLOSE':
          return [{type: 'CLOSE'}];
        case 'URL':
          return typeof action.connectionURL === 'string' ? [{type: 'URL', url: action.connectionURL, openInNewTab: action.openUrlInNewTab !== false}] : [];
        case 'INTERNAL_NODE': {
          const destinationId = guidOf(action.transitionNodeID);
          if (!destinationId) return [];
          const move = MOVES[action.transitionType];
          const transitionType = move ? move[0] : action.transitionType === 'DISSOLVE' || action.transitionType === 'SMART_ANIMATE' ? action.transitionType : undefined;
          const transition = transitionType
            ? {type: transitionType, duration: num(action.transitionDuration) ?? 0.3, easing: {type: EASINGS[action.easingType] ?? 'EASE_OUT'}, ...(move ? {direction: move[1]} : {})}
            : null;
          return [{type: 'NODE', destinationId, navigation: NAVIGATIONS[action.navigationType] ?? 'NAVIGATE', transition, ...(action.transitionPreserveScroll ? {preserveScrollPosition: true} : {})}];
        }
        default:
          return [];
      }
    });
    return actions.length ? [{trigger, actions} as FigmaInteraction] : [];
  });
}
