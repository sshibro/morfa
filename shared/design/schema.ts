import {z} from 'zod';
import type {DesignDocument, NodeId, SceneNode} from './types';
import {CONTAINER_TYPES, DESIGN_SCHEMA_VERSION, LIBRARY_PAGE_ID} from './types';
import type {DocumentPatch} from './patch';
import {countText, documentCaps, tooManyLayersMessage} from './big-files';
import {DESIGN_FIELD_LIMITS as L} from './document-limits';

// "Morfa": what a stored document may contain (docs/design-tool.md §The document). The server
// validates every document it stores: in full on create, replace and restore, and on autosave the
// patch entries plus the structural invariants of the nodes a patch touches (`checkPatchedDocument`),
// because a full pass over a 20 MB file on every save would be too slow. The client runs the same
// schema when a portable file is opened. Unknown keys are dropped; nothing here touches the DOM.

const ID = /^[A-Za-z0-9_:;.,-]+$/;
/** A key of a stored map. `__proto__` would replace an object's prototype when assigned. */
const key = (max: number = L.id) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(value => value !== '__proto__', 'Invalid key.');
const id = z
  .string()
  .min(1)
  .max(L.id)
  .regex(ID)
  .refine(value => value !== '__proto__', 'Invalid identifier.');
const text = (max: number) => z.string().max(max);
const num = z.number().finite().min(-L.coordinate).max(L.coordinate);
const size = z.number().finite().min(0).max(L.coordinate);
const unit = z.number().finite().min(0).max(1);
const signedUnit = z.number().finite().min(-1).max(1);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max);
const record = <T extends z.ZodTypeAny>(value: T, max: number, keySchema: z.ZodType<string> = id) =>
  z.record(keySchema, value).refine(map => Object.keys(map).length <= max, `No more than ${max} entries.`);
// The caps of a whole file (`DESIGN_DOCUMENT_CAPS`, or `DESIGN_BIG_FILE_CAPS` with the big-files switch on) are read when a
// value is checked, not when the schema is built: refinements, so the fast path (`compile`) and zod agree.
// The refusal names the count and the cap ("2,000 pages; the limit is 200.").
const CAPPED: Record<keyof ReturnType<typeof documentCaps>, string> = {nodes: 'layers', pages: 'pages', bytes: 'bytes'};
const cappedMessage = (count: number, cap: keyof ReturnType<typeof documentCaps>) => ({
  message: `${countText(count)} ${CAPPED[cap]}, the limit is ${countText(documentCaps()[cap])}.`,
});
const capped = <T extends z.ZodTypeAny>(item: T, cap: keyof ReturnType<typeof documentCaps>, min = 0) =>
  z.array(item).min(min).refine(items => items.length <= documentCaps()[cap], items => cappedMessage(items.length, cap));
const cappedRecord = <T extends z.ZodTypeAny>(value: T, cap: keyof ReturnType<typeof documentCaps>) =>
  z.record(id, value).refine(map => Object.keys(map).length <= documentCaps()[cap], map => cappedMessage(Object.keys(map).length, cap));

/** Same-origin picture of the owning account. The server checks the owner (server/design/images.ts). */
export const DESIGN_IMAGE_URL = /^\/uploads\/(?!\.\.?$)[A-Za-z0-9._-]{1,200}$/;
/** Prototype "Open link" and text hyperlinks: http(s) and mailto only, opened with noopener. */
export function isSafeDesignUrl(value: string): boolean {
  if (value.length > L.url) return false;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
const safeUrl = z.string().max(L.url).refine(isSafeDesignUrl, 'The link must start with http://, https:// or mailto:.');

const blendMode = z.enum([
  'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE',
  'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
]);
const rgb = z.object({r: unit, g: unit, b: unit});
const rgba = z.object({r: unit, g: unit, b: unit, a: unit});
const vec = z.object({x: num, y: num});
const matrix = z.tuple([z.tuple([num, num, num]), z.tuple([num, num, num])]);
const alias = z.object({type: z.literal('VARIABLE_ALIAS'), id});
/** Where a copy from a shared library came from (types.ts `RemoteAsset`): the library's server id, the asset's id there and the
 *  library version. */
const remote = z.object({libraryId: z.string().regex(/^[0-9a-f-]{36}$/), key: id, version: int(1, 1_000_000_000)});

const paintBase = {opacity: unit, visible: z.boolean(), blendMode};
const solidPaint = z.object({...paintBase, type: z.literal('SOLID'), color: rgb, boundVariables: z.object({color: alias.optional()}).optional()});
const gradientPaint = z.object({
  ...paintBase,
  type: z.enum(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']),
  gradientStops: list(z.object({position: unit, color: rgba}), L.gradientStops).min(1),
  gradientHandlePositions: z.tuple([vec, vec, vec]),
});
const imagePaint = z.object({
  ...paintBase,
  type: z.literal('IMAGE'),
  imageRef: z.union([z.literal(''), id]),
  scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']),
  imageTransform: matrix.optional(),
  scalingFactor: z.number().finite().positive().max(10_000).optional(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  filters: z
    .object({
      exposure: signedUnit.optional(),
      contrast: signedUnit.optional(),
      saturation: signedUnit.optional(),
      temperature: signedUnit.optional(),
      tint: signedUnit.optional(),
      highlights: signedUnit.optional(),
      shadows: signedUnit.optional(),
    })
    .optional(),
});
const paint = z.discriminatedUnion('type', [solidPaint, gradientPaint, imagePaint]);
const paints = list(paint, L.paints);

const effect = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['DROP_SHADOW', 'INNER_SHADOW']),
    color: rgba,
    offset: vec,
    radius: size,
    spread: num,
    visible: z.boolean(),
    blendMode,
    showShadowBehindNode: z.boolean().optional(),
  }),
  z.object({type: z.enum(['LAYER_BLUR', 'BACKGROUND_BLUR']), radius: size, visible: z.boolean()}),
]);
const effects = list(effect, L.effects);

