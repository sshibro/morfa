import {DESIGN_COMMENT_POLL_MS} from '../../../shared/design/comments';

// How an open file hears about other people's comments (docs/design-tool.md §Teams "Comments").
//
// THE HOOK for real-time: a feed is started once per open file with `pull`, which fetches the changes after the controller's cursor
// (`GET /api/design-files/:id/comments?since=`) and merges them. The default feed polls: at once, then every 20 seconds while the tab is
// visible, and again when the tab comes back or the window regains focus. A real-time channel (co-editing's socket) replaces it with
// `setCommentFeed(feed)` and calls `pull()` when the server says the file's comments changed (its message needs no payload: the cursor
// fetch is cheap and keeps one merge path), keeping a slow poll as a fallback if it likes.

export type CommentFeedTarget = {
  fileId: string;
  /** Fetches and merges what changed after the cursor; never rejects (a failure is shown by the controller and retried next time). */
  pull(): Promise<void>;
};
/** Starts delivering changes for one open file; returns the stop. */
export type CommentFeed = (target: CommentFeedTarget) => () => void;

/** Polls while the tab is visible. */
export const pollingFeed: CommentFeed = ({pull}) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = stopped || !visible() ? null : setTimeout(tick, DESIGN_COMMENT_POLL_MS);
  };
  const tick = () => {
    timer = null;
    if (stopped) return;
    void pull().finally(schedule);
  };
  const wake = () => {
    if (!stopped && visible()) tick();
    else schedule();
  };
  tick();
  globalThis.document?.addEventListener('visibilitychange', wake);
  globalThis.window?.addEventListener('focus', wake);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    globalThis.document?.removeEventListener('visibilitychange', wake);
    globalThis.window?.removeEventListener('focus', wake);
  };
};

let current: CommentFeed = pollingFeed;

/** Replaces how files hear about comments (null: back to polling). Files opened afterwards use it. */
export function setCommentFeed(feed: CommentFeed | null): void {
  current = feed ?? pollingFeed;
}
const listening = new Map<string, Set<() => Promise<void>>>();

/** The feed files open with: the current one, and `commentsChanged` reaches the file while it is open. */
export const commentFeed = (): CommentFeed => target => {
  const stop = current(target);
  let pulls = listening.get(target.fileId);
  if (!pulls) listening.set(target.fileId, (pulls = new Set()));
  pulls.add(target.pull);
  return () => {
    stop();
    pulls.delete(target.pull);
    if (!pulls.size && listening.get(target.fileId) === pulls) listening.delete(target.fileId);
  };
};

/** Co-editing's stream heard that the file's comments changed (`comments` event): its open views fetch what is new now. */
export function commentsChanged(fileId: string): void {
  for (const pull of listening.get(fileId) ?? []) void pull();
}
