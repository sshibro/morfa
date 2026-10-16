import type {DesignDocument, Effect, Paint, RGBA, Style, StyleId, TextStyle, Variable, VariableCollection, VariableId, VariableValue} from '../types';
import {PRODUCT_NAME} from '../product';
import {isAlias, variableUsage} from '../variables';
import {formatValue, type CodeFormat} from './format';
import {NameRegistry, camelCase, nameWords, slugName, valueName} from './names';
import {blurCss, color, fontFamilyCss, gradientCss, guessFallback, isVisiblePaint, letterSpacingCss, lineHeightCss, num, px, shadowCss} from './values';

// Design tokens (docs/design-tool.md §Design to code): local colour, text and effect styles and the
// variables of every collection become CSS custom properties in tokens.css and names in tokens.ts.
// A variable collection with several modes writes its default mode on :root and every other mode
// in a `[data-theme="…"]` block (a second collection with modes gets its own attribute, e.g.
// `data-density`), so a frame that picked a mode in the editor carries the same attribute in code.
// Layers bound to a style or a variable reference the token instead of repeating the value.

export type TokenKind = 'color' | 'gradient' | 'fill' | 'font' | 'tracking' | 'shadow' | 'blur' | 'number' | 'string' | 'boolean';

export type Token = {
  /** CSS custom property without the dashes: "color-brand-primary". Empty for booleans (tokens.ts only). */
  name: string;
  /** Key in tokens.ts: "colorBrandPrimary". */
  key: string;
  kind: TokenKind;
  /** The style or variable name as the designer wrote it. */
  original: string;
  /** CSS value in the default mode. */
  value: string;
  /** Other modes: attribute value → CSS value. */
  modes: {mode: string; attribute: string; value: string}[];
  description: string;
  source: {type: 'style'; id: StyleId} | {type: 'variable'; id: VariableId; collectionId: string};
  /** A text style's parts, for Tailwind's text sizes (`--text-h1`, `--text-h1--line-height`…). */
  text?: {family: string; familyCss: string; size: string; lineHeight: string | null; weight: string; tracking: string | null; italic: boolean};
};

export type ModeAttribute = {collectionId: string; collection: string; attribute: string; modes: Map<string, string>; defaultModeId: string};

export type TokenTable = {
  tokens: Token[];
  /** Style id → its main token (colour, gradient, font, shadow). */
  byStyle: Map<StyleId, Token>;
  /** Text style id → letter-spacing token, when the style has tracking. */
  trackingByStyle: Map<StyleId, Token>;
  /** Effect style id → blur token, when the style blurs. */
  blurByStyle: Map<StyleId, Token>;
  byVariable: Map<VariableId, Token>;
  /** Collections with more than one mode: the attribute and each mode's value. */
  modeAttributes: Map<string, ModeAttribute>;
  /** A raw colour → the colour tokens with exactly that value (Figma's "suggested variables"), when suggestions are on. */
  suggested?: ReadonlyMap<string, readonly Token[]>;
};

export const EMPTY_TOKENS: TokenTable = {tokens: [], byStyle: new Map(), trackingByStyle: new Map(), blurByStyle: new Map(), byVariable: new Map(), modeAttributes: new Map()};

export type TokenOptions = {fontFallback?: (family: string) => string | undefined};

/** Tables of one set of document tables: without a font fallback, and per fallback function. */
type Cached = {plain?: TokenTable; byFallback: WeakMap<NonNullable<TokenOptions['fontFallback']>, TokenTable>};
const cache = new WeakMap<object, WeakMap<object, WeakMap<object, Cached>>>();

/** The tokens of a document; cached while its styles, variables and collections stay the same (and per font fallback: the
 *  editor passes one function, so "Code" builds the table once, not on every change to the file). */
export function collectTokens(doc: DesignDocument, options: TokenOptions = {}): TokenTable {
  let byStyles = cache.get(doc.styles);
  if (!byStyles) cache.set(doc.styles, byStyles = new WeakMap());
  let byVariables = byStyles.get(doc.variables);
  if (!byVariables) byStyles.set(doc.variables, byVariables = new WeakMap());
  let cached = byVariables.get(doc.variableCollections);
  if (!cached) byVariables.set(doc.variableCollections, cached = {byFallback: new WeakMap()});
  const fallback = options.fontFallback;
  const hit = fallback ? cached.byFallback.get(fallback) : cached.plain;
  if (hit) return hit;
  const table = buildTokens(doc, options);
  if (fallback) cached.byFallback.set(fallback, table);
  else cached.plain = table;
  return table;
}