const autoLayout = z.object({
  layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID']),
  layoutWrap: z.enum(['NO_WRAP', 'WRAP']),
  primaryAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']),
  counterAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'BASELINE']),
  counterAxisAlignContent: z.enum(['AUTO', 'SPACE_BETWEEN']),
  paddingLeft: num,
  paddingRight: num,
  paddingTop: num,
  paddingBottom: num,
  itemSpacing: num,
  counterAxisSpacing: num,
  itemReverseZIndex: z.boolean(),
  strokesIncludedInLayout: z.boolean(),
});
const gridTrackSize = z.object({type: z.enum(['FIXED', 'FLEX', 'HUG']), value: size.optional()});
const gridLayout = z.object({
  rowCount: int(1, L.gridTracks),
  columnCount: int(1, L.gridTracks),
  rowGap: size,
  columnGap: size,
  rowSizes: list(gridTrackSize, L.gridTracks),
  columnSizes: list(gridTrackSize, L.gridTracks),
  autoTracks: z.enum(['NONE', 'ROWS']),
  itemsPositioning: z.enum(['MANUAL', 'ROW_AUTO_FLOW']),
});
const gridChildAlign = z.enum(['MIN', 'CENTER', 'MAX', 'AUTO']);
const gridChild = z.object({
  rowAnchorIndex: int(0, L.gridTracks - 1).optional(),
  columnAnchorIndex: int(0, L.gridTracks - 1).optional(),
  rowSpan: int(1, L.gridTracks).optional(),
  columnSpan: int(1, L.gridTracks).optional(),
  horizontalAlign: gridChildAlign.optional(),
  verticalAlign: gridChildAlign.optional(),
});
const layoutGrid = z.discriminatedUnion('pattern', [
  z.object({pattern: z.literal('GRID'), sectionSize: size, visible: z.boolean(), color: rgba}),
  z.object({
    pattern: z.enum(['COLUMNS', 'ROWS']),
    alignment: z.enum(['MIN', 'MAX', 'CENTER', 'STRETCH']),
    count: int(0, 10_000),
    gutterSize: num,
    offset: num,
    sectionSize: size,
    visible: z.boolean(),
    color: rgba,
  }),
]);
const layoutGrids = list(layoutGrid, L.layoutGrids);

const lineHeight = z.discriminatedUnion('unit', [
  z.object({unit: z.literal('AUTO')}),
  z.object({unit: z.enum(['PIXELS', 'PERCENT']), value: size}),
]);
const hyperlink = z.discriminatedUnion('type', [
  z.object({type: z.literal('URL'), url: safeUrl}),
  z.object({type: z.literal('NODE'), nodeId: id}),
]);
const textStyleShape = {
  fontFamily: z.string().min(1).max(L.fontFamily),
  fontWeight: z.number().finite().min(1).max(1000),
  italic: z.boolean(),
  fontSize: z.number().finite().min(0).max(100_000),
  lineHeight,
  letterSpacing: z.object({unit: z.enum(['PIXELS', 'PERCENT']), value: num}),
  textDecoration: z.enum(['NONE', 'UNDERLINE', 'STRIKETHROUGH']),
  textCase: z.enum(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS']),
  hyperlink: hyperlink.nullable().optional(),
};
const textStyle = z.object(textStyleShape);
const textRun = z.object({
  start: int(0, L.characters),
  end: int(0, L.characters),
  style: z.object(textStyleShape).partial(),
  fills: paints.optional(),
  textStyleId: id.optional(),
});
const textProps = z.object({
  characters: text(L.characters),
  style: textStyle,
  runs: list(textRun, L.textRuns),
  textAlignHorizontal: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']),
  textAlignVertical: z.enum(['TOP', 'CENTER', 'BOTTOM']),
  textAutoResize: z.enum(['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE']),
  paragraphSpacing: num,
  paragraphIndent: num,
  listTypes: list(z.enum(['NONE', 'ORDERED', 'UNORDERED']), L.listTypes).optional(),
  maxLines: int(1, 100_000).nullable().optional(),
});

const pathCommand = z.discriminatedUnion('type', [
  z.object({type: z.literal('M'), x: num, y: num}),
  z.object({type: z.literal('L'), x: num, y: num}),
  z.object({type: z.literal('C'), x1: num, y1: num, x2: num, y2: num, x: num, y: num}),
  z.object({type: z.literal('Q'), x1: num, y1: num, x: num, y: num}),
  z.object({type: z.literal('Z')}),
]);
const vectorPath = z.object({windingRule: z.enum(['NONZERO', 'EVENODD']), commands: list(pathCommand, L.pathCommands)});
const textPath = z.object({commands: list(pathCommand, L.pathCommands).min(2), startOffset: unit, side: z.enum(['LEFT', 'RIGHT'])});
const variableWidthStroke = z.object({
  widthProfile: z.enum(['UNIFORM', 'WEDGE', 'TAPER', 'QUARTER_TAPER', 'EYE', 'MIRRORED_TAPER', 'CUSTOM']),
  variableWidthPoints: list(z.object({position: unit, width: z.number().finite().min(0).max(100)}), L.widthPoints).optional(),
});
const annotationProperty = z.enum([
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'fills', 'strokes', 'strokeWeight', 'cornerRadius', 'effects', 'opacity',
  'textStyleId', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlignHorizontal',
  'layoutMode', 'itemSpacing', 'padding', 'alignItems', 'mainComponent',
]);
const annotation = z.object({
  id,
  label: text(L.description),
  categoryId: id.optional(),
  properties: list(z.object({type: annotationProperty}), L.annotationProperties).optional(),
});
const measurementSide = z.enum(['TOP', 'RIGHT', 'BOTTOM', 'LEFT']);
const measurement = z.object({
  id,
  start: z.object({nodeId: id, side: measurementSide}),
  end: z.object({nodeId: id, side: measurementSide}),
  offset: z.discriminatedUnion('type', [z.object({type: z.literal('INNER'), relative: unit}), z.object({type: z.literal('OUTER'), fixed: num})]),
  freeText: text(L.shortText).optional(),
});

const easing = z.enum(['LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'EASE_IN_BACK', 'EASE_OUT_BACK', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW']);
const duration = z.number().finite().min(0).max(1_000_000);
const trigger = z.discriminatedUnion('type', [
  z.object({type: z.enum(['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'ON_DRAG', 'MOUSE_ENTER', 'MOUSE_LEAVE', 'MOUSE_DOWN', 'MOUSE_UP'])}),
  z.object({type: z.literal('AFTER_TIMEOUT'), timeout: duration}),
  z.object({type: z.literal('ON_KEY_DOWN'), keyCode: z.string().min(1).max(64)}),
]);
const transition = z.discriminatedUnion('type', [
  z.object({type: z.literal('INSTANT')}),
  z.object({type: z.enum(['DISSOLVE', 'SMART_ANIMATE']), duration, easing}),
  z.object({
    type: z.enum(['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT']),
    direction: z.enum(['LEFT', 'RIGHT', 'TOP', 'BOTTOM']),
    matchLayers: z.boolean().optional(),
    duration,
    easing,
  }),
]);
const action = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('NODE'),
    navigation: z.enum(['NAVIGATE', 'OVERLAY', 'SWAP', 'SCROLL_TO', 'CHANGE_TO']),
    destinationId: id,
    transition,
    preserveScrollPosition: z.boolean().optional(),
    resetScrollPosition: z.boolean().optional(),
    overlayRelativePosition: vec.optional(),
  }),
  z.object({type: z.literal('BACK')}),
  z.object({type: z.literal('CLOSE')}),
  z.object({type: z.literal('URL'), url: safeUrl, openInNewTab: z.boolean()}),
]);
const reaction = z.object({trigger, actions: list(action, L.actions)});

const exportSetting = z.object({
  format: z.enum(['PNG', 'JPG', 'SVG', 'PDF', 'WEBP']),
  suffix: text(L.shortText),
  constraint: z.object({type: z.enum(['SCALE', 'WIDTH', 'HEIGHT']), value: z.number().finite().positive().max(100_000)}),
  svgIdAttribute: z.boolean().optional(),
});
const constraintType = z.enum(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE']);
const layoutSizing = z.enum(['FIXED', 'HUG', 'FILL']);
const optionalSize = size.nullable().optional();

const nodeType = z.enum([
  'PAGE', 'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'BOOLEAN_OPERATION',
  'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'VECTOR', 'TEXT', 'SLICE',
]);
const strokeMarker = z.enum(['NONE', 'LINE_ARROW', 'TRIANGLE_ARROW', 'REVERSED_TRIANGLE', 'CIRCLE', 'DIAMOND', 'ROUND', 'SQUARE']);
const propertyDefinition = z.object({
  type: z.enum(['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT']),
  defaultValue: z.union([text(L.description), z.boolean()]),
  variantOptions: list(text(L.shortText), L.variantOptions).optional(),
  preferredValues: list(id, L.variantOptions).optional(),
});

/** "Board" (shared/design/board/types.ts `BoardMeta`, docs/board.md §Objects): what a layer is in a board object. Ids and names
 *  are bounded like the rest; a connector's free end is a coordinate. */
const connectorEnd = z.union([
  z.object({node: id, magnet: z.enum(['auto', 'top', 'right', 'bottom', 'left', 'center'])}),
  // Anywhere on the object: a point of its box in fractions (lane G step 3).
  z.object({node: id, at: z.object({x: unit, y: unit})}),
  z.object({x: num, y: num}),
]);
const boardMeta = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('sticky'), wide: z.boolean().optional()}),
  z.object({
    kind: z.literal('shape'),
    shape: z.enum([
      'square', 'rounded', 'ellipse', 'diamond', 'triangle', 'triangle-down', 'parallelogram', 'parallelogram-left', 'trapezoid', 'hexagon',
      'pentagon', 'octagon', 'star', 'plus', 'arrow-right', 'arrow-left', 'chevron', 'cylinder', 'document', 'speech',
      'cylinder-horizontal', 'file', 'folder', 'documents', 'predefined-process', 'shield', 'manual-input', 'internal-storage', 'or',
      'summing-junction',
    ]),
  }),
  z.object({
    kind: z.literal('connector'), start: connectorEnd, end: connectorEnd, line: z.enum(['straight', 'elbow', 'curved']),
    labelAt: unit.optional(), points: list(z.object({x: num, y: num}), L.connectorPoints).optional(),
  }),
  z.object({kind: z.literal('stamp'), stamp: z.enum(['heart', 'like', 'dislike', 'star', 'question', 'plus-one', 'check', 'fire', 'avatar']), by: text(L.name).optional()}),
  z.object({kind: z.literal('sticker'), sticker: z.string().min(1).max(L.shortText).regex(/^[a-z0-9-]+$/)}),
  z.object({kind: z.literal('table')}),
  z.object({kind: z.literal('stroke'), tool: z.enum(['marker', 'highlighter', 'washi'])}),
  z.object({
    kind: z.literal('part'), part: z.enum(['text', 'author', 'shape', 'line', 'label', 'row', 'cell']),
    colSpan: int(1, L.tableSpan).optional(), rowSpan: int(1, L.tableSpan).optional(),
  }),
  z.object({kind: z.literal('section'), hidden: z.boolean().optional(), backgroundLocked: z.boolean().optional()}),
]);

