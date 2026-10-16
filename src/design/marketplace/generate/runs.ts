// The one job "Generation" runs at a time in an editor (docs/marketplaces.md §Catalog Generation): a cut-out, a variant batch or a WB cover
// pair, with its progress, its stop and what it ended with. Kept per editor (per store), so the tab can close and open again while a
// batch runs.

import type {BrandKit} from '../../../../shared/design/marketplace/brand-kit';
import {newBrandKit} from '../../../../shared/design/marketplace/brand-kit';
import {planVariants} from '../../../../shared/design/marketplace/generation';
import {productLayers, type CardCopy} from '../../../../shared/design/marketplace/generation-layers';
import {cardMeta, type CardMeta} from '../../../../shared/design/marketplace/meta';
import {COVER_AUDIENCE_LABELS} from '../../../../shared/design/marketplace/specs';
import type {ImageRef, NodeId} from '../../../../shared/design/types';
import type {FontRegistry} from '../../engine/contracts';
import type {DesignStore} from '../../engine/store';
import {cutOutFree} from './api';
import {fontWeights, insertCopies, placeCutOut} from './apply';

export type RunKind = 'cut' | 'variants' | 'covers';
export type RunTone = 'done' | 'warning' | 'error';
export type RunResult = {
  kind: RunKind;
  cardId: NodeId;
  tone: RunTone;
  message: string;
  /** The layers or frames it made, for "Show". */
  made?: NodeId[];
};
export type RunState = {
  running: {kind: RunKind; cardId: NodeId; step: string; done: number; total: number} | null;
  last: RunResult | null;
};

export type RunServices = {
  fileId: string;
  store: DesignStore;
  fonts: Pick<FontRegistry, 'families' | 'ensure'>;
  revealNodes(ids: readonly NodeId[]): void;
};
type Step = (step: string, done?: number) => void;
type Work = (signal: AbortSignal, step: Step) => Promise<Omit<RunResult, 'kind' | 'cardId'>>;

// ── One runner per editor ───────────────────────────────────────────────────────────────────────

export type Runner = {
  get(): RunState;
  subscribe(listener: () => void): () => void;
  /** Stops the job: the request in flight is dropped; a batch keeps what is done. */
  cancel(): void;
  /** Forgets the last result (the panel's "×"). */
  dismiss(): void;
  start(kind: RunKind, cardId: NodeId, total: number, work: Work): Promise<RunResult | null>;
};

const runners = new WeakMap<DesignStore, Runner>();

export function runnerOf(store: DesignStore): Runner {
  let runner = runners.get(store);
  if (runner) return runner;
  let state: RunState = {running: null, last: null};
  let abort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (change: Partial<RunState>) => {
    state = {...state, ...change};
    for (const listener of [...listeners]) listener();
  };
  runner = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    cancel: () => abort?.abort(),
    dismiss: () => set({last: null}),
    async start(kind, cardId, total, work) {
      if (state.running) return null;
      const controller = (abort = new AbortController());
      set({running: {kind, cardId, step: '', done: 0, total}, last: null});
      const step: Step = (text, done) => state.running && set({running: {...state.running, step: text, done: done ?? state.running.done}});
      let result: RunResult;
      try {
        result = {kind, cardId, ...(await work(controller.signal, step))};
      } catch (error) {
        result = {kind, cardId, tone: controller.signal.aborted ? 'warning' : 'error', message: controller.signal.aborted ? 'Stopped.' : failureMessage(error)};
      } finally {
        if (abort === controller) abort = null;
      }
      set({running: null, last: result});
      return result;
    },
  };
  runners.set(store, runner);
  return runner;
}

/** "1 variant", "3 variants". */
export function variantsWord(count: number): string {
  return count === 1 ? 'variant' : 'variants';
}

/** What a failed step says: a lost connection, the server's sentence when it sent one, else a general line. */
function failureMessage(error: unknown): string {
  if (error instanceof TypeError) return 'No connection to the server. Check your connection and try again.';
  return error instanceof Error && error.message ? error.message : 'Could not complete the request.';
}

/** The card's meta and frame as the store has them now (a run starts on a card that may have changed since the panel drew). */
function cardNow(store: DesignStore, cardId: NodeId) {
  const doc = store.getState().doc;
  const card = doc.nodes[cardId];
  const meta = cardMeta(card);
  if (!card || !meta) throw Error('Card not found: it was deleted or is no longer a card.');
  return {doc, card, meta};
}

// ── Cut-outs ────────────────────────────────────────────────────────────────────────────────────

