import type {DesignDocument, ExportSetting, ImageRef, NodeId, Paint, RGB, SceneNode, ShadowEffect} from '../../../../shared/design/types';
import type {TextMeasurer} from '../../../../shared/design/text-layout';
import {isAutoLayout} from '../../../../shared/design/constraints';
import {effectiveSizing} from '../../../../shared/design/layout';
import {cornerRadiiOf} from '../../../../shared/design/shapes';
import {cssBox, nodeToCss, sides, suggestedColor, wholeTextStyle, type ColorUse, type CssGroup, type Decl} from '../../../../shared/design/codegen/css';
import {formatValue, type CodeFormat} from '../../../../shared/design/codegen/format';
import {slugName} from '../../../../shared/design/codegen/names';
import type {ComponentInfo, Framework, PropInfo} from '../../../../shared/design/codegen/react';
import {attrValue, vueText} from '../../../../shared/design/codegen/vue';
import {meaningfulName} from '../../../../shared/design/codegen/semantics';
import {inlineSvg, isVectorGraphic, svgKey, svgMarkup, type InlineSvg} from '../../../../shared/design/codegen/svg';
import type {TokenTable} from '../../../../shared/design/codegen/tokens';
import {color, gradientCss, letterSpacingCss, lineHeightCss, num, px, shadowCss} from '../../../../shared/design/codegen/values';

// What the "Code" tab shows beside the code, as Figma's Dev Mode does: the box model, auto layout, typography, the styles
// and variables a selection uses (and the ones its raw values could use), the pictures and icons in it, a component's
// usage for any props, and the CSS as a list of values. Pure reads of the document; every value is ready to copy.

/** A value row: what it is, the value, a dimmed note after it (how a size is set), what a click copies. */
export type Measure = {label: string; value: string; note?: string; copy: string};

const TYPE_LABELS: Partial<Record<SceneNode['type'], string>> = {
  FRAME: 'Frame', GROUP: 'Group', SECTION: 'Section', COMPONENT: 'Component', COMPONENT_SET: 'Component set', INSTANCE: 'Instance',
  BOOLEAN_OPERATION: 'Boolean operation', RECTANGLE: 'Rectangle', ELLIPSE: 'Ellipse', LINE: 'Line', POLYGON: 'Polygon', STAR: 'Star',
  VECTOR: 'Vector', TEXT: 'Text', SLICE: 'Slice', PAGE: 'Page',
};

/** A file tab's label: the file's name, its middle cut out past `max` characters, so the ending that tells ".tsx" from
 *  ".module.css" stays in view ("OnlaynZapisKoto…aVas.tsx" beside "OnlaynZapi….module.css"). */
export function fileTabLabel(path: string, max = 24): string {
  const name = path.split('/').pop() || path;
  if ([...name].length <= max) return name;
  const dot = name.indexOf('.', 1);
  const ext = dot > 0 ? name.slice(dot) : '';
  const stem = [...(dot > 0 ? name.slice(0, dot) : name)];
  const room = Math.max(4, max - ext.length - 1);
  const head = Math.ceil(room * 0.6), tail = room - head;
  return stem.slice(0, head).join('') + '…' + (tail ? stem.slice(-tail).join('') : '') + ext;
}

export const typeLabel = (node: SceneNode) => (node.type === 'FRAME' && node.autoLayout?.layoutMode && node.autoLayout.layoutMode !== 'NONE' ? 'Auto layout frame' : TYPE_LABELS[node.type] ?? node.type);

/** A length as the code settings write it (16px or 1rem). */
const length = (value: number, format?: CodeFormat) => formatValue('width', px(value), format);

// ── Box model ──────────────────────────────────────────────────────────────────────────────────

export type Sizing = 'FIXED' | 'HUG' | 'FILL';

