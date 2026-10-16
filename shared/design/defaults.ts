import type {AutoLayout, Constraints, DesignDocument, NodeId, NodeType, Paint, RGB, RGBA, SceneNode, SolidPaint, TextProps, TextStyle} from './types';
import {CONTAINER_TYPES, DESIGN_SCHEMA_VERSION, FRAME_LIKE_TYPES} from './types';

// Factories for nodes, paints and documents. Every node in a file passed through `createNode`
// (or a mapper that fills the same fields), so the renderer and panels can rely on the
// always-present fields of `SceneNode` without checking for undefined.

export const WHITE: RGB = {r: 1, g: 1, b: 1};
export const BLACK: RGB = {r: 0, g: 0, b: 0};
/** Figma's default shape grey (#D9D9D9). */
export const SHAPE_GREY: RGB = {r: 217 / 255, g: 217 / 255, b: 217 / 255};
/** The canvas of a page without a colour of its own in the light theme (#F5F5F5), and everywhere outside the editor
 *  (file thumbnails, template cards). */
export const PAGE_BACKGROUND: RGB = {r: 245 / 255, g: 245 / 255, b: 245 / 255};
/** The same canvas in the dark theme (#1E1E1E), as Figma draws a page whose background was never set. */
export const PAGE_BACKGROUND_DARK: RGB = {r: 30 / 255, g: 30 / 255, b: 30 / 255};

/** The default canvas colour for the editor's theme. */
export const defaultPageBackground = (theme: 'light' | 'dark' = 'light'): RGB => (theme === 'dark' ? PAGE_BACKGROUND_DARK : PAGE_BACKGROUND);

/** What a page's canvas shows: its own colour once the designer set one, otherwise the theme's default. New pages
 *  store none (`backgroundColor` absent); files made before kept the colour they stored. */
export const pageBackground = (page: Pick<SceneNode, 'backgroundColor'> | undefined, fallback: RGB = PAGE_BACKGROUND): RGB =>
  page?.backgroundColor ?? fallback;

export const solid = (color: RGB, opacity = 1): SolidPaint => ({type: 'SOLID', color: {...color}, opacity, visible: true, blendMode: 'NORMAL'});
export const rgba = (color: RGB, a = 1): RGBA => ({...color, a});

/** The font every new text starts with: it carries Cyrillic and ships with the app (/fonts/inter). */
export const DEFAULT_FONT_FAMILY = 'Inter';

export const defaultTextStyle = (): TextStyle => ({
  fontFamily: DEFAULT_FONT_FAMILY,
  fontWeight: 400,
  italic: false,
  fontSize: 16,
  lineHeight: {unit: 'AUTO'},
  letterSpacing: {unit: 'PERCENT', value: 0},
  textDecoration: 'NONE',
  textCase: 'ORIGINAL',
});

export const defaultTextProps = (characters = ''): TextProps => ({
  characters,
  style: defaultTextStyle(),
  runs: [],
  textAlignHorizontal: 'LEFT',
  textAlignVertical: 'TOP',
  textAutoResize: 'WIDTH_AND_HEIGHT',
  paragraphSpacing: 0,
  paragraphIndent: 0,
});

export const defaultAutoLayout = (layoutMode: AutoLayout['layoutMode'] = 'NONE'): AutoLayout => ({
  layoutMode,
  layoutWrap: 'NO_WRAP',
  primaryAxisAlignItems: 'MIN',
  counterAxisAlignItems: 'MIN',
  counterAxisAlignContent: 'AUTO',
  paddingLeft: 0,
  paddingRight: 0,
  paddingTop: 0,
  paddingBottom: 0,
  itemSpacing: 0,
  counterAxisSpacing: 0,
  itemReverseZIndex: false,
  strokesIncludedInLayout: false,
});

const DEFAULT_CONSTRAINTS: Constraints = {horizontal: 'MIN', vertical: 'MIN'};

export const isContainerType = (type: NodeType) => CONTAINER_TYPES.includes(type);
export const isFrameLike = (type: NodeType) => FRAME_LIKE_TYPES.includes(type);

