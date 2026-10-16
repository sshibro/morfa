// Deterministic demo data for the operator's console preview (scripts/admin/preview.ts): every /api/admin/* answer the console reads,
// typed against the contracts (shared/admin-analytics.ts, shared/support.ts). One seeded population of ~180 accounts (a couple of them
// closing) with two years of daily activity; every report is computed from it for the asked period, so the numbers agree with each
// other. Not the server's seeder (scripts/admin/seed*).
import {
  ACCOUNT_SEGMENTS,
  ADMIN_ACCOUNTS_PAGE_SIZE,
  ADMIN_PERIOD_DAYS,
  type AccountSegment,
  type AdminAccountDetail,
  type AdminAccountRow,
  type AdminAccountsPage,
  type AdminAccountsQuery,
  type AdminAlert,
  type AdminCohort,
  type AdminDayPoint,
  type AdminMetric,
  type AdminOverview,
  type AdminPeriod,
  type AdminSlice,
  type AdminUsage,
  type AdminWindow,
} from '../../shared/admin-analytics';
import type {SupportConversation, SupportInbox, SupportInboxFilter, SupportInboxRow, SupportMessage, SupportContext} from '../../shared/support';

/** The moment every report is read at (12:00 in Moscow). The preview fixes the browser's clock to it too. */
export const NOW = Date.parse('2026-10-10T09:00:00Z');
const DAY = 86_400_000;
const MSK = 3 * 3_600_000;
const HISTORY = 760;

// ── Randomness and days ─────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261010);
const between = (min: number, max: number) => min + random() * (max - min);
const int = (min: number, max: number) => Math.floor(between(min, max + 1));
const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
const chance = (p: number) => random() < p;

