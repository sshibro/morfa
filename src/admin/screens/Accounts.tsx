import {useCallback, useEffect, useRef, type KeyboardEvent} from 'react';
import {ArrowDown, ArrowUp, ChevronLeft, ChevronRight} from 'lucide-react';
import {ACCOUNT_SEGMENTS, ADMIN_ACCOUNTS_PAGE_SIZE, ADMIN_API, type AccountSegment, type AdminAccountRow, type AdminAccountSort, type AdminAccountsPage} from '../../../shared/admin-analytics';
import {Sparkline} from '../charts/Sparkline';
import {useAdminQuery} from '../data';
import {ago, bytes, dateLabel, num, plural} from '../format';
import {SEGMENT_COLOR, SEGMENT_LABEL} from '../palette';
import {accountHash, adminHash, goAdmin, type AccountsList} from '../route';
import {Avatar, Empty, Failure, PageHead, SearchBox, SegmentPill} from '../ui';

type Column = {key: string; title: string; sort?: AdminAccountSort; numeric?: boolean; className?: string; width?: number};
// Fixed widths for the figures; the account takes what is left.
const COLUMNS: Column[] = [
  {key: 'who', title: 'Account', className: 'is-who'},
  {key: 'segment', title: 'Status', className: 'is-segment', width: 132},
  {key: 'activity', title: 'Activity', className: 'is-activity', width: 152},
  {key: 'files', title: 'Files', sort: 'files', numeric: true, width: 64},
  {key: 'storage', title: 'Size', sort: 'storage', numeric: true, className: 'is-storage', width: 80},
  {key: 'seen', title: 'Seen', sort: 'active', numeric: true, width: 104},
  {key: 'created', title: 'Created', sort: 'created', numeric: true, className: 'is-created', width: 80},
];

const SORT_NAMES: Record<AdminAccountSort, string> = {created: 'Created', active: 'Last seen', files: 'Files', storage: 'Size'};

function pages(current: number, last: number): Array<number | 'gap'> {
  if (last <= 7) return Array.from({length: last}, (_, index) => index + 1);
  const set = new Set([1, last, current - 1, current, current + 1].filter(page => page >= 1 && page <= last));
  const sorted = [...set].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) out.push('gap');
    out.push(page);
  });
  return out;
}

function Row({row}: {row: AdminAccountRow}) {
  const open = () => goAdmin(accountHash(row.id));
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.target === event.currentTarget) open();
  };
  return (
    <tr onClick={open} onKeyDown={onKey} className={row.segment === 'closing' ? 'is-closing' : undefined}>
      <td className="is-who">
        <a className="mfa-who" href={accountHash(row.id)} onClick={event => event.stopPropagation()}>
          <Avatar id={row.id} name={row.name} email={row.email} />
          <span className="mfa-who-text">
            <b>{row.name || row.email}</b>
            <small>{row.email}</small>
          </span>
        </a>
        <span className="mfa-row-pill"><SegmentPill segment={row.segment} /></span>
      </td>
      <td className="is-segment">
        <SegmentPill segment={row.segment} />
      </td>
      <td data-label="30 days" className="is-activity">
        <Sparkline values={row.activity30d} width={96} height={26} color={row.activeDays30d > 0 ? 'var(--mfa-viz-1)' : 'var(--mfa-viz-other)'} area />
        <span className="mfa-activity-days" title="active days of 30">{row.activeDays30d}<small>/30</small></span>
      </td>
      <td data-label="Files" className="is-num">{num(row.files)}</td>
      <td data-label="Size" className="is-num is-storage">{row.storageBytes > 0 ? bytes(row.storageBytes) : <span className="mfa-dim">—</span>}</td>
      <td data-label="Seen" className="is-num is-seen">{ago(row.lastActiveAt)}</td>
      <td data-label="Created" className="is-num is-created">{dateLabel(row.createdAt)}</td>
    </tr>
  );
}

function SkeletonRows() {
  return (
    <tbody aria-hidden="true">
      {Array.from({length: 8}, (_, index) => (
        <tr key={index} className="is-skeleton">
          <td className="is-who"><span className="mfa-who"><span className="mfa-skel" style={{width: 36, height: 36, borderRadius: 18}} /><span className="mfa-skel" style={{width: 160, height: 14}} /></span></td>
          {COLUMNS.slice(1).map(column => <td key={column.key}><span className="mfa-skel" style={{display: 'block', width: '70%', height: 12}} /></td>)}
        </tr>
      ))}
    </tbody>
  );
}

