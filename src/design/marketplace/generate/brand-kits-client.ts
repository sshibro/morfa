// The account's brand kits on the client (docs/marketplaces.md §Brand kit): read once per page from /api/marketplace/generation and kept
// in one shared list, so the Generate tab, slide kits and catalog runs see the same kits and a save shows everywhere at once. Owned by
// the Catalog Generation module; useBrandKits() is the contract other modules read.

import {useEffect, useSyncExternalStore} from 'react';
import type {BrandKit, BrandKitRecord} from '../../../../shared/design/marketplace/brand-kit';
import {createBrandKit, readBrandKits, removeBrandKit, saveBrandKit} from './api';

type KitsState = {kits: readonly BrandKitRecord[]; loading: boolean; loaded: boolean; error: string | null};
let state: KitsState = {kits: [], loading: false, loaded: false, error: null};
const listeners = new Set<() => void>();
const set = (change: Partial<KitsState>) => {
  state = {...state, ...change};
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const byChange = (a: BrandKitRecord, b: BrandKitRecord) => b.updatedAt.localeCompare(a.updatedAt);

let reading: Promise<void> | null = null;
/** Reads the kits (once; `again` reads them anew). */
export function loadBrandKits(again = false): Promise<void> {
  if (reading && !again) return reading;
  if (state.loaded && !again) return Promise.resolve();
  set({loading: true});
  reading = readBrandKits()
    .then(answer => set({kits: answer.kits, loading: false, loaded: true, error: null}))
    .catch((error: unknown) => set({loading: false, error: error instanceof Error ? error.message : 'Could not load brand kits.'}))
    .finally(() => {
      reading = null;
    });
  return reading;
}

/** Saves a kit: a new one when `id` is null. Resolves to the stored record (the server's checked copy). */
export async function storeBrandKit(id: string | null, kit: BrandKit): Promise<BrandKitRecord> {
  const {kit: record} = id ? await saveBrandKit(id, kit) : await createBrandKit(kit);
  set({kits: [record, ...state.kits.filter(each => each.id !== record.id)].sort(byChange)});
  return record;
}

export async function deleteBrandKit(id: string): Promise<void> {
  await removeBrandKit(id);
  set({kits: state.kits.filter(each => each.id !== id)});
}

/** The account's kits (the last changed first), read on first use. */
export function useBrandKits(): {kits: readonly BrandKitRecord[]; loading: boolean; error?: string | null} {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    void loadBrandKits();
  }, []);
  return {kits: snapshot.kits, loading: snapshot.loading || !snapshot.loaded && !snapshot.error, error: snapshot.error};
}

/** Forgets the kits (the account changed). */
export function resetBrandKits() {
  reading = null;
  set({kits: [], loading: false, loaded: false, error: null});
}
