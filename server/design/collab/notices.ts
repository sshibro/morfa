import {collabConfigured} from './config';
import {pushFile, pushNotice} from './client';
import {leaseHolder} from './leases';

// The file-class events of a file a collab node holds (docs/BACKEND.md §6; lane B6): what the SSE hub tells the open editors of
// a legacy file, api tells the node, which passes it to the file's sockets — a rename (`file {name}`), the file closed (trash,
// erase: `bye`), and the "changed" notices of comments and the meeting (`/internal/notice`, which rides the socket as a `file`-class
// event). The hub keeps sending all of them to its own streams whatever the mode (live/hub.ts calls these after its own work), so a
// tab still on SSE hears them too. Each is fire and forget after the commit; a node that does not answer misses it (renames and
// closes are also read again by collab's 20 s re-validation; comments and meetings have the editor's poll as their fallback).

const inFlight = new Set<Promise<unknown>>();

function later(work: () => Promise<unknown>) {
  if (!collabConfigured()) return;
  const run = work().catch(error => console.error('collab notice:', (error as Error).message));
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** For tests: resolves when every notice started so far is done. */
export async function noticesIdle(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

async function holderNode(fileId: string): Promise<string | null> {
  return (await leaseHolder(fileId))?.node ?? null;
}

export function collabFileRenamed(fileId: string, name: string) {
  later(async () => {
    const node = await holderNode(fileId);
    if (node) await pushFile(node, fileId, {name});
  });
}

/** The file went to the trash or was erased: its sockets end. `node`: the holder read before the file's row was deleted. */
export function collabFileClosed(fileId: string, reason: 'trashed' | 'erased' | 'moved', node?: string | null) {
  later(async () => {
    const holder = node ?? (await holderNode(fileId));
    if (holder) await pushFile(holder, fileId, {close: reason});
  });
}

/** Comments changed: the sockets fetch what is new (`GET /:id/comments?since=`), as the SSE `comments` event says. */
export function collabCommentsChanged(fileId: string) {
  later(async () => {
    const node = await holderNode(fileId);
    if (node) await pushNotice(node, fileId, {kind: 'comments'});
  });
}

/** The meeting (timer, vote) changed as `revision`; with `user`, only that person's own votes. */
export function collabMeetingChanged(fileId: string, change: {revision: number; user?: string}) {
  later(async () => {
    const node = await holderNode(fileId);
    if (node) await pushNotice(node, fileId, {kind: 'meeting', revision: change.revision, ...(change.user ? {user: change.user} : {})});
  });
}
