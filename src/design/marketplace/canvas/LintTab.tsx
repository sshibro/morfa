import {memo, useRef, useState, type KeyboardEvent} from 'react';
import type {LintCheck, LintFinding, LintReport, LintStatus} from '../../../../shared/design/marketplace/lint';
import type {CardMeta} from '../../../../shared/design/marketplace/meta';
import {MARKETPLACE_RULES_CHECKED, MARKETPLACES, marketplaceSpec, type Marketplace} from '../../../../shared/design/marketplace/specs';
import type {NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {IconCheck, IconClose} from '../../ui/icons';
import {Spinner} from '../../ui/Spinner';
import {useCardProofing} from '../proof/client';
import {setCardMarketplace} from './card-ops';
import {useCardLint} from './use-card-lint';
import {errors, remarks, tallyOf, verdictText} from './verdict';

// Card Canvas: "Check", Spec Lint's live checks for the card (docs/marketplaces.md §Spec Lint). On top, the verdict for the
// card's marketplace; under it the marketplace switch, which is also the summary of all three ("WB ✓ · Ozon ✕ 2 · YM !"); then the
// checks that fail or wait, each finding a button that selects its layers; the passed checks fold into one line. The date of
// the rules the checks follow closes the tab. The tab measures only while it is open (use-card-lint.ts).

/** A check's state as a small round mark: green tick, red cross, amber "!", a ring while it waits. */
export function StatusMark({status, measuring = false}: {status: LintStatus; measuring?: boolean}) {
  if (status === 'pending') return measuring ? <Spinner size={14} className="dz-mp-mark is-pending" /> : <span className="dz-mp-mark is-pending" aria-hidden="true" />;
  return (
    <span className={`dz-mp-mark is-${status}`} aria-hidden="true">
      {status === 'pass' ? <IconCheck size={12} strokeWidth={2} /> : status === 'fail' ? <IconClose size={12} strokeWidth={2} /> : '!'}
    </span>
  );
}

export const LintTab = memo(function LintTab({frameId, meta}: {frameId: NodeId; meta: CardMeta}) {
  const services = useEditorServices();
  const proofing = useCardProofing(frameId);
  const {reports, measuring} = useCardLint(frameId, meta, {measure: true, all: true, proofing});
  const [passedOpen, setPassedOpen] = useState(false);
  const report = reports[meta.marketplace];
  if (!report) return null;
  const spec = marketplaceSpec(meta.marketplace);
  const problems = report.checks.filter(check => check.status === 'fail' || check.status === 'warn');
  const waiting = report.checks.filter(check => check.status === 'pending');
  const passed = report.checks.filter(check => check.status === 'pass');
  const show = (ids: readonly NodeId[]) => {
    const doc = services.store.getState().doc;
    const present = ids.filter(id => doc.nodes[id]);
    if (!present.length) return;
    services.store.setSelection(present);
    // The card itself is on screen already: reveal only its layers.
    if (present.some(id => id !== frameId)) services.revealNodes(present);
  };
  return (
    <div className="dz-mp-lint">
      <Verdict report={report} name={spec.name} measuring={measuring} />
      <MarketplaceSwitch value={meta.marketplace} reports={reports} measuring={measuring} disabled={!!services.readOnly}
        onChange={marketplace => setCardMarketplace(services.store, frameId, marketplace)} />
      {(problems.length > 0 || waiting.length > 0) && (
        <ul className="dz-mp-checks" aria-label="Checks">
          {[...problems, ...waiting].map(check => <CheckRow key={check.id} check={check} measuring={measuring} onShow={show} />)}
        </ul>
      )}
      {passed.length > 0 && (
        <>
          <button type="button" className="dz-mp-passed" aria-expanded={passedOpen} onClick={() => setPassedOpen(open => !open)}>
            <StatusMark status="pass" />
            <span>Passed: {passed.length}</span>
            <span className="dz-mp-passed-action">{passedOpen ? 'Collapse' : 'Show'}</span>
          </button>
          {passedOpen && (
            <ul className="dz-mp-checks is-passed" aria-label="Passed checks">
              {passed.map(check => <CheckRow key={check.id} check={check} measuring={measuring} onShow={show} />)}
            </ul>
          )}
        </>
      )}
      <p className="dz-mp-rules">Rules as of {MARKETPLACE_RULES_CHECKED}</p>
    </div>
  );
});

function Verdict({report, name, measuring}: {report: LintReport; name: string; measuring: boolean}) {
  const tally = tallyOf(report);
  const waiting = report.checks.filter(check => check.status === 'pending').map(check => check.label.toLowerCase());
  const [title, detail] = tally.fail
    ? [`Will not pass ${name} moderation`, errors(tally.fail) + (tally.warn ? `, ${remarks(tally.warn)}` : '')]
    : tally.warn
      ? [`Will pass ${name} moderation`, `But there are ${remarks(tally.warn)}`]
      : tally.pending
        ? measuring ? ['Checking…', `${name}: ${waiting.join(', ')}`] : ['No errors', `No data: ${waiting.join(', ')}`]
        : [`Ready for ${name}`, 'All checks passed'];
  return (
    <div className={`dz-mp-verdict is-${report.status}`} role="status">
      <StatusMark status={report.status} measuring={measuring} />
      <div className="dz-mp-verdict-text">
        <span className="dz-mp-verdict-title">{title}</span>
        <span className="dz-mp-verdict-detail">{detail}</span>
      </div>
    </div>
  );
}

/** The card's marketplace, as a segmented switch whose segments carry each marketplace's verdict: "WB ✓", "Ozon ✕ 2", "YM !".
 *  Choosing one moves the card to that marketplace (one undo step). */
function MarketplaceSwitch({value, reports, measuring, disabled, onChange}: {
  value: Marketplace;
  reports: Partial<Record<Marketplace, LintReport>>;
  measuring: boolean;
  disabled: boolean;
  onChange: (marketplace: Marketplace) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const next = MARKETPLACES[(MARKETPLACES.indexOf(value) + step + MARKETPLACES.length) % MARKETPLACES.length];
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div ref={group} role="radiogroup" aria-label="Card marketplace" className="dz-segmented is-fill dz-mp-switch" onKeyDown={onKeyDown}>
      {MARKETPLACES.map(id => {
        const report = reports[id];
        const tally = tallyOf(report);
        const spec = marketplaceSpec(id);
        const verdict = verdictText(report, measuring);
        const count = tally.fail || tally.warn;
        return (
          <button key={id} type="button" role="radio" aria-checked={id === value} tabIndex={id === value ? 0 : -1} data-value={id} disabled={disabled}
            aria-label={`${spec.name}: ${verdict}`} title={`${spec.name}: ${verdict}`} className="dz-segment dz-mp-switch-item" onClick={() => onChange(id)}>
            <span>{spec.short}</span>
            <span className={`dz-mp-switch-status is-${report?.status ?? 'pending'}`} aria-hidden="true">
              {report?.status === 'pass' ? <IconCheck size={12} strokeWidth={2} /> : report?.status === 'fail' ? <IconClose size={12} strokeWidth={2} /> : report?.status === 'warn' ? '!' : '…'}
              {count > 0 && <span className="dz-mp-switch-count">{count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CheckRow({check, measuring, onShow}: {check: LintCheck; measuring: boolean; onShow: (ids: readonly NodeId[]) => void}) {
  const state = check.status === 'fail' ? 'Error' : check.status === 'warn' ? 'Remark' : check.status === 'pending' ? (measuring ? 'Measuring…' : 'No data') : '';
  return (
    <li className={`dz-mp-check is-${check.status}`}>
      <div className="dz-mp-check-head">
        <StatusMark status={check.status} measuring={measuring} />
        <span className="dz-mp-check-label">{check.label}</span>
        {state && <span className="dz-mp-check-state">{state}</span>}
      </div>
      {check.findings.length > 0 && (
        <ul className="dz-mp-findings">
          {check.findings.map((finding, index) => <FindingRow key={index} finding={finding} onShow={onShow} />)}
        </ul>
      )}
    </li>
  );
}

export function FindingRow({finding, onShow}: {finding: LintFinding; onShow: (ids: readonly NodeId[]) => void}) {
  return (
    <li>
      {finding.nodeIds.length
        ? <button type="button" className={`dz-mp-finding is-${finding.status}`} title="Show on the canvas" onClick={() => onShow(finding.nodeIds)}>{finding.message}</button>
        : <span className={`dz-mp-finding is-${finding.status}`}>{finding.message}</span>}
    </li>
  );
}