/** "Remove background" (free, on the server): the product of `sourceId`'s picture as the card's locked product layer. */
export function runCutOut(services: RunServices, input: {cardId: NodeId; sourceId: NodeId; imageRef: ImageRef}) {
  const {store, fileId} = services;
  return runnerOf(store).start('cut', input.cardId, 1, async (signal, step) => {
    step('Removing the background…');
    const answer = await cutOutFree({fileId, imageRef: input.imageRef}, signal);
    const id = placeCutOut(store, input.sourceId, answer, 'Remove background');
    if (!id) return {tone: 'error', message: 'The photo layer was deleted while the product was being cut out.'};
    return {tone: 'done', message: 'Product cut out and locked.', made: [id]};
  });
}

// ── Variants and covers ─────────────────────────────────────────────────────────────────────────

/** The kit a batch styles new layers with: the chosen one, or neutral colours and Inter. */
const kitOrDefault = (kit: BrandKit | null): BrandKit => kit ?? newBrandKit('No brand kit');

/** Loads the kit's faces before new texts are laid out (at most a few seconds: the editor lays them out again once they come). */
async function kitFonts(fonts: RunServices['fonts'], kit: BrandKit) {
  const faces = [kit.fonts.heading, kit.fonts.body].flatMap(family => [400, 600, 700].map(weight => fonts.ensure({family, weight, italic: false, size: 16}).catch(() => undefined)));
  await Promise.race([Promise.all(faces), new Promise(resolve => setTimeout(resolve, 3000))]);
}

/** A copy's meta: the master's, in its set, with only the copy's own variant or audience. */
function copyMeta(meta: CardMeta, group: string, own: {variant?: number; audience?: CardMeta['audience']}): CardMeta {
  const {variant: _variant, audience: _audience, ...rest} = meta;
  void _variant;
  void _audience;
  return {...rest, group, ...own};
}

export type VariantsInput = {
  cardId: NodeId;
  count: number;
  kit: BrandKit | null;
};

/**
 * "Cover variants": `count` copies of the card to its right, each on one of the kit's colour backgrounds, with its own badge and
 * product placement; the headline stays the card's own. All frames land in one undo step.
 */
export function runVariants(services: RunServices, input: VariantsInput) {
  const {store} = services;
  return runnerOf(store).start('variants', input.cardId, 0, async (signal, step) => {
    const {doc, card, meta} = cardNow(store, input.cardId);
    const kit = kitOrDefault(input.kit);
    const plans = planVariants({count: input.count, colors: kit.colors, marketplace: meta.marketplace, products: productLayers(doc, input.cardId).length});
    step('Building variants…');
    await kitFonts(services.fonts, kit);
    if (signal.aborted) return {tone: 'warning', message: 'Stopped.'};
    const group = meta.group ?? input.cardId;
    const copies: CardCopy[] = plans.map(plan => ({
      meta: copyMeta(meta, group, {variant: plan.variant}),
      name: `${card.name} · variant ${plan.variant}`,
      background: plan.background,
      badge: plan.badge,
      composition: plan.composition,
    }));
    const made = insertCopies(store, input.cardId, copies, kit, fontWeights(services.fonts), `Cover variants · ${plans.length}`);
    if (made.length) services.revealNodes([input.cardId, ...made]);
    return {tone: 'done', message: `Done: ${made.length} ${variantsWord(made.length)} to the right of the card.`, made};
  });
}

/**
 * "Pair of WB covers": two covers beside the card for WB's personalized covers, "New buyers" and "Returning buyers" (what is
 * new: another product layer when the card has several, else a closer look, with a "New" badge). Each cover keeps the card's headline.
 */
export function runCovers(services: RunServices, input: {cardId: NodeId; kit: BrandKit | null}) {
  const {store} = services;
  return runnerOf(store).start('covers', input.cardId, 0, async (_signal, step) => {
    const {doc, meta} = cardNow(store, input.cardId);
    const kit = kitOrDefault(input.kit);
    step('Building covers…');
    await kitFonts(services.fonts, kit);
    const products = productLayers(doc, input.cardId).length;
    const group = meta.group ?? input.cardId;
    const copies: CardCopy[] = [
      {meta: copyMeta(meta, group, {audience: 'new'}), name: COVER_AUDIENCE_LABELS.new, background: null, badge: null, composition: null},
      {
        meta: copyMeta(meta, group, {audience: 'returning'}), name: COVER_AUDIENCE_LABELS.returning, background: null,
        badge: {shape: 'pill', text: 'New'},
        composition: products > 1 ? {scale: 1, dx: 0, dy: 0, rotation: 0, mirror: false, product: 1} : {scale: 1.15, dx: 0, dy: 0.02, rotation: 0, mirror: false, product: 0},
      },
    ];
    const made = insertCopies(store, input.cardId, copies, kit, fontWeights(services.fonts), 'Pair of WB covers');
    if (made.length) services.revealNodes([input.cardId, ...made]);
    return {tone: 'done', message: `The covers "${COVER_AUDIENCE_LABELS.new}" and "${COVER_AUDIENCE_LABELS.returning}" are to the right of the card.`, made};
  });
}
