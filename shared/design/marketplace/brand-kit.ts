// A brand kit (docs/marketplaces.md §Catalog Generation): the fonts, colours, logos, icons every generated card and slide
// kit follows. Stored per account (marketplace_brand_kits.kit); pictures are the account's design pictures. Owned by the Catalog
// Generation module, which may add fields; the ones below are what other modules read.

import type {ImageAsset} from '../types';

/** Colours as #rrggbb. */
export type BrandColors = {primary: string; secondary: string; accent: string; background: string; text: string};

export type BrandKit = {
  v: 1;
  name: string;
  colors: BrandColors;
  /** Font families from Morfa's font library. */
  fonts: {heading: string; body: string};
  /** The brand's logo (Ozon allows it as a watermark, YM as is, WB never). */
  logo: ImageAsset | null;
  /** The store's logo (refused by YM and WB). */
  storeLogo: ImageAsset | null;
  icons: ImageAsset[];
};

export type BrandKitRecord = {id: string; name: string; kit: BrandKit; updatedAt: string};

export const DEFAULT_BRAND_COLORS: BrandColors = {primary: '#141414', secondary: '#5b5b66', accent: '#4338ff', background: '#f4f4f6', text: '#141414'};

/** An account keeps at most this many kits; a kit at most this many icons. */
export const BRAND_KITS_PER_ACCOUNT = 20;
export const BRAND_KIT_ICONS = 24;
export const BRAND_KIT_NAME_CHARS = 80;

/** A new kit: Morfa's neutral colours, Inter for both fonts, no pictures. */
export const newBrandKit = (name: string): BrandKit => ({
  v: 1,
  name,
  colors: {...DEFAULT_BRAND_COLORS},
  fonts: {heading: 'Inter', body: 'Inter'},
  logo: null,
  storeLogo: null,
  icons: [],
});

/** Every picture a kit holds (logo, store logo, icons), for copying them into a file. */
export const brandKitPictures = (kit: BrandKit): ImageAsset[] => [kit.logo, kit.storeLogo, ...kit.icons].filter((asset): asset is ImageAsset => !!asset);
