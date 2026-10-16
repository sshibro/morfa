import {useEffect, useSyncExternalStore} from 'react';
import {ApiError} from '../../../api';
import {designIdFromHash} from '../../../navigation';
import {NUMBERS_REFRESH_MS, type FileCards, type FrameNumbers, type LoopLink, type LoopTest} from '../../../../shared/design/marketplace/loop';
import {notifyMarketplaceOverlay} from '../overlay';
import {readFileCards} from './api';

// The sales numbers of the open file (docs/marketplaces.md §Performance Loop), shared by "Sales" and the canvas strip: read when the
// file has a card on screen or the tab opens, again every ten minutes while the file stays open, and at once after a publish or a
// test changes. Every change redraws the canvas overlay. A 404 means the loop is off: nothing is asked again in this session.

export type FileCardsEntry = {
  state: 'loading' | 'ready' | 'off' | 'error';
  cards: FileCards | null;
  error: string | null;
};

/** `view` is replaced, never changed in place: it is what React compares to know the numbers changed. */
type Entry = {view: FileCardsEntry; fetchedAt: number; inflight: Promise<void> | null; timer: ReturnType<typeof setInterval> | null};
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const LOADING: FileCardsEntry = {state: 'loading', cards: null, error: null};

function changed() {
  for (const listener of listeners) listener();
  notifyMarketplaceOverlay();
}

/** The file's numbers as last read (undefined before the first read). */
export const fileCardsEntry = (fileId: string): FileCardsEntry | undefined => entries.get(fileId)?.view;

/** Reads the file's numbers again (`force`: even if they are fresh). */
export function refreshFileCards(fileId: string, force = false): Promise<void> {
  let entry = entries.get(fileId);
  if (!entry) entries.set(fileId, (entry = {view: LOADING, fetchedAt: 0, inflight: null, timer: null}));
  if (entry.view.state === 'off') return Promise.resolve();
  if (entry.inflight) return force ? entry.inflight.then(() => refreshFileCards(fileId, true)) : entry.inflight;
  if (!force && entry.view.state !== 'error' && Date.now() - entry.fetchedAt < NUMBERS_REFRESH_MS) return Promise.resolve();
  const current = entry;
  current.inflight = readFileCards(fileId)
    .then(cards => void (current.view = {state: 'ready', cards, error: null}))
    .catch(error => {
      if (error instanceof ApiError && error.status === 404 && error.details?.code !== 'not_found') current.view = {state: 'off', cards: null, error: null};
      else {
        const cards = current.view.cards;
        current.view = {state: cards ? 'ready' : 'error', cards, error: error instanceof Error ? error.message : 'Could not load the data.'};
      }
    })
    .then(() => {
      current.fetchedAt = Date.now();
      current.inflight = null;
      changed();
    });
  return current.inflight;
}

/** Keeps the file's numbers fresh while it is the open file (`#design/<id>`); stops by itself when another opens. */
export function watchFileCards(fileId: string): void {
  void refreshFileCards(fileId);
  const entry = entries.get(fileId)!;
  if (entry.timer || entry.view.state === 'off') return;
  entry.timer = setInterval(() => {
    if (designIdFromHash(location.hash) !== fileId || entry.view.state === 'off') {
      clearInterval(entry.timer!);
      entry.timer = null;
      return;
    }
    if (document.visibilityState === 'visible') void refreshFileCards(fileId);
  }, NUMBERS_REFRESH_MS);
}

/** The open file's id, as the address names it (the canvas overlay has no other way to know). */
export const openFileId = (): string => (typeof location === 'undefined' ? '' : designIdFromHash(location.hash));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** "Sales": the file's numbers, read on mount and kept fresh. */
export function useFileCards(fileId: string): FileCardsEntry {
  useEffect(() => {
    watchFileCards(fileId);
    void refreshFileCards(fileId, true);
  }, [fileId]);
  return useSyncExternalStore(subscribe, () => entries.get(fileId)?.view ?? LOADING);
}

/** The frame's numbers, its link (the frame itself, or the link whose test it is a variant of) and its tests. */
export function frameView(cards: FileCards | null, nodeId: string): {link: LoopLink | null; numbers: FrameNumbers | null; tests: LoopTest[]; variantOf: LoopTest | null} {
  if (!cards) return {link: null, numbers: null, tests: [], variantOf: null};
  const own = cards.links.find(link => link.nodeId === nodeId) ?? null;
  const variantOf = own ? null : (cards.tests.find(test => test.variantB === nodeId && (test.status === 'running' || test.status === 'planned')) ?? cards.tests.find(test => test.variantB === nodeId) ?? null);
  const link = own ?? (variantOf ? (cards.links.find(entry => entry.id === variantOf.linkId) ?? null) : null);
  return {
    link,
    numbers: cards.frames.find(frame => frame.nodeId === nodeId) ?? null,
    tests: link ? cards.tests.filter(test => test.linkId === link.id) : [],
    variantOf,
  };
}

/** Frames that won their link's latest finished test (tests come newest first). */
export function winnerFrames(cards: FileCards | null): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const test of cards?.tests ?? []) {
    if (test.status !== 'finished' || seen.has(test.linkId)) continue;
    seen.add(test.linkId);
    if (test.winner === 'a') out.add(test.variantA);
    else if (test.winner === 'b') out.add(test.variantB);
  }
  return out;
}
