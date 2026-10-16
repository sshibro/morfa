import {designFail} from '../errors';
import {pushFile, replaceAtNode, CollabUnavailable} from './client';
import {collabBodyLimit, collabConfigured} from './config';
import {leaseHolder} from './leases';
import {sessionUrlOf} from './session';

// api's document writes while a collab node holds the file (docs/BACKEND.md §7 "rust"). The node owns the document: PATCH is
// refused with 409 `collab_active` and the session URL (the editor moves to the socket), and a whole document (PUT: an import, a
// restore of a version) goes to the node as a `replace` (POST /internal/replace): a new version at the actor and a row of the
// journal (`op` = the document as an inline checkpoint), and every socket reloads (`bye {replaced}`). A document larger than the node
// reads in one request (2 MiB with today's build) goes the long way: the node lets the file go, api writes it as in legacy.

/** 409 collab_active: the file is edited through its collab node; the editor reconnects through `sessionUrl`. */
export function collabActive(fileId: string): never {
  return designFail(409, 'collab_active', 'The file is open for co-editing. Reconnecting to it…', {
    sessionUrl: sessionUrlOf(fileId),
    retryable: true,
  });
}

const REPLACE_ATTEMPTS = 3;
const REPLACE_WAIT_MS = 300;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A whole document made on `baseVersion` for a file a node may hold. Resolves with the node's new version once the node committed
 * it, or null when no node holds the file (the caller writes it itself, under the row lock that keeps a node from taking it
 * meanwhile). An actor already past `baseVersion` refuses it: 409 version_conflict with its version, as a stale PUT gets. A node that
 * holds the lease but has no actor for the file (a lease /session took for a socket that never came, an actor stopping) is asked
 * again a few times, then the write is refused with 409 collab_active (retryable): api never writes a document a live lease covers.
 */
export async function forwardReplace(fileId: string, user: string, text: () => Buffer | string, baseVersion?: number): Promise<number | null> {
  if (!collabConfigured()) return null;
  for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
    const holder = await leaseHolder(fileId);
    if (!holder) return null;
    // Larger than the node reads in one request: the node lets the file go first and api writes it (below).
    if (Buffer.byteLength(text()) > collabBodyLimit()) return evictThenWrite(fileId, holder.node);
    try {
      const answer = await replaceAtNode(holder.node, fileId, user, text(), baseVersion);
      if (answer.open && typeof answer.version === 'number') return answer.version;
      if (answer.status === 409 && answer.code === 'version_conflict')
        designFail(409, 'version_conflict', 'The file was changed in another tab. Open it again.', {currentVersion: answer.currentVersion ?? null});
      if (answer.status === 413) return evictThenWrite(fileId, holder.node);
      if (answer.status === 400)
        designFail(400, 'design_document_invalid', 'File not saved: the co-editing server did not accept the document.', {code: answer.code});
    } catch (error) {
      if (!(error instanceof CollabUnavailable)) throw error;
    }
    await sleep(REPLACE_WAIT_MS);
  }
  return collabActive(fileId);
}

const EVICT_WAIT_MS = 5_000;

/** The node is told to let the file go (`bye {replaced}`: its actor stores what is queued and releases the lease); once the lease
 *  is free the caller writes the document itself (null), and the editors reconnect to a node that loads it. Still held after
 *  EVICT_WAIT_MS (or taken again at once by a reconnecting editor): 409 collab_active, retryable. */
async function evictThenWrite(fileId: string, node: string): Promise<null> {
  await pushFile(node, fileId, {close: 'replaced'}).catch(() => undefined);
  const deadline = Date.now() + EVICT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await leaseHolder(fileId))) return null;
    await sleep(100);
  }
  return collabActive(fileId);
}
