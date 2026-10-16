import type {Rect} from '../../../shared/design/geometry';
import type {NodeId, Vec} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import {registerTool} from '../engine/tools/registry';
import type {Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from '../engine/tools/types';

// The canvas side of "Meeting" (docs/board-meeting.md): two modes, each a tool of the canvas so its clicks never select or move
// anything and panning (space, the wheel, the middle button) keeps working.
// - "Voting" (meeting-vote): a click on a frame (a sticky or a shape on a board) gives it one of your votes; your dots are DOM
//   buttons over the canvas (a click on one takes it back), so they never reach this tool. The object under the pointer is outlined
//   in the meeting accent on the canvas's own overlay.
// - "Reaction" (meeting-emote): pressing on the canvas bursts the chosen emote at the pointer, again every 160 ms while held, and the
//   wave of a high five lasts while it is held. The cursor is the emote itself.
// Escape (or the bar's button) goes back to "Move". Both stay available in a read-only file: they are not the document.

export const VOTE_TOOL = 'meeting-vote';
export const EMOTE_TOOL = 'meeting-emote';

export type VoteToolHost = {
  targetAt(page: Vec): NodeId | null;
  box(id: NodeId): Rect | null;
  vote(id: NodeId): void;
  /** The accent the hover outline is drawn in. */
  accent(): string;
};
export type EmoteToolHost = {
  /** The cursor while the mode is on (the chosen emote). */
  cursor(): string;
  press(page: Vec): void;
  move(page: Vec): void;
  release(): void;
};

const voteHosts = new WeakMap<DesignStore, VoteToolHost>();
const emoteHosts = new WeakMap<DesignStore, EmoteToolHost>();
export function connectMeetingTools(store: DesignStore, hosts: {vote: VoteToolHost; emote: EmoteToolHost}): () => void {
  voteHosts.set(store, hosts.vote);
  emoteHosts.set(store, hosts.emote);
  return () => {
    if (voteHosts.get(store) === hosts.vote) voteHosts.delete(store);
    if (emoteHosts.get(store) === hosts.emote) emoteHosts.delete(store);
  };
}

/** A ballot box's slot with a dot going in, tip at the hotspot (8, 8); white with a dark outline so it reads on any canvas. */
const VOTE_CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<circle cx="8" cy="8" r="5.5" fill="#fff" stroke="#1E1E1E" stroke-width="1.25"/>' +
  '<circle cx="8" cy="8" r="3" fill="#1E1E1E"/>' +
  '<path d="M15.5 14.5v6M12.5 17.5h6" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>' +
  '<path d="M15.5 14.5v6M12.5 17.5h6" stroke="#1E1E1E" stroke-width="1.5" stroke-linecap="round"/></svg>';
export const VOTE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(VOTE_CURSOR_SVG)}") 8 8, copy`;

/** An emote as a cursor: the emoji itself, 28 px, its centre at the hotspot. */
export const emoteCursor = (emoji: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><text x="16" y="17" font-size="24" text-anchor="middle" dominant-baseline="middle">${emoji}</text></svg>`)}") 16 16, pointer`;

class VoteTool implements Tool {
  readonly id = VOTE_TOOL;
  readonly cursor = VOTE_CURSOR;
  private hovered: NodeId | null = null;
  /** Each canvas makes its own tool, so the store of its events is the one its overlay draws. */
  private store: DesignStore | null = null;

  overlayHints() {
    return {handles: false, hover: false, sizeBadge: false};
  }
  activate(ctx: ToolContext) {
    this.store = ctx.store;
    ctx.store.setHover(null);
  }
  deactivate(ctx: ToolContext) {
    this.hovered = null;
    ctx.requestOverlay();
  }
  onPointerMove(event: ToolPointerEvent, ctx: ToolContext) {
    this.store = ctx.store;
    const next = voteHosts.get(ctx.store)?.targetAt(event.page) ?? null;
    if (next === this.hovered) return;
    this.hovered = next;
    ctx.requestOverlay();
  }
  onPointerDown(event: ToolPointerEvent, ctx: ToolContext) {
    if (event.button !== 0) return;
    const host = voteHosts.get(ctx.store);
    const id = host?.targetAt(event.page) ?? null;
    if (host && id) host.vote(id);
  }
  onKeyDown(event: ToolKeyEvent, ctx: ToolContext) {
    if (event.code !== 'Escape' || event.type !== 'keydown') return false;
    ctx.setTool('move');
    return true;
  }
  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const host = this.store ? voteHosts.get(this.store) : undefined;
    const box = this.hovered && host ? host.box(this.hovered) : null;
    if (!host || !box) return;
    const a = view.pageToScreen({x: box.x, y: box.y}),
      b = view.pageToScreen({x: box.x + box.width, y: box.y + box.height});
    ctx2d.save();
    ctx2d.strokeStyle = host.accent();
    ctx2d.lineWidth = 2;
    ctx2d.strokeRect(Math.round(a.x), Math.round(a.y), Math.round(b.x - a.x), Math.round(b.y - a.y));
    ctx2d.restore();
  }
}

class EmoteTool implements Tool {
  readonly id = EMOTE_TOOL;
  readonly cursor = 'pointer';
  private held = false;

  overlayHints() {
    return {handles: false, hover: false, sizeBadge: false};
  }
  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
    ctx.setCursor(emoteHosts.get(ctx.store)?.cursor() ?? null);
  }
  deactivate(ctx: ToolContext) {
    if (this.held) emoteHosts.get(ctx.store)?.release();
    this.held = false;
    ctx.setCursor(null);
  }
  onPointerDown(event: ToolPointerEvent, ctx: ToolContext) {
    if (event.button !== 0) return;
    const host = emoteHosts.get(ctx.store);
    if (!host) return;
    ctx.setCursor(host.cursor());
    this.held = true;
    host.press(event.page);
  }
  onPointerMove(event: ToolPointerEvent, ctx: ToolContext) {
    if (this.held) emoteHosts.get(ctx.store)?.move(event.page);
  }
  onPointerUp(_event: ToolPointerEvent, ctx: ToolContext) {
    if (!this.held) return;
    this.held = false;
    emoteHosts.get(ctx.store)?.release();
  }
  onPointerCancel(ctx: ToolContext) {
    this.onPointerUp(undefined as unknown as ToolPointerEvent, ctx);
  }
  busy() {
    return this.held;
  }
  onKeyDown(event: ToolKeyEvent, ctx: ToolContext) {
    if (event.code !== 'Escape' || event.type !== 'keydown') return false;
    ctx.setTool('move');
    return true;
  }
}

let registered = false;
/** Registers both tools (idempotent). */
export function registerMeetingTools() {
  if (registered) return;
  registered = true;
  registerTool(VOTE_TOOL, () => new VoteTool());
  registerTool(EMOTE_TOOL, () => new EmoteTool());
}
