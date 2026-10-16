import type {DesignDocument, NodeId, Vec} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import type {TextMeasurer} from '../../../../shared/design/text-layout';
import type {SpatialIndex} from '../../../../shared/design/tree';
import type {Viewport} from '../contracts';
import type {OverlayItem} from '../overlay';
import type {DesignStore} from '../store';
import type {TouchClaim} from '../touch/gestures';

// The contract between the canvas and its tools (docs/design-tool.md §Client engine). The canvas
// turns DOM events into these, keeps pointer capture and the cursor, and draws; a tool decides what
// a press, a drag and a key mean. One module per tool, registered by id (registry.ts).

export type ToolPointerEvent = {
  /** CSS px from the canvas's top-left corner. */
  screen: Vec;
  /** The same point on the page. */
  page: Vec;
  button: number;
  buttons: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** ⌘ on Mac, Ctrl elsewhere. */
  mod: boolean;
  pointerId: number;
  pointerType: string;
  pressure: number;
  /** Clicks in a row (2 on the second press of a double click). */
  detail: number;
  timeStamp: number;
};

export type ToolKeyEvent = {
  type: 'keydown' | 'keyup';
  /** Physical key (`KeyboardEvent.code`), so tools work on the Russian layout. */
  code: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  mod: boolean;
  repeat: boolean;
};

export type ViewHelpers = {
  viewport(): Viewport;
  /** CSS px of the canvas. */
  size(): {width: number; height: number};
  screenToPage(point: Vec): Vec;
  pageToScreen(point: Vec): Vec;
  setViewport(viewport: Viewport): void;
  /** Page units per CSS px at the current zoom (1 / zoom). */
  pixel(): number;
};

export type SnapContext = {doc: DesignDocument; pageId: NodeId; zoom: number; exclude: ReadonlySet<NodeId>};
export type SnapResult = {dx: number; dy: number; guides: OverlayItem[]};

/** Smart guides plug in here. The default moves nothing and shows nothing. */
export interface SnapHook {
  /** Where a moving selection whose bounds are now `rect` (page space) should land: the correction to
   *  add and the guides to show. */
  snapMove(rect: Rect, context: SnapContext): SnapResult;
  /** A dragged handle or a drawn point. */
  snapPoint?(point: Vec, context: SnapContext): {x: number; y: number; guides: OverlayItem[]};
  /** The drag ended: cached candidates can go. */
  end?(): void;
}

export const NO_SNAP: SnapHook = {snapMove: () => ({dx: 0, dy: 0, guides: []})};

export type EditKind = 'text' | 'vector' | 'gradient';

export interface ToolContext {
  readonly store: DesignStore;
  readonly measurer: TextMeasurer;
  readonly view: ViewHelpers;
  readonly snap: SnapHook;
  /** The spatial index of the current page when the renderer keeps one (hit tests then skip the walk). */
  index(): SpatialIndex | null;
  setCursor(cursor: string | null): void;
  /** Redraw the overlay on the next frame (after a tool changed what `drawOverlay` shows). */
  requestOverlay(): void;
  /** Items the overlay draws for the tool until replaced (guides, measurements). */
  setOverlayItems(items: readonly OverlayItem[]): void;
  /** Opens the text or vector editor of a node (the text and vector modules fill this in). */
  enterEdit(id: NodeId, kind?: EditKind): void;
  /** Renames a frame in place, in a field over its title on the canvas (a double click on the title). */
  editTitle?(id: NodeId): void;
  setTool(id: string): void;
  /** Modifier keys held right now (`ctrl`: the Control key itself, which suspends snapping as in Figma). */
  modifiers(): {shift: boolean; alt: boolean; mod: boolean; ctrl?: boolean};
}

/** What the engine's own overlay should leave out while a tool works. */
export type OverlayHints = {handles?: boolean; hover?: boolean; sizeBadge?: boolean};

export interface Tool {
  readonly id: string;
  /** CSS cursor while the tool is idle. */
  readonly cursor: string;
  activate?(ctx: ToolContext): void;
  deactivate?(ctx: ToolContext): void;
  onPointerDown?(event: ToolPointerEvent, ctx: ToolContext): void;
  onPointerMove?(event: ToolPointerEvent, ctx: ToolContext): void;
  onPointerUp?(event: ToolPointerEvent, ctx: ToolContext): void;
  /** The pointer went away mid-drag (capture lost, window blurred): put things back. */
  onPointerCancel?(ctx: ToolContext): void;
  onDoubleClick?(event: ToolPointerEvent, ctx: ToolContext): void;
  /** What a one-finger press here means on touch (engine/touch/gestures.ts). Default `draw`: the tool takes it all. A tool
   *  with this method also takes `onPointerCancel` before its press became a drag (a second finger landed). */
  touchClaim?(event: ToolPointerEvent, ctx: ToolContext): TouchClaim;
  /** Return true when the key was used; it then reaches no command. */
  onKeyDown?(event: ToolKeyEvent, ctx: ToolContext): boolean | void;
  onKeyUp?(event: ToolKeyEvent, ctx: ToolContext): boolean | void;
  /** Extra drawing on the overlay, in CSS px of the canvas, after the engine's own. */
  drawOverlay?(ctx2d: CanvasRenderingContext2D, view: ViewHelpers): void;
  overlayHints?(): OverlayHints;
  /** In the middle of a drag: hover is not tracked and the canvas does not switch tools. */
  busy?(): boolean;
  /** Live nodes to draw above everything and unclipped while they move (RenderOptions.lifted). */
  lifted?(): ReadonlySet<NodeId> | null;
}
