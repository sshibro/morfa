// "Morfa": bounds of one document's fields (docs/design-tool.md §Server API). The schema
// (shared/design/schema.ts) enforces them on the server and when a portable file is opened; the
// editor may read them to stop input early. Plain numbers only: importable from anywhere.
// Limits per account (storage, history) and hard caps of a whole file live in limits.ts:
// `DESIGN_DOCUMENT_CAPS` there.

export const DESIGN_FIELD_LIMITS = {
  /** Node, style, variable, collection, mode and image ids. Instance copies chain ids with ";". */
  id: 512,
  /** Layer, style, variable, page and flow names. */
  name: 500,
  /** Text node content, UTF-16 code units. */
  characters: 100_000,
  /** Path commands of one VECTOR node, all its paths together. */
  pathCommands: 100_000,
  vectorPaths: 1_000,
  /** Fills or strokes of one node, run or style. */
  paints: 100,
  gradientStops: 100,
  effects: 100,
  dashPattern: 100,
  exportSettings: 50,
  reactions: 100,
  actions: 50,
  layoutGrids: 100,
  /** Rows or columns of a grid auto-layout frame; also the cap of a child's anchors and spans. */
  gridTracks: 1_000,
  guides: 1_000,
  flowStartingPoints: 500,
  textRuns: 10_000,
  /** One entry per paragraph. */
  listTypes: 100_001,
  overrides: 500,
  componentProperties: 500,
  variantOptions: 500,
  boundVariables: 200,
  pluginData: 100,
  pluginDataValue: 10_000,
  /** Notes for developers on one layer, and the layer properties one note shows. */
  annotations: 100,
  annotationProperties: 30,
  /** Pinned measurements of one page. */
  measurements: 1_000,
  /** Width points of one custom stroke profile. */
  widthPoints: 1_000,
  /** "Board": waypoints of one reshaped connector. */
  connectorPoints: 1_000,
  /** "Board": columns or rows one table cell spans. */
  tableSpan: 1_000,
  description: 10_000,
  fontFamily: 200,
  url: 2_048,
  shortText: 200,
  styles: 10_000,
  images: 10_000,
  variableCollections: 1_000,
  variables: 20_000,
  modes: 100,
  /** Nesting below a page. Renderers and exporters walk the tree recursively. */
  depth: 256,
  /** |x| of every coordinate, size, offset and radius. */
  coordinate: 1e9,
} as const;

/** A portable file ("Save to computer", `.rdesign`): the document with its pictures inlined. */
export const DESIGN_PORTABLE_MAX_BYTES = 50 * 1024 * 1024;
/** Autosave hands a patch to `fetch(..., {keepalive: true})` when the page hides only below this size
 * (browsers cap all keepalive bodies in flight at 64 KiB). */
export const DESIGN_KEEPALIVE_PATCH_BYTES = 60 * 1024;
/** One PATCH body: the patch and the optional `before` map. */
export const DESIGN_PATCH_MAX_BYTES = 8 * 1024 * 1024;
