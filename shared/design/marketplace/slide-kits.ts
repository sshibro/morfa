// Slide kits (docs/marketplaces.md §Card Canvas): auto-layout templates for the six slides every card needs, built as ordinary
// layers so swapping a text never breaks the slide. Each slide is a frame of the marketplace's card size laid out top to bottom, with
// paddings that keep its content out of the marketplace's own badges; texts fill the width and grow in height, so a longer Russian
// text wraps and the product photo above gives way to it. Colours and fonts come from the brand kit when one is given, otherwise a quiet
// neutral palette in Inter. Owned by the Card Canvas module (export, kits and proofing).

import {createNode, defaultAutoLayout, defaultTextProps, defaultTextStyle, newId, solid} from '../defaults';
import {fontFamilies, type FontFamily} from '../../fonts';
import type {AutoLayout, NodeId, NodeType, RGB, SceneNode, TextProps} from '../types';
import type {BrandKit} from './brand-kit';
import {withCardMeta, withLayerRole, type LayerRole} from './meta';
import {CARD_SLIDE_KINDS, CARD_SLIDE_LABELS, marketplaceSpec, type CardSlideKind, type Marketplace, type MarketplaceSpec} from './specs';

export type SlideKitOptions = {
  marketplace: Marketplace;
  slides: readonly CardSlideKind[];
  /** Top-left of the first slide on the page; the others follow to the right. */
  origin: {x: number; y: number};
  /** Card meta `group` shared by the set. */
  group: string;
  brand?: BrandKit | null;
};

/** Nodes to create, parents before children, in order; `parentId: null` marks a slide frame, which goes on the page. */
export type SlideKitBuild = {nodes: SceneNode[]; frameIds: NodeId[]};

/** Space between two slides of a set on the page. */
export const SLIDE_GAP = 120;
/** The font of a kit without a brand kit (or with a font Morfa does not have): it carries Cyrillic and ships with the app. */
export const SLIDE_KIT_FONT = 'Inter';

// ── Palette and type ────────────────────────────────────────────────────────────────────────────

type Palette = {background: RGB; surface: RGB; headline: RGB; text: RGB; muted: RGB; accent: RGB; onAccent: RGB; placeholder: RGB; divider: RGB; star: RGB};