/** Moscow day of an instant. */
const moscowDay = (ms: number) => new Date(ms + MSK).toISOString().slice(0, 10);
/** UTC instant of a Moscow day's midnight. */
const dayStart = (day: string) => Date.parse(day + 'T00:00:00Z') - MSK;
const TODAY = moscowDay(NOW);
const TODAY_START = dayStart(TODAY);
/** Day index: 0 is HISTORY-1 days ago, HISTORY-1 is today. */
const dayIndex = (ms: number) => HISTORY - 1 - Math.floor((TODAY_START - dayStart(moscowDay(ms))) / DAY);
const dayOfIndex = (index: number) => moscowDay(TODAY_START - (HISTORY - 1 - index) * DAY + 12 * 3_600_000);
const weekday = (day: string) => (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7;
const iso = (ms: number) => new Date(ms).toISOString();

// ── Names ───────────────────────────────────────────────────────────────────

const FIRST = ['Anna', 'Maria', 'Katherine', 'Olivia', 'Daisy', 'Alice', 'Pauline', 'Kelsey', 'Vera', 'Julia', 'Sophia', 'Irene', 'Natalie', 'Helen', 'Victoria', 'Alexander', 'Daniel', 'Ivan', 'Maxwell', 'Arthur', 'Samuel', 'Nathan', 'Paul', 'Michael', 'Edward', 'Kyle', 'Roman', 'Timothy', 'Gabriel', 'Ethan', 'Andrew', 'Dennis'];
const LAST = ['Smith', 'Johnson', 'Cooper', 'Taylor', 'Walker', 'Lee', 'Foster', 'Newman', 'Morris', 'Wolfe', 'Sullivan', 'Wilson', 'Zimmerman', 'Powell', 'Sanders', 'Goldman', 'Vincent', 'Bogart', 'Ford', 'Fedor', 'Mitchell', 'Bell', 'Turner', 'White', 'Kramer', 'Ortiz', 'Kessler', 'Mackay', 'Anderson', 'Kowalski', 'Hill', 'Gray'];
const STUDIOS = ['Pixel Studio', 'Line Bureau', 'North Design', 'Contour Agency', 'Form and Color', 'Mono Studio', 'Growth Point', 'Interface Atelier'];
/** The Latin-letters-and-digits form of a name, for an address. */
const latin = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const DOMAINS = ['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'proton.me', 'hey.com'];

// ── The population ──────────────────────────────────────────────────────────

type Level = 'power' | 'regular' | 'casual' | 'dormant';
type Person = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  created: number;
  createdIndex: number;
  segment: AccountSegment;
  level: Level;
  /** Requests per day, HISTORY long, oldest first. */
  requests: number[];
  files: number;
  trashed: number;
  storageBytes: number;
  versions: number;
  teams: Array<{id: string; name: string; role: string; members: number}>;
  deletionRequestedAt: number | null;
  /** Funnel flags for its first days. */
  madeFile: boolean;
  cameBack: boolean;
  usesFeatures: Set<string>;
};

const LEVEL_RATE: Record<Level, number> = {power: 46, regular: 18, casual: 6, dormant: 1.2};
const LEVEL_DAYS: Record<Level, number> = {power: 0.8, regular: 0.5, casual: 0.2, dormant: 0.03};

function makePerson(index: number, segment: AccountSegment): Person {
  const studio = chance(0.06);
  const first = pick(FIRST);
  const last = pick(LAST);
  const name = studio ? pick(STUDIOS) : chance(0.07) ? '' : `${first} ${last}`;
  const handle = studio ? latin(name).slice(0, 14) || 'studio' : `${latin(first)}.${latin(last)}`;
  const email = `${handle}${chance(0.3) ? int(1, 99) : ''}@${studio ? 'studio-' + latin(name).slice(0, 6) + '.example' : pick(DOMAINS)}`;
  // More signups lately: the product grows.
  const age = Math.floor(700 * (1 - Math.sqrt(random())) ** 1.15);
  const created = NOW - age * DAY - int(0, 20) * 3_600_000;
  const levelRoll = random();
  const level: Level =
    segment === 'closing' ? 'dormant' : levelRoll < 0.1 ? 'power' : levelRoll < 0.35 ? 'regular' : levelRoll < 0.7 ? 'casual' : 'dormant';
  return {
    id: `acc_${(index * 7919 + 104_729).toString(36)}${int(10, 99)}`,
    name,
    email,
    emailVerified: chance(0.8),
    created,
    createdIndex: Math.max(0, dayIndex(created)),
    segment,
    level,
    requests: [],
    files: 0,
    trashed: 0,
    storageBytes: 0,
    versions: 0,
    teams: [],
    deletionRequestedAt: null,
    madeFile: chance(level === 'dormant' ? 0.45 : 0.92),
    cameBack: level !== 'dormant' || chance(0.25),
    usesFeatures: new Set(),
  };
}

function buildPopulation(): Person[] {
  const plan: AccountSegment[] = [...Array<AccountSegment>(2).fill('closing'), ...Array<AccountSegment>(178).fill('active')];
  const people = plan.map((segment, index) => makePerson(index, segment));
  // A few hand-placed people the screenshots can rely on.
  people[0].name = 'Anna Brooks';
  people[0].email = 'anna.brooks@gmail.com';
  people[0].level = 'power';
  people[0].created = NOW - 260 * DAY;
  people[0].createdIndex = dayIndex(people[0].created);
  people[0].teams.push({id: 'team_brooks', name: 'Brooks & Partners', role: 'owner', members: 4}, {id: 'team_pixel', name: 'Pixel Studio', role: 'editor', members: 9});
  people[1].name = 'Pixel Studio';
  people[1].email = 'hello@pixel-studio.example';
  people[1].level = 'power';
  for (const person of people) simulate(person);
  return people;
}

function simulate(person: Person) {
  const rate = LEVEL_RATE[person.level];
  const activeShare = LEVEL_DAYS[person.level];
  const closingIndex = person.segment === 'closing' ? HISTORY - int(3, 9) : null;
  for (let index = 0; index < HISTORY; index++) {
    const day = dayOfIndex(index);
    let requests = 0;
    if (index >= person.createdIndex) {
      const sinceStart = index - person.createdIndex;
      const fresh = sinceStart < 3 ? 1 : 0;
      const weekend = weekday(day) >= 5 ? 0.35 : 1;
      let share = activeShare * weekend;
      if (closingIndex !== null && index > closingIndex) share = 0;
      // Dormant people were active only at first.
      if (person.level === 'dormant' && sinceStart > 20) share *= 0.15;
      if (fresh || random() < share) requests = Math.max(1, Math.round(rate * between(0.3, 1.7) * (fresh ? 1.4 : 1)));
    }
    person.requests.push(requests);
  }
  const totalRequests = person.requests.reduce((sum, value) => sum + value, 0);
  person.files = person.madeFile ? Math.max(1, Math.round(totalRequests / between(90, 160))) : 0;
  person.trashed = Math.round(person.files * between(0, 0.15));
  person.versions = Math.round(person.files * between(2, 9));
  person.storageBytes = Math.round(person.files * between(180_000, 2_600_000) + (person.level === 'power' ? between(20e6, 300e6) : 0));
  if (person.level === 'power' || person.level === 'regular') {
    for (const feature of ['comments', 'sharing', 'versions', 'libraries', 'teams', 'meetings']) if (chance(feature === 'versions' ? 0.8 : feature === 'comments' ? 0.6 : feature === 'sharing' ? 0.5 : 0.25)) person.usesFeatures.add(feature);
  } else if (person.level === 'casual' && chance(0.3)) {
    person.usesFeatures.add(pick(['comments', 'sharing', 'versions']));
  }
  if (person.segment === 'closing') person.deletionRequestedAt = NOW - int(1, 6) * DAY;

  if (person.teams.length === 0 && chance(person.level === 'power' ? 0.5 : person.level === 'regular' ? 0.2 : 0.02)) {
    person.teams.push({id: `team_${person.id.slice(4)}m`, name: pick(STUDIOS), role: pick(['editor', 'editor', 'viewer', 'admin']), members: int(3, 12)});
  }
}

const PEOPLE: Person[] = buildPopulation();

const byId = new Map(PEOPLE.map(person => [person.id, person]));

// ── Helpers over the population ─────────────────────────────────────────────

function windowOf(period: AdminPeriod): AdminWindow {
  const days = ADMIN_PERIOD_DAYS[period];
  const from = TODAY_START - (days - 1) * DAY;
  return {period, from: iso(from), to: iso(NOW), previousFrom: iso(from - days * DAY), days};
}
/** Index range of a period's days, and of the previous window. */
function ranges(period: AdminPeriod) {
  const days = ADMIN_PERIOD_DAYS[period];
  const end = HISTORY - 1;
  return {days, from: end - days + 1, to: end, prevFrom: end - 2 * days + 1, prevTo: end - days};
}
const sumRange = (values: number[], from: number, to: number) => {
  let sum = 0;
  for (let index = Math.max(0, from); index <= to; index++) sum += values[index] ?? 0;
  return sum;
};
const metric = (value: number, previous: number | null): AdminMetric => ({value: Math.round(value * 100) / 100, previous: previous === null ? null : Math.round(previous * 100) / 100});
const series = (from: number, to: number, value: (index: number) => number): AdminDayPoint[] =>
  Array.from({length: to - from + 1}, (_, offset) => ({day: dayOfIndex(from + offset), value: Math.round(value(from + offset) * 100) / 100}));

const live = (person: Person, at = NOW) => person.created <= at;
const lastActive = (person: Person): string | null => {
  for (let index = HISTORY - 1; index >= 0; index--) {
    if (person.requests[index] > 0) {
      const start = TODAY_START - (HISTORY - 1 - index) * DAY;
      const hour = index === HISTORY - 1 ? Math.min(11, int(8, 11)) : int(9, 22);
      return iso(Math.min(NOW - 4 * 60_000, start + hour * 3_600_000 + int(0, 59) * 60_000));
    }
  }
  return null;
};

function rowOf(person: Person): AdminAccountRow {
  const from = HISTORY - 30;
  const activity30d = person.requests.slice(from);
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    emailVerified: person.emailVerified,
    createdAt: iso(person.created),
    lastActiveAt: lastActive(person),
    segment: person.segment,
    activeDays30d: activity30d.filter(value => value > 0).length,
    activity30d,
    files: person.files,
    storageBytes: person.storageBytes,
    teams: person.teams.length,
  };
}

