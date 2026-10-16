/* The operator's console (#admin in the app, src/admin; GET /api/admin/*, server/admin/router.ts): what every screen reads.
 * Only operators reach it: MORFA_OPERATORS names them (account ids, or e-mails the account has proven); everyone else gets the
 * API's plain 404 and /api/config has no `admin` key for them.
 *
 * Units: instants are UTC ISO strings. A `day` is a Moscow calendar date 'YYYY-MM-DD' and every day series is dense: one point per
 * Moscow day of the window, oldest first, zeros included. Erased accounts are never listed; they only count where a total says so. An
 * account at a reserved `.invalid` address is not a person: never counted or listed (server/admin/analytics/people.ts). */

export const ADMIN_PERIODS = ['7d', '30d', '90d', '365d'] as const;
export type AdminPeriod = (typeof ADMIN_PERIODS)[number];
export const ADMIN_PERIOD_DAYS: Readonly<Record<AdminPeriod, number>> = {'7d': 7, '30d': 30, '90d': 90, '365d': 365};
export const DEFAULT_ADMIN_PERIOD: AdminPeriod = '30d';
export const isAdminPeriod = (value: unknown): value is AdminPeriod =>
  typeof value === 'string' && (ADMIN_PERIODS as readonly string[]).includes(value);

/** The window a report covers: [from, to), `to` is the moment of the reading; the previous window is [previousFrom, from), as long. */
export type AdminWindow = {period: AdminPeriod; from: string; to: string; previousFrom: string; days: number};

/** A number and the same number over the previous window (null: no comparison makes sense, e.g. a point-in-time count with no history). */
export type AdminMetric = {value: number; previous: number | null};
export type AdminDayPoint = {day: string; value: number};
/** One part of a whole: `key` is stable (an action, a feature), `label` is the Russian text a chart shows. */
export type AdminSlice = {key: string; label: string; value: number};

/** What an account is now, the first that holds in this order:
 *  closing   asked to close the account (deletion requested, not erased yet);
 *  active    any other live account. */
export const ACCOUNT_SEGMENTS = ['active', 'closing'] as const;
export type AccountSegment = (typeof ACCOUNT_SEGMENTS)[number];

/** One account as every list shows it. */
export type AdminAccountRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  /** The last recorded request (admin_activity), null when none. */
  lastActiveAt: string | null;
  segment: AccountSegment;
  /** The last 30 days. */
  activeDays30d: number;
  /** Requests per Moscow day over the last 30 days, oldest first (exactly 30 numbers): the row's sparkline. */
  activity30d: number[];
  files: number;
  storageBytes: number;
  teams: number;
};

/** Accounts waiting to be erased. */
export type AdminAlertKind = 'closing';
export type AdminAlert = {kind: AdminAlertKind; tone: 'danger' | 'warn' | 'info'; count: number};

/** One weekly signup cohort: of the accounts that signed up in the Moscow week starting `week` (a Monday), the share active in each later
 *  week. `active[0]` is the signup week itself (1 when anyone in it made a request), `active[k]` the k-th week after, up to 8; weeks that
 *  have not ended yet are left out, so later cohorts have shorter arrays. */
export type AdminCohort = {week: string; size: number; active: number[]};

/** GET /api/admin/overview?period= — the home screen. */
export type AdminOverview = {
  window: AdminWindow;
  generatedAt: string;
  kpis: {
    /** Live accounts (not erased) at `to`; previous: at `from`. */
    accounts: AdminMetric;
    newAccounts: AdminMetric;
    /** Distinct accounts with a request in the window. */
    activeAccounts: AdminMetric;
  };
  series: {
    signups: AdminDayPoint[];
    /** Distinct active accounts per day (DAU). */
    active: AdminDayPoint[];
  };
  /** Accounts that signed up in the window, step by step: signed up → made a file → came back on a later day. */
  funnel: AdminSlice[];
  /** Distinct active accounts over the last 1, 7 and 30 days, as of `to`. */
  stickiness: {dau: number; wau: number; mau: number};
  /** Up to the last 8 weekly cohorts, oldest first. */
  cohorts: AdminCohort[];
  /** Requests in the window by Moscow weekday (0 Monday … 6 Sunday) and hour (0–23): 7 arrays of 24 numbers. */
  heatmap: number[][];
  /** What needs the operator; only kinds with count > 0, the most urgent first. */
  alerts: AdminAlert[];
};