export type BoxModel = {
  width: number;
  height: number;
  sizing: {horizontal: Sizing; vertical: Sizing};
  /** The box in its parent, as CSS places it. */
  x: number;
  y: number;
  /** Auto layout's padding, top right bottom left. */
  padding: [number, number, number, number] | null;
  /** A stroke drawn inside or across the edge, by side (a CSS border or inset shadow). */
  border: [number, number, number, number] | null;
  radius: string | null;
  rotation: number;
  /** Placed by its parent's auto layout (no x and y in code). */
  inFlow: boolean;
};

export function boxModel(doc: DesignDocument, node: SceneNode): BoxModel {
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  const box = cssBox(node);
  const al = isAutoLayout(node) ? node.autoLayout! : null;
  const stroke = node.strokes.some(paint => paint.visible !== false && paint.opacity > 0) && node.strokeWeight > 0 && node.type !== 'TEXT' && node.type !== 'LINE';
  const sides = node.individualStrokeWeights;
  const radii = cornerRadiiOf(node);
  const radiusValues = radii.map(radius => px(Math.max(0, radius)));
  return {
    width: node.width,
    height: node.height,
    sizing: {horizontal: effectiveSizing(node, parent, 'horizontal') as Sizing, vertical: effectiveSizing(node, parent, 'vertical') as Sizing},
    x: box.x,
    y: box.y,
    padding: al ? [al.paddingTop, al.paddingRight, al.paddingBottom, al.paddingLeft] : null,
    border: stroke ? (sides ? [sides.top, sides.right, sides.bottom, sides.left] : [node.strokeWeight, node.strokeWeight, node.strokeWeight, node.strokeWeight]) : null,
    radius: node.type === 'ELLIPSE' ? '50%' : radiusValues.some(value => value !== '0') ? (radiusValues.every(value => value === radiusValues[0]) ? radiusValues[0] : radiusValues.join(' ')) : null,
    rotation: node.rotation,
    inFlow: !!parent && isAutoLayout(parent) && node.layoutPositioning !== 'ABSOLUTE',
  };
}

const SIZING_LABELS: Record<Sizing, string> = {FIXED: 'Fixed', HUG: 'Hug contents', FILL: 'Fill container'};
export const sizingLabel = (sizing: Sizing) => SIZING_LABELS[sizing];

const ALIGN_LABELS = {MIN: 'Start', CENTER: 'Center', MAX: 'End', SPACE_BETWEEN: 'Space between', BASELINE: 'Baseline'} as const;

export function layoutRows(node: SceneNode, format?: CodeFormat): Measure[] | null {
  const al = node.autoLayout;
  if (!al || al.layoutMode === 'NONE') return null;
  const padding = [al.paddingTop, al.paddingRight, al.paddingBottom, al.paddingLeft].map(value => length(value, format));
  const paddingText = sides(padding);
  const rows: Measure[] = [
    {label: 'Direction', value: al.layoutMode === 'VERTICAL' ? 'Vertical' : al.layoutWrap === 'WRAP' ? 'Horizontal, wrap' : 'Horizontal', copy: `flex-direction: ${al.layoutMode === 'VERTICAL' ? 'column' : 'row'};`},
    {label: 'Gap', value: al.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'Auto' : length(al.itemSpacing, format), copy: al.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'justify-content: space-between;' : `gap: ${length(al.itemSpacing, format)};`},
    {label: 'Padding', value: paddingText, copy: `padding: ${paddingText};`},
    {label: 'Alignment', value: `${ALIGN_LABELS[al.primaryAxisAlignItems]} · ${ALIGN_LABELS[al.counterAxisAlignItems]}`,
      copy: `justify-content: ${{MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between'}[al.primaryAxisAlignItems]}; align-items: ${{MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline'}[al.counterAxisAlignItems]};`},
  ];
  if (al.layoutWrap === 'WRAP') rows.push({label: 'Gap between rows', value: length(al.counterAxisSpacing, format), copy: `row-gap: ${length(al.counterAxisSpacing, format)};`});
  return rows;
}

// ── Typography ─────────────────────────────────────────────────────────────────────────────────