const sliceList = (entries: Array<[string, string, number]>): AdminSlice[] => entries.map(([key, label, value]) => ({key, label, value: Math.round(value * 100) / 100}));

// ── GET /api/admin/overview ─────────────────────────────────────────────────

export function overview(period: AdminPeriod): AdminOverview {
  const r = ranges(period);
  const window = windowOf(period);
  const fromMs = Date.parse(window.from);
  const signupsAt = (index: number) => PEOPLE.filter(person => person.createdIndex === index).length;
  const activeAt = (index: number) => PEOPLE.filter(person => person.requests[index] > 0).length;
  const distinctActive = (from: number, to: number) => PEOPLE.filter(person => sumRange(person.requests, from, to) > 0).length;

  const newIn = PEOPLE.filter(person => person.createdIndex >= r.from);
  const funnel = sliceList([
    ['signup', 'Signed up', newIn.length],
    ['file', 'Created a file', newIn.filter(person => person.madeFile).length],
    ['return', 'Came back', newIn.filter(person => person.madeFile && person.cameBack).length],
  ]);

  // Weekly cohorts: the last 8 Mondays.
  const cohorts: AdminCohort[] = [];
  const todayWeekStart = HISTORY - 1 - weekday(TODAY);
  for (let k = 8; k >= 1; k--) {
    const start = todayWeekStart - k * 7;
    const members = PEOPLE.filter(person => person.createdIndex >= start && person.createdIndex < start + 7);
    const weeksDone = Math.min(9, k);
    const active: number[] = [];
    for (let w = 0; w < weeksDone; w++) {
      const from = start + w * 7;
      const share = members.length ? members.filter(person => sumRange(person.requests, from, from + 6) > 0).length / members.length : 0;
      active.push(Math.round(share * 1000) / 1000);
    }
    cohorts.push({week: dayOfIndex(start), size: members.length, active});
  }

  // When people work: requests in the window spread over weekdays and Moscow hours.
  const hourShape = [0.4, 0.2, 0.1, 0.05, 0.05, 0.1, 0.3, 0.8, 1.6, 3.2, 5.2, 6.4, 6.1, 5.0, 5.8, 6.3, 6.0, 5.1, 3.8, 3.0, 2.6, 2.1, 1.5, 0.9];
  const heatRandom = mulberry32(ADMIN_PERIOD_DAYS[period] * 31);
  const totals = Array.from({length: 7}, () => 0);
  for (let index = r.from; index <= r.to; index++) totals[weekday(dayOfIndex(index))] += PEOPLE.reduce((sum, person) => sum + person.requests[index], 0);
  const heatmap = totals.map((total, day) => {
    const weights = hourShape.map((weight, hour) => weight * (day >= 5 ? (hour >= 11 && hour <= 20 ? 1.1 : 0.7) : 1) * (0.8 + heatRandom() * 0.4));
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(weight => Math.round((total * weight) / sum));
  });

  const alerts: AdminAlert[] = ([{kind: 'closing', tone: 'info', count: PEOPLE.filter(person => person.segment === 'closing').length}] satisfies AdminAlert[]).filter(alert => alert.count > 0);

  return {
    window,
    generatedAt: iso(NOW),
    kpis: {
      accounts: metric(PEOPLE.filter(person => live(person)).length, PEOPLE.filter(person => live(person, fromMs)).length),
      newAccounts: metric(newIn.length, PEOPLE.filter(person => person.createdIndex >= r.prevFrom && person.createdIndex <= r.prevTo).length),
      activeAccounts: metric(distinctActive(r.from, r.to), distinctActive(r.prevFrom, r.prevTo)),
    },
    series: {
      signups: series(r.from, r.to, signupsAt),
      active: series(r.from, r.to, activeAt),
    },
    funnel,
    stickiness: {dau: distinctActive(HISTORY - 1, HISTORY - 1), wau: distinctActive(HISTORY - 7, HISTORY - 1), mau: distinctActive(HISTORY - 30, HISTORY - 1)},
    cohorts,
    heatmap,
    alerts,
  };
}

