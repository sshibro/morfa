import {useMemo, useState} from 'react';
import type {CardMeta} from '../../../../shared/design/marketplace/meta';
import {formatPercent, type CardNumbers} from '../../../../shared/design/marketplace/score';
import {
  DEFAULT_SWAP_HOURS,
  DEFAULT_TEST_DAYS,
  LOOP_MARKETPLACE_NAMES,
  ROTATION_SWAP_HOURS,
  TEST_DAYS_MAX,
  TEST_DAYS_MIN,
  type FileCards,
  type LoopLink,
  type LoopTest,
  type TestMode,
  type TestResult,
  type TestWinner,
} from '../../../../shared/design/marketplace/loop';
import {daysLeft, moscowDay} from '../../../../shared/design/marketplace/loop-stats';
import type {NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button} from '../../ui/Button';
import {NumberField} from '../../ui/NumberField';
import {Select} from '../../ui/Select';
import {SegmentedControl} from '../../ui/Tabs';
import {TextInput} from '../../ui/TextInput';
import {createAbTest, extensionOf, moveLink, setTestWinner, startCabinetTest, stopAbTest} from './api';
import {refreshFileCards} from './cards-store';
import {daysText, pText} from './format';
import {downloadPicture, duplicateAsVariant, renderFrame, variantCandidates} from './frames';

// "A/B test" in "Sales" (docs/marketplaces.md §Performance Loop): set the linked frame (A) against another (B), either as Morfa's own
// rotation (the slot's picture swapped at Moscow midnight, the winner by a z-test on the days each was live) or as the marketplace's
// built-in test followed from here (Morfa prepares both pictures; the seller starts it in the cabinet and enters the winner). Under it,
// the file's queue: every test planned or running, with its days left, the picture live now and "Stop".

const MODES = [
  {value: 'rotation', label: 'Rotation in Morfa'},
  {value: 'cabinet', label: 'Test in the seller account'},
] as const;
const SWAPS = ROTATION_SWAP_HOURS.map(hours => ({value: String(hours), label: hours === 24 ? 'Every day' : `Every ${hours / 24} days`}));
const WINNERS = [
  {value: 'a', label: 'A'},
  {value: 'b', label: 'B'},
  {value: 'none', label: 'No clear winner'},
] as const;

type Props = {frameId: NodeId; meta: CardMeta; link: LoopLink; cards: FileCards};

const useNames = () => useDesignStore(state => state.doc.nodes, Object.is, {slice: 'doc'});
const nameOf = (nodes: Record<string, {name?: string} | undefined>, id: string) => nodes[id]?.name || 'frame deleted';
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'That did not work. Try again.');

/** "CTR 2.0% → 5.1%" (A → B) for a result, by the metric it was judged on. */
function comparison(result: TestResult | null): string | null {
  if (!result?.metric) return null;
  const rate = (side: CardNumbers) =>
    result.metric === 'ctr'
      ? side.views && side.clicks !== null ? formatPercent(side.clicks / side.views) : '—'
      : side.clicks && side.orders !== null ? formatPercent(side.orders / side.clicks) : '—';
  return `${result.metric === 'ctr' ? 'CTR' : 'Orders from clicks'} ${rate(result.a)} → ${rate(result.b)}`;
}

export function AbTestSection({frameId, meta, link, cards}: Props) {
  const tests = cards.tests.filter(test => test.linkId === link.id);
  const active = tests.find(test => test.status === 'planned' || test.status === 'running');
  const finished = tests.find(test => test.status === 'finished');
  const queue = cards.tests.filter(test => test.status === 'planned' || test.status === 'running');
  return (
    <section className="dz-mp-loop-block" aria-label="A/B test">
      <h3 className="dz-mp-loop-heading">A/B test</h3>
      {active ? (
        <ActiveTest test={active} link={link} meta={meta} cards={cards} />
      ) : (
        <>
          {finished && <FinishedTest test={finished} link={link} />}
          <NewTest frameId={frameId} meta={meta} link={link} cards={cards} />
        </>
      )}
      {queue.length > (active ? 1 : 0) && <TestQueue tests={queue} cards={cards} />}
    </section>
  );
}

