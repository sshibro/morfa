import {Fragment, memo, useCallback, useMemo} from 'react';
import type {DesignCommentThread} from '../../../../shared/design/comments';
import type {DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button, IconButton} from '../../ui/Button';
import {IconComment, IconSearch, IconSliders} from '../../ui/icons';
import {TextInput} from '../../ui/TextInput';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {EmptyState} from '../../ui/ProgressBar';
import {Kbd, Spinner} from '../../ui/Spinner';
import {SegmentedControl} from '../../ui/Tabs';
import type {CommentsController} from '../controller';
import {listThreads, repliesLabel, unreadCount} from '../model';
import {COMMENT_TOOL} from '../tool';
import {Avatar, TimeAgo, useCommentsState, useNow} from './parts';

// "Comments" in the left panel (docs/design-tool.md §Teams "Comments"): the file's threads, open or resolved, only the viewer's or
// those mentioning the viewer, found by a search of their text and people, newest first, unread first or by page. A click opens the thread on the canvas in comment mode. Rows skip layout and paint
// while scrolled out of view (content-visibility), so a file with hundreds of threads stays light.

const STATUS = [{value: 'open', label: 'Open'}, {value: 'resolved', label: 'Resolved'}] as const;

export function CommentsPanel({controller, store}: {controller: CommentsController; store: DesignStore}) {
  const state = useCommentsState(controller);
  const now = useNow();
  const {filter, openId} = state.ui;
  const you = state.you?.id ?? null;
  const pages = useDesignStore(s => s.doc.pages, Object.is, {store, slice: 'doc'});
  const pageNames = useDesignStore(s => s.doc.pages.map(id => s.doc.nodes[id]?.name ?? '').join('\u0000'), Object.is, {store, slice: 'doc'});
  const names = useMemo(() => new Map(pages.map((id, index) => [id, pageNames.split('\u0000')[index] || 'Page'])), [pages, pageNames]);
  const list = useMemo(() => listThreads(state.threads, filter, you, pages), [state.threads, filter, you, pages]);
  const unread = unreadCount(state.threads);

  const items = useCallback((): MenuItem[] => [
    {id: 'mine', label: 'My threads only', checked: filter.mine, onSelect: () => controller.setUI({filter: {...filter, mine: !filter.mine}})},
    {id: 'mentions', label: 'Mentioning me only', checked: filter.mentions, onSelect: () => controller.setUI({filter: {...filter, mentions: !filter.mentions}})},
    {type: 'separator'},
    {type: 'label', label: 'Sort'},
    {id: 'date', label: 'By date', radio: true, checked: filter.sort === 'date', onSelect: () => controller.setUI({filter: {...filter, sort: 'date'}})},
    {id: 'unread', label: 'Unread first', radio: true, checked: filter.sort === 'unread', onSelect: () => controller.setUI({filter: {...filter, sort: 'unread'}})},
    {id: 'page', label: 'By page', radio: true, checked: filter.sort === 'page', onSelect: () => controller.setUI({filter: {...filter, sort: 'page'}})},
    {type: 'separator'},
    {id: 'read', label: 'Mark all as read', disabled: !unread, onSelect: () => controller.markRead([...state.threads.values()].filter(thread => thread.unread > 0).map(thread => thread.id))},
  ], [filter, controller, unread, state.threads]);
  const menu = useMenuTrigger({items, label: 'Comment filters', placement: 'bottom-end', minWidth: 220});
  const narrowed = filter.mine || filter.mentions;
  const searching = !!filter.query?.trim();

  const openThread = (thread: DesignCommentThread) => {
    if (store.getState().tool !== COMMENT_TOOL) store.setTool(COMMENT_TOOL);
    controller.open(thread.id, {reveal: true});
  };

  return (
    <div className="dz-comments-panel">
      <div className="dz-comments-toolbar">
        <SegmentedControl options={STATUS} value={filter.status} onChange={status => controller.setUI({filter: {...filter, status}})} aria-label="Which threads to show" fill />
        <IconButton label="Filters and sorting" className={narrowed ? 'is-narrowed' : ''} {...menu.triggerProps}><IconSliders /></IconButton>
        {menu.element}
      </div>
      <div className="dz-comments-search">
        <TextInput value={filter.query ?? ''} onChange={query => controller.setUI({filter: {...filter, query}})} icon={<IconSearch />} placeholder="Search comments" aria-label="Search comments" />
      </div>
      {state.status === 'loading' ? (
        <div className="dz-comments-state"><Spinner size={16} label="Loading comments" /></div>
      ) : state.status === 'error' ? (
        <EmptyState tone="error" icon={<IconComment />} title="Could not load" actions={<Button onClick={() => void controller.pull()}>Retry</Button>}>
          {state.error}
        </EmptyState>
      ) : list.length ? (
        <ul className="dz-comments-list" aria-label="Threads">
          {list.map((thread, index) => {
            const group = filter.sort === 'page' && (index === 0 || list[index - 1].anchor.pageId !== thread.anchor.pageId);
            return (
              <Fragment key={thread.id}>
                {group && <li className="dz-comments-group" role="presentation">{names.get(thread.anchor.pageId) ?? 'Deleted page'}</li>}
                <ThreadRow thread={thread} now={now} open={thread.id === openId} you={you} pageName={filter.sort === 'date' && pages.length > 1 ? names.get(thread.anchor.pageId) ?? null : null} onOpen={openThread} />
              </Fragment>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={<IconComment />} title={narrowed || searching || filter.status === 'resolved' ? 'Nothing found' : 'No comments yet'}>
          {searching
            ? 'Change the query: we search comment text and member names.'
            : narrowed
            ? 'Clear the filter to see the other threads.'
            : filter.status === 'resolved'
              ? 'Resolved threads will appear here.'
              : <>Press <Kbd shortcut="KeyC" /> and click the canvas to leave a comment.</>}
        </EmptyState>
      )}
      {state.error && state.status === 'ready' && <p className="dz-comments-offline" role="status">{state.error}</p>}
    </div>
  );
}

const ThreadRow = memo(function ThreadRow({thread, now, open, you, pageName, onOpen}: {
  thread: DesignCommentThread;
  now: number;
  open: boolean;
  you: string | null;
  pageName: string | null;
  onOpen: (thread: DesignCommentThread) => void;
}) {
  const first = thread.comments[0];
  const last = thread.comments.at(-1) ?? first;
  const replies = thread.comments.length - 1;
  const mentioned = !!you && thread.comments.some(comment => comment.mentions.some(mention => mention.userId === you));
  return (
    <li>
      <button type="button" className={`dz-comment-row ${open ? 'is-open' : ''} ${thread.unread ? 'is-unread' : ''}`.trim()} aria-current={open || undefined}
        onClick={() => onOpen(thread)}>
        <Avatar person={thread.author} />
        <span className="dz-comment-row-main">
          <span className="dz-comment-meta">
            <span className="dz-comment-author">{thread.author.name}</span>
            <TimeAgo iso={last?.createdAt ?? thread.createdAt} now={now} />
            {thread.unread > 0 && <span className="dz-unread-dot" role="img" aria-label="Unread" />}
          </span>
          <span className="dz-comment-row-text">{first?.text ?? ''}</span>
          {(replies > 0 || pageName || mentioned) && (
            <span className="dz-comment-row-sub">
              {replies > 0 && <span>{repliesLabel(replies)}</span>}
              {mentioned && <span className="dz-comment-row-mention">You were mentioned</span>}
              {pageName && <span className="dz-comment-row-page">{pageName}</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  );
});

/** The right panel in comment mode, where the design tools were (as in Figma): what the mode does and how to leave it. */
export function CommentModePanel({controller, readOnly}: {controller: CommentsController; readOnly: boolean}) {
  const state = useCommentsState(controller);
  const open = [...state.threads.values()].filter(thread => thread.resolvedAt === null).length;
  const unread = unreadCount(state.threads);
  return (
    <div className="dz-comment-mode">
      <span className="dz-comment-mode-icon" aria-hidden="true"><IconComment /></span>
      <h2 className="dz-comment-mode-title">Comments</h2>
      <p>Click the canvas to leave a comment. It attaches to the frame under the cursor and moves with it.</p>
      {state.status === 'ready' && (
        <p className="dz-comment-mode-stats">
          {open ? `Open threads: ${open}` : 'No open threads'}
          {unread ? ` · unread comments: ${unread}` : ''}
        </p>
      )}
      <p className="dz-comment-mode-keys">
        <Kbd shortcut="Escape" />{readOnly ? 'return to viewing' : 'return to editing'}
      </p>
      {state.rights.mention && <p className="dz-comment-mode-note">Type "@" to mention a team member: they will see it in the "Mentioning me only" list. We do not send emails.</p>}
    </div>
  );
}