export function Accounts({list}: {list: AccountsList}) {
  const query = useAdminQuery<AdminAccountsPage>(
    ADMIN_API.accounts,
    {q: list.q || undefined, segment: list.segment === 'all' ? undefined : list.segment, sort: list.sort, order: list.order, page: list.page},
    {report: true},
  );
  const data = query.data;
  const go = (next: Partial<AccountsList>, replace = false) => goAdmin(adminHash({section: 'accounts', list: {...list, page: 1, ...next}}), {replace});
  // The search writes `q` in place (no history entry per keystroke); the latest list is read when it fires.
  const latest = useRef(list);
  useEffect(() => {
    latest.current = list;
  });
  const onSearch = useCallback((q: string) => goAdmin(adminHash({section: 'accounts', list: {...latest.current, q, page: 1}}), {replace: true}), []);

  const sortBy = (sort: AdminAccountSort) => go({sort, order: list.sort === sort && list.order === 'desc' ? 'asc' : 'desc'});
  const counts = data?.counts;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? ADMIN_ACCOUNTS_PAGE_SIZE;
  const last = Math.max(1, Math.ceil(total / pageSize));
  const filtered = list.q !== '' || list.segment !== 'all';

  return (
    <div className="mfa-screen">
      <PageHead
        title="Accounts"
        fact={
          counts ? (
            <>
              <span><b>{num(counts.all)}</b> {plural(counts.all, 'account', 'accounts')}</span>
              {counts.closing > 0 && (
                <>
                  <i className="mfa-dot-sep" aria-hidden="true" />
                  <span><b>{num(counts.closing)}</b> {plural(counts.closing, 'is being deleted', 'are being deleted')}</span>
                </>
              )}
            </>
          ) : undefined
        }
      />

      <div className="mfa-toolbar">
        <div className="mfa-filters" role="group" aria-label="Status">
          {(['all', ...ACCOUNT_SEGMENTS] as Array<AccountSegment | 'all'>).map(segment => (
            <button key={segment} type="button" aria-pressed={list.segment === segment} className={`mfa-filter${list.segment === segment ? ' is-on' : ''}`} onClick={() => go({segment})}>
              {segment !== 'all' && <i style={{background: SEGMENT_COLOR[segment]}} aria-hidden="true" />}
              {SEGMENT_LABEL[segment]}
              <span className="mfa-filter-count">{counts ? num(counts[segment]) : '·'}</span>
            </button>
          ))}
        </div>
        <div className="mfa-toolbar-side">
          <SearchBox value={list.q} onChange={onSearch} placeholder="Name, e-mail or id" label="Search accounts" />
          <label className="mfa-sort-select">
            <span className="mfa-sr">Sort</span>
            <select value={`${list.sort}:${list.order}`} onChange={event => {
              const [sort, order] = event.target.value.split(':') as [AdminAccountSort, 'asc' | 'desc'];
              go({sort, order});
            }}>
              {(Object.keys(SORT_NAMES) as AdminAccountSort[]).flatMap(sort => [
                <option key={sort + ':desc'} value={`${sort}:desc`}>{SORT_NAMES[sort]} ↓</option>,
                <option key={sort + ':asc'} value={`${sort}:asc`}>{SORT_NAMES[sort]} ↑</option>,
              ])}
            </select>
          </label>
        </div>
      </div>

      {query.error && !data ? (
        <Failure error={query.error} onRetry={query.retry} />
      ) : (
        <div className={`mfa-table-wrap${query.stale ? ' mfa-stale' : ''}`}>
          {query.error && data && <Failure error={query.error} onRetry={query.retry} compact />}
          <table className="mfa-table">
            <colgroup>
              {COLUMNS.map(column => <col key={column.key} className={column.className} style={column.width ? {width: column.width} : undefined} />)}
            </colgroup>
            <caption className="mfa-sr">Accounts, sorted by {SORT_NAMES[list.sort]}, {list.order === 'desc' ? 'descending' : 'ascending'}</caption>
            <thead>
              <tr>
                {COLUMNS.map(column => {
                  const sorted = column.sort && list.sort === column.sort;
                  return (
                    <th key={column.key} scope="col" className={`${column.className ?? ''}${column.numeric ? ' is-num' : ''}`.trim() || undefined} aria-sort={sorted ? (list.order === 'desc' ? 'descending' : 'ascending') : undefined}>
                      {column.sort ? (
                        <button type="button" className={sorted ? 'is-sorted' : undefined} onClick={() => sortBy(column.sort!)}>
                          {column.title}
                          {sorted ? (list.order === 'desc' ? <ArrowDown size={13} strokeWidth={2.4} aria-hidden="true" /> : <ArrowUp size={13} strokeWidth={2.4} aria-hidden="true" />) : <ArrowDown size={13} strokeWidth={2.4} aria-hidden="true" className="mfa-sort-ghost" />}
                        </button>
                      ) : (
                        column.title
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            {!data ? (
              <SkeletonRows />
            ) : (
              <tbody>
                {data.rows.map(row => <Row key={row.id} row={row} />)}
              </tbody>
            )}
          </table>
          {data && data.rows.length === 0 && (
            <Empty
              text={list.q ? `Nobody found for "${list.q}"` : 'Nobody in this list yet'}
              action={filtered ? <button type="button" className="mfa-btn" onClick={() => go({q: '', segment: 'all'})}>Reset filters</button> : undefined}
            />
          )}
        </div>
      )}

      {data && total > pageSize && (
        <nav className="mfa-pager" aria-label="Pages">
          <span className="mfa-pager-range">
            {num((data.page - 1) * pageSize + 1)}–{num(Math.min(total, data.page * pageSize))} of {num(total)}
          </span>
          <div className="mfa-pager-pages">
            <button type="button" className="mfa-icon-btn" disabled={data.page <= 1} onClick={() => go({page: data.page - 1})} aria-label="Previous page">
              <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            {pages(data.page, last).map((page, index) =>
              page === 'gap' ? (
                <span key={'gap' + index} className="mfa-pager-gap">…</span>
              ) : (
                <button key={page} type="button" className={`mfa-pager-page${page === data.page ? ' is-on' : ''}`} aria-current={page === data.page ? 'page' : undefined} onClick={() => go({page})}>
                  {page}
                </button>
              ),
            )}
            <button type="button" className="mfa-icon-btn" disabled={data.page >= last} onClick={() => go({page: data.page + 1})} aria-label="Next page">
              <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
