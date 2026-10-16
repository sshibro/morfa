import {startSpan} from '../../observability/tracing';
import {collabNode, collabSecret, type CollabNode} from './config';

// api → collab over the private network (crates/collab/src/internal.rs, router.rs): `Authorization: Bearer <secret>`, JSON
// bodies as crates/protocol/schema.json and internal.rs read them. Every call has a deadline; a node that does not answer is
// an error the caller decides about (pushes are best effort: collab re-validates every connection through api every 20 s).

export class CollabUnavailable extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;

export type CollabAnswer<T> = {status: number; body: T};

/** One internal request to `node`. Throws CollabUnavailable on a network error, a timeout or a missing secret. */
export async function collabRequest<T = Record<string, unknown>>(
  node: CollabNode | string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CollabAnswer<T>> {
  const target = typeof node === 'string' ? collabNode(node) : node;
  if (!target) throw new CollabUnavailable(`collab node ${String(node)} is not configured (DESIGN_COLLAB_NODES)`);
  const secret = collabSecret();
  if (!secret) throw new CollabUnavailable('DESIGN_COLLAB_INTERNAL_SECRET is not set');
  let response: Response;
  // OTLP client span (server/observability/tracing.ts; lane B5): api → collab's /internal/*.
  const span = startSpan(`${method} ${route.replace(/\/[^/]*\d[^/]*/g, '/:id')}`, 'client', {'collab.node': target.name});
  try {
    response = await fetch(target.internal + route, {
      method,
      headers: {authorization: `Bearer ${secret}`, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    span.end({}, (error as Error).message);
    throw new CollabUnavailable(`collab ${target.name} ${route}: ${(error as Error).message}`);
  }
  span.end({'http.response.status_code': response.status});
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = {text};
  }
  if (response.status === 403) throw new CollabUnavailable(`collab ${target.name} refused the internal secret`, 403);
  return {status: response.status, body: parsed as T};
}

/** POST /internal/acl: the user's role in an open file changed (null: access removed, the user's sockets close). */
export const pushAcl = (node: string, file: string, user: string, role: string | null) =>
  collabRequest<{open: boolean}>(node, 'POST', '/internal/acl', {file, user, role});

/** POST /internal/file: renamed (`name`), or closed with a `bye` reason (`trashed`, `erased`, `moved`, `shutdown`, …). */
export const pushFile = (node: string, file: string, change: {name?: string; close?: string}) =>
  collabRequest<{open: boolean}>(node, 'POST', '/internal/file', {file, ...change});

/** POST /internal/replace: the whole document of an open file replaced (api's PUT, a restore), made on `baseVersion`. `{open: false}`
 *  when the node has no actor for the file; 409 `version_conflict` (with `currentVersion`) when the actor moved past `baseVersion`.
 *  The node answers once the new version is committed. The body goes as a prepared string (a document can be 20 MB). */
export async function replaceAtNode(
  node: string,
  file: string,
  user: string,
  documentText: string | Buffer,
  baseVersion?: number,
): Promise<{open: boolean; version?: number; status: number; code?: string; currentVersion?: number}> {
  const base = baseVersion === undefined ? '' : `,"baseVersion":${baseVersion}`;
  const body = `{"file":${JSON.stringify(file)},"user":${JSON.stringify(user)}${base},"document":${documentText.toString()}}`;
  const answer = await collabRequest<{open?: boolean; version?: number; code?: string; currentVersion?: number}>(node, 'POST', '/internal/replace', body, 60_000);
  return {open: answer.body?.open === true, version: answer.body?.version, status: answer.status, code: answer.body?.code, currentVersion: answer.body?.currentVersion};
}

/** POST /internal/notice: a file-class event for the file's sockets (comments, meeting); a 404/405 answer (an older collab
 *  build) is `false`. */
export async function pushNotice(node: string, file: string, notice: Record<string, unknown>): Promise<boolean> {
  const answer = await collabRequest(node, 'POST', '/internal/notice', {file, ...notice}, 2_000);
  return answer.status >= 200 && answer.status < 300;
}

export type ShadowAnswer = {version?: number; hash?: string | null; applied?: boolean; fallback?: boolean; refused?: unknown; code?: string};

/** POST /internal/shadow-op (BACKEND §7 step 2). */
export const shadowOp = (node: CollabNode | string, body: string) => collabRequest<ShadowAnswer>(node, 'POST', '/internal/shadow-op', body, 30_000);

/** GET /internal/shadow-doc/:file: collab's shadow copy of a file (`{version, document}`), so a mismatch names the exact path. */
export const shadowDoc = (node: CollabNode | string, file: string) =>
  collabRequest<{version?: number; document?: unknown; code?: string}>(node, 'GET', `/internal/shadow-doc/${encodeURIComponent(file)}`, undefined, 30_000);

/** GET /internal/doc/:file of an open actor: `{version, committed, hash, nodes, conns, tail}`. */
export const inspectDoc = (node: string, file: string) =>
  collabRequest<{version: number; committed: number; hash: string; nodes: number; conns: number; tail: number; code?: string}>(
    node,
    'GET',
    `/internal/doc/${encodeURIComponent(file)}`,
    undefined,
    30_000,
  );
