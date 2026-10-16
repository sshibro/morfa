// What people make in the demo: team workspaces with members, roles, invites and projects; personal and team files (designs and
// boards) created and edited in sessions, with their saved versions, thumbnails and pictures; files shared with guests; comment threads with replies and mentions; shared libraries and the files that use them;
// "Board" meetings with votes and timers; stars. Every action lands in the journal at the moment it happens.
import type {DemoDocument, DocumentKit} from './documents';
import type {Journal} from './journal';
import {momentAfter, type Account} from './people';
import type {Random} from './random';
import type {Tables} from './tables';
import {
  BOARD_NAMES,
  COMMENT_REPLIES,
  COMMENT_THREADS,
  FILE_NAMES,
  LIBRARY_FILE_NAMES,
  PROJECT_NAMES,
  TEAM_NAMES,
  VERSION_LABELS,
} from './texts';
import {DAY, HOUR, MINUTE, iso} from './time';
import {DESIGN_LIMITS} from '../../../shared/design/limits';

type Role = 'owner' | 'admin' | 'editor' | 'developer' | 'viewer';
const EDITS: ReadonlySet<Role> = new Set(['owner', 'admin', 'editor']);
type Member = {account: Account; role: Role; joinedAt: number};
export type Team = {
  id: string;
  name: string;
  owner: Account;
  createdAt: number;
  members: Member[];
  projects: {id: string; createdAt: number}[];
  files: DemoFile[];
};
export type DemoFile = {
  id: string;
  holder: Account;
  team: Team | null;
  projectId: string | null;
  name: string;
  kind: 'design' | 'board';
  doc: DemoDocument;
  /** Which of the kit's documents it holds (they grow with the index). */
  variant: number;
  createdAt: number;
  creator: Account;
  trashedAt: number | null;
  /** When it was saved: each save moved the file on by one version. */
  saves: number[];
  linkAccess: 'none' | 'view' | 'edit';
  guests: Map<Account, {role: 'editor' | 'viewer' | null; at: number}>;
  library: boolean;
};
export type Product = {
  teams: Team[];
  files: DemoFile[];
};

type Context = {rng: Random; t: Tables; journal: Journal; now: number; kit: DocumentKit};

const DESIGN_WEIGHTS = [3, 3, 3, 2.5, 2, 1.5, 1.2, 0.8, 0.6, 1];
const BOARD_WEIGHTS = [3, 2, 1.5, 1];
const ROLE_WEIGHTS: readonly (readonly [Role, number])[] = [
  ['admin', 0.1],
  ['editor', 0.55],
  ['developer', 0.15],
  ['viewer', 0.2],
];

