import {
  ACCOUNT_SEGMENTS,
  ADMIN_ACCOUNT_SORTS,
  DEFAULT_ADMIN_PERIOD,
  isAdminPeriod,
  type AccountSegment,
  type AdminAccountSort,
  type AdminPeriod,
} from '../../shared/admin-analytics';
import {SUPPORT_INBOX_FILTERS, type SupportInboxFilter} from '../../shared/support';

// The console's addresses: #admin (Overview), #admin/accounts (Accounts), #admin/accounts/<id> (one account),
// #admin/usage (Usage), #admin/support[/<threadId>] (Support). What a screen shows
// lives in the hash's query (`period`; the list's `q`, `segment`, `sort`, `order`, `page`; the inbox's `filter` and `q`), so back,
// forward and a reload keep it. Defaults are left out of the address.

export type PeriodSection = 'overview' | 'usage';
export type AdminSection = PeriodSection | 'accounts' | 'account' | 'support';

export type SupportView = {filter: SupportInboxFilter; q: string; thread: string | null};
export const DEFAULT_SUPPORT: SupportView = {filter: 'waiting', q: '', thread: null};

export type AccountsList = {q: string; segment: AccountSegment | 'all'; sort: AdminAccountSort; order: 'asc' | 'desc'; page: number};
export const DEFAULT_LIST: AccountsList = {q: '', segment: 'all', sort: 'created', order: 'desc', page: 1};

export type AdminRoute =
  | {section: PeriodSection; period: AdminPeriod}
  | {section: 'accounts'; list: AccountsList}
  | {section: 'account'; id: string}
  | {section: 'support'; support: SupportView};

export const PERIOD_SECTIONS: readonly PeriodSection[] = ['overview', 'usage'];
export const isPeriodSection = (section: AdminSection): section is PeriodSection => (PERIOD_SECTIONS as readonly string[]).includes(section);

const PATHS: Record<PeriodSection | 'accounts', string> = {overview: '', accounts: '/accounts', usage: '/usage'};

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
};

const isSegment = (value: string | null): value is AccountSegment => !!value && (ACCOUNT_SEGMENTS as readonly string[]).includes(value);
const isSort = (value: string | null): value is AdminAccountSort => !!value && (ADMIN_ACCOUNT_SORTS as readonly string[]).includes(value);
const isFilter = (value: string | null): value is SupportInboxFilter => !!value && (SUPPORT_INBOX_FILTERS as readonly string[]).includes(value);

/** What `#admin…` shows; anything it does not know is the overview. */
export function parseAdminHash(hash: string): AdminRoute {
  const body = hash.replace(/^#/, '');
  const [path, search = ''] = body.split(/\?(.*)/s, 2);
  const params = new URLSearchParams(search);
  const parts = path.split('/').filter(Boolean);
  const period = params.get('period');
  const periodOf = isAdminPeriod(period) ? period : DEFAULT_ADMIN_PERIOD;
  if (parts[0] !== 'admin') return {section: 'overview', period: periodOf};
  if (parts[1] === 'accounts' && parts[2]) {
    const id = decode(parts.slice(2).join('/'));
    if (id) return {section: 'account', id};
  }
  if (parts[1] === 'accounts') {
    const segment = params.get('segment');
    const sort = params.get('sort');
    const order = params.get('order');
    const page = Number(params.get('page'));
    return {
      section: 'accounts',
      list: {
        q: (params.get('q') ?? '').slice(0, 200),
        segment: isSegment(segment) ? segment : 'all',
        sort: isSort(sort) ? sort : DEFAULT_LIST.sort,
        order: order === 'asc' ? 'asc' : 'desc',
        page: Number.isInteger(page) && page > 0 ? page : 1,
      },
    };
  }
  if (parts[1] === 'support') {
    const filter = params.get('filter');
    const thread = parts[2] ? decode(parts.slice(2).join('/')) : '';
    return {section: 'support', support: {filter: isFilter(filter) ? filter : DEFAULT_SUPPORT.filter, q: (params.get('q') ?? '').slice(0, 200), thread: thread || null}};
  }
  if (parts[1] === 'usage') return {section: 'usage', period: periodOf};
  return {section: 'overview', period: periodOf};
}

/** The address of a route, `#admin…`. */
export function adminHash(route: AdminRoute): string {
  if (route.section === 'account') return '#admin/accounts/' + encodeURIComponent(route.id);
  const params = new URLSearchParams();
  if (route.section === 'support') {
    const {filter, q, thread} = route.support;
    if (filter !== DEFAULT_SUPPORT.filter) params.set('filter', filter);
    if (q) params.set('q', q);
    const query = params.toString();
    return '#admin/support' + (thread ? '/' + encodeURIComponent(thread) : '') + (query ? '?' + query : '');
  }
  if (route.section === 'accounts') {
    const {q, segment, sort, order, page} = route.list;
    if (q) params.set('q', q);
    if (segment !== DEFAULT_LIST.segment) params.set('segment', segment);
    if (sort !== DEFAULT_LIST.sort) params.set('sort', sort);
    if (order !== DEFAULT_LIST.order) params.set('order', order);
    if (page !== 1) params.set('page', String(page));
  } else if (route.period !== DEFAULT_ADMIN_PERIOD) {
    params.set('period', route.period);
  }
  const query = params.toString();
  return '#admin' + PATHS[route.section] + (query ? '?' + query : '');
}

export const accountsHash = (list: Partial<AccountsList> = {}) => adminHash({section: 'accounts', list: {...DEFAULT_LIST, ...list}});
export const accountHash = (id: string) => adminHash({section: 'account', id});
export const periodHash = (section: PeriodSection, period: AdminPeriod) => adminHash({section, period});
export const supportHash = (view: Partial<SupportView> = {}) => adminHash({section: 'support', support: {...DEFAULT_SUPPORT, ...view}});

/** Fired after the console rewrites its own address in place (history.replaceState sends no event of its own). */
export const ADMIN_ROUTE_EVENT = 'morfa-admin-route';

/** Go to a console address: a new history entry, or in place (`replace`, e.g. while typing a search). */
export function goAdmin(hash: string, {replace = false}: {replace?: boolean} = {}) {
  if (hash === location.hash) return;
  if (replace) {
    history.replaceState(history.state, '', location.pathname + location.search + hash);
    window.dispatchEvent(new Event(ADMIN_ROUTE_EVENT));
  } else {
    location.hash = hash.slice(1);
  }
}
