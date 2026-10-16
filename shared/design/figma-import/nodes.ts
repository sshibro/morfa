import type {AutoLayout, ComponentPropertyDefinition, ComponentPropertyReferences, GridChild, GridChildAlign, GridLayout, GridTrackSize, LayoutSizing, Measurement, MeasurementSide, NodeId, NodeType, PathCommand, SceneNode, VectorPath} from '../types';
import {FRAME_LIKE_TYPES} from '../types';
import {TYPE_NAMES, createNode, defaultAutoLayout, isContainerType} from '../defaults';
import {scaling} from '../geometry';
import {parsePathData, subpaths, transformPath} from '../paths';
import {sizingFixes} from '../layout';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';
import type {FigmaComponentMeta, FigmaFile, FigmaNode, FigmaPath} from './rest-types';
import type {Entry} from './plan';
import {plainId} from './plan';
import type {Placed} from './geometry';
import type {ReportBuilder} from './report';
import {framePrototypeOf, reactionsOf, scrollBehaviorOf} from './prototype';
import {textPropsOf} from './text';
import {ICON_FONT} from './fonts';
import {
  blendMode, bool, capOf, clamp, constraintsOf, coord, dashesOf, effectsOf, exportSettingsOf, finite, gridsOf, miterLimitOf, paintsOf, size, strokeAlignOf, strokeJoinOf,
  text, unit, type Note,
} from './values';

// One Figma node → one Morfa node: every field the model has, from the REST answer. Geometry
// comes placed (geometry.ts), the type and ids decided (plan.ts); this module only reads values.

export type StyleUse = {nodeId: NodeId; kind: 'fill' | 'stroke' | 'effect' | 'grid' | 'text'; figmaId: string};

export type BuildContext = {
  file: FigmaFile;
  report: ReportBuilder;
  /** Figma node id → id in the new file, for nodes the import writes. */
  nodeRef: (figmaId: string) => NodeId | undefined;
  /** Component key → id in the new file (preferred values of instance-swap properties). */
  componentByKey: Map<string, NodeId>;
  styleUses: StyleUse[];
  /** Layers that had variables bound in Figma. */
  variables: {count: number};
};

const FRAME_LIKE = new Set<NodeType>(FRAME_LIKE_TYPES);
const MARKER_TYPES = new Set<NodeType>(['LINE', 'VECTOR']);
const SIZINGS = new Set(['FIXED', 'HUG', 'FILL']);
const STYLE_KINDS: Record<string, StyleUse['kind']> = {fill: 'fill', fills: 'fill', stroke: 'stroke', strokes: 'stroke', effect: 'effect', effects: 'effect', grid: 'grid', grids: 'grid', text: 'text'};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const key = (value: string) => value.slice(0, L.shortText);

export function noteFor(report: ReportBuilder, layer: string | undefined): Note {
  return (noteKey, group, message) => report.note(noteKey, group, message, layer);
}

// ── Auto layout and sizing ─────────────────────────────────────────────────────────────────────

function autoLayoutOf(node: FigmaNode, note: Note): AutoLayout {
  const layout = defaultAutoLayout();
  if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL' || node.layoutMode === 'GRID') layout.layoutMode = node.layoutMode;
  layout.layoutWrap = node.layoutWrap === 'WRAP' ? 'WRAP' : 'NO_WRAP';
  const primary = node.primaryAxisAlignItems;
  layout.primaryAxisAlignItems = primary === 'CENTER' || primary === 'MAX' || primary === 'SPACE_BETWEEN' ? primary : 'MIN';
  const counter = node.counterAxisAlignItems;
  layout.counterAxisAlignItems = counter === 'CENTER' || counter === 'MAX' || counter === 'BASELINE' ? counter : 'MIN';
  layout.counterAxisAlignContent = node.counterAxisAlignContent === 'SPACE_BETWEEN' ? 'SPACE_BETWEEN' : 'AUTO';
  layout.paddingLeft = coord(node.paddingLeft);
  layout.paddingRight = coord(node.paddingRight);
  layout.paddingTop = coord(node.paddingTop);
  layout.paddingBottom = coord(node.paddingBottom);
  layout.itemSpacing = coord(node.itemSpacing);
  // Figma's null spacing between rows follows the item spacing.
  layout.counterAxisSpacing = typeof node.counterAxisSpacing === 'number' ? coord(node.counterAxisSpacing) : layout.itemSpacing;
  layout.itemReverseZIndex = bool(node.itemReverseZIndex, false);
  layout.strokesIncludedInLayout = bool(node.strokesIncludedInLayout, false);
  return layout;
}

