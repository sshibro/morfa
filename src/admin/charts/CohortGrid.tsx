import type {AdminCohort} from '../../../shared/admin-analytics';
import {dayLabel, num, pct} from '../format';
import {SEQUENTIAL, sequentialInk, sequentialStep} from '../palette';

/** Weekly signup cohorts: one row per week, one column per week since signup, each cell the share still active, coloured on the
 *  sequential indigo ramp. It is a real table, so it reads as one. */
export function CohortGrid({label, cohorts}: {label: string; cohorts: AdminCohort[]}) {
  const columns = Math.max(1, ...cohorts.map(cohort => cohort.active.length));
  if (cohorts.length === 0) return <p className="mfa-none">No cohorts in this period</p>;
  return (
    <div className="mfa-cohorts">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col" className="mfa-cohort-week">Week</th>
            {Array.from({length: columns}, (_, index) => (
              <th key={index} scope="col">{index === 0 ? 'wk 0' : `+${index}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map(cohort => (
            <tr key={cohort.week}>
              <th scope="row" className="mfa-cohort-week">
                <span>{dayLabel(cohort.week)}</span>
                <em>{num(cohort.size)}</em>
              </th>
              {Array.from({length: columns}, (_, index) => {
                const share = cohort.active[index];
                if (share === undefined) return <td key={index} className="is-future" />;
                const step = cohort.size > 0 ? sequentialStep(share) : 0;
                return (
                  <td key={index} style={{background: SEQUENTIAL[step], color: sequentialInk(step)}} title={`${num(Math.round(share * cohort.size))} of ${num(cohort.size)}`}>
                    {cohort.size > 0 ? pct(share) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
