// The parts of Figma's REST API answers the design importer reads (GET /v1/files/:key?geometry=paths
// and GET /v1/files/:key/nodes). Written from Figma's REST API reference; every field is optional
// because Figma omits defaults (visible: true, opacity: 1, blendMode NORMAL...) and the answer is
// untrusted input. Types only.

export type FigmaVector = {x: number; y: number};
export type FigmaColor = {r: number; g: number; b: number; a?: number};
/** Row-major [[a, c, e], [b, d, f]], as `relativeTransform` and `imageTransform` come. */
export type FigmaTransform = [[number, number, number], [number, number, number]];
export type FigmaRect = {x: number; y: number; width: number; height: number};

export type FigmaColorStop = {position: number; color: FigmaColor};
export type FigmaPaint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: FigmaColor;
  gradientHandlePositions?: FigmaVector[];
  gradientStops?: FigmaColorStop[];
  scaleMode?: string;
  imageTransform?: FigmaTransform;
  scalingFactor?: number;
  rotation?: number;
  imageRef?: string;
  gifRef?: string;
  filters?: Record<string, number>;
};

export type FigmaEffect = {
  type: string;
  visible?: boolean;
  radius?: number;
  color?: FigmaColor;
  blendMode?: string;
  offset?: FigmaVector;
  spread?: number;
  showShadowBehindNode?: boolean;
  /** Blurs: NORMAL or PROGRESSIVE (startRadius, startOffset, endOffset). */
  blurType?: string;
  startRadius?: number;
};

export type FigmaLayoutGrid = {
  pattern?: string;
  sectionSize?: number;
  visible?: boolean;
  color?: FigmaColor;
  alignment?: string;
  gutterSize?: number;
  offset?: number;
  count?: number;
};

export type FigmaExportSetting = {suffix?: string; format?: string; constraint?: {type?: string; value?: number}};
export type FigmaPath = {path: string; windingRule?: string; overrideID?: number};

export type FigmaTypeStyle = {
  fontFamily?: string;
  fontPostScriptName?: string | null;
  fontStyle?: string;
  fontWeight?: number;
  italic?: boolean;
  fontSize?: number;
  textCase?: string;
  textDecoration?: string;
  textAutoResize?: string;
  textTruncation?: string;
  maxLines?: number | null;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  lineHeightPercentFontSize?: number;
  lineHeightUnit?: string;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  listSpacing?: number;
  leadingTrim?: string;
  hyperlink?: {type?: string; url?: string; nodeID?: string} | null;
  fills?: FigmaPaint[];
  opentypeFlags?: Record<string, number>;
};

export type FigmaTrigger = {type?: string; timeout?: number; delay?: number; keyCodes?: number[]; device?: string};
export type FigmaEasing = {type?: string};
export type FigmaTransition = {type?: string; easing?: FigmaEasing; duration?: number; direction?: string; matchLayers?: boolean};
export type FigmaAction = {
  type?: string;
  url?: string;
  openInNewTab?: boolean;
  destinationId?: string | null;
  navigation?: string;
  transition?: FigmaTransition | null;
  preserveScrollPosition?: boolean;
  resetScrollPosition?: boolean;
  overlayRelativePosition?: FigmaVector;
};
export type FigmaInteraction = {trigger?: FigmaTrigger | null; actions?: (FigmaAction | null)[] | null; action?: FigmaAction | null};

export type FigmaComponentPropertyDefinition = {
  type?: string;
  defaultValue?: string | boolean;
  variantOptions?: string[];
  preferredValues?: {type?: string; key?: string}[];
};

