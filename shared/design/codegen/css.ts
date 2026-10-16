import type {DesignDocument, ImagePaint, ImageRef, NodeId, Paint, SceneNode, ShadowEffect, TextStyle} from '../types';
import {apply, localMatrix, type Rect} from '../geometry';
import {isAutoLayout} from '../constraints';
import {effectiveSizing, textSizing} from '../layout';
import {DEFAULT_GRID, placeGridChildren, trackOf} from '../layout-grid';
import {cornerRadiiOf} from '../shapes';
import {hasVariableWidth} from '../stroke-profile';
import {formatValue, type CodeFormat} from './format';
import {collectTokens, EMPTY_TOKENS, suggestTokens, type TokenTable} from './tokens';
import {BLEND_CSS, blurCss, color, fontFamilyCss, gradientCss, guessFallback, isVisiblePaint, letterSpacingCss, lineHeightCss, num, px, shadowCss} from './values';
import {slugName} from './names';

// CSS of one layer, as a developer inspects it (docs/design-tool.md §Design to code): auto layout as
// flexbox, the place in the parent from its constraints, sizing (fixed, hug, fill) as widths and
// flex items, fills, corners, strokes by alignment, effects, opacity, blending, clipping and
// typography. Values bound to a style or a variable reference its token (`var(--…)`). The React
// emitters build on the same declarations, so the "Code" tab and an exported project always agree.

export type CssGroup = 'layout' | 'position' | 'size' | 'item' | 'visual' | 'text';
/** `reset`: the browser's own look taken away (a paragraph's margin, a button's border); Tailwind's preflight already does it. */
export type Decl = {prop: string; value: string; group: CssGroup; reset?: true};

/** How the element shows the layer's own paint: CSS (div), an <svg> with the paint inside, an <img>. */
export type PaintMode = 'css' | 'svg' | 'img';

export type DeclContext = {
  doc: DesignDocument;
  tokens: TokenTable;
  /** A fallback stack for a font family ("sans-serif"). */
  fallback: (family: string) => string;
  /** What goes inside `url(…)` for a picture. */
  asset: (ref: ImageRef) => string;
  /** The element is the root of the output: it is not placed in a parent. */
  root: boolean;
  paint?: PaintMode;
  /** The box to place instead of the layer's (a turned vector is placed by its painted bounds). */
  box?: Rect;
};

export type CssOptions = {
  /** Reference tokens for styles and variables (default true). */
  tokens?: boolean | TokenTable;
  /** A raw colour equal to a colour token's value is written as the token (default true; needs tokens). */
  suggest?: boolean;
  /** Units and colour format of the values. */
  format?: CodeFormat;
  fontFallback?: (family: string) => string | undefined;
  /** What goes inside `url(…)` for a picture (default `assets/<name>.<ext>`). */
  assetUrl?: (ref: ImageRef) => string;
};

const GROUP_ORDER: CssGroup[] = ['layout', 'position', 'size', 'item', 'visual', 'text'];
const GROUP_TITLES: Partial<Record<CssGroup, string>> = {layout: 'Auto layout', item: 'Inside auto layout', text: 'Text'};

