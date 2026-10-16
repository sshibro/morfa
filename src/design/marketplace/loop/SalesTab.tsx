import {memo, useEffect, useMemo, useState} from 'react';
import {collectCardFacts} from '../../../../shared/design/marketplace/facts';
import {lintCard} from '../../../../shared/design/marketplace/lint';
import {CARD_SLIDE_KINDS} from '../../../../shared/design/marketplace/specs';
import type {CardMeta} from '../../../../shared/design/marketplace/meta';
import {cardScore, type CardNumbers} from '../../../../shared/design/marketplace/score';
import {
  isLoopMarketplace,
  LOOP_MARKETPLACE_NAMES,
  SLOT_MAX,
  type FileCards,
  type FrameNumbers,
  type LoopConnection,
  type LoopLink,
  type LoopMarketplace,
  type LoopProduct,
  type LoopPublication,
} from '../../../../shared/design/marketplace/loop';
import type {NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button} from '../../ui/Button';
import {NumberField} from '../../ui/NumberField';
import {Select} from '../../ui/Select';
import {Spinner} from '../../ui/Spinner';
import {TextInput} from '../../ui/TextInput';
import {IconSearch, IconWarning} from '../../ui/icons';
import {AbTestSection} from './AbTest';
import {extensionOf, linkCard, publishCard, searchProducts, unlinkCard} from './api';
import {frameView, refreshFileCards, useFileCards} from './cards-store';
import {ConnectDialog} from './ConnectDialog';
import {conversionText, DASH, daysText, lowCtr, stripParts, whenText} from './format';
import {lintFailures, renderFrame} from './frames';

// Performance Loop: "Sales" (docs/marketplaces.md §Performance Loop). For a card not yet tied to the shop: connect Wildberries or
// Ozon by API key, then find the product and its photo slot. For a linked card: the numbers of the days its picture was live (bigger
// than the canvas strip), a 14-day sparkline, Card Score, "Publish" (Spec Lint's failures ask first) with its history, and the
// A/B test. Without the Professional plan the tab explains what it does and offers the plan; with the switch off it says so.

export const SalesTab = memo(function SalesTab({frameId, meta}: {frameId: NodeId; meta: CardMeta}) {
  const services = useEditorServices();
  const entry = useFileCards(services.fileId);
  if (!isLoopMarketplace(meta.marketplace))
    return <p className="dz-mp-loop-quiet">Yandex Market does not accept pictures through its API yet. Export the card in the Export tab.</p>;
  if (entry.state === 'loading')
    return (
      <div className="dz-mp-loop-loading" role="status">
        <Spinner size={14} /> Loading sales…
      </div>
    );
  if (entry.state === 'off') return <p className="dz-mp-loop-quiet">Publishing to marketplaces and statistics are turned off for now.</p>;
  if (!entry.cards)
    return (
      <div className="dz-mp-loop-stack">
        <p className="dz-mp-loop-error" role="alert">{entry.error ?? 'Could not load sales.'}</p>
        <Button onClick={() => void refreshFileCards(services.fileId, true)}>Retry</Button>
      </div>
    );
  const cards = entry.cards;
  const view = frameView(cards, frameId);
  const marketplace = meta.marketplace;
  if (!view.link) {
    const connections = cards.connections.filter(connection => connection.marketplace === marketplace);
    if (!connections.length) return <ConnectFirst marketplace={marketplace} />;
    return <LinkProduct frameId={frameId} meta={meta} connections={connections} />;
  }
  return <Linked frameId={frameId} meta={meta} cards={cards} link={view.link} numbers={view.numbers} variantOf={view.variantOf?.variantA ?? null} />;
});

function ConnectFirst({marketplace}: {marketplace: LoopMarketplace}) {
  const services = useEditorServices();
  const [open, setOpen] = useState(false);
  return (
    <div className="dz-mp-loop-stack">
      <p className="dz-mp-loop-lead">Connect a shop to publish the card and see its impressions, CTR and orders.</p>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={services.readOnly}>Connect {LOOP_MARKETPLACE_NAMES[marketplace]}</Button>
      {open && (
        <ConnectDialog
          marketplace={marketplace}
          onClose={() => setOpen(false)}
          onDone={connection => {
            setOpen(false);
            services.toast(`${connection.label}: connected`, 'success');
            void refreshFileCards(services.fileId, true);
          }}
        />
      )}
    </div>
  );
}