// ── GET /api/admin/accounts ─────────────────────────────────────────────────

const ROWS = PEOPLE.map(rowOf);

export function accounts(query: AdminAccountsQuery): AdminAccountsPage {
  const q = (query.q ?? '').trim().toLowerCase();
  const matching = ROWS.filter(row => !q || row.name.toLowerCase().includes(q) || row.email.toLowerCase().includes(q) || row.id.toLowerCase().includes(q));
  const counts = Object.fromEntries([['all', matching.length], ...ACCOUNT_SEGMENTS.map(segment => [segment, matching.filter(row => row.segment === segment).length])]) as AdminAccountsPage['counts'];
  const segment = query.segment ?? 'all';
  const rows = matching.filter(row => segment === 'all' || row.segment === segment);
  const sort = query.sort ?? 'created';
  const order = query.order ?? 'desc';
  const key = (row: AdminAccountRow): number =>
    sort === 'created' ? Date.parse(row.createdAt)
      : sort === 'active' ? (row.lastActiveAt ? Date.parse(row.lastActiveAt) : 0)
        : sort === 'files' ? row.files
          : row.storageBytes;
  rows.sort((a, b) => (order === 'desc' ? key(b) - key(a) : key(a) - key(b)) || a.id.localeCompare(b.id));
  const page = Math.max(1, query.page ?? 1);
  const start = (page - 1) * ADMIN_ACCOUNTS_PAGE_SIZE;
  return {rows: rows.slice(start, start + ADMIN_ACCOUNTS_PAGE_SIZE), total: rows.length, page, pageSize: ADMIN_ACCOUNTS_PAGE_SIZE, counts};
}