function sizingOf(node: FigmaNode, type: NodeType, parent: FigmaNode | undefined): {horizontal: LayoutSizing; vertical: LayoutSizing} {
  let horizontal = SIZINGS.has(String(node.layoutSizingHorizontal)) ? (node.layoutSizingHorizontal as LayoutSizing) : undefined;
  let vertical = SIZINGS.has(String(node.layoutSizingVertical)) ? (node.layoutSizingVertical as LayoutSizing) : undefined;
  if (horizontal && vertical) return {horizontal, vertical};
  // Answers from before layoutSizing*: derive it from the older fields.
  let h: LayoutSizing = 'FIXED', v: LayoutSizing = 'FIXED';
  if (FRAME_LIKE.has(type) && (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL')) {
    const primaryHug = node.primaryAxisSizingMode === 'AUTO', counterHug = node.counterAxisSizingMode === 'AUTO';
    if (node.layoutMode === 'HORIZONTAL') [h, v] = [primaryHug ? 'HUG' : 'FIXED', counterHug ? 'HUG' : 'FIXED'];
    else [h, v] = [counterHug ? 'HUG' : 'FIXED', primaryHug ? 'HUG' : 'FIXED'];
  }
  if (type === 'TEXT') {
    const mode = node.style?.textAutoResize;
    if (mode === 'WIDTH_AND_HEIGHT') [h, v] = ['HUG', 'HUG'];
    else if (mode === 'HEIGHT') v = 'HUG';
  }
  const flow = parent && (parent.layoutMode === 'HORIZONTAL' || parent.layoutMode === 'VERTICAL') && node.layoutPositioning !== 'ABSOLUTE';
  if (flow) {
    const grow = finite(node.layoutGrow) > 0, stretch = node.layoutAlign === 'STRETCH';
    if (parent!.layoutMode === 'HORIZONTAL') {
      if (grow) h = 'FILL';
      if (stretch) v = 'FILL';
    } else {
      if (grow) v = 'FILL';
      if (stretch) h = 'FILL';
    }
  }
  return {horizontal: horizontal ?? h, vertical: vertical ?? v};
}

/** One track of a REST `gridRowsSizing` / `gridColumnsSizing` string (CSS grid-template terms): `80px` FIXED, `2fr` FLEX by
 *  weight, `auto` HUG; anything else (minmax, percentages, repeat) reads as one FLEX track. */
function gridTrackOf(term: string): GridTrackSize {
  const px = /^(\d+(?:\.\d+)?)px$/i.exec(term);
  if (px) return {type: 'FIXED', value: size(Number(px[1]))};
  const fr = /^(\d+(?:\.\d+)?)fr$/i.exec(term);
  if (fr) return Number(fr[1]) === 1 ? {type: 'FLEX'} : {type: 'FLEX', value: Math.max(0, Number(fr[1]))};
  if (/^auto$/i.test(term)) return {type: 'HUG'};
  return {type: 'FLEX'};
}

/** The grid auto layout of a GRID frame (lane N1 step 11). The REST API gives counts, gaps and the tracks as strings, and
 *  anchors every child itself, so the placement is MANUAL and the rows are not automatic. */
function gridOf(node: FigmaNode): GridLayout {
  const tracks = (text: unknown) => (typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).slice(0, L.gridTracks).map(gridTrackOf) : []);
  const rowSizes = tracks(node.gridRowsSizing), columnSizes = tracks(node.gridColumnsSizing);
  const count = (value: unknown, fallback: number) => {
    const n = finite(value, NaN);
    return Number.isFinite(n) && n >= 1 ? Math.min(L.gridTracks, Math.floor(n)) : Math.max(1, fallback);
  };
  return {
    rowCount: count(node.gridRowCount, rowSizes.length),
    columnCount: count(node.gridColumnCount, columnSizes.length),
    rowGap: Math.max(0, coord(node.gridRowGap)),
    columnGap: Math.max(0, coord(node.gridColumnGap)),
    rowSizes,
    columnSizes,
    autoTracks: 'NONE',
    itemsPositioning: 'MANUAL',
  };
}