const hex = (value: string): RGB | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
};
const mix = (a: RGB, b: RGB, t: number): RGB => ({r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t});
const luminance = ({r, g, b}: RGB) => {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const WHITE: RGB = {r: 1, g: 1, b: 1};
const INK: RGB = hex('#171717')!;

/** Warm greys and ink: no colour of its own, so a seller's product sets the tone. */
const NEUTRAL: Palette = {
  background: hex('#F2F1EE')!,
  surface: WHITE,
  headline: INK,
  text: INK,
  muted: hex('#5E5E66')!,
  accent: INK,
  onAccent: WHITE,
  placeholder: hex('#DEDCD7')!,
  divider: hex('#E2E0DB')!,
  star: hex('#E39B2D')!,
};

function paletteOf(brand: BrandKit | null | undefined): Palette {
  if (!brand) return NEUTRAL;
  const c = brand.colors;
  const background = hex(c.background) ?? NEUTRAL.background;
  const text = hex(c.text) ?? NEUTRAL.text;
  const accent = hex(c.accent) ?? NEUTRAL.accent;
  return {
    background,
    surface: WHITE,
    headline: hex(c.primary) ?? text,
    text,
    muted: hex(c.secondary) ?? NEUTRAL.muted,
    accent,
    // Text on the accent: white or ink, whichever reads better.
    onAccent: contrast(accent, WHITE) >= contrast(accent, INK) ? WHITE : INK,
    placeholder: mix(background, text, 0.1),
    divider: mix(WHITE, text, 0.12),
    star: accent,
  };
}

const LIBRARY = Object.values(fontFamilies) as FontFamily[];
/** A family from Morfa's font library by name (any case), or Inter. */
function familyOf(name: string | undefined): FontFamily {
  const wanted = name?.trim().toLowerCase();
  return (wanted && LIBRARY.find(font => font.family.toLowerCase() === wanted)) || LIBRARY.find(font => font.family === SLIDE_KIT_FONT)!;
}
/** The weight the family has nearest to `wanted`: inside a variable face's range, or the closest of its static weights. */
export function nearestWeight(font: Pick<FontFamily, 'variable' | 'weights'>, wanted: number): number {
  if (!font.weights.length) return wanted;
  if (font.variable) return Math.min(Math.max(wanted, Math.min(...font.weights)), Math.max(...font.weights));
  return font.weights.reduce((best, weight) => (Math.abs(weight - wanted) < Math.abs(best - wanted) ? weight : best), font.weights[0]);
}

type Type = {size: number; weight: number; heading?: boolean; line?: number};
const TYPE = {
  headline: {size: 64, weight: 700, heading: true, line: 110},
  title: {size: 30, weight: 600, heading: true, line: 120},
  body: {size: 28, weight: 400, line: 130},
  small: {size: 24, weight: 400, line: 130},
  badge: {size: 26, weight: 600, heading: true, line: 120},
  number: {size: 28, weight: 700, heading: true, line: 100},
  rating: {size: 96, weight: 700, heading: true, line: 100},
  caption: {size: 40, weight: 700, heading: true, line: 115},
} as const satisfies Record<string, Type>;

// ── Safe area ───────────────────────────────────────────────────────────────────────────────────

/** The slide's paddings: clear of the marketplace's badges at the top and bottom edges, with room to breathe. */
export function slidePadding(spec: Pick<MarketplaceSpec, 'frame' | 'safeZones'>): {top: number; right: number; bottom: number; left: number} {
  const {height} = spec.frame;
  let top = 0;
  let bottom = 0;
  for (const zone of spec.safeZones) {
    if (zone.y <= 0.001) top = Math.max(top, (zone.y + zone.height) * height);
    if (zone.y + zone.height >= 0.999) bottom = Math.max(bottom, zone.height * height);
  }
  const edge = 64;
  return {top: Math.ceil(Math.max(edge, top + 24)), right: edge, bottom: Math.ceil(Math.max(edge, bottom + 24)), left: edge};
}

// ── Building ────────────────────────────────────────────────────────────────────────────────────

type Props = Partial<SceneNode> & {name: string};

class Builder {
  readonly nodes: SceneNode[] = [];
  constructor(
    readonly palette: Palette,
    private readonly heading: FontFamily,
    private readonly body: FontFamily,
    readonly width: number,
  ) {}

  add(type: NodeType, parent: NodeId | null, props: Props, role?: LayerRole): SceneNode {
    const node = createNode(type, {...props, id: newId(), parentId: parent});
    if (role) node.pluginData = withLayerRole(node.pluginData, role);
    this.nodes.push(node);
    return node;
  }

  /** An auto-layout frame without a fill of its own unless asked. */
  stack(parent: NodeId, name: string, layout: Partial<AutoLayout> & Pick<AutoLayout, 'layoutMode'>, props: Partial<SceneNode> = {}, role?: LayerRole): SceneNode {
    return this.add('FRAME', parent, {
      name,
      fills: [],
      clipsContent: false,
      autoLayout: {...defaultAutoLayout(layout.layoutMode), ...layout},
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      width: this.width,
      height: 10,
      ...props,
    }, role);
  }

  /** A text that fills its row and grows in height (`wrap`), or one that hugs its words. */
  text(parent: NodeId, name: string, characters: string, type: Type, color: RGB, options: {role?: LayerRole; wrap?: boolean; align?: TextProps['textAlignHorizontal']} = {}): SceneNode {
    const font = type.heading ? this.heading : this.body;
    const wrap = options.wrap ?? true;
    const text: TextProps = {
      ...defaultTextProps(characters),
      style: {...defaultTextStyle(), fontFamily: font.family, fontWeight: nearestWeight(font, type.weight), fontSize: type.size, lineHeight: {unit: 'PERCENT', value: type.line ?? 120}},
      textAutoResize: wrap ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
      textAlignHorizontal: options.align ?? 'LEFT',
    };
    return this.add('TEXT', parent, {
      name,
      fills: [solid(color)],
      text,
      width: wrap ? this.width : Math.ceil(characters.length * type.size * 0.6),
      height: Math.ceil(type.size * ((type.line ?? 120) / 100)),
      layoutSizingHorizontal: wrap ? 'FILL' : 'HUG',
      layoutSizingVertical: 'HUG',
    }, options.role);
  }

  /** The product photo's place: a neutral block named for what goes in it, which takes the room the texts leave. */
  photo(parent: NodeId, name = 'Product photo', props: Partial<SceneNode> = {}): SceneNode {
    return this.add('RECTANGLE', parent, {
      name,
      fills: [solid(this.palette.placeholder)],
      cornerRadius: 24,
      width: this.width,
      height: 400,
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'FILL',
      ...props,
    }, 'product');
  }

  /** A round icon with a check mark. */
  check(parent: NodeId) {
    const circle = this.add('FRAME', parent, {
      name: 'Icon', width: 56, height: 56, cornerRadius: 28, fills: [solid(this.palette.accent)],
      autoLayout: {...defaultAutoLayout('HORIZONTAL'), primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER'},
    });
    this.add('VECTOR', circle.id, {
      name: 'Checkmark', width: 24, height: 24, fills: [], strokes: [solid(this.palette.onAccent)], strokeWeight: 3, strokeCap: 'ROUND', strokeJoin: 'ROUND',
      vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 4, y: 12.5}, {type: 'L', x: 9.5, y: 18}, {type: 'L', x: 20, y: 6.5}]}],
    });
  }

  stars(parent: NodeId, size: number) {
    const row = this.stack(parent, 'Stars', {layoutMode: 'HORIZONTAL', itemSpacing: Math.round(size / 5), counterAxisAlignItems: 'CENTER'}, {layoutSizingHorizontal: 'HUG', width: size * 6});
    for (let i = 0; i < 5; i++) this.add('STAR', row.id, {name: 'Star', width: size, height: size, fills: [solid(this.palette.star)], pointCount: 5, innerRadius: 0.45});
  }
}