// ── GET /api/admin/accounts/:id ─────────────────────────────────────────────

const FILE_NAMES = ['Landing page — spring', 'Mobile app v3', 'Design system', 'Onboarding', 'Investor presentation', 'Client account', 'Icons', 'Social media banners', 'Product cards', 'Wireframes', 'Logo — options', 'Idea board', 'Sprint retro', 'Checkout'];
const ROUTES = ['POST /api/design/files/:id/versions', 'POST /api/design/files', 'PATCH /api/design/files/:id', 'POST /api/design/comments', 'POST /api/design/files/:id/share', 'POST /api/design/libraries/:id/publish', 'DELETE /api/design/files/:id', 'POST /api/design/meetings'];

export function account(id: string): AdminAccountDetail | null {
  const person = byId.get(id);
  if (!person) return null;
  const local = mulberry32(id.split('').reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) >>> 0);
  const row = rowOf(person);
  const from = HISTORY - 90;
  const recent = Array.from({length: 40}, (_, n) => {
    const at = NOW - (n * (person.level === 'power' ? 0.6 : 3.5) + local() * 0.5) * 3_600_000 - 5 * 60_000;
    return {at: iso(at), action: local() < 0.55 ? 'read' : ROUTES[Math.floor(local() * ROUTES.length)]};
  });
  const actionCounts = ROUTES.slice(0, 8).map((route, n) => ({key: route, label: route, value: Math.round((sumRange(person.requests, from, HISTORY - 1) / (n + 2)) * (0.3 + local() * 0.4))}))
    .filter(entry => entry.value > 0)
    .sort((a, b) => b.value - a.value);
  return {
    account: {...row, deletionRequestedAt: person.deletionRequestedAt ? iso(person.deletionRequestedAt) : null, sessions: {active: person.level === 'dormant' ? 0 : int(1, 3), lastSignInAt: row.lastActiveAt}},
    files: {
      count: person.files,
      trashed: person.trashed,
      storageBytes: person.storageBytes,
      versions: person.versions,
      recent: Array.from({length: Math.min(8, person.files)}, (_, n) => ({
        id: `file_${id.slice(4)}_${n}`,
        name: FILE_NAMES[(n + id.length) % FILE_NAMES.length],
        updatedAt: iso(NOW - (n * n * 0.7 + local()) * DAY),
        bytes: Math.round(200_000 + local() * 3_400_000),
        nodeCount: Math.round(40 + local() * 2400),
        team: person.teams.length > 0 && local() < 0.3,
      })),
    },
    teams: person.teams,
    activity: {daily: series(from, HISTORY - 1, index => person.requests[index]), recent, topActions: actionCounts},
    collaboration: {comments: person.usesFeatures.has('comments') ? int(3, 140) : 0, sharedFiles: person.usesFeatures.has('sharing') ? int(1, 18) : 0, meetings: person.usesFeatures.has('meetings') ? int(1, 9) : 0},
  };
}