/** The product and photo slot the frame stands for: found by name, article or number in the seller's catalogue. */
function LinkProduct({frameId, meta, connections}: {frameId: NodeId; meta: CardMeta; connections: LoopConnection[]}) {
  const services = useEditorServices();
  const [connectionId, setConnectionId] = useState(connections[0]!.id);
  const connection = connections.find(entry => entry.id === connectionId) ?? connections[0]!;
  const [query, setQuery] = useState(meta.sku ?? '');
  const [results, setResults] = useState<LoopProduct[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<LoopProduct | null>(null);
  const [slot, setSlot] = useState(() => Math.max(1, CARD_SLIDE_KINDS.indexOf(meta.slide ?? 'main') + 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const number = connection.marketplace === 'wb' ? 'nmID' : 'product_id';

  useEffect(() => {
    if (connection.status === 'refused') return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const answer = await searchProducts(connection.id, query.trim(), controller.signal);
        setResults(answer.products);
        setError(null);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Search failed.');
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [connection.id, connection.status, query]);

  const link = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await linkCard({fileId: services.fileId, nodeId: frameId, connectionId: connection.id, productId: chosen.productId, slot});
      await refreshFileCards(services.fileId, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dz-mp-loop-stack">
      <p className="dz-mp-loop-lead">Link the card to a product and the photo it will replace.</p>
      {connections.length > 1 && (
        <Select aria-label="Shop" value={connection.id} options={connections.map(entry => ({value: entry.id, label: entry.label}))} onChange={setConnectionId} />
      )}
      {connection.status === 'refused' ? (
        <Refused connection={connection} onReconnect={() => setReconnect(true)} />
      ) : (
        <>
          <TextInput
            aria-label="Product"
            icon={<IconSearch />}
            value={query}
            onChange={value => {
              setQuery(value);
              setChosen(null);
            }}
            placeholder={`Name, article number or ${number}`}
            end={searching ? <Spinner size={12} /> : undefined}
          />
          {results && (
            <ul className="dz-mp-loop-products" aria-label="Products">
              {results.length === 0 && <li className="dz-mp-loop-quiet">Nothing found.</li>}
              {results.map(product => (
                <li key={product.productId}>
                  <button
                    type="button"
                    className="dz-mp-loop-product"
                    aria-pressed={chosen?.productId === product.productId}
                    onClick={() => setChosen(product)}>
                    <span className="dz-mp-loop-product-title">{product.title}</span>
                    <span className="dz-mp-loop-quiet">
                      {product.article ? `${product.article} · ` : ''}
                      {number} {product.productId}
                      {product.photos ? ` · photos: ${product.photos}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="dz-mp-loop-row">
            <label className="dz-mp-loop-field is-inline">
              <span>Photo no.</span>
              <NumberField aria-label="Photo number" value={slot} min={1} max={SLOT_MAX} precision={0} onChange={value => setSlot(Math.round(value))} />
            </label>
            <span className="dz-mp-loop-quiet">{slot === 1 ? 'main photo' : 'in the product gallery'}</span>
          </div>
          {error && <p className="dz-mp-loop-error" role="alert">{error}</p>}
          <Button variant="primary" disabled={!chosen || services.readOnly} busy={busy} onClick={link}>Link to product</Button>
        </>
      )}
      {reconnect && (
        <ConnectDialog
          marketplace={connection.marketplace}
          connection={connection}
          onClose={() => setReconnect(false)}
          onDone={() => {
            setReconnect(false);
            void refreshFileCards(services.fileId, true);
          }}
        />
      )}
    </div>
  );
}

function Refused({connection, onReconnect}: {connection: LoopConnection; onReconnect: () => void}) {
  return (
    <div className="dz-mp-loop-alert" role="alert">
      <IconWarning size={16} />
      <div className="dz-mp-loop-stack">
        <span>{connection.lastError ?? `${LOOP_MARKETPLACE_NAMES[connection.marketplace]} rejected the key.`}</span>
        <Button size={24} onClick={onReconnect}>Reconnect</Button>
      </div>
    </div>
  );
}

function Linked({frameId, meta, cards, link, numbers, variantOf}: {
  frameId: NodeId;
  meta: CardMeta;
  cards: FileCards;
  link: LoopLink;
  numbers: FrameNumbers | null;
  variantOf: NodeId | null;
}) {
  const services = useEditorServices();
  const connection = cards.connections.find(entry => entry.id === link.connectionId);
  const [reconnect, setReconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const number = link.marketplace === 'wb' ? 'nmID' : 'product_id';
  const variantName = useDesignStore(state => (variantOf ? state.doc.nodes[variantOf]?.name ?? null : null), Object.is, {slice: 'doc'});
  const unlink = async () => {
    setBusy(true);
    try {
      await unlinkCard(link.id);
      await refreshFileCards(services.fileId, true);
    } catch (caught) {
      services.toast(caught instanceof Error ? caught.message : 'Could not unlink.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dz-mp-loop">
      <div className="dz-mp-loop-product-head">
        <span className="dz-mp-loop-product-title">{link.title ?? `Product ${link.productId}`}</span>
        <span className="dz-mp-loop-quiet">
          {LOOP_MARKETPLACE_NAMES[link.marketplace]} · {number} {link.productId} · photo {link.slot}
        </span>
        {variantOf && <span className="dz-mp-loop-quiet">Variant B in the test of the card "{variantName ?? DASH}"</span>}
      </div>
      {connection?.status === 'refused' && <Refused connection={connection} onReconnect={() => setReconnect(true)} />}
      <Numbers numbers={numbers} window={cards.window} />
      <Score frameId={frameId} meta={meta} numbers={numbers} />
      {!variantOf && <Publish frameId={frameId} meta={meta} link={link} cards={cards} disabled={connection?.status === 'refused'} />}
      <AbTestSection frameId={frameId} meta={meta} link={link} cards={cards} />
      {!variantOf && (
        <Button size={24} variant="ghost" className="dz-mp-loop-unlink" busy={busy} disabled={services.readOnly} onClick={unlink}>Unlink from product</Button>
      )}
      {reconnect && connection && (
        <ConnectDialog
          marketplace={connection.marketplace}
          connection={connection}
          onClose={() => setReconnect(false)}
          onDone={() => {
            setReconnect(false);
            void refreshFileCards(services.fileId, true);
          }}
        />
      )}
    </div>
  );
}

/** The four numbers, larger than the canvas strip; conversion and the 14 days under them. */
function Numbers({numbers, window}: {numbers: FrameNumbers | null; window: FileCards['window']}) {
  if (!numbers || !numbers.days)
    return (
      <p className="dz-mp-loop-quiet dz-mp-loop-empty">
        No numbers yet. The marketplace reports them with a delay; Morfa fetches them every three hours.
      </p>
    );
  const parts = stripParts(numbers.totals);
  const low = lowCtr(numbers.totals);
  return (
    <section className="dz-mp-loop-block" aria-label="Sales">
      <dl className="dz-mp-loop-numbers">
        {parts.map(part => (
          <div key={part.label} className={`dz-mp-loop-number ${part.label === 'CTR' && low ? 'is-low' : ''}`}>
            <dt>{part.label}</dt>
            <dd>{part.value}</dd>
          </div>
        ))}
      </dl>
      {low && <p className="dz-mp-loop-error">CTR is below 2%: the cover is worth redoing.</p>}
      <p className="dz-mp-loop-quiet">
        Conversion to order {conversionText(numbers.totals)} ·{' '}
        {numbers.productWide ? `${daysText(numbers.days)} for the product: not published from Morfa yet` : `${daysText(numbers.days)} on the shelf`}
      </p>
      <Sparkline series={numbers.series} from={window.from} to={window.to} />
    </section>
  );
}

/** Fourteen days in one quiet line: CTR when impressions are known, else card opens; a gap where another picture was live. */
function Sparkline({series, from, to}: {series: FrameNumbers['series']; from: string; to: string}) {
  const byCtr = series.some(day => day && day.views);
  const values = series.map(day => (!day ? null : byCtr ? (day.views ? (day.clicks ?? 0) / day.views : null) : day.clicks));
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) return null;
  const max = Math.max(...known) || 1;
  const width = 140, height = 28, step = width / Math.max(1, values.length - 1);
  const segments: string[] = [];
  let current = '';
  values.forEach((value, i) => {
    if (value === null) {
      if (current) segments.push(current);
      current = '';
      return;
    }
    const point = `${(i * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`;
    current += (current ? ' L' : 'M') + point;
  });
  if (current) segments.push(current);
  const label = `${byCtr ? 'CTR' : 'Card visits'} by day from ${from} to ${to}`;
  return (
    <figure className="dz-mp-loop-spark">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {segments.map(path => <path key={path} d={path} />)}
      </svg>
      <figcaption className="dz-mp-loop-quiet">{byCtr ? 'CTR' : 'Visits'} over 14 days</figcaption>
    </figure>
  );
}

/** Card Score: half Spec Lint, half CTR against 5 %. */
function Score({frameId, meta, numbers}: {frameId: NodeId; meta: CardMeta; numbers: FrameNumbers | null}) {
  const doc = useDesignStore(state => state.doc, Object.is, {slice: 'doc'});
  const report = useMemo(() => {
    const facts = collectCardFacts(doc, frameId, meta);
    return facts ? lintCard(facts) : null;
  }, [doc, frameId, meta]);
  if (!report) return null;
  const totals: CardNumbers | null = numbers && numbers.days ? numbers.totals : null;
  const score = cardScore(report, totals);
  return (
    <div className={`dz-mp-loop-score ${score.lowCtr ? 'is-low' : ''}`}>
      <span className="dz-mp-loop-score-value" aria-label={`Card Score ${score.score} of 100`}>
        {score.score}
        <span className="dz-mp-loop-quiet">/100</span>
      </span>
      <span className="dz-mp-loop-score-text">
        <span>Card Score</span>
        <span className="dz-mp-loop-quiet">{score.lintOnly ? 'from the check: too few impressions for CTR yet' : 'check and CTR'}</span>
      </span>
    </div>
  );
}

const STATUS_TEXT: Record<LoopPublication['status'], string> = {
  pending: 'Sending…',
  sent: 'Sent: the marketplace is processing it',
  live: 'Live',
  failed: 'Not published',
  replaced: 'Replaced',
};

function Publish({frameId, meta, link, cards, disabled}: {frameId: NodeId; meta: CardMeta; link: LoopLink; cards: FileCards; disabled: boolean}) {
  const services = useEditorServices();
  const nodes = useDesignStore(state => state.doc.nodes, Object.is, {slice: 'doc'});
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = cards.publications.filter(publication => publication.linkId === link.id);
  const last = history[0];

  const send = async (confirmed: boolean) => {
    if (!confirmed) {
      const failed = lintFailures(services, frameId, meta);
      if (failed.length) {
        setFailures(failed.map(check => check.label));
        return;
      }
    }
    setFailures(null);
    setBusy(true);
    setError(null);
    try {
      const picture = await renderFrame(services, frameId, meta);
      const {publication} = await publishCard(link.id, picture, `card${extensionOf(picture)}`);
      await refreshFileCards(services.fileId, true);
      if (publication.status === 'failed') setError(publication.error ?? 'Not published.');
      else services.toast(publication.status === 'live' ? 'The picture is live' : 'Sent: the marketplace is processing the picture', 'success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not publish.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dz-mp-loop-block" aria-label="Publishing">
      {failures ? (
        <div className="dz-mp-loop-confirm" role="alertdialog" aria-label="The check found errors">
          <p>
            The check found errors: {failures.join(', ')}. {LOOP_MARKETPLACE_NAMES[link.marketplace]} may reject the picture or the card.
          </p>
          <div className="dz-mp-loop-row">
            <Button size={24} variant="danger" onClick={() => void send(true)}>Publish anyway</Button>
            <Button size={24} onClick={() => setFailures(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="primary" busy={busy} disabled={disabled || services.readOnly} onClick={() => void send(false)}>
          Publish to {LOOP_MARKETPLACE_NAMES[link.marketplace]}
        </Button>
      )}
      {error && <p className="dz-mp-loop-error" role="alert">{error}</p>}
      {last && !error && (
        <p className={`dz-mp-loop-quiet dz-mp-loop-last is-${last.status}`} role="status">
          {STATUS_TEXT[last.status]}
          {last.status === 'live' ? ` since ${whenText(last.liveFrom)}` : last.status === 'failed' && last.error ? `: ${last.error}` : ''}
        </p>
      )}
      {history.length > 0 && (
        <details className="dz-mp-loop-history">
          <summary>Publishing history</summary>
          <ol>
            {history.slice(0, 10).map(publication => (
              <li key={publication.id}>
                <span>{nodes[publication.nodeId]?.name ?? 'Frame deleted'}</span>
                <span className="dz-mp-loop-quiet">
                  {STATUS_TEXT[publication.status]} · {whenText(publication.liveFrom ?? publication.requestedAt)}
                  {publication.testId ? ' · test' : ''}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

