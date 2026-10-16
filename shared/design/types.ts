// "Morfa": the document model of the vector design tool (docs/design-tool.md).
//
// One file is a flat map of nodes keyed by id. Pages are the roots; every other node names its
// parent and every container lists its children bottom-to-top (index 0 is drawn first, the
// layers panel shows the list reversed). Names and semantics follow Figma's plugin API wherever
// that is practical, so a Figma file maps onto it field by field and designers find the same
// controls. This module is types only: no runtime code, safe to import from anywhere.

import type {BoardMeta} from './board/types';

export type NodeId = string;
export type StyleId = string;
export type ImageRef = string;
export type VariableId = string;

/** Channels are 0..1, as in Figma. A solid paint keeps its alpha in `Paint.opacity`. */
export type RGB = {r: number; g: number; b: number};
export type RGBA = RGB & {a: number};
export type Vec = {x: number; y: number};
/** Row-major 2×3 affine matrix [[a, c, e], [b, d, f]]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [[number, number, number], [number, number, number]];

export type BlendMode =
  | 'PASS_THROUGH' | 'NORMAL' | 'DARKEN' | 'MULTIPLY' | 'COLOR_BURN' | 'LIGHTEN' | 'SCREEN' | 'COLOR_DODGE'
  | 'OVERLAY' | 'SOFT_LIGHT' | 'HARD_LIGHT' | 'DIFFERENCE' | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY';

// ── Paints ─────────────────────────────────────────────────────────────────────────────────────

export type ColorStop = {position: number; color: RGBA};
export type GradientType = 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
export type ImageScaleMode = 'FILL' | 'FIT' | 'CROP' | 'TILE';
/** Each −1..1, 0 is neutral. */
export type ImageFilters = {exposure?: number; contrast?: number; saturation?: number; temperature?: number; tint?: number; highlights?: number; shadows?: number};
/** A field of a node or paint bound to a variable (shared/design/types.ts `Variable`). */
export type VariableAlias = {type: 'VARIABLE_ALIAS'; id: VariableId};

type PaintBase = {
  /** 0..1, multiplies the paint. Default 1. */
  opacity: number;
  visible: boolean;
  blendMode: BlendMode;
};
export type SolidPaint = PaintBase & {type: 'SOLID'; color: RGB; boundVariables?: {color?: VariableAlias}};
export type GradientPaint = PaintBase & {
  type: GradientType;
  gradientStops: ColorStop[];
  /** Three handles in the node's unit box (0..1 of width/height), as in Figma's REST API:
   *  [0] start/centre, [1] end (the gradient's main axis), [2] the perpendicular width handle. */
  gradientHandlePositions: [Vec, Vec, Vec];
};
export type ImagePaint = PaintBase & {
  type: 'IMAGE';
  /** Key into `DesignDocument.images`; empty while an upload is pending. */
  imageRef: ImageRef;
  scaleMode: ImageScaleMode;
  /** CROP: maps the node's unit box into the image's unit box (Figma's `imageTransform`). */
  imageTransform?: Matrix;
  /** TILE: tile size as a fraction of the image's natural size. Default 1. */
  scalingFactor?: number;
  /** Quarter turns: 0, 90, 180 or 270. */
  rotation?: number;
  filters?: ImageFilters;
};
export type Paint = SolidPaint | GradientPaint | ImagePaint;

// ── Strokes, corners, effects ──────────────────────────────────────────────────────────────────

export type StrokeAlign = 'INSIDE' | 'CENTER' | 'OUTSIDE';
export type StrokeCap = 'NONE' | 'ROUND' | 'SQUARE';
/** What a LINE or open VECTOR path draws at its first/last point. */
export type StrokeMarker = 'NONE' | 'LINE_ARROW' | 'TRIANGLE_ARROW' | 'REVERSED_TRIANGLE' | 'CIRCLE' | 'DIAMOND' | 'ROUND' | 'SQUARE';
export type StrokeJoin = 'MITER' | 'BEVEL' | 'ROUND';
export type IndividualStrokeWeights = {top: number; right: number; bottom: number; left: number};
/** "Width profile" (Figma's `widthProfile`): how the width of an open path's stroke changes along it
 *  (shared/design/stroke-profile.ts holds each preset's points). CUSTOM uses `variableWidthPoints`. */
