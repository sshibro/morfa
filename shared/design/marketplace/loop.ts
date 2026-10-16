// Performance Loop (docs/marketplaces.md §Performance Loop): what the editor and /api/marketplace say to each other about a seller's
// connections, the card frames linked to products, the pictures published, the numbers the marketplaces report and the A/B tests.
// Types and limits only; the arithmetic is in ./loop-stats.ts.

import type {CardNumbers} from './score';

/** The marketplaces whose seller APIs Morfa talks to (Yandex Market cards are designed and exported, not published). */
export type LoopMarketplace = 'wb' | 'ozon';
export const LOOP_MARKETPLACES: readonly LoopMarketplace[] = ['wb', 'ozon'];
export const isLoopMarketplace = (value: unknown): value is LoopMarketplace => value === 'wb' || value === 'ozon';
export const LOOP_MARKETPLACE_NAMES: Readonly<Record<LoopMarketplace, string>> = {wb: 'Wildberries', ozon: 'Ozon'};

/** `refused`: the marketplace said the key is not valid (or lacks a right); nothing is synced until it is entered again. */
export type ConnectionStatus = 'ok' | 'refused' | 'error';

/** A seller's account as the editor sees it: never the key, only a hint that tells two keys apart. */
export type LoopConnection = {
  id: string;
  marketplace: LoopMarketplace;
  label: string;
  hint: string;
  status: ConnectionStatus;
  lastError: string | null;
  checkedAt: string | null;
  syncedAt: string | null;
  createdAt: string;
};

/** A product found in the seller's catalogue. WB: `productId` is the nmID; Ozon: the product_id, `sku` what its analytics count by. */
export type LoopProduct = {productId: string; sku: string | null; title: string; article: string | null; photos: number};

/** A card frame standing for one photo slot (1 = the main one) of a product. */
export type LoopLink = {
  id: string;
  nodeId: string;
  connectionId: string;
  marketplace: LoopMarketplace;
  productId: string;
  sku: string | null;
  title: string | null;
  slot: number;
  createdAt: string;
};

export type PublicationStatus = 'pending' | 'sent' | 'live' | 'failed' | 'replaced';
/** One picture sent for a linked slot, and the hours it was the live photo. */
export type LoopPublication = {
  id: string;
  linkId: string;
  nodeId: string;
  testId: string | null;
  status: PublicationStatus;
  error: string | null;
  requestedAt: string;
  sentAt: string | null;
  liveFrom: string | null;
  liveUntil: string | null;
};

export type TestMode = 'cabinet' | 'rotation';
export type TestStatus = 'planned' | 'running' | 'finished' | 'stopped';
export type TestVariant = 'a' | 'b';
export type TestWinner = TestVariant | 'none';
/** What a test compared: CTR when both variants have impressions, else orders per card open; `metric` null for a cabinet test. */
export type TestResult = {
  metric: 'ctr' | 'conversion' | null;
  a: CardNumbers & {days: number};
  b: CardNumbers & {days: number};
  z: number | null;
  p: number | null;
};
export type LoopTest = {
  id: string;
  linkId: string;
  variantA: string;
  variantB: string;
  mode: TestMode;
  status: TestStatus;
  days: number;
  swapHours: number | null;
  liveVariant: TestVariant | null;
  nextSwapAt: string | null;
  startedAt: string | null;
  endsAt: string | null;
  finishedAt: string | null;
  winner: TestWinner | null;
  result: TestResult | null;
  createdAt: string;
};

/** One Moscow day's numbers. */
export type DayNumbers = CardNumbers & {day: string};

/** A frame's numbers over the window: the days it was the live picture (`series`: every day of the window, oldest first, null
 *  where another picture was live or nothing was reported). `productWide`: the link was never published from Morfa, so the
 *  numbers are the product's whatever picture it shows. */
export type FrameNumbers = {
  nodeId: string;
  linkId: string;
  totals: CardNumbers;
  days: number;
  series: (DayNumbers | null)[];
  productWide: boolean;
};

/** GET /api/marketplace/files/:fileId/cards: everything "Sales" and the canvas show for one file. */
export type FileCards = {
  /** The server's clock (days left, "updated"). */
  now: string;
  window: {from: string; to: string};
  connections: LoopConnection[];
  links: LoopLink[];
  frames: FrameNumbers[];
  tests: LoopTest[];
  publications: LoopPublication[];
};

/** GET /api/marketplace/loop: the loop is on (404 otherwise). */
export type LoopState = {on: true};

/** The numbers shown by default: the last two weeks. */
export const NUMBERS_WINDOW_DAYS = 14;
/** How often the open file asks again. */
export const NUMBERS_REFRESH_MS = 10 * 60_000;
/** Rotation: the picture changes at Moscow midnight every one, two or three days (the marketplaces report by day). */
export const ROTATION_SWAP_HOURS: readonly number[] = [24, 48, 72];
export const DEFAULT_SWAP_HOURS = 24;
export const DEFAULT_TEST_DAYS = 14;
/** A test runs from a week (the marketplaces' own tests' minimum) to two months. */
export const TEST_DAYS_MIN = 1;
export const TEST_DAYS_MAX = 60;
/** The picture the editor uploads: a marketplace takes up to 10 MB. */
export const PUBLISH_MAX_BYTES = 10 * 1024 * 1024;
/** Photo slots a product has. */
export const SLOT_MAX = 30;