/** One layer. Type-specific fields are optional here; `checkNode` holds what each type requires. */
export const sceneNodeSchema = z.object({
  id,
  type: nodeType,
  name: text(L.name),
  parentId: id.nullable(),
  children: capped(id, 'nodes').optional(),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: unit,
  blendMode,
  isMask: z.boolean(),
  maskType: z.enum(['ALPHA', 'VECTOR', 'LUMINANCE']).optional(),
  x: num,
  y: num,
  width: size,
  height: size,
  rotation: num,
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  constrainProportions: z.boolean().optional(),
  fills: paints,
  strokes: paints,
  strokeWeight: size,
  strokeAlign: z.enum(['INSIDE', 'CENTER', 'OUTSIDE']),
  strokeCap: z.enum(['NONE', 'ROUND', 'SQUARE']),
  strokeJoin: z.enum(['MITER', 'BEVEL', 'ROUND']),
  strokeMiterLimit: size,
  dashPattern: list(size, L.dashPattern),
  effects,
  fillStyleId: id.optional(),
  strokeStyleId: id.optional(),
  effectStyleId: id.optional(),
  boundVariables: record(alias, L.boundVariables, key(L.shortText)).optional(),
  constraints: z.object({horizontal: constraintType, vertical: constraintType}),
  layoutPositioning: z.enum(['AUTO', 'ABSOLUTE']),
  layoutSizingHorizontal: layoutSizing,
  layoutSizingVertical: layoutSizing,
  minWidth: optionalSize,
  maxWidth: optionalSize,
  minHeight: optionalSize,
  maxHeight: optionalSize,
  gridChild: gridChild.optional(),
  exportSettings: list(exportSetting, L.exportSettings),
  reactions: list(reaction, L.reactions),

  cornerRadius: size.optional(),
  rectangleCornerRadii: z.tuple([size, size, size, size]).nullable().optional(),
  cornerSmoothing: unit.optional(),
  individualStrokeWeights: z.object({top: size, right: size, bottom: size, left: size}).nullable().optional(),
  clipsContent: z.boolean().optional(),
  autoLayout: autoLayout.optional(),
  grid: gridLayout.optional(),
  layoutGrids: layoutGrids.optional(),
  gridStyleId: id.optional(),
  overflowDirection: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL', 'BOTH']).optional(),
  overlayPositionType: z
    .enum(['CENTER', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'MANUAL'])
    .optional(),
  overlayBackground: z
    .discriminatedUnion('type', [z.object({type: z.literal('NONE')}), z.object({type: z.literal('SOLID_COLOR'), color: rgba})])
    .optional(),
  overlayBackgroundInteraction: z.enum(['NONE', 'CLOSE_ON_CLICK_OUTSIDE']).optional(),
  scrollBehavior: z.enum(['SCROLLS', 'FIXED', 'STICKY_SCROLLS']).optional(),

  backgroundColor: rgb.optional(),
  guides: list(z.object({axis: z.enum(['X', 'Y']), offset: num}), L.guides).optional(),
  flowStartingPoints: list(z.object({nodeId: id, name: text(L.name)}), L.flowStartingPoints).optional(),
  prototypeDevice: z
    .discriminatedUnion('type', [
      z.object({type: z.literal('NONE')}),
      z.object({type: z.literal('PRESET'), presetId: z.string().min(1).max(L.shortText), rotation: z.union([z.literal(0), z.literal(90)])}),
    ])
    .optional(),
  prototypeBackground: rgb.optional(),

  arcData: z.object({startingAngle: num, endingAngle: num, innerRadius: unit}).optional(),
  pointCount: int(3, 1000).optional(),
  innerRadius: unit.optional(),
  strokeStartMarker: strokeMarker.optional(),
  strokeEndMarker: strokeMarker.optional(),
  variableWidthStrokeProperties: variableWidthStroke.optional(),
  vectorPaths: list(vectorPath, L.vectorPaths).optional(),
  booleanOperation: z.enum(['UNION', 'INTERSECT', 'SUBTRACT', 'EXCLUDE']).optional(),
  text: textProps.optional(),
  textStyleId: id.optional(),
  textPath: textPath.optional(),
  annotations: list(annotation, L.annotations).optional(),
  measurements: list(measurement, L.measurements).optional(),

  description: text(L.description).optional(),
  componentPropertyDefinitions: record(propertyDefinition, L.componentProperties, key(L.shortText)).optional(),
  componentPropertyReferences: z
    .object({visible: text(L.shortText).optional(), characters: text(L.shortText).optional(), mainComponent: text(L.shortText).optional()})
    .optional(),
  componentId: id.optional(),
  componentProperties: record(z.union([text(L.description), z.boolean()]), L.componentProperties, key(L.shortText)).optional(),
  isExposedInstance: z.boolean().optional(),
  mainId: id.optional(),
  overrides: list(z.string().min(1).max(L.shortText), L.overrides).optional(),
  pluginData: record(text(L.pluginDataValue), L.pluginData, key(L.shortText)).optional(),
  remote: remote.optional(),
  board: boardMeta.optional(),
});

