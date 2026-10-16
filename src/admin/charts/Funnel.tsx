import {num, pct} from '../format';
import {ORDINAL} from '../palette';
import {SrTable} from './core';

export type FunnelStep = {key: string; label: string; value: number};

/** Steps of one cohort as horizontal bars against the first step (an ordinal indigo ramp, darkest first), each with its share of the
 *  first step and the conversion from the step before. */
export function Funnel({label, steps}: {label: string; steps: FunnelStep[]}) {
  const first = steps[0]?.value ?? 0;
  return (
    <div className="mfa-funnel">
      <ol>
        {steps.map((step, index) => {
          const share = first > 0 ? step.value / first : 0;
          const previous = index > 0 ? steps[index - 1].value : null;
          const conversion = previous ? step.value / previous : null;
          return (
            <li key={step.key}>
              <div className="mfa-funnel-head">
                <span className="mfa-funnel-label">{step.label}</span>
                {conversion !== null && (
                  <span className="mfa-funnel-step" title="from the previous step">
                    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2v3.5a2 2 0 0 0 2 2h4M6 5.5l2 2-2 2" /></svg>
                    {pct(conversion)}
                  </span>
                )}
                <b className="mfa-funnel-value">{num(step.value)}</b>
              </div>
              <div className="mfa-funnel-track">
                <div className="mfa-funnel-bar" style={{width: `${Math.max(share * 100, step.value > 0 ? 0.8 : 0)}%`, background: ORDINAL[Math.min(index, ORDINAL.length - 1)]}} />
                <span className="mfa-funnel-share">{index === 0 ? '' : pct(share)}</span>
              </div>
            </li>
          );
        })}
      </ol>
      <SrTable
        caption={label}
        head={['Step', 'Accounts', 'From the first step', 'From the previous']}
        rows={steps.map((step, index) => [
          step.label,
          num(step.value),
          first > 0 ? pct(step.value / first) : '—',
          index > 0 && steps[index - 1].value > 0 ? pct(step.value / steps[index - 1].value) : '—',
        ])}
      />
    </div>
  );
}