const WEIGHT_NAMES: Record<number, string> = {100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black'};

export type Typography = {
  /** The text style's name, when the text uses one. */
  style: string | null;
  /** Its token (`--font-heading-h2`), for copying. */
  token: string | null;
  family: string;
  weight: number;
  italic: boolean;
  rows: Measure[];
};

export function typographyRows(node: SceneNode, tokens: TokenTable, format?: CodeFormat): Typography | null {
  if (node.type !== 'TEXT' || !node.text) return null;
  const {style, styleId} = wholeTextStyle(node);
  const token = styleId ? tokens.byStyle.get(styleId) : undefined;
  const lineHeight = lineHeightCss(style.lineHeight);
  const spacing = letterSpacingCss(style.letterSpacing);
  const size = length(style.fontSize, format);
  const lead = lineHeight ? formatValue('line-height', lineHeight, format) : null;
  const rows: Measure[] = [
    {label: 'Font', value: style.fontFamily, copy: `font-family: '${style.fontFamily}';`},
    {label: 'Style', value: `${WEIGHT_NAMES[style.fontWeight] ?? style.fontWeight}${style.italic ? ' Italic' : ''} · ${style.fontWeight}`, copy: `font-weight: ${style.fontWeight};`},
    {label: 'Size', value: size, copy: `font-size: ${size};`},
    {label: 'Line height', value: lead ?? 'Auto', copy: `line-height: ${lead ?? 'normal'};`},
  ];
  if (spacing) rows.push({label: 'Letter spacing', value: spacing, copy: `letter-spacing: ${spacing};`});
  const align = node.text.textAlignHorizontal;
  if (align !== 'LEFT') rows.push({label: 'Alignment', value: {CENTER: 'Center', RIGHT: 'Right', JUSTIFIED: 'Justified'}[align] ?? align, copy: `text-align: ${{CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify'}[align]};`});
  return {style: token ? token.original : null, token: token?.name ? `--${token.name}` : null, family: style.fontFamily, weight: style.fontWeight, italic: style.italic, rows};
}

// ── Styles and variables ───────────────────────────────────────────────────────────────────────

export type StyleKind = 'fill' | 'stroke' | 'text' | 'effect';

export type StyleEntry = {
  key: string;
  kind: StyleKind;
  /** A colour swatch; a gradient's CSS when it is one; a shadow's `box-shadow` (its preview). */
  swatch: RGB | null;
  alpha: number;
  gradient: string | null;
  shadow?: string;
  /** The value in the chosen colour format (`#3D63F5`, `0 8px 24px …`). */
  value: string;
  /** The token the layers use (`--color-brand-500`), or the one their raw value equals. */
  token: string | null;
  /** The designer's name of the style or variable. */
  original: string | null;
  /** The layers use the raw value; the token is one that has it (Figma's suggested variables). */
  suggested: boolean;
  /** Where it is used ("Fill", "Text", "Shadow"). */
  where: string;
  /** What a click copies: the token's `var(…)`, else the value. */
  copy: string;
};

const USE_OF: Record<StyleKind, ColorUse> = {fill: 'fill', stroke: 'stroke', text: 'text', effect: 'fill'};

/** The colours, gradients and shadows the layers use, each once: bound tokens first-class, raw values with the token they
 *  could use. */
export function stylesUsed(doc: DesignDocument, ids: readonly NodeId[], tokens: TokenTable, format?: CodeFormat, limit = 40): StyleEntry[] {
  const out = new Map<string, StyleEntry>();
  const stack = [...ids];
  const formatColor = (value: string) => formatValue('color', value, format);
  const tokenOf = (name: string) => tokens.tokens.find(token => token.name === name);
  const add = (entry: Omit<StyleEntry, 'key' | 'copy'>) => {
    const key = `${entry.kind}|${entry.value}|${entry.token ?? ''}`;
    if (!out.has(key)) out.set(key, {...entry, key, copy: entry.token ? `var(${entry.token})` : entry.value});
  };
  const paintEntry = (paint: Paint, kind: StyleKind, where: string, styleId?: string) => {
    if (paint.visible === false || paint.opacity <= 0 || paint.type === 'IMAGE') return;
    const style = styleId ? tokens.byStyle.get(styleId) : undefined;
    if (paint.type === 'SOLID') {
      const raw = color(paint.color, paint.opacity);
      const alias = paint.boundVariables?.color;
      const bound = alias ? tokens.byVariable.get(alias.id) : style?.kind === 'color' ? style : undefined;
      const suggestion = bound ? null : /^var\(--([^)]+)\)$/.exec(suggestedColor({tokens}, raw, USE_OF[kind]))?.[1] ?? null;
      const token = bound?.name ? bound : suggestion ? tokenOf(suggestion) : undefined;
      add({kind, swatch: paint.color, alpha: paint.opacity, gradient: null, value: formatColor(raw), token: token?.name ? `--${token.name}` : null, original: token?.original ?? null, suggested: !bound && !!token, where});
      return;
    }
    const css = gradientCss(paint, 100, 100);
    const first = paint.gradientStops[0];
    add({kind, swatch: first?.color ?? null, alpha: first ? first.color.a * paint.opacity : 1, gradient: css, value: formatColor(css), token: style?.name ? `--${style.name}` : null, original: style?.original ?? null, suggested: false, where});
  };
  for (let visited = 0; stack.length && out.size < limit && visited < 5000; visited++) {
    const node = doc.nodes[stack.shift()!];
    if (!node || node.visible === false) continue;
    // A variant set's dashed purple frame is the editor's, not the design's.
    if (node.type === 'COMPONENT_SET') {
      if (node.children) stack.push(...node.children);
      continue;
    }
    const isText = node.type === 'TEXT';
    for (const paint of node.fills) paintEntry(paint, isText ? 'text' : 'fill', isText ? 'Text' : 'Fill', node.fillStyleId);
    for (const run of node.text?.runs ?? []) for (const paint of run.fills ?? []) paintEntry(paint, 'text', 'Text');
    for (const paint of node.strokes) paintEntry(paint, 'stroke', 'Stroke', node.strokeStyleId);
    // A layer's shadows are one `box-shadow` (an effect style of two shadows is one style).
    const shadows = node.effects.filter((effect): effect is ShadowEffect => effect.visible !== false && (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'));
    if (shadows.length) {
      const style = node.effectStyleId ? tokens.byStyle.get(node.effectStyleId) : undefined;
      const value = formatValue('box-shadow', shadows.map(effect => shadowCss(effect)).join(', '), format);
      add({kind: 'effect', swatch: null, alpha: 1, gradient: null, shadow: value, value, token: style?.kind === 'shadow' ? `--${style.name}` : null,
        original: style?.kind === 'shadow' ? style.original : null, suggested: false, where: shadows.every(effect => effect.type === 'INNER_SHADOW') ? 'Inner shadow' : 'Shadow'});
    }
    if (node.children && node.type !== 'BOOLEAN_OPERATION' && !isVectorGraphic(doc, node.id)) stack.push(...node.children);
  }
  return [...out.values()];
}

// ── Assets ─────────────────────────────────────────────────────────────────────────────────────

export type DetectedAsset = {
  key: string;
  nodeId: NodeId;
  name: string;
  kind: 'icon' | 'image';
  ref?: ImageRef;
  fileName: string;
  width: number;
  height: number;
  /** How many layers of the selection show it (one icon in every variant of a button). */
  count: number;
  /** An icon's .svg file as the code draws it; `monochrome` when it is in `currentColor`. */
  svg?: string;
  monochrome?: boolean;
};

/** A name that says only what a layer is ("Icon", "Vector"), not which picture it is. */
const GENERIC_PICTURE = /^(icon|vector|svg|image|picture|layer|shape|group|frame|path|union|glyph)(-?\d+)?$/;

/** An icon's file name, as the code names its component (ButtonIcon → button-icon.svg): the layer's name, or, when that
 *  names only a kind, the component or the layer it is in before it. */
function iconFileName(doc: DesignDocument, node: SceneNode): string {
  const own = slugName(node.name, 'icon');
  if (!GENERIC_PICTURE.test(own)) return own;
  for (let parent = node.parentId ? doc.nodes[node.parentId] : undefined; parent && parent.type !== 'PAGE'; parent = parent.parentId ? doc.nodes[parent.parentId] : undefined) {
    // A variant ("Type=Primary") is named by its set.
    if (parent.name.includes('=') || !meaningfulName(parent)) continue;
    const owner = slugName(parent.name, '');
    if (owner && !GENERIC_PICTURE.test(owner)) return `${owner}-${own.replace(/-?\d+$/, '')}`;
  }
  return own;
}

/** The icons (vector pictures) and images in the selection, as Figma's Dev Mode lists them for download. An icon drawn
 *  the same in another colour is the same asset (the code draws it in `currentColor`), so a button's icon in eight
 *  variants is one entry. */
export function detectAssets(doc: DesignDocument, ids: readonly NodeId[], options: {limit?: number; measurer?: TextMeasurer} = {}): DetectedAsset[] {
  const limit = options.limit ?? 24;
  const out = new Map<string, DetectedAsset>();
  const names = new Set<string>();
  const unique = (base: string, ext: string) => {
    let name = `${base}.${ext}`;
    for (let n = 2; names.has(name); n++) name = `${base}-${n}.${ext}`;
    names.add(name);
    return name;
  };
  /** Instances of one component draw the same: their key is the component's, without drawing them. */
  const byComponent = new Map<NodeId, string>();
  const stack = [...ids];
  let drawn = 0;
  for (let visited = 0; stack.length && visited < 5000; visited++) {
    const node = doc.nodes[stack.shift()!];
    if (!node || node.visible === false || node.type === 'PAGE') continue;
    if (node.type !== 'COMPONENT_SET' && isVectorGraphic(doc, node.id)) {
      let key = node.type === 'INSTANCE' && node.componentId ? byComponent.get(node.componentId) : undefined;
      let svg: InlineSvg | null = null;
      if (!key) {
        // Drawing is the costly part: past a few hundred icons the rest count by their layer.
        svg = drawn++ < 300 ? inlineSvg(doc, node.id, {measurer: options.measurer, idPrefix: 'icon'}) : null;
        key = `icon:${svg ? svgKey(svg) : node.id}`;
        if (node.type === 'INSTANCE' && node.componentId) byComponent.set(node.componentId, key);
      }
      const known = out.get(key);
      if (known) known.count++;
      else if (out.size < limit) {
        out.set(key, {key, nodeId: node.id, name: node.name, kind: 'icon', fileName: unique(iconFileName(doc, node), 'svg'), width: node.width, height: node.height, count: 1,
          ...(svg ? {svg: svgMarkup(svg), monochrome: !!svg.monochrome} : {})});
      }
      continue;
    }
    for (const paint of node.fills) {
      if (paint.type !== 'IMAGE' || !paint.imageRef || paint.visible === false) continue;
      const key = `image:${paint.imageRef}`;
      const known = out.get(key);
      if (known) {
        known.count++;
        continue;
      }
      if (out.size >= limit) continue;
      const asset = doc.images[paint.imageRef];
      const ext = (asset?.url.match(/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
      out.set(key, {key, nodeId: node.id, name: asset?.name ?? node.name, kind: 'image', ref: paint.imageRef, fileName: unique(slugName((asset?.name ?? node.name).replace(/\.[a-z0-9]+$/i, ''), 'image'), ext), width: asset?.width ?? node.width, height: asset?.height ?? node.height, count: 1});
    }
    if (node.children && node.type !== 'BOOLEAN_OPERATION') stack.push(...node.children);
  }
  return [...out.values()];
}

export type AssetEntry = {key: string; nodeId: NodeId; layer: string; setting: ExportSetting; fileName: string; label: string};

const settingLabel = (setting: ExportSetting) => {
  const size = setting.constraint.type === 'SCALE' ? `${num(setting.constraint.value)}x` : `${setting.constraint.type === 'WIDTH' ? 'w' : 'h'} ${num(setting.constraint.value)}`;
  return setting.format === 'SVG' || setting.format === 'PDF' ? setting.format : `${setting.format} ${size}`;
};

/** Export settings of the layers and everything inside them ("Export" in the Design tab). */
export function exportAssets(doc: DesignDocument, ids: readonly NodeId[], limit = 40): AssetEntry[] {
  const out: AssetEntry[] = [];
  const stack = [...ids];
  while (stack.length && out.length < limit) {
    const node = doc.nodes[stack.shift()!];
    if (!node) continue;
    node.exportSettings.forEach((setting, index) => {
      const ext = setting.format === 'JPG' ? 'jpg' : setting.format.toLowerCase();
      const base = slugName(node.name, 'layer');
      out.push({key: `${node.id}:${index}`, nodeId: node.id, layer: node.name, setting, fileName: `${base}${setting.suffix}.${ext}`, label: settingLabel(setting)});
    });
    if (node.children) stack.push(...node.children);
  }
  return out;
}

// ── A component's usage, for any props ─────────────────────────────────────────────────────────

export type PlaygroundValue = string | boolean;

/** The label prop: React's `children`, a Vue component's default slot. */
const isLabel = (prop: PropInfo) => prop.name === 'children' || (prop.name === 'default' && prop.native);

/** The props an instance gives, read from its usage (`<Button size="small" disabled>Buy</Button>`, or in a Vue
 *  template `<Button :count="2">Buy</Button>`). */
export function propsOfUsage(info: ComponentInfo, usage: string | undefined): Record<string, PlaygroundValue> {
  const values: Record<string, PlaygroundValue> = {};
  for (const prop of info.props) values[prop.name] = defaultOf(prop);
  if (!usage) return values;
  // The tag's own attributes only: a slot's template inside it passes another component's.
  const open = /^<\w+[^>]*?\/?>/.exec(usage)?.[0] ?? usage;
  for (const match of open.matchAll(/\s(:?)([A-Za-z][\w-]*)(?:=(?:"([^"]*)"|\{([^{}]*)\}))?(?=[\s/>])/g)) {
    const [, bound, name] = match;
    // A Vue binding (`:count="2"`) holds an expression where a JSX attribute has braces.
    const quoted: string | undefined = bound ? undefined : match[3];
    const expression: string | undefined = bound ? match[3] : match[4];
    const prop = info.props.find(entry => entry.name === name);
    if (!prop) continue;
    if (quoted !== undefined) values[name] = prop.kind === 'variant' ? `'${quoted}'` : quoted;
    else if (expression === undefined) values[name] = true;
    else if (expression === 'false' || expression === 'true') values[name] = prop.kind === 'variant' ? expression : expression === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(expression)) values[name] = expression;
  }
  const children = /^<\w+[^>]*?(?<!\/)>([\s\S]*)<\/\w+>$/.exec(usage)?.[1];
  const label = info.props.find(isLabel);
  if (children !== undefined && label) {
    const text = children.replace(/<template #[\w-]+>[\s\S]*?<\/template>|<template #[\w-]+ \/>/g, '').replace(/<br \/>/g, '\n');
    values[label.name] = label.name === 'default' ? text.replace(/&lt;/g, '<').replace(/&amp;/g, '&') : text;
  }
  return values;
}

function defaultOf(prop: PropInfo): PlaygroundValue {
  if (prop.kind === 'variant') return prop.defaultValue ?? prop.options?.[0] ?? '';
  if (prop.kind === 'variantBool' || prop.kind === 'boolean' || prop.kind === 'disabled') return prop.defaultValue === 'true';
  if (prop.kind === 'text') return '';
  return '';
}

const attrText = (value: string) => (/["{}<>&\n]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`);

/** The JSX (or Vue template) that gives `values` to the component: defaults left out, the label as children (the default
 *  slot). Slots keep their default. */
export function usageFor(info: ComponentInfo, values: Record<string, PlaygroundValue>, framework: Framework = 'react'): string {
  if (framework === 'vue') return vueUsageFor(info, values);
  let attrs = '';
  let children = '';
  for (const prop of info.props) {
    const value = values[prop.name];
    if (value === undefined) continue;
    if (prop.name === 'children') {
      children = String(value);
      continue;
    }
    if (prop.kind === 'slot') continue;
    if (prop.kind === 'variant') {
      const literal = String(value);
      if (literal === prop.defaultValue) continue;
      attrs += literal === 'true' ? ` ${prop.name}` : literal === 'false' || /^-?\d/.test(literal) ? ` ${prop.name}={${literal}}` : ` ${prop.name}="${literal.replace(/^'|'$/g, '')}"`;
    } else if (typeof value === 'boolean') {
      if (String(value) === (prop.defaultValue ?? 'false')) continue;
      attrs += value ? ` ${prop.name}` : ` ${prop.name}={false}`;
    } else if (value !== '' || prop.required) attrs += ` ${prop.name}=${attrText(value)}`;
  }
  const content = children.split('\n').map(line => (/[{}<>&]/.test(line) ? `{${JSON.stringify(line)}}` : line)).join('<br />');
  return content ? `<${info.name}${attrs}>${content}</${info.name}>` : `<${info.name}${attrs} />`;
}

function vueUsageFor(info: ComponentInfo, values: Record<string, PlaygroundValue>): string {
  let attrs = '';
  let children = '';
  for (const prop of info.props) {
    const value = values[prop.name];
    if (value === undefined || prop.kind === 'slot') continue;
    if (isLabel(prop)) {
      children = String(value);
      continue;
    }
    if (prop.kind === 'variant') {
      const literal = String(value);
      if (literal === prop.defaultValue) continue;
      attrs += literal === 'true' ? ` ${prop.name}` : literal === 'false' || /^-?\d/.test(literal) ? ` :${prop.name}="${literal}"` : ` ${prop.name}="${attrValue(literal.replace(/^'|'$/g, ''))}"`;
    } else if (typeof value === 'boolean') {
      if (String(value) === (prop.defaultValue ?? 'false')) continue;
      attrs += value ? ` ${prop.name}` : ` :${prop.name}="false"`;
    } else if (value !== '' || prop.required) attrs += ` ${prop.name}="${attrValue(value)}"`;
  }
  const content = children.split('\n').map(line => vueText(line)).join('<br />');
  return content ? `<${info.name}${attrs}>${content}</${info.name}>` : `<${info.name}${attrs} />`;
}

// ── The CSS as a list ──────────────────────────────────────────────────────────────────────────

const GROUP_TITLES: Record<CssGroup, string> = {layout: 'Auto layout', position: 'Position', size: 'Size', item: 'Inside auto layout', visual: 'Appearance', text: 'Text'};
const ORDER: CssGroup[] = ['layout', 'position', 'size', 'item', 'visual', 'text'];

/** The layer's CSS declarations by group, each a row that copies `prop: value;` (Figma's List view of the code). */
export function cssList(doc: DesignDocument, id: NodeId, options: {format?: CodeFormat; fontFallback?: (family: string) => string | undefined; suggest?: boolean} = {}): {title: string; rows: Measure[]}[] {
  const decls: Decl[] = nodeToCss(doc, id, {fontFallback: options.fontFallback, suggest: options.suggest});
  return ORDER.map(group => ({
    title: GROUP_TITLES[group],
    rows: decls.filter(decl => decl.group === group).map(decl => {
      const value = formatValue(decl.prop, decl.value, options.format);
      return {label: decl.prop, value, copy: `${decl.prop}: ${value};`};
    }),
  })).filter(group => group.rows.length);
}
