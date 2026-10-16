import {db} from '../../db';
import {liveState, recordCollab} from '../live/hub';
import {collabConfigured, collabNode} from './config';
import {pushFile} from './client';
import {sessionUrlOf} from './session';
import {fileCollabMode} from './switch';

// Flipping a file back (DESIGN_COLLAB rust → shadow|legacy, docs/BACKEND.md §7 "Roll back = flip the flag"): a node that still
// holds a file the switch no longer puts on collab is told to let it go (`/internal/file {close: moved}`: the actor stores what is
// queued, releases the lease and closes its sockets with `bye {moved}`; the editors reconnect through /session, which now answers
// 409 collab_inactive, and go back to SSE + PATCH). Until the lease is released api keeps refusing PATCH for the file
// (files.ts: a live lease always wins), so no write of the two paths ever overlaps. Runs at start, every RECONCILE_EVERY_MS while a
// collab node is configured, and on demand after the switch changes (`reconcileCollab()`).

const RECONCILE_EVERY_MS = 10_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Tells the nodes to let go of the files the switch no longer puts on collab; resolves with how many it told. */
export async function reconcileCollab(): Promise<number> {
  if (!collabConfigured()) return 0;
  const held = await db.many<{id: string; user_id: string; team_id: string | null; collab_node: string}>(
    'SELECT id,user_id,team_id,collab_node FROM design_files WHERE collab_node IS NOT NULL AND lease_until>=clock_timestamp()',
  );
  let told = 0;
  for (const file of held) {
    if (fileCollabMode(file) === 'rust' || !collabNode(file.collab_node)) continue;
    try {
      await pushFile(file.collab_node, file.id, {close: 'moved'});
      told++;
    } catch (error) {
      console.error('collab reconcile:', (error as Error).message);
    }
  }
  return told;
}

const announced = new Set<string>();

/**
 * Flipping a file onto collab (legacy|shadow → rust): the SSE streams this process holds for it hear `collab {mode, sessionUrl}` once,
 * so an editor that opened the file on SSE can move to the socket without a reload (lane B3's live session); its PATCHes keep
 * landing until a node takes the file, then 409 collab_active says the same. Resolves with how many files were announced.
 */
export async function announceCollab(): Promise<number> {
  if (!collabConfigured()) return 0;
  const open = liveState().files.filter(file => file.connections > 0).map(file => file.fileId);
  for (const id of [...announced]) if (!open.includes(id)) announced.delete(id);
  if (!open.length) return 0;
  const rows = await db.many<{id: string; user_id: string; team_id: string | null}>('SELECT id,user_id,team_id FROM design_files WHERE id=ANY($1::text[])', [open]);
  let count = 0;
  for (const file of rows) {
    if (fileCollabMode(file) !== 'rust') {
      announced.delete(file.id);
      continue;
    }
    if (announced.has(file.id)) continue;
    announced.add(file.id);
    recordCollab(file.id, {mode: 'rust', sessionUrl: sessionUrlOf(file.id)});
    count++;
  }
  return count;
}

/** After the switch changed: open SSE files moving to collab are told, files leaving it are let go by their nodes. */
export async function applyCollabSwitch(): Promise<{announced: number; released: number}> {
  return {announced: await announceCollab(), released: await reconcileCollab()};
}

export function watchCollabSwitch() {
  if (timer || !collabConfigured()) return;
  void applyCollabSwitch().catch(() => undefined);
  timer = setInterval(() => void applyCollabSwitch().catch(() => undefined), RECONCILE_EVERY_MS);
  timer.unref();
}

export function stopCollabSwitch() {
  if (timer) clearInterval(timer);
  timer = null;
}
