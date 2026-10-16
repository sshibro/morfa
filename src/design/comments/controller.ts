import {ApiError} from '../../api';
import type {
  DesignCommentAnchor,
  DesignCommentChange,
  DesignCommentDraft,
  DesignCommentRights,
  DesignCommentThread,
} from '../../../shared/design/comments';
import * as commentsApi from './api';
import {commentFeed} from './feed';
import type {CommentToolHost} from './tool';
import {asRead, DEFAULT_FILTER, mergeChanges, unreadCount, type CommentFilter, type Threads} from './model';

// One open file's comments (docs/design-tool.md §Teams "Comments"): the threads as the server last said, the cursor of its changes,
// the caller's rights, and the comment mode's own state (the open thread, a pin being placed, the panel's filter). Framework-agnostic: the
// lazy UI (CommentsLayer, CommentsPanel) reads it with useSyncExternalStore; the editor reads only the unread count.

export type CommentDraftPin = {anchor: DesignCommentAnchor};
export type TeamMember = {userId: string; name: string};

export type CommentsUI = {
  /** The thread whose card is open. */
  openId: string | null;
  /** A pin placed and waiting for its first comment. */
  draft: CommentDraftPin | null;
  filter: CommentFilter;
  /** Bumped to bring the open thread into view (a click in the list, a link). */
  reveal: number;
  /** ⇧C: the pins show in comment mode only (the open thread's stays). */
  hidden: boolean;
};

export type CommentsState = {
  status: 'loading' | 'ready' | 'error';
  threads: Threads;
  cursor: number;
  you: {id: string; name: string} | null;
  rights: DesignCommentRights;
  /** The last failed refresh, in the user's words. */
  error: string | null;
  ui: CommentsUI;
};