// ── GET /api/admin/usage ────────────────────────────────────────────────────

export function usage(period: AdminPeriod): AdminUsage {
  const r = ranges(period);
  const window = windowOf(period);
  const total = (pick: (person: Person) => number[], from: number, to: number) => PEOPLE.reduce((sum, person) => sum + sumRange(pick(person), from, to), 0);
  const active = PEOPLE.filter(person => sumRange(person.requests, r.from, r.to) > 0);
  const created = (from: number, to: number) => PEOPLE.reduce((sum, person) => sum + (person.files > 0 ? sumRange(person.requests, from, to) / 120 : 0), 0);
  const featureLabel: Record<string, string> = {comments: 'Comments', versions: 'Versions', sharing: 'Link sharing', libraries: 'Libraries', teams: 'Teams', meetings: 'Meetings'};
  const productRandom = mulberry32(ADMIN_PERIOD_DAYS[period] * 17);
  const filesAt = (index: number) => Math.round(PEOPLE.reduce((sum, person) => sum + (person.files > 0 && person.requests[index] > 0 ? person.requests[index] / 110 : 0), 0) * (0.8 + productRandom() * 0.4));

  return {
    window,
    generatedAt: iso(NOW),
    kpis: {
      filesCreated: metric(Math.round(created(r.from, r.to)), Math.round(created(r.prevFrom, r.prevTo))),
      comments: metric(Math.round(created(r.from, r.to) * 2.6), Math.round(created(r.prevFrom, r.prevTo) * 2.4)),
      teamsCreated: metric(Math.max(1, Math.round(ADMIN_PERIOD_DAYS[period] / 9)), Math.max(1, Math.round(ADMIN_PERIOD_DAYS[period] / 11))),
    },
    product: {
      filesCreated: series(r.from, r.to, filesAt),
      versions: series(r.from, r.to, index => filesAt(index) * 3 + Math.round(productRandom() * 4)),
      comments: series(r.from, r.to, index => Math.round(filesAt(index) * 2.4 * (0.6 + productRandom() * 0.8))),
      adoption: ['versions', 'comments', 'sharing', 'teams', 'libraries', 'meetings'].map(key => {
        const users = active.filter(person => person.usesFeatures.has(key)).length;
        return {key, label: featureLabel[key], accounts: users, share: active.length ? Math.round((users / active.length) * 1000) / 1000 : 0};
      }),
      topActions: ROUTES.map((route, n) => ({key: route, label: route, value: Math.round(total(person => person.requests, r.from, r.to) / (6 + n * 3.4))})),
    },
    storage: {
      files: PEOPLE.reduce((sum, person) => sum + person.files, 0),
      documentBytes: PEOPLE.reduce((sum, person) => sum + person.storageBytes, 0),
      pictures: PEOPLE.reduce((sum, person) => sum + person.files * 3, 0),
      pictureBytes: PEOPLE.reduce((sum, person) => sum + Math.round(person.storageBytes * 1.7), 0),
      versions: PEOPLE.reduce((sum, person) => sum + person.versions, 0),
    },
  };
}

// ── Support ─────────────────────────────────────────────────────────────────

type Thread = {
  id: string;
  person: Person;
  status: 'open' | 'closed';
  messages: Array<SupportMessage & {context?: SupportContext}>;
  /** The person's messages the operator has not read. */
  unread: number;
  userReadAt: string | null;
};

