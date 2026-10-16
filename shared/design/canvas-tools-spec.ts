// The layer specs of a create_layers call, read and normalised before anything reaches a document (docs/mcp-server.md §Editing): the
// schema is read leniently (a model's slips are read the way they were meant: numbers as strings, enums by a common synonym, missing
// fields), then every spec is checked: counts, lengths, numbers, colours, fonts of the catalogue, parents that are earlier frames, and
// no URL, markup or control character anywhere. Harmless slips are normalised, never refused; a URL, markup or a control character is.
import {z} from 'zod';
import {CANVAS_SPEC_CAPS, type CanvasNodeSpec} from './canvas-tools';

const sizing = z.enum(['FIXED', 'HUG', 'FILL']);
const nodeSpec = z.object({
  id: z.string(),
  parent: z.string().nullable(),
  type: z.enum(['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'IMAGE']),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fill: z.string().nullable(),
  stroke: z.object({color: z.string(), weight: z.number()}).nullable(),
  cornerRadius: z.number().nullable(),
  opacity: z.number().nullable(),
  layout: z
    .object({
      mode: z.enum(['HORIZONTAL', 'VERTICAL']),
      gap: z.number(),
      padding: z.object({top: z.number(), right: z.number(), bottom: z.number(), left: z.number()}),
      primaryAlign: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']),
      counterAlign: z.enum(['MIN', 'CENTER', 'MAX']),
      wrap: z.boolean(),
    })
    .nullable(),
  sizing: z.object({horizontal: sizing, vertical: sizing}).nullable(),
  text: z
    .object({
      characters: z.string(),
      fontFamily: z.string(),
      fontWeight: z.number(),
      fontSize: z.number(),
      lineHeight: z.number().nullable(),
      letterSpacing: z.number().nullable(),
      align: z.enum(['LEFT', 'CENTER', 'RIGHT']),
      color: z.string(),
    })
    .nullable(),
  image: z.object({description: z.string()}).nullable(),
});
const specList = z.object({create: z.array(nodeSpec)});

/** A URL, a scheme that runs or loads something, or a bare www. host. */
const URLISH =
  /(?:\b[a-z][a-z0-9+.-]{1,20}:\/\/|\bwww\.[a-z0-9-]|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+|\b(?:file|blob)\s*:\s*\/|\bmailto:\S)/i;
const MARKUP = /<\s*\/?\s*[a-z!?][^>]*>/i;
// Control characters other than tab and line feed (and the C1 range): never in a layer's text or name. A carriage return is read as a
// line break first.
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]');

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The refusals found so far: hostile content (a URL, markup, a control character), each `path: message`. */
type Ctx = {hostile: string[]};

function text(ctx: Ctx, where: string, raw: string, max: number, {lines = false} = {}): string {
  const value = raw.replace(/\r\n?/g, '\n');
  if (URLISH.test(value)) ctx.hostile.push(`${where}: a URL or a link scheme is not allowed.`);
  if (MARKUP.test(value)) ctx.hostile.push(`${where}: markup is not allowed.`);
  if (CONTROL.test(value)) ctx.hostile.push(`${where}: control characters are not allowed.`);
  const trimmed = lines ? value : value.replace(/[\n\t]+/g, ' ').trim();
  const chars = [...trimmed];
  return chars.length <= max ? trimmed : chars.slice(0, max).join('');
}
/** A number in its range: one out of it (or not finite) is clamped, a slip of the model, not a reason to refuse. */
function number(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(clamp(value, min, max) * 100) / 100;
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  white: '#FFFFFF', black: '#000000', red: '#FF0000', green: '#008000', blue: '#0000FF', grey: '#808080', gray: '#808080',
  yellow: '#FFFF00', orange: '#FFA500', pink: '#FFC0CB', purple: '#800080', transparent: '#00000000',
};
const byte = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0').toUpperCase();
/** A colour as #RRGGBB or #RRGGBBAA, from the forms a model writes (#RGB, #RGBA, the hex without #, rgb()/rgba(), a few names); null
 *  when it is none of them. */
export function normalizeColor(raw: string): string | null {
  const value = raw.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value) ?? /^([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!.length <= 4 ? [...hex[1]!].map(digit => digit + digit).join('') : hex[1]!;
    return '#' + digits.toUpperCase();
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i.exec(value);
  if (rgb) {
    const alpha = rgb[4] === undefined ? null : Number(rgb[4]) / (rgb[5] ? 100 : 1);
    return '#' + byte(Number(rgb[1])) + byte(Number(rgb[2])) + byte(Number(rgb[3])) + (alpha === null || alpha >= 1 ? '' : byte(alpha * 255));
  }
  return NAMED_COLORS[value.toLowerCase()] ?? null;
}

// ── The lenient read ─────────────────────────────────────────────────────────────────────────────

/** Names a model may write for an enum's value; the first candidate the enum has wins (LEFT is MIN for an alignment, LEFT for a text). */
const ENUM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  START: ['MIN'], LEFT: ['MIN'], TOP: ['MIN'], FLEX_START: ['MIN'], BASELINE: ['MIN'], STRETCH: ['FILL', 'MIN'],
  END: ['MAX'], RIGHT: ['MAX'], BOTTOM: ['MAX'], FLEX_END: ['MAX'],
  CENTRE: ['CENTER'], MIDDLE: ['CENTER'],
  SPACEBETWEEN: ['SPACE_BETWEEN'], BETWEEN: ['SPACE_BETWEEN'], JUSTIFY: ['SPACE_BETWEEN', 'LEFT'], JUSTIFIED: ['LEFT'],
  ROW: ['HORIZONTAL', 'FRAME'], COLUMN: ['VERTICAL', 'FRAME'], COL: ['VERTICAL'],
  FILL_CONTAINER: ['FILL'], FILL_PARENT: ['FILL'], HUG_CONTENTS: ['HUG'], HUG_CONTENT: ['HUG'], AUTO: ['HUG'], FIXED_SIZE: ['FIXED'],
  RECT: ['RECTANGLE'], LINE: ['RECTANGLE'], VECTOR: ['RECTANGLE'], DIVIDER: ['RECTANGLE'], CIRCLE: ['ELLIPSE'], OVAL: ['ELLIPSE'],
  GROUP: ['FRAME'], CONTAINER: ['FRAME'], COMPONENT: ['FRAME'], INSTANCE: ['FRAME'], SECTION: ['FRAME'], BUTTON: ['FRAME'], INPUT: ['FRAME'],
  CARD: ['FRAME'], STACK: ['FRAME'], BOX: ['FRAME'], DIV: ['FRAME'],
  IMG: ['IMAGE'], PICTURE: ['IMAGE'], PHOTO: ['IMAGE'], ICON: ['IMAGE'], LOGO: ['IMAGE'],
  LABEL: ['TEXT'], PARAGRAPH: ['TEXT'], HEADING: ['TEXT'],
};
const WEIGHTS: Readonly<Record<string, number>> = {thin: 100, extralight: 200, light: 300, regular: 400, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900};
const K = z.ZodFirstPartyTypeKind;

/**
 * The input read the way it was meant, before its schema: a number written as a string ("16", "16px"), a font weight by name ("bold"),
 * an enum in another case or by a common synonym ("center", "space-between", "fill_container", "rect"), a missing nullable as null and a
 * missing list as empty, a string written as a number. A list item that still does not fit its schema is left out, so one odd layer
 * never costs the whole call. Values are never invented: what cannot be read stays as it was and the schema says so.
 */
function lenient(schema: z.ZodTypeAny, value: unknown, path: string): unknown {
  const def = schema._def as {typeName: z.ZodFirstPartyTypeKind; values?: readonly string[]; type?: z.ZodTypeAny; innerType?: z.ZodTypeAny};
  switch (def.typeName) {
    case K.ZodNullable:
      return value === undefined || value === null ? null : lenient(def.innerType!, value, path);
    case K.ZodObject: {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const source = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(shape).map(key => [key, lenient(shape[key]!, source[key], path ? `${path}.${key}` : key)]));
    }
    case K.ZodArray: {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) return value;
      const items: unknown[] = [];
      value.forEach((item, index) => {
        const read = lenient(def.type!, item, `${path}[${index}]`);
        if (def.type!.safeParse(read).success) items.push(read);
      });
      return items;
    }
    case K.ZodNumber: {
      if (typeof value === 'number' && !Number.isFinite(value)) return 0;
      if (typeof value === 'string') {
        const weight = WEIGHTS[value.trim().toLowerCase().replace(/[\s_-]/g, '')];
        if (weight !== undefined && path.endsWith('fontWeight')) return weight;
        const read = /^\s*(-?\d+(?:\.\d+)?)\s*(?:px|pt)?\s*$/i.exec(value);
        if (read) return Number(read[1]);
      }
      return value;
    }
    case K.ZodString:
      return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value === undefined ? '' : value;
    case K.ZodBoolean:
      return value === 'true' ? true : value === 'false' ? false : value;
    case K.ZodEnum: {
      if (typeof value !== 'string') return value;
      const options = def.values ?? [];
      if (options.includes(value)) return value;
      const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (options.includes(key)) return key;
      const candidates = ENUM_SYNONYMS[key] ?? ENUM_SYNONYMS[key.replace(/_/g, '')] ?? [];
      return candidates.find(candidate => options.includes(candidate)) ?? value;
    }
    default:
      return value;
  }
}