export type StrokeWidthProfile = 'UNIFORM' | 'WEDGE' | 'TAPER' | 'QUARTER_TAPER' | 'EYE' | 'MIRRORED_TAPER' | 'CUSTOM';
/** `position` 0..1 along the path, `width` a fraction of `strokeWeight` there (Figma's VariableWidthPoint). */
export type VariableWidthPoint = {position: number; width: number};
export type VariableWidthStrokeProperties = {widthProfile: StrokeWidthProfile; variableWidthPoints?: VariableWidthPoint[]};

export type ShadowEffect = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGBA;
  offset: Vec;
  /** Blur radius in px. */
  radius: number;
  spread: number;
  visible: boolean;
  blendMode: BlendMode;
  /** DROP_SHADOW only: draw the shadow under transparent parts of the node too. Default false. */
  showShadowBehindNode?: boolean;
};
export type BlurEffect = {type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number; visible: boolean};
export type Effect = ShadowEffect | BlurEffect;

// ── Layout ─────────────────────────────────────────────────────────────────────────────────────

export type ConstraintType = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE';
export type Constraints = {horizontal: ConstraintType; vertical: ConstraintType};

export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
export type LayoutSizing = 'FIXED' | 'HUG' | 'FILL';
export type LayoutAlign = 'MIN' | 'CENTER' | 'MAX';
/** The auto-layout properties of a frame-like node (FRAME, COMPONENT, COMPONENT_SET, INSTANCE). */
export type AutoLayout = {
  layoutMode: LayoutMode;
  layoutWrap: 'NO_WRAP' | 'WRAP';
  primaryAxisAlignItems: LayoutAlign | 'SPACE_BETWEEN';
  counterAxisAlignItems: LayoutAlign | 'BASELINE';
  /** WRAP only: how the rows share the cross axis. */
  counterAxisAlignContent: 'AUTO' | 'SPACE_BETWEEN';
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  itemSpacing: number;
  /** WRAP only: the gap between rows. */
  counterAxisSpacing: number;
  /** Later children are drawn below earlier ones ("First on top"). */
  itemReverseZIndex: boolean;
  strokesIncludedInLayout: boolean;
};

/** One row or column of a grid auto-layout frame (Figma's GridTrackSize): FIXED is `value` px, FLEX a share of what is
 *  left by `value` (CSS `fr`; 1 when absent), HUG the largest child in the track. */
export type GridTrackSize = {type: 'FIXED' | 'FLEX' | 'HUG'; value?: number};
/** Figma's grid auto layout, on a frame whose `autoLayout.layoutMode` is 'GRID' (its paddings, `itemReverseZIndex` and
 *  `strokesIncludedInLayout` still come from `autoLayout`; the flex-only fields there are kept and ignored). The names are
 *  Figma's plugin-API names without the `grid` prefix: `rowCount` is `gridRowCount`, `autoTracks` is `gridAutoTracks`.
 *  A GRID frame without this object lays out as one FLEX cell with no gaps. */
export type GridLayout = {
  /** Tracks on each axis, ≥ 1. With `autoTracks: 'ROWS'` the row count is derived from the children (this one is the
   *  count to return to under 'NONE'); the layout never writes either. */
  rowCount: number;
  columnCount: number;
  rowGap: number;
  columnGap: number;
  /** One entry per track, top to bottom and left to right; a missing entry reads as `{type: 'FLEX'}`, extra entries are
   *  ignored (two people may edit the count and the sizes at once). On an axis the frame hugs, FLEX tracks size as HUG. */
  rowSizes: GridTrackSize[];
  columnSizes: GridTrackSize[];
  /** 'ROWS': rows appear as children need them and empty rows go (Figma's "Auto" rows). */
  autoTracks: 'NONE' | 'ROWS';
  /** 'ROW_AUTO_FLOW': children fill the cells in layer order, row by row (`grid-auto-flow: row`, sparse); 'MANUAL':
   *  each child sits where its `gridChild` anchors say. */
  itemsPositioning: 'MANUAL' | 'ROW_AUTO_FLOW';
};
export type GridChildAlign = 'MIN' | 'CENTER' | 'MAX' | 'AUTO';
/** A child of a GRID frame: its cell (Figma's `gridRowAnchorIndex` / `gridColumnAnchorIndex`, 0-based, read only under
 *  `itemsPositioning: 'MANUAL'`; the layout derives the cell otherwise and never writes it), its spans (`gridRowSpan` /
 *  `gridColumnSpan`, ≥ 1, 1 when absent) and how it sits in its cells when it does not FILL them (`gridChildHorizontalAlign`
 *  / `gridChildVerticalAlign`; AUTO = MIN). */