const LONG = 'Hello! This is my second message, sorry for the long letter. Yesterday evening I was working on a landing page layout for a client and everything saved fine, but this morning I opened the file and half of the frames are there, while the whole right column with the pricing cards is gone. In the version history I can see a save at 11:40 pm, but even if I restore it the cards stay empty: only the frames remain, without text or pictures.\n\nI tried opening the file in another browser and on my phone and got the same thing. A colleague with link access sees the empty cards too. The layout is due tomorrow at noon, so I would really appreciate your help as soon as possible. If needed, I can give you access to the file or send a screen recording.';

const minutesAgo = (minutes: number) => iso(NOW - minutes * 60_000);

function buildThreads(): Thread[] {
  const people = PEOPLE.filter(person => person.name && person.segment !== 'closing');
  const at = (n: number) => people[n % people.length];
  const message = (id: string, author: 'user' | 'operator', body: string, minutes: number, context?: SupportContext) => ({id, author, body, createdAt: minutesAgo(minutes), ...(context ? {context} : {})});
  return [
    {
      id: 'thr_a1', person: at(3), status: 'open', unread: 1, userReadAt: null,
      messages: [message('m_a1_1', 'user', 'How can I make a component stretch to the width of its frame? In Figma this was "Fill container".', 12, {where: 'editor', fileId: 'file_x'})],
    },
    {
      id: 'thr_b2', person: PEOPLE[0], status: 'open', unread: 2, userReadAt: minutesAgo(60 * 26),
      messages: [
        message('m_b2_1', 'user', 'Good afternoon! The file will not load after yesterday\'s edit.', 60 * 27, {where: 'files'}),
        message('m_b2_2', 'operator', 'Hello, Anna! Let us take a look. What is the file called?', 60 * 26 + 50),
        message('m_b2_3', 'user', '"Landing page — spring"', 60 * 26 + 40),
        message('m_b2_4', 'operator', 'We found the cause and fixed it: the file opens again. Please check.', 60 * 26 + 10),
        message('m_b2_5', 'user', LONG, 160, {where: 'editor', fileId: 'file_landing'}),
        message('m_b2_6', 'user', 'Here is a screenshot of what I see (I could not attach it, so I will describe it): empty white rectangles instead of cards.', 152, {where: 'editor', fileId: 'file_landing'}),
      ],
    },
    {
      id: 'thr_c3', person: at(9), status: 'open', unread: 1, userReadAt: null,
      messages: [message('m_c3_1', 'user', 'I cannot sign in from my phone: after I enter my name the page just reloads. What should I do?', 60 * 6 + 20, {where: 'other'})],
    },
    {
      id: 'thr_d4', person: PEOPLE[1], status: 'open', unread: 0, userReadAt: minutesAgo(60 * 50),
      messages: [
        message('m_d4_1', 'user', 'Can I add two more designers to the team?', 60 * 52, {where: 'files'}),
        message('m_d4_2', 'operator', 'Yes, you can invite members at any time: "Team" → "Invite".', 60 * 51),
        message('m_d4_3', 'user', 'Great. Where do I do that? I could not find the button in the team settings.', 60 * 30),
      ],
    },
    {
      id: 'thr_e5', person: at(14), status: 'open', unread: 0, userReadAt: minutesAgo(100),
      messages: [
        message('m_e5_1', 'user', 'A picture will not paste into a board file: it appears and disappears at once.', 60 * 5, {where: 'board', fileId: 'file_board'}),
        message('m_e5_2', 'operator', 'Thanks for writing! This is a known bug on boards, the fix ships this evening.', 60 * 3),
      ],
    },
    {
      id: 'thr_f6', person: at(21), status: 'open', unread: 0, userReadAt: null,
      messages: [
        message('m_f6_1', 'user', 'How do I export a frame to PDF with vector text?', 60 * 30, {where: 'editor', fileId: 'file_pdf'}),
        message('m_f6_2', 'operator', 'Select the frame → "Export" panel on the right → PDF format. The text stays vector.', 60 * 28),
      ],
    },
    {
      id: 'thr_g7', person: at(30), status: 'closed', unread: 0, userReadAt: minutesAgo(60 * 24 * 4 - 30),
      messages: [
        message('m_g7_1', 'user', 'The e-mail confirmation letter does not arrive.', 60 * 24 * 4 + 90),
        message('m_g7_2', 'operator', 'We sent it again — please check your "Spam" folder.', 60 * 24 * 4 + 60),
        message('m_g7_3', 'user', 'Found it, thanks!', 60 * 24 * 4),
      ],
    },
    {
      id: 'thr_h8', person: at(40), status: 'closed', unread: 0, userReadAt: minutesAgo(60 * 24 * 15),
      messages: [
        message('m_h8_1', 'user', 'How do I delete my account and all files?', 60 * 24 * 16),
        message('m_h8_2', 'operator', 'Deletion request accepted: the account and files will be erased within a few days.', 60 * 24 * 15 + 30),
      ],
    },
  ];
}

