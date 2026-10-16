import type {Decl} from './css';
import {formatValue, type CodeFormat} from './format';
import {slugName} from './names';
import type {Token, TokenTable} from './tokens';

// Declarations as Tailwind CSS 4 utilities, the way a Tailwind codebase writes them: the scale where a value sits on
// it (p-4 is 16px, size-10 is 40px, rounded-full is a circle), the theme where a token is (bg-brand-500, shadow-card,
// text-heading-h1 for a whole text style, font-family-inter), arbitrary values only for what has neither
// (w-[393px]), and an arbitrary property ([backdrop-filter:blur(4px)]) for what has no utility. What preflight already
// does (margins, border-box, a button's border and background) is never repeated. The theme the classes rely on is
// written by `tailwindTheme` (tokens.ts) into src/theme.css.

export type TailwindOptions = {
  /** CSS names of the colour tokens (`color-brand-500`), the theme's colours. */
  colorTokens?: ReadonlySet<string>;
  tokens?: TokenTable;
  format?: CodeFormat;
  /** Families the classes use, filled while mapping: family → its theme name (`inter` for `font-family-inter`). */
  families?: Map<string, string>;
  /** The family that is the theme's sans (CSS, as `font-family` writes it): texts in it need no class. */
  baseFamily?: string | null;
};

/** Spaces become underscores inside arbitrary values; real underscores are escaped. */
const arbitrary = (value: string) => value.replace(/_/g, '\\_').replace(/\s+/g, '_');

const PX = /^(-?\d+(?:\.\d+)?)px$/;
const TOKEN = /^var\(--([a-z0-9-]+)\)$/;

/** A length on Tailwind's 4px spacing scale (multiples of 2px give whole or half steps), else null. */
function step(value: string): string | null {
  if (value === '0') return '0';
  const match = PX.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 && Number.isInteger(n) && n % 2 === 0 ? String(n / 4) : null;
}