export type GridChild = {
  rowAnchorIndex?: number;
  columnAnchorIndex?: number;
  rowSpan?: number;
  columnSpan?: number;
  horizontalAlign?: GridChildAlign;
  verticalAlign?: GridChildAlign;
};

export type LayoutGrid =
  | {pattern: 'GRID'; sectionSize: number; visible: boolean; color: RGBA}
  | {pattern: 'COLUMNS' | 'ROWS'; alignment: 'MIN' | 'MAX' | 'CENTER' | 'STRETCH'; count: number; gutterSize: number; offset: number; sectionSize: number; visible: boolean; color: RGBA};

export type Guide = {axis: 'X' | 'Y'; offset: number};

// ── Text ───────────────────────────────────────────────────────────────────────────────────────

export type LineHeight = {unit: 'AUTO'} | {unit: 'PIXELS' | 'PERCENT'; value: number};
export type LetterSpacing = {unit: 'PIXELS' | 'PERCENT'; value: number};
export type TextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS';
export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
export type Hyperlink = {type: 'URL'; url: string} | {type: 'NODE'; nodeId: NodeId};

/** Character-level typography. A text node carries a full base style; runs override parts of it. */
export type TextStyle = {
  /** Family name as shown in the font menu, e.g. "Inter". */
  fontFamily: string;
  /** 100..900. */
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  textDecoration: TextDecoration;
  textCase: TextCase;
  hyperlink?: Hyperlink | null;
};
/** A styled range of `characters`, end exclusive, in UTF-16 code units. Runs never overlap and are sorted. */
export type TextRun = {start: number; end: number; style: Partial<TextStyle>; fills?: Paint[]; textStyleId?: StyleId};
export type ListType = 'NONE' | 'ORDERED' | 'UNORDERED';
export type TextAutoResize = 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
export type TextProps = {
  characters: string;
  style: TextStyle;
  runs: TextRun[];
  textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textAlignVertical: 'TOP' | 'CENTER' | 'BOTTOM';
  textAutoResize: TextAutoResize;
  paragraphSpacing: number;
  paragraphIndent: number;
  /** One entry per paragraph (split on "\n"); missing entries are 'NONE'. */
  listTypes?: ListType[];
  /** TRUNCATE: lines kept before the ellipsis; absent = as many as fit. */
  maxLines?: number | null;
};

/** "Text on path" (Figma's TEXT_PATH): a TEXT layer whose lines follow a path instead of standing in a box
 *  (shared/design/text-path.ts places the glyphs; every renderer and exporter uses it). The lines are never wrapped;
 *  `textAlignHorizontal` places them along the path around `startOffset` (LEFT starts there, CENTER is centred on it,
 *  RIGHT ends there) and `textAlignVertical` across it (TOP: the text hangs below the path, CENTER: centred on it,
 *  BOTTOM: the last line's baseline stands on it). */
export type TextPathData = {
  /** The path in the layer's local box, as a VECTOR's: resizing the layer scales it. Only its first subpath carries text. */
  commands: PathCommand[];
  /** 0..1 of the path's length. */
  startOffset: number;
  /** RIGHT: the text runs on the path's other side, the path read backwards (SVG 2's `side="right"`). */
  side: 'LEFT' | 'RIGHT';
};

// ── Dev annotations and measurements ───────────────────────────────────────────────────────────

