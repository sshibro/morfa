import type {
  BlendMode, ColorStop, GradientPaint, ImagePaint, Matrix, NodeId, Paint, PathCommand, RGB, RGBA, SceneNode, StrokeCap, StrokeJoin, TextRun, TextStyle, Vec, VectorPath, WindingRule,
} from './types';
import {DEFAULT_FONT_FAMILY, createNode, defaultTextProps, newId} from './defaults';
import {DESIGN_FIELD_LIMITS} from './document-limits';
import {IDENTITY, apply, invert, localMatrix, multiply, rotationMatrix, scaling, transformRect, translation, unionRects} from './geometry';
import {ellipseArcCubics, parsePathData, pathBounds, pathsBounds, transformPath} from './paths';
import {layoutText, type TextMeasurer} from './text-layout';

// SVG → "Morfa" nodes. Pure: it reads a plain element tree (src/design/import/svg-dom.ts
// builds one from pasted or dropped text with DOMParser, never touching the page) and returns
// nodes made with createNode, ready for a transaction.
//
//   svg → FRAME (viewBox and preserveAspectRatio become the content transform, content clipped)
//   g, a, nested svg, use → GROUP or the copy itself; path/line/polyline/polygon → VECTOR;
//   rect, circle, ellipse → RECTANGLE/ELLIPSE when the transform keeps them exact, else VECTOR;
//   text/tspan → TEXT (basic: runs and lines); image with a data: URL → RECTANGLE with an IMAGE
//   fill whose upload the caller finishes (`images`); clip-path → a vector mask; mask → a
//   luminance (or alpha) mask group.
//
// Styles follow the cascade: inherited properties, presentation attributes, simple <style>
// rules (tag, .class, #id and their compounds), the style attribute, !important. Transforms are
// split into a rotation kept on the node and a scale/skew baked into its geometry.
//
// Hostile input is bounded: element visits, output nodes, `use` depth and cycles, path commands,
// stylesheet size and wall-clock time all have limits, and nothing outside the document is ever
// fetched: only same-document "#id" references and data:image URLs are followed.

/** A parsed SVG element as plain data. Text content appears as children with tag "#text". */
export type SvgNode = {tag: string; attrs: Record<string, string>; children: SvgNode[]; text?: string};

/** A picture to upload: put its ref into the IMAGE fill of `nodeId` (fills[0]) once stored. */
export type SvgImportImage = {nodeId: NodeId; dataUrl: string; mimeType: string};

export type SvgImportOptions = {
  /** Name of the frame (default from <title> or "SVG"). */
  name?: string;
  /** Parent and position of the frame; the caller may also set them afterwards. */
  parentId?: NodeId | null;
  x?: number;
  y?: number;
  /** Measures text so TEXT boxes and baselines match the editor; without it sizes are estimated. */
  measurer?: TextMeasurer;
  /** What `currentColor` means when the SVG never sets `color` (default black). */
  color?: RGB;
  /** Wall-clock budget in ms (default SVG_IMPORT_LIMITS.timeMs). */
  timeBudgetMs?: number;
};

export type SvgImportResult = {nodes: SceneNode[]; rootId: NodeId; images: SvgImportImage[]; warnings: string[]};

export const SVG_IMPORT_LIMITS = {
  /** Source text accepted by the DOM adapter. */
  inputBytes: 2 * 1024 * 1024,
  /** Elements the DOM adapter keeps, and how deep. */
  elements: 20_000,
  depth: 64,
  /** Nodes one import may create. */
  nodes: 20_000,
  /** Elements visited, counting every copy a `use` makes. */
  visits: 100_000,
  /** Nested `use` references. */
  useDepth: 8,
  /** Path commands over the whole import. */
  pathCommands: 1_000_000,
  styleBytes: 256 * 1024,
  styleRules: 2_000,
  timeMs: 3_000,
} as const;

export const SVG_WARNINGS = {
  remoteImage: 'External images are not loaded: paste the picture separately',
  imageSize: 'An image without dimensions was skipped',
  imageType: 'An image of this format was skipped',
  pattern: 'Patterns were replaced with a solid color or removed',
  filter: 'SVG filters were not imported',
  marker: 'SVG markers were not imported',
  textPath: 'Text on a path was imported as plain text',
  useDepth: 'References <use> that are nested too deeply were skipped',
  useCycle: 'A circular <use> reference was skipped',
  externalUse: 'References to other files were skipped',
  tooMany: 'The file is too large: only part of it was imported',
  time: 'Parsing took too long: only part of it was imported',
  unknown: 'Unknown elements were skipped',
  css: 'Complex CSS selectors are not supported',
} as const;

type Style = Record<string, string>;
type Built = {node: SceneNode; children?: Built[]};
type Ctx = {ctm: Matrix; style: Style; useDepth: number; chain: ReadonlySet<string>};
type Box = {x: number; y: number; width: number; height: number} | null;
/** A box, or how to get it: an element's bounds are only computed when a gradient needs them. */
type BoxSource = Box | (() => Box);
const boxOf = (source: BoxSource): Box => (typeof source === 'function' ? source() : source);

// ── CSS values ─────────────────────────────────────────────────────────────────────────────────

const INHERITED = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing',
  'visibility', 'clip-rule', 'text-decoration', 'xml:space', 'white-space', 'font-variant', 'text-transform',
]);
const PRESENTATION = new Set([
  ...INHERITED, 'opacity', 'display', 'clip-path', 'mask', 'mix-blend-mode', 'stop-color', 'stop-opacity', 'filter', 'vector-effect',
  'marker-start', 'marker-mid', 'marker-end', 'mask-type', 'font',
]);

const NAMED_COLORS: Record<string, string> = Object.fromEntries(
  ('aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd ' +
  'blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed ' +
  'cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 ' +
  'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f ' +
  'darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 ' +
  'dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 ' +
  'goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 ' +
  'khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff ' +
  'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa ' +
  'lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 ' +
  'magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 ' +
  'mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 ' +
  'moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 ' +
  'palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd ' +
  'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 ' +
  'seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
  'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff ' +
  'whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32').split(' ').map(entry => entry.split(':')),
);

