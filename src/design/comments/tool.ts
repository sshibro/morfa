import {anchorAt, type DesignCommentAnchor} from '../../../shared/design/comments';
import type {DesignStore} from '../engine/store';
import {registerCommand, type Command} from '../engine/commands/registry';
import {registerTool} from '../engine/tools/registry';
import type {Tool, ToolContext, ToolKeyEvent, ToolPointerEvent} from '../engine/tools/types';

// "Comment" (C): a click on the canvas places a pin (on the frame, component, instance or section under it, so it follows that layer;
// else on the canvas) and opens the field for the first comment. Pins themselves are DOM buttons over the canvas (CommentsLayer), so a
// click on a pin never reaches this tool. Selection handles and hover outlines are off while commenting and the selection is dropped, as
// in Figma; Escape closes an open card first, then the editor goes back to "Move".

export const COMMENT_TOOL = 'comment';

/** What the open file does with the tool's clicks and Escape (DesignEditor connects `commentToolHost` of its comments controller). */
export type CommentToolHost = {
  /** A click on the canvas at `anchor` (page space). */
  place(anchor: DesignCommentAnchor): void;
  /** Escape: closes an open card or draft; true when it did. */
  escape(): boolean;
  /** "Comments on the canvas" (⇧C, as Figma's): whether pins show outside comment mode, and the switch. */
  pinsShown(): boolean;
  togglePins(): void;
};

const hosts = new WeakMap<DesignStore, CommentToolHost>();
export function connectCommentTool(store: DesignStore, host: CommentToolHost): () => void {
  hosts.set(store, host);
  return () => {
    if (hosts.get(store) === host) hosts.delete(store);
  };
}

// A speech bubble with a plus, its tip at the hotspot (bottom left), white with a dark outline so it reads on any canvas.
const CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<path d="M2.5 21.5V11a8.5 8.5 0 1 1 8.5 8.5H4.5Z" fill="#fff" stroke="#1E1E1E" stroke-width="1.25" stroke-linejoin="round"/>' +
  '<path d="M11 7.5v7M7.5 11h7" stroke="#1E1E1E" stroke-width="1.5" stroke-linecap="round"/></svg>';
export const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(CURSOR_SVG)}") 2 22, crosshair`;

class CommentTool implements Tool {
  readonly id = COMMENT_TOOL;
  readonly cursor = COMMENT_CURSOR;

  overlayHints() {
    return {handles: false, hover: false, sizeBadge: false};
  }

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
    // Comment mode draws no selection, so nothing stays selected for a key (Delete, arrows) to act on unseen.
    if (ctx.store.getState().selection.length) ctx.store.setSelection([]);
  }

  onPointerDown(event: ToolPointerEvent, ctx: ToolContext) {
    if (event.button !== 0) return;
    const host = hosts.get(ctx.store);
    if (!host) return;
    // A click beside an open card closes it (as in Figma); the next click places a pin.
    if (host.escape()) return;
    const {doc, pageId} = ctx.store.getState();
    host.place(anchorAt(doc, pageId, event.page));
  }

  onKeyDown(event: ToolKeyEvent, ctx: ToolContext) {
    if (event.code !== 'Escape' || event.type !== 'keydown') return false;
    return hosts.get(ctx.store)?.escape() ?? false;
  }
}

/** View ▸ "Comments on the canvas" (⇧C): hides the pins except in comment mode, as Figma's Show comments. */
export const SHOW_COMMENTS_COMMAND: Command = {
  id: 'view.comments',
  label: 'Comments on the canvas',
  group: 'view',
  shortcut: {code: 'KeyC', shift: true},
  enabled: ctx => hosts.has(ctx.store),
  checked: ctx => hosts.get(ctx.store)?.pinsShown() ?? true,
  run: ctx => hosts.get(ctx.store)?.togglePins(),
};

let registered = false;
/** Registers the tool and "Comments on the canvas" (idempotent); the toolbar shows "Comment" once it is there. */
export function registerCommentTool() {
  if (registered) return;
  registered = true;
  registerTool(COMMENT_TOOL, () => new CommentTool());
  registerCommand(SHOW_COMMENTS_COMMAND);
}
