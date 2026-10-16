// Catalog Generation (docs/marketplaces.md §Catalog Generation): what the editor and the server agree on for cut-outs, variant batches
// and WB cover sets. The wire types of /api/marketplace/generation and the plan of a variant batch. Pure: no DOM, no server imports, so
// the editor, the server and the tests read the same lists.
//
// Morfa never redraws the product: a cut-out keeps the seller's own pixels.

import type {ImageAsset, ImageRef} from '../types';
import type {BrandKit} from './brand-kit';
import {marketplaceSpec, type Marketplace} from './specs';

// ── Wire types (/api/marketplace/generation) ────────────────────────────────────────────────────
//   GET    /brand-kits                  → {kits: BrandKitRecord[]}
//   POST   /brand-kits                  → {kit: BrandKitRecord}             body {kit: BrandKit}
//   PATCH  /brand-kits/:id              → {kit: BrandKitRecord}             body {kit: BrandKit}
//   DELETE /brand-kits/:id              → {ok: true}
//   POST   /brand-kits/:id/pictures     → KitPicturesAnswer                 body {fileId, urls?}
//   POST   /cut-out                     → CutOutAnswer                      body CutOutBody

/** Fractions (0..1) of the source picture: the part the cut-out keeps. */
export type CutOutBox = {x: number; y: number; width: number; height: number};
export type CutOutBody = {fileId: string; imageRef: ImageRef};
/** The cut-out, stored as a design picture of the file (PNG with alpha), and where it sits in its source picture. */
export type CutOutAnswer = {ref: ImageRef; asset: ImageAsset; box: CutOutBox; source: {width: number; height: number}};

/** A kit's pictures as the file can use them: the same picture when it already belongs to the file's place, else a copy stored in the
 *  file; a picture the account can no longer read is left out. Keyed by the kit's own url. */
export type KitPicturesAnswer = {pictures: Record<string, {ref: ImageRef; asset: ImageAsset}>};

// ── Variants ────────────────────────────────────────────────────────────────────────────────────

export const VARIANT_COUNT = {min: 2, max: 12, default: 10} as const;

export type BadgeShape = 'pill' | 'rect' | 'round' | 'tag';
export const BADGE_SHAPES: readonly BadgeShape[] = ['pill', 'rect', 'tag', 'round'];
/** Short badge words that pass every marketplace's word rules (tests/design-marketplace-generation.test.ts holds them to it). */
export const BADGE_TEXTS: readonly string[] = ['New', 'New colour', 'Premium', 'Warranty', 'Eco', 'Limited edition'];
/** The badge texts the marketplace lets through. */
export const badgeTexts = (marketplace: Marketplace): string[] => BADGE_TEXTS.filter(text => !marketplaceSpec(marketplace).bannedWords.some(rule => rule.pattern.test(text)));

/** A variant's background: the brand kit's colours. */
export type VariantBackground =
  | {kind: 'solid'; color: string}
  | {kind: 'linear'; from: string; to: string}
  | {kind: 'radial'; from: string; to: string};
/** How the product stands in the frame: a scale and an offset (fractions of the frame) over the master's placement, a slight turn, a
 *  mirror, and which of the seller's product layers is shown. */
export type VariantComposition = {scale: number; dx: number; dy: number; rotation: number; mirror: boolean; product: number};
export type VariantPlan = {variant: number; background: VariantBackground; badge: {shape: BadgeShape; text: string}; composition: VariantComposition};

const COMPOSITIONS: readonly Omit<VariantComposition, 'product'>[] = [
  {scale: 1, dx: 0, dy: 0, rotation: 0, mirror: false},
  {scale: 1.12, dx: 0, dy: 0.02, rotation: 0, mirror: false},
  {scale: 0.9, dx: -0.06, dy: 0, rotation: 3, mirror: false},
  {scale: 1, dx: 0.06, dy: 0, rotation: -3, mirror: true},
  {scale: 0.95, dx: 0, dy: -0.03, rotation: 0, mirror: true},
  {scale: 1.06, dx: -0.04, dy: 0.01, rotation: -2, mirror: false},
];

/** Hex helpers for the kit's colours (#rrggbb). */
export function mixHex(a: string, b: string, t: number): string {
  const read = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) || 0);
  const [x, y] = [read(a), read(b)];
  return '#' + x.map((value, i) => Math.round(value + (y[i] - value) * t).toString(16).padStart(2, '0')).join('');
}

/** The brand kit's own backgrounds, in the order variants take them. */
export function kitBackgrounds(colors: BrandKit['colors']): VariantBackground[] {
  return [
    {kind: 'solid', color: colors.background},
    {kind: 'linear', from: colors.background, to: mixHex(colors.background, colors.primary, 0.18)},
    {kind: 'solid', color: mixHex(colors.background, colors.accent, 0.12)},
    {kind: 'radial', from: '#ffffff', to: colors.background},
    {kind: 'linear', from: mixHex(colors.background, colors.secondary, 0.15), to: colors.background},
    {kind: 'solid', color: mixHex(colors.background, colors.primary, 0.08)},
  ];
}

/**
 * The plan of a variant batch: `count` variants on the brand kit's colours, each with its own badge and composition (rotating among
 * `products` product layers). Deterministic, so a batch can be explained and tested.
 */
export function planVariants(options: {count: number; colors: BrandKit['colors']; marketplace: Marketplace; products: number}): VariantPlan[] {
  const count = Math.max(VARIANT_COUNT.min, Math.min(VARIANT_COUNT.max, Math.round(options.count)));
  const own = kitBackgrounds(options.colors);
  const texts = badgeTexts(options.marketplace);
  const products = Math.max(1, Math.round(options.products));
  return Array.from({length: count}, (_, index) => ({
    variant: index + 1,
    background: own[index % own.length],
    badge: {shape: BADGE_SHAPES[index % BADGE_SHAPES.length], text: texts[index % texts.length] ?? 'New'},
    composition: {...COMPOSITIONS[index % COMPOSITIONS.length], product: index % products},
  }));
}