/** Default name of a new node, as the layers panel shows it. */
export const TYPE_NAMES: Record<NodeType, string> = {
  PAGE: 'Page', FRAME: 'Frame', GROUP: 'Group', SECTION: 'Section', COMPONENT: 'Component', COMPONENT_SET: 'Component set',
  INSTANCE: 'Instance', BOOLEAN_OPERATION: 'Boolean operation', RECTANGLE: 'Rectangle', ELLIPSE: 'Ellipse', LINE: 'Line',
  POLYGON: 'Polygon', STAR: 'Star', VECTOR: 'Vector', TEXT: 'Text', SLICE: 'Slice',
};

/** Fills a new node of `type` with defaults, then applies `props`. `id` and `parentId` are required in props
 *  except for pages, whose parentId is null. Type-specific fields only appear on types they apply to. */
export function createNode(type: NodeType, props: Partial<SceneNode> & {id: NodeId}): SceneNode {
  const frameLike = isFrameLike(type);
  const shapeFill: Paint[] = type === 'RECTANGLE' || type === 'ELLIPSE' || type === 'POLYGON' || type === 'STAR' || type === 'VECTOR' ? [solid(SHAPE_GREY)]
    : type === 'TEXT' ? [solid(BLACK)]
    : frameLike || type === 'SECTION' ? [solid(WHITE)]
    : [];
  const node: SceneNode = {
    id: props.id,
    type,
    name: TYPE_NAMES[type],
    parentId: null,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: type === 'GROUP' || type === 'BOOLEAN_OPERATION' || frameLike ? 'PASS_THROUGH' : 'NORMAL',
    isMask: false,
    x: 0,
    y: 0,
    width: type === 'TEXT' ? 0 : 100,
    height: type === 'LINE' ? 0 : type === 'TEXT' ? 0 : 100,
    rotation: 0,
    fills: shapeFill,
    strokes: type === 'LINE' ? [solid(BLACK)] : [],
    strokeWeight: 1,
    strokeAlign: type === 'LINE' || type === 'VECTOR' ? 'CENTER' : 'INSIDE',
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
    strokeMiterLimit: 4,
    dashPattern: [],
    effects: [],
    constraints: {...DEFAULT_CONSTRAINTS},
    layoutPositioning: 'AUTO',
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
    exportSettings: [],
    reactions: [],
  };
  if (isContainerType(type)) node.children = [];
  if (type === 'RECTANGLE' || frameLike || type === 'SECTION') {
    node.cornerRadius = 0;
    node.cornerSmoothing = 0;
  }
  if (type === 'POLYGON' || type === 'STAR') {
    node.cornerRadius = 0;
    node.pointCount = type === 'STAR' ? 5 : 3;
  }
  if (type === 'STAR') node.innerRadius = 0.382;
  if (type === 'ELLIPSE') node.arcData = {startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0};
  if (type === 'LINE' || type === 'VECTOR') {
    node.strokeStartMarker = 'NONE';
    node.strokeEndMarker = 'NONE';
  }
  if (type === 'VECTOR') node.vectorPaths = [];
  if (type === 'BOOLEAN_OPERATION') node.booleanOperation = 'UNION';
  if (type === 'TEXT') {
    node.text = defaultTextProps();
    node.layoutSizingHorizontal = 'HUG';
    node.layoutSizingVertical = 'HUG';
  }
  if (frameLike) {
    node.clipsContent = true;
    node.autoLayout = defaultAutoLayout();
    node.layoutGrids = [];
    node.overflowDirection = 'NONE';
  }
  if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
    node.description = '';
    node.componentPropertyDefinitions = {};
  }
  if (type === 'INSTANCE') node.componentProperties = {};
  if (type === 'PAGE') {
    // No `backgroundColor`: the canvas follows the editor's theme until the designer picks a colour.
    node.guides = [];
    node.flowStartingPoints = [];
    node.prototypeDevice = {type: 'NONE'};
    node.fills = [];
    node.width = 0;
    node.height = 0;
  }
  if (type === 'SECTION') node.fills = [solid(WHITE)];
  return {...node, ...props, name: props.name ?? node.name};
}

/** A file with one empty page. */
export function createDocument(pageId: NodeId, pageName = 'Page 1'): DesignDocument {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    pages: [pageId],
    nodes: {[pageId]: createNode('PAGE', {id: pageId, name: pageName})},
    styles: {},
    images: {},
    variableCollections: {},
    variables: {},
  };
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Short random ids (10 base-36 chars, ~51 bits): files hold tens of thousands of nodes and ids repeat in every
 *  children list, so they stay compact. Instance copies derive theirs (shared/design/components.ts). */
export function newId(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte % 36];
  return id;
}
