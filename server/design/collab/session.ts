import {readFileSync} from 'node:fs';
import {db} from '../../db';
import {prepared} from '../../postgresql/client';
import type {CustomerAuthority} from '../../customer-authority';
import {canEditTeamFiles, type DesignTeamRole} from '../../../shared/design/teams';
import {forgetDocument} from '../document-cache';
import {designFail, notFound} from '../errors';
import {recordCollab} from '../live/hub';
import {collabConfigured, socketUrlOf} from './config';
import {knownNode, LEASE_TTL_MS, nodeFor, takeOrFindLease, watchCollabHealth} from './leases';
import {collabOverrides, globalCollabMode, type CollabMode} from './switch';
import {mintTicket, ticketKey, TICKET_TTL_SECONDS} from './tickets';

// GET /api/design-files/:id/session (docs/BACKEND.md §2 "Routing and the lease", §11; TARGETS A2): where the file's actor runs and a
// ticket for its socket. The caller must be able to view the file (fileAccess, as the SSE stream); the file must be in
// DESIGN_COLLAB=rust (409 `collab_inactive` otherwise: the editor stays on SSE + PATCH). The lease is found, or taken for the node
// the file hashes to; the ticket (60 s) carries the role the file gives the caller now (a trashed file: viewer).

export type CollabSessionAnswer = {wsUrl: string; ticket: string; version: number; node: string; expiresAt: number};

export const sessionUrlOf = (fileId: string) => `/api/design-files/${encodeURIComponent(fileId)}/session`;

const INACTIVE = 'This file is edited without a separate co-editing server.';

const unavailable = (message = 'Co-editing is unavailable right now. Try again in a few seconds.'): never =>
  designFail(503, 'design_unavailable', message, {retryable: true});

const FILE_ID = /^[0-9a-f-]{36}$/;

type SessionRow = {
  id: string;
  user_id: string;
  team_id: string | null;
  trashed: boolean;
  role: DesignTeamRole;
  name: string | null;
  mode: CollabMode;
  /** Set when this statement took the lease. */
  taken_node: string | null;
  taken_version: string | number | null;
  /** The holder before it (when it did not take it). */
  collab_node: string | null;
  version: string | number;
  live: boolean;
};

/**
 * The whole of /session's database work in one statement (TARGETS A2: a ticket is asked for on every open and reconnect):
 * - file-access.ts `fileAccess(…, 'view')` with the session check of `designRead`: the caller's live session, the account not
 *   closing, the file reachable by the one rule file-access.ts `fileRoleJoins` (its owner, its live team's members, its guests;
 *   sql/session.sql holds that rule's text, and tests/postgresql-runtime-design-file-sharing.test.ts keeps the two the same);
 * - switch.ts `fileCollabMode`, from the overrides passed in (the team's entry, then the holder's, then the global mode);
 * - leases.ts `takeOrFindLease`: in rust mode an idle file's lease is taken for `node` (the fence moves up), a live holder is found.
 * No row: 404, as for a file that does not exist (a session that ended a moment ago is answered 404 rather than 401).
 */
const SESSION = prepared(readFileSync(new URL('./sql/session.sql', import.meta.url), 'utf8'));

async function sessionRow(actor: CustomerAuthority, fileId: string, node: string): Promise<SessionRow | undefined> {
  if (!FILE_ID.test(fileId)) return undefined;
  const overrides = [...collabOverrides()];
  return db.one<SessionRow>(SESSION, [
    fileId,
    actor.ownerId,
    actor.sessionHash,
    Date.now(),
    overrides.map(([id]) => id),
    overrides.map(([, mode]) => mode),
    globalCollabMode(),
    node,
    LEASE_TTL_MS,
  ]);
}

/** A node took the file's lease (here, or a collab node's /session: internal-router.ts): it owns the document from now on, so
 *  what this process holds of it is only a stale copy, and open SSE streams of the file are told to move to the socket. */
export function leaseTaken(fileId: string) {
  forgetDocument(fileId);
  recordCollab(fileId, {mode: 'rust', sessionUrl: sessionUrlOf(fileId)});
}

export async function openCollabSession(actor: CustomerAuthority, fileId: string, origin: string | null): Promise<CollabSessionAnswer> {
  const key = ticketKey();
  if (!key) unavailable();
  // Without a node nothing runs on collab (switch.ts): the file is on the legacy path.
  if (!collabConfigured()) designFail(409, 'collab_inactive', INACTIVE, {mode: 'legacy'});
  watchCollabHealth();
  const target = nodeFor(fileId) ?? unavailable();
  const row = await sessionRow(actor, fileId, target.name);
  if (!row) return notFound();
  const name = [...(row.name ?? '').trim()].slice(0, 80).join('') || 'Member';
  if (row.mode !== 'rust') designFail(409, 'collab_inactive', INACTIVE, {mode: row.mode});
  // Taken by this statement, or a live holder found; else (taken or released by another statement meanwhile) read again.
  const lease = row.taken_node
    ? {holder: {node: row.taken_node}, taken: true, version: Number(row.taken_version)}
    : row.collab_node && row.live
      ? {holder: {node: row.collab_node}, taken: false, version: Number(row.version)}
      : ((await takeOrFindLease(row.id, target)) ?? unavailable());
  const holder = knownNode(lease.holder.node) ?? unavailable();
  if (lease.taken) leaseTaken(row.id);
  const role = !row.trashed || !canEditTeamFiles(row.role) ? row.role : 'viewer';
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const ticket = mintTicket(key!, {
    file: row.id,
    user: actor.ownerId,
    name,
    role,
    ...(row.team_id ? {team: row.team_id} : {}),
    ...(origin ? {origin} : {}),
    exp,
  });
  return {wsUrl: socketUrlOf(holder, row.id), ticket, version: lease.version, node: holder.name, expiresAt: exp * 1000};
}