/** The teams: created by engaged people, joined by colleagues already here and by newcomers who came with an invite. */
export function buildTeams(c: Context, accounts: Account[]): Team[] {
  const {rng, t, journal, now} = c;
  const count = Math.max(4, Math.round(accounts.length * 0.04));
  const owners = rng.sample(
    accounts.filter(
      a =>
        a.fate === 'live' &&
        (a.engagement === 'regular' || a.engagement === 'power') &&
        a.signupAt < now - 10 * DAY &&
        a.sessions.length >= 3,
    ),
    count,
  );
  const people = accounts.filter(a => a.fate !== 'erased');
  const names = rng.sample(TEAM_NAMES, TEAM_NAMES.length);
  const teams: Team[] = [];
  for (const owner of owners) {
    const createdAt = momentAfter(rng, owner, owner.signupAt + rng.exponential(12 * DAY));
    if (createdAt === null || createdAt > now - 2 * DAY) continue;
    const team: Team = {
      id: rng.uuid(),
      name: names[teams.length % names.length],
      owner,
      createdAt,
      members: [{account: owner, role: 'owner', joinedAt: createdAt}],
      projects: [],
      files: [],
    };
    journal.add(owner, createdAt, 'POST /api/design-teams');
    const size = rng.weighted<number>([
      [1, 0.15],
      [2, 0.25],
      [3, 0.22],
      [4, 0.15],
      [5, 0.1],
      [6, 0.08],
      [7, 0.05],
    ]);
    for (let k = 0; k < size; k++) {
      const taken = new Set(team.members.map(m => m.account));
      const newcomers = people.filter(
        a => !taken.has(a) && a.signupAt > createdAt && a.signupAt < createdAt + 30 * DAY,
      );
      const colleagues = people.filter(
        a => !taken.has(a) && a.signupAt < createdAt && a.activeUntil > createdAt + DAY && a.engagement !== 'bounce',
      );
      const newcomer = newcomers.length > 0 && (rng.chance(0.5) || !colleagues.length);
      const pool = newcomer ? newcomers : colleagues;
      if (!pool.length) break;
      const member = rng.pick(pool);
      const joinedAt = newcomer
        ? member.signupAt + rng.uniform(1, 8) * MINUTE
        : momentAfter(rng, member, createdAt + rng.uniform(0, 3) * DAY);
      if (joinedAt === null || joinedAt > now) continue;
      const role = rng.weighted(ROLE_WEIGHTS);
      const invitedAt = Math.min(joinedAt - 30_000, Math.max(createdAt + MINUTE, joinedAt - rng.uniform(1, 72) * HOUR));
      t.design_team_invites.add({
        id: rng.uuid(),
        team_id: team.id,
        token: rng.hex(64),
        role,
        created_by: owner.id,
        created_at: iso(invitedAt),
        expires_at: iso(invitedAt + 7 * DAY),
        max_uses: 1,
        uses: 1,
        revoked_at: null,
        email: null,
      });
      journal.add(owner, invitedAt, 'POST /api/design-teams/:id/invites');
      journal.add(member, joinedAt + 20_000, 'POST /api/design-teams/invites/:token/accept');
      team.members.push({account: member, role, joinedAt});
    }
    // Invites nobody used: a link that expired, one revoked.
    for (let k = rng.int(0, 2); k > 0; k--) {
      const at = createdAt + rng.uniform(0, Math.min(60, (now - createdAt) / DAY - 1)) * DAY;
      const kind = rng.pick(['expired', 'revoked'] as const);
      t.design_team_invites.add({
        id: rng.uuid(),
        team_id: team.id,
        token: rng.hex(64),
        role: rng.pick(['editor', 'viewer'] as const),
        created_by: owner.id,
        created_at: iso(at),
        expires_at: iso(at + 7 * DAY),
        max_uses: rng.int(1, 10),
        uses: 0,
        revoked_at: kind === 'revoked' ? iso(at + rng.uniform(1, 48) * HOUR) : null,
        email: null,
      });
    }
    for (const name of rng.sample(PROJECT_NAMES, rng.int(1, 4))) {
      const at = momentAfter(rng, owner, createdAt + rng.uniform(0, 10) * DAY) ?? createdAt + MINUTE;
      if (at > now) continue;
      const project = {id: rng.uuid(), createdAt: at};
      team.projects.push(project);
      t.design_projects.add({id: project.id, team_id: team.id, name, created_at: iso(at), deleted_at: null});
      journal.add(owner, at, 'POST /api/design-teams/:id/projects');
    }
    t.design_teams.add({
      id: team.id,
      name: team.name,
      owner_id: owner.id,
      created_at: iso(createdAt),
      deleted_at: null,
    });
    for (const m of team.members)
      t.design_team_members.add({
        team_id: team.id,
        user_id: m.account.id,
        role: m.role,
        joined_at: iso(m.joinedAt),
        invited_by: m.role === 'owner' ? null : owner.id,
      });
    teams.push(team);
  }
  return teams;
}