export const ADMIN_ACCOUNT_SORTS = ['created', 'active', 'files', 'storage'] as const;
export type AdminAccountSort = (typeof ADMIN_ACCOUNT_SORTS)[number];
export const ADMIN_ACCOUNTS_PAGE_SIZE = 50;
/** GET /api/admin/accounts?q=&segment=&sort=&order=&page= (all optional; segment 'all', sort 'created', order 'desc', page 1).
 *  `q` matches the name, the e-mail or the id, case-insensitive substring. */
export type AdminAccountsQuery = {
  q?: string;
  segment?: AccountSegment | 'all';
  sort?: AdminAccountSort;
  order?: 'asc' | 'desc';
  page?: number;
};
export type AdminAccountsPage = {
  rows: AdminAccountRow[];
  /** Rows matching `q` and `segment`. */
  total: number;
  page: number;
  pageSize: number;
  /** Rows matching `q` per segment, and 'all': the segment tabs' counts. */
  counts: Record<AccountSegment | 'all', number>;
};

/** GET /api/admin/accounts/:id — one account; 404 for an unknown or erased one, or one at a reserved `.invalid` address. */
export type AdminAccountDetail = {
  account: AdminAccountRow & {
    deletionRequestedAt: string | null;
    /** Sessions not expired now, and when the newest began. */
    sessions: {active: number; lastSignInAt: string | null};
  };
  files: {
    count: number;
    trashed: number;
    storageBytes: number;
    versions: number;
    /** The 8 most recently changed files (team files the account owns included). */
    recent: Array<{id: string; name: string; updatedAt: string; bytes: number; nodeCount: number; team: boolean}>;
  };
  teams: Array<{id: string; name: string; role: string; members: number}>;
  activity: {
    /** Requests per Moscow day, the last 90 days. */
    daily: AdminDayPoint[];
    /** The newest 40 journal rows (the route with ids masked, 'read' for a GET). */
    recent: Array<{at: string; action: string}>;
    /** The account's most frequent non-read actions, the last 90 days, at most 8. */
    topActions: AdminSlice[];
  };
  collaboration: {comments: number; sharedFiles: number; meetings: number};
};

/** GET /api/admin/usage?period= — what people do in the product. */
export type AdminUsage = {
  window: AdminWindow;
  generatedAt: string;
  kpis: {
    filesCreated: AdminMetric;
    comments: AdminMetric;
    teamsCreated: AdminMetric;
  };
  product: {
    filesCreated: AdminDayPoint[];
    /** Saved versions per day. */
    versions: AdminDayPoint[];
    comments: AdminDayPoint[];
    /** Of the accounts active in the window, how many used each feature in it (key: 'comments', 'teams', 'sharing', 'libraries',
     *  'meetings', 'versions'); `share` is accounts / active accounts, 0..1. */
    adoption: Array<{key: string; label: string; accounts: number; share: number}>;
    /** The most frequent non-read actions in the journal (the masked route), at most 10. */
    topActions: AdminSlice[];
  };
  storage: {files: number; documentBytes: number; pictures: number; pictureBytes: number; versions: number};
};

/** The paths the console reads, for both sides. */
export const ADMIN_API = {
  overview: '/admin/overview',
  accounts: '/admin/accounts',
  account: (id: string) => `/admin/accounts/${encodeURIComponent(id)}`,
  usage: '/admin/usage',
} as const;
