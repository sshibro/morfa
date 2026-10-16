// The whole demo history, built in memory from one seed: accounts and their sessions, teams, files and collaboration, the activity
// journal; then the accounts' own rows (users, cookies) and the erasure of the erased ones, exactly as
// server/launch/lifecycle.ts eraseAccount leaves an account: the row anonymised, its data gone.
import {documentKit} from './documents';
import {Journal, writeJournal} from './journal';
import {assignFates, buildSessions, createAccounts, type Account, type ModelOptions} from './people';
import {buildProduct, buildTeams} from './product';
import {Random} from './random';
import {emptyTables, type Tables} from './tables';
import {DAY, textTime} from './time';

/** A browser's sign-in lasts this long (server/auth.ts SESSION_MAX_AGE_MS). */
const COOKIE_DAYS = 7;

export type World = {
  tables: Tables;
  accounts: Account[];
  /** Every demo account id, the erased ones included. */
  users: string[];
};

export function buildWorld(options: ModelOptions): World {
  const root = new Random(`morfa-demo:${options.seed}`);
  const t = emptyTables(),
    journal = new Journal(),
    now = options.now;
  const kit = documentKit(root.fork('documents'));
  const accounts = createAccounts(root.fork('accounts'), options);
  assignFates(root.fork('fates'), accounts, options);
  const sessions = root.fork('sessions');
  for (const account of accounts) buildSessions(sessions, account, options);

  const teams = buildTeams({rng: root.fork('teams'), t, journal, now, kit}, accounts);
  buildProduct({rng: root.fork('product'), t, journal, now, kit}, accounts, teams);
  writeAccounts(root.fork('users'), t, accounts, now);
  writeJournal(root.fork('journal'), t, journal, accounts, now);
  erase(t, new Set(accounts.filter(a => a.fate === 'erased').map(a => a.id)));
  return {tables: t, accounts, users: accounts.map(a => a.id)};
}

/** The account rows, the browsers signed in (the last one of each person, some long expired) and the erasure ledger. */
function writeAccounts(rng: Random, t: Tables, accounts: Account[], now: number): void {
  for (const a of accounts) {
    const erased = a.fate === 'erased';
    t.users.add({
      id: a.id,
      email: erased ? `erased-${a.id}@invalid.local` : a.email,
      name: erased ? 'Deleted account' : a.name,
      password: '',
      email_verified: erased ? 0 : a.emailVerified ? 1 : 0,
      created_at: textTime(a.signupAt),
      deletion_requested_at: a.closedAt === null ? null : textTime(a.closedAt),
      erasure_completed_at: a.erasedAt === null ? null : textTime(a.erasedAt),
    });
    if (erased) t.erasure_ledger.add({id: a.id, kind: 'account', erased_at: textTime(a.erasedAt!)});
    // Closing ends every session (server/launch/lifecycle.ts closeAccount).
    if (a.fate !== 'live' || !a.sessions.length) continue;
    let cookie = a.sessions[0].start;
    for (const s of a.sessions) if (s.start > cookie + COOKIE_DAYS * DAY) cookie = s.start;
    t.sessions.add({
      token: rng.hex(64),
      user_id: a.id,
      expires: Math.round(cookie + COOKIE_DAYS * DAY),
      created_at: textTime(cookie),
    });
    // A second device now and then (a phone), signed in on a recent visit.
    const recent = a.sessions.filter(s => s.start > now - 14 * DAY);
    if (recent.length && rng.chance(0.2)) {
      const at = rng.pick(recent).start;
      if (at !== cookie)
        t.sessions.add({
          token: rng.hex(64),
          user_id: a.id,
          expires: Math.round(at + COOKIE_DAYS * DAY),
          created_at: textTime(at),
        });
    }
  }
}

/** What erasure removes for these accounts (their files with everything in them, journal). */
function erase(t: Tables, erased: ReadonlySet<string>): void {
  if (!erased.size) return;
  const keep = <R extends Record<string, unknown>>(rows: R[], drop: (row: R) => boolean) =>
    rows.filter(row => !drop(row));
  const by = (key: string, set: ReadonlySet<string>) => (row: Record<string, unknown>) => set.has(row[key] as string);
  const files = new Set(t.design_files.rows.filter(by('user_id', erased)).map(r => r.id as string));
  const threads = new Set(t.design_comment_threads.rows.filter(by('file_id', files)).map(r => r.id as string));
  const comments = new Set(t.design_comments.rows.filter(by('thread_id', threads)).map(r => r.id as string));
  const libraries = new Set(t.design_libraries.rows.filter(by('file_id', files)).map(r => r.id as string));
  t.sessions.rows = keep(t.sessions.rows, by('user_id', erased));
  t.admin_activity.rows = keep(t.admin_activity.rows, by('user_id', erased));
  t.design_team_members.rows = keep(t.design_team_members.rows, by('user_id', erased));
  t.design_files.rows = keep(t.design_files.rows, by('id', files));
  t.design_file_versions.rows = keep(t.design_file_versions.rows, by('file_id', files));
  t.design_images.rows = keep(
    t.design_images.rows,
    r => files.has(r.file_id as string) || erased.has(r.user_id as string),
  );
  t.design_file_members.rows = keep(
    t.design_file_members.rows,
    r => files.has(r.file_id as string) || erased.has(r.user_id as string),
  );
  t.design_favourite_files.rows = keep(
    t.design_favourite_files.rows,
    r => files.has(r.file_id as string) || erased.has(r.user_id as string),
  );
  t.design_comment_threads.rows = keep(t.design_comment_threads.rows, by('id', threads));
  t.design_comments.rows = keep(t.design_comments.rows, by('id', comments));
  t.design_comment_mentions.rows = keep(
    t.design_comment_mentions.rows,
    r => comments.has(r.comment_id as string) || erased.has(r.user_id as string),
  );
  t.design_comment_reads.rows = keep(
    t.design_comment_reads.rows,
    r => threads.has(r.thread_id as string) || erased.has(r.user_id as string),
  );
  t.design_libraries.rows = keep(t.design_libraries.rows, by('id', libraries));
  t.design_library_versions.rows = keep(t.design_library_versions.rows, by('library_id', libraries));
  t.design_library_subscriptions.rows = keep(
    t.design_library_subscriptions.rows,
    r => libraries.has(r.library_id as string) || files.has(r.file_id as string),
  );
  t.design_meetings.rows = keep(t.design_meetings.rows, by('file_id', files));
  t.design_meeting_votes.rows = keep(
    t.design_meeting_votes.rows,
    r => files.has(r.file_id as string) || erased.has(r.user_id as string),
  );
  // Comments it wrote in other people's files stay, detached from it.
  for (const row of t.design_comments.rows) if (erased.has(row.author_id as string)) row.author_id = null;
  for (const row of t.design_comment_threads.rows) if (erased.has(row.author_id as string)) row.author_id = null;
}
