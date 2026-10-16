import {ADMIN_API, type AdminPeriod, type AdminUsage} from '../../../shared/admin-analytics';
import {Bars} from '../charts/Bars';
import {HBars} from '../charts/HBars';
import {useAdminQuery} from '../data';
import {bytes, compact, delta, num, pct} from '../format';
import {seriesColor} from '../palette';
import {Kpi, PageHead, Section} from '../ui';
import {COMPARE, ScreenFailure, ScreenSkeleton, WindowFact} from './common';

export function Usage({period}: {period: AdminPeriod}) {
  const query = useAdminQuery<AdminUsage>(ADMIN_API.usage, {period}, {report: true});
  const data = query.data;
  if (!data && query.error) return <ScreenFailure title="Usage" query={query} />;
  if (!data) return <ScreenSkeleton title="Usage" />;

  const {kpis, product, storage} = data;
  const compare = COMPARE[period];
  const productDays = product.filesCreated.map(point => point.day);

  return (
    <div className={query.stale ? 'mfa-screen mfa-stale' : 'mfa-screen'}>
      <PageHead
        title="Usage"
        fact={<WindowFact window={data.window} />}
      />

      <div className="mfa-strip-kpis is-three">
        <Kpi label="New files" value={num(kpis.filesCreated.value)} delta={delta(kpis.filesCreated)} compare={compare} />
        <Kpi label="Comments" value={num(kpis.comments.value)} delta={delta(kpis.comments)} compare={compare} />
        <Kpi label="New teams" value={num(kpis.teamsCreated.value)} delta={delta(kpis.teamsCreated)} compare={compare} />
      </div>

      <div className="mfa-grid">
        <Section title="New files" span={4}>
          <Bars label="New files by day" days={productDays} height={150} series={[{key: 'files', label: 'Files', values: product.filesCreated.map(point => point.value), color: seriesColor(0)}]} axis={compact} />
        </Section>
        <Section title="Versions" span={4}>
          <Bars label="Saved versions by day" days={productDays} height={150} series={[{key: 'versions', label: 'Versions', values: product.versions.map(point => point.value), color: seriesColor(0)}]} axis={compact} />
        </Section>
        <Section title="Comments" span={4}>
          <Bars label="Comments by day" days={productDays} height={150} series={[{key: 'comments', label: 'Comments', values: product.comments.map(point => point.value), color: seriesColor(0)}]} axis={compact} />
        </Section>

        <Section title="Feature adoption" span={7} hint="The share of accounts active in the period that used the feature.">
          <HBars
            label="Feature adoption"
            rows={[...product.adoption].sort((a, b) => b.share - a.share).map(feature => ({key: feature.key, label: feature.label, text: feature.label, value: feature.share, display: pct(feature.share), extra: num(feature.accounts)}))}
            max={1}
            labelWidth="34%"
          />
        </Section>

        <Section title="Storage" span={5}>
          <div className="mfa-tiles">
            <div><span>Files</span><b>{num(storage.files)}</b><small>{bytes(storage.documentBytes)}</small></div>
            <div><span>Pictures</span><b>{num(storage.pictures)}</b><small>{bytes(storage.pictureBytes)}</small></div>
            <div><span>Versions</span><b>{num(storage.versions)}</b><small>saved</small></div>
            <div><span>Total</span><b>{bytes(storage.documentBytes + storage.pictureBytes)}</b><small>documents and pictures</small></div>
          </div>
          <div className="mfa-split-bar mfa-storage-bar" aria-hidden="true">
            <i style={{flexGrow: storage.documentBytes || 1, background: seriesColor(0)}} />
            <i style={{flexGrow: storage.pictureBytes || 1, background: seriesColor(1)}} />
          </div>
          <ul className="mfa-storage-legend">
            <li><i className="mfa-key is-square" style={{background: seriesColor(0)}} />Documents</li>
            <li><i className="mfa-key is-square" style={{background: seriesColor(1)}} />Pictures</li>
          </ul>
        </Section>

        <Section title="Common actions" span={12} hint="Requests other than reads, in the period.">
          <HBars label="Common actions" rows={product.topActions.map(action => ({key: action.key, label: <span className="mfa-mono">{action.label}</span>, text: action.label, value: action.value}))} labelWidth="56%" />
        </Section>
      </div>
    </div>
  );
}
