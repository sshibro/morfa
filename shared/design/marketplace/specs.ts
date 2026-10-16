// "Marketplaces": the product-card rules of Wildberries, Ozon and Yandex Market that Morfa's frames, Spec Lint and exports
// follow (docs/marketplaces.md). Plain data with no imports, so the editor, the server and the tests read the same numbers.
//
// The marketplaces change these rules every few months, so the set carries a version and the date it was checked; the editor
// shows that date beside the checks. Sources: SelSup "Photo requirements for products on marketplaces" (22 Sep 2026) and "Neural network
// for product photos" (15 Sep 2026), both summarising the marketplaces' help centres.

export type Marketplace = 'wb' | 'ozon' | 'ym';
export const MARKETPLACES: readonly Marketplace[] = ['wb', 'ozon', 'ym'];

/** Bumped with any rule below; the date is the day the set was last checked against the marketplaces. */
export const MARKETPLACE_RULES_VERSION = '2026-09-22';
export const MARKETPLACE_RULES_CHECKED = '22.09.2026';

export type ImageFormat = 'jpg' | 'png' | 'webp' | 'heic';

/** A zone of the card the marketplace's own badges, price chips or the favourite icon cover in the catalogue. Fractions of the
 *  frame (0..1) so the zone fits any frame size; approximate, measured on the catalogue grid of the web and mobile apps. */
export type SafeZone = {id: string; label: string; x: number; y: number; width: number; height: number};

export type BannedWordRule = {
  id: string;
  /** Matched against each text layer's characters, case-insensitive, `u` flag. */
  pattern: RegExp;
  /** What the check says when it finds one, 'The word "sale": WB does not allow it…' style, without the word itself. */
  reason: string;
};

export type LogoRule =
  /** WB: no logo on the image at all. */
  | 'forbidden'
  /** Ozon: only the brand's watermark, off-centre and under half the area. */
  | 'watermark'
  /** Yandex Market: the brand's logo yes, the store's logo no. */
  | 'brand-only';

export type MarketplaceSpec = {
  id: Marketplace;
  name: string;
  short: string;
  /** The frame a new card opens at. */
  frame: {width: number; height: number};
  formats: readonly ImageFormat[];
  minSize: {width: number; height: number};
  maxSize: {width: number; height: number} | null;
  /** Width:height the main image should have; `strict` turns a mismatch into a failure rather than a warning. */
  aspect: {width: number; height: number; strict: boolean};
  maxFileBytes: number;
  maxImages: number;
  /** WB: a card with fewer images is not shown in search. */
  minImagesForSearch: number | null;
  /** WB: the least JPEG quality (the "compression at least 65 %" rule). */
  minJpegQuality: number | null;
  logo: LogoRule;
  /** Text contrast against what is behind it (WCAG): normal and large text. Null where the marketplace sets none. */
  textContrast: {normal: number; large: number} | null;
  /** YM: the product fills at least this share of the frame's height or width. */
  productMinFill: number | null;
  /** Ozon: 3D renders and images without the actual product are refused. */
  realProductOnly: boolean;
  /** WB: garbled captions made by AI lower the card's grade. */
  proofText: boolean;
  bannedWords: readonly BannedWordRule[];
  safeZones: readonly SafeZone[];
  /** Ozon fresh: square cards. */
  altFrames: readonly {id: string; name: string; width: number; height: number}[];
};

const MB = 1024 * 1024;

/** A Russian word and every ending of it: `stem` plus any letters, not glued to a letter before it. */
const word = (stem: string) => new RegExp(`(?<![\\p{L}\\d])${stem}\\p{L}*`, 'iu');
/** An exact phrase with free endings on its last word. */
const phrase = (text: string) => new RegExp(`(?<![\\p{L}\\d])${text.replace(/ /g, '\\s+')}\\p{L}*`, 'iu');

/** Contacts are refused by every marketplace: phones, links, e-mail, @names and messengers. */
const CONTACT_RULES: readonly BannedWordRule[] = [
  {id: 'contact-phone', pattern: /(?:\+7|(?<!\d)8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/u, reason: 'Phone number on the picture: marketplaces do not allow contact details'},
  {id: 'contact-link', pattern: /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\d])[\p{L}\d-]+\.(?:ru|рф|com|net|org|su|shop|store|online)(?![\p{L}\d])/iu, reason: 'Link on the picture: marketplaces do not allow contact details'},
  {id: 'contact-email', pattern: /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.\p{L}{2,}/u, reason: 'E-mail on the picture: marketplaces do not allow contact details'},
  {id: 'contact-handle', pattern: /(?<![\p{L}\d])@[a-z0-9_]{3,}/iu, reason: 'Social media handle on the picture: marketplaces do not allow contact details'},
  {id: 'contact-messenger', pattern: word('(?:whatsapp|ватсап|вотсап|телеграм|telegram|вайбер|viber|инстаграм|instagram)'), reason: 'Messenger on the picture: marketplaces do not allow contact details'},
];