/** A property of the annotated layer shown on its annotation, read live from the layer (Figma's AnnotationProperty). */
export type AnnotationPropertyType =
  | 'width' | 'height' | 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight'
  | 'fills' | 'strokes' | 'strokeWeight' | 'cornerRadius' | 'effects' | 'opacity'
  | 'textStyleId' | 'fontFamily' | 'fontStyle' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'letterSpacing' | 'textAlignHorizontal'
  | 'layoutMode' | 'itemSpacing' | 'padding' | 'alignItems' | 'mainComponent';
/** "Annotation" (Y): a note for developers pinned to a layer, with an optional category (shared/design/annotations.ts
 *  `ANNOTATION_CATEGORIES`) and properties of the layer it shows. `id` is unique on its layer. */
export type Annotation = {id: string; label: string; categoryId?: string; properties?: {type: AnnotationPropertyType}[]};
export type MeasurementSide = 'TOP' | 'RIGHT' | 'BOTTOM' | 'LEFT';
/** "Measurement" (⇧M): a pinned distance between two parallel edges of layers on the page, or of one layer (its width or
 *  height), as Figma's Dev Mode measurement. INNER: the line runs across the start layer at `relative` (0..1) of its
 *  side; OUTER: `fixed` px outside the start layer (positive: away from its box). `freeText` replaces the number shown. */
export type Measurement = {
  id: string;
  start: {nodeId: NodeId; side: MeasurementSide};
  end: {nodeId: NodeId; side: MeasurementSide};
  offset: {type: 'INNER'; relative: number} | {type: 'OUTER'; fixed: number};
  freeText?: string;
};

// ── Vectors ────────────────────────────────────────────────────────────────────────────────────

export type WindingRule = 'NONZERO' | 'EVENODD';
/** Absolute commands in the node's local box. Arcs are converted to cubics on import. */
export type PathCommand =
  | {type: 'M'; x: number; y: number}
  | {type: 'L'; x: number; y: number}
  | {type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number}
  | {type: 'Q'; x1: number; y1: number; x: number; y: number}
  | {type: 'Z'};
export type VectorPath = {windingRule: WindingRule; commands: PathCommand[]};
export type BooleanOperation = 'UNION' | 'INTERSECT' | 'SUBTRACT' | 'EXCLUDE';
export type ArcData = {
  /** Radians, clockwise from 3 o'clock. A full ellipse is 0 → 2π. */
  startingAngle: number;
  endingAngle: number;
  /** 0..1 of the radius; > 0 makes a ring or a donut slice. */
  innerRadius: number;
};

// ── Prototyping ────────────────────────────────────────────────────────────────────────────────

export type Trigger =
  | {type: 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'ON_DRAG' | 'MOUSE_ENTER' | 'MOUSE_LEAVE' | 'MOUSE_DOWN' | 'MOUSE_UP'}
  /** `timeout` in seconds, as in Figma. */
  | {type: 'AFTER_TIMEOUT'; timeout: number}
  | {type: 'ON_KEY_DOWN'; keyCode: string};