const style = z.object({
  id,
  type: z.enum(['FILL', 'TEXT', 'EFFECT', 'GRID']),
  name: text(L.name),
  description: text(L.description),
  paints: paints.optional(),
  text: textStyle.optional(),
  effects: effects.optional(),
  grids: layoutGrids.optional(),
  remote: remote.optional(),
});
const imageAsset = z.object({
  url: z.string().regex(DESIGN_IMAGE_URL, 'The image must be uploaded to this account.'),
  width: z.number().finite().positive().max(1_000_000),
  height: z.number().finite().positive().max(1_000_000),
  name: text(L.shortText).optional(),
});
const variableCollection = z.object({
  id,
  name: text(L.name),
  modes: list(z.object({modeId: id, name: text(L.name)}), L.modes).min(1),
  defaultModeId: id,
  variableIds: list(id, L.variables),
  remote: remote.optional(),
});
const variableValue = z.union([rgba, z.number().finite(), text(L.description), z.boolean(), alias]);
const variable = z.object({
  id,
  name: text(L.name),
  collectionId: id,
  type: z.enum(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN']),
  valuesByMode: record(variableValue, L.modes),
  description: text(L.description),
  hiddenFromPublishing: z.boolean().optional(),
  remote: remote.optional(),
});
const modeChoice = record(id, L.variableCollections);

export const designDocumentSchema = z.object({
  schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
  pages: capped(id, 'pages', 1),
  nodes: z.record(id, sceneNodeSchema),
  styles: record(style, L.styles),
  images: record(imageAsset, L.images),
  variableCollections: record(variableCollection, L.variableCollections),
  variables: record(variable, L.variables),
  variableModes: cappedRecord(modeChoice, 'nodes').optional(),
  board: z.literal(true).optional(),
});

/** One autosave or undo step. Entries are whole values; null removes. */
export const documentPatchSchema = z.object({
  nodes: cappedRecord(sceneNodeSchema.nullable(), 'nodes').optional(),
  pages: capped(id, 'pages', 1).optional(),
  styles: record(style.nullable(), L.styles).optional(),
  images: record(imageAsset.nullable(), L.images).optional(),
  variableCollections: record(variableCollection.nullable(), L.variableCollections).optional(),
  variables: record(variable.nullable(), L.variables).optional(),
  variableModes: cappedRecord(modeChoice.nullable(), 'nodes').optional(),
});

// ── Fast path ──────────────────────────────────────────────────────────────────────────────────
// zod builds a full copy of a 20 MB document with a context per field: about a second for 20 000
// nodes. The schemas above stay the single definition; `compile` turns them into plain checks that
// validate in place and drop unknown keys, as zod's default `strip` does. A value the checks refuse
// goes through zod itself for the message and path. Every zod feature used above must be handled
// here: anything else throws when this module loads, so a new kind of check is never skipped.

type Check = (value: unknown, strip: boolean) => boolean;
type Def = {typeName: string; [key: string]: any};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function compile(schema: z.ZodTypeAny): Check {
  const def = schema._def as Def;
  switch (def.typeName) {
    case 'ZodString': {
      let min = 0,
        max = Infinity;
      const patterns: RegExp[] = [];
      for (const check of def.checks)
        if (check.kind === 'min') min = check.value;
        else if (check.kind === 'max') max = check.value;
        else if (check.kind === 'regex') patterns.push(check.regex);
        else throw Error('schema: unsupported string check ' + check.kind);
      return value => {
        if (typeof value !== 'string' || value.length < min || value.length > max) return false;
        for (const pattern of patterns) {
          pattern.lastIndex = 0;
          if (!pattern.test(value)) return false;
        }
        return true;
      };
    }
    case 'ZodNumber': {
      let min = -Infinity,
        minInclusive = true,
        max = Infinity,
        maxInclusive = true,
        integer = false,
        finite = false;
      for (const check of def.checks)
        if (check.kind === 'min') [min, minInclusive] = [check.value, check.inclusive];
        else if (check.kind === 'max') [max, maxInclusive] = [check.value, check.inclusive];
        else if (check.kind === 'int') integer = true;
        else if (check.kind === 'finite') finite = true;
        else throw Error('schema: unsupported number check ' + check.kind);
      return value =>
        typeof value === 'number' &&
        !Number.isNaN(value) &&
        (!finite || Number.isFinite(value)) &&
        (!integer || Number.isInteger(value)) &&
        (minInclusive ? value >= min : value > min) &&
        (maxInclusive ? value <= max : value < max);
    }
    case 'ZodBoolean':
      return value => typeof value === 'boolean';
    case 'ZodLiteral': {
      const expected = def.value;
      return value => value === expected;
    }
    case 'ZodEnum': {
      const values = new Set<unknown>(def.values);
      return value => values.has(value);
    }
    case 'ZodOptional': {
      const inner = compile(def.innerType);
      return (value, strip) => value === undefined || inner(value, strip);
    }
    case 'ZodNullable': {
      const inner = compile(def.innerType);
      return (value, strip) => value === null || inner(value, strip);
    }
    case 'ZodArray': {
      if (def.exactLength) throw Error('schema: unsupported exact array length');
      const item = compile(def.type),
        min = def.minLength?.value ?? 0,
        max = def.maxLength?.value ?? Infinity;
      return (value, strip) => {
        if (!Array.isArray(value) || value.length < min || value.length > max) return false;
        for (let i = 0; i < value.length; i++) if (!item(value[i], strip)) return false;
        return true;
      };
    }
    case 'ZodTuple': {
      if (def.rest) throw Error('schema: unsupported tuple rest');
      const items: Check[] = def.items.map(compile);
      return (value, strip) => Array.isArray(value) && value.length === items.length && items.every((item, i) => item(value[i], strip));
    }
    case 'ZodObject': {
      if (def.unknownKeys !== 'strip' || def.catchall?._def.typeName !== 'ZodNever') throw Error('schema: only stripping objects are supported');
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      const fields = Object.entries(shape).map(([name, field]) => [name, compile(field)] as const);
      const known = new Set(Object.keys(shape));
      return (value, strip) => {
        if (!isObject(value)) return false;
        for (const [name, field] of fields) if (!field(Object.hasOwn(value, name) ? value[name] : undefined, strip)) return false;
        if (strip) for (const name of Object.keys(value)) if (!known.has(name)) delete value[name];
        return true;
      };
    }
    case 'ZodRecord': {
      const keyCheck = compile(def.keyType),
        item = compile(def.valueType);
      return (value, strip) => {
        if (!isObject(value)) return false;
        for (const name of Object.keys(value)) if (!keyCheck(name, strip) || !item(value[name], strip)) return false;
        return true;
      };
    }
    case 'ZodDiscriminatedUnion': {
      const discriminator: string = def.discriminator,
        options = new Map<unknown, Check>([...(def.optionsMap as Map<unknown, z.ZodTypeAny>)].map(([tag, option]) => [tag, compile(option)]));
      return (value, strip) => {
        if (!isObject(value)) return false;
        const option = options.get(value[discriminator]);
        return !!option && option(value, strip);
      };
    }
    case 'ZodUnion': {
      // zod keeps the first option that parses; check without stripping, then strip with that one.
      const options: Check[] = def.options.map(compile);
      return (value, strip) => {
        const option = options.find(check => check(value, false));
        return !!option && (!strip || option(value, true));
      };
    }
    case 'ZodEffects': {
      if (def.effect.type !== 'refinement') throw Error('schema: only refinements are supported');
      const inner = compile(def.schema),
        refinement = def.effect.refinement as (value: unknown, context: unknown) => unknown;
      return (value, strip) => {
        if (!inner(value, strip)) return false;
        let failed = false;
        const result = refinement(value, {addIssue: () => (failed = true), path: []});
        return !failed && result !== false;
      };
    }
    default:
      throw Error('schema: unsupported type ' + def.typeName);
  }
}
const fastDocument = compile(designDocumentSchema),
  fastPatch = compile(documentPatchSchema);

// ── Messages ───────────────────────────────────────────────────────────────────────────────────

/** The tables of a document a patch replaces entries of, and its page order. */
export const PATCH_TABLES = ['nodes', 'styles', 'images', 'variableCollections', 'variables', 'variableModes'] as const;
export type PatchTable = (typeof PATCH_TABLES)[number];
/** One entry of a document or patch a refusal is about: a node, a style, a picture... (`key` null: the table as a
 *  whole, such as the node count, or the page order). The client reverts exactly this entry (autosave recovery). */
export type PatchEntry = {table: PatchTable | 'pages'; key: string | null};
export type DesignValidation<T> = {ok: true; value: T} | {ok: false; error: string; path: string; entry?: PatchEntry};
const isPatchTable = (value: unknown): value is PatchTable => (PATCH_TABLES as readonly unknown[]).includes(value);
/** The entry a zod path (`['nodes', id, 'fills', 0]`) is about. Ids may contain dots, so this reads the path's
 *  segments, never its joined text. */
function entryOfSegments(path: readonly (string | number)[]): PatchEntry | undefined {
  if (path[0] === 'pages') return {table: 'pages', key: null};
  if (!isPatchTable(path[0])) return undefined;
  return {table: path[0], key: path.length > 1 ? String(path[1]) : null};
}

const russian: z.ZodErrorMap = issue => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return {message: issue.received === 'undefined' ? 'A required field is missing.' : 'Wrong value type.'};
    case z.ZodIssueCode.too_big:
      return {message: issue.type === 'array' ? 'Too many items.' : issue.type === 'string' ? 'The text is too long.' : 'The value is too large.'};
    case z.ZodIssueCode.too_small:
      return {message: issue.type === 'array' ? 'Too few items.' : issue.type === 'string' ? 'Empty value.' : 'The value is too small.'};
    case z.ZodIssueCode.invalid_enum_value:
    case z.ZodIssueCode.invalid_literal:
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.invalid_union_discriminator:
      return {message: 'Invalid value.'};
    case z.ZodIssueCode.not_finite:
      return {message: 'The number must be finite.'};
    case z.ZodIssueCode.invalid_string:
      return {message: 'Invalid characters.'};
    case z.ZodIssueCode.custom:
      return {message: issue.message ?? 'Invalid value.'};
    default:
      return {message: 'Invalid value.'};
  }
};
const pathOf = (path: readonly (string | number)[]) => path.join('.');
/** The fast checks first (in place); zod only to explain a refusal. */
function parsed<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, fast: Check, value: unknown): DesignValidation<T> {
  if (fast(value, true)) return {ok: true, value: value as T};
  const result = schema.safeParse(value, {errorMap: russian});
  if (result.success) return {ok: true, value: result.data};
  const issue = result.error.issues[0];
  const entry = entryOfSegments(issue?.path ?? []);
  return {ok: false, error: issue?.message ?? 'Invalid value.', path: pathOf(issue?.path ?? []), ...(entry ? {entry} : {})};
}
class Invalid extends Error {
  entry?: PatchEntry;
  constructor(
    message: string,
    readonly path: string,
    entry?: PatchEntry,
  ) {
    super(message);
    if (entry) this.entry = entry;
  }
}
const nodeEntry = (key: string): PatchEntry => ({table: 'nodes', key});
/** Runs one node's checks; a refusal without an entry is about that node. */
function forNode(nodeId: string, run: () => void) {
  try {
    run();
  } catch (error) {
    if (error instanceof Invalid && !error.entry) error.entry = nodeEntry(nodeId);
    throw error;
  }
}
const failure = (error: Invalid) => ({ok: false as const, error: error.message, path: error.path, ...(error.entry ? {entry: error.entry} : {})});
const invalid = (message: string, path: string, entry?: PatchEntry): never => {
  throw new Invalid(message, path, entry);
};