/** A child of a GRID frame: its anchors, spans and alignment in its cells. */
function gridChildOf(node: FigmaNode): GridChild {
  const child: GridChild = {};
  const index = (value: unknown) => {
    const n = finite(value, NaN);
    return Number.isFinite(n) && n >= 0 ? Math.min(L.gridTracks - 1, Math.floor(n)) : undefined;
  };
  const span = (value: unknown) => {
    const n = finite(value, NaN);
    return Number.isFinite(n) && n > 1 ? Math.min(L.gridTracks, Math.floor(n)) : undefined;
  };
  const align = (value: unknown): GridChildAlign | undefined => (value === 'MIN' || value === 'CENTER' || value === 'MAX' || value === 'AUTO' ? value : undefined);
  child.rowAnchorIndex = index(node.gridRowAnchorIndex) ?? 0;
  child.columnAnchorIndex = index(node.gridColumnAnchorIndex) ?? 0;
  const rowSpan = span(node.gridRowSpan), columnSpan = span(node.gridColumnSpan);
  if (rowSpan !== undefined) child.rowSpan = rowSpan;
  if (columnSpan !== undefined) child.columnSpan = columnSpan;
  const h = align(node.gridChildHorizontalAlign), v = align(node.gridChildVerticalAlign);
  if (h && h !== 'AUTO') child.horizontalAlign = h;
  if (v && v !== 'AUTO') child.verticalAlign = v;
  return child;
}

// ── Vectors ────────────────────────────────────────────────────────────────────────────────────

function pathsOf(list: FigmaPath[] | undefined, placed: Placed, note: Note): VectorPath[] {
  if (!Array.isArray(list)) return [];
  const out: VectorPath[] = [];
  let budget: number = L.pathCommands;
  const scale = Math.abs(placed.scaleX - 1) > 1e-6 || Math.abs(placed.scaleY - 1) > 1e-6 ? scaling(placed.scaleX, placed.scaleY) : null;
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.path !== 'string') continue;
    if (budget <= 0 || out.length >= L.vectorPaths) {
      note('vector-big', 'vectors', 'Paths that are too complex were simplified: some lines were not imported');
      break;
    }
    let commands: PathCommand[] = parsePathData(entry.path, {maxCommands: budget});
    if (commands.length >= budget) note('vector-big', 'vectors', 'Paths that are too complex were simplified: some lines were not imported');
    if (!commands.length) continue;
    if (scale) commands = transformPath(commands, scale);
    budget -= commands.length;
    out.push({windingRule: entry.windingRule === 'EVENODD' ? 'EVENODD' : 'NONZERO', commands});
  }
  return out;
}

// ── Components ─────────────────────────────────────────────────────────────────────────────────

