import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import {anchorPoint, designCommentLink, type DesignCommentAnchor, type DesignCommentThread} from '../../../../shared/design/comments';
import {ApiError} from '../../../api';
import {currentViewport, type DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {COMMENT_TOOL} from '../tool';
import {clampZoom, fitRect, pageToScreen} from '../../engine/viewport';
import {Button, IconButton} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {IconCheck, IconClose, IconMore} from '../../ui/icons';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import type {CommentsController} from '../controller';
import {clusterPins, matchesFilter, sameClusters, separatingZoom, type PinCluster} from '../model';
import {Composer} from './Composer';
import {Avatar, CommentText, TimeAgo, useCommentsState, useNow} from './parts';

// Comment mode over the canvas (docs/design-tool.md §Teams "Comments"): the pins of the page (an author's bubble; unread ones marked;
// close ones clustered when zoomed out), the field for a new pin, and the open thread's card beside its pin. Pins and the card are DOM
// above the canvas; their positions are written straight to the elements on every viewport or document change (no React render for a
// pan), and React renders only when the clusters themselves change. Positions go in the `translate` property, never `transform`: the
// pin's 0.96 press and the card's scale-in (`scale`) then happen about the element's own origin. Under a `transform: translate()` the
// scale would also scale the offset, and a pin far from the canvas's corner jumped ~30 px from under the pointer when pressed.

export type CommentsLayerProps = {
  controller: CommentsController;
  store: DesignStore;
  /** The canvas's size in CSS px (the card stays inside it). */
  canvasSize(): {width: number; height: number};
  toast(message: string, kind?: 'success' | 'error'): void;
};

/** Pins nearer than this many screen px share a bubble. */
const CLUSTER_PX = 28;
const PIN = 32;
const CARD_WIDTH = 300;
const GAP = 8;
/** The floating toolbar's band at the canvas's bottom (12 px + 40 px + a gap). */
const TOOLBAR_ROOM = 64;

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.status === 0 ? 'No connection. Try again.' : error instanceof Error && error.message ? error.message : fallback;

export function CommentsLayer({controller, store, canvasSize, toast}: CommentsLayerProps) {
  const state = useCommentsState(controller);
  const pageId = useDesignStore(s => s.pageId, Object.is, {store, slice: 'page'});
  const commenting = useDesignStore(s => s.tool === COMMENT_TOOL, Object.is, {store, slice: 'tool'});
  const you = state.you?.id ?? null;
  const {openId, draft, filter, reveal, hidden} = state.ui;
  // ⇧C hid the pins: only comment mode shows them (the open thread's always).
  const shown = !hidden || commenting;

  // The page's pins in the panel's filter, oldest first (it leads a cluster); the open thread is always shown.
  const pins = useMemo(() => {
    const list = [...state.threads.values()].filter(
      thread => thread.anchor.pageId === pageId && (thread.id === openId || (shown && matchesFilter(thread, filter, you))),
    );
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
  }, [state.threads, pageId, openId, filter, you, shown]);
  const open = openId ? state.threads.get(openId) ?? null : null;

  // ── Positions ──
  const [clusters, setClusters] = useState<PinCluster[]>([]);
  const elements = useRef(new Map<string, HTMLElement>());
  const card = useRef<HTMLDivElement | null>(null);
  const draftPin = useRef<HTMLDivElement | null>(null);
  const placed = useRef<PinCluster[]>([]);
  const latest = useRef({pins, open, draft});
  latest.current = {pins, open, draft};

  const place = useCallback(() => {
    const s = store.getState();
    const viewport = currentViewport(s);
    const {pins: list, open: thread, draft: pending} = latest.current;
    const points = list.map(each => {
      const point = anchorPoint(s.doc, each.anchor);
      return {id: each.id, x: point.x * viewport.zoom, y: point.y * viewport.zoom};
    });
    // The open thread keeps a pin of its own (never inside a cluster), so its card has something to stand beside.
    const next = clusterPins(points.filter(point => point.id !== thread?.id), CLUSTER_PX);
    if (thread) {
      const own = points.find(point => point.id === thread.id);
      if (own) next.push({ids: [own.id], x: own.x, y: own.y});
    }
    if (!sameClusters(next, placed.current)) setClusters(next);
    placed.current = next;
    const offsetX = viewport.x * viewport.zoom,
      offsetY = viewport.y * viewport.zoom;
    for (const cluster of next) {
      const element = elements.current.get(cluster.ids[0]);
      if (element) element.style.translate = `${Math.round(cluster.x - offsetX)}px ${Math.round(cluster.y - offsetY - PIN)}px`;
    }
    const size = canvasSize();
    const at = (anchor: DesignCommentAnchor) => pageToScreen(viewport, anchorPoint(s.doc, anchor));
    if (pending && draftPin.current) {
      const point = at(pending.anchor);
      draftPin.current.style.translate = `${Math.round(point.x)}px ${Math.round(point.y - PIN)}px`;
    }
    const anchorOfCard = pending?.anchor ?? (thread && thread.anchor.pageId === s.pageId ? thread.anchor : null);
    if (card.current && anchorOfCard) {
      const point = at(anchorOfCard);
      const height = card.current.offsetHeight;
      let left = point.x + PIN + GAP;
      if (left + CARD_WIDTH > size.width - GAP) left = point.x - GAP - CARD_WIDTH;
      left = Math.max(GAP, Math.min(left, size.width - CARD_WIDTH - GAP));
      // Clear of the floating toolbar at the bottom.
      const top = Math.max(GAP, Math.min(point.y - PIN, size.height - height - TOOLBAR_ROOM));
      card.current.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
      // Scales in from the pin's side.
      card.current.style.transformOrigin = `${left > point.x ? 0 : CARD_WIDTH}px ${Math.round(point.y - PIN - top + PIN / 2)}px`;
    }
  }, [store, canvasSize]);

  useLayoutEffect(() => {
    place();
  });
  useEffect(() => {
    let frame = 0;
    const request = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const off = store.subscribe(request, {slice: ['viewport', 'page', 'doc']});
    window.addEventListener('resize', request);
    return () => {
      off();
      window.removeEventListener('resize', request);
      cancelAnimationFrame(frame);
    };
  }, [store, place]);

  // ── Reveal: a thread opened from the list or a link is brought into view on its page ──
  const revealed = useRef(0);
  useEffect(() => {
    if (revealed.current === reveal) return;
    revealed.current = reveal;
    if (!open) return;
    const s = store.getState();
    if (s.pageId !== open.anchor.pageId && s.doc.nodes[open.anchor.pageId]?.type === 'PAGE') store.setPage(open.anchor.pageId);
    const after = store.getState();
    const point = anchorPoint(after.doc, open.anchor);
    const viewport = currentViewport(after);
    const size = canvasSize();
    if (!size.width || !size.height) return;
    const screen = pageToScreen(viewport, point);
    const margin = 80;
    const inside = screen.x > margin && screen.x < size.width - CARD_WIDTH - margin && screen.y > margin + PIN && screen.y < size.height - margin;
    if (inside) return;
    const zoom = clampZoom(viewport.zoom);
    // The pin a little left of centre, so its card fits beside it.
    store.setViewport({zoom, x: point.x - (size.width - CARD_WIDTH) / 2 / zoom, y: point.y - size.height / 2 / zoom});
  }, [reveal, open, store, canvasSize]);

  // An open thread that gets new comments is read as they arrive.
  useEffect(() => {
    if (open && open.unread > 0) controller.markRead([open.id]);
  }, [open, controller]);

  const zoomTo = (cluster: PinCluster) => {
    const s = store.getState();
    const points = cluster.ids.map(id => state.threads.get(id)).filter((thread): thread is DesignCommentThread => !!thread).map(thread => anchorPoint(s.doc, thread.anchor));
    if (!points.length) return;
    const xs = points.map(p => p.x),
      ys = points.map(p => p.y);
    const rect = {x: Math.min(...xs), y: Math.min(...ys), width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys))};
    const zoom = currentViewport(s).zoom;
    // Pins on one point never come apart: the first one opens (the others are in the list).
    if (zoom >= 4 || (rect.width <= 1 && rect.height <= 1)) {
      controller.open(cluster.ids[0]);
      return;
    }
    // In until the closest pins come apart (at least twice as close, at most 400 %), or as far as the group still fits.
    store.setViewport(fitRect(canvasSize(), rect, 120, separatingZoom(points, CLUSTER_PX, zoom)));
  };

  const setElement = (key: string) => (element: HTMLElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
  };

  return (
    <div className="dz-comments-layer" aria-label="Comments on the canvas">
      {clusters.map(cluster => {
        if (cluster.ids.length > 1) {
          const unread = cluster.ids.some(id => (state.threads.get(id)?.unread ?? 0) > 0);
          return (
            <button key={'c:' + cluster.ids[0]} ref={setElement(cluster.ids[0])} type="button" className={`dz-comment-pin is-cluster ${unread ? 'is-unread' : ''}`.trim()}
              aria-label={`${cluster.ids.length} comments nearby, zoom in`} onClick={() => zoomTo(cluster)}>
              <span className="dz-comment-pin-count">{cluster.ids.length}</span>
            </button>
          );
        }
        const thread = state.threads.get(cluster.ids[0]);
        if (!thread) return null;
        return <Pin key={thread.id} thread={thread} open={thread.id === openId} setRef={setElement(thread.id)} onOpen={() => {
          // A pin clicked while designing opens comment mode with its thread, as a row of the list does.
          if (!commenting) store.setTool(COMMENT_TOOL);
          controller.open(thread.id === openId ? null : thread.id);
        }} />;
      })}
      {draft && (
        <div ref={draftPin} className="dz-comment-pin is-draft" aria-hidden="true">
          <Avatar person={state.you ?? {id: null, name: '?'}} />
        </div>
      )}
      {draft ? (
        <div ref={card} className="dz-comment-card is-draft" role="dialog" aria-label="New comment" key="draft" style={{width: CARD_WIDTH} as CSSProperties}>
          <Composer placeholder="Add a comment" aria-label="New comment" autoFocus you={you}
            members={state.rights.mention ? controller.members : undefined}
            onCancel={() => controller.setUI({draft: null})}
            onSubmit={async text => {
              try {
                await controller.create(draft.anchor, text);
              } catch (error) {
                toast(errorText(error, 'Could not send the comment.'), 'error');
                throw error;
              }
            }} />
        </div>
      ) : open && open.anchor.pageId === pageId ? (
        <div ref={card} className="dz-comment-card" role="dialog" aria-label="Thread" key={open.id} style={{width: CARD_WIDTH} as CSSProperties}>
          <ThreadCard thread={open} controller={controller} toast={toast} />
        </div>
      ) : null}
    </div>
  );
}