function NewTest({frameId, meta, link, cards}: Props) {
  const services = useEditorServices();
  const doc = useDesignStore(state => state.doc, Object.is, {slice: 'doc'});
  const candidates = useMemo(() => variantCandidates(services, link.nodeId, meta), [services, link.nodeId, meta, doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const [variant, setVariant] = useState<string | null>(null);
  const [mode, setMode] = useState<TestMode>('rotation');
  const [swap, setSwap] = useState(String(DEFAULT_SWAP_HOURS));
  const [days, setDays] = useState(DEFAULT_TEST_DAYS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = candidates.find(candidate => candidate.id === variant) ?? candidates[0] ?? null;
  const refused = cards.connections.find(connection => connection.id === link.connectionId)?.status === 'refused';
  if (frameId !== link.nodeId) return null;

  if (!chosen)
    return (
      <div className="dz-mp-loop-stack">
        <p className="dz-mp-loop-quiet">A test needs a second variant of the card on this page.</p>
        <Button onClick={() => duplicateAsVariant(services, frameId)} disabled={services.readOnly}>Duplicate as variant B</Button>
      </div>
    );

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const pictures = mode === 'rotation' ? {a: await renderFrame(services, link.nodeId, meta), b: await renderFrame(services, chosen.id, meta)} : null;
      await createAbTest({linkId: link.id, variantB: chosen.id, mode, days, ...(mode === 'rotation' ? {swapHours: Number(swap)} : {})}, pictures);
      await refreshFileCards(services.fileId, true);
      services.toast(mode === 'rotation' ? 'Rotation started: variant A is live' : 'Test prepared');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dz-mp-loop-stack">
      <label className="dz-mp-loop-field">
        <span>Variant B</span>
        <Select aria-label="Variant B" value={chosen.id} options={candidates.map(candidate => ({value: candidate.id, label: candidate.name}))} onChange={setVariant} />
      </label>
      <SegmentedControl aria-label="How to test" options={MODES} value={mode} onChange={setMode} fill />
      {mode === 'rotation' ? (
        <>
          <div className="dz-mp-loop-pair">
            <label className="dz-mp-loop-field">
              <span>Change photo</span>
              <Select aria-label="Change photo" value={swap} options={SWAPS} onChange={setSwap} />
            </label>
            <label className="dz-mp-loop-field">
              <span>Days</span>
              <NumberField aria-label="Test days" value={days} min={TEST_DAYS_MIN} max={TEST_DAYS_MAX} precision={0} onChange={value => setDays(Math.round(value))} />
            </label>
          </div>
          <p className="dz-mp-loop-quiet">
            Morfa will swap the main photo at midnight Moscow time and compare CTR, or orders from clicks if {LOOP_MARKETPLACE_NAMES[link.marketplace]} does not report impressions.
          </p>
        </>
      ) : (
        <>
          <label className="dz-mp-loop-field">
            <span>Days</span>
            <NumberField aria-label="Test days" value={days} min={7} max={TEST_DAYS_MAX} precision={0} onChange={value => setDays(Math.round(value))} />
          </label>
          <p className="dz-mp-loop-quiet">
            {link.marketplace === 'wb' ? 'Wildberries' : 'Ozon'} has no API for built-in tests: Morfa prepares both pictures, you start the test in the seller account and mark the result here.
          </p>
        </>
      )}
      {error && <p className="dz-mp-loop-error" role="alert">{error}</p>}
      <Button variant="primary" busy={busy} disabled={refused || services.readOnly} onClick={start}>
        {mode === 'rotation' ? 'Start rotation' : 'Prepare test'}
      </Button>
    </div>
  );
}

function ActiveTest({test, link, meta, cards}: {test: LoopTest; link: LoopLink; meta: CardMeta; cards: FileCards}) {
  const services = useEditorServices();
  const nodes = useNames();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedOn, setStartedOn] = useState(() => moscowDay(Date.parse(cards.now)));
  const [winner, setWinner] = useState<TestWinner | null>(null);
  const now = Date.parse(cards.now);
  const left = test.endsAt ? daysLeft(Date.parse(test.endsAt), now) : test.days;
  const run = (key: string, work: () => Promise<unknown>) => async () => {
    setBusy(key);
    setError(null);
    try {
      await work();
      await refreshFileCards(services.fileId, true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };
  const stop = run('stop', () => stopAbTest(test.id));
  const names = {a: nameOf(nodes, test.variantA), b: nameOf(nodes, test.variantB)};

  return (
    <div className="dz-mp-loop-stack">
      <div className="dz-mp-loop-status">
        <span className={`dz-mp-loop-dot is-${test.status}`} aria-hidden="true" />
        <span>
          {test.mode === 'rotation' ? 'Rotation' : 'Test in the seller account'} ·{' '}
          {test.status === 'planned' ? 'not started yet' : left > 0 ? `${daysText(left)} left` : 'time is up'}
        </span>
      </div>
      <dl className="dz-mp-loop-variants">
        <dt>A</dt>
        <dd>{names.a}{test.liveVariant === 'a' && <span className="dz-mp-loop-live">live</span>}</dd>
        <dt>B</dt>
        <dd>{names.b}{test.liveVariant === 'b' && <span className="dz-mp-loop-live">live</span>}</dd>
      </dl>
      {test.mode === 'rotation' && test.result && <Standing result={test.result} />}
      {test.mode === 'cabinet' && test.status === 'planned' && (
        <ol className="dz-mp-loop-steps">
          <li>
            <span>Download both pictures.</span>
            <Button size={24} busy={busy === 'download'} onClick={run('download', async () => {
              for (const [variant, id] of [['a', test.variantA], ['b', test.variantB]] as const) {
                const blob = await renderFrame(services, id, meta);
                downloadPicture(blob, `${variant.toUpperCase()} — ${nameOf(nodes, id)}${extensionOf(blob)}`);
              }
            })}>Download A and B</Button>
          </li>
          <li>
            Start a photo test in the {LOOP_MARKETPLACE_NAMES[link.marketplace]} seller account for the product {link.marketplace === 'wb' ? 'nmID' : 'product_id'} {link.productId}.
          </li>
          <li>
            <span>Mark the start day.</span>
            <div className="dz-mp-loop-row">
              <TextInput aria-label="Start day" type="date" value={startedOn} onChange={setStartedOn} max={moscowDay(now)} />
              <Button size={24} variant="primary" busy={busy === 'start'} onClick={run('start', () => startCabinetTest(test.id, startedOn || null))}>Test started</Button>
            </div>
          </li>
        </ol>
      )}
      {test.mode === 'cabinet' && test.status === 'running' && (
        <div className="dz-mp-loop-stack">
          <span className="dz-mp-loop-caption">Who won according to the seller account?</span>
          <SegmentedControl aria-label="Winner" options={WINNERS} value={winner} onChange={setWinner} fill />
          <Button size={24} variant="primary" disabled={!winner} busy={busy === 'winner'} onClick={run('winner', () => setTestWinner(test.id, winner!))}>Save result</Button>
        </div>
      )}
      {error && <p className="dz-mp-loop-error" role="alert">{error}</p>}
      <Button size={24} variant="ghost" className="dz-mp-loop-stop" busy={busy === 'stop'} onClick={stop}>Stop</Button>
    </div>
  );
}

/** A running rotation's standing so far: each variant's days and rate. */
function Standing({result}: {result: TestResult}) {
  const rate = (side: CardNumbers & {days: number}) =>
    result.metric === 'conversion'
      ? side.clicks ? formatPercent((side.orders ?? 0) / side.clicks) : '—'
      : side.views && side.clicks !== null ? formatPercent(side.clicks / side.views) : '—';
  const label = result.metric === 'conversion' ? 'Orders from clicks' : 'CTR';
  return (
    <table className="dz-mp-loop-standing">
      <thead>
        <tr><th scope="col">Variant</th><th scope="col">Days</th><th scope="col">{label}</th></tr>
      </thead>
      <tbody>
        <tr><th scope="row">A</th><td>{result.a.days}</td><td>{rate(result.a)}</td></tr>
        <tr><th scope="row">B</th><td>{result.b.days}</td><td>{rate(result.b)}</td></tr>
      </tbody>
    </table>
  );
}

function FinishedTest({test, link}: {test: LoopTest; link: LoopLink}) {
  const services = useEditorServices();
  const nodes = useNames();
  const [busy, setBusy] = useState(false);
  const winnerId = test.winner === 'b' ? test.variantB : test.winner === 'a' ? test.variantA : null;
  const compared = comparison(test.result);
  const nextRound = async () => {
    if (!winnerId) return;
    setBusy(true);
    try {
      // The winner becomes the linked frame (A) of the next round; its copy is the new variant.
      if (link.nodeId !== winnerId) await moveLink(link.id, winnerId);
      const copy = duplicateAsVariant(services, winnerId);
      await refreshFileCards(services.fileId, true);
      if (copy) services.toast('The new variant is ready: edit it and start the test');
    } catch (caught) {
      services.toast(errorText(caught), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`dz-mp-loop-verdict ${winnerId ? 'is-winner' : ''}`}>
      <p className="dz-mp-loop-verdict-title">
        {winnerId ? <>Winner: {test.winner!.toUpperCase()} "{nameOf(nodes, winnerId)}"</> : 'No clear winner'}
      </p>
      <p className="dz-mp-loop-quiet">
        {test.mode === 'cabinet' ? 'According to the seller account.' : compared ? `${compared}${test.result?.p !== null && test.result?.p !== undefined ? ` · ${pText(test.result.p)}` : ''}` : 'Not enough data to compare.'}
      </p>
      {winnerId && (
        <Button size={24} busy={busy} disabled={services.readOnly} onClick={nextRound}>Next round from the winner</Button>
      )}
    </div>
  );
}

/** Every test of the file that is planned or running. */
function TestQueue({tests, cards}: {tests: LoopTest[]; cards: FileCards}) {
  const services = useEditorServices();
  const nodes = useNames();
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.parse(cards.now);
  return (
    <div className="dz-mp-loop-queue">
      <h4 className="dz-mp-loop-caption">Tests in this file</h4>
      <ul>
        {tests.map(test => (
          <li key={test.id}>
            <button type="button" className="dz-mp-loop-queue-name" onClick={() => services.revealNodes([test.variantA, test.variantB])}>
              {nameOf(nodes, test.variantA)} / {nameOf(nodes, test.variantB)}
            </button>
            <span className="dz-mp-loop-quiet">
              {test.status === 'planned' ? 'not started' : test.endsAt ? `${daysText(daysLeft(Date.parse(test.endsAt), now))} left` : 'running'}
              {test.liveVariant ? ` · live ${test.liveVariant.toUpperCase()}` : ''}
            </span>
            <Button size={24} variant="ghost" busy={busy === test.id} onClick={async () => {
              setBusy(test.id);
              try {
                await stopAbTest(test.id);
                await refreshFileCards(services.fileId, true);
              } catch (caught) {
                services.toast(errorText(caught), 'error');
              } finally {
                setBusy(null);
              }
            }}>Stop</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