function definitionsOf(node: FigmaNode, context: BuildContext): Record<string, ComponentPropertyDefinition> {
  const out: Record<string, ComponentPropertyDefinition> = {};
  if (!isObject(node.componentPropertyDefinitions)) return out;
  for (const [name, raw] of Object.entries(node.componentPropertyDefinitions)) {
    if (Object.keys(out).length >= L.componentProperties) break;
    if (!isObject(raw) || !name || name === '__proto__') continue;
    const type = raw.type === 'BOOLEAN' || raw.type === 'TEXT' || raw.type === 'INSTANCE_SWAP' || raw.type === 'VARIANT' ? raw.type : null;
    if (!type) continue;
    let defaultValue: string | boolean;
    if (type === 'BOOLEAN') defaultValue = raw.defaultValue === true || raw.defaultValue === 'true';
    else if (type === 'INSTANCE_SWAP') defaultValue = typeof raw.defaultValue === 'string' ? context.nodeRef(raw.defaultValue) ?? plainId(raw.defaultValue) : '';
    else defaultValue = text(raw.defaultValue, L.description);
    const definition: ComponentPropertyDefinition = {type, defaultValue};
    if (type === 'VARIANT' && Array.isArray(raw.variantOptions)) definition.variantOptions = raw.variantOptions.filter(option => typeof option === 'string').slice(0, L.variantOptions).map(option => option.slice(0, L.shortText));
    if (type === 'INSTANCE_SWAP' && Array.isArray(raw.preferredValues)) {
      const preferred = raw.preferredValues.flatMap(value => {
        const id = isObject(value) && typeof value.key === 'string' ? context.componentByKey.get(value.key) : undefined;
        return id ? [id] : [];
      });
      if (preferred.length) definition.preferredValues = preferred.slice(0, L.variantOptions);
    }
    out[key(name)] = definition;
  }
  return out;
}

function propertiesOf(node: FigmaNode, context: BuildContext): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!isObject(node.componentProperties)) return out;
  for (const [name, raw] of Object.entries(node.componentProperties)) {
    if (Object.keys(out).length >= L.componentProperties) break;
    if (!isObject(raw) || !name || name === '__proto__') continue;
    const value = raw.value;
    if (typeof value === 'boolean') out[key(name)] = value;
    else if (typeof value === 'string') out[key(name)] = raw.type === 'INSTANCE_SWAP' ? context.nodeRef(value) ?? plainId(value) : value.slice(0, L.description);
  }
  return out;
}

function referencesOf(node: FigmaNode): ComponentPropertyReferences | undefined {
  if (!isObject(node.componentPropertyReferences)) return undefined;
  const out: ComponentPropertyReferences = {};
  for (const field of ['visible', 'characters', 'mainComponent'] as const) {
    const value = node.componentPropertyReferences[field];
    if (typeof value === 'string' && value) out[field] = key(value);
  }
  return Object.keys(out).length ? out : undefined;
}

const metaOf = (file: FigmaFile, id: string): FigmaComponentMeta | undefined =>
  (file.components && Object.hasOwn(file.components, id) ? file.components[id] : undefined) ?? (file.componentSets && Object.hasOwn(file.componentSets, id) ? file.componentSets[id] : undefined);

// ── The node ───────────────────────────────────────────────────────────────────────────────────

export type BuildInput = {
  entry: Entry;
  type: NodeType;
  id: NodeId;
  mainId?: NodeId;
  parent: SceneNode;
  /** The parent's Figma node (auto layout of the parent decides sizing). */
  parentFigma?: FigmaNode;
  placed: Placed;
  /** A Figma instance kept as a frame. */
  detached?: {componentName: string};
};