// ── Invariants ─────────────────────────────────────────────────────────────────────────────────

const CONTAINERS = new Set<string>(CONTAINER_TYPES);
const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/** What a node of its type must carry, and its text runs. */
function checkNode(node: SceneNode, path: string) {
  const container = CONTAINERS.has(node.type);
  if (container && !Array.isArray(node.children)) invalid('The container has no layer list.', path + '.children');
  if (!container && node.children !== undefined) invalid('This layer cannot have nested layers.', path + '.children');
  if ((node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION') && !node.children!.length)
    invalid('A group must contain at least one layer.', path + '.children');
  if (node.type === 'PAGE' ? node.parentId !== null : node.parentId === null)
    invalid(node.type === 'PAGE' ? 'A page cannot be nested.' : 'The layer has no parent.', path + '.parentId');
  if (node.type === 'TEXT') {
    if (!node.text) invalid('The text layer has no text.', path + '.text');
    const length = node.text!.characters.length;
    let end = 0;
    node.text!.runs.forEach((run, i) => {
      if (run.start < end || run.end <= run.start || run.end > length)
        invalid('Text runs overlap or go beyond the text.', `${path}.text.runs.${i}`);
      end = run.end;
    });
  } else if (node.text !== undefined) invalid('Only a text layer has text.', path + '.text');
  if (node.textPath !== undefined && node.type !== 'TEXT') invalid('Only a text layer has a text path.', path + '.textPath');
  if (node.measurements !== undefined && node.type !== 'PAGE') invalid('Only a page stores measurements.', path + '.measurements');
  if (node.annotations !== undefined && node.type === 'PAGE') invalid('A page has no annotations.', path + '.annotations');
  // Co-editing merges these lists entry by entry (shared/design/merge.ts): an id stands once in its list.
  for (const field of ['annotations', 'measurements'] as const) {
    const entries = node[field];
    if (entries && new Set(entries.map(entry => entry.id)).size !== entries.length) invalid('Duplicate identifier in the list.', `${path}.${field}`);
  }
  if (node.vectorPaths) {
    let commands = 0;
    for (const vector of node.vectorPaths) commands += vector.commands.length;
    if (commands > L.pathCommands) invalid('The path is too complex.', path + '.vectorPaths');
  }
  if (node.id.includes(';') !== (node.mainId !== undefined))
    invalid('An instance layer must refer to a component layer.', path + '.mainId');
  // The hidden library page holds only copies of library components, and only they carry `remote` (docs/design-tool.md §Teams).
  if (node.parentId === LIBRARY_PAGE_ID && (!node.remote || (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET')))
    invalid('Only components from libraries live on the libraries page.', path + '.parentId');
  if (node.remote !== undefined && node.parentId !== LIBRARY_PAGE_ID) invalid('A library component lives only on the libraries page.', path + '.remote');
}

/** A node inside an instance is `${instanceId};${mainId}` for one of its INSTANCE ancestors. Walks up at
 * most `depth` steps; also proves the chain reaches a page without a cycle. */
function checkAncestry(nodes: Record<string, SceneNode>, node: SceneNode, path: string) {
  let instance = node.mainId === undefined;
  let current = node,
    steps = 0;
  while (current.parentId !== null) {
    if (++steps > L.depth) invalid('Nesting is too deep or the layers form a cycle.', path + '.parentId');
    const parent = own(nodes, current.parentId);
    if (!parent) return invalid('The layer\'s parent was not found.', path + '.parentId');
    if (!instance && parent.type === 'INSTANCE' && node.id === parent.id + ';' + node.mainId) instance = true;
    current = parent;
  }
  if (current.type !== 'PAGE') invalid('The layer is not on a page.', path + '.parentId');
  if (!instance) invalid('An instance layer lies outside its instance.', path + '.mainId');
  return steps;
}

/** How often each id stands in a node's children list, counted once per node and check: a frame may hold tens
 *  of thousands of layers, and scanning its list for each of them made a check quadratic (seconds of blocked
 *  event loop for one request). */
type Listing = (parentId: string) => ReadonlyMap<string, number> | undefined;
function listing(nodes: Record<string, SceneNode>): Listing {
  const cache = new Map<string, Map<string, number>>();
  return parentId => {
    let counts = cache.get(parentId);
    if (!counts) {
      const parent = own(nodes, parentId);
      if (!parent) return undefined;
      counts = new Map();
      for (const child of parent.children ?? []) counts.set(child, (counts.get(child) ?? 0) + 1);
      cache.set(parentId, counts);
    }
    return counts;
  };
}
const listedIn = (listed: Listing, parentId: string, id: string) => listed(parentId)?.get(id) ?? 0;

/** The node's own place: its parent lists it exactly once, its children name it as parent. */
function checkLinks(nodes: Record<string, SceneNode>, node: SceneNode, path: string, listed: Listing) {
  if (node.parentId !== null) {
    const parent = own(nodes, node.parentId);
    if (!parent) invalid('The layer\'s parent was not found.', path + '.parentId');
    if (listedIn(listed, node.parentId, node.id) !== 1) invalid('A layer must appear in its parent\'s list exactly once.', path + '.parentId');
  }
  if (node.children) {
    const seen = new Set<string>();
    node.children.forEach((childId, i) => {
      const child = own(nodes, childId);
      if (!child || child.parentId !== node.id || seen.has(childId))
        invalid('The layer list does not match the layer parents.', `${path}.children.${i}`);
      seen.add(childId);
    });
  }
}

function checkPages(doc: DesignDocument) {
  const seen = new Set<string>();
  doc.pages.forEach((pageId, i) => {
    const page = own(doc.nodes, pageId);
    if (!page || page.type !== 'PAGE' || seen.has(pageId) || pageId === LIBRARY_PAGE_ID) invalid('The page list does not match the file\'s pages.', 'pages.' + i, PAGES);
    seen.add(pageId);
  });
  return seen;
}
const PAGES: PatchEntry = {table: 'pages', key: null};

function checkTables(doc: DesignDocument) {
  for (const [table, map] of [['styles', doc.styles], ['variableCollections', doc.variableCollections], ['variables', doc.variables]] as const)
    for (const [entry, value] of Object.entries(map as Record<string, {id: string}>))
      if (value.id !== entry) invalid('The entry key does not match its identifier.', `${table}.${entry}.id`, {table, key: entry});
}

/** Every invariant of docs/design-tool.md §The document over a schema-valid document. Iterative: no
 * recursion over the tree, so a hostile nesting depth cannot exhaust the stack. */
function checkDocument(doc: DesignDocument) {
  const ids = Object.keys(doc.nodes);
  const caps = documentCaps();
  if (ids.length > caps.nodes) invalid(tooManyLayersMessage(ids.length, caps), 'nodes', {table: 'nodes', key: null});
  checkTables(doc);
  const pages = checkPages(doc);
  const listed = listing(doc.nodes);
  for (const nodeId of ids)
    forNode(nodeId, () => {
      const node = doc.nodes[nodeId],
        path = 'nodes.' + nodeId;
      if (node.id !== nodeId) invalid('The layer key does not match its identifier.', path + '.id');
      checkNode(node, path);
      if (node.type === 'PAGE' && !pages.has(nodeId) && nodeId !== LIBRARY_PAGE_ID) invalid('The page is not in the page list.', path);
      checkLinks(doc.nodes, node, path, listed);
    });
  // Every node reachable from a page (the hidden library page included): with consistent links this rules out cycles.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const pageId of own(doc.nodes, LIBRARY_PAGE_ID)?.type === 'PAGE' ? [...doc.pages, LIBRARY_PAGE_ID] : doc.pages) {
    depth.set(pageId, 0);
    queue.push(pageId);
  }
  for (let at = 0; at < queue.length; at++) {
    const nodeId = queue[at],
      level = depth.get(nodeId)!;
    for (const child of doc.nodes[nodeId].children ?? []) {
      if (level + 1 > L.depth) invalid('Layer nesting is too deep.', 'nodes.' + child, nodeEntry(child));
      depth.set(child, level + 1);
      queue.push(child);
    }
  }
  if (queue.length !== ids.length) {
    const lost = ids.find(nodeId => !depth.has(nodeId))!;
    invalid('The layer is not linked to any page.', 'nodes.' + lost + '.parentId', nodeEntry(lost));
  }
  for (const nodeId of ids) if (doc.nodes[nodeId].mainId !== undefined) forNode(nodeId, () => checkAncestry(doc.nodes, doc.nodes[nodeId], 'nodes.' + nodeId));
}

/** A whole document: shape, bounds, then every structural invariant. The value is a stripped copy. A refusal names
 *  its `path` and, when it is about one entry (a node, a style...), that `entry`. */
export function validateDocument(value: unknown): DesignValidation<DesignDocument> {
  const shape = parsed(designDocumentSchema, fastDocument, value);
  if (!shape.ok) return shape;
  const doc = shape.value as unknown as DesignDocument;
  try {
    checkDocument(doc);
  } catch (error) {
    if (error instanceof Invalid) return failure(error);
    throw error;
  }
  return {ok: true, value: doc};
}

/** The shape and bounds of a patch's entries (no document needed). Unknown keys are dropped in place. */
export function validatePatch(value: unknown): DesignValidation<DocumentPatch> {
  return parsed(documentPatchSchema, fastPatch, value) as DesignValidation<DocumentPatch>;
}

// ── Entries of a patch, one by one (the editor's autosave guard) ─────────────────────────────────

/** Why one entry of a patch would be refused. */
export type PatchIssue = PatchEntry & {error: string; path: string};

const entryKey = compile(id);
const ENTRY_SCHEMAS: Record<PatchTable, [z.ZodTypeAny, number | (() => number)]> = {
  nodes: [sceneNodeSchema.nullable(), () => documentCaps().nodes],
  styles: [style.nullable(), L.styles],
  images: [imageAsset.nullable(), L.images],
  variableCollections: [variableCollection.nullable(), L.variableCollections],
  variables: [variable.nullable(), L.variables],
  variableModes: [modeChoice.nullable(), () => documentCaps().nodes],
};
const ENTRY_CHECKS = Object.fromEntries(Object.entries(ENTRY_SCHEMAS).map(([table, [schema]]) => [table, compile(schema)])) as Record<PatchTable, Check>;
const pageOrderSchema = capped(id, 'pages', 1);
const pageOrder = compile(pageOrderSchema);

/** One message for a value the fast check refused: zod's first issue on that value alone. */
function explain(schema: z.ZodTypeAny, value: unknown, prefix: (string | number)[]): {error: string; path: string} {
  const result = schema.safeParse(value, {errorMap: russian});
  const issue = result.success ? undefined : result.error.issues[0];
  return {error: issue?.message ?? 'Invalid value.', path: pathOf([...prefix, ...(issue?.path ?? [])])};
}

/**
 * Every entry of `patch` the schema refuses, each with its message and path, without changing the patch (no keys
 * are dropped: the editor's documents are never written to). The same checks as `validatePatch`, entry by entry, so
 * a caller can keep the rest; the cost grows with the patch, never with the document.
 */
export function patchIssues(patch: DocumentPatch): PatchIssue[] {
  const issues: PatchIssue[] = [];
  const raw = patch as Record<string, unknown>;
  if (raw.pages !== undefined && !pageOrder(raw.pages, false))
    issues.push({table: 'pages', key: null, ...explain(pageOrderSchema, raw.pages, ['pages'])});
  for (const table of PATCH_TABLES) {
    const changes = raw[table];
    if (changes === undefined) continue;
    if (!isObject(changes)) {
      issues.push({table, key: null, error: 'Wrong value type.', path: table});
      continue;
    }
    const keys = Object.keys(changes);
    const [schema, cap] = ENTRY_SCHEMAS[table];
    const max = typeof cap === 'function' ? cap() : cap;
    if (keys.length > max) issues.push({table, key: null, error: `No more than ${max} entries.`, path: table});
    const check = ENTRY_CHECKS[table];
    for (const key of keys) {
      if (!entryKey(key, false)) issues.push({table, key, error: 'Invalid identifier.', path: `${table}.${key}`});
      else if (!check(changes[key], false)) issues.push({table, key, ...explain(schema, changes[key], [table, key])});
    }
  }
  return issues;
}

// ── A patch's invariants ─────────────────────────────────────────────────────────────────────────

/** What the invariants of a patch read of the document it was made on: its page order and its nodes. */
export type PatchBase = {readonly pages: readonly NodeId[]; node(id: NodeId): SceneNode | undefined};
const baseOf = (doc: DesignDocument): PatchBase => ({pages: doc.pages, node: id => own(doc.nodes, id)});

/** The invariants a patch could have broken, checked on the nodes it touched: `after` is
 * `applyPatch(before, patch)` and `before` was valid. Cost grows with the patch, not the file
 * (plus one count of the node keys unless the caller keeps it, `nodeCount`, and the subtrees of
 * nodes that moved to another parent). */
export function checkPatchedDocument(before: DesignDocument, after: DesignDocument, patch: DocumentPatch, nodeCount?: () => number): DesignValidation<DesignDocument> {
  const issues = patchedIssues(baseOf(before), after, patch, 1, nodeCount);
  return issues.length ? failure(issues[0]) : {ok: true, value: after};
}

/**
 * Every entry of a patch whose invariants fail (at most `limit`), each named by the entry it is about: a node
 * check that trips over a neighbour still names the patched node, the one a client can put back. `before` reads
 * the document the patch was made on (the editor's last saved state), `after` is it with the patch applied.
 * `nodeCount`: the layers of `after` when the caller keeps count (counting a 20 000-layer table takes milliseconds).
 */
export function patchedDocumentIssues(before: PatchBase, after: DesignDocument, patch: DocumentPatch, options: {limit?: number; nodeCount?: () => number} = {}): PatchIssue[] {
  return patchedIssues(before, after, patch, options.limit ?? 100, options.nodeCount).map(error => ({...(error.entry ?? {table: 'nodes' as const, key: null}), error: error.message, path: error.path}));
}

const ENOUGH = Symbol('enough');
function patchedIssues(before: PatchBase, after: DesignDocument, patch: DocumentPatch, limit: number, count: (() => number) | undefined): Invalid[] {
  const found: Invalid[] = [];
  const attempt = (entry: PatchEntry | null, run: () => void) => {
    try {
      run();
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      if (entry) error.entry = entry;
      found.push(error);
      if (found.length >= limit) throw ENOUGH;
    }
  };
  try {
    attempt(null, () => {
      const nodeCount = patch.nodes ? (count ? count() : Object.keys(after.nodes).length) : 0;
      const caps = documentCaps();
      if (nodeCount > caps.nodes) invalid(tooManyLayersMessage(nodeCount, caps), 'nodes', {table: 'nodes', key: null});
    });
    for (const [table, changes] of [['styles', patch.styles], ['variableCollections', patch.variableCollections], ['variables', patch.variables]] as const)
      for (const [entry, value] of Object.entries((changes ?? {}) as Record<string, {id: string} | null>))
        if (value && value.id !== entry) attempt({table, key: entry}, () => invalid('The entry key does not match its identifier.', `${table}.${entry}.id`));
    let pages = new Set(after.pages);
    if (patch.pages)
      attempt(PAGES, () => {
        pages = checkPages(after);
        if (pages.size !== after.pages.length) invalid('Pages are repeated.', 'pages');
        for (const pageId of before.pages) if (!pages.has(pageId) && own(after.nodes, pageId)) invalid('The page is not in the page list.', 'nodes.' + pageId);
      });
    const listed = listing(after.nodes);
    // Nodes whose depth and instance ancestry were checked with a moved subtree: each once, however many of its
    // ancestors the patch moved.
    const walked = new Set<string>();
    for (const [nodeId, value] of Object.entries(patch.nodes ?? {}))
      attempt(nodeEntry(nodeId), () => {
        const path = 'nodes.' + nodeId,
          previous = before.node(nodeId);
        if (value === null) {
          if (pages.has(nodeId)) invalid('A deleted page is still in the page list.', 'pages');
          if (previous?.parentId != null && listedIn(listed, previous.parentId, nodeId))
            invalid('A deleted layer is still in its parent\'s list.', path);
          for (const child of previous?.children ?? []) {
            const kept = own(after.nodes, child);
            if (kept && kept.parentId === nodeId) invalid('A deleted layer still has nested layers.', 'nodes.' + child);
          }
          return;
        }
        const node = after.nodes[nodeId];
        if (node.id !== nodeId) invalid('The layer key does not match its identifier.', path + '.id');
        checkNode(node, path);
        if (node.type === 'PAGE' && !pages.has(nodeId) && nodeId !== LIBRARY_PAGE_ID) invalid('The page is not in the page list.', path);
        if (node.type !== 'PAGE' && pages.has(nodeId)) invalid('The page list does not match the file\'s pages.', 'pages');
        checkLinks(after.nodes, node, path, listed);
        // Leaving a parent: the old parent must have let go of it.
        if (previous && previous.parentId !== null && previous.parentId !== node.parentId && listedIn(listed, previous.parentId, nodeId))
          invalid('The layer is still in its former parent\'s list.', path + '.parentId');
        // Children it no longer lists must have moved elsewhere.
        for (const child of previous?.children ?? []) {
          const kept = own(after.nodes, child);
          if (kept && kept.parentId === nodeId && !listedIn(listed, nodeId, child)) invalid('The layer list does not match the layer parents.', 'nodes.' + child);
        }
        const level = node.type === 'PAGE' ? 0 : checkAncestry(after.nodes, node, path);
        // A subtree that moved under another parent, or whose root changed type (an instance that stopped being
        // one): its depth changed with it, and its instance copies must still lie under their instance.
        if (previous && (previous.parentId !== node.parentId || previous.type !== node.type) && node.children?.length) {
          const queue: [string, number][] = node.children.map(child => [child, level + 1]);
          for (let at = 0; at < queue.length; at++) {
            const [childId, childLevel] = queue[at];
            if (walked.has(childId)) continue;
            walked.add(childId);
            if (childLevel > L.depth) invalid('Layer nesting is too deep.', 'nodes.' + childId);
            const child = own(after.nodes, childId);
            if (child?.mainId !== undefined) checkAncestry(after.nodes, child, 'nodes.' + childId);
            for (const grandchild of child?.children ?? []) queue.push([grandchild, childLevel + 1]);
          }
        }
      });
  } catch (error) {
    if (error !== ENOUGH) throw error;
  }
  return found;
}

/** Every picture URL a document points at, for the owner check. */
export const documentImageUrls = (doc: Pick<DesignDocument, 'images'>) => [...new Set(Object.values(doc.images).map(asset => asset.url))];
/** Filenames of those pictures (`/uploads/<file>` → `<file>`). */
export const documentImageFiles = (doc: Pick<DesignDocument, 'images'>) => documentImageUrls(doc).map(url => url.slice('/uploads/'.length));