const RADII: Record<string, string> = {'2px': 'xs', '4px': 'sm', '6px': 'md', '8px': 'lg', '12px': 'xl', '16px': '2xl', '24px': '3xl', '32px': '4xl', '50%': 'full', '9999px': 'full'};
const WEIGHTS: Record<string, string> = {'100': 'thin', '200': 'extralight', '300': 'light', '400': 'normal', '500': 'medium', '600': 'semibold', '700': 'bold', '800': 'extrabold', '900': 'black'};
const BLEND = new Set(['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
const JUSTIFY: Record<string, string> = {'flex-start': 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', 'space-between': 'justify-between'};
const ITEMS: Record<string, string> = {'flex-start': 'items-start', center: 'items-center', 'flex-end': 'items-end', baseline: 'items-baseline', stretch: 'items-stretch'};
const CONTENT: Record<string, string> = {'flex-start': 'content-start', 'space-between': 'content-between'};

/** What Tailwind's preflight already sets: a declaration with this value says nothing in a Tailwind project. */
const PREFLIGHT: Record<string, string[]> = {margin: ['0'], 'box-sizing': ['border-box'], border: ['0', 'none'], background: ['none'], font: ['inherit'], color: ['inherit'], padding: [], 'text-decoration': []};

class Mapper {
  constructor(private readonly options: TailwindOptions) {}

  private arb(prop: string, value: string): string {
    return arbitrary(formatValue(prop, value, this.options.format));
  }

  private tokenOf(name: string): Token | undefined {
    return this.options.tokens?.tokens.find(token => token.name === name);
  }

  /** A colour utility: the theme's colour for a colour token, the variable for another token, an arbitrary value otherwise. */
  color(prefix: string, value: string): string {
    const token = TOKEN.exec(value);
    if (token && this.options.colorTokens?.has(token[1])) return `${prefix}-${token[1].replace(/^color-/, '')}`;
    if (token) return `${prefix}-(--${token[1]})`;
    return `${prefix}-[${this.arb('color', value)}]`;
  }

  /** A spacing utility (p-4, gap-2), the variable of a token, or an arbitrary length. */
  space(prefix: string, value: string): string {
    const scaled = step(value);
    if (scaled !== null) return `${prefix}-${scaled}`;
    const token = TOKEN.exec(value);
    if (token) return `${prefix}-(--${token[1]})`;
    if (value.startsWith('-') && step(value.slice(1))) return `-${prefix}-${step(value.slice(1))}`;
    return `${prefix}-[${this.arb('padding', value)}]`;
  }

  length(prefix: string, value: string): string {
    if (value === '100%') return `${prefix}-full`;
    if (value === 'fit-content') return `${prefix}-fit`;
    if (value === '100dvh') return `${prefix}-dvh`;
    return this.space(prefix, value);
  }

  sides(prefix: string, value: string): string[] {
    const parts = value.split(/\s+(?![^(]*\))/);
    const [t, r = t, b = t, l = r] = parts;
    if (t === r && r === b && b === l) return [this.space(prefix, t)];
    if (t === b && r === l) return [this.space(`${prefix}x`, r), this.space(`${prefix}y`, t)];
    if (r === l) return [this.space(`${prefix}x`, r), this.space(`${prefix}t`, t), this.space(`${prefix}b`, b)];
    return [this.space(`${prefix}t`, t), this.space(`${prefix}r`, r), this.space(`${prefix}b`, b), this.space(`${prefix}l`, l)];
  }

  corners(value: string): string[] {
    const radius = (prefix: string, v: string) => {
      if (RADII[v]) return `${prefix}-${RADII[v]}`;
      const token = TOKEN.exec(v);
      return token ? `${prefix}-(--${token[1]})` : `${prefix}-[${this.arb('border-radius', v)}]`;
    };
    const parts = value.split(/\s+(?![^(]*\))/);
    if (parts.length === 1) return [radius('rounded', value)];
    const [tl, tr = tl, br = tl, bl = tr] = parts;
    if (tl === tr && br === bl) return [radius('rounded-t', tl), ...(br !== '0' ? [radius('rounded-b', br)] : [])].filter(name => !name.endsWith('-[0]'));
    return ([['tl', tl], ['tr', tr], ['br', br], ['bl', bl]] as const).filter(([, v]) => v !== '0').map(([corner, v]) => radius(`rounded-${corner}`, v));
  }

  /** `1px solid #E5E7EB` as width, style and colour utilities (`border-b`, `border-dashed`, `border-neutral-200`). */
  border(prefix: string, value: string): string[] {
    const match = /^(\S+)\s+(solid|dashed|dotted)\s+(.+)$/.exec(value);
    if (!match) return [`[${prefix}:${this.arb(prefix, value)}]`];
    const [, width, style, colour] = match;
    const side = prefix === 'border' ? '' : `-${prefix.slice('border-'.length)[0]}`;
    const widthClass = width === '1px' ? `border${side}` : PX.test(width) && Number.isInteger(Number(PX.exec(width)![1])) ? `border${side}-${PX.exec(width)![1]}` : `border${side}-[${width}]`;
    return [widthClass, ...(style === 'solid' ? [] : [`border-${style}`]), this.color('border', colour)];
  }

  /** Shadows: tokens from the theme (shadow-card), an inside stroke as inset-ring, the rest arbitrary. */
  shadow(value: string): string[] {
    // No shadow: the shadow and the inside stroke are separate utilities, so both go.
    if (value === 'none') return ['shadow-none', 'inset-ring-0'];
    const out: string[] = [];
    const rest: string[] = [];
    for (const part of value.split(/,(?![^(]*\))/).map(part => part.trim())) {
      const token = TOKEN.exec(part);
      const ring = /^inset 0 0 0 (\S+) (.+)$/.exec(part);
      if (token && this.tokenOf(token[1])?.kind === 'shadow') out.push(`shadow-${token[1].replace(/^shadow-/, '')}`);
      else if (ring) out.push(ring[1] === '1px' ? 'inset-ring' : /^\d+px$/.test(ring[1]) ? `inset-ring-${PX.exec(ring[1])![1]}` : `inset-ring-[${ring[1]}]`, this.color('inset-ring', ring[2]));
      else rest.push(part);
    }
    if (rest.length) out.push(`shadow-[${this.arb('box-shadow', rest.join(', '))}]`);
    return out;
  }

  /** A whole text style: its family and the theme's text size, which carries its line height, weight and tracking. */
  font(value: string): string[] {
    const token = TOKEN.exec(value);
    const style = token ? this.tokenOf(token[1]) : undefined;
    if (!style?.text) return [`[font:${this.arb('font', value)}]`];
    return [...this.family(style.text.family, style.text.familyCss), `text-${style.name.replace(/^font-/, '')}`, ...(style.text.italic ? ['italic'] : [])];
  }

  /** A family's class, none for the theme's sans. */
  family(family: string, css: string): string[] {
    if (css === this.options.baseFamily) return [];
    const slug = slugName(family, 'family');
    this.options.families?.set(css, slug);
    return [`font-family-${slug}`];
  }

  map(decl: Decl): string[] {
    const {prop, value} = decl;
    const token = TOKEN.exec(value);
    switch (prop) {
      case 'display': return [value === 'flex' ? 'flex' : value === 'inline-flex' ? 'inline-flex' : value === 'grid' ? 'grid' : value === 'inline-grid' ? 'inline-grid' : value === 'none' ? 'hidden' : value === 'block' ? 'block' : value === '-webkit-box' ? '[display:-webkit-box]' : `[display:${arbitrary(value)}]`];
      case 'grid-template-columns': return [`grid-cols-[${arbitrary(value)}]`];
      case 'grid-template-rows': return [`grid-rows-[${arbitrary(value)}]`];
      case 'grid-row': return [`row-[${arbitrary(value)}]`];
      case 'grid-column': return [`col-[${arbitrary(value)}]`];
      case 'justify-self': return [`justify-self-${value}`];
      case 'flex-direction': return [value === 'column' ? 'flex-col' : 'flex-row'];
      case 'flex-wrap': return [value === 'wrap' ? 'flex-wrap' : 'flex-nowrap'];
      case 'justify-content': return [JUSTIFY[value] ?? `[justify-content:${arbitrary(value)}]`];
      case 'align-items': return [ITEMS[value] ?? `[align-items:${arbitrary(value)}]`];
      case 'align-content': return [CONTENT[value] ?? `[align-content:${arbitrary(value)}]`];
      case 'align-self': return [value === 'stretch' ? 'self-stretch' : value === 'start' || value === 'center' || value === 'end' ? `self-${value}` : `self-[${arbitrary(value)}]`];
      case 'gap': {
        const [row, column] = value.split(/\s+(?![^(]*\))/);
        return column === undefined ? [this.space('gap', row)] : [this.space('gap-y', row), this.space('gap-x', column)];
      }
      case 'padding': return this.sides('p', value);
      case 'padding-left': return [this.space('pl', value)];
      case 'margin': return value === '0' ? ['m-0'] : this.sides('m', value);
      case 'margin-inline': return [value === 'auto' ? 'mx-auto' : this.space('mx', value)];
      case 'flex': return [value === 'none' ? 'flex-none' : value === '1' || value === '1 0 0' ? 'flex-1' : `flex-[${arbitrary(value)}]`];
      case 'flex-shrink': return [value === '0' ? 'shrink-0' : `shrink-[${value}]`];
      case 'position': return [value];
      case 'left': case 'right': case 'top': case 'bottom': return [this.length(prop, value)];
      case 'width': return [this.length('w', value)];
      case 'height': return [this.length('h', value)];
      case 'min-width': return [this.length('min-w', value)];
      case 'max-width': return [this.length('max-w', value)];
      case 'min-height': return [this.length('min-h', value)];
      case 'max-height': return [this.length('max-h', value)];
      case 'box-sizing': return [value === 'border-box' ? 'box-border' : 'box-content'];
      case 'background': {
        if (value === 'none') return ['bg-transparent'];
        if (token || /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(value)) return [this.color('bg', value)];
        return [`bg-[${this.arb('background', value)}]`];
      }
      case 'color': return value === 'inherit' ? ['text-inherit'] : value === 'transparent' ? ['text-transparent'] : [this.color('text', value)];
      case 'border-radius': return this.corners(value);
      case 'border': return value === '0' || value === 'none' ? ['border-0'] : this.border('border', value);
      case 'border-top': case 'border-right': case 'border-bottom': case 'border-left': return this.border(prop, value);
      case 'border-style': return [`border-${value}`];
      case 'border-width': {
        const [t, r = t, b = t, l = r] = value.split(/\s+/);
        const width = (side: string, v: string) => (v === '1px' ? `border-${side}` : PX.test(v) && Number.isInteger(Number(PX.exec(v)![1])) ? `border-${side}-${PX.exec(v)![1]}` : `border-${side}-[${v}]`);
        return ([['t', t], ['r', r], ['b', b], ['l', l]] as const).filter(([, v]) => v !== '0').map(([side, v]) => width(side, v));
      }
      case 'border-color': return [this.color('border', value)];
      case 'outline': {
        if (value === 'none') return ['outline-none'];
        const match = /^(\S+)\s+(solid|dashed|dotted)\s+(.+)$/.exec(value);
        if (!match) return [`[outline:${this.arb('outline', value)}]`];
        return [match[1] === '1px' ? 'outline' : `outline-${PX.exec(match[1])?.[1] ?? `[${match[1]}]`}`, ...(match[2] === 'solid' ? [] : [`outline-${match[2]}`]), this.color('outline', match[3])];
      }
      case 'outline-offset': return [/^-/.test(value) ? `-outline-offset-${PX.exec(value.slice(1))?.[1] ?? `[${value.slice(1)}]`}` : `outline-offset-${PX.exec(value)?.[1] ?? `[${value}]`}`];
      case 'opacity': {
        const n = Number(value);
        return Number.isFinite(n) && Math.round(n * 100) % 5 === 0 ? [`opacity-${Math.round(n * 100)}`] : [`opacity-[${arbitrary(value)}]`];
      }
      case 'mix-blend-mode': return [BLEND.has(value) ? `mix-blend-${value}` : `mix-blend-[${arbitrary(value)}]`];
      case 'overflow': return [`overflow-${value}`];
      case 'box-shadow': return this.shadow(value);
      case 'text-shadow': return [`[text-shadow:${this.arb('text-shadow', value)}]`];
      case 'filter': return /^blur\(([^)]+)\)$/.test(value) ? [`blur-[${/^blur\(([^)]+)\)$/.exec(value)![1]}]`] : [`[filter:${arbitrary(value)}]`];
      case 'backdrop-filter': return /^blur\(([^)]+)\)$/.test(value) ? [`backdrop-blur-[${/^blur\(([^)]+)\)$/.exec(value)![1]}]`] : [`[backdrop-filter:${arbitrary(value)}]`];
      case '-webkit-backdrop-filter': return [];
      case 'font': return this.font(value);
      case 'font-family': {
        const family = /^'((?:[^'\\]|\\.)*)'/.exec(value)?.[1]?.replace(/\\(.)/g, '$1');
        return family ? this.family(family, value) : [`font-[${arbitrary(value)}]`];
      }
      case 'font-weight': return [WEIGHTS[value] ? `font-${WEIGHTS[value]}` : `font-[${arbitrary(value)}]`];
      case 'font-size': return [token ? `text-(length:--${token[1]})` : `text-[${this.arb('font-size', value)}]`];
      case 'font-style': return [value === 'italic' ? 'italic' : 'not-italic'];
      case 'line-height': return [token ? `leading-(--${token[1]})` : `leading-[${this.arb('line-height', value)}]`];
      case 'letter-spacing': {
        // A text style's tracking travels with its text size (the theme's --text-*--letter-spacing).
        if (token && this.tokenOf(token[1])?.kind === 'tracking') return [];
        return [token ? `tracking-(--${token[1]})` : `tracking-[${arbitrary(value)}]`];
      }
      case 'text-align': return [value === 'inherit' ? '[text-align:inherit]' : `text-${value}`];
      case 'text-transform': return [value === 'none' ? 'normal-case' : value];
      case 'font-variant-caps': return [value === 'small-caps' ? '[font-variant-caps:small-caps]' : 'normal-nums'];
      case 'text-decoration': return [value === 'underline' ? 'underline' : value === 'line-through' ? 'line-through' : 'no-underline'];
      case 'white-space': return [`whitespace-${value}`];
      case 'text-overflow': return [value === 'ellipsis' ? 'text-ellipsis' : 'text-clip'];
      case '-webkit-line-clamp': return [`line-clamp-${value}`];
      case '-webkit-box-orient': return [];
      case 'cursor': return [`cursor-${value}`];
      case 'object-fit': return [`object-${value}`];
      case 'transform': return [`[transform:${arbitrary(value)}]`];
      default: return [`[${prop}:${this.arb(prop, value)}]`];
    }
  }
}