export function buildNode(input: BuildInput, context: BuildContext): SceneNode {
  const {entry, type, id, parent, placed} = input;
  const figma = entry.node;
  const name = text(figma.name, L.name) || TYPE_NAMES[type];
  const note = noteFor(context.report, name);
  const node = createNode(type, {id, parentId: parent.id, name});
  const container = isContainerType(type);
  const frameLike = FRAME_LIKE.has(type);
  if (input.mainId !== undefined) node.mainId = input.mainId;

  node.visible = bool(figma.visible, true);
  node.locked = bool(figma.locked, false);
  node.opacity = unit(figma.opacity, 1);
  node.blendMode = blendMode(figma.blendMode, node.blendMode, note, container);
  if (figma.isMask) {
    node.isMask = true;
    node.maskType = figma.maskType === 'VECTOR' || figma.maskType === 'LUMINANCE' || figma.maskType === 'ALPHA' ? figma.maskType : figma.isMaskOutline ? 'VECTOR' : 'ALPHA';
  }

  node.x = placed.x;
  node.y = placed.y;
  node.width = placed.width;
  node.height = type === 'LINE' ? 0 : placed.height;
  node.rotation = placed.rotation;
  if (placed.flipX) node.flipX = true;
  if (figma.preserveRatio === true) node.constrainProportions = true;
  if (placed.skewed) note('skew', 'vectors', 'Skew is not imported: layers were aligned without skew');

  // Paints, strokes, effects
  node.fills = paintsOf(Array.isArray(figma.fills) ? figma.fills : figma.background, note);
  node.strokes = paintsOf(figma.strokes, note);
  node.strokeWeight = size(figma.strokeWeight, node.strokes.length ? 1 : node.strokeWeight);
  node.strokeAlign = strokeAlignOf(figma.strokeAlign, node.strokeAlign);
  const cap = capOf(figma.strokeCap, note);
  node.strokeCap = cap.cap;
  if (cap.marker && MARKER_TYPES.has(type)) node.strokeEndMarker = cap.marker;
  node.strokeJoin = strokeJoinOf(figma.strokeJoin);
  node.strokeMiterLimit = miterLimitOf(figma.strokeMiterAngle);
  node.dashPattern = dashesOf(figma.strokeDashes);
  node.effects = effectsOf(figma.effects, note);

  // Layout in the parent
  node.constraints = constraintsOf(figma.constraints);
  node.layoutPositioning = figma.layoutPositioning === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO';
  for (const field of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
    const value = finite(figma[field], NaN);
    if (Number.isFinite(value) && value > 0) node[field] = size(value);
  }
  node.exportSettings = exportSettingsOf(figma.exportSettings);
  node.reactions = reactionsOf(figma, context.nodeRef, note);

  // Corners and individual strokes
  if ('cornerRadius' in node) {
    node.cornerRadius = size(figma.cornerRadius);
    if ((type === 'RECTANGLE' || frameLike) && Array.isArray(figma.rectangleCornerRadii) && figma.rectangleCornerRadii.length === 4) {
      const radii = figma.rectangleCornerRadii.map(value => size(value)) as [number, number, number, number];
      if (radii.some(value => value !== radii[0])) node.rectangleCornerRadii = radii;
      else node.cornerRadius = radii[0];
    }
    if ('cornerSmoothing' in node || figma.cornerSmoothing) node.cornerSmoothing = unit(figma.cornerSmoothing);
  }
  if ((type === 'RECTANGLE' || frameLike) && isObject(figma.individualStrokeWeights)) {
    const w = figma.individualStrokeWeights;
    node.individualStrokeWeights = {top: size(w.top), right: size(w.right), bottom: size(w.bottom), left: size(w.left)};
  }

  // Frames
  if (frameLike) {
    node.clipsContent = bool(figma.clipsContent, false);
    node.autoLayout = autoLayoutOf(figma, note);
    if (node.autoLayout.layoutMode === 'GRID') node.grid = gridOf(figma);
    node.layoutGrids = gridsOf(figma.layoutGrids);
    Object.assign(node, framePrototypeOf(figma));
  }
  const scroll = scrollBehaviorOf(figma);
  if (scroll) node.scrollBehavior = scroll;

  // Shapes
  if (type === 'ELLIPSE' && isObject(figma.arcData)) {
    node.arcData = {startingAngle: coord(figma.arcData.startingAngle), endingAngle: coord(figma.arcData.endingAngle, 2 * Math.PI), innerRadius: unit(figma.arcData.innerRadius)};
  }
  if (type === 'POLYGON' || type === 'STAR') node.pointCount = clamp(Math.round(finite(figma.pointCount, type === 'STAR' ? 5 : 3)), 3, 1000);
  if (type === 'STAR') node.innerRadius = unit(figma.innerRadius, 0.382);
  if (type === 'VECTOR') vectorOf(node, figma, placed, note);
  if (type === 'BOOLEAN_OPERATION') {
    const op = figma.booleanOperation;
    node.booleanOperation = op === 'INTERSECT' || op === 'SUBTRACT' || op === 'EXCLUDE' ? op : 'UNION';
  }

  // Text
  if (type === 'TEXT') {
    const families = new Set<string>();
    node.text = textPropsOf(figma, {
      note,
      nodeRef: context.nodeRef,
      substituted: (from, to) => {
        if (families.has(from)) return;
        families.add(from);
        context.report.font(from, to);
      },
    });
    if (families.size) node.pluginData = {figmaFont: [...families].join(', ').slice(0, L.pluginDataValue)};
    // An icon font the catalogue lacks: the run replaces the text by Figma's SVG render of it (src/design/import/figma/icon-texts.ts).
    if ([...families].some(family => ICON_FONT.test(family)) && figma.id.length <= L.pluginDataValue) node.pluginData = {...node.pluginData, figmaIcon: figma.id};
    if (figma.type === 'TEXT_PATH') {
      // Figma's API gives the path's geometry (geometry=paths) but not where the text starts on it nor its side: the text
      // follows the path from its start, and the report says so.
      const path = subpaths(pathsOf(figma.fillGeometry, placed, note)[0]?.commands ?? [])[0];
      if (path && path.length >= 2 && node.text) {
        node.textPath = {commands: path, startOffset: 0, side: 'LEFT'};
        node.text = {...node.text, textAutoResize: 'NONE'};
        note('text-path-start', 'text', 'Text on a path was imported with its path; Figma does not provide where the text starts on the path, so check it');
      } else note('text-path', 'text', 'Text on a path was imported as plain text: Figma did not provide its path');
    }
  }

  // Components
  if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
    node.description = text(metaOf(context.file, figma.id)?.description, L.description);
    node.componentPropertyDefinitions = definitionsOf(figma, context);
  }
  if (type === 'INSTANCE') {
    node.componentId = context.nodeRef(figma.componentId ?? '') ?? plainId(figma.componentId ?? '');
    node.componentProperties = propertiesOf(figma, context);
    if (figma.isExposedInstance === true) node.isExposedInstance = true;
  }
  const references = referencesOf(figma);
  if (references) node.componentPropertyReferences = references;
  if (input.detached) node.pluginData = {...node.pluginData, figmaComponent: input.detached.componentName.slice(0, L.pluginDataValue)};
  if (['TABLE', 'TABLE_CELL', 'SHAPE_WITH_TEXT', 'STICKY', 'WASHI_TAPE', 'HIGHLIGHT', 'STAMP'].includes(figma.type))
    note('figjam-' + figma.type, 'vectors', 'Tables and FigJam objects were imported in a simplified form');

  // Sizing in the parent (and the corrections Figma itself makes)
  const sizing = sizingOf(figma, type, input.parentFigma);
  node.layoutSizingHorizontal = sizing.horizontal;
  node.layoutSizingVertical = sizing.vertical;
  if (input.parentFigma?.layoutMode === 'GRID' && node.layoutPositioning !== 'ABSOLUTE') node.gridChild = gridChildOf(figma);
  const fixes = sizingFixes(node, parent);
  if (fixes) Object.assign(node, fixes);

  // Styles are attached once their values are known (styles.ts).
  if (isObject(figma.styles)) {
    for (const [field, styleId] of Object.entries(figma.styles)) {
      const kind = STYLE_KINDS[field];
      if (kind && typeof styleId === 'string' && styleId) context.styleUses.push({nodeId: id, kind, figmaId: styleId});
    }
  }
  if (isObject(figma.boundVariables) && Object.keys(figma.boundVariables).length) context.variables.count++;
  return node;
}