// ── The check ───────────────────────────────────────────────────────────────────────────────────

type RawNode = z.infer<typeof nodeSpec>;
const DEFAULT_TEXT_COLOR = '#141414';

/** The id a layer keeps: letters, digits, - and _, at most 40, unique in the call. */
function localId(id: string, index: number, taken: Set<string>): string {
  let next = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || `layer_${index + 1}`;
  if (taken.has(next)) {
    let n = 2;
    while (taken.has(`${next.slice(0, 36)}-${n}`)) n++;
    next = `${next.slice(0, 36)}-${n}`;
  }
  taken.add(next);
  return next;
}

/**
 * The layers to create, normalised: ids made safe and unique, parents that exist (an unknown or circular one is the page), parents before
 * their children, a shape (rectangle or ellipse) that holds layers turned into a frame of the same look, a layer inside a text or an image
 * moved to that layer's own parent, numbers clamped to their ranges, colours read in their usual forms, a text layer without its text
 * given its name as text. Fonts are the catalogue's (others become Inter).
 */
function createOps(ctx: Ctx, list: readonly RawNode[], font: (family: string) => string | null): CanvasNodeSpec[] {
  const C = CANVAS_SPEC_CAPS;
  const nodes = list.slice(0, C.nodes);
  const taken = new Set<string>(),
    first = new Map<string, string>();
  const ids = nodes.map((node, index) => {
    const id = localId(node.id, index, taken);
    if (!first.has(node.id)) first.set(node.id, id);
    return id;
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  const parentOf: (string | null)[] = nodes.map((node, i) => {
    if (node.parent === null) return null;
    const parent = first.get(node.parent);
    return parent === undefined || parent === ids[i] ? null : parent;
  });
  // A circle of parents is broken where it closes: the layer whose parent leads back goes to the page.
  for (let i = 0; i < nodes.length; i++) {
    const seen = new Set<number>([i]);
    let child = i;
    while (parentOf[child] !== null) {
      const at = index.get(parentOf[child]!)!;
      if (seen.has(at)) {
        parentOf[child] = null;
        break;
      }
      seen.add(at);
      child = at;
    }
  }
  // Parents before their children, otherwise in the call's order.
  const order: number[] = [],
    placed = new Set<number>();
  const place = (i: number) => {
    if (placed.has(i)) return;
    placed.add(i);
    if (parentOf[i] !== null) place(index.get(parentOf[i]!)!);
    order.push(i);
  };
  nodes.forEach((_, i) => place(i));

  const made = new Map<string, CanvasNodeSpec>();
  const out: CanvasNodeSpec[] = [];
  for (const i of order) {
    const node = nodes[i]!,
      at = `create[${i}]`;
    let parent = parentOf[i] === null ? null : made.get(parentOf[i]!)!;
    let x = number(node.x, -100_000, 100_000, 0),
      y = number(node.y, -100_000, 100_000, 0);
    if (parent && (parent.type === 'RECTANGLE' || parent.type === 'ELLIPSE')) {
      // A button or a logo drawn as a shape with its text inside: the shape becomes a frame that looks the same.
      if (parent.type === 'ELLIPSE') parent.cornerRadius = Math.round((Math.min(parent.width, parent.height) / 2) * 100) / 100;
      parent.type = 'FRAME';
      parent.image = null;
    } else if (parent && parent.type !== 'FRAME') {
      // Nothing goes inside a text or a picture: the layer joins that layer's own parent, where it stood.
      if (!parent.parent || !made.get(parent.parent)?.layout) {
        x += parent.x;
        y += parent.y;
      }
      parent = parent.parent === null ? null : made.get(parent.parent)!;
    }
    const inLayout = !!parent?.layout;
    // An opacity in percent (80) is 0.8.
    const percent = node.opacity !== null && node.opacity > 1 && node.opacity <= 100;
    const opacity = node.opacity === null ? null : percent ? node.opacity / 100 : node.opacity;
    const fill = node.fill === null ? null : paint(node.fill);
    const strokeColor = node.stroke ? paint(node.stroke.color) : null;
    const spec: CanvasNodeSpec = {
      id: ids[i]!,
      parent: parent?.id ?? null,
      type: node.type,
      name: text(ctx, `${at}.name`, node.name, C.names) || node.type,
      x,
      y,
      width: number(node.width, 1, 10_000, 100),
      height: number(node.height, 1, 10_000, 100),
      fill,
      stroke: node.stroke && strokeColor ? {color: strokeColor, weight: number(node.stroke.weight, 0, 100, 1)} : null,
      cornerRadius: node.cornerRadius === null ? null : number(node.cornerRadius, 0, 5_000, 0),
      opacity: opacity === null ? null : number(opacity, 0, 1, 1),
      layout: null,
      sizing: null,
      text: null,
      image: null,
    };
    if (node.type === 'FRAME' && node.layout) {
      const l = node.layout,
        pad = (side: 'top' | 'right' | 'bottom' | 'left') => number(l.padding[side], 0, 1_000, 0);
      spec.layout = {
        mode: l.mode,
        gap: number(l.gap, 0, 1_000, 0),
        padding: {top: pad('top'), right: pad('right'), bottom: pad('bottom'), left: pad('left')},
        primaryAlign: l.primaryAlign,
        counterAlign: l.counterAlign,
        wrap: l.wrap,
      };
    }
    if (node.sizing) {
      // A sizing that cannot hold where the layer stands is made fixed: a slip of layout, not a reason to refuse the call.
      const canHug = (node.type === 'FRAME' && !!spec.layout) || node.type === 'TEXT';
      const fit = (value: 'FIXED' | 'HUG' | 'FILL') => (value === 'HUG' && !canHug) || (value === 'FILL' && !inLayout) ? 'FIXED' : value;
      spec.sizing = {horizontal: fit(node.sizing.horizontal), vertical: fit(node.sizing.vertical)};
    }
    if (node.type === 'TEXT') {
      const t = node.text ?? {characters: node.name, fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeight: null, letterSpacing: null, align: 'LEFT' as const, color: DEFAULT_TEXT_COLOR};
      const fontSize = number(t.fontSize, 1, 400, 16);
      // A line height of 3 or less is a multiplier of the size (1.4), not pixels.
      const multiplier = t.lineHeight !== null && t.lineHeight > 0 && t.lineHeight <= 3;
      const lineHeight = t.lineHeight === null ? null : multiplier ? t.lineHeight * fontSize : t.lineHeight;
      const color = paint(t.color);
      spec.text = {
        characters: text(ctx, `${at}.text.characters`, t.characters, C.chars, {lines: true}),
        fontFamily: font(t.fontFamily) ?? font('Inter') ?? 'Inter',
        fontWeight: clamp(Math.round((Number.isFinite(t.fontWeight) ? t.fontWeight : 400) / 100) * 100, 100, 900),
        fontSize,
        lineHeight: lineHeight === null ? null : number(lineHeight, 1, 1_000, fontSize * 1.3),
        letterSpacing: t.letterSpacing === null ? null : number(t.letterSpacing, -50, 200, 0),
        align: t.align,
        color: color ?? DEFAULT_TEXT_COLOR,
      };
    }
    if (node.type === 'IMAGE') spec.image = {description: text(ctx, `${at}.image.description`, node.image?.description || node.name, C.chars)};
    made.set(spec.id, spec);
    out.push(spec);
  }
  return out;
}
/** A colour, normalised; null (no paint) for none, transparent or what cannot be read. */
function paint(value: string): string | null {
  if (/^\s*(none|transparent|)\s*$/i.test(value)) return null;
  return normalizeColor(value);
}

export type SpecCheck = {ok: true; specs: CanvasNodeSpec[]} | {ok: false; problems: string[]};

/**
 * Checks the layer specs of one create_layers call (each with its optional fields set to their neutral values) and normalises them.
 * `font` returns the catalogue's spelling of a family or null. A URL, markup or a control character anywhere is refused; the other
 * slips are normalised (a short colour, a size of 0, a text inside a shape, a list over its cap, a parent that comes later).
 */
export function checkNodeSpecs(raw: readonly unknown[], font: (family: string) => string | null): SpecCheck {
  const ctx: Ctx = {hostile: []};
  const parsed = specList.safeParse(lenient(specList, {create: raw}, ''));
  if (!parsed.success) return {ok: false, problems: ['The answer does not follow the schema.']};
  const specs = createOps(ctx, parsed.data.create, font);
  return ctx.hostile.length ? {ok: false, problems: ctx.hostile} : {ok: true, specs};
}