const NUMBER_PATTERN = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Numbers in a list ("1, 2 3e1-4"), at most `max`. */
export function parseNumberList(value: string | undefined, max = 1_000_000): number[] {
  if (!value) return [];
  const out: number[] = [];
  for (const match of value.matchAll(NUMBER_PATTERN)) {
    if (out.length >= max) break;
    const n = Number(match[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** A CSS colour: #rgb[a], #rrggbb[aa], rgb()/rgba() (commas or spaces, percentages, "/ alpha"),
 *  hsl()/hsla(), the named colours and `transparent`. Null for anything else. */
export function parseColor(value: string): RGBA | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === 'transparent') return {r: 0, g: 0, b: 0, a: 0};
  const named = NAMED_COLORS[v];
  if (named) return parseColor('#' + named);
  if (v[0] === '#') {
    const hex = v.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const expand = hex.length === 3 || hex.length === 4 ? [...hex].map(c => c + c).join('') : hex;
    if (expand.length !== 6 && expand.length !== 8) return null;
    const channel = (k: number) => parseInt(expand.slice(k * 2, k * 2 + 2), 16) / 255;
    return {r: channel(0), g: channel(1), b: channel(2), a: expand.length === 8 ? channel(3) : 1};
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const alphaOf = (s: string | undefined) => (s === undefined ? 1 : s.endsWith('%') ? clamp01(parseFloat(s) / 100) : clamp01(parseFloat(s)));
  if (fn[1].startsWith('rgb')) {
    const ch = (s: string) => clamp01(s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s) / 255);
    const [r, g, b] = parts.slice(0, 3).map(ch);
    const a = alphaOf(parts[3]);
    return [r, g, b, a].every(Number.isFinite) ? {r, g, b, a} : null;
  }
  const hue = parts[0].endsWith('turn') ? parseFloat(parts[0]) * 360 : parts[0].endsWith('rad') ? (parseFloat(parts[0]) * 180) / Math.PI : parseFloat(parts[0]);
  const s = clamp01(parseFloat(parts[1]) / 100), l = clamp01(parseFloat(parts[2]) / 100), a = alphaOf(parts[3]);
  if (![hue, s, l, a].every(Number.isFinite)) return null;
  const k = (n: number) => (n + hue / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return {r: clamp01(f(0)), g: clamp01(f(8)), b: clamp01(f(4)), a};
}

/** An SVG transform list as a matrix; null when the list is malformed (SVG then ignores it). */
export function parseTransform(value: string | undefined): Matrix | null {
  if (!value || !value.trim()) return IDENTITY;
  let m: Matrix = IDENTITY;
  const pattern = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy;
  let consumed = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    consumed = pattern.lastIndex;
    const n = parseNumberList(match[2], 7);
    let t: Matrix;
    switch (match[1]) {
      case 'matrix': if (n.length !== 6) return null; t = [[n[0], n[2], n[4]], [n[1], n[3], n[5]]]; break;
      case 'translate': if (!n.length) return null; t = translation(n[0], n[1] ?? 0); break;
      case 'scale': if (!n.length) return null; t = scaling(n[0], n[1] ?? n[0]); break;
      case 'rotate': {
        if (!n.length) return null;
        const r = rotationMatrix((n[0] * Math.PI) / 180);
        t = n.length >= 3 ? multiply(multiply(translation(n[1], n[2]), r), translation(-n[1], -n[2])) : r;
        break;
      }
      case 'skewX': if (!n.length) return null; t = [[1, Math.tan((n[0] * Math.PI) / 180), 0], [0, 1, 0]]; break;
      default: if (!n.length) return null; t = [[1, 0, 0], [Math.tan((n[0] * Math.PI) / 180), 1, 0]];
    }
    m = multiply(m, t);
  }
  return value.slice(consumed).trim() ? null : m;
}

/** A length in px. `%` is of `reference`; em/ex follow `fontSize`. Null when unreadable. */
export function parseLength(value: string | undefined, reference = 0, fontSize = 16): number | null {
  if (value === undefined) return null;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|rem|%)?\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  switch ((match[2] ?? '').toLowerCase()) {
    case 'pt': return (n * 4) / 3;
    case 'pc': return n * 16;
    case 'mm': return (n * 96) / 25.4;
    case 'cm': return (n * 96) / 2.54;
    case 'in': return n * 96;
    case 'em': return n * fontSize;
    case 'ex': return (n * fontSize) / 2;
    case 'rem': return n * 16;
    case '%': return (n / 100) * reference;
    default: return n;
  }
}

/** "url(#id) fallback" → the id and the rest. */
function parseUrl(value: string): {id: string | null; external: boolean; rest: string} | null {
  const match = /^\s*url\(\s*(['"]?)([^'")]*)\1\s*\)\s*(.*)$/i.exec(value);
  if (!match) return null;
  const target = match[2].trim();
  return {id: target.startsWith('#') ? target.slice(1) : null, external: !target.startsWith('#'), rest: match[3].trim()};
}

// ── Stylesheets ────────────────────────────────────────────────────────────────────────────────

type Selector = {tag: string | null; id: string | null; classes: string[]; specificity: number};
type Declaration = {property: string; value: string; important: boolean};
type Rule = {selectors: Selector[]; declarations: Declaration[]; order: number};

/** Declarations of a style attribute or rule body ("fill: red; stroke: url(#a)"). */
export function parseDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  let depth = 0, quote = '', start = 0;
  const flush = (end: number) => {
    const part = text.slice(start, end);
    const colon = part.indexOf(':');
    if (colon > 0) {
      const property = part.slice(0, colon).trim().toLowerCase();
      let value = part.slice(colon + 1).trim();
      const important = /!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
      if (property && value) out.push({property, value, important});
    }
    start = end + 1;
  };
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && !depth) flush(k);
  }
  flush(text.length);
  return out;
}

function parseSelector(text: string): Selector | null {
  const s = text.trim();
  const match = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(s);
  if (!match || !s) return null;
  const tag = match[1] && match[1] !== '*' ? match[1] : null;
  let id: string | null = null;
  const classes: string[] = [];
  for (const part of match[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '#') id = part.slice(1);
    else classes.push(part.slice(1));
  }
  return {tag, id, classes, specificity: (id ? 10_000 : 0) + classes.length * 100 + (tag ? 1 : 0)};
}

/** Rules of a stylesheet that use simple selectors; @-blocks and anything else are skipped. */
function parseStylesheet(text: string, firstOrder: number, warn: (w: string) => void): Rule[] {
  const css = text.slice(0, SVG_IMPORT_LIMITS.styleBytes).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let k = 0;
  while (k < css.length && rules.length < SVG_IMPORT_LIMITS.styleRules) {
    while (k < css.length && /\s/.test(css[k])) k++;
    // A statement at-rule (@import, @charset, @namespace) ends at its semicolon, not at a block.
    if (css[k] === '@') {
      const semicolon = css.indexOf(';', k), brace = css.indexOf('{', k);
      if (semicolon >= 0 && (brace < 0 || semicolon < brace)) { k = semicolon + 1; continue; }
    }
    const open = css.indexOf('{', k);
    if (open < 0) break;
    const prelude = css.slice(k, open).trim();
    // Find the matching brace (blocks may nest inside @-rules).
    let depth = 1, close = open + 1;
    while (close < css.length && depth) {
      if (css[close] === '{') depth++;
      else if (css[close] === '}') depth--;
      close++;
    }
    const body = css.slice(open + 1, close - 1);
    k = close;
    if (prelude.startsWith('@') || body.includes('{')) continue;
    const parsed = prelude.split(',').map(parseSelector);
    if (parsed.some(s => !s)) warn(SVG_WARNINGS.css);
    const selectors = parsed.filter((s): s is Selector => !!s);
    if (selectors.length) rules.push({selectors, declarations: parseDeclarations(body), order: firstOrder + rules.length});
  }
  return rules;
}

// ── The importer ───────────────────────────────────────────────────────────────────────────────

const NOT_RENDERED = new Set(['defs', 'symbol', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern', 'style', 'title', 'desc', 'metadata', 'filter', 'marker', 'script', 'foreignObject', 'font', 'font-face', 'cursor', 'view', 'animate', 'animateMotion', 'animateTransform', 'set', 'mpath', '#text']);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const BLEND_MODES: Record<string, BlendMode> = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN', 'color-dodge': 'COLOR_DODGE',
  'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT', difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE',
  saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'inherit', 'initial']);

/** Degrees in (−180, 180], float noise next to a multiple of 90° snapped to it. */
function cleanDegrees(degrees: number): number {
  let d = ((degrees % 360) + 360) % 360;
  if (d > 180) d -= 360;
  const quarter = Math.round(d / 90) * 90;
  if (Math.abs(d - quarter) < 1e-7) d = quarter;
  if (d === -180) d = 180;
  return Object.is(d, -0) ? 0 : d;
}

/** Float noise off a coordinate (19.999999999999996 → 20), so panels show what the file says. */
const clean = (v: number) => {
  const r = Math.round(v * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
};

/** Splits a transform into a rotation kept on the node and the rest (scale, skew, translation)
 *  applied to the geometry in the rotated frame: ctm = R · inner. */
function splitRotation(ctm: Matrix): {rotation: number; frame: Matrix; inner: Matrix} {
  const angle = Math.atan2(ctm[1][0], ctm[0][0]);
  const rotation = cleanDegrees((-(Number.isFinite(angle) ? angle : 0) * 180) / Math.PI);
  const frame = rotationMatrix((-rotation * Math.PI) / 180);
  return {rotation, frame, inner: multiply(invert(frame), ctm)};
}

class Importer {
  private readonly byId = new Map<string, SvgNode>();
  private readonly rules: Rule[] = [];
  private readonly warnings = new Set<string>();
  readonly images: SvgImportImage[] = [];
  private nodeCount = 0;
  private indexed = 0;
  private visits = 0;
  private commands = 0;
  private stopped = false;
  private readonly started = Date.now();
  private readonly budget: number;
  private viewport = {width: 300, height: 150};
  private readonly currentColor: RGB;

  constructor(private readonly root: SvgNode, private readonly options: SvgImportOptions) {
    this.budget = options.timeBudgetMs ?? SVG_IMPORT_LIMITS.timeMs;
    this.currentColor = options.color ?? {r: 0, g: 0, b: 0};
    this.index(root, 0);
  }

  warn(message: string) { this.warnings.add(message); }

  /** Ids and stylesheets of the whole document, in document order. */
  private index(el: SvgNode, depth: number) {
    if (depth > SVG_IMPORT_LIMITS.depth + 1 || this.indexed++ > SVG_IMPORT_LIMITS.visits) return;
    const id = el.attrs.id;
    if (id && !this.byId.has(id)) this.byId.set(id, el);
    if (el.tag === 'style') {
      const text = el.children.filter(c => c.tag === '#text').map(c => c.text ?? '').join('');
      if (!el.attrs.type || /css/i.test(el.attrs.type)) this.rules.push(...parseStylesheet(text, this.rules.length, w => this.warn(w)));
    }
    for (const child of el.children) this.index(child, depth + 1);
  }

  private tick(): boolean {
    if (this.stopped) return false;
    if (++this.visits > SVG_IMPORT_LIMITS.visits || this.nodeCount >= SVG_IMPORT_LIMITS.nodes) {
      this.stopped = true;
      this.warn(SVG_WARNINGS.tooMany);
      return false;
    }
    if ((this.visits & 63) === 0 && Date.now() - this.started > this.budget) {
      this.stopped = true;
      this.warn(SVG_WARNINGS.time);
      return false;
    }
    return true;
  }

  private make(type: SceneNode['type'], props: Partial<SceneNode>): SceneNode {
    this.nodeCount++;
    return createNode(type, {id: newId(), ...props});
  }

  // Styles ────────────────────────────────────────────────────────────────────────────────────

  private computeStyle(el: SvgNode, parent: Style): Style {
    const style: Style = {};
    for (const key of Object.keys(parent)) if (INHERITED.has(key)) style[key] = parent[key];
    const set = (property: string, value: string) => {
      if (value === 'inherit') { if (parent[property] !== undefined) style[property] = parent[property]; else delete style[property]; }
      else if (value !== 'initial' && value !== 'unset') style[property] = value;
      else delete style[property];
    };
    for (const [name, value] of Object.entries(el.attrs)) if (PRESENTATION.has(name)) set(name, value.trim());
    const important: Declaration[] = [];
    if (this.rules.length) {
      const classes = (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
      const matched: {specificity: number; order: number; declarations: Declaration[]}[] = [];
      for (const rule of this.rules) {
        let best = -1;
        for (const s of rule.selectors) {
          if (s.tag && s.tag !== el.tag) continue;
          if (s.id && s.id !== el.attrs.id) continue;
          if (s.classes.some(c => !classes.includes(c))) continue;
          best = Math.max(best, s.specificity);
        }
        if (best >= 0) matched.push({specificity: best, order: rule.order, declarations: rule.declarations});
      }
      matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
      for (const m of matched) for (const d of m.declarations) (d.important ? important.push(d) : set(d.property, d.value));
    }
    const inline = el.attrs.style ? parseDeclarations(el.attrs.style) : [];
    for (const d of inline) if (!d.important) set(d.property, d.value);
    for (const d of important) set(d.property, d.value);
    for (const d of inline) if (d.important) set(d.property, d.value);
    return style;
  }

  private fontSize(style: Style): number {
    return Math.max(0, parseLength(style['font-size'], 16, 16) ?? 16);
  }

  private colorOf(style: Style): RGB {
    const c = style.color && style.color.toLowerCase() !== 'currentcolor' ? parseColor(style.color) : null;
    return c ? {r: c.r, g: c.g, b: c.b} : this.currentColor;
  }

  // Paints ────────────────────────────────────────────────────────────────────────────────────

  /** A fill or stroke paint for an element: `bbox` is its geometry's bounds in user space, `ctm`
   *  its user space → frame, `unit` the node's unit box → frame. */
  private paint(value: string | undefined, opacity: number, style: Style, bbox: BoxSource, ctm: Matrix, unit: Matrix): Paint | null {
    const v = (value ?? '').trim();
    if (!v || v === 'none') return null;
    const url = parseUrl(v);
    if (url) {
      const target = url.id ? this.byId.get(url.id) : undefined;
      if (target && (target.tag === 'linearGradient' || target.tag === 'radialGradient')) {
        const gradient = this.gradient(target, opacity, bbox, ctm, unit);
        if (gradient) return gradient;
        if (gradient === null) return null;
      }
      if (target?.tag === 'pattern') this.warn(SVG_WARNINGS.pattern);
      return url.rest ? this.paint(url.rest, opacity, style, bbox, ctm, unit) : null;
    }
    const color = v.toLowerCase() === 'currentcolor' ? {...this.colorOf(style), a: 1} : parseColor(v);
    if (!color) return null;
    return {type: 'SOLID', color: {r: color.r, g: color.g, b: color.b}, opacity: clamp01(color.a * opacity), visible: true, blendMode: 'NORMAL'};
  }

  /** Attributes and stops along a gradient's href chain (own values first). */
  private gradientChain(el: SvgNode): {attrs: Record<string, string>; stops: SvgNode[]} {
    const attrs: Record<string, string> = {};
    let stops: SvgNode[] = [];
    const seen = new Set<SvgNode>();
    for (let current: SvgNode | undefined = el; current && !seen.has(current) && seen.size < 8; ) {
      seen.add(current);
      for (const [k, v] of Object.entries(current.attrs)) if (!(k in attrs)) attrs[k] = v;
      if (!stops.length) stops = current.children.filter(c => c.tag === 'stop');
      const href: string | undefined = current.attrs.href ?? current.attrs['xlink:href'];
      const next: SvgNode | undefined = href?.startsWith('#') ? this.byId.get(href.slice(1)) : undefined;
      if (next && next.tag !== 'linearGradient' && next.tag !== 'radialGradient') break;
      current = next;
    }
    return {attrs, stops};
  }

  /** undefined: not a usable gradient (fall back); null: paints nothing. */
  private gradient(el: SvgNode, opacity: number, bboxSource: BoxSource, ctm: Matrix, unit: Matrix): GradientPaint | Paint | null | undefined {
    const {attrs, stops: stopNodes} = this.gradientChain(el);
    const stops: ColorStop[] = [];
    let last = 0;
    for (const stop of stopNodes.slice(0, DESIGN_FIELD_LIMITS.gradientStops)) {
      const style = this.computeStyle(stop, {});
      const raw = stop.attrs.offset ?? '0';
      const offset = clamp01(raw.trim().endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw) || 0);
      last = Math.max(last, offset);
      const colorText = style['stop-color'] ?? 'black';
      const base = colorText.toLowerCase() === 'currentcolor' ? {...this.colorOf(style), a: 1} : parseColor(colorText) ?? {r: 0, g: 0, b: 0, a: 1};
      const stopOpacity = clamp01(parseFloat(style['stop-opacity'] ?? '1'));
      stops.push({position: last, color: {r: base.r, g: base.g, b: base.b, a: clamp01(base.a * (Number.isFinite(stopOpacity) ? stopOpacity : 1))}});
    }
    if (!stops.length) return null;
    if (stops.length === 1) {
      const c = stops[0].color;
      return {type: 'SOLID', color: {r: c.r, g: c.g, b: c.b}, opacity: clamp01(c.a * opacity), visible: true, blendMode: 'NORMAL'};
    }
    const userSpace = attrs.gradientUnits === 'userSpaceOnUse';
    const bbox = userSpace ? null : boxOf(bboxSource);
    if (!userSpace && (!bbox || bbox.width <= 0 || bbox.height <= 0)) return null; // SVG: no box, no gradient
    const coord = (name: string, fallback: string, axis: 'x' | 'y' | 'r') => {
      const raw = attrs[name] ?? fallback;
      if (!userSpace) return raw.trim().endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
      const ref = axis === 'x' ? this.viewport.width : axis === 'y' ? this.viewport.height : Math.hypot(this.viewport.width, this.viewport.height) / Math.SQRT2;
      return parseLength(raw, ref) ?? 0;
    };
    const gradientTransform = parseTransform(attrs.gradientTransform) ?? IDENTITY;
    const boxMatrix: Matrix = userSpace || !bbox ? IDENTITY : [[bbox.width, 0, bbox.x], [0, bbox.height, bbox.y]];
    const toUnit = multiply(invert(unit), multiply(ctm, multiply(boxMatrix, gradientTransform)));
    let handles: [Vec, Vec, Vec];
    let type: GradientPaint['type'];
    if (el.tag === 'radialGradient') {
      type = 'GRADIENT_RADIAL';
      const cx = coord('cx', '50%', 'x'), cy = coord('cy', '50%', 'y'), r = coord('r', '50%', 'r');
      if (!(r > 0)) {
        const c = stops[stops.length - 1].color;
        return {type: 'SOLID', color: {r: c.r, g: c.g, b: c.b}, opacity: clamp01(c.a * opacity), visible: true, blendMode: 'NORMAL'};
      }
      handles = [{x: cx, y: cy}, {x: cx + r, y: cy}, {x: cx, y: cy + r}];
    } else {
      type = 'GRADIENT_LINEAR';
      const x1 = coord('x1', '0%', 'x'), y1 = coord('y1', '0%', 'y'), x2 = coord('x2', '100%', 'x'), y2 = coord('y2', '0%', 'y');
      const dx = x2 - x1, dy = y2 - y1;
      if (!dx && !dy) {
        const c = stops[stops.length - 1].color;
        return {type: 'SOLID', color: {r: c.r, g: c.g, b: c.b}, opacity: clamp01(c.a * opacity), visible: true, blendMode: 'NORMAL'};
      }
      // The width handle sits across the axis, half its length away: Figma's default frame.
      handles = [{x: x1, y: y1}, {x: x2, y: y2}, {x: x1 - dy / 2, y: y1 + dx / 2}];
    }
    if ([...handles].some(h => !Number.isFinite(h.x) || !Number.isFinite(h.y))) return undefined;
    return {
      type, gradientStops: stops, opacity: clamp01(opacity), visible: true, blendMode: 'NORMAL',
      gradientHandlePositions: handles.map(h => apply(toUnit, h)) as [Vec, Vec, Vec],
    };
  }

  private strokeProps(style: Style, ctm: Matrix, bbox: BoxSource, unit: Matrix): Partial<SceneNode> {
    const det = Math.abs(ctm[0][0] * ctm[1][1] - ctm[0][1] * ctm[1][0]);
    const factor = style['vector-effect'] === 'non-scaling-stroke' ? 1 : Math.sqrt(det);
    const width = (parseLength(style['stroke-width'] ?? '1', Math.hypot(this.viewport.width, this.viewport.height) / Math.SQRT2) ?? 1) * factor;
    const stroke = width > 0 ? this.paint(style.stroke, clamp01(parseFloat(style['stroke-opacity'] ?? '1')), style, bbox, ctm, unit) : null;
    const cap: Record<string, StrokeCap> = {butt: 'NONE', round: 'ROUND', square: 'SQUARE'};
    const join: Record<string, StrokeJoin> = {miter: 'MITER', 'miter-clip': 'MITER', arcs: 'MITER', round: 'ROUND', bevel: 'BEVEL'};
    let dashes = style['stroke-dasharray'] && style['stroke-dasharray'] !== 'none' ? parseNumberList(style['stroke-dasharray'], 64).map(v => Math.max(0, v * factor)) : [];
    if (dashes.length % 2) dashes = [...dashes, ...dashes];
    if (dashes.every(v => v === 0)) dashes = [];
    const miter = parseFloat(style['stroke-miterlimit'] ?? '4');
    return {
      strokes: stroke ? [stroke] : [],
      strokeWeight: stroke ? width : 1,
      strokeAlign: 'CENTER',
      strokeCap: cap[style['stroke-linecap'] ?? ''] ?? 'NONE',
      strokeJoin: join[style['stroke-linejoin'] ?? ''] ?? 'MITER',
      strokeMiterLimit: Number.isFinite(miter) && miter >= 1 ? miter : 4,
      dashPattern: dashes,
    };
  }

  private layerProps(el: SvgNode, style: Style): Partial<SceneNode> {
    const props: Partial<SceneNode> = {};
    const opacity = parseFloat(style.opacity ?? '1');
    if (Number.isFinite(opacity) && opacity !== 1) props.opacity = clamp01(opacity);
    const blend = BLEND_MODES[(style['mix-blend-mode'] ?? '').toLowerCase()];
    if (blend && blend !== 'NORMAL') props.blendMode = blend;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') props.visible = false;
    const name = el.attrs['inkscape:label'] ?? el.attrs['data-name'] ?? el.attrs.id;
    if (name) props.name = name.slice(0, 200);
    if (style.filter && style.filter !== 'none') this.warn(SVG_WARNINGS.filter);
    if ((style['marker-start'] && style['marker-start'] !== 'none') || (style['marker-end'] && style['marker-end'] !== 'none') || (style['marker-mid'] && style['marker-mid'] !== 'none')) this.warn(SVG_WARNINGS.marker);
    return props;
  }

  // Elements ──────────────────────────────────────────────────────────────────────────────────

  run(): SvgImportResult {
    const root = this.root;
    const rootStyle = this.computeStyle(root, {});
    const viewBox = parseNumberList(root.attrs.viewBox, 4);
    const hasViewBox = viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0;
    const sizeOf = (value: string | undefined, fallback: number) => {
      if (value === undefined || value.trim().endsWith('%')) return fallback;
      const v = parseLength(value, fallback);
      return v !== null && v > 0 ? v : fallback;
    };
    const width = sizeOf(root.attrs.width, hasViewBox ? viewBox[2] : 300);
    const height = sizeOf(root.attrs.height, hasViewBox ? viewBox[3] : 150);
    this.viewport = hasViewBox ? {width: viewBox[2], height: viewBox[3]} : {width, height};
    const content = hasViewBox ? viewBoxTransform(viewBox, width, height, root.attrs.preserveAspectRatio) : IDENTITY;
    const title = root.children.find(c => c.tag === 'title')?.children.find(c => c.tag === '#text')?.text?.trim();
    const frame = this.make('FRAME', {
      name: (this.options.name ?? title ?? 'SVG').slice(0, 200),
      parentId: this.options.parentId ?? null,
      x: this.options.x ?? 0,
      y: this.options.y ?? 0,
      width,
      height,
      fills: [],
      clipsContent: true,
      ...pick(this.layerProps(root, rootStyle), ['opacity', 'blendMode', 'visible']),
    });
    const ctx: Ctx = {ctm: content, style: rootStyle, useDepth: 0, chain: new Set()};
    const children = this.childrenOf(root, ctx, 1);
    const built: Built = {node: frame, children};
    finalizeGroups(built, true);
    const nodes: SceneNode[] = [];
    flattenTree(built, null, nodes);
    nodes[0].parentId = this.options.parentId ?? null;
    return {nodes, rootId: frame.id, images: this.images, warnings: [...this.warnings]};
  }

  private childrenOf(el: SvgNode, ctx: Ctx, depth: number): Built[] {
    const out: Built[] = [];
    for (const child of el.children) {
      if (this.stopped) break;
      out.push(...this.convert(child, ctx, depth));
    }
    return out;
  }

  private convert(el: SvgNode, ctx: Ctx, depth: number): Built[] {
    if (NOT_RENDERED.has(el.tag) || depth > SVG_IMPORT_LIMITS.depth + 1) return [];
    if (!this.tick()) return [];
    const style = this.computeStyle(el, ctx.style);
    if (style.display === 'none') return [];
    const transform = parseTransform(el.attrs.transform);
    const ctm = multiply(ctx.ctm, transform ?? IDENTITY);
    // Ancestors' ids join the chain, so a <use> pointing back up the tree is a cycle at once.
    const chain = el.attrs.id ? new Set(ctx.chain).add(el.attrs.id) : ctx.chain;
    const inner: Ctx = {...ctx, ctm, style, chain};
    let built: Built[];
    switch (el.tag) {
      case 'g': case 'a': built = this.group(el, style, this.childrenOf(el, inner, depth + 1)); break;
      case 'switch': {
        const first = el.children.find(c => c.tag !== '#text' && !NOT_RENDERED.has(c.tag));
        built = this.group(el, style, first ? this.convert(first, inner, depth + 1) : []);
        break;
      }
      case 'svg': {
        const vb = parseNumberList(el.attrs.viewBox, 4);
        const x = parseLength(el.attrs.x, this.viewport.width) ?? 0, y = parseLength(el.attrs.y, this.viewport.height) ?? 0;
        const w = parseLength(el.attrs.width ?? '100%', this.viewport.width) ?? 0, h = parseLength(el.attrs.height ?? '100%', this.viewport.height) ?? 0;
        const viewportCtm = multiply(ctm, multiply(translation(x, y), vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? viewBoxTransform(vb, w, h, el.attrs.preserveAspectRatio) : IDENTITY));
        built = this.group(el, style, this.childrenOf(el, {...inner, ctm: viewportCtm}, depth + 1));
        break;
      }
      case 'use': built = this.use(el, inner, depth); break;
      case 'text': built = this.text(el, style, ctm); break;
      case 'image': built = this.image(el, style, ctm); break;
      default:
        if (SHAPES.has(el.tag)) built = this.shape(el, style, ctm);
        else {
          if (el.tag !== 'textPath') this.warn(SVG_WARNINGS.unknown);
          built = [];
        }
    }
    if (!built.length) return built;
    return this.clipAndMask(el, style, ctm, built, depth);
  }

  private group(el: SvgNode, style: Style, children: Built[]): Built[] {
    if (!children.length) return [];
    const node = this.make('GROUP', {...this.layerProps(el, style)});
    return [{node, children}];
  }

  private use(el: SvgNode, ctx: Ctx, depth: number): Built[] {
    const href = el.attrs.href ?? el.attrs['xlink:href'] ?? '';
    if (!href.startsWith('#')) {
      if (href) this.warn(SVG_WARNINGS.externalUse);
      return [];
    }
    const id = href.slice(1);
    const target = this.byId.get(id);
    if (!target) return [];
    if (ctx.chain.has(id)) { this.warn(SVG_WARNINGS.useCycle); return []; }
    if (ctx.useDepth >= SVG_IMPORT_LIMITS.useDepth) { this.warn(SVG_WARNINGS.useDepth); return []; }
    const x = parseLength(el.attrs.x, this.viewport.width) ?? 0, y = parseLength(el.attrs.y, this.viewport.height) ?? 0;
    const chain = new Set(ctx.chain).add(id);
    let ctm = multiply(ctx.ctm, translation(x, y));
    const next: Ctx = {ctm, style: ctx.style, useDepth: ctx.useDepth + 1, chain};
    let children: Built[];
    if (target.tag === 'symbol' || target.tag === 'svg') {
      const vb = parseNumberList(target.attrs.viewBox, 4);
      const w = parseLength(el.attrs.width ?? target.attrs.width ?? '100%', this.viewport.width) ?? 0;
      const h = parseLength(el.attrs.height ?? target.attrs.height ?? '100%', this.viewport.height) ?? 0;
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) ctm = multiply(ctm, viewBoxTransform(vb, w, h, target.attrs.preserveAspectRatio));
      const symbolStyle = this.computeStyle(target, ctx.style);
      children = this.childrenOf(target, {...next, ctm, style: symbolStyle}, depth + 1);
    } else {
      // The referenced element is copied as if it were the use's only child.
      children = this.convert(target, next, depth + 1);
    }
    if (!children.length) return [];
    const props = this.layerProps(el, ctx.style);
    if (children.length === 1 && props.opacity === undefined && props.blendMode === undefined && props.visible === undefined) {
      if (props.name) children[0].node.name = props.name;
      return children;
    }
    return [{node: this.make('GROUP', props), children}];
  }

  /** Geometry of a basic shape in its user space, plus the exact primitive when there is one. */
  private geometry(el: SvgNode, style: Style): {commands: PathCommand[]; rect?: {x: number; y: number; w: number; h: number; rx: number; ry: number}; ellipse?: {cx: number; cy: number; rx: number; ry: number}} | null {
    const vw = this.viewport.width, vh = this.viewport.height, diag = Math.hypot(vw, vh) / Math.SQRT2;
    const fs = this.fontSize(style);
    const len = (name: string, ref: number, fallback = 0) => parseLength(el.attrs[name], ref, fs) ?? fallback;
    switch (el.tag) {
      case 'path': {
        const remaining = SVG_IMPORT_LIMITS.pathCommands - this.commands;
        if (remaining <= 0) { this.stopped = true; this.warn(SVG_WARNINGS.tooMany); return null; }
        // One layer holds what a stored document allows (shared/design/document-limits.ts); the rest is cut.
        const commands = parsePathData(el.attrs.d ?? '', {maxCommands: Math.min(remaining, DESIGN_FIELD_LIMITS.pathCommands)});
        if (commands.length === DESIGN_FIELD_LIMITS.pathCommands) this.warn(SVG_WARNINGS.tooMany);
        this.commands += commands.length;
        return commands.length ? {commands} : null;
      }
      case 'rect': {
        const x = len('x', vw), y = len('y', vh), w = len('width', vw), h = len('height', vh);
        if (!(w > 0 && h > 0)) return null;
        let rx = parseLength(el.attrs.rx, vw, fs), ry = parseLength(el.attrs.ry, vh, fs);
        if (rx === null || rx < 0) rx = ry !== null && ry >= 0 ? ry : 0;
        if (ry === null || ry < 0) ry = rx;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        return {commands: roundedRectCommands(x, y, w, h, rx, ry), rect: {x, y, w, h, rx, ry}};
      }
      case 'circle': case 'ellipse': {
        const cx = len('cx', vw), cy = len('cy', vh);
        let rx = el.tag === 'circle' ? len('r', diag) : parseLength(el.attrs.rx, vw, fs), ry = el.tag === 'circle' ? rx : parseLength(el.attrs.ry, vh, fs);
        if (rx === null || rx < 0) rx = ry;
        if (ry === null || ry < 0) ry = rx;
        if (!(rx! > 0 && ry! > 0)) return null;
        const commands: PathCommand[] = [{type: 'M', x: cx + rx!, y: cy}];
        for (const c of ellipseArcCubics({x: cx, y: cy}, rx!, ry!, 0, 0, 2 * Math.PI)) commands.push({type: 'C', x1: c[1].x, y1: c[1].y, x2: c[2].x, y2: c[2].y, x: c[3].x, y: c[3].y});
        const last = commands[commands.length - 1] as {x: number; y: number};
        last.x = cx + rx!; last.y = cy;
        commands.push({type: 'Z'});
        return {commands, ellipse: {cx, cy, rx: rx!, ry: ry!}};
      }
      case 'line':
        return {commands: [{type: 'M', x: len('x1', vw), y: len('y1', vh)}, {type: 'L', x: len('x2', vw), y: len('y2', vh)}]};
      case 'polyline': case 'polygon': {
        const n = parseNumberList(el.attrs.points, 200_000);
        if (n.length < 4) return null;
        const commands: PathCommand[] = [];
        for (let k = 0; k + 1 < n.length; k += 2) commands.push({type: k ? 'L' : 'M', x: n[k], y: n[k + 1]});
        if (el.tag === 'polygon') commands.push({type: 'Z'});
        this.commands += commands.length;
        return {commands};
      }
      default: return null;
    }
  }

  private shape(el: SvgNode, style: Style, ctm: Matrix): Built[] {
    const geometry = this.geometry(el, style);
    if (!geometry) return [];
    let measured: Box | undefined;
    const bbox = () => (measured === undefined ? (measured = pathBounds(geometry.commands)) : measured);
    const {rotation, frame, inner} = splitRotation(ctm);
    const scale = Math.max(Math.abs(inner[0][0]), Math.abs(inner[1][1]), Math.abs(inner[0][1]), 1e-12);
    const exact = Math.abs(inner[0][1]) <= scale * 1e-9 && Math.abs(inner[1][0]) <= scale * 1e-9;
    let type: SceneNode['type'] = 'VECTOR';
    let box: {x: number; y: number; width: number; height: number};
    const props: Partial<SceneNode> = {};
    const sx = Math.abs(inner[0][0]), sy = Math.abs(inner[1][1]);
    if (exact && geometry.rect && Math.abs(geometry.rect.rx * sx - geometry.rect.ry * sy) <= 1e-9 * Math.max(1, geometry.rect.rx * sx)) {
      const r = geometry.rect;
      type = 'RECTANGLE';
      box = transformRect(inner, {x: r.x, y: r.y, width: r.w, height: r.h});
      props.cornerRadius = r.rx * sx;
    } else if (exact && geometry.ellipse) {
      const e = geometry.ellipse;
      type = 'ELLIPSE';
      box = transformRect(inner, {x: e.cx - e.rx, y: e.cy - e.ry, width: e.rx * 2, height: e.ry * 2});
    } else {
      const local = transformPath(geometry.commands, inner);
      box = pathBounds(local) ?? {x: 0, y: 0, width: 0, height: 0};
      translateInPlace(local, -box.x, -box.y);
      props.vectorPaths = [{windingRule: windingOf(style['fill-rule']), commands: local}];
    }
    const origin = apply(frame, {x: box.x, y: box.y});
    if (props.cornerRadius !== undefined) props.cornerRadius = clean(props.cornerRadius);
    const node = this.make(type, {x: clean(origin.x), y: clean(origin.y), width: clean(box.width), height: clean(box.height), rotation, ...props});
    const unit = multiply(localMatrix(node), scaling(box.width || 1, box.height || 1));
    const fillOpacity = clamp01(parseFloat(style['fill-opacity'] ?? '1'));
    // Lines draw no fill, as in SVG (an open path's fill closes it; a line encloses nothing).
    const fill = el.tag === 'line' ? null : this.paint(style.fill ?? 'black', Number.isFinite(fillOpacity) ? fillOpacity : 1, style, bbox, ctm, unit);
    Object.assign(node, {fills: fill ? [fill] : []}, this.strokeProps(style, ctm, bbox, unit), this.layerProps(el, style));
    return [{node}];
  }

  private image(el: SvgNode, style: Style, ctm: Matrix): Built[] {
    const href = (el.attrs.href ?? el.attrs['xlink:href'] ?? '').trim();
    const data = /^data:([\w/+.-]+)(;[^,]*)?,/i.exec(href);
    if (!data) {
      if (href) this.warn(SVG_WARNINGS.remoteImage);
      return [];
    }
    const mimeType = data[1].toLowerCase();
    if (!IMAGE_TYPES.has(mimeType)) { this.warn(SVG_WARNINGS.imageType); return []; }
    const vw = this.viewport.width, vh = this.viewport.height;
    const x = parseLength(el.attrs.x, vw) ?? 0, y = parseLength(el.attrs.y, vh) ?? 0;
    const w = parseLength(el.attrs.width, vw), h = parseLength(el.attrs.height, vh);
    if (!(w && h && w > 0 && h > 0)) { this.warn(SVG_WARNINGS.imageSize); return []; }
    const {rotation, frame, inner} = splitRotation(ctm);
    const box = transformRect(inner, {x, y, width: w, height: h});
    const origin = apply(frame, {x: box.x, y: box.y});
    const aspect = (el.attrs.preserveAspectRatio ?? '').trim();
    const scaleMode: ImagePaint['scaleMode'] = aspect.startsWith('none') ? 'CROP' : /\bslice\b/.test(aspect) ? 'FILL' : 'FIT';
    const paint: ImagePaint = {type: 'IMAGE', imageRef: '', scaleMode, opacity: 1, visible: true, blendMode: 'NORMAL'};
    if (scaleMode === 'CROP') paint.imageTransform = [[1, 0, 0], [0, 1, 0]];
    const node = this.make('RECTANGLE', {name: 'Image', x: clean(origin.x), y: clean(origin.y), width: clean(box.width), height: clean(box.height), rotation, fills: [paint], strokes: [], ...this.layerProps(el, style)});
    this.images.push({nodeId: node.id, dataUrl: href, mimeType});
    return [{node}];
  }

  private text(el: SvgNode, style: Style, ctm: Matrix): Built[] {
    type Piece = {text: string; style: Style; newLine: boolean};
    const pieces: Piece[] = [];
    const fs = this.fontSize(style);
    const firstOf = (v: string | undefined, ref: number) => (v === undefined ? null : parseLength(v.trim().split(/[\s,]+/)[0], ref, fs));
    const x0 = firstOf(el.attrs.x, this.viewport.width), y0 = firstOf(el.attrs.y, this.viewport.height);
    const state: {origin: Vec | null; baseline: number | null; lineGap: number} = {origin: x0 !== null || y0 !== null ? {x: x0 ?? 0, y: y0 ?? 0} : null, baseline: y0, lineGap: 0};
    const walk = (node: SvgNode, nodeStyle: Style, depth: number) => {
      if (depth > 8) return;
      for (const child of node.children) {
        if (child.tag === '#text') { pieces.push({text: child.text ?? '', style: nodeStyle, newLine: false}); continue; }
        if (child.tag !== 'tspan' && child.tag !== 'textPath' && child.tag !== 'a') continue;
        if (child.tag === 'textPath') this.warn(SVG_WARNINGS.textPath);
        const childStyle = this.computeStyle(child, nodeStyle);
        if (childStyle.display === 'none') continue;
        const y = firstOf(child.attrs.y, this.viewport.height), dy = firstOf(child.attrs.dy, this.viewport.height);
        // A tspan that moves to another baseline starts a new line; the first gap sets the line height.
        let newLine = false;
        if (y !== null && state.baseline !== null && Math.abs(y - state.baseline) > 1e-6) {
          newLine = true;
          state.lineGap ||= Math.abs(y - state.baseline);
          state.baseline = y;
        } else if (dy && pieces.length) {
          newLine = true;
          state.lineGap ||= Math.abs(dy);
          state.baseline = (state.baseline ?? 0) + dy;
        }
        if (!state.origin && (child.attrs.x !== undefined || y !== null)) state.origin = {x: firstOf(child.attrs.x, this.viewport.width) ?? 0, y: y ?? 0};
        if (y !== null && state.baseline === null) state.baseline = y;
        if (newLine) pieces.push({text: '', style: childStyle, newLine: true});
        walk(child, childStyle, depth + 1);
      }
    };
    walk(el, style, 0);
    // XML whitespace: newlines go, tabs become spaces, runs of spaces collapse, the ends are trimmed.
    const preserve = style['xml:space'] === 'preserve' || el.attrs['xml:space'] === 'preserve';
    let characters = '';
    const base = this.textStyle(style);
    const runs: (TextRun & {fillStyle?: Style})[] = [];
    for (const piece of pieces) {
      if (piece.newLine) { characters = characters.replace(/ +$/, '') + '\n'; continue; }
      let text = preserve ? piece.text.replace(/[\n\r\t]/g, ' ') : piece.text.replace(/[\n\r]/g, '').replace(/\t/g, ' ').replace(/ {2,}/g, ' ');
      if (!preserve && (characters.endsWith(' ') || characters.endsWith('\n') || !characters)) text = text.replace(/^ +/, '');
      if (!text) continue;
      const start = characters.length;
      characters += text;
      const pieceStyle = this.textStyle(piece.style);
      const diff: Partial<TextStyle> = {};
      for (const key of ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'textDecoration'] as const) {
        if (pieceStyle[key] !== base[key]) (diff as Record<string, unknown>)[key] = pieceStyle[key];
      }
      const ownFill = piece.style.fill !== style.fill || piece.style['fill-opacity'] !== style['fill-opacity'];
      if (Object.keys(diff).length || ownFill) runs.push({start, end: characters.length, style: diff, ...(ownFill ? {fillStyle: piece.style} : {})});
    }
    if (!preserve) characters = characters.replace(/ +$/, '');
    if (characters.length > DESIGN_FIELD_LIMITS.characters) {
      characters = characters.slice(0, DESIGN_FIELD_LIMITS.characters);
      this.warn(SVG_WARNINGS.tooMany);
    }
    if (!characters.trim()) return [];
    const {rotation, frame, inner} = splitRotation(ctm);
    const factor = Math.sqrt(Math.abs(inner[0][0] * inner[1][1] - inner[0][1] * inner[1][0])) || 1;
    const textStyle: TextStyle = {...base, fontSize: base.fontSize * factor, letterSpacing: {unit: 'PIXELS', value: base.letterSpacing.value * factor}};
    if (state.lineGap) textStyle.lineHeight = {unit: 'PIXELS', value: state.lineGap * factor};
    const anchor = (style['text-anchor'] ?? 'start').trim();
    const props = defaultTextProps(characters);
    props.style = textStyle;
    const kept = runs.map(run => ({...run, end: Math.min(run.end, characters.length)})).filter(run => run.end > run.start);
    props.runs = kept.map(run => ({start: run.start, end: run.end, style: run.style.fontSize ? {...run.style, fontSize: run.style.fontSize * factor} : run.style}));
    props.textAlignHorizontal = anchor === 'middle' ? 'CENTER' : anchor === 'end' ? 'RIGHT' : 'LEFT';
    props.textAutoResize = 'WIDTH_AND_HEIGHT';
    const node = this.make('TEXT', {name: characters.slice(0, 60).replace(/\n/g, ' '), rotation, text: props, fills: []});
    // Size and baseline: measured when a measurer is given, estimated otherwise.
    let width: number, height: number, baseline: number;
    if (this.options.measurer) {
      const layout = layoutText(node, this.options.measurer, null);
      width = layout.width; height = layout.height; baseline = layout.lines[0]?.baseline ?? textStyle.fontSize * 0.8;
    } else {
      const lines = characters.split('\n');
      const lineHeight = textStyle.lineHeight.unit === 'PIXELS' ? textStyle.lineHeight.value : textStyle.fontSize * 1.2;
      width = Math.max(...lines.map(l => l.length)) * textStyle.fontSize * 0.55;
      height = lines.length * lineHeight;
      baseline = (lineHeight - textStyle.fontSize * 1.2) / 2 + textStyle.fontSize * 0.95;
    }
    const at = apply(inner, state.origin ?? {x: 0, y: 0});
    const left = at.x - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
    const topLeft = apply(frame, {x: left, y: at.y - baseline});
    Object.assign(node, {x: clean(topLeft.x), y: clean(topLeft.y), width: clean(width), height: clean(height)}, this.layerProps(el, style));
    // Paints need the final box (gradients live in the node's unit box).
    const unit = multiply(localMatrix(node), scaling(width || 1, height || 1));
    const userBox = transformRect(multiply(invert(ctm), localMatrix(node)), {x: 0, y: 0, width, height});
    const fillOf = (s: Style) => this.paint(s.fill ?? 'black', clamp01(parseFloat(s['fill-opacity'] ?? '1')), s, userBox, ctm, unit);
    const fill = fillOf(style);
    node.fills = fill ? [fill] : [];
    kept.forEach((run, k) => {
      const target = props.runs[k];
      if (!run.fillStyle || !target) return;
      const runFill = fillOf(run.fillStyle);
      target.fills = runFill ? [runFill] : [];
    });
    if (style.stroke && style.stroke !== 'none') Object.assign(node, this.strokeProps(style, ctm, userBox, unit));
    return [{node}];
  }

  private textStyle(style: Style): TextStyle {
    const families = (style['font-family'] ?? '').split(',').map(f => f.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const family = families.find(f => !GENERIC_FAMILIES.has(f.toLowerCase())) ?? DEFAULT_FONT_FAMILY;
    const weightText = (style['font-weight'] ?? 'normal').toLowerCase();
    const weight = weightText === 'bold' || weightText === 'bolder' ? 700 : weightText === 'lighter' ? 300 : weightText === 'normal' ? 400 : Math.max(100, Math.min(900, Math.round((parseFloat(weightText) || 400) / 100) * 100));
    const size = this.fontSize(style);
    const spacing = style['letter-spacing'] && style['letter-spacing'] !== 'normal' ? parseLength(style['letter-spacing'], size, size) ?? 0 : 0;
    const decoration = style['text-decoration'] ?? '';
    return {
      fontFamily: family.slice(0, 100),
      fontWeight: weight,
      italic: /italic|oblique/i.test(style['font-style'] ?? ''),
      fontSize: size,
      lineHeight: {unit: 'AUTO'},
      letterSpacing: {unit: 'PIXELS', value: spacing},
      textDecoration: /underline/.test(decoration) ? 'UNDERLINE' : /line-through/.test(decoration) ? 'STRIKETHROUGH' : 'NONE',
      textCase: /uppercase/.test(style['text-transform'] ?? '') ? 'UPPER' : /lowercase/.test(style['text-transform'] ?? '') ? 'LOWER' : /small-caps/.test(style['font-variant'] ?? '') ? 'SMALL_CAPS' : 'ORIGINAL',
    };
  }

  // Clipping and masking ──────────────────────────────────────────────────────────────────────

  private clipAndMask(el: SvgNode, style: Style, ctm: Matrix, built: Built[], depth: number): Built[] {
    let out = built;
    const clip = style['clip-path'] ? parseUrl(style['clip-path']) : null;
    if (clip?.id) {
      const target = this.byId.get(clip.id);
      if (target?.tag === 'clipPath') {
        const bbox = boundsOfBuilt(out, ctm);
        const units = target.attrs.clipPathUnits === 'objectBoundingBox' && bbox ? [[bbox.width, 0, bbox.x], [0, bbox.height, bbox.y]] as Matrix : IDENTITY;
        const clipCtm = multiply(multiply(ctm, units), parseTransform(target.attrs.transform) ?? IDENTITY);
        const paths = this.clipPaths(target, clipCtm, 0);
        if (!paths.length) return []; // an empty clip hides everything
        const bounds = pathsBounds(paths)!;
        const mask = this.make('VECTOR', {
          name: target.attrs.id ?? 'Mask', isMask: true, maskType: 'VECTOR', x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
          vectorPaths: paths.map(p => ({windingRule: p.windingRule, commands: transformPath(p.commands, translation(-bounds.x, -bounds.y))})),
          fills: [{type: 'SOLID', color: {r: 0, g: 0, b: 0}, opacity: 1, visible: true, blendMode: 'NORMAL'}], strokes: [],
        });
        out = [{node: this.make('GROUP', {name: 'Clip'}), children: [{node: mask}, ...out]}];
      }
    }
    const maskRef = style.mask ? parseUrl(style.mask) : null;
    if (maskRef?.id) {
      const target = this.byId.get(maskRef.id);
      if (target?.tag === 'mask') {
        const bbox = boundsOfBuilt(built, ctm);
        const units = target.attrs.maskContentUnits === 'objectBoundingBox' && bbox ? [[bbox.width, 0, bbox.x], [0, bbox.height, bbox.y]] as Matrix : IDENTITY;
        const maskStyle = this.computeStyle(target, {});
        const content = this.childrenOf(target, {ctm: multiply(ctm, units), style: maskStyle, useDepth: SVG_IMPORT_LIMITS.useDepth - 1, chain: new Set([maskRef.id])}, depth + 1);
        if (!content.length) return [];
        const alpha = (maskStyle['mask-type'] ?? target.attrs['mask-type'] ?? '').trim() === 'alpha';
        const maskBuilt: Built = content.length === 1 ? content[0] : {node: this.make('GROUP', {name: target.attrs.id ?? 'Mask'}), children: content};
        Object.assign(maskBuilt.node, {isMask: true, maskType: alpha ? 'ALPHA' : 'LUMINANCE'});
        out = [{node: this.make('GROUP', {name: 'Mask'}), children: [maskBuilt, ...out]}];
      }
    }
    return out;
  }

  /** The union outline of a clipPath's shapes, mapped into the frame. */
  private clipPaths(clip: SvgNode, ctm: Matrix, useDepth: number): VectorPath[] {
    const out: VectorPath[] = [];
    const style = this.computeStyle(clip, {});
    for (const child of clip.children) {
      if (!this.tick()) break;
      const childStyle = this.computeStyle(child, style);
      if (childStyle.display === 'none' || childStyle.visibility === 'hidden') continue;
      const childCtm = multiply(ctm, parseTransform(child.attrs.transform) ?? IDENTITY);
      if (child.tag === 'use' && useDepth < SVG_IMPORT_LIMITS.useDepth) {
        const href = child.attrs.href ?? child.attrs['xlink:href'] ?? '';
        const target = href.startsWith('#') ? this.byId.get(href.slice(1)) : undefined;
        if (target && SHAPES.has(target.tag)) {
          const x = parseLength(child.attrs.x, this.viewport.width) ?? 0, y = parseLength(child.attrs.y, this.viewport.height) ?? 0;
          out.push(...this.clipPaths({...clip, children: [target]}, multiply(childCtm, translation(x, y)), useDepth + 1));
        }
        continue;
      }
      if (!SHAPES.has(child.tag)) continue;
      const geometry = this.geometry(child, childStyle);
      if (geometry) out.push({windingRule: windingOf(childStyle['clip-rule']), commands: transformPath(geometry.commands, childCtm)});
    }
    return out;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

const windingOf = (rule: string | undefined): WindingRule => ((rule ?? '').trim() === 'evenodd' ? 'EVENODD' : 'NONZERO');

/** Moves freshly made commands without copying them again (paths may hold 10⁵ commands). */
function translateInPlace(commands: PathCommand[], dx: number, dy: number): void {
  for (const c of commands) {
    if (c.type === 'Z') continue;
    c.x += dx; c.y += dy;
    if (c.type === 'C') { c.x1 += dx; c.y1 += dy; c.x2 += dx; c.y2 += dy; }
    else if (c.type === 'Q') { c.x1 += dx; c.y1 += dy; }
  }
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (source[k] !== undefined) out[k] = source[k];
  return out;
}

/** viewBox → viewport per preserveAspectRatio (default xMidYMid meet). */
function viewBoxTransform(vb: number[], width: number, height: number, preserve: string | undefined): Matrix {
  const [vx, vy, vw, vh] = vb;
  let sx = width / vw, sy = height / vh;
  const [align = 'xMidYMid', meetOrSlice = 'meet'] = (preserve ?? '').trim().split(/\s+/).filter(Boolean);
  if (align !== 'none') {
    const s = meetOrSlice === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
  }
  let tx = -vx * sx, ty = -vy * sy;
  if (align !== 'none') {
    const extraX = width - vw * sx, extraY = height - vh * sy;
    if (align.includes('xMid')) tx += extraX / 2;
    else if (align.includes('xMax')) tx += extraX;
    if (align.includes('YMid')) ty += extraY / 2;
    else if (align.includes('YMax')) ty += extraY;
  }
  return [[sx, 0, tx], [0, sy, ty]];
}

/** A rectangle with elliptical corners (rx, ry), clockwise from the top edge. */
function roundedRectCommands(x: number, y: number, w: number, h: number, rx: number, ry: number): PathCommand[] {
  if (!(rx > 0 && ry > 0)) return [{type: 'M', x, y}, {type: 'L', x: x + w, y}, {type: 'L', x: x + w, y: y + h}, {type: 'L', x, y: y + h}, {type: 'Z'}];
  const out: PathCommand[] = [{type: 'M', x: x + rx, y}];
  const corner = (cx: number, cy: number, start: number) => {
    for (const c of ellipseArcCubics({x: cx, y: cy}, rx, ry, 0, start, Math.PI / 2)) out.push({type: 'C', x1: c[1].x, y1: c[1].y, x2: c[2].x, y2: c[2].y, x: c[3].x, y: c[3].y});
  };
  const line = (px: number, py: number) => out.push({type: 'L', x: px, y: py});
  line(x + w - rx, y); corner(x + w - rx, y + ry, -Math.PI / 2);
  line(x + w, y + h - ry); corner(x + w - rx, y + h - ry, 0);
  line(x + rx, y + h); corner(x + rx, y + h - ry, Math.PI / 2);
  line(x, y + ry); corner(x + rx, y + ry, Math.PI);
  const last = out[out.length - 1] as {x: number; y: number};
  last.x = x + rx; last.y = y;
  out.push({type: 'Z'});
  return out;
}

/** Bounds of built nodes in the user space of `ctm` (for objectBoundingBox units). */
function boundsOfBuilt(built: Built[], ctm: Matrix): {x: number; y: number; width: number; height: number} | null {
  const boxes: {x: number; y: number; width: number; height: number}[] = [];
  const back = invert(ctm);
  const visit = (b: Built, parent: Matrix) => {
    const m = multiply(parent, localMatrix(b.node));
    if (b.children) b.children.forEach(child => visit(child, m));
    else boxes.push(transformRect(multiply(back, m), {x: 0, y: 0, width: b.node.width, height: b.node.height}));
  };
  // Built nodes are still in frame space here (groups are finalised later).
  built.forEach(b => visit(b, IDENTITY));
  return unionRects(boxes);
}

/** Groups take the union box of their children; children move into the group's space. Every
 *  node was placed in frame space, so a group (never rotated) only shifts its children. */
function finalizeGroups(built: Built, isRoot: boolean): void {
  if (!built.children) return;
  for (const child of built.children) finalizeGroups(child, false);
  if (isRoot) return;
  const box = unionRects(built.children.map(c => transformRect(localMatrix(c.node), {x: 0, y: 0, width: c.node.width, height: c.node.height})));
  if (!box) return;
  Object.assign(built.node, {x: clean(box.x), y: clean(box.y), width: clean(box.width), height: clean(box.height), rotation: 0});
  for (const child of built.children) {
    child.node.x = clean(child.node.x - built.node.x);
    child.node.y = clean(child.node.y - built.node.y);
  }
}

function flattenTree(built: Built, parentId: NodeId | null, out: SceneNode[]): void {
  built.node.parentId = parentId;
  out.push(built.node);
  if (built.children) {
    built.node.children = built.children.map(c => c.node.id);
    for (const child of built.children) flattenTree(child, built.node.id, out);
  }
}

/** Maps a parsed SVG into nodes: a FRAME (first in `nodes`, id `rootId`) with the content. The
 *  root must be an <svg> element. Pictures in data: URLs come back in `images` for upload. */
export function importSvg(tree: SvgNode, options: SvgImportOptions = {}): SvgImportResult {
  if (tree.tag !== 'svg') throw new Error('svg_root_expected');
  return new Importer(tree, options).run();
}