/** VECTOR paths: Figma's fill geometry, or, for an open path drawn only by its stroke, the stroke's
 *  outline filled with the stroke's paints (REST has no vector network to rebuild the centre line). */
function vectorOf(node: SceneNode, figma: FigmaNode, placed: Placed, note: Note): void {
  const fills = pathsOf(figma.fillGeometry, placed, note);
  const visibleStrokes = node.strokes.filter(paint => paint.visible);
  if (fills.length) {
    node.vectorPaths = fills;
    const table = figma.fillOverrideTable;
    if (isObject(table) && Object.values(table).some(entry => isObject(entry) && Array.isArray(entry.fills))) note('vector-regions', 'vectors', 'Different fills of regions of one vector were merged into one');
    return;
  }
  const outline = pathsOf(figma.strokeGeometry, placed, note);
  if (visibleStrokes.length && node.strokeWeight > 0 && outline.length) {
    node.vectorPaths = outline;
    node.fills = visibleStrokes;
    node.strokes = [];
    node.strokeStartMarker = 'NONE';
    node.strokeEndMarker = 'NONE';
    note('vector-outline', 'vectors', 'Open paths were imported as a stroke converted into a shape: its weight can no longer be changed');
    return;
  }
  node.vectorPaths = [];
  if (!figma.fillGeometry && !figma.strokeGeometry) note('vector-empty', 'vectors', 'Vectors without geometry in Figma\'s response were imported empty');
}

