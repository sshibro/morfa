import type {ReactNode} from 'react';
import type {AdminPeriod, AdminWindow} from '../../../shared/admin-analytics';
import type {AdminQuery} from '../data';
import {dateLabel, NBSP} from '../format';
import {Failure, KpiSkeleton, PageHead} from '../ui';

export const COMPARE: Record<AdminPeriod, string> = {
  '7d': 'vs the previous 7 days',
  '30d': 'vs the previous 30 days',
  '90d': 'vs the previous 90 days',
  '365d': 'vs the previous year',
};

/** "Sep 10 – Oct 10": the window a report covers. */
export const rangeText = (window: AdminWindow) => `${dateLabel(window.from)}${NBSP}–${NBSP}${dateLabel(window.to)}`;

/** A head with the window and a dot between facts. */
export function WindowFact({window, children}: {window: AdminWindow; children?: ReactNode}) {
  return (
    <>
      <span>{rangeText(window)}</span>
      {children && <i className="mfa-dot-sep" aria-hidden="true" />}
      {children}
    </>
  );
}

/** What a screen shows before its first answer: its head, the number tiles' frames, two quiet blocks. */
export function ScreenSkeleton({title, kpis = 4}: {title: string; kpis?: number}) {
  return (
    <>
      <PageHead title={title} fact={<span className="mfa-skel" style={{width: 220, height: 14, display: 'inline-block'}} />} />
      <div className={`mfa-kpis${kpis === 3 ? ' is-three' : ''}`} aria-busy="true">
        {Array.from({length: kpis}, (_, index) => <KpiSkeleton key={index} hero />)}
      </div>
      <div className="mfa-grid" aria-hidden="true">
        <div className="mfa-sec mfa-span-8"><div className="mfa-skel" style={{height: 260}} /></div>
        <div className="mfa-sec mfa-span-4"><div className="mfa-skel" style={{height: 260}} /></div>
      </div>
    </>
  );
}

/** The first answer failed: the head and the failure with its retry. */
export function ScreenFailure({title, query}: {title: string; query: Pick<AdminQuery<unknown>, 'error' | 'retry'>}) {
  return (
    <>
      <PageHead title={title} />
      {query.error && <Failure error={query.error} onRetry={query.retry} />}
    </>
  );
}