export type Easing = 'LINEAR' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_AND_OUT' | 'EASE_IN_BACK' | 'EASE_OUT_BACK' | 'GENTLE' | 'QUICK' | 'BOUNCY' | 'SLOW';
export type TransitionDirection = 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';
/** `duration` is in seconds, as in Figma's API (0.3 = 300 ms); panels show milliseconds. */
export type Transition =
  | {type: 'INSTANT'}
  | {type: 'DISSOLVE' | 'SMART_ANIMATE'; duration: number; easing: Easing}
  | {type: 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT'; direction: TransitionDirection; matchLayers?: boolean; duration: number; easing: Easing};
export type OverlayPosition = 'CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT' | 'MANUAL';
export type Action =
  | {type: 'NODE'; navigation: 'NAVIGATE' | 'OVERLAY' | 'SWAP' | 'SCROLL_TO' | 'CHANGE_TO'; destinationId: NodeId; transition: Transition; preserveScrollPosition?: boolean; resetScrollPosition?: boolean; overlayRelativePosition?: Vec}
  | {type: 'BACK'}
  | {type: 'CLOSE'}
  /** http(s) and mailto only; the player opens it with noopener. */
  | {type: 'URL'; url: string; openInNewTab: boolean};
export type Reaction = {trigger: Trigger; actions: Action[]};
export type OverflowDirection = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH';
export type FlowStartingPoint = {nodeId: NodeId; name: string};
export type PrototypeDevice = {type: 'NONE'} | {type: 'PRESET'; presetId: string; rotation: 0 | 90};

// ── Export ─────────────────────────────────────────────────────────────────────────────────────

export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF' | 'WEBP';
export type ExportSetting = {
  format: ExportFormat;
  suffix: string;
  constraint: {type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number};
  /** SVG: each layer's element carries the layer's name as its `id` (Figma's "Include "id" attribute"). */
  svgIdAttribute?: boolean;
};

// ── Components ─────────────────────────────────────────────────────────────────────────────────

export type ComponentPropertyType = 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP' | 'VARIANT';
export type ComponentPropertyDefinition = {
  type: ComponentPropertyType;
  /** BOOLEAN: boolean; TEXT: string; INSTANCE_SWAP: component id; VARIANT: one of `variantOptions`. */
  defaultValue: string | boolean;
  variantOptions?: string[];
  /** INSTANCE_SWAP: components offered first in the swap menu. */
  preferredValues?: NodeId[];
};
/** Which node field a component property drives: visible (BOOLEAN), characters (TEXT), mainComponent (INSTANCE_SWAP).
 *  Values are property keys of the owning component's `componentPropertyDefinitions`. */
export type ComponentPropertyReferences = {visible?: string; characters?: string; mainComponent?: string};

// ── Nodes ──────────────────────────────────────────────────────────────────────────────────────

export type NodeType =
  | 'PAGE' | 'FRAME' | 'GROUP' | 'SECTION' | 'COMPONENT' | 'COMPONENT_SET' | 'INSTANCE' | 'BOOLEAN_OPERATION'
  | 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR' | 'VECTOR' | 'TEXT' | 'SLICE';

/** Containers own `children`. GROUP and BOOLEAN_OPERATION always fit their box to their children. */
export const CONTAINER_TYPES: readonly NodeType[] = ['PAGE', 'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'BOOLEAN_OPERATION'];
/** Frame-like nodes clip, have auto layout, layout grids, prototype overflow and corner radii. */
export const FRAME_LIKE_TYPES: readonly NodeType[] = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

/** One interface for every node type. Fields marked "type-specific" are present only where they apply
 *  (see `shared/design/defaults.ts` for which type gets what); everything else is always present.
 *
 *  Geometry: (x, y) is the top-left corner of the node's box in its parent's coordinate space,
 *  before rotation. The local → parent transform is translate(x, y) · rotate(−rotation°) ·
 *  flip about the box centre. `rotation` is in degrees and positive turns counter-clockwise on
 *  screen, as in Figma's panel (shared/design/geometry.ts `localMatrix`). GROUP and
 *  BOOLEAN_OPERATION keep their box equal to the union of their children; children of every
 *  container are positioned in that container's local space. */
export interface SceneNode {
  id: NodeId;
  type: NodeType;
  name: string;
  /** null for pages only. */
  parentId: NodeId | null;
  /** Containers only, bottom-to-top. */
  children?: NodeId[];

  visible: boolean;
  locked: boolean;
  /** 0..1. */
  opacity: number;
  blendMode: BlendMode;
  /** This node masks the siblings above it, up to the next mask or the end of the parent. */
  isMask: boolean;
  maskType?: 'ALPHA' | 'VECTOR' | 'LUMINANCE';

  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  /** "Constrain proportions" (Figma's constrainProportions): W and H in the panel and the canvas handles keep the
   *  layer's aspect ratio. Absent is off. */
  constrainProportions?: boolean;

  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  strokeAlign: StrokeAlign;
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  strokeMiterLimit: number;
  dashPattern: number[];
  effects: Effect[];

  fillStyleId?: StyleId;
  strokeStyleId?: StyleId;
  effectStyleId?: StyleId;
  /** Field → variable (e.g. "width", "itemSpacing", "opacity", "cornerRadius", "characters", "visible"). */
  boundVariables?: Record<string, VariableAlias>;

  /** Children of non-auto-layout containers: how they follow a resized parent. */
  constraints: Constraints;
  /** Children of auto-layout frames. ABSOLUTE children ignore the flow and use constraints. */
  layoutPositioning: 'AUTO' | 'ABSOLUTE';
  /** HUG: auto-layout frames and text only. FILL: children of auto-layout frames only. */
  layoutSizingHorizontal: LayoutSizing;
  layoutSizingVertical: LayoutSizing;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  /** Children of GRID frames: the cell, spans and alignment within the cells. */
  gridChild?: GridChild;

  exportSettings: ExportSetting[];
  reactions: Reaction[];

  // Type-specific ──────────────────────────────────────────────────────────────────────────────

  /** RECTANGLE, frame-like, POLYGON, STAR, SECTION: one radius for every corner. */
  cornerRadius?: number;
  /** RECTANGLE and frame-like: [top-left, top-right, bottom-right, bottom-left]; overrides `cornerRadius`. */
  rectangleCornerRadii?: [number, number, number, number] | null;
  /** 0..1, iOS-style smoothing of rounded corners. */
  cornerSmoothing?: number;
  /** RECTANGLE and frame-like. */
  individualStrokeWeights?: IndividualStrokeWeights | null;

  /** Frame-like. */
  clipsContent?: boolean;
  autoLayout?: AutoLayout;
  /** `autoLayout.layoutMode` 'GRID' only: the grid's tracks, gaps and placement rules. */
  grid?: GridLayout;
  layoutGrids?: LayoutGrid[];
  gridStyleId?: StyleId;
  overflowDirection?: OverflowDirection;
  /** Prototype: how this frame behaves when opened as an overlay. */
  overlayPositionType?: OverlayPosition;
  overlayBackground?: {type: 'NONE'} | {type: 'SOLID_COLOR'; color: RGBA};
  overlayBackgroundInteraction?: 'NONE' | 'CLOSE_ON_CLICK_OUTSIDE';
  /** Children of a scrolling frame: FIXED stays put, STICKY sticks at the top. */
  scrollBehavior?: 'SCROLLS' | 'FIXED' | 'STICKY_SCROLLS';

  /** PAGE. */
  backgroundColor?: RGB;
  guides?: Guide[];
  flowStartingPoints?: FlowStartingPoint[];
  prototypeDevice?: PrototypeDevice;
  prototypeBackground?: RGB;

  /** ELLIPSE. */
  arcData?: ArcData;
  /** POLYGON and STAR. */
  pointCount?: number;
  /** STAR: 0..1. */
  innerRadius?: number;
  /** LINE and VECTOR. */
  strokeStartMarker?: StrokeMarker;
  strokeEndMarker?: StrokeMarker;
  /** LINE and VECTOR whose paths are all open: a stroke whose width changes along the path (shared/design/stroke-profile.ts).
   *  Absent or UNIFORM: the plain stroke. With a profile the stroke is centred, and dashes and markers are not drawn. */
  variableWidthStrokeProperties?: VariableWidthStrokeProperties;
  /** VECTOR: paths in the node's local box. Resizing a vector scales its paths. */
  vectorPaths?: VectorPath[];
  /** BOOLEAN_OPERATION. */
  booleanOperation?: BooleanOperation;
  /** TEXT. */
  text?: TextProps;
  textStyleId?: StyleId;
  /** TEXT: the text follows this path ("Text on path"). */
  textPath?: TextPathData;

  /** Any layer but a page: notes for developers ("Annotation", Y). */
  annotations?: Annotation[];
  /** PAGE: pinned measurements between layers of the page ("Measurement", ⇧M). */
  measurements?: Measurement[];

  /** COMPONENT and COMPONENT_SET. */
  description?: string;
  /** COMPONENT (BOOLEAN/TEXT/INSTANCE_SWAP) and COMPONENT_SET (VARIANT). Keys are unique names, e.g. "Icon#12". */
  componentPropertyDefinitions?: Record<string, ComponentPropertyDefinition>;
  /** Nodes inside a component whose fields a component property drives. */
  componentPropertyReferences?: ComponentPropertyReferences;
  /** INSTANCE: the main component it was made from. */
  componentId?: NodeId;
  /** INSTANCE: values of the main component's properties (variant values included). */
  componentProperties?: Record<string, string | boolean>;
  /** INSTANCE inside a main component: its properties show on the main's instances, beside their own (Figma's
   *  exposed nested instances). Copies inherit it. */
  isExposedInstance?: boolean;

  /** Nodes inside an instance: the node of the main component (or of the nested instance) it mirrors.
   *  Their id is `${instanceId};${mainId}` (shared/design/components.ts). */
  mainId?: NodeId;
  /** Nodes inside an instance: fields the user changed on this copy; syncing keeps them. */
  overrides?: string[];

  /** Free-form metadata imported from other tools; never read by the renderer. */
  pluginData?: Record<string, string>;

  /** COMPONENT and COMPONENT_SET on the library page (`LIBRARY_PAGE_ID`) only: the shared library this read-only
   *  copy of a main component came from (shared/design/libraries.ts). */
  remote?: RemoteAsset;

  /** "Board" (docs/board.md §Objects): what this layer is in a board object (a sticky, a connector, a table's cell...).
   *  Absent on every layer a design file draws; the renderer never reads it. */
  board?: BoardMeta;
}

// ── Shared libraries ───────────────────────────────────────────────────────────────────────────

/** Where a copy of a library's component, style, variable collection or variable came from (docs/design-tool.md §Teams,
 *  "Shared libraries"). The copy is read-only in the file that uses it; an update from the library replaces it. */
export type RemoteAsset = {
  /** The library on the server (`design_libraries.id`). */
  libraryId: string;
  /** The asset's id in the library file, the same in every version of the library. */
  key: string;
  /** The library version the copy was taken from. */
  version: number;
};

/** The hidden page holding a file's copies of library components (as Figma's internal canvas): never in `pages`, never
 *  shown, only COMPONENT and COMPONENT_SET nodes with `remote` directly on it. */
export const LIBRARY_PAGE_ID = 'morfa:library';

// ── Styles and variables ───────────────────────────────────────────────────────────────────────

export type StyleType = 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
/** Local styles. Nodes keep concrete values and the style id; editing a style rewrites every user
 *  (shared/design/styles.ts), so renderers and exporters never resolve styles. */
export type Style = {
  id: StyleId;
  type: StyleType;
  /** "/" makes groups, as in Figma: "Brand/Primary". */
  name: string;
  description: string;
  paints?: Paint[];
  text?: TextStyle;
  effects?: Effect[];
  grids?: LayoutGrid[];
  /** A style copied from a shared library: read-only here, replaced by the library's updates. */
  remote?: RemoteAsset;
};

export type VariableType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
export type VariableValue = RGBA | number | string | boolean | VariableAlias;
/** `remote`: a collection (or variable) copied from a shared library, read-only here. */
export type VariableCollection = {id: string; name: string; modes: {modeId: string; name: string}[]; defaultModeId: string; variableIds: VariableId[]; remote?: RemoteAsset};
export type Variable = {id: VariableId; name: string; collectionId: string; type: VariableType; valuesByMode: Record<string, VariableValue>; description: string; hiddenFromPublishing?: boolean; remote?: RemoteAsset};

// ── Images and the document ────────────────────────────────────────────────────────────────────

export type ImageAsset = {
  /** Same-origin URL: `/uploads/<file>` owned by the file's account. Never a data: or remote URL in a stored file. */
  url: string;
  width: number;
  height: number;
  name?: string;
};

export const DESIGN_SCHEMA_VERSION = 1;

export interface DesignDocument {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  /** Page ids in panel order. At least one. The hidden library page (`LIBRARY_PAGE_ID`) is never listed. */
  pages: NodeId[];
  nodes: Record<NodeId, SceneNode>;
  styles: Record<StyleId, Style>;
  images: Record<ImageRef, ImageAsset>;
  variableCollections: Record<string, VariableCollection>;
  variables: Record<VariableId, Variable>;
  /** Frame-like nodes may pick a mode per collection: nodeId → collectionId → modeId. */
  variableModes?: Record<NodeId, Record<string, string>>;
  /** "Board" (docs/board.md): a board's document. Normalization then runs the board's steps (sticky text fit, connectors that
   *  follow their objects); without it a document never pays for them. Set when a board is made, never changed. */
  board?: true;
}
