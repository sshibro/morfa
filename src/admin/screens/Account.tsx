import {useState} from 'react';
import {FileText, MessageSquare, MonitorSmartphone, Share2, Video} from 'lucide-react';
import {ADMIN_API, type AdminAccountDetail} from '../../../shared/admin-analytics';
import {Bars} from '../charts/Bars';
import {HBars} from '../charts/HBars';
import {Meter} from '../charts/Meter';
import {ApiError} from '../../api';
import {useAdminQuery} from '../data';
import {ago, bytes, countOf, dateLabel, daysSince, num, plural, timeLabel} from '../format';
import {seriesColor} from '../palette';
import {accountsHash} from '../route';
import {Avatar, Chip, CopyId, Empty, Failure, Kpi, KpiSkeleton, PageHead, Section, SegmentPill} from '../ui';

/** shared/design/teams.ts DesignTeamRole */
const ROLE_LABEL: Record<string, string> = {owner: 'owner', admin: 'admin', editor: 'editor', developer: 'developer', viewer: 'viewer', member: 'member'};

/** A journal row's route, said shorter: "POST /api/design/files/:id/versions" → "POST design/files/:id/versions". */
const actionText = (action: string) => action.replace(/\s\/api\//, ' ').replace(/^read$/, 'read');

function AccountSkeleton() {
  return (
    <>
      <header className="mfa-head" aria-busy="true">
        <span className="mfa-skel" style={{width: 72, height: 72, borderRadius: 36}} />
        <div className="mfa-head-text">
          <span className="mfa-skel" style={{width: 260, height: 30}} />
          <span className="mfa-skel" style={{width: 200, height: 14}} />
        </div>
      </header>
      <div className="mfa-kpis">{Array.from({length: 4}, (_, index) => <KpiSkeleton key={index} />)}</div>
    </>
  );
}

export function AccountPage({id}: {id: string}) {
  const query = useAdminQuery<AdminAccountDetail>(ADMIN_API.account(id), {}, {report: true});
  const [showAll, setShowAll] = useState(false);
  const data = query.data;
  if (!data && query.error) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return <Empty text="There is no such account, or it was deleted" action={<a className="mfa-btn" href={accountsHash()}>All accounts</a>} />;
    }
    return (
      <>
        <PageHead title="Account" />
        <Failure error={query.error} onRetry={query.retry} />
      </>
    );
  }
  if (!data) return <AccountSkeleton />;

  const {account, files, activity} = data;
  const since = daysSince(account.createdAt);
  const days = activity.daily.map(point => point.day);
  const recent = showAll ? activity.recent : activity.recent.slice(0, 12);

  return (
    <div className="mfa-screen">
      <PageHead
        leading={<Avatar id={account.id} name={account.name} email={account.email} size="lg" />}
        title={account.name || account.email}
        fact={
          <>
            <span>{account.email}</span>
            <i className="mfa-dot-sep" aria-hidden="true" />
            <span>with us <b>{countOf(since, 'day', 'days')}</b></span>
            <i className="mfa-dot-sep" aria-hidden="true" />
            <span>seen {ago(account.lastActiveAt)}</span>
          </>
        }
      />
      <div className="mfa-badges">
        <SegmentPill segment={account.segment} />
        {account.deletionRequestedAt && <span className="mfa-sec-alert is-danger"><i aria-hidden="true" />deletion requested {dateLabel(account.deletionRequestedAt)}</span>}
        <CopyId id={account.id} />
      </div>

      <div className="mfa-strip-kpis">
        <Kpi label="Teams" value={num(data.teams.length)} />
        <Kpi label="Files" value={num(files.count)} foot={files.trashed ? `${num(files.trashed)} in the trash` : `${num(files.versions)} versions`} />
        <Kpi label="Storage" value={bytes(files.storageBytes)} />
        <Kpi
          label="Active days"
          value={`${account.activeDays30d} of 30`}
          visual={<Meter value={account.activeDays30d} max={30} label="Active days of 30" tone={account.activeDays30d >= 15 ? 'good' : 'brand'} height={6} />}
        />
      </div>

      <div className="mfa-grid">
        <Section title="Activity, 90 days" span={12} hint="The account's requests by day, Moscow time.">
          <Bars label="The account's requests by day over 90 days" days={days} unit="day" series={[{key: 'requests', label: 'Requests', values: activity.daily.map(point => point.value), color: seriesColor(0)}]} height={200} />
        </Section>

        <Section title="Teams" span={12} count={data.teams.length || undefined}>
          {data.teams.length === 0 ? (
            <p className="mfa-none">Not in any team</p>
          ) : (
            <ul className="mfa-teams">
              {data.teams.map(team => (
                <li key={team.id}>
                  <span className="mfa-team-mark" aria-hidden="true">{team.name.slice(0, 1).toUpperCase()}</span>
                  <span className="mfa-who-text">
                    <b>{team.name}</b>
                    <small>{countOf(team.members, 'member', 'members')}</small>
                  </span>
                  <Chip tone={team.role === 'owner' ? 'brand' : undefined}>{ROLE_LABEL[team.role] ?? team.role}</Chip>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent files" span={8} count={files.count || undefined}>
          {files.recent.length === 0 ? (
            <p className="mfa-none">No files</p>
          ) : (
            <ul className="mfa-files">
              {files.recent.map(file => (
                <li key={file.id}>
                  <span className="mfa-file-icon" aria-hidden="true"><FileText size={16} strokeWidth={1.9} /></span>
                  <span className="mfa-who-text">
                    <b>{file.name}</b>
                    <small>{ago(file.updatedAt)}{file.team ? ' · team' : ''}</small>
                  </span>
                  <span className="mfa-file-meta">{num(file.nodeCount)} <small>{plural(file.nodeCount, 'layer', 'layers')}</small></span>
                  <span className="mfa-file-meta">{bytes(file.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Collaboration" span={4}>
          <ul className="mfa-facts">
            <li><MessageSquare size={16} strokeWidth={1.9} aria-hidden="true" /><span>Comments</span><b>{num(data.collaboration.comments)}</b></li>
            <li><Share2 size={16} strokeWidth={1.9} aria-hidden="true" /><span>Shared files</span><b>{num(data.collaboration.sharedFiles)}</b></li>
            <li><Video size={16} strokeWidth={1.9} aria-hidden="true" /><span>Calls</span><b>{num(data.collaboration.meetings)}</b></li>
            <li><MonitorSmartphone size={16} strokeWidth={1.9} aria-hidden="true" /><span>Active sessions</span><b>{num(account.sessions.active)}</b></li>
          </ul>
          {account.sessions.lastSignInAt && <p className="mfa-small">Last sign-in {ago(account.sessions.lastSignInAt)}</p>}
        </Section>

        <Section title="Common actions" span={6} hint="Requests other than reads, over 90 days.">
          <HBars label="Common actions" rows={activity.topActions.map(action => ({key: action.key, label: <span className="mfa-mono">{actionText(action.label)}</span>, text: action.label, value: action.value}))} labelWidth="55%" />
        </Section>

        <Section title="Recent actions" span={6} count={activity.recent.length || undefined}>
          {activity.recent.length === 0 ? (
            <p className="mfa-none">Nothing yet</p>
          ) : (
            <>
              <ol className="mfa-timeline">
                {recent.map((row, index) => (
                  <li key={row.at + index} className={row.action === 'read' ? 'is-read' : undefined}>
                    <time dateTime={row.at}>{timeLabel(row.at)}</time>
                    <i aria-hidden="true" />
                    <span className="mfa-mono">{actionText(row.action)}</span>
                    <small>{ago(row.at)}</small>
                  </li>
                ))}
              </ol>
              {activity.recent.length > 12 && (
                <button type="button" className="mfa-more" onClick={() => setShowAll(value => !value)}>
                  {showAll ? 'Collapse' : `${activity.recent.length - 12} more`}
                </button>
              )}
            </>
          )}
        </Section>
      </div>
    </div>
  );
}
