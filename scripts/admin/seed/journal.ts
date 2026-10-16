// The activity journal of the demo (admin_activity): one row per recorded request, as server/app.ts records them: a signed-in account's
// successful request, GETs as `read` at most once a minute (server/admin/telemetry.ts recordActivity), anything else as its masked route
// (`safeRoute(req.method + ' ' + req.path)`: ids become `:id`). The model adds the writes as they happen; reads fill each session.
import type {Account} from './people';
import type {Random} from './random';
import type {Tables} from './tables';
import {MINUTE, iso} from './time';

type Entry = {account: Account; at: number; action: string};

export class Journal {
  readonly entries: Entry[] = [];
  add(account: Account, at: number, action: string): void {
    this.entries.push({account, at, action});
  }
}

/** How often a session's screens ask the server for something (a GET at least once in this many seconds, on average). */
const READ_GAP_SECONDS = {bounce: 95, casual: 110, regular: 125, power: 140} as const;

/** Reads for every session, then every row in time order. Rows of erased accounts went with them; nothing is recorded for an account
 *  once it asked to close (recordActivity checks deletion_requested_at), or after now. */
export function writeJournal(rng: Random, t: Tables, journal: Journal, accounts: Account[], now: number): void {
  for (const account of accounts) {
    const mean = READ_GAP_SECONDS[account.engagement];
    for (const session of account.sessions) {
      let at = session.start + rng.uniform(1, 8) * 1000;
      while (at < session.end) {
        journal.add(account, at, 'read');
        // A read within a minute of the last one is not recorded.
        at += MINUTE + rng.exponential((mean - 60) * 1000);
      }
    }
  }
  const rows = journal.entries.filter(
    e =>
      e.account.fate !== 'erased' &&
      e.at < now &&
      e.at >= e.account.signupAt &&
      e.at < (e.account.closedAt ?? Infinity),
  );
  rows.sort((a, b) => a.at - b.at);
  for (const e of rows)
    t.admin_activity.add({id: rng.uuid(), user_id: e.account.id, action: e.action, created_at: iso(e.at)});
}
