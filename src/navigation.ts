// In-app navigation requests from places that do not hold App state (the file browser, the editor's menus,
// commands). App listens and switches the view after the editor's save guard. Morfa's own: the file browser (#designs), one file (#design/<id>), the operator's console (#admin…) and
// signing out; nothing else exists.

export type NavigationRequest =
  /** The file browser, `#designs`. */
  | {kind?: 'workspace'; view: 'designs'}
  /** A file in the editor (or its player), `#design/<id>`. */
  | {kind: 'design'; fileId: string}
  /** The operator's console (src/admin), `#admin[/…][?…]`: `route` is the address after "#", `admin` when left out.
   *  Only operators reach it (App); for anyone else it is the file browser. */
  | {kind: 'admin'; route?: string}
  /** Leave the tool: save, end the session, show the sign-in. */
  | {kind: 'sign-out'};

export type NavigationTarget =
  | {kind: 'workspace'; view: 'designs'}
  | {kind: 'design'; fileId: string}
  | {kind: 'admin'; route: string}
  | {kind: 'sign-out'};

/** `#admin`, `#admin/…` and `#admin?…`; not `#administrator`. */
export const isAdminHash = (hash: string) => /^#admin(?:[/?]|$)/.test(hash);

const adminRoute = (route: string | undefined) => (route && isAdminHash('#' + route) ? route : 'admin');

export const normalizeNavigation = (request: NavigationRequest): NavigationTarget =>
  request.kind === 'design' || request.kind === 'sign-out'
    ? request
    : request.kind === 'admin'
      ? {kind: 'admin', route: adminRoute(request.route)}
      : {kind: 'workspace', view: 'designs'};

export const NAVIGATION_EVENT = 'forma-navigate';

export function requestNavigation(detail: NavigationRequest) {
  window.dispatchEvent(new CustomEvent<NavigationRequest>(NAVIGATION_EVENT, {detail}));
}

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
};

/** The file id of `#design/<id>[?…]`, or '' for any other hash. */
export const designIdFromHash = (hash: string) => (hash.startsWith('#design/') ? decode(hash.slice('#design/'.length).split('?')[0]) : '');

/** Where an address points: a file, the console (only when `admin`: the account is an operator), or the file browser for every
 *  other hash. */
export function navigationFromUrl(url: Pick<URL, 'hash'>, {admin = false}: {admin?: boolean} = {}): NavigationTarget {
  const fileId = designIdFromHash(url.hash);
  if (fileId) return {kind: 'design', fileId};
  if (admin && isAdminHash(url.hash)) return {kind: 'admin', route: url.hash.slice(1)};
  return {kind: 'workspace', view: 'designs'};
}

/** The address of a destination; written only after the editor's save guard succeeds. */
export function navigationUrl(request: NavigationRequest, current: Pick<URL, 'pathname' | 'search'>): string {
  const target = normalizeNavigation(request);
  const hash = target.kind === 'design' ? 'design/' + encodeURIComponent(target.fileId) : target.kind === 'admin' ? target.route : 'designs';
  return current.pathname + current.search + '#' + hash;
}