const Pin = memo(function Pin({thread, open, setRef, onOpen}: {thread: DesignCommentThread; open: boolean; setRef: (element: HTMLElement | null) => void; onOpen: () => void}) {
  const resolved = thread.resolvedAt !== null;
  const unread = thread.unread > 0;
  const replies = thread.comments.length - 1;
  const label = `Comment: ${thread.author.name}${replies > 0 ? `, replies: ${replies}` : ''}${unread ? ', unread' : ''}${resolved ? ', resolved' : ''}`;
  return (
    <button ref={setRef} type="button" className={`dz-comment-pin ${open ? 'is-open' : ''} ${unread ? 'is-unread' : ''} ${resolved ? 'is-resolved' : ''}`.trim()}
      aria-label={label} aria-expanded={open} data-thread={thread.id} onClick={onOpen}>
      {resolved ? <span className="dz-comment-pin-check"><IconCheck size={14} /></span> : <Avatar person={thread.author} />}
    </button>
  );
});

// ── The thread's card ────────────────────────────────────────────────────────────────────────────

function ThreadCard({thread, controller, toast}: {thread: DesignCommentThread; controller: CommentsController; toast: CommentsLayerProps['toast']}) {
  const state = useCommentsState(controller);
  const now = useNow();
  const you = state.you?.id ?? null;
  const {rights} = state;
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{kind: 'thread'} | {kind: 'comment'; id: string} | null>(null);
  const resolved = thread.resolvedAt !== null;
  const canResolve = rights.resolveAny || thread.author.id === you;
  const canDeleteThread = rights.deleteAny || (thread.author.id !== null && thread.author.id === you);
  const messages = useRef<HTMLDivElement>(null);
  const count = thread.comments.length;
  useLayoutEffect(() => {
    const element = messages.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count]);

  const run = async (work: () => Promise<void>, fallback: string) => {
    try {
      await work();
    } catch (error) {
      toast(errorText(error, fallback), 'error');
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(designCommentLink(location, controller.fileId, thread.id));
      toast('Comment link copied', 'success');
    } catch {
      toast('The browser did not allow access to the clipboard. Allow it for this site and try again.', 'error');
    }
  };
  const items = useCallback((): MenuItem[] => [
    {id: 'link', label: 'Copy link', onSelect: () => void copyLink()},
    ...(canDeleteThread ? [{type: 'separator'} as const, {id: 'delete', label: 'Delete thread', danger: true, onSelect: () => setConfirm({kind: 'thread'})}] : []),
  ], [canDeleteThread]); // eslint-disable-line react-hooks/exhaustive-deps
  const menu = useMenuTrigger({items, label: 'Thread actions', placement: 'bottom-end'});

  return (
    <>
      <header className="dz-comment-card-head">
        <span className="dz-comment-card-title">{resolved ? 'Resolved' : 'Comment'}</span>
        {canResolve && (
          <IconButton label={resolved ? 'Reopen' : 'Mark as resolved'} pressed={resolved} className="dz-comment-resolve"
            onClick={() => void run(() => controller.resolve(thread.id, !resolved), 'Could not update the thread.')}>
            <IconCheck />
          </IconButton>
        )}
        <IconButton label="More" tooltip={false} {...menu.triggerProps}><IconMore /></IconButton>
        {menu.element}
        <IconButton label="Close" shortcut="Escape" onClick={() => controller.open(null)}><IconClose /></IconButton>
      </header>
      <div ref={messages} className="dz-comment-messages">
        {thread.comments.map((comment, index) => (
          <article key={comment.id} className="dz-comment" aria-label={`${comment.author.name}, ${index === 0 ? 'comment' : 'reply'}`}>
            <Avatar person={comment.author} />
            <div className="dz-comment-main">
              <div className="dz-comment-meta">
                <span className="dz-comment-author">{comment.author.name}</span>
                <TimeAgo iso={comment.createdAt} now={now} />
                {comment.editedAt && <span className="dz-comment-edited">edited</span>}
              </div>
              {editing === comment.id ? (
                <Composer placeholder="Comment" aria-label="Edit comment" autoFocus saveLabel="Save" you={you}
                  initial={{text: comment.text, mentions: comment.mentions}}
                  members={rights.mention ? controller.members : undefined}
                  onCancel={() => setEditing(null)}
                  onSubmit={async draft => {
                    try {
                      await controller.edit(thread.id, comment.id, draft);
                      setEditing(null);
                    } catch (error) {
                      toast(errorText(error, 'Could not save the comment.'), 'error');
                      throw error;
                    }
                  }} />
              ) : (
                <CommentText text={comment.text} mentions={comment.mentions} you={you} />
              )}
            </div>
            <MessageMenu own={comment.author.id !== null && comment.author.id === you} canDelete={rights.deleteAny || (comment.author.id !== null && comment.author.id === you)}
              first={index === 0} onEdit={() => setEditing(comment.id)}
              onDelete={() => setConfirm(index === 0 ? {kind: 'thread'} : {kind: 'comment', id: comment.id})} />
          </article>
        ))}
      </div>
      <div className="dz-comment-reply">
        <Composer placeholder="Reply" aria-label="Reply" autoFocus={!editing} you={you}
          members={rights.mention ? controller.members : undefined}
          onCancel={() => controller.open(null)}
          onSubmit={async draft => {
            try {
              await controller.reply(thread.id, draft);
            } catch (error) {
              toast(errorText(error, 'Could not send the reply.'), 'error');
              throw error;
            }
          }} />
      </div>
      {confirm && (
        <Dialog title={confirm.kind === 'thread' ? 'Delete thread?' : 'Delete comment?'} width={360} onClose={() => setConfirm(null)}
          footer={
            <>
              <Button size={32} onClick={() => setConfirm(null)}>Cancel</Button>
              <Button size={32} variant="danger" onClick={() => {
                const target = confirm;
                setConfirm(null);
                void run(
                  () => (target.kind === 'thread' ? controller.deleteThread(thread.id) : controller.deleteComment(thread.id, target.id)),
                  'Could not delete.',
                );
              }}>Delete</Button>
            </>
          }>
          <p>
            {confirm.kind === 'thread' ? 'The comment and all its replies will disappear for everyone.' : 'The reply will disappear for everyone.'}
          </p>
        </Dialog>
      )}
    </>
  );
}

function MessageMenu({own, canDelete, first, onEdit, onDelete}: {own: boolean; canDelete: boolean; first: boolean; onEdit: () => void; onDelete: () => void}) {
  const items = useCallback((): MenuItem[] => [
    ...(own ? [{id: 'edit', label: 'Edit', onSelect: onEdit}] : []),
    ...(canDelete ? [{id: 'delete', label: first ? 'Delete thread' : 'Delete', danger: true, onSelect: onDelete}] : []),
  ], [own, canDelete, first, onEdit, onDelete]);
  const menu = useMenuTrigger({items, label: 'Comment actions', placement: 'bottom-end'});
  if (!own && !canDelete) return <span className="dz-comment-menu-spacer" />;
  return (
    <>
      <IconButton label="Comment actions" tooltip={false} className="dz-comment-menu" {...menu.triggerProps}><IconMore /></IconButton>
      {menu.element}
    </>
  );
}