/** Files and everything people do in them. */
export function buildProduct(c: Context, accounts: Account[], teams: Team[]): Product {
  const {rng, t, journal, now, kit} = c;
  const files: DemoFile[] = [];
  const own = new Map<Account, DemoFile[]>();
  const memberships = new Map<Account, {team: Team; member: Member}[]>();
  for (const team of teams)
    for (const member of team.members)
      memberships.set(member.account, [...(memberships.get(member.account) ?? []), {team, member}]);

  const newFile = (input: {
    creator: Account;
    team: Team | null;
    at: number;
    kind?: 'design' | 'board';
    library?: boolean;
    name?: string;
  }): DemoFile => {
    const kind = input.kind ?? (rng.chance(input.team ? 0.22 : 0.12) ? 'board' : 'design');
    const variant = rng.index(kind === 'board' ? BOARD_WEIGHTS : DESIGN_WEIGHTS);
    const doc = input.library ? kit.library.document : (kind === 'board' ? kit.boards : kit.designs)[variant];
    const file: DemoFile = {
      id: rng.uuid(),
      holder: input.team ? input.team.owner : input.creator,
      team: input.team,
      projectId: input.team && input.team.projects.length && rng.chance(0.8) ? rng.pick(input.team.projects).id : null,
      name:
        input.name ??
        (input.library ? rng.pick(LIBRARY_FILE_NAMES) : rng.pick(kind === 'board' ? BOARD_NAMES : FILE_NAMES)),
      kind,
      doc,
      variant,
      createdAt: input.at,
      creator: input.creator,
      trashedAt: null,
      saves: [],
      linkAccess: 'none',
      guests: new Map(),
      library: !!input.library,
    };
    if (file.projectId && input.team!.projects.find(p => p.id === file.projectId)!.createdAt > input.at)
      file.projectId = null;
    files.push(file);
    if (input.team) input.team.files.push(file);
    else own.set(input.creator, [...(own.get(input.creator) ?? []), file]);
    journal.add(input.creator, input.at, 'POST /api/design-files');
    return file;
  };
  const live = (list: readonly DemoFile[], at: number) =>
    list.filter(f => f.createdAt <= at && (f.trashedAt === null || f.trashedAt > at));
  // Libraries are published from a dedicated file: by engaged people in their own files or in a team.
  const publishers = new Set(
    rng.sample(
      accounts.filter(
        a => a.fate !== 'erased' && (a.engagement === 'power' || memberships.has(a)) && a.sessions.length > 4,
      ),
      Math.max(3, Math.round(accounts.length / 50)),
    ),
  );

  // Pass 1: files are made (and shared) in sessions, in time order per person.
  for (const account of accounts) {
    const rate = {bounce: 0, casual: 0.07, regular: 0.1, power: 0.14}[account.engagement];
    const firstFile = {bounce: 0.55, casual: 0.8, regular: 0.95, power: 1}[account.engagement];
    let libraryDue = publishers.has(account);
    account.sessions.forEach((session, k) => {
      const at = session.start + (session.end - session.start) * rng.uniform(0.05, 0.4);
      const mine = own.get(account) ?? [];
      if (k === 0 ? rng.chance(firstFile) : rng.chance(rate)) {
        const copy = k > 0 && mine.length > 0 && rng.chance(0.12);
        newFile({creator: account, team: null, at, name: copy ? `${rng.pick(mine).name} (copy)` : undefined});
        if (copy) journal.add(account, at - 2000, 'POST /api/design-files/:id/duplicate');
      }
      for (const {team, member} of memberships.get(account) ?? []) {
        if (member.joinedAt > session.start || !EDITS.has(member.role)) continue;
        if (!rng.chance(member.role === 'owner' ? 0.08 : 0.05)) continue;
        const when = at + rng.uniform(1, 5) * MINUTE;
        newFile({creator: account, team, at: when});
      }
      if (libraryDue && k >= 3) {
        libraryDue = false;
        const teamsHere = (memberships.get(account) ?? []).filter(
          m => EDITS.has(m.member.role) && m.member.joinedAt < at,
        );
        const team = teamsHere.length && rng.chance(0.7) ? rng.pick(teamsHere).team : null;
        newFile({creator: account, team, at: at + MINUTE, kind: 'design', library: true});
      }
      // Sharing a personal file: the file's link, and the people it was shared with.
      const shareChance = {bounce: 0, casual: 0.01, regular: 0.025, power: 0.04}[account.engagement];
      const shareable = live(mine, at).filter(f => !f.library);
      if (account.fate !== 'erased' && shareable.length && rng.chance(shareChance))
        share(rng.pick(shareable), account, at + rng.uniform(1, 10) * MINUTE);
    });
  }

  function share(file: DemoFile, owner: Account, at: number) {
    if (at > now) return;
    if (rng.chance(0.15)) {
      file.linkAccess = rng.chance(0.8) ? 'view' : 'edit';
      journal.add(owner, at, 'PATCH /api/design-files/:id/sharing');
    }
    // People share with colleagues and clients who are around; now and then with someone who never comes back.
    const candidates = accounts.filter(
      a => a !== owner && a.fate !== 'erased' && a.signupAt < at && !file.guests.has(a),
    );
    const around = candidates.filter(a => a.activeUntil > at + 2 * DAY);
    for (const guest of rng.sample(around.length && rng.chance(0.85) ? around : candidates, rng.int(1, 3))) {
      const role = rng.chance(0.5) ? 'editor' : 'viewer';
      const opened = momentAfter(rng, guest, at);
      if (opened !== null && opened < now && opened < at + 14 * DAY) {
        file.guests.set(guest, {role, at: opened});
        journal.add(guest, opened, 'GET /api/design-files/:id');
      }
    }
  }

  const editable = (account: Account, at: number): DemoFile[] => {
    const list = live(own.get(account) ?? [], at);
    for (const {team, member} of memberships.get(account) ?? [])
      if (member.joinedAt <= at && EDITS.has(member.role)) list.push(...live(team.files, at));
    for (const file of files) {
      const guest = file.guests.get(account);
      if (guest && guest.at <= at && guest.role === 'editor' && (file.trashedAt === null || file.trashedAt > at))
        list.push(file);
    }
    return list;
  };
  const picture = (
    file: DemoFile,
    at: number,
    kind: 'image' | 'thumbnail',
    size: {width: number; height: number},
    bytes: number,
  ) => {
    const hash = rng.hex(64);
    const webp = kind === 'thumbnail' || rng.chance(0.7);
    const filename = `${rng.urlSafe(22)}.${webp ? 'webp' : 'png'}`;
    t.design_images.add({
      filename,
      user_id: file.holder.id,
      file_id: file.id,
      kind,
      bytes: Math.round(bytes),
      width: size.width,
      height: size.height,
      created_at: iso(at),
      team_id: file.team?.id ?? null,
      content_hash: hash,
      storage_key: kind === 'thumbnail' ? `thumb/${hash}.webp` : `img/${hash}`,
    });
    return filename;
  };

  // Pass 2: editing. Each session works on one file (two in a long one): saves, versions, pictures, exports, stars.
  const versions: {file: DemoFile; at: number; label: string | null; by: Account}[] = [];
  const collaborative: {file: DemoFile; account: Account; at: number}[] = [];
  const thumbnails = new Map<DemoFile, number>();
  const starred = new Set<string>();
  for (const account of accounts) {
    const rate = {bounce: 0.12, casual: 0.18, regular: 0.24, power: 0.3}[account.engagement];
    for (const session of account.sessions) {
      const minutes = (session.end - session.start) / MINUTE;
      const list = editable(account, session.start + MINUTE);
      if (!list.length) continue;
      const targets = rng.sample(list, minutes > 45 && list.length > 1 ? 2 : 1);
      for (const file of targets) {
        const from = Math.max(session.start, file.createdAt) + rng.uniform(0.2, 2) * MINUTE;
        const span = session.end - from;
        if (span < MINUTE) continue;
        const saves = rng.poisson(((span / MINUTE) * rate) / targets.length);
        if (!saves) continue;
        const times = Array.from({length: saves}, () => from + rng.uniform(0, span)).sort((a, b) => a - b);
        file.saves.push(...times);
        for (const at of times) journal.add(account, at, 'PATCH /api/design-files/:id/document');
        // An automatic version once a quarter of an hour of editing has passed, a second one in a long sitting (the server takes at
        // most one per ten minutes of editing).
        const autos = times.filter(at => at - times[0] >= 15 * MINUTE);
        if (autos.length) versions.push({file, at: autos[0], label: null, by: account});
        const late = autos.find(at => at - autos[0] >= 60 * MINUTE);
        if (late !== undefined) versions.push({file, at: late, label: null, by: account});
        const end = times[times.length - 1];
        if (rng.chance(account.engagement === 'power' ? 0.06 : 0.03)) {
          versions.push({file, at: end + 20_000, label: rng.pick(VERSION_LABELS), by: account});
          journal.add(account, end + 20_000, 'POST /api/design-files/:id/versions');
        }
        if (rng.chance(0.5) && end + 30_000 < now) {
          thumbnails.set(file, Math.max(thumbnails.get(file) ?? 0, end + 30_000));
          journal.add(account, end + 30_000, 'PUT /api/design-files/:id/thumbnail');
        }
        if (rng.chance(0.06)) {
          const at = from + rng.uniform(0, span);
          picture(
            file,
            at,
            'image',
            rng.pick([
              {width: 1920, height: 1080},
              {width: 1200, height: 800},
              {width: 800, height: 800},
              {width: 1080, height: 1350},
            ]),
            rng.logNormal(380_000, 0.8),
          );
          journal.add(account, at, 'POST /api/design-files/:id/images');
        }
        if (rng.chance(0.05)) journal.add(account, end + 40_000, 'POST /api/design-files/:id/export/raster');
        if (rng.chance(0.015)) journal.add(account, end + 50_000, 'POST /api/design-files/:id/export/pdf');
        if (rng.chance(0.03)) journal.add(account, from, 'PATCH /api/design-files/:id');
        if (rng.chance(0.004)) journal.add(account, from + 30_000, 'POST /api/design-files/:id/versions/:id/restore');
        if (file.team && file.projectId === null && file.team.projects.length && rng.chance(0.05)) {
          const project = rng.pick(file.team.projects);
          if (project.createdAt < from) {
            file.projectId = project.id;
            journal.add(account, from + 10_000, 'POST /api/design-files/:id/move');
          }
        }
        if (rng.chance(0.02) && !starred.has(account.id + file.id)) {
          starred.add(account.id + file.id);
          t.design_favourite_files.add({user_id: account.id, file_id: file.id, created_at: iso(from)});
          journal.add(account, from, 'PUT /api/design-favourites/files/:id');
        }
        if (file.team ? file.team.members.length > 1 : file.guests.size > 0)
          collaborative.push({file, account, at: end});
        else if (rng.chance(0.015)) collaborative.push({file, account, at: end});
      }
      if (rng.chance(0.01)) journal.add(account, session.end, 'POST /api/auth/logout');
      if (rng.chance(0.004)) journal.add(account, session.start + MINUTE, 'PUT /api/settings');
    }
  }

  // Trash: a file left there longer than the limit keeps it is erased by the sweep, with everything in it.
  const erasedFiles = new Set(
    files.filter(f => {
      if (f.trashedAt === null) return false;
      return f.trashedAt < now - DESIGN_LIMITS.trashDays * DAY;
    }),
  );
  const kept = files.filter(f => !erasedFiles.has(f));
  for (const file of files) file.saves.sort((a, b) => a - b);

  comments(
    c,
    collaborative.filter(e => !erasedFiles.has(e.file)),
  );
  libraries(c, kept);
  meetings(c, kept);

  // Versions: automatic ones older than the history days are pruned; named ones stay.
  for (const v of versions) {
    if (erasedFiles.has(v.file) || v.at > now) continue;
    if (v.label === null && v.at < now - DESIGN_LIMITS.historyDays * DAY) continue;
    // The document as it was then: usually a smaller state of the file's own.
    const doc = v.file.library
      ? v.file.doc
      : (v.file.kind === 'board' ? kit.boards : kit.designs)[Math.max(0, v.file.variant - rng.int(0, 3))];
    t.design_file_versions.add({
      id: rng.uuid(),
      file_id: v.file.id,
      user_id: v.file.holder.id,
      version: versionAt(v.file, v.at),
      label: v.label,
      document: doc.text,
      bytes: doc.bytes,
      created_at: iso(v.at),
    });
  }
  const lastAuto = new Map<DemoFile, number>();
  for (const v of versions)
    if (v.label === null && v.at <= now) lastAuto.set(v.file, Math.max(lastAuto.get(v.file) ?? 0, v.at));
  for (const file of kept) {
    const last = file.saves.at(-1) ?? file.createdAt;
    const thumb = thumbnails.get(file);
    const auto = lastAuto.get(file);
    t.design_files.add({
      id: file.id,
      user_id: file.holder.id,
      team_id: file.team?.id ?? null,
      project_id: file.projectId,
      name: file.name,
      document: file.doc.text,
      version: 1 + file.saves.length,
      bytes: file.doc.bytes,
      node_count: file.doc.nodeCount,
      thumbnail_filename: thumb
        ? picture(file, thumb, 'thumbnail', {width: 640, height: 400}, rng.uniform(6_000, 42_000))
        : null,
      client_id: rng.urlSafe(21),
      auto_version_at: auto === undefined ? null : iso(auto),
      created_at: iso(file.createdAt),
      updated_at: iso(Math.max(last, file.trashedAt ?? 0)),
      trashed_at: file.trashedAt === null ? null : iso(file.trashedAt),
      kind: file.kind,
      link_access: file.linkAccess,
    });
    for (const [guest, g] of file.guests)
      t.design_file_members.add({
        file_id: file.id,
        user_id: guest.id,
        role: g.role,
        invited_by: file.holder.id,
        created_at: iso(g.at),
      });
  }
  // Rows that point at an erased file went with it.
  const gone = new Set([...erasedFiles].map(f => f.id));
  for (const table of [t.design_images, t.design_favourite_files] as const)
    table.rows = table.rows.filter(row => !gone.has(row.file_id as string));

  return {
    teams,
    files: kept,
  };
}

