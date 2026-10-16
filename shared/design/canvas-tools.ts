// The canvas tools the MCP server's editing tools run (docs/mcp-server.md §Editing): create, update, delete and duplicate layers and
// add colour styles on a document. Types and caps only, no zod: shared/design/canvas-tools-check.ts checks a tool's raw input into
// these (the checker of the server) and src/design/canvas-tools/executor.ts runs the checked call against a document.

/** Caps of the tools' inputs. */
export const CANVAS_TOOL_CAPS = {
  /** Layers one create_layers call may add (build big screens in sections). */
  create: 100,
  updates: 100,
  deletes: 200,
  duplicates: 20,
  colors: 32,
} as const;

/** Caps of a layer spec (the strings of a create_layers call). */
export const CANVAS_SPEC_CAPS = {
  /** Layers a spec list may hold. */
  nodes: 300,
  /** Any string: text characters, image descriptions. */
  chars: 2000,
  names: 200,
} as const;

/** One tool result's text, characters; longer results are cut with a note. */
export const CANVAS_RESULT_CHARS = 12_000;

export type CanvasLayout = {
  mode: 'HORIZONTAL' | 'VERTICAL';
  gap: number;
  padding: {top: number; right: number; bottom: number; left: number};
  primaryAlign: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAlign: 'MIN' | 'CENTER' | 'MAX';
  wrap: boolean;
};
export type CanvasText = {
  characters: string;
  /** Always a family of the font catalogue (shared/fonts.ts). */
  fontFamily: string;
  /** 100…900 in hundreds. */
  fontWeight: number;
  fontSize: number;
  /** Pixels; null is auto. */
  lineHeight: number | null;
  /** Percent of the size; null is 0. */
  letterSpacing: number | null;
  align: 'LEFT' | 'CENTER' | 'RIGHT';
  /** #RRGGBB or #RRGGBBAA. */
  color: string;
};
/**
 * One layer to create. `id` is local to the call; `parent` is the id of an earlier FRAME of the same call, or null for a top-level layer
 * (placed on the page or in the frame the call names). `x`/`y` matter only where the parent has no auto layout. IMAGE is a rectangle
 * holding a picture placeholder; no layer ever carries a URL.
 */
export type CanvasNodeSpec = {
  id: string;
  parent: string | null;
  type: 'FRAME' | 'TEXT' | 'RECTANGLE' | 'ELLIPSE' | 'IMAGE';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** #RRGGBB or #RRGGBBAA; null is no fill. */
  fill: string | null;
  stroke: {color: string; weight: number} | null;
  cornerRadius: number | null;
  /** 0…1; null is 1. */
  opacity: number | null;
  /** FRAME only. */
  layout: CanvasLayout | null;
  /** HUG only for a FRAME with a layout and for TEXT; FILL only inside a parent with a layout. */
  sizing: {horizontal: 'FIXED' | 'HUG' | 'FILL'; vertical: 'FIXED' | 'HUG' | 'FILL'} | null;
  /** TEXT only. */
  text: CanvasText | null;
  /** IMAGE only. */
  image: {description: string} | null;
};

/** A change to one layer: only the fields given change. */
export type CanvasLayerUpdate = {
  id: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** #RRGGBB or #RRGGBBAA as the only fill; null removes the fills. */
  fill?: string | null;
  stroke?: {color: string; weight: number} | null;
  cornerRadius?: number;
  /** 0…1. */
  opacity?: number;
  visible?: boolean;
  /** FRAME only; null removes auto layout. */
  layout?: CanvasLayout | null;
  sizing?: {horizontal: 'FIXED' | 'HUG' | 'FILL'; vertical: 'FIXED' | 'HUG' | 'FILL'};
  /** TEXT only: the fields given change for the whole text. */
  text?: Partial<CanvasText>;
  /** Moves the layer into this frame (an alias), or onto its page (null), at `index` among the new parent's children or last. It keeps
   *  its place on screen unless the new parent's auto layout places it. */
  parent?: string | null;
  index?: number;
};

export type CanvasToolName = 'create_layers' | 'update_layers' | 'delete_layers' | 'duplicate_layers' | 'add_color_styles';

/** The checked inputs, by tool (shared/design/canvas-tools-check.ts parses a raw input into these). */
export type CanvasToolInputs = {
  /** `parent` null puts the top-level layers on the page beside what is there, an alias puts them in that frame. The result maps every
   *  spec's local id to its alias. */
  create_layers: {parent: string | null; layers: CanvasNodeSpec[]};
  update_layers: {updates: CanvasLayerUpdate[]};
  delete_layers: {ids: string[]};
  /** Each copy goes beside its original (to the right of a top-level frame, after it in its parent otherwise). */
  duplicate_layers: {ids: string[]};
  /** Colour styles "group/name". */
  add_color_styles: {group: string; colors: {name: string; color: string}[]};
};

/** A tool call, its input checked. */
export type CanvasToolCall = {[K in CanvasToolName]: {id: string; name: K; input: CanvasToolInputs[K]}}[CanvasToolName];

/** What a tool did. `ok: false` is an error the caller reads (and usually fixes). */
export type CanvasToolResult = {id: string; ok: boolean; text: string};