/** One declaration as utilities. */
export function declToTailwind(decl: Decl, options: TailwindOptions | ReadonlySet<string> = {}): string[] {
  const opts = options instanceof Set ? {colorTokens: options as ReadonlySet<string>} : options as TailwindOptions;
  if (decl.reset && PREFLIGHT[decl.prop]?.includes(decl.value)) return [];
  return new Mapper(opts).map(decl);
}

/** Declarations as one class string, in declaration order; a width and height that match become `size-*`, and a line
 *  clamp (display -webkit-box with overflow hidden) becomes `line-clamp-*` alone. */
export function tailwindClasses(decls: readonly Decl[], options: TailwindOptions | ReadonlySet<string> = {}): string {
  const opts = options instanceof Set ? {colorTokens: options as ReadonlySet<string>} : options as TailwindOptions;
  const mapper = new Mapper(opts);
  const width = decls.find(decl => decl.prop === 'width')?.value, height = decls.find(decl => decl.prop === 'height')?.value;
  const square = width !== undefined && width === height && step(width) !== null;
  const clamp = decls.some(decl => decl.prop === '-webkit-line-clamp');
  const out: string[] = [];
  for (const decl of decls) {
    if (decl.reset && PREFLIGHT[decl.prop]?.includes(decl.value)) continue;
    if (square && (decl.prop === 'width' || decl.prop === 'height')) {
      if (decl.prop === 'width') out.push(`size-${step(width!)}`);
      continue;
    }
    if (clamp && ((decl.prop === 'display' && decl.value === '-webkit-box') || decl.prop === 'overflow' || decl.prop === 'text-overflow')) continue;
    for (const name of mapper.map(decl)) if (!out.includes(name)) out.push(name);
  }
  return out.join(' ');
}