/** A Figma page → a PAGE node (children are attached by the caller). */
export function buildPage(entry: Entry, id: NodeId, context: BuildContext): SceneNode {
  const figma = entry.node;
  const page = createNode('PAGE', {id, name: text(figma.name, L.name) || TYPE_NAMES.PAGE});
  if (isObject(figma.backgroundColor)) {
    const color = figma.backgroundColor;
    page.backgroundColor = {r: unit(color.r), g: unit(color.g), b: unit(color.b)};
  }
  if (Array.isArray(figma.flowStartingPoints)) {
    page.flowStartingPoints = figma.flowStartingPoints
      .flatMap(flow => {
        const nodeId = isObject(flow) && typeof flow.nodeId === 'string' ? context.nodeRef(flow.nodeId) : undefined;
        return nodeId ? [{nodeId, name: text(flow.name, L.name) || 'Flow'}] : [];
      })
      .slice(0, L.flowStartingPoints);
  }
  const device = figma.prototypeDevice;
  if (isObject(device) && device.type === 'PRESET' && typeof device.presetIdentifier === 'string' && device.presetIdentifier) {
    page.prototypeDevice = {type: 'PRESET', presetId: device.presetIdentifier.slice(0, L.shortText), rotation: device.rotation === 'CCW_90' ? 90 : 0};
  }
  const background = Array.isArray(figma.prototypeBackgrounds) ? figma.prototypeBackgrounds.find(paint => isObject(paint) && paint.type === 'SOLID' && paint.visible !== false) : undefined;
  if (background?.color) page.prototypeBackground = {r: unit(background.color.r), g: unit(background.color.g), b: unit(background.color.b)};
  const measurements = measurementsOf(figma, context);
  if (measurements.length) page.measurements = measurements;
  return page;
}

const SIDES = new Set<MeasurementSide>(['TOP', 'RIGHT', 'BOTTOM', 'LEFT']);
/** Dev Mode measurements of a Figma page whose layers came along. */
function measurementsOf(figma: FigmaNode, context: BuildContext): Measurement[] {
  if (!Array.isArray(figma.measurements)) return [];
  const out: Measurement[] = [];
  const ids = new Set<string>();
  for (const raw of figma.measurements) {
    if (out.length >= L.measurements || !isObject(raw) || !isObject(raw.start) || !isObject(raw.end) || !isObject(raw.offset)) continue;
    const startId = typeof raw.start.nodeId === 'string' ? context.nodeRef(raw.start.nodeId) : undefined;
    const endId = typeof raw.end.nodeId === 'string' ? context.nodeRef(raw.end.nodeId) : undefined;
    const startSide = raw.start.side as MeasurementSide, endSide = raw.end.side as MeasurementSide;
    if (!startId || !endId || !SIDES.has(startSide) || !SIDES.has(endSide)) continue;
    const offset: Measurement['offset'] = raw.offset.type === 'OUTER'
      ? {type: 'OUTER', fixed: clamp(finite(raw.offset.fixed, 0), -L.coordinate, L.coordinate)}
      : {type: 'INNER', relative: unit(raw.offset.relative, 0.5)};
    let id = `m${out.length + 1}`;
    while (ids.has(id)) id += '_';
    ids.add(id);
    const measurement: Measurement = {id, start: {nodeId: startId, side: startSide}, end: {nodeId: endId, side: endSide}, offset};
    if (typeof raw.freeText === 'string' && raw.freeText.trim()) measurement.freeText = raw.freeText.slice(0, L.shortText);
    out.push(measurement);
  }
  return out;
}