/** WB: marketing words. WB grades the main photo on "marketing words" since 21 Sep 2026. The patterns below stay Russian on purpose:
 *  they match the Russian text a seller puts on a card for the Russian marketplaces (Wildberries, Ozon, Yandex Market). */
const WB_SALES_WORDS: readonly BannedWordRule[] = [
  {id: 'wb-discount', pattern: word('скидк'), reason: 'WB lowers the photo score for words about discounts'},
  {id: 'wb-sale', pattern: word('распродаж'), reason: 'WB lowers the photo score for the word "sale"'},
  {id: 'wb-liquidation', pattern: word('ликвидац'), reason: 'WB lowers the photo score for the word "liquidation"'},
  {id: 'wb-promo', pattern: word('акци(?:я|и|ю|ей|онн)'), reason: 'WB lowers the photo score for words about promotions'},
  {id: 'wb-cheap', pattern: word('(?:дешев|дёшев|дешёв)'), reason: 'WB lowers the photo score for the word "cheap"'},
  {id: 'wb-best-price', pattern: phrase('лучш(?:ая|ую|ей) цен'), reason: 'WB lowers the photo score for price promises'},
  {id: 'wb-low-price', pattern: phrase('(?:низк|супер|мега)\\p{L}* цен'), reason: 'WB lowers the photo score for price promises'},
  {id: 'wb-hit', pattern: phrase('хит продаж'), reason: 'WB lowers the photo score for "bestseller" claims'},
  {id: 'wb-bestseller', pattern: word('(?:бестселлер|лидер продаж)'), reason: 'WB lowers the photo score for "bestseller"'},
  {id: 'wb-free', pattern: word('бесплатн'), reason: 'WB lowers the photo score for the word "free"'},
  {id: 'wb-sale-en', pattern: /(?<![\p{L}\d])(?:sale|discount)(?![\p{L}\d])/iu, reason: 'WB lowers the photo score for the word "sale"'},
  {id: 'wb-percent', pattern: /[-−–]\s?\d{1,2}\s?%/u, reason: 'Discount percentage on the photo: WB lowers the score'},
];

/** Ozon: no prices, contacts, calls to action or delivery details on the image. */
const OZON_WORDS: readonly BannedWordRule[] = [
  {id: 'ozon-price', pattern: /\d[\d\s]*(?:₽|руб(?:\.|л\p{L}*)?(?![\p{L}])|р\.)/iu, reason: 'Price on the picture: Ozon does not allow prices'},
  {id: 'ozon-cta', pattern: word('(?:купи|закаж|заказыва|звони|позвони|пиши|напиши|успей|спеши|переходи|жми|добавь в корзин)'), reason: 'Call to action: Ozon does not allow "buy", "order", "hurry"'},
  {id: 'ozon-delivery', pattern: word('(?:доставк|доставим|доставля|самовывоз|курьер)'), reason: 'Delivery terms on the picture: Ozon does not allow them'},
  {id: 'ozon-discount', pattern: word('(?:скидк|распродаж)'), reason: 'Ozon does not allow words about discounts and prices'},
];

/** Yandex Market: no claims of being an analogue or the original. */
const YM_WORDS: readonly BannedWordRule[] = [
  {id: 'ym-analog', pattern: word('аналог'), reason: 'Yandex Market does not allow "analog"'},
  {id: 'ym-original', pattern: word('оригинал'), reason: 'Yandex Market does not allow "original"'},
  {id: 'ym-replica', pattern: word('(?:реплик|копи[яию]|люкс-копи)'), reason: 'Yandex Market does not allow "copy" and "replica"'},
];

const zone = (id: string, label: string, x: number, y: number, width: number, height: number): SafeZone => ({id, label, x, y, width, height});