export interface CommentsController {
  readonly fileId: string;
  /** The file's team (mentions pick from its members), null for a personal file. */
  readonly teamId: string | null;
  getState(): CommentsState;
  subscribe(listener: () => void): () => void;
  /** Changes after the cursor, merged. Concurrent calls share one request. */
  pull(): Promise<void>;
  /** A thread from a write's answer or another channel. */
  apply(changes: readonly DesignCommentChange[]): void;
  setUI(partial: Partial<CommentsUI>): void;
  open(threadId: string | null, options?: {reveal?: boolean}): void;
  create(anchor: DesignCommentAnchor, draft: DesignCommentDraft): Promise<DesignCommentThread>;
  reply(threadId: string, draft: DesignCommentDraft): Promise<void>;
  edit(threadId: string, commentId: string, draft: DesignCommentDraft): Promise<void>;
  deleteComment(threadId: string, commentId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  markRead(threadIds: readonly string[]): void;
  /** Members to mention (team files), loaded once. */
  members(): Promise<TeamMember[]>;
  dispose(): void;
}

const NO_RIGHTS: DesignCommentRights = {resolveAny: false, deleteAny: false, mention: false};
const errorText = (error: unknown) =>
  error instanceof ApiError && error.status === 0
    ? 'No connection. Comments will update when it is back.'
    : error instanceof Error && error.message
      ? error.message
      : 'Could not load comments.';

export function createCommentsController(options: {fileId: string; teamId: string | null; startFeed?: boolean}): CommentsController {
  const {fileId, teamId} = options;
  let state: CommentsState = {
    status: 'loading',
    threads: new Map(),
    cursor: 0,
    you: null,
    rights: NO_RIGHTS,
    error: null,
    ui: {openId: null, draft: null, filter: DEFAULT_FILTER, reveal: 0, hidden: false},
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  const set = (next: Partial<CommentsState>) => {
    if (disposed) return;
    state = {...state, ...next};
    for (const listener of [...listeners]) listener();
  };

  let inFlight: Promise<void> | null = null;
  let again = false;
  const fetchOnce = async () => {
    const controller = new AbortController();
    try {
      const answer = await commentsApi.listComments(fileId, state.cursor, controller.signal);
      if (disposed) return;
      // A cursor ahead of the server's (a restored file) gives a full list: start over from it.
      const restart = answer.cursor < state.cursor;
      const threads = mergeChanges(restart ? new Map() : state.threads, answer.threads);
      set({status: 'ready', threads, cursor: Math.max(restart ? 0 : state.cursor, answer.cursor), you: answer.you, rights: answer.rights, error: null});
    } catch (error) {
      if (!disposed) set({status: state.status === 'loading' ? 'error' : state.status, error: errorText(error)});
    }
  };
  const pull = (): Promise<void> => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        await fetchOnce();
      } while (again && !disposed);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const apply = (changes: readonly DesignCommentChange[]) => {
    const threads = mergeChanges(state.threads, changes);
    if (threads === state.threads) return;
    const ui = state.ui.openId && !threads.has(state.ui.openId) ? {...state.ui, openId: null} : state.ui;
    set({threads, ui});
  };

  // Reading a thread marks it read here at once and on the server soon after (a burst of opens is one request).
  const pendingRead = new Set<string>();
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  const flushRead = () => {
    readTimer = null;
    const ids = [...pendingRead];
    pendingRead.clear();
    if (ids.length) void commentsApi.markCommentsRead(fileId, ids).catch(() => undefined);
  };
  const markRead = (threadIds: readonly string[]) => {
    let threads: Map<string, DesignCommentThread> | null = null;
    for (const id of threadIds) {
      const thread = state.threads.get(id);
      if (!thread) continue;
      const read = asRead(thread);
      if (read !== thread) (threads ??= new Map(state.threads)).set(id, read);
      if (thread.unread > 0 || thread.readSeq < thread.seq) pendingRead.add(id);
    }
    if (threads) set({threads});
    if (pendingRead.size && !readTimer) readTimer = setTimeout(flushRead, 300);
  };

  let memberList: Promise<TeamMember[]> | null = null;
  const members = () => {
    if (!teamId) return Promise.resolve([]);
    memberList ??= commentsApi
      .listTeamMembers(teamId)
      .then(answer => answer.members.map(member => ({userId: member.userId, name: member.name})))
      .catch(error => {
        memberList = null;
        throw error;
      });
    return memberList;
  };

  const write = async (request: Promise<{thread: DesignCommentChange}>) => {
    const {thread} = await request;
    apply([thread]);
    return thread;
  };

  const controller: CommentsController = {
    fileId,
    teamId,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    pull,
    apply,
    setUI(partial) {
      set({ui: {...state.ui, ...partial}});
    },
    open(threadId, openOptions = {}) {
      set({ui: {...state.ui, openId: threadId, draft: null, reveal: openOptions.reveal ? state.ui.reveal + 1 : state.ui.reveal}});
      if (threadId) markRead([threadId]);
    },
    async create(anchor, draft) {
      const thread = (await write(commentsApi.createCommentThread(fileId, {anchor, ...draft}))) as DesignCommentThread;
      set({ui: {...state.ui, draft: null, openId: thread.id}});
      return thread;
    },
    async reply(threadId, draft) {
      await write(commentsApi.replyToComment(fileId, threadId, draft));
    },
    async edit(threadId, commentId, draft) {
      await write(commentsApi.editComment(fileId, threadId, commentId, draft));
    },
    async deleteComment(threadId, commentId) {
      await write(commentsApi.deleteComment(fileId, threadId, commentId));
    },
    async deleteThread(threadId) {
      await write(commentsApi.deleteCommentThread(fileId, threadId));
    },
    async resolve(threadId, resolved) {
      await write(commentsApi.resolveCommentThread(fileId, threadId, resolved));
    },
    markRead,
    members,
    dispose() {
      disposed = true;
      stopFeed?.();
      if (readTimer) clearTimeout(readTimer);
      flushRead();
      listeners.clear();
    },
  };
  const stopFeed = options.startFeed === false ? null : commentFeed()({fileId, pull});
  return controller;
}

/** Unread comments in open threads, for the editor's badge. */
export const unreadOf = (state: CommentsState) => unreadCount(state.threads);

/** What the comment tool's clicks and Escape do in this file: a click places a pin waiting for its first comment (shown as soon as the
 *  lazy layer is there, so a click right after C is never lost); Escape closes an open card or that pin. */
export function commentToolHost(controller: CommentsController): CommentToolHost {
  return {
    place(anchor) {
      controller.setUI({draft: {anchor}, openId: null});
    },
    escape() {
      const {ui} = controller.getState();
      if (!ui.draft && !ui.openId) return false;
      controller.setUI({draft: null, openId: null});
      return true;
    },
    pinsShown: () => !controller.getState().ui.hidden,
    togglePins() {
      controller.setUI({hidden: !controller.getState().ui.hidden});
    },
  };
}