/** The file's version after the saves made by `at`. */
const versionAt = (file: DemoFile, at: number) => 1 + file.saves.filter(s => s <= at).length;

/** Threads on files people work on together (and a few notes to self), with replies, mentions, resolutions and read state. */
function comments(c: Context, sessions: {file: DemoFile; account: Account; at: number}[]): void {
  const {rng, t, journal, now} = c;
  const read = new Set<string>();
  type Change = {at: number; apply: (seq: number) => void};
  const changes = new Map<DemoFile, Change[]>();
  const change = (file: DemoFile, at: number, apply: (seq: number) => void) =>
    changes.set(file, [...(changes.get(file) ?? []), {at, apply}]);
  const participants = (file: DemoFile): Account[] =>
    file.team ? file.team.members.map(m => m.account) : [file.holder, ...file.guests.keys()];
  for (const {file, account, at} of sessions) {
    const people = participants(file).filter(p => p.fate !== 'erased');
    const solo = people.length < 2;
    if (!rng.chance(solo ? 0.25 : 0.14)) continue;
    const others = people.filter(p => p !== account);
    const thread = {id: rng.uuid()};
    const onLayer = rng.chance(0.7) && file.doc.layerIds.length > 0;
    const row = t.design_comment_threads.add({
      id: thread.id,
      file_id: file.id,
      page_id: file.doc.pageId,
      x: Math.round(rng.uniform(0, 3000)),
      y: Math.round(rng.uniform(0, 1600)),
      node_id: onLayer ? rng.pick(file.doc.layerIds) : null,
      offset_x: onLayer ? Math.round(rng.uniform(0, 300)) : null,
      offset_y: onLayer ? Math.round(rng.uniform(0, 200)) : null,
      author_id: account.id,
      created_at: iso(at),
      resolved_at: null,
      resolved_by: null,
      seq: 0,
    });
    const say = (author: Account, when: number, text: string) => {
      const mention = others.length > 0 && author === account && rng.chance(0.2) ? rng.pick(others) : null;
      const body = mention ? `@${mention.firstName} ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
      const comment = t.design_comments.add({
        id: rng.uuid(),
        thread_id: thread.id,
        author_id: author.id,
        body,
        created_at: iso(when),
        seq: 0,
      });
      if (mention)
        t.design_comment_mentions.add({
          comment_id: comment.id as string,
          user_id: mention.id,
          at: 0,
          length: 1 + mention.firstName.length,
        });
      change(file, when, seq => {
        comment.seq = seq;
        row.seq = seq;
      });
    };
    say(account, at, rng.pick(COMMENT_THREADS));
    journal.add(account, at, 'POST /api/design-files/:id/comments');
    let last = at;
    const readers = new Set<Account>([account]);
    for (const other of rng.sample(others, 3)) {
      if (!rng.chance(0.4)) continue;
      const when = momentAfter(rng, other, last + 10 * MINUTE);
      if (when === null || when > now || when > at + 5 * DAY) continue;
      say(other, when, rng.pick(COMMENT_REPLIES));
      journal.add(other, when, 'POST /api/design-files/:id/comments/:id/replies');
      readers.add(other);
      last = when;
    }
    if (rng.chance(solo ? 0.3 : 0.45)) {
      const resolver = rng.chance(0.6) ? account : file.team ? file.team.owner : file.holder;
      const when = momentAfter(rng, resolver, last + 30 * MINUTE);
      if (when !== null && when < now && when < last + 7 * DAY && resolver.fate !== 'erased') {
        change(file, when, seq => {
          row.resolved_at = iso(when);
          row.resolved_by = resolver.id;
          row.seq = seq;
        });
        journal.add(resolver, when, 'PATCH /api/design-files/:id/comments/:id');
        readers.add(resolver);
      }
    }
    for (const reader of [...readers, ...others.filter(() => rng.chance(0.4))])
      // Read once everything is numbered (Infinity sorts last).
      change(file, Infinity, () => {
        if (read.has(thread.id + reader.id)) return;
        read.add(thread.id + reader.id);
        t.design_comment_reads.add({thread_id: thread.id, user_id: reader.id, read_seq: Number(row.seq)});
      });
    for (const other of others)
      if (rng.chance(0.3)) {
        const when = momentAfter(rng, other, at + MINUTE);
        if (when !== null && when < now) journal.add(other, when, 'POST /api/design-files/:id/comments/read');
      }
  }
  // The file's change counter only grows: number every change of its threads in time order.
  for (const list of changes.values()) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((entry, i) => entry.apply(i + 1));
  }
}

/** Shared libraries: published (one to four versions) from their file, enabled by other files of the same place. */
function libraries(c: Context, files: DemoFile[]): void {
  const {rng, t, journal, now, kit} = c;
  const lib = kit.library;
  for (const file of files.filter(f => f.library && f.trashedAt === null)) {
    const publisher = file.creator;
    const id = rng.uuid();
    const count = rng.int(1, 4);
    const times: number[] = [];
    let at = file.createdAt + rng.uniform(5, 50) * MINUTE;
    for (let v = 0; v < count && at < now; v++) {
      times.push(at);
      const next = momentAfter(rng, publisher, at + rng.uniform(3, 30) * DAY);
      if (next === null) break;
      at = next;
    }
    if (!times.length) continue;
    times.forEach((when, i) => {
      t.design_library_versions.add({
        id: rng.uuid(),
        library_id: id,
        user_id: file.holder.id,
        version: i + 1,
        file_version: versionAt(file, when),
        description: i === 0 ? 'First version' : rng.pick(['New buttons', 'Updated colors', 'Fixed padding', '']),
        manifest: lib.manifest,
        snapshot: lib.snapshot,
        bytes: lib.bytes,
        published_by: publisher.id,
        created_at: iso(when),
      });
      journal.add(publisher, when, 'POST /api/design-files/:id/library');
    });
    const unpublished = rng.chance(0.08) ? times[times.length - 1] + rng.uniform(1, 10) * DAY : null;
    t.design_libraries.add({
      id,
      file_id: file.id,
      user_id: file.holder.id,
      version: times.length,
      published_at: iso(times[times.length - 1]),
      unpublished_at: unpublished !== null && unpublished < now ? iso(unpublished) : null,
      created_at: iso(times[0]),
    });
    // Files of the same place use it.
    const place = files.filter(
      f =>
        f !== file &&
        !f.library &&
        f.kind === 'design' &&
        (file.team ? f.team === file.team : !f.team && f.holder === file.holder),
    );
    for (const user of rng.sample(place, rng.int(1, 5))) {
      const by = user.team ? rng.pick(user.team.members.filter(m => EDITS.has(m.role))).account : user.holder;
      const when = momentAfter(rng, by, Math.max(times[0], user.createdAt) + rng.uniform(0, 5) * DAY);
      if (when === null || when > now) continue;
      t.design_library_subscriptions.add({
        file_id: user.id,
        library_id: id,
        enabled_by: by.id,
        enabled_at: iso(when),
        seen_version: times.filter(p => p <= when).length || 1,
      });
      journal.add(by, when, 'PUT /api/design-files/:id/libraries/:id');
      if (rng.chance(0.6))
        journal.add(by, when + rng.uniform(1, 20) * MINUTE, 'POST /api/design-files/:id/libraries/:id/import');
    }
  }
}

/** "Board" meetings: votes (a team's board hosts one every week or few, a retro), each with everyone's ballots, and sometimes a timer.
 *  The file keeps the last session's results and ballots until someone clears them. */
function meetings(c: Context, files: DemoFile[]): void {
  const {rng, t, journal, now} = c;
  for (const file of files.filter(f => f.kind === 'board' && f.trashedAt === null)) {
    const people = (file.team ? file.team.members.map(m => m.account) : [file.holder, ...file.guests.keys()]).filter(
      p => p.fate !== 'erased',
    );
    if (!people.length || !rng.chance(file.team ? 0.7 : people.length > 1 ? 0.5 : 0.12)) continue;
    let session: {
      starter: Account;
      at: number;
      ended: number;
      voteId: string;
      perPerson: number;
      timer: boolean;
    } | null = null;
    let revision = 0;
    for (let from = file.createdAt + rng.uniform(0, 10) * DAY; from < now; from += rng.uniform(7, 21) * DAY) {
      const starter = rng.pick(people);
      const at = momentAfter(rng, starter, from);
      if (at === null || at > now - HOUR) break;
      session = {
        starter,
        at,
        ended: at + rng.uniform(5, 20) * MINUTE,
        voteId: rng.uuid(),
        perPerson: rng.pick([3, 3, 5]),
        timer: rng.chance(0.5),
      };
      if (session.timer) journal.add(starter, at - MINUTE, 'POST /api/design-files/:id/meeting/timer');
      journal.add(starter, at, 'POST /api/design-files/:id/meeting/vote');
      journal.add(starter, session.ended, 'POST /api/design-files/:id/meeting/vote');
      revision += 2 + (session.timer ? 2 : 0);
      for (const voter of rng.sample(people, rng.int(Math.min(2, people.length), Math.min(6, people.length)))) {
        journal.add(voter, at + rng.uniform(1, 4) * MINUTE, 'POST /api/design-files/:id/meeting/vote/ballot');
        revision++;
      }
      if (!file.team || !rng.chance(0.75)) break;
    }
    if (!session) continue;
    const {starter, at, ended, voteId, perPerson, timer} = session;
    // The ballots of the last session.
    for (const voter of rng.sample(people, rng.int(Math.min(2, people.length), Math.min(6, people.length)))) {
      let left = perPerson;
      const layers = rng.sample(file.doc.layerIds, rng.int(1, 3));
      for (const [i, node] of layers.entries()) {
        const count = i === layers.length - 1 ? left : rng.int(1, Math.max(1, left - (layers.length - 1 - i)));
        if (count < 1) break;
        left -= count;
        t.design_meeting_votes.add({file_id: file.id, vote_id: voteId, user_id: voter.id, node_id: node, count});
      }
    }
    const duration = rng.pick([300_000, 600_000, 900_000]);
    t.design_meetings.add({
      file_id: file.id,
      revision,
      timer_state: timer ? 'paused' : null,
      timer_duration_ms: timer ? duration : null,
      timer_remaining_ms: timer ? Math.round(rng.uniform(0, duration) / 1000) * 1000 : null,
      timer_music: timer ? rng.pick(['lofi', 'ambient', 'rain', null]) : null,
      timer_by: timer ? starter.id : null,
      vote_id: voteId,
      vote_by: starter.id,
      vote_per_person: perPerson,
      vote_with_timer: false,
      vote_started_at: iso(at),
      vote_ended_at: iso(ended),
      updated_at: iso(ended),
    });
  }
}
