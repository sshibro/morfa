// Card Canvas: Spec Lint live on a card (docs/marketplaces.md §Spec Lint). The pure checks follow the card's layers within a moment
// of an edit; the measurements (the file's size, text contrast, the product's cover) wait until the edits have stopped for
// 600 ms, run one at a time, and only for a caller that asks (the open "Check" tab). An edit elsewhere in the file wakes
// nothing: the card's own layers are compared by identity first.

import {useEffect, useMemo, useRef, useState} from 'react';
import {collectCardFacts} from '../../../../shared/design/marketplace/facts';
import {lintCard, type CardFacts, type LintReport} from '../../../../shared/design/marketplace/lint';
import type {CardMeta} from '../../../../shared/design/marketplace/meta';
import {MARKETPLACES, type Marketplace} from '../../../../shared/design/marketplace/specs';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {cardSignature, sameList} from './card-doc';
import {measureCard, recalledMeasured, rememberMeasured, type CardMeasured} from './measure';

/** Pure checks follow edits at most this often. */
export const FACTS_THROTTLE_MS = 150;
/** Measurements start once the card has not changed for this long. */
export const MEASURE_DEBOUNCE_MS = 600;

export type CardLint = {
  /** The card's own marketplace first; with `all`, the other two too. Null for a frame that is gone. */
  reports: Partial<Record<Marketplace, LintReport>>;
  /** A measurement is running. */
  measuring: boolean;
  /** Measurements arrived at least once for this card. */
  measured: boolean;
};

export type CardLintOptions = {
  /** Run the measurements (the open "Check" tab); without, the last ones of this visit are reused. */
  measure: boolean;
  /** Check every marketplace, not only the card's own. */
  all: boolean;
  /** The card's proofing issues (proof/client.ts `useCardProofing`, which the caller runs only where it may fetch). */
  proofing?: CardFacts['proofing'];
};

export function useCardLint(frameId: NodeId, meta: CardMeta, options: CardLintOptions): CardLint {
  const services = useEditorServices();
  const store = services.store;
  const proofing = options.proofing;
  const metaKey = JSON.stringify(meta);

  // The document, re-read when the card's layers change (throttled), as a version number: a store that writes its table in place
  // keeps the same object.
  const docRef = useRef<DesignDocument>(store.getState().doc);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let signature = cardSignature(store.getState().doc, frameId);
    docRef.current = store.getState().doc;
    setVersion(v => v + 1);
    const read = () => {
      timer = null;
      const doc = store.getState().doc;
      const next = cardSignature(doc, frameId);
      if (sameList(signature, next)) return;
      signature = next;
      docRef.current = doc;
      setVersion(v => v + 1);
    };
    const off = store.subscribe(() => {
      timer ??= setTimeout(read, FACTS_THROTTLE_MS);
    }, {slice: 'doc'});
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [store, frameId]);

  // Measurements: one at a time; an edit during one runs another after it, on the card as it is then.
  const [result, setResult] = useState<{frameId: NodeId; key: string; value: CardMeasured} | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const latest = useRef({frameId, meta, services});
  latest.current = {frameId, meta, services};
  const run = useRef({busy: false, again: false, scheduled: false, alive: true});
  useEffect(() => {
    run.current.alive = true;
    return () => {
      run.current.alive = false;
    };
  }, []);
  useEffect(() => {
    if (!options.measure) return;
    const state = run.current;
    const start = () => {
      state.scheduled = false;
      if (state.busy) {
        state.again = true;
        return;
      }
      state.busy = true;
      setMeasuring(true);
      const {frameId: id, meta: card, services: editor} = latest.current;
      const key = JSON.stringify(card);
      measureCard(editor, docRef.current, id, card)
        .then(value => {
          if (!state.alive) return;
          rememberMeasured(id, card.marketplace, value);
          setResult({frameId: id, key, value});
        }, () => undefined)
        .finally(() => {
          state.busy = false;
          if (!state.alive) return;
          if (state.again) {
            state.again = false;
            start();
          } else if (!state.scheduled) setMeasuring(false);
        });
    };
    // From the edit on, the checks that wait for a measurement say so, not "No data".
    setMeasuring(true);
    state.scheduled = true;
    const timer = setTimeout(start, MEASURE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      state.scheduled = false;
    };
  }, [options.measure, version, metaKey, frameId]);

  const measured = result?.frameId === frameId && result.key === metaKey ? result.value : recalledMeasured(frameId, meta.marketplace);
  const reports = useMemo(() => {
    const doc = docRef.current;
    const out: Partial<Record<Marketplace, LintReport>> = {};
    for (const marketplace of options.all ? MARKETPLACES : [meta.marketplace]) {
      const facts = collectCardFacts(doc, frameId, {...meta, marketplace}, {measured, proofing});
      if (facts) out[marketplace] = lintCard(facts);
    }
    return out;
    // `metaKey` stands for `meta`, a fresh object on every render of the section.
  }, [version, metaKey, frameId, measured, proofing, options.all]);
  return {reports, measuring: options.measure && measuring, measured: measured !== undefined};
}