export const MARKETPLACE_SPECS: Readonly<Record<Marketplace, MarketplaceSpec>> = {
  wb: {
    id: 'wb',
    name: 'Wildberries',
    short: 'WB',
    frame: {width: 900, height: 1200},
    formats: ['jpg', 'png', 'webp'],
    minSize: {width: 700, height: 900},
    maxSize: null,
    aspect: {width: 3, height: 4, strict: false},
    maxFileBytes: 10 * MB,
    maxImages: 30,
    minImagesForSearch: 2,
    minJpegQuality: 65,
    logo: 'forbidden',
    textContrast: {normal: 4.5, large: 3},
    productMinFill: null,
    realProductOnly: false,
    proofText: true,
    bannedWords: [...WB_SALES_WORDS, ...CONTACT_RULES],
    safeZones: [
      zone('badges', 'Promo and "New" badges', 0, 0, 0.46, 0.11),
      zone('favourite', 'Favorites', 0.83, 0, 0.17, 0.11),
      zone('price', 'Discount and rating', 0, 0.9, 0.42, 0.1),
    ],
    altFrames: [],
  },
  ozon: {
    id: 'ozon',
    name: 'Ozon',
    short: 'Ozon',
    frame: {width: 900, height: 1200},
    formats: ['jpg', 'png', 'heic', 'webp'],
    minSize: {width: 200, height: 200},
    maxSize: {width: 7680, height: 7680},
    aspect: {width: 3, height: 4, strict: true},
    maxFileBytes: 10 * MB,
    maxImages: 30,
    minImagesForSearch: null,
    minJpegQuality: null,
    logo: 'watermark',
    textContrast: null,
    productMinFill: null,
    realProductOnly: true,
    proofText: false,
    bannedWords: [...OZON_WORDS, ...CONTACT_RULES],
    safeZones: [
      zone('badges', '"Sale" and "Original" badges', 0, 0, 0.5, 0.1),
      zone('favourite', 'Favorites', 0.84, 0, 0.16, 0.1),
      zone('price', 'Discount and video', 0, 0.91, 0.38, 0.09),
    ],
    altFrames: [{id: 'ozon-fresh', name: 'Ozon fresh 1:1', width: 1200, height: 1200}],
  },
  ym: {
    id: 'ym',
    name: 'Yandex Market',
    short: 'YM',
    frame: {width: 900, height: 1200},
    formats: ['jpg', 'png', 'heic', 'webp'],
    minSize: {width: 300, height: 300},
    maxSize: null,
    aspect: {width: 3, height: 4, strict: false},
    maxFileBytes: 10 * MB,
    maxImages: 30,
    minImagesForSearch: null,
    minJpegQuality: null,
    logo: 'brand-only',
    textContrast: null,
    productMinFill: 2 / 3,
    realProductOnly: true,
    proofText: false,
    bannedWords: [...YM_WORDS, ...CONTACT_RULES],
    safeZones: [
      zone('badges', '"Super price" and "Hit" badges', 0, 0, 0.44, 0.1),
      zone('favourite', 'Favorites and compare', 0.8, 0, 0.2, 0.1),
    ],
    altFrames: [],
  },
};

export const marketplaceSpec = (id: Marketplace): MarketplaceSpec => MARKETPLACE_SPECS[id];
export const isMarketplace = (value: unknown): value is Marketplace => value === 'wb' || value === 'ozon' || value === 'ym';

/** The six slides every card needs, in the order a buyer swipes them. */
export type CardSlideKind = 'main' | 'benefits' | 'specs' | 'howto' | 'proof' | 'lifestyle';
export const CARD_SLIDE_KINDS: readonly CardSlideKind[] = ['main', 'benefits', 'specs', 'howto', 'proof', 'lifestyle'];
export const CARD_SLIDE_LABELS: Readonly<Record<CardSlideKind, string>> = {
  main: 'Main photo',
  benefits: 'Benefits',
  specs: 'Specs and sizes',
  howto: 'How to use',
  proof: 'Reviews and trust',
  lifestyle: 'In real life',
};

/** WB personalized covers (10 Sep 2026): one main image for new buyers, another for returning ones. */
export type CoverAudience = 'new' | 'returning';
export const COVER_AUDIENCE_LABELS: Readonly<Record<CoverAudience, string>> = {new: 'New buyers', returning: 'Returning buyers'};

/** Covers under this click-through rate are flagged as low: the benchmark sellers use for WB. */
export const LOW_CTR = 0.02;
/** CTR at which a cover earns the CTR half of Card Score in full. */
export const STRONG_CTR = 0.05;