export type FigmaNode = {
  id: string;
  name?: string;
  type: string;
  visible?: boolean;
  locked?: boolean;
  children?: FigmaNode[];

  // Geometry (relativeTransform and size come with geometry=paths)
  relativeTransform?: FigmaTransform;
  size?: FigmaVector;
  absoluteBoundingBox?: FigmaRect | null;
  rotation?: number;
  /** "Constrain proportions" of the layer. */
  preserveRatio?: boolean;

  // Appearance
  opacity?: number;
  blendMode?: string;
  isMask?: boolean;
  isMaskOutline?: boolean;
  maskType?: string;
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  individualStrokeWeights?: {top: number; right: number; bottom: number; left: number};
  strokeAlign?: string;
  strokeCap?: string;
  strokeJoin?: string;
  strokeMiterAngle?: number;
  strokeDashes?: number[];
  effects?: FigmaEffect[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  cornerSmoothing?: number;
  styles?: Record<string, string>;
  fillGeometry?: FigmaPath[];
  /** Per-region fills of a vector, keyed by `FigmaPath.overrideID`. */
  fillOverrideTable?: Record<string, {fills?: FigmaPaint[]} | null>;
  strokeGeometry?: FigmaPath[];
  arcData?: {startingAngle: number; endingAngle: number; innerRadius: number};
  /** Not documented for REST; read when present. */
  pointCount?: number;
  innerRadius?: number;
  booleanOperation?: string;

  // Frames
  clipsContent?: boolean;
  background?: FigmaPaint[];
  backgroundColor?: FigmaColor;
  layoutMode?: string;
  layoutWrap?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  counterAxisAlignContent?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number | null;
  itemReverseZIndex?: boolean;
  strokesIncludedInLayout?: boolean;
  // Grid auto layout (layoutMode GRID; the REST spec's HasLayoutTrait): the tracks come as CSS grid-template strings.
  gridRowCount?: number;
  gridColumnCount?: number;
  gridRowGap?: number;
  gridColumnGap?: number;
  gridRowsSizing?: string;
  gridColumnsSizing?: string;
  layoutGrids?: FigmaLayoutGrid[];
  overflowDirection?: string;
  scrollBehavior?: string;
  overlayPositionType?: string;
  overlayBackground?: {type?: string; color?: FigmaColor};
  overlayBackgroundInteraction?: string;

  // Children of frames
  constraints?: {vertical?: string; horizontal?: string};
  layoutAlign?: string;
  layoutGrow?: number;
  layoutPositioning?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  // Children of GRID frames.
  gridRowAnchorIndex?: number;
  gridColumnAnchorIndex?: number;
  gridRowSpan?: number;
  gridColumnSpan?: number;
  gridChildHorizontalAlign?: string;
  gridChildVerticalAlign?: string;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;

  // Prototyping and export
  interactions?: FigmaInteraction[];
  reactions?: FigmaInteraction[];
  transitionNodeID?: string | null;
  transitionDuration?: number;
  transitionEasing?: string;
  exportSettings?: FigmaExportSetting[];

  // Text
  characters?: string;
  style?: FigmaTypeStyle;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, FigmaTypeStyle>;
  lineTypes?: string[];
  lineIndentations?: number[];

  // Components
  componentId?: string;
  componentProperties?: Record<string, {type?: string; value?: string | boolean}>;
  componentPropertyDefinitions?: Record<string, FigmaComponentPropertyDefinition>;
  componentPropertyReferences?: Record<string, string>;
  /** An instance inside a main component whose properties the main's instances show. */
  isExposedInstance?: boolean;
  overrides?: {id: string; overriddenFields?: string[]}[];

  // Pages
  flowStartingPoints?: {nodeId?: string; name?: string}[];
  prototypeDevice?: {type?: string; presetIdentifier?: string; rotation?: string};
  prototypeBackgrounds?: FigmaPaint[];
  /** Dev Mode measurements pinned on the page. */
  measurements?: {id?: string; start?: {nodeId?: string; side?: string}; end?: {nodeId?: string; side?: string}; offset?: {type?: string; relative?: number; fixed?: number}; freeText?: string}[];

  boundVariables?: Record<string, unknown>;
};

export type FigmaComponentMeta = {key?: string; name?: string; description?: string; componentSetId?: string; remote?: boolean};
export type FigmaStyleMeta = {key?: string; name?: string; description?: string; styleType?: string; remote?: boolean};

/** A file as the importer reads it: GET /v1/files/:key, or the same shape assembled from nodes answers. */
export type FigmaFile = {
  name?: string;
  document?: {id?: string; children?: FigmaNode[]};
  components?: Record<string, FigmaComponentMeta>;
  componentSets?: Record<string, FigmaComponentMeta>;
  styles?: Record<string, FigmaStyleMeta>;
};