/** Layers drawn as vector shapes: in code they are SVG. */
export const VECTOR_TYPES = new Set(['VECTOR', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION']);

/** True when CSS boxes cannot draw the layer (paths, arcs, rings, arrowheads). */
export function needsSvg(node: SceneNode): boolean {
  if (VECTOR_TYPES.has(node.type)) return true;
  // Text on a path and a stroke whose width changes along it have no CSS form.
  if (node.type === 'TEXT' && node.textPath) return true;
  if (node.type === 'LINE' && hasVariableWidth(node)) return true;
  if (node.type === 'ELLIPSE') {
    const arc = node.arcData;
    if (!arc) return false;
    const sweep = Math.abs(arc.endingAngle - arc.startingAngle);
    return arc.innerRadius > 0 || (sweep < 2 * Math.PI - 1e-6 && sweep > 1e-9);
  }
  if (node.type === 'LINE') return (node.strokeStartMarker ?? 'NONE') !== 'NONE' || (node.strokeEndMarker ?? 'NONE') !== 'NONE' || node.strokes.filter(isVisiblePaint).some(p => p.type !== 'SOLID');
  return false;
}

const isFrameLike = (node: SceneNode) => node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE';

/** The default name of a picture file: the asset's name or the ref, with the extension of its URL. */
export function defaultAssetPath(doc: DesignDocument, ref: ImageRef): string {
  const asset = doc.images[ref];
  const ext = (asset?.url.match(/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
  const base = slugName((asset?.name ?? '').replace(/\.[a-z0-9]+$/i, ''), '') || slugName(ref, 'image');
  return `assets/${base}.${ext}`;
}

export function declarationContext(doc: DesignDocument, options: CssOptions = {}, root = false): DeclContext {
  const table = options.tokens === false ? EMPTY_TOKENS : options.tokens && options.tokens !== true ? options.tokens : collectTokens(doc, {fontFallback: options.fontFallback});
  const tokens = options.suggest === false || options.tokens === false ? table : suggestTokens(table);
  return {
    doc,
    tokens,
    fallback: family => options.fontFallback?.(family) ?? guessFallback(family),
    asset: options.assetUrl ?? (ref => defaultAssetPath(doc, ref)),
    root,
  };
}

/** The declarations of one layer, in Figma's dev-mode order. A layer on a page is a root (no position). */
export function nodeToCss(doc: DesignDocument, id: NodeId, options: CssOptions = {}): Decl[] {
  const node = doc.nodes[id];
  if (!node || node.type === 'PAGE') return [];
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  const ctx = declarationContext(doc, options, !parent || parent.type === 'PAGE');
  return declarations(node, {...ctx, paint: needsSvg(node) ? 'svg' : 'css'});
}

/** Declarations as a stylesheet body: groups apart, Figma's group titles as comments. */
export function formatDeclarations(decls: readonly Decl[], options: {indent?: string; titles?: boolean; format?: CodeFormat} = {}): string {
  const indent = options.indent ?? '';
  const blocks: string[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = decls.filter(decl => decl.group === group);
    if (!inGroup.length) continue;
    const title = options.titles !== false ? GROUP_TITLES[group] : undefined;
    blocks.push([...(title ? [`${indent}/* ${title} */`] : []), ...inGroup.map(decl => `${indent}${decl.prop}: ${formatValue(decl.prop, decl.value, options.format)};`)].join('\n'));
  }
  return blocks.join('\n\n');
}

const commentText = (text: string) => text.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();

/** "Copy as CSS": every selected layer under its name. */
export function cssForLayers(doc: DesignDocument, ids: readonly NodeId[], options: CssOptions = {}): string {
  const parts: string[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node || node.type === 'PAGE') continue;
    const decls = nodeToCss(doc, id, options);
    const note = node.textPath
      ? '\n/* Text on a path: CSS has no such thing; in code it is an SVG with text ("Copy as SVG"). */'
      : needsSvg(node) ? '\n/* Vector shape: in code it is an SVG ("Copy as SVG"). */' : '';
    parts.push(`/* ${commentText(node.name)} */${note}\n${formatDeclarations(decls, {format: options.format})}`.trimEnd());
  }
  return parts.join('\n\n') + (parts.length ? '\n' : '');
}

// ── Declarations ───────────────────────────────────────────────────────────────────────────────

/** Four sides (top, right, bottom, left) as CSS's shortest shorthand: `10px 16px`. */
export function sides(values: readonly string[]): string {
  const [t, r, b, l] = values;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

const tokenVar = (ctx: DeclContext, node: SceneNode, field: string): string | null => {
  const alias = node.boundVariables?.[field];
  const token = alias ? ctx.tokens.byVariable.get(alias.id) : undefined;
  return token?.name ? `var(--${token.name})` : null;
};

/** The box as CSS places it: CSS turns about the centre, the model about the top-left corner. */
export function cssBox(node: SceneNode): Rect {
  if (!node.rotation && !node.flipX && !node.flipY) return {x: node.x, y: node.y, width: node.width, height: node.height};
  const centre = apply(localMatrix(node), {x: node.width / 2, y: node.height / 2});
  return {x: centre.x - node.width / 2, y: centre.y - node.height / 2, width: node.width, height: node.height};
}

export const turned = (node: SceneNode) => {
  const r = ((node.rotation % 360) + 360) % 360;
  return r > 0.01 && r < 359.99;
};

function centreOffset(start: number, size: number, parentSize: number): string {
  const k = start + size / 2 - parentSize / 2 - size / 2;
  if (Math.abs(k) < 0.005) return '50%';
  return k < 0 ? `calc(50% - ${px(-k)})` : `calc(50% + ${px(k)})`;
}

const percent = (value: number, of: number) => `${num(of ? (value / of) * 100 : 0)}%`;

/** What a colour paints: a token is suggested by the use its name says it is for. */
export type ColorUse = 'text' | 'fill' | 'stroke';

const USE_WORDS: Record<ColorUse, RegExp> = {
  text: /(^|-)(text|on|foreground|fg|content|ink|label|icon|title)(-|$)/,
  fill: /(^|-)(background|bg|surface|fill|card|canvas|layer|container|backdrop)(-|$)/,
  stroke: /(^|-)(border|stroke|outline|divider|line|separator|ring)(-|$)/,
};

/** A raw colour as the token with that value, when one fits (Figma's suggested variables): the only token of the value, else
 *  one named for this use (text, fill, stroke), else a palette step named for no use (`neutral-0`). Several tokens of other
 *  uses (white is both "background" and "text on accent") and none of this one: the raw value stays. */
export function suggestedColor(ctx: Pick<DeclContext, 'tokens'>, raw: string, use: ColorUse): string {
  const tokens = ctx.tokens.suggested?.get(raw);
  if (!tokens?.length) return raw;
  const words = (token: {name: string}) => token.name.replace(/^color-/, '');
  if (tokens.length === 1) return `var(--${tokens[0].name})`;
  const fitting = tokens.find(token => USE_WORDS[use].test(words(token)));
  if (fitting) return `var(--${fitting.name})`;
  const palette = tokens.find(token => !Object.values(USE_WORDS).some(pattern => pattern.test(words(token))));
  return palette ? `var(--${palette.name})` : raw;
}

function solidCss(ctx: DeclContext, paint: Paint, use: ColorUse): string | null {
  if (paint.type !== 'SOLID') return null;
  const alias = paint.boundVariables?.color;
  const token = alias ? ctx.tokens.byVariable.get(alias.id) : undefined;
  if (token?.name) return `var(--${token.name})`;
  return suggestedColor(ctx, color(paint.color, paint.opacity), use);
}

function imageLayer(ctx: DeclContext, paint: ImagePaint): string | null {
  if (!paint.imageRef) return null;
  const url = `url(${ctx.asset(paint.imageRef)})`;
  switch (paint.scaleMode) {
    case 'FIT': return `${url} center / contain no-repeat`;
    case 'TILE': {
      const natural = ctx.doc.images[paint.imageRef];
      const factor = paint.scalingFactor ?? 1;
      return natural ? `${url} left top / ${px(natural.width * factor)} ${px(natural.height * factor)} repeat` : `${url} left top repeat`;
    }
    case 'CROP': {
      const m = paint.imageTransform;
      if (!m || m[0][1] || m[1][0]) return `${url} center / cover no-repeat`;
      const [a, e] = [m[0][0], m[0][2]], [d, f] = [m[1][1], m[1][2]];
      const position = (offset: number, scale: number) => (Math.abs(1 - scale) < 1e-6 ? '0%' : `${num((offset / (1 - scale)) * 100)}%`);
      return `${url} ${position(e, a)} ${position(f, d)} / ${num(100 / (a || 1))}% ${num(100 / (d || 1))}% no-repeat`;
    }
    default: return `${url} center / cover no-repeat`;
  }
}

/** `background` for fills: one colour, or layers top-first (a solid colour among layers is a flat gradient). */
export function backgroundCss(ctx: DeclContext, node: SceneNode, fills: readonly Paint[] = node.fills, styleId = node.fillStyleId, use: ColorUse = 'fill'): string | null {
  const visible = fills.filter(isVisiblePaint);
  if (!visible.length) return null;
  const style = styleId ? ctx.tokens.byStyle.get(styleId) : undefined;
  if (style && (style.kind === 'color' || style.kind === 'gradient' || style.kind === 'fill') && !visible.some(p => p.type === 'IMAGE')) return `var(--${style.name})`;
  if (visible.length === 1 && visible[0].type === 'SOLID') return solidCss(ctx, visible[0], use);
  const layers = [...visible].reverse().map(paint => {
    if (paint.type === 'SOLID') {
      const c = solidCss(ctx, paint, use)!;
      return `linear-gradient(${c}, ${c})`;
    }
    if (paint.type === 'IMAGE') return imageLayer(ctx, paint);
    return gradientCss(paint, node.width, node.height);
  }).filter((layer): layer is string => !!layer);
  return layers.length ? layers.join(', ') : null;
}

/** The colour of a text (or run): a solid fill's colour, null for gradients and pictures. */
function textColor(ctx: DeclContext, fills: readonly Paint[], styleId: string | undefined): string | null {
  const visible = fills.filter(isVisiblePaint);
  if (visible.length !== 1 || visible[0].type !== 'SOLID') return null;
  const style = styleId ? ctx.tokens.byStyle.get(styleId) : undefined;
  if (style?.kind === 'color') return `var(--${style.name})`;
  return solidCss(ctx, visible[0], 'text');
}

/** Text paint declarations: `color`, or a gradient clipped to the glyphs. */
export function textPaintDecls(ctx: DeclContext, node: SceneNode, fills: readonly Paint[], styleId: string | undefined, group: CssGroup = 'text'): Decl[] {
  const solid = textColor(ctx, fills, styleId);
  if (solid) return [{group, prop: 'color', value: solid}];
  const background = backgroundCss(ctx, node, fills, styleId, 'text');
  if (!background) return [];
  return [
    {group, prop: 'background', value: background},
    {group, prop: '-webkit-background-clip', value: 'text'},
    {group, prop: 'background-clip', value: 'text'},
    {group, prop: 'color', value: 'transparent'},
  ];
}

const TEXT_CASE: Record<string, [string, string] | undefined> = {
  UPPER: ['text-transform', 'uppercase'], LOWER: ['text-transform', 'lowercase'], TITLE: ['text-transform', 'capitalize'], SMALL_CAPS: ['font-variant-caps', 'small-caps'],
};

/** Typography of a style. With `base`, only what differs from it (a run inside a text). */
export function typographyDecls(ctx: DeclContext, node: SceneNode, style: TextStyle, styleId: string | undefined, base?: TextStyle, baseStyleId?: string): Decl[] {
  const out: Decl[] = [];
  const add = (prop: string, value: string | null) => {
    if (value !== null) out.push({group: 'text', prop, value});
  };
  const token = styleId ? ctx.tokens.byStyle.get(styleId) : undefined;
  const same = <K extends keyof TextStyle>(key: K) => !!base && JSON.stringify(style[key]) === JSON.stringify(base[key]);
  if (token?.kind === 'font' && !(base && styleId === baseStyleId)) {
    add('font', `var(--${token.name})`);
    const tracking = ctx.tokens.trackingByStyle.get(styleId!);
    if (tracking) add('letter-spacing', `var(--${tracking.name})`);
  } else if (!(token?.kind === 'font' && base && styleId === baseStyleId)) {
    const bound = (field: string) => (base ? null : tokenVar(ctx, node, field));
    if (!same('fontFamily')) add('font-family', bound('fontFamily') ?? fontFamilyCss(style.fontFamily, ctx.fallback(style.fontFamily)));
    if (!same('italic') && (style.italic || base)) add('font-style', style.italic ? 'italic' : 'normal');
    if (!same('fontWeight')) add('font-weight', bound('fontWeight') ?? String(style.fontWeight));
    if (!same('fontSize')) add('font-size', bound('fontSize') ?? px(style.fontSize));
    if (!same('lineHeight')) add('line-height', bound('lineHeight') ?? lineHeightCss(style.lineHeight) ?? (base ? 'normal' : null));
    if (!same('letterSpacing')) add('letter-spacing', bound('letterSpacing') ?? letterSpacingCss(style.letterSpacing) ?? (base ? 'normal' : null));
  }
  if (!same('textCase')) {
    const entry = TEXT_CASE[style.textCase];
    if (entry) add(entry[0], entry[1]);
    else if (base) add(TEXT_CASE[base.textCase]?.[0] ?? 'text-transform', 'none');
  }
  if (!same('textDecoration')) {
    if (style.textDecoration === 'UNDERLINE') add('text-decoration', 'underline');
    else if (style.textDecoration === 'STRIKETHROUGH') add('text-decoration', 'line-through');
    else if (base) add('text-decoration', 'none');
  }
  return out;
}

/** The style a whole text shows: its base style under a run that covers every character. */
export function wholeTextStyle(node: SceneNode): {style: TextStyle; fills: Paint[]; styleId: string | undefined} {
  const text = node.text!;
  const length = text.characters.length;
  const run = text.runs.length === 1 && text.runs[0].start === 0 && text.runs[0].end >= length ? text.runs[0] : undefined;
  return {
    style: run ? {...text.style, ...run.style} : text.style,
    fills: run?.fills ?? node.fills,
    styleId: run?.textStyleId ?? node.textStyleId,
  };
}

/** Every declaration of a layer for the element that draws it. */
export function declarations(node: SceneNode, ctx: DeclContext): Decl[] {
  const out: Decl[] = [];
  const add = (group: CssGroup, prop: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') out.push({group, prop, value});
  };
  const {doc} = ctx;
  const paint = ctx.paint ?? 'css';
  const parent = !ctx.root && node.parentId ? doc.nodes[node.parentId] : undefined;
  const flexParent = !!parent && isAutoLayout(parent);
  const inFlow = flexParent && node.layoutPositioning !== 'ABSOLUTE';
  const isText = node.type === 'TEXT' && !!node.text;

  // Auto layout ──────────────────────────────────────────────────────────────────────────────
  const sizingParent = parent ?? undefined;
  // A root that hugs its content is inline-flex: it sizes itself as a button does, with no width to keep in step.
  const hugsWidth = ctx.root && !isText && paint === 'css' && !ctx.box && effectiveSizing(node, sizingParent, 'horizontal') === 'HUG';
  if (isAutoLayout(node) && paint !== 'svg' && node.autoLayout!.layoutMode === 'GRID') {
    // Grid auto layout → CSS grid: the tracks as the design stores them (px, fr, auto for hug), the gaps, the padding.
    // Children carry their cells (`grid-row` / `grid-column`), spans and alignment below.
    const al = node.autoLayout!, grid = node.grid ?? DEFAULT_GRID;
    const placement = placeGridChildren(grid, (node.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.visible && child.layoutPositioning !== 'ABSOLUTE'));
    const template = (spec: typeof grid.rowSizes, count: number) => Array.from({length: count}, (_, i) => {
      const track = trackOf(spec, i);
      return track.kind === 'FIXED' ? px(track.value) : track.kind === 'HUG' ? 'auto' : `${track.value}fr`;
    });
    add('layout', 'display', hugsWidth ? 'inline-grid' : 'grid');
    add('layout', 'grid-template-columns', template(grid.columnSizes, placement.columns).join(' '));
    add('layout', 'grid-template-rows', template(grid.rowSizes, placement.rows).join(' '));
    const rowGap = px(grid.rowGap), columnGap = px(grid.columnGap);
    if (rowGap !== '0' || columnGap !== '0') add('layout', 'gap', rowGap === columnGap ? rowGap : `${rowGap} ${columnGap}`);
    const padding = [
      tokenVar(ctx, node, 'paddingTop') ?? px(al.paddingTop),
      tokenVar(ctx, node, 'paddingRight') ?? px(al.paddingRight),
      tokenVar(ctx, node, 'paddingBottom') ?? px(al.paddingBottom),
      tokenVar(ctx, node, 'paddingLeft') ?? px(al.paddingLeft),
    ];
    if (padding.some(value => value !== '0')) add('layout', 'padding', sides(padding));
  } else if (isAutoLayout(node) && paint !== 'svg') {
    const al = node.autoLayout!;
    const wrap = al.layoutWrap === 'WRAP' && al.layoutMode === 'HORIZONTAL';
    add('layout', 'display', hugsWidth ? 'inline-flex' : 'flex');
    if (al.layoutMode === 'VERTICAL') add('layout', 'flex-direction', 'column');
    if (wrap) add('layout', 'flex-wrap', 'wrap');
    add('layout', 'justify-content', {MIN: null, CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between'}[al.primaryAxisAlignItems]);
    // Children that all fill across are CSS's default (stretch): neither they nor the container say so.
    if (!stretchesAll(doc, node)) add('layout', 'align-items', {MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline'}[al.counterAxisAlignItems]);
    if (wrap) add('layout', 'align-content', al.counterAxisAlignContent === 'SPACE_BETWEEN' ? 'space-between' : 'flex-start');
    const main = al.primaryAxisAlignItems === 'SPACE_BETWEEN' ? '0' : tokenVar(ctx, node, 'itemSpacing') ?? px(al.itemSpacing);
    if (wrap) {
      const cross = tokenVar(ctx, node, 'counterAxisSpacing') ?? px(al.counterAxisSpacing);
      if (main !== '0' || cross !== '0') add('layout', 'gap', cross === main ? main : `${cross} ${main}`);
    } else if (main !== '0') add('layout', 'gap', main);
    const padding = [
      tokenVar(ctx, node, 'paddingTop') ?? px(al.paddingTop),
      tokenVar(ctx, node, 'paddingRight') ?? px(al.paddingRight),
      tokenVar(ctx, node, 'paddingBottom') ?? px(al.paddingBottom),
      tokenVar(ctx, node, 'paddingLeft') ?? px(al.paddingLeft),
    ];
    if (padding.some(value => value !== '0')) add('layout', 'padding', sides(padding));
  }

  // Place in the parent ──────────────────────────────────────────────────────────────────────
  const box = ctx.box ?? cssBox(node);
  const parentGroup = parent && (parent.type === 'GROUP' || parent.type === 'BOOLEAN_OPERATION');
  const constraints = parentGroup ? {horizontal: 'MIN', vertical: 'MIN'} as const : node.constraints;
  let stretchH = false, stretchV = false, scaleH = false, scaleV = false;
  if (parent && !inFlow) {
    add('position', 'position', 'absolute');
    const pw = parent.width, ph = parent.height;
    switch (constraints.horizontal) {
      case 'MAX': add('position', 'right', px(pw - box.x - box.width)); break;
      case 'CENTER': add('position', 'left', centreOffset(box.x, box.width, pw)); break;
      case 'STRETCH': add('position', 'left', px(box.x)); add('position', 'right', px(pw - box.x - box.width)); stretchH = true; break;
      case 'SCALE': add('position', 'left', percent(box.x, pw)); scaleH = true; break;
      default: add('position', 'left', px(box.x));
    }
    switch (constraints.vertical) {
      case 'MAX': add('position', 'bottom', px(ph - box.y - box.height)); break;
      case 'CENTER': add('position', 'top', centreOffset(box.y, box.height, ph)); break;
      case 'STRETCH': add('position', 'top', px(box.y)); add('position', 'bottom', px(ph - box.y - box.height)); stretchV = true; break;
      case 'SCALE': add('position', 'top', percent(box.y, ph)); scaleV = true; break;
      default: add('position', 'top', px(box.y));
    }
  }

  // Size ─────────────────────────────────────────────────────────────────────────────────────
  let horizontal = paint === 'svg' || ctx.box ? 'FIXED' : effectiveSizing(node, sizingParent, 'horizontal');
  let vertical = paint === 'svg' || ctx.box ? 'FIXED' : effectiveSizing(node, sizingParent, 'vertical');
  let textMode = isText ? textSizing(node, sizingParent).textAutoResize : null;
  if (isText && paint === 'css' && !ctx.box) {
    const sizing = textSizing(node, sizingParent);
    horizontal = sizing.horizontal;
    vertical = sizing.vertical;
    textMode = sizing.textAutoResize;
  }
  const row = flexParent && parent!.autoLayout!.layoutMode === 'HORIZONTAL';
  const primaryFill = inFlow && (row ? horizontal : vertical) === 'FILL';
  const crossFill = inFlow && (row ? vertical : horizontal) === 'FILL';
  const sizeValue = (field: 'width' | 'height', value: number) => tokenVar(ctx, node, field) ?? px(value);
  if (stretchH) { /* left + right */ }
  else if (scaleH) add('size', 'width', percent(box.width, parent!.width));
  else if (horizontal === 'FIXED') add('size', 'width', sizeValue('width', box.width));
  else if (horizontal === 'HUG' && ctx.root && !isText && !hugsWidth) add('size', 'width', 'fit-content');
  if (stretchV) { /* top + bottom */ }
  else if (scaleV) add('size', 'height', percent(box.height, parent!.height));
  else if (vertical === 'FIXED') add('size', 'height', node.type === 'LINE' && paint === 'css' ? '0' : sizeValue('height', box.height));
  for (const [field, prop] of [['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']] as const) {
    const value = node[field];
    if (value !== null && value !== undefined) add('size', prop, tokenVar(ctx, node, field) ?? px(value));
  }

  // Inside auto layout ───────────────────────────────────────────────────────────────────────
  // Filling takes the free space; a fixed size never shrinks (as in the design); hugging needs nothing.
  const gridParent = flexParent && parent!.autoLayout!.layoutMode === 'GRID';
  if (inFlow && gridParent) {
    // The cell the layout derived (CSS's own row auto-flow would find the same, but a manual grid needs it said, and
    // spans always do); then how the child sits in its cells: FILL stretches (CSS's default), the rest align.
    const grid = parent!.grid ?? DEFAULT_GRID;
    const cell = placeGridChildren(grid, (parent!.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.visible && child.layoutPositioning !== 'ABSOLUTE')).cells.get(node.id);
    if (cell) {
      const line = (start: number, span: number) => (span > 1 ? `${start + 1} / span ${span}` : grid.itemsPositioning === 'MANUAL' ? `${start + 1}` : null);
      add('item', 'grid-row', line(cell.row, cell.rowSpan));
      add('item', 'grid-column', line(cell.column, cell.columnSpan));
    }
    const self = (sizing: string, align: string | undefined) => (sizing === 'FILL' ? null : align === 'CENTER' ? 'center' : align === 'MAX' ? 'end' : 'start');
    add('item', 'justify-self', self(horizontal, node.gridChild?.horizontalAlign));
    add('item', 'align-self', self(vertical, node.gridChild?.verticalAlign));
  } else if (inFlow) {
    if (primaryFill) add('item', 'flex', '1');
    else if ((row ? horizontal : vertical) === 'FIXED') add('item', 'flex-shrink', '0');
    if (crossFill && !stretchesAll(doc, parent!)) add('item', 'align-self', 'stretch');
  }

  // Turn and flip ────────────────────────────────────────────────────────────────────────────
  if (paint !== 'svg' && !ctx.box && (turned(node) || node.flipX || node.flipY)) {
    const parts = [turned(node) ? `rotate(${num(-node.rotation)}deg)` : '', node.flipX && node.flipY ? 'scale(-1)' : node.flipX ? 'scaleX(-1)' : node.flipY ? 'scaleY(-1)' : ''];
    add('position', 'transform', parts.filter(Boolean).join(' '));
  }

  // Paint ────────────────────────────────────────────────────────────────────────────────────
  const shadows: string[] = [];
  // Background, then corners (a picture drawn as <img> is rounded like the box it fills).
  if (paint === 'css' && !isText) add('visual', 'background', node.type === 'LINE' ? null : backgroundCss(ctx, node));
  if ((paint === 'css' || paint === 'img') && !isText) {
    if (node.type === 'ELLIPSE') add('visual', 'border-radius', '50%');
    else if (node.type === 'RECTANGLE' || isFrameLike(node) || node.type === 'SECTION') {
      const radii = cornerRadiiOf(node);
      const fields = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
      const values = radii.map((radius, i) => tokenVar(ctx, node, fields[i]) ?? tokenVar(ctx, node, 'cornerRadius') ?? px(Math.max(0, radius)));
      // Round all the way: a circle is 50%, a pill 9999px, so the shape holds when the box changes size.
      const round = radii.every(radius => radius === radii[0]) && values.every(value => value === values[0] && !value.startsWith('var(')) && radii[0] >= Math.min(node.width, node.height) / 2 - 0.01 && radii[0] > 0;
      if (round) add('visual', 'border-radius', Math.abs(node.width - node.height) < 0.01 ? '50%' : '9999px');
      else if (values.some(value => value !== '0')) add('visual', 'border-radius', sides(values));
    }
  }
  if (paint === 'css' && !isText) {
    // Strokes
    const stroke = [...node.strokes].reverse().find(isVisiblePaint);
    if (stroke) {
      const style = node.dashPattern.length ? (node.strokeCap === 'ROUND' && node.dashPattern[0] <= node.strokeWeight ? 'dotted' : 'dashed') : 'solid';
      const strokeToken = node.strokeStyleId ? ctx.tokens.byStyle.get(node.strokeStyleId) : undefined;
      const strokeColor = strokeToken?.kind === 'color' ? `var(--${strokeToken.name})` : solidCss(ctx, stroke, 'stroke');
      const weight = tokenVar(ctx, node, 'strokeWeight') ?? px(node.strokeWeight);
      const individual = node.individualStrokeWeights;
      if (node.type === 'LINE') {
        add('visual', 'border-top', `${weight} ${style} ${strokeColor ?? 'currentColor'}`);
      } else if (!strokeColor) {
        // A gradient stroke: border-image draws it, without rounded corners.
        const gradient = stroke.type !== 'SOLID' && stroke.type !== 'IMAGE' ? gradientCss(stroke, node.width, node.height) : null;
        if (gradient) {
          add('visual', 'border', `${weight} solid transparent`);
          add('visual', 'border-image', `${gradient} 1`);
        }
      } else if (individual) {
        const widths = [individual.top, individual.right, individual.bottom, individual.left];
        const drawn = widths.map((width, i) => [width, ['top', 'right', 'bottom', 'left'][i]] as const).filter(([width]) => width > 0);
        // One side (a divider under a row) is one shorthand; several keep the three properties.
        if (drawn.length === 1) add('visual', `border-${drawn[0][1]}`, `${px(drawn[0][0])} ${style} ${strokeColor}`);
        else if (drawn.length) {
          add('visual', 'border-style', style);
          add('visual', 'border-width', sides(widths.map(px)));
          add('visual', 'border-color', strokeColor);
        }
      } else if (node.strokeAlign === 'INSIDE' && style === 'solid') {
        shadows.push(`inset 0 0 0 ${weight} ${strokeColor}`);
      } else if (node.strokeAlign === 'INSIDE') {
        add('visual', 'border', `${weight} ${style} ${strokeColor}`);
      } else {
        add('visual', 'outline', `${weight} ${style} ${strokeColor}`);
        if (node.strokeAlign === 'CENTER') add('visual', 'outline-offset', node.strokeWeight ? `-${px(node.strokeWeight / 2)}` : '0');
      }
    }
  }

  // Effects ──────────────────────────────────────────────────────────────────────────────────
  if (paint !== 'svg') {
    const effects = node.effects.filter(e => e.visible !== false);
    const effectToken = node.effectStyleId ? ctx.tokens.byStyle.get(node.effectStyleId) : undefined;
    const blurToken = node.effectStyleId ? ctx.tokens.blurByStyle.get(node.effectStyleId) : undefined;
    const shadowEffects = effects.filter((e): e is ShadowEffect => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
    if (isText) {
      const drops = shadowEffects.filter(e => e.type === 'DROP_SHADOW');
      if (drops.length) add('visual', 'text-shadow', [...drops].reverse().map(e => shadowCss(e, {spread: false})).join(', '));
    } else if (paint === 'css' || paint === 'img') {
      if (effectToken?.kind === 'shadow') shadows.push(`var(--${effectToken.name})`);
      else shadows.push(...[...shadowEffects].reverse().map(e => shadowCss(e)));
    }
    if (shadows.length) add('visual', 'box-shadow', shadows.join(', '));
    const blur = effects.find(e => e.type === 'LAYER_BLUR');
    if (blur) add('visual', 'filter', blurToken ? `var(--${blurToken.name})` : blurCss(blur.radius));
    const backdrop = effects.find(e => e.type === 'BACKGROUND_BLUR');
    if (backdrop) {
      add('visual', 'backdrop-filter', blurCss(backdrop.radius));
      add('visual', '-webkit-backdrop-filter', blurCss(backdrop.radius));
    }
  }

  // Layer ────────────────────────────────────────────────────────────────────────────────────
  const opacityToken = tokenVar(ctx, node, 'opacity');
  if (opacityToken) add('visual', 'opacity', `calc(${opacityToken} / 100)`);
  else if (node.opacity < 1) add('visual', 'opacity', num(node.opacity));
  add('visual', 'mix-blend-mode', BLEND_CSS[node.blendMode] ?? null);
  if (paint === 'css' && isFrameLike(node) && node.clipsContent && node.children?.length && clipsSomething(doc, node)) add('visual', 'overflow', 'hidden');

  // Text ─────────────────────────────────────────────────────────────────────────────────────
  if (isText && paint === 'css') {
    const text = node.text!;
    const whole = wholeTextStyle(node);
    out.push(...typographyDecls(ctx, node, whole.style, whole.styleId));
    if (text.textAlignHorizontal !== 'LEFT') add('text', 'text-align', {CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify'}[text.textAlignHorizontal]);
    if (text.paragraphIndent) add('text', 'text-indent', px(text.paragraphIndent));
    out.push(...textPaintDecls(ctx, node, whole.fills, whole.styleId));
    const stroke = [...node.strokes].reverse().find(isVisiblePaint);
    if (stroke?.type === 'SOLID') add('text', '-webkit-text-stroke', `${px(node.strokeWeight)} ${solidCss(ctx, stroke, 'stroke')}`);
    if (textMode === 'WIDTH_AND_HEIGHT') add('text', 'white-space', 'nowrap');
    if (textMode === 'TRUNCATE') {
      add('text', 'overflow', 'hidden');
      add('text', 'text-overflow', 'ellipsis');
      if (text.maxLines) {
        add('text', 'display', '-webkit-box');
        add('text', '-webkit-line-clamp', String(text.maxLines));
        add('text', '-webkit-box-orient', 'vertical');
      } else add('text', 'white-space', 'nowrap');
    } else if ((textMode === 'NONE') && text.textAlignVertical !== 'TOP') {
      add('text', 'display', 'flex');
      add('text', 'flex-direction', 'column');
      add('text', 'justify-content', text.textAlignVertical === 'CENTER' ? 'center' : 'flex-end');
    }
  }

  // Padding and borders sit inside the size, as in the design: the generated project's reset (and Tailwind's
  // preflight) sets `box-sizing: border-box` once for every element, so no rule repeats it.
  return out;
}

/** Whether every child auto layout places fills the cross axis: then `align-items` is CSS's default (stretch) and the
 *  children need no `align-self`. */
export function stretchesAll(doc: DesignDocument, node: SceneNode): boolean {
  const al = node.autoLayout;
  if (!al || !isAutoLayout(node) || al.layoutWrap === 'WRAP') return false;
  const axis = al.layoutMode === 'HORIZONTAL' ? 'vertical' : 'horizontal';
  let any = false;
  for (const id of node.children ?? []) {
    const child = doc.nodes[id];
    if (!child || child.visible === false || child.layoutPositioning === 'ABSOLUTE') continue;
    if (effectiveSizing(child, node, axis) !== 'FILL') return false;
    any = true;
  }
  return any;
}

/** Whether clipping changes the picture: a child sticks out, or rounded corners cut it. */
function clipsSomething(doc: DesignDocument, node: SceneNode): boolean {
  const [tl, tr, br, bl] = cornerRadiiOf(node).map(radius => Math.min(Math.max(0, radius), node.width / 2, node.height / 2));
  const w = node.width, h = node.height, e = 0.01;
  // A corner square of the frame that a box reaches into.
  const overlaps = (box: Rect, x: number, y: number, size: number) => size > 0 && box.x < x + size - e && box.x + box.width > x + e && box.y < y + size - e && box.y + box.height > y + e;
  for (const id of node.children ?? []) {
    const child = doc.nodes[id];
    if (!child || !child.visible) continue;
    const box = cssBox(child);
    if (turned(child) || box.x < -e || box.y < -e || box.x + box.width > w + e || box.y + box.height > h + e) return true;
    if (overlaps(box, 0, 0, tl) || overlaps(box, w - tr, 0, tr) || overlaps(box, w - br, h - br, br) || overlaps(box, 0, h - bl, bl)) return true;
  }
  return false;
}