/** The preview's live support state: replies, closing and reading change it. */
export class SupportStore {
  threads = buildThreads();
  private seq = 0;
  /** The inbox is empty (an "all answered" screenshot). */
  empty = false;

  private waitingSince(thread: Thread): string | null {
    if (thread.status !== 'open') return null;
    let since: string | null = null;
    for (const message of thread.messages) {
      if (message.author === 'operator') since = null;
      else since ??= message.createdAt;
    }
    return since;
  }

  private row(thread: Thread): SupportInboxRow {
    const last = thread.messages[thread.messages.length - 1];
    return {
      id: thread.id,
      account: {id: thread.person.id, name: thread.person.name, email: thread.person.email},
      status: thread.status,
      last: {author: last.author, body: last.body, createdAt: last.createdAt},
      unread: thread.unread,
      waitingSince: this.waitingSince(thread),
      updatedAt: last.createdAt,
    };
  }

  inbox(filter: SupportInboxFilter, q: string): SupportInbox {
    const query = q.trim().toLowerCase();
    const threads = this.empty ? this.threads.filter(thread => thread.status === 'closed') : this.threads;
    const rows = threads.map(thread => this.row(thread)).filter(row => !query || row.account.name.toLowerCase().includes(query) || row.account.email.toLowerCase().includes(query));
    const of = (name: SupportInboxFilter) =>
      rows.filter(row => (name === 'all' ? true : name === 'closed' ? row.status === 'closed' : name === 'open' ? row.status === 'open' : row.status === 'open' && row.waitingSince !== null));
    const listed = of(filter).sort((a, b) => (filter === 'waiting' ? a.waitingSince!.localeCompare(b.waitingSince!) : b.updatedAt.localeCompare(a.updatedAt)));
    return {rows: listed.slice(0, 100), counts: {waiting: of('waiting').length, open: of('open').length, closed: of('closed').length, all: rows.length}};
  }

  waiting(): number {
    return this.empty ? 0 : this.threads.filter(thread => this.waitingSince(thread) !== null).length;
  }

  conversation(id: string): SupportConversation | null {
    const thread = this.threads.find(entry => entry.id === id);
    if (!thread) return null;
    return {id: thread.id, status: thread.status, account: {id: thread.person.id, name: thread.person.name, email: thread.person.email}, messages: thread.messages, userReadAt: thread.userReadAt};
  }

  reply(id: string, body: string): SupportConversation | null {
    const thread = this.threads.find(entry => entry.id === id);
    if (!thread) return null;
    thread.messages.push({id: `m_new_${++this.seq}`, author: 'operator', body, createdAt: iso(NOW + this.seq * 1000)});
    thread.status = 'open';
    return this.conversation(id);
  }

  setStatus(id: string, status: 'open' | 'closed'): SupportConversation | null {
    const thread = this.threads.find(entry => entry.id === id);
    if (!thread) return null;
    thread.status = status;
    return this.conversation(id);
  }

  read(id: string) {
    const thread = this.threads.find(entry => entry.id === id);
    if (thread) thread.unread = 0;
  }
}

/** Every account id the preview may open (the first is an active one with history). */
export const SAMPLE_ACCOUNT = PEOPLE[0].id;
export const SAMPLE_THREAD = 'thr_b2';