type Slide = (b: Builder, frame: SceneNode) => void;

/** A headline (role Headline) that wraps over the full width. */
const headline = (b: Builder, frame: SceneNode, characters: string) => b.text(frame.id, 'Headline', characters, TYPE.headline, b.palette.headline, {role: 'headline'});

const SLIDES: Record<CardSlideKind, Slide> = {
  main(b, frame) {
    headline(b, frame, 'Product name in one or two lines');
    b.photo(frame.id);
    const badges = b.stack(frame.id, 'Badges', {layoutMode: 'HORIZONTAL', layoutWrap: 'WRAP', itemSpacing: 12, counterAxisSpacing: 12});
    for (const words of ['Natural material', 'Sizes 42–56', '1 year warranty']) {
      const badge = b.stack(badges.id, 'Badge', {layoutMode: 'HORIZONTAL', paddingTop: 14, paddingBottom: 14, paddingLeft: 22, paddingRight: 22}, {
        layoutSizingHorizontal: 'HUG', width: 200, height: 56, cornerRadius: 16, fills: [solid(b.palette.accent)],
      }, 'badge');
      b.text(badge.id, words, words, TYPE.badge, b.palette.onAccent, {wrap: false});
    }
  },
  benefits(b, frame) {
    headline(b, frame, 'The main points');
    b.photo(frame.id);
    const list = b.stack(frame.id, 'Benefits', {layoutMode: 'VERTICAL', itemSpacing: 28});
    const items: [string, string][] = [
      ['Reliable materials', 'Long-lasting and neat-looking'],
      ['Thoughtful details', 'Everything in its place, nothing extra'],
      ['Easy care', 'Just wipe with a damp cloth'],
    ];
    for (const [title, line] of items) {
      const row = b.stack(list.id, 'Benefit', {layoutMode: 'HORIZONTAL', itemSpacing: 24, counterAxisAlignItems: 'MIN'});
      b.check(row.id);
      const words = b.stack(row.id, 'Text', {layoutMode: 'VERTICAL', itemSpacing: 6});
      b.text(words.id, 'Benefit', title, TYPE.title, b.palette.text, {role: 'benefit'});
      b.text(words.id, 'Description', line, TYPE.small, b.palette.muted);
    }
  },
  specs(b, frame) {
    headline(b, frame, 'Specifications');
    b.photo(frame.id);
    const table = b.stack(frame.id, 'Table', {layoutMode: 'VERTICAL', paddingTop: 8, paddingBottom: 8, paddingLeft: 32, paddingRight: 32}, {fills: [solid(b.palette.surface)], cornerRadius: 24});
    const rows: [string, string][] = [
      ['Material', 'Cotton 100%'],
      ['Size', '40 × 30 × 12 cm'],
      ['Weight', '450 g'],
      ['Colour', 'Graphite'],
      ['Country of origin', 'Germany'],
    ];
    rows.forEach(([label, value], index) => {
      const row = b.stack(table.id, 'Row', {layoutMode: 'HORIZONTAL', itemSpacing: 24, paddingTop: 20, paddingBottom: 20, counterAxisAlignItems: 'CENTER'}, index < rows.length - 1
        ? {strokes: [solid(b.palette.divider)], strokeWeight: 1, strokeAlign: 'INSIDE', individualStrokeWeights: {top: 0, right: 0, bottom: 1, left: 0}}
        : {});
      b.text(row.id, 'Parameter', label, TYPE.body, b.palette.muted);
      b.text(row.id, 'Value', value, {...TYPE.body, weight: 600}, b.palette.text, {align: 'RIGHT'});
    });
  },
  howto(b, frame) {
    headline(b, frame, 'How to use');
    b.photo(frame.id);
    const steps = b.stack(frame.id, 'Steps', {layoutMode: 'VERTICAL', itemSpacing: 24});
    ['Take the item out of the packaging', 'Unfold it and leave it for an hour', 'Done: ready to use'].forEach((words, index) => {
      const row = b.stack(steps.id, `Step ${index + 1}`, {layoutMode: 'HORIZONTAL', itemSpacing: 24, counterAxisAlignItems: 'CENTER'});
      const number = b.add('FRAME', row.id, {
        name: 'Number', width: 64, height: 64, cornerRadius: 32, fills: [solid(b.palette.accent)],
        autoLayout: {...defaultAutoLayout('HORIZONTAL'), primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER'},
      });
      b.text(number.id, 'Digit', String(index + 1), TYPE.number, b.palette.onAccent, {wrap: false, align: 'CENTER'});
      b.text(row.id, 'Step', words, TYPE.body, b.palette.text);
    });
  },
  proof(b, frame) {
    headline(b, frame, 'What buyers say');
    b.photo(frame.id);
    const rating = b.stack(frame.id, 'Rating', {layoutMode: 'HORIZONTAL', itemSpacing: 24, counterAxisAlignItems: 'CENTER'});
    b.text(rating.id, 'Average rating', '4.9', TYPE.rating, b.palette.headline, {wrap: false});
    const side = b.stack(rating.id, 'Caption', {layoutMode: 'VERTICAL', itemSpacing: 8});
    b.stars(side.id, 32);
    b.text(side.id, 'Description', 'Average buyer rating', TYPE.small, b.palette.muted);
    const quotes: [string, string][] = [
      ['Excellent quality, just like in the photo. I use it every day.', 'Anna'],
      ['Arrived fast, neatly packed. Recommended.', 'Mark'],
    ];
    for (const [quote, author] of quotes) {
      const card = b.stack(frame.id, 'Review', {layoutMode: 'VERTICAL', itemSpacing: 12, paddingTop: 28, paddingBottom: 28, paddingLeft: 32, paddingRight: 32}, {fills: [solid(b.palette.surface)], cornerRadius: 24});
      b.stars(card.id, 20);
      b.text(card.id, 'Review text', quote, TYPE.body, b.palette.text);
      b.text(card.id, 'Author', author, {...TYPE.small, weight: 600}, b.palette.muted);
    }
  },
  lifestyle(b, frame) {
    // The photo fills the whole slide behind the caption, out of the flow.
    b.photo(frame.id, 'Lifestyle photo', {
      cornerRadius: 0, x: 0, y: 0, width: frame.width, height: frame.height,
      layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    });
    const caption = b.stack(frame.id, 'Caption', {layoutMode: 'VERTICAL', itemSpacing: 8, paddingTop: 28, paddingBottom: 28, paddingLeft: 32, paddingRight: 32}, {
      fills: [solid(b.palette.surface, 0.94)], cornerRadius: 24,
    });
    b.text(caption.id, 'Headline', 'Made for every day', TYPE.caption, b.palette.headline, {role: 'headline'});
    b.text(caption.id, 'Description', 'Say where and how to use the product', TYPE.small, b.palette.muted);
  },
};

/**
 * The slides asked for, in the order a buyer swipes them, each a frame of the marketplace's card size carrying card meta
 * {marketplace, slide, group}, placed left to right from `origin`. Nothing is inserted: the caller creates the nodes in one transaction
 * (frames on the page, `parentId: null`), and the commit lays them out.
 */
export function buildSlideKit(options: SlideKitOptions): SlideKitBuild {
  const spec = marketplaceSpec(options.marketplace);
  const padding = slidePadding(spec);
  const palette = paletteOf(options.brand);
  const heading = familyOf(options.brand?.fonts.heading);
  const body = familyOf(options.brand?.fonts.body);
  const builder = new Builder(palette, heading, body, spec.frame.width - padding.left - padding.right);
  const frameIds: NodeId[] = [];
  const kinds = CARD_SLIDE_KINDS.filter(kind => options.slides.includes(kind));
  kinds.forEach((kind, index) => {
    const frame = builder.add('FRAME', null, {
      name: CARD_SLIDE_LABELS[kind],
      x: options.origin.x + index * (spec.frame.width + SLIDE_GAP),
      y: options.origin.y,
      width: spec.frame.width,
      height: spec.frame.height,
      fills: [solid(palette.background)],
      clipsContent: true,
      autoLayout: {
        ...defaultAutoLayout('VERTICAL'),
        itemSpacing: 32,
        paddingTop: padding.top,
        paddingRight: padding.right,
        paddingBottom: padding.bottom,
        paddingLeft: padding.left,
        primaryAxisAlignItems: kind === 'lifestyle' ? 'MAX' : 'MIN',
      },
      pluginData: withCardMeta(undefined, {v: 1, marketplace: options.marketplace, slide: kind, group: options.group}),
    });
    frameIds.push(frame.id);
    SLIDES[kind](builder, frame);
  });
  return {nodes: builder.nodes, frameIds};
}
