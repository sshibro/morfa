// The operator's console (#admin…): who uses Morfa and what they do. App renders it only for an operator
// (/api/config `admin: true`) and reaches it only through import(), so nobody else ever loads it. It uses the shell's own fonts (Inter,
// Wix Madefor Display) and Morfa's brand: an ink rail, a white workspace, one indigo accent. Every rule is scoped under `.mfa`.
import './admin.css';
import './screens.css';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType} from 'react';
import {Activity, ArrowLeft, FileText, LayoutDashboard, MessageCircle, RefreshCw, Users, type LucideProps} from 'lucide-react';
import {ADMIN_PERIODS, DEFAULT_ADMIN_PERIOD, type AdminPeriod} from '../../shared/admin-analytics';
import {SUPPORT_API, SUPPORT_POLL_IDLE_MS, type SupportWaiting} from '../../shared/support';
import type {Account} from '../auth/session';
import {BrandSymbol, Lockup} from '../brand/marks';
import {useResolvedTheme} from '../design/ui/theme';
import {AdminContext, useAdminQuery, type AdminContextValue, type AdminStatus} from './data';
import {timeLabel} from './format';
import {ADMIN_ROUTE_EVENT, adminHash, DEFAULT_LIST, DEFAULT_SUPPORT, goAdmin, isPeriodSection, parseAdminHash, periodHash, type AccountsList, type AdminRoute, type AdminSection, type PeriodSection, type SupportView} from './route';
import {Avatar} from './ui';
import {Overview} from './screens/Overview';
import {Accounts} from './screens/Accounts';
import {AccountPage} from './screens/Account';
import {Usage} from './screens/Usage';
import {Support} from './support/Support';

type NavSection = PeriodSection | 'accounts' | 'support';
// "Support" second: people waiting for an answer are what needs the operator first.
const NAV: Array<{section: NavSection; label: string; short: string; icon: ComponentType<LucideProps>}> = [
  {section: 'overview', label: 'Overview', short: 'Overview', icon: LayoutDashboard},
  {section: 'support', label: 'Support', short: 'Support', icon: MessageCircle},
  {section: 'accounts', label: 'Accounts', short: 'Accounts', icon: Users},
  {section: 'usage', label: 'Usage', short: 'Product', icon: Activity},
];

const TITLES: Record<AdminSection, string> = {overview: 'Overview', accounts: 'Accounts', account: 'Account', usage: 'Usage', support: 'Support'};
const PERIOD_LABEL: Record<AdminPeriod, string> = {'7d': '7d', '30d': '30d', '90d': '90d', '365d': '1y'};
const PERIOD_NAME: Record<AdminPeriod, string> = {'7d': '7 days', '30d': '30 days', '90d': '90 days', '365d': '1 year'};
const THEME_COLOR = '#141414';

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  window.addEventListener('popstate', listener);
  window.addEventListener(ADMIN_ROUTE_EVENT, listener);
  return () => {
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('popstate', listener);
    window.removeEventListener(ADMIN_ROUTE_EVENT, listener);
  };
}
const hashNow = () => location.hash;

function PeriodSwitch({section, period}: {section: PeriodSection; period: AdminPeriod}) {
  return (
    <div className="mfa-seg" role="radiogroup" aria-label="Period">
      {ADMIN_PERIODS.map(option => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === period}
          aria-label={PERIOD_NAME[option]}
          className={option === period ? 'is-on' : undefined}
          onClick={() => goAdmin(periodHash(section, option))}
        >
          {PERIOD_LABEL[option]}
        </button>
      ))}
    </div>
  );
}