const suggestions = new WeakMap<TokenTable, TokenTable>();

/** The table with suggestions: a layer whose raw colour equals a colour token's value (the designer did not bind it)
 *  is written as that token, as Figma's Dev Mode suggests the variable (css.ts `suggestedColor` picks among several). */
export function suggestTokens(table: TokenTable): TokenTable {
  let out = suggestions.get(table);
  if (!out) {
    const byValue = new Map<string, Token[]>();
    for (const token of table.tokens) {
      if (token.kind !== 'color' || !token.name || !/^(#[0-9A-F]{6}|rgba\()/i.test(token.value)) continue;
      const list = byValue.get(token.value);
      if (list) list.push(token);
      else byValue.set(token.value, [token]);
    }
    out = {...table, suggested: byValue};
    suggestions.set(table, out);
  }
  return out;
}

const PREFIX_SYNONYMS: Record<string, string[]> = {
  color: ['color', 'colors'],
  font: ['font', 'fonts', 'text', 'type', 'typography'],
  shadow: ['shadow', 'shadows', 'effect', 'effects'],
  blur: ['blur'],
  gradient: ['gradient', 'gradients'],
};

function prefixed(prefix: string, words: string[]): string[] {
  if (!prefix) return words;
  const synonyms = PREFIX_SYNONYMS[prefix] ?? [prefix];
  const rest = words[0] && synonyms.includes(words[0]) ? words.slice(1) : words;
  return [prefix, ...rest];
}

const fallbackFor = (options: TokenOptions) => (family: string) => options.fontFallback?.(family) ?? guessFallback(family);

/** `font` shorthand of a text style: "italic 600 32px/40px 'Inter', sans-serif". */
export function fontShorthand(style: Pick<TextStyle, 'italic' | 'fontWeight' | 'fontSize' | 'lineHeight' | 'fontFamily'>, fallback: (family: string) => string): string {
  const lineHeight = lineHeightCss(style.lineHeight) ?? 'normal';
  return [style.italic ? 'italic' : '', String(style.fontWeight), `${px(style.fontSize)}/${lineHeight}`, fontFamilyCss(style.fontFamily, fallback(style.fontFamily))].filter(Boolean).join(' ');
}

/** CSS for a fill style's paints: a colour for one solid paint, else a background value. */
export function paintsCss(paints: readonly Paint[], width = 100, height = 100): {kind: 'color' | 'gradient' | 'fill'; value: string} | null {
  const visible = paints.filter(isVisiblePaint);
  if (!visible.length) return null;
  if (visible.length === 1 && visible[0].type === 'SOLID') return {kind: 'color', value: color(visible[0].color, visible[0].opacity)};
  const layers = [...visible].reverse().map(paint => {
    if (paint.type === 'SOLID') {
      const c = color(paint.color, paint.opacity);
      return `linear-gradient(${c}, ${c})`;
    }
    if (paint.type === 'IMAGE') return null;
    return gradientCss(paint, width, height);
  }).filter((layer): layer is string => !!layer);
  if (!layers.length) return null;
  return {kind: visible.some(p => p.type === 'SOLID') || layers.length > 1 ? 'fill' : 'gradient', value: layers.join(', ')};
}

export function effectsCss(effects: readonly Effect[]): {shadow: string | null; blur: string | null} {
  const visible = effects.filter(e => e.visible !== false);
  const shadows = visible.filter((e): e is Extract<Effect, {type: 'DROP_SHADOW' | 'INNER_SHADOW'}> => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
  const blur = visible.find(e => e.type === 'LAYER_BLUR');
  return {shadow: shadows.length ? [...shadows].reverse().map(e => shadowCss(e)).join(', ') : null, blur: blur ? blurCss(blur.radius) : null};
}

/** Number variables bound only to weights or opacity are unitless; every other number is px. */
function floatUnit(doc: DesignDocument, variable: Variable): '' | 'px' {
  const nodes = variableUsage(doc).byVariable.get(variable.id);
  const fields = new Set<string>();
  for (const id of nodes ?? []) {
    for (const [field, alias] of Object.entries(doc.nodes[id]?.boundVariables ?? {})) if (alias?.id === variable.id) fields.add(field);
  }
  if (fields.size) return [...fields].every(field => field === 'fontWeight' || field === 'opacity') ? '' : 'px';
  return /weight|opacity|z-?index|ratio|scale|count|columns?|order|flex|duration|вес|насыщенн|прозрачн/i.test(variable.name) ? '' : 'px';
}

function buildTokens(doc: DesignDocument, options: TokenOptions): TokenTable {
  const fallback = fallbackFor(options);
  const cssNames = new NameRegistry();
  const keys = new NameRegistry();
  const table: TokenTable = {tokens: [], byStyle: new Map(), trackingByStyle: new Map(), blurByStyle: new Map(), byVariable: new Map(), modeAttributes: new Map()};
  const add = (prefix: string, words: string[], token: Omit<Token, 'name' | 'key'>): Token => {
    const all = prefixed(prefix, words.length ? words : ['token']);
    const name = cssNames.claim(all.join('-'));
    const key = keys.claim(camelCase(name.split('-')));
    const full = {...token, name, key};
    table.tokens.push(full);
    return full;
  };

  // Styles, sorted by name so the file reads like the styles panel.
  const styles = Object.values(doc.styles).sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
  for (const style of styles) addStyle(style);

  function addStyle(style: Style) {
    const words = nameWords(style.name);
    const base = {original: style.name, modes: [], description: style.description ?? '', source: {type: 'style', id: style.id} as const};
    if (style.type === 'FILL' && style.paints) {
      const css = paintsCss(style.paints);
      if (css) table.byStyle.set(style.id, add(css.kind === 'color' ? 'color' : css.kind === 'gradient' ? 'gradient' : 'fill', words, {...base, kind: css.kind, value: css.value}));
    } else if (style.type === 'TEXT' && style.text) {
      const t = style.text;
      table.byStyle.set(style.id, add('font', words, {...base, kind: 'font', value: fontShorthand(t, fallback), text: {
        family: t.fontFamily, familyCss: fontFamilyCss(t.fontFamily, fallback(t.fontFamily)), size: px(t.fontSize), lineHeight: lineHeightCss(t.lineHeight), weight: String(t.fontWeight), tracking: letterSpacingCss(t.letterSpacing), italic: t.italic,
      }}));
      const tracking = letterSpacingCss(style.text.letterSpacing);
      if (tracking) table.trackingByStyle.set(style.id, add('font', [...words, 'tracking'], {...base, kind: 'tracking', value: tracking}));
    } else if (style.type === 'EFFECT' && style.effects) {
      const css = effectsCss(style.effects);
      if (css.shadow) table.byStyle.set(style.id, add('shadow', words, {...base, kind: 'shadow', value: css.shadow}));
      if (css.blur) table.blurByStyle.set(style.id, add('blur', words, {...base, kind: 'blur', value: css.blur}));
    }
  }

  // Mode attributes: the first collection with modes gets data-theme, the others their own name.
  const collections = Object.values(doc.variableCollections);
  const attributes = new NameRegistry(['data-theme']);
  let themeTaken = false;
  for (const collection of collections) {
    if (collection.modes.length < 2) continue;
    const attribute = themeTaken ? attributes.claim(`data-${slugName(collection.name, 'mode')}`) : 'data-theme';
    themeTaken = true;
    const values = new NameRegistry();
    const modes = new Map<string, string>();
    for (const mode of collection.modes) modes.set(mode.modeId, values.claim(valueName(mode.name, 'mode').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()));
    table.modeAttributes.set(collection.id, {collectionId: collection.id, collection: collection.name, attribute, modes, defaultModeId: collection.defaultModeId});
  }

  // Variables in collection order, then each collection's own order.
  const ordered: {variable: Variable; collection: VariableCollection | undefined}[] = [];
  const seen = new Set<VariableId>();
  for (const collection of collections) {
    for (const id of collection.variableIds) {
      const variable = doc.variables[id];
      if (variable && !seen.has(id)) { ordered.push({variable, collection}); seen.add(id); }
    }
  }
  for (const variable of Object.values(doc.variables)) if (!seen.has(variable.id)) ordered.push({variable, collection: doc.variableCollections[variable.collectionId]});

  // Names first (aliases need the target's name), values after.
  const pending: {token: Token; variable: Variable; collection: VariableCollection | undefined; unit: '' | 'px'}[] = [];
  for (const {variable, collection} of ordered) {
    const words = nameWords(variable.name);
    const unit = variable.type === 'FLOAT' ? floatUnit(doc, variable) : 'px';
    const kind: TokenKind = variable.type === 'COLOR' ? 'color' : variable.type === 'FLOAT' ? 'number' : variable.type === 'STRING' ? 'string' : 'boolean';
    const prefix = variable.type === 'COLOR' ? 'color' : words[0] && /^[0-9]/.test(words[0]) ? (variable.type === 'FLOAT' ? 'size' : 'value') : '';
    const base: Omit<Token, 'name' | 'key'> = {kind, original: variable.name, value: '', modes: [], description: variable.description ?? '', source: {type: 'variable', id: variable.id, collectionId: variable.collectionId}};
    let token: Token;
    if (variable.type === 'BOOLEAN') {
      const key = keys.claim(camelCase(prefixed(prefix, words.length ? words : ['flag'])));
      token = {...base, name: '', key};
      table.tokens.push(token);
    } else token = add(prefix, words, base);
    table.byVariable.set(variable.id, token);
    pending.push({token, variable, collection, unit});
  }
  for (const {token, variable, collection, unit} of pending) {
    const valueIn = (modeId: string | undefined): string => {
      const raw: VariableValue | undefined = (modeId !== undefined ? variable.valuesByMode[modeId] : undefined) ?? Object.values(variable.valuesByMode)[0];
      return variableCss(doc, table, variable, raw, unit);
    };
    token.value = valueIn(collection?.defaultModeId);
    const attribute = collection ? table.modeAttributes.get(collection.id) : undefined;
    if (attribute && collection) {
      for (const mode of collection.modes) {
        if (mode.modeId === collection.defaultModeId) continue;
        const value = valueIn(mode.modeId);
        if (value !== token.value) token.modes.push({mode: mode.name, attribute: attribute.modes.get(mode.modeId)!, value});
      }
    }
  }
  return table;
}

function variableCss(doc: DesignDocument, table: TokenTable, variable: Variable, raw: VariableValue | undefined, unit: '' | 'px'): string {
  if (raw === undefined) return variable.type === 'BOOLEAN' ? 'false' : variable.type === 'COLOR' ? 'transparent' : '0';
  if (isAlias(raw)) {
    const target = table.byVariable.get(raw.id);
    if (target?.name) return `var(--${target.name})`;
    const resolved = doc.variables[raw.id];
    return resolved && resolved.id !== variable.id ? variableCss(doc, table, resolved, Object.values(resolved.valuesByMode)[0], unit) : '0';
  }
  switch (variable.type) {
    case 'COLOR': {
      const rgba = raw as RGBA;
      return color(rgba, rgba.a);
    }
    case 'FLOAT': return unit === 'px' ? px(raw as number) : num(raw as number, 3);
    case 'STRING': return JSON.stringify(String(raw));
    case 'BOOLEAN': return String(raw);
  }
}

// ── Files ──────────────────────────────────────────────────────────────────────────────────────

const comment = (text: string) => text.replace(/\*\//g, '* /');

/** tokens.css: `:root` with every token, then a block per extra mode. Empty string without tokens. */
export function tokensCss(table: TokenTable, options: {title?: string; format?: CodeFormat} = {}): string {
  const cssTokens = table.tokens.filter(token => token.name);
  if (!cssTokens.length) return '';
  const lines: string[] = [`/* Design tokens${options.title ? ` of the file "${comment(options.title)}"` : ''}: styles and variables from ${PRODUCT_NAME}. */`, ':root {'];
  for (const token of cssTokens) {
    lines.push(`  --${token.name}: ${formatValue(token.kind === 'font' ? 'font' : token.kind === 'shadow' ? 'box-shadow' : '', token.value, options.format)};${token.original ? ` /* ${comment(token.original)} */` : ''}`);
  }
  lines.push('}');
  for (const attribute of table.modeAttributes.values()) {
    for (const [modeId, value] of attribute.modes) {
      if (modeId === attribute.defaultModeId) continue;
      const entries = cssTokens.flatMap(token => (token.source.type === 'variable' && token.source.collectionId === attribute.collectionId ? token.modes.filter(mode => mode.attribute === value) : []).map(mode => `  --${token.name}: ${formatValue('', mode.value, options.format)};`));
      if (!entries.length) continue;
      lines.push('', `[${attribute.attribute}='${value}'] {`, ...entries, '}');
    }
  }
  return lines.join('\n') + '\n';
}

/** tokens.ts: the token names for TypeScript, the default values, and the modes. */
export function tokensTs(table: TokenTable): string {
  const cssTokens = table.tokens.filter(token => token.name);
  const flags = table.tokens.filter(token => !token.name);
  const lines = ['// Design tokens: CSS variables from tokens.css. The values are in the default mode.', ''];
  lines.push('export const tokens = {');
  for (const token of cssTokens) lines.push(`  /** ${comment(token.original)} */`, `  ${token.key}: 'var(--${token.name})',`);
  lines.push('} as const;', '', 'export type TokenName = keyof typeof tokens;', '');
  lines.push('export const tokenValues: Record<TokenName, string> = {');
  for (const token of cssTokens) lines.push(`  ${token.key}: ${JSON.stringify(token.value)},`);
  lines.push('};');
  if (flags.length) {
    lines.push('', 'export const flags = {');
    for (const token of flags) lines.push(`  /** ${comment(token.original)} */`, `  ${token.key}: ${token.value},`);
    lines.push('} as const;');
  }
  for (const attribute of table.modeAttributes.values()) {
    const name = camelCase(nameWords(attribute.attribute.replace(/^data-/, ''))) + 'Modes';
    lines.push('', `/** Modes of the collection "${comment(attribute.collection)}": the ${attribute.attribute} attribute. */`);
    lines.push(`export const ${name} = [${[...attribute.modes.values()].map(value => `'${value}'`).join(', ')}] as const;`);
  }
  return lines.join('\n') + '\n';
}

/** src/theme.css of a Tailwind project: the tokens in Tailwind's theme namespaces (colours, text styles as text sizes,
 *  shadows, the families the classes use), so `bg-brand-500`, `text-heading-h1`, `shadow-card` and `font-family-inter`
 *  exist; tokens with no namespace and the other modes of a collection stay plain custom properties. */
export function tailwindTheme(table: TokenTable, families: ReadonlyMap<string, string>, options: {format?: CodeFormat; sans?: string | null} = {}): string {
  const value = (prop: string, raw: string) => formatValue(prop, raw, options.format);
  const theme: string[] = [];
  const plain: string[] = [];
  for (const token of table.tokens) {
    if (!token.name) continue;
    const note = token.original ? ` /* ${comment(token.original)} */` : '';
    if (token.kind === 'color') theme.push(`  --${token.name}: ${value('color', token.value)};${note}`);
    else if (token.kind === 'shadow') theme.push(`  --${token.name}: ${value('box-shadow', token.value)};${note}`);
    else if (token.kind === 'font' && token.text) {
      const name = `text-${token.name.replace(/^font-/, '')}`;
      theme.push(`  --${name}: ${value('font-size', token.text.size)};${note}`);
      if (token.text.lineHeight) theme.push(`  --${name}--line-height: ${value('line-height', token.text.lineHeight)};`);
      theme.push(`  --${name}--font-weight: ${token.text.weight};`);
      if (token.text.tracking) theme.push(`  --${name}--letter-spacing: ${token.text.tracking};`);
      // The shorthand stays for CSS that reads it (and the family comes from its own class).
      plain.push(`  --${token.name}: ${value('font', token.value)};${note}`);
    } else if (token.kind !== 'tracking') plain.push(`  --${token.name}: ${value('', token.value)};${note}`);
  }
  // The family most texts use is the theme's sans: preflight sets it on the page, and no text names it.
  if (options.sans) theme.push(`  --font-sans: ${options.sans};`);
  for (const [css, slug] of [...families].sort((a, b) => a[1].localeCompare(b[1]))) theme.push(`  --font-family-${slug}: ${css};`);
  if (!theme.length && !plain.length) return '';
  const lines: string[] = [`/* Tailwind theme from the styles and variables of ${PRODUCT_NAME}: bg-*, text-*, shadow-* and font-family-* from these values. */`];
  if (theme.length) lines.push('@theme {', ...theme, '}');
  if (plain.length) lines.push('', ':root {', ...plain, '}');
  for (const attribute of table.modeAttributes.values()) {
    for (const [modeId, mode] of attribute.modes) {
      if (modeId === attribute.defaultModeId) continue;
      const entries = table.tokens.filter(token => token.name && token.source.type === 'variable' && token.source.collectionId === attribute.collectionId)
        .flatMap(token => token.modes.filter(entry => entry.attribute === mode).map(entry => `  --${token.name}: ${value('', entry.value)};`));
      if (entries.length) lines.push('', `[${attribute.attribute}='${mode}'] {`, ...entries, '}');
    }
  }
  return lines.join('\n') + '\n';
}
