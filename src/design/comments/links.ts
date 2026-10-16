import {DESIGN_COMMENT_PARAM} from '../../../shared/design/comments';
import type {DesignStore} from '../engine/store';
import type {CommentsController} from './controller';
import {COMMENT_TOOL} from './tool';

// "Copy link" on a thread gives `<app>/#design/<file>?comment=<thread>`. The app's router reads only the file id before `?`
// (navigation.ts `designIdFromHash`); this module reads the rest once the file's comments have loaded: comment mode, the thread's page,
// the pin in view and its card open. A thread that is gone says so.

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
};

/** The thread a `#design/<file>?comment=<id>` hash names for this file, or null. */
export function linkedThreadId(hash: string, fileId: string): string | null {
  if (!hash.startsWith('#design/')) return null;
  const rest = hash.slice('#design/'.length);
  const at = rest.indexOf('?');
  if (at < 0 || decode(rest.slice(0, at)) !== fileId) return null;
  return new URLSearchParams(rest.slice(at + 1)).get(DESIGN_COMMENT_PARAM) || null;
}

/** Honours `?comment=` now and whenever the hash changes while the file is open. */
export function followCommentLinks(options: {
  controller: CommentsController;
  store: DesignStore;
  toast(message: string): void;
  location?: Pick<Location, 'hash'>;
  target?: EventTarget;
}): () => void {
  const {controller, store} = options;
  const where = options.location ?? globalThis.location;
  const target = options.target ?? globalThis.window;
  let wanted: string | null = null;
  let off: (() => void) | null = null;
  const settle = () => {
    const state = controller.getState();
    if (!wanted || state.status === 'loading') return;
    const id = wanted;
    wanted = null;
    off?.();
    off = null;
    const thread = state.threads.get(id);
    if (!thread) {
      options.toast(state.status === 'error' ? 'Could not load comments. Open the link again.' : 'The linked comment was not found: it may have been deleted.');
      return;
    }
    if (thread.resolvedAt !== null && state.ui.filter.status !== 'resolved') controller.setUI({filter: {...state.ui.filter, status: 'resolved'}});
    if (store.getState().tool !== COMMENT_TOOL) store.setTool(COMMENT_TOOL);
    controller.open(id, {reveal: true});
  };
  const follow = () => {
    const id = linkedThreadId(where.hash, controller.fileId);
    if (!id) return;
    wanted = id;
    off?.();
    off = controller.subscribe(settle);
    settle();
  };
  follow();
  target?.addEventListener('hashchange', follow);
  return () => {
    target?.removeEventListener('hashchange', follow);
    off?.();
  };
}