function RefreshButton({status, onRefresh}: {status: AdminStatus; onRefresh: () => void}) {
  return (
    <button type="button" className={`mfa-icon-btn${status.loading ? ' is-busy' : ''}`} onClick={onRefresh} aria-label={status.at ? `Refresh, data as of ${timeLabel(new Date(status.at).toISOString())}` : 'Refresh'} title="Refresh">
      <RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export default function AdminRoot({account}: {account: Account}) {
  const theme = useResolvedTheme();
  const hash = useSyncExternalStore(subscribe, hashNow, hashNow);
  const route: AdminRoute = useMemo(() => parseAdminHash(hash), [hash]);
  const [token, setToken] = useState(0);
  const [status, setStatus] = useState<AdminStatus>({loading: false, at: null});
  const [scrolled, setScrolled] = useState(false);
  const work = useRef<HTMLElement>(null);
  // The rail carries the last period and the last list, so moving between screens keeps what the operator chose.
  const [lastPeriod, setLastPeriod] = useState<AdminPeriod>(isPeriodSection(route.section) && 'period' in route ? route.period : DEFAULT_ADMIN_PERIOD);
  const [lastList, setLastList] = useState<AccountsList>(route.section === 'accounts' ? route.list : DEFAULT_LIST);
  const [lastSupport, setLastSupport] = useState<SupportView>(route.section === 'support' ? {...route.support, thread: null} : DEFAULT_SUPPORT);
  useEffect(() => {
    if ('period' in route) setLastPeriod(route.period);
    if (route.section === 'accounts') setLastList(route.list);
    if (route.section === 'support') setLastSupport({...route.support, thread: null});
  }, [route]);

  const refresh = useCallback(() => setToken(count => count + 1), []);
  // The rail's badge: conversations waiting for an answer, polled while the tab is in front.
  const waiting = useAdminQuery<SupportWaiting>(SUPPORT_API.waiting, {}, {pollMs: SUPPORT_POLL_IDLE_MS});
  const waitingCount = waiting.data?.waiting ?? null;
  const recount = waiting.poke;
  const context: AdminContextValue = useMemo(
    () => ({refreshToken: token, refresh, report: setStatus, waiting: waitingCount, recount}),
    [token, refresh, waitingCount, recount],
  );

  // A new screen (or another account) starts at the top; a new period or page of the same screen keeps the place.
  const place = route.section === 'account' ? 'account:' + route.id : route.section;
  useLayoutEffect(() => {
    work.current?.scrollTo({top: 0});
  }, [place]);

  useEffect(() => {
    const previous = document.title;
    return () => {
      document.title = previous;
    };
  }, []);
  useEffect(() => {
    document.title = `${TITLES[route.section]} · Morfa admin`;
  }, [route.section]);
  useLayoutEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const previous = meta?.getAttribute('content');
    meta?.setAttribute('content', THEME_COLOR);
    return () => {
      if (meta && previous) meta.setAttribute('content', previous);
    };
  }, []);

  const current: NavSection = route.section === 'account' ? 'accounts' : route.section;
  const navHref = (section: NavSection) =>
    section === 'accounts' ? adminHash({section: 'accounts', list: lastList}) : section === 'support' ? adminHash({section: 'support', support: lastSupport}) : periodHash(section, lastPeriod);
  const badge = (section: NavSection) =>
    section === 'support' && waitingCount ? <span className="mfa-badge" aria-label={`waiting for a reply: ${waitingCount}`}>{waitingCount > 99 ? '99+' : waitingCount}</span> : null;
  const backToList = adminHash({section: 'accounts', list: lastList});

  let screen;
  switch (route.section) {
    case 'overview':
      screen = <Overview period={route.period} />;
      break;
    case 'accounts':
      screen = <Accounts list={route.list} />;
      break;
    case 'account':
      screen = <AccountPage id={route.id} />;
      break;
    case 'usage':
      screen = <Usage period={route.period} />;
      break;
    case 'support':
      screen = <Support view={route.support} />;
      break;
  }
  const fill = route.section === 'support';

  return (
    <AdminContext.Provider value={context}>
      <div className="mfa" data-theme={theme}>
        <nav className="mfa-rail" aria-label="Admin console">
          <a className="mfa-rail-brand" href="#designs" title="To files">
            <Lockup className="mfa-rail-lockup" />
          </a>
          <span className="mfa-rail-badge">admin</span>
          <ul className="mfa-rail-nav">
            {NAV.map(item => {
              const Icon = item.icon;
              return (
                <li key={item.section}>
                  <a href={navHref(item.section)} aria-current={current === item.section ? 'page' : undefined}>
                    <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
                    <span className="mfa-rail-label">{item.label}</span>
                    {badge(item.section)}
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="mfa-rail-foot">
            <div className="mfa-rail-me">
              <Avatar id={account.id} name={account.name ?? ''} email={account.email ?? ''} size="sm" />
              <span>
                <b>{account.name || account.email || 'Operator'}</b>
                {account.name && account.email && <small>{account.email}</small>}
              </span>
            </div>
            <a className="mfa-rail-back" href="#designs">
              <ArrowLeft size={18} strokeWidth={1.9} aria-hidden="true" />
              To files
            </a>
          </div>
        </nav>

        <header className="mfa-strip">
          <a href="#designs" className="mfa-strip-brand" aria-label="Morfa — to files">
            <BrandSymbol className="mfa-strip-symbol" />
            <span>admin</span>
          </a>
          <span className="mfa-strip-actions">
            <RefreshButton status={status} onRefresh={refresh} />
          </span>
        </header>

        <main className={`mfa-work${fill ? ' is-fill' : ''}`} ref={work} onScroll={event => setScrolled(event.currentTarget.scrollTop > 4)}>
          {/* On a phone a top bar with nothing but the clock goes; the strip above has the refresh. */}
          <div className={`mfa-top${scrolled ? ' is-scrolled' : ''}${!isPeriodSection(route.section) && route.section !== 'account' ? ' is-empty' : ''}`}>
            <div className="mfa-top-left">
              {route.section === 'account' && (
                <a className="mfa-back" href={backToList}>
                  <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
                  Accounts
                </a>
              )}
            </div>
            <div className="mfa-top-right">
              {isPeriodSection(route.section) && 'period' in route && <PeriodSwitch section={route.section} period={route.period} />}
              {status.at && <span className="mfa-asof" title="Data as of">{timeLabel(new Date(status.at).toISOString())}</span>}
              <span className="mfa-top-refresh"><RefreshButton status={status} onRefresh={refresh} /></span>
            </div>
          </div>
          <div className={`mfa-page${fill ? ' is-fill' : ''}`} key={place}>
            {screen}
          </div>
        </main>

        <nav className="mfa-tabs" aria-label="Sections">
          {NAV.map(item => {
            const Icon = item.icon;
            return (
              <a key={item.section} href={navHref(item.section)} aria-current={current === item.section ? 'page' : undefined}>
                <span className="mfa-tab-icon">
                  <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
                  {badge(item.section)}
                </span>
                <span>{item.short}</span>
              </a>
            );
          })}
          <a href="#designs">
            <span className="mfa-tab-icon">
              <FileText size={20} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <span>Files</span>
          </a>
        </nav>
      </div>
    </AdminContext.Provider>
  );
}
