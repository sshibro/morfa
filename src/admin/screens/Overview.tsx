import type {ComponentType} from 'react';
import {ChevronRight, MessageCircle, Trash2, type LucideProps} from 'lucide-react';
import {ADMIN_API, type AdminAlert, type AdminOverview, type AdminPeriod} from '../../../shared/admin-analytics';
import {AreaLine} from '../charts/AreaLine';
import {CohortGrid} from '../charts/CohortGrid';
import {Funnel} from '../charts/Funnel';
import {Heatmap} from '../charts/Heatmap';
import {Gauge} from '../charts/Meter';
import {useAdmin, useAdminQuery} from '../data';
import {compact, delta, num, pct, plural} from '../format';
import {seriesColor} from '../palette';
import {accountsHash, supportHash} from '../route';
import {Kpi, PageHead, Section} from '../ui';
import {COMPARE, ScreenFailure, ScreenSkeleton, WindowFact} from './common';

type QueueEntry = {key: string; tone: 'danger' | 'warn' | 'info'; icon: ComponentType<LucideProps>; count: string; text: string; href: string};

function alertEntry(alert: AdminAlert): QueueEntry {
  const n = alert.count;
  switch (alert.kind) {
    case 'closing':
      return {key: alert.kind, tone: alert.tone, icon: Trash2, count: num(n), text: plural(n, 'account is being deleted', 'accounts are being deleted'), href: accountsHash({segment: 'closing'})};
  }
}

/** What needs the operator, most urgent first; the first is featured. */
function Queue({entries}: {entries: QueueEntry[]}) {
  return (
    <ul className="mfa-queue" aria-label="Needs attention">
      {entries.map((entry, index) => {
        const Icon = entry.icon;
        return (
          <li key={entry.key}>
            <a className={`mfa-alert is-${entry.tone}${index === 0 ? ' is-featured' : ''}`} href={entry.href}>
              <span className="mfa-alert-icon" aria-hidden="true"><Icon size={20} strokeWidth={2} /></span>
              <span className="mfa-alert-text">
                <b>{entry.count}</b>
                <span>{entry.text}</span>
              </span>
              {index === 0 && <ChevronRight className="mfa-alert-go" size={18} strokeWidth={2} aria-hidden="true" />}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Overview({period}: {period: AdminPeriod}) {
  const query = useAdminQuery<AdminOverview>(ADMIN_API.overview, {period}, {report: true});
  const {waiting} = useAdmin();
  const data = query.data;
  if (!data && query.error) return <ScreenFailure title="Overview" query={query} />;
  if (!data) return <ScreenSkeleton title="Overview" kpis={3} />;

  const {kpis, series} = data;
  const days = series.signups.map(point => point.day);
  const compare = COMPARE[period];
  const queue: QueueEntry[] = [
    ...(waiting ? [{key: 'support', tone: 'warn' as const, icon: MessageCircle, count: num(waiting), text: plural(waiting, 'request is waiting for a reply', 'requests are waiting for a reply'), href: supportHash()}] : []),
    ...data.alerts.filter(alert => alert.count > 0).map(alertEntry),
  ];
  const funnel = data.funnel.map(step => ({key: step.key, label: step.label, value: step.value}));
  const returned = funnel[funnel.length - 1]?.value ?? 0;
  const conversion = funnel[0]?.value ? returned / funnel[0].value : 0;

  return (
    <div className={query.stale ? 'mfa-screen mfa-stale' : 'mfa-screen'}>
      <PageHead
        title="Overview"
        fact={
          <WindowFact window={data.window}>
            <span><b>{num(kpis.accounts.value)}</b> {plural(kpis.accounts.value, 'account', 'accounts')}</span>
          </WindowFact>
        }
      />

      {queue.length > 0 && <Queue entries={queue} />}

      <div className="mfa-kpis is-three">
        <Kpi hero label="Active" value={num(kpis.activeAccounts.value)} delta={delta(kpis.activeAccounts)} compare={compare} spark={series.active.map(point => point.value)} hint="Accounts that made at least one request in the period. The line shows active accounts by day." />
        <Kpi hero label="New" value={num(kpis.newAccounts.value)} delta={delta(kpis.newAccounts)} compare={compare} spark={series.signups.map(point => point.value)} sparkColor={seriesColor(1)} />
        <Kpi hero label="Total accounts" value={num(kpis.accounts.value)} delta={delta(kpis.accounts)} compare={compare} />
      </div>

      <div className="mfa-grid">
        <Section title="Sign-ups and activity" span={8} hint="New accounts and active ones (at least one request) by day, Moscow time.">
          <AreaLine
            label="Sign-ups and active accounts by day"
            days={days}
            toggle
            endLabels
            series={[
              {key: 'active', label: 'Active', values: series.active.map(point => point.value), color: seriesColor(0), area: true},
              {key: 'signups', label: 'Sign-ups', values: series.signups.map(point => point.value), color: seriesColor(1)},
            ]}
            axis={compact}
            height={300}
          />
        </Section>

        <Section title="Engagement" span={4} hint="DAU/MAU: the share of accounts active over 30 days that come in every day. Above 20% is good for a work tool.">
          <Gauge share={data.stickiness.mau ? data.stickiness.dau / data.stickiness.mau : 0} label="DAU / MAU" caption="DAU / MAU" />
          <div className="mfa-trio">
            <div><b>{num(data.stickiness.dau)}</b><span>per day</span></div>
            <div><b>{num(data.stickiness.wau)}</b><span>per week</span></div>
            <div><b>{num(data.stickiness.mau)}</b><span>per 30 days</span></div>
          </div>
        </Section>

        <Section title="Journey of new accounts" span={6} hint="Accounts that signed up in the period: how many reached each step." aside={<span className="mfa-chip is-brand">{pct(conversion)} came back</span>}>
          <Funnel label="Funnel of new accounts" steps={funnel} />
        </Section>

        <Section title="Weekly retention" span={6} hint="The share of accounts from the sign-up week that are active 1, 2 … 8 weeks later. Incomplete weeks are not shown.">
          <CohortGrid label="Cohorts by sign-up week" cohorts={data.cohorts} />
        </Section>

        <Section title="When they work" span={12} hint="Requests in the period by weekday and hour, Moscow time.">
          <Heatmap label="Requests by weekday and hour" grid={data.heatmap} />
        </Section>
      </div>
    </div>
  );
}
