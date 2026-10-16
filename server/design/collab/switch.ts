import {collabConfigured, collabWire} from './config';

// DESIGN_COLLAB (docs/BACKEND.md §7): which path a file's co-editing takes.
//
//   legacy  today: the SSE stream down, PATCH up, Node merges and writes design_file_changes.
//   shadow  the Node path stays authoritative; every accepted PATCH (and every whole-document write) is also sent to collab's
//           POST /internal/shadow-op, which applies it to its own copy and answers its hash (shadow.ts compares and logs).
//   rust    the editor opens the socket: GET /:id/session takes the file's lease for a collab node and mints a ticket. While a
//           node holds the lease, api refuses PATCH (409 collab_active with the session URL) and forwards PUT to the node as a
//           replace; the lease, journal and checkpoints are collab's.
//
// The switch is global (DESIGN_COLLAB) with per-account and per-team overrides (DESIGN_COLLAB_ACCOUNTS: comma-separated
// `<account or team id>=<mode>`). A file's mode is its team's entry, else its holder account's (design_files.user_id: the
// personal owner, a team file's owner), else the global one: every member of a file is on the same path, whoever opens it.
// GET /api/design-files/:id/collab tells the editor the file's mode (files.ts `fileCollab`), which it picks its transport from;
// /api/config tells the signed-in account its own mode (`designCollab`), the editor's fallback for an api without that route.
//
// Whatever the mode, a live lease wins: api never writes a document a collab node holds (files.ts checks it under the file's
// row lock), so flipping the switch back while a node still holds a file is safe; reconcile.ts tells such nodes to let go.

export type CollabMode = 'legacy' | 'shadow' | 'rust';
const MODES: readonly CollabMode[] = ['legacy', 'shadow', 'rust'];

const isMode = (value: string): value is CollabMode => (MODES as readonly string[]).includes(value);

/** The global mode: DESIGN_COLLAB, `legacy` when unset or unknown. */
export function globalCollabMode(): CollabMode {
  const value = (process.env.DESIGN_COLLAB ?? '').trim();
  return isMode(value) ? value : 'legacy';
}

let parsed: {text: string; entries: Map<string, CollabMode>} | null = null;

/** DESIGN_COLLAB_ACCOUNTS as id → mode. An id may contain `=` only before the last one; unknown modes are left out. */
export function collabOverrides(): ReadonlyMap<string, CollabMode> {
  const text = process.env.DESIGN_COLLAB_ACCOUNTS ?? '';
  if (parsed?.text === text) return parsed.entries;
  const entries = new Map<string, CollabMode>();
  for (const entry of text.split(',').map(part => part.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf('=');
    const id = entry.slice(0, at).trim(),
      mode = entry.slice(at + 1).trim();
    if (at > 0 && id && isMode(mode)) entries.set(id, mode);
    else console.error(`DESIGN_COLLAB_ACCOUNTS: “${entry}” is not <id>=legacy|shadow|rust; left out.`);
  }
  parsed = {text, entries};
  return entries;
}

/** Without a configured collab node nothing can run on collab: every mode is the legacy path. */
const reachable = (mode: CollabMode): CollabMode => (mode !== 'legacy' && !collabConfigured() ? 'legacy' : mode);

/** The mode of a file: its team's override, its holder account's, or the global one. */
export function fileCollabMode(file: {user_id: string; team_id: string | null}): CollabMode {
  const overrides = collabOverrides();
  return reachable((file.team_id ? overrides.get(file.team_id) : undefined) ?? overrides.get(file.user_id) ?? globalCollabMode());
}

/** The mode of an account (what /api/config says to it). */
export function accountCollabMode(accountId: string | null | undefined): CollabMode {
  return reachable((accountId ? collabOverrides().get(accountId) : undefined) ?? globalCollabMode());
}

/** The fields /api/config adds for the editor (src/design/realtime/transport/pick.ts). */
export function collabConfigFor(accountId: string | null | undefined): {designCollab: CollabMode; designCollabWire?: 'binary'} {
  const designCollab = accountCollabMode(accountId);
  return designCollab === 'rust' && collabWire() === 'binary' ? {designCollab, designCollabWire: 'binary'} : {designCollab};
}

/** Whether this deployment may send anything to collab (a mode other than legacy somewhere, and a node). */
export function collabInUse(): boolean {
  if (!collabConfigured()) return false;
  if (globalCollabMode() !== 'legacy') return true;
  for (const mode of collabOverrides().values()) if (mode !== 'legacy') return true;
  return false;
}
