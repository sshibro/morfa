// The canvas tools' inputs (docs/mcp-server.md §Editing): what an assistant may send for each tool, checked before anything reaches a
// document. A call that fails is refused with its problems (the assistant usually fixes them in the next call). New layers go through
// the spec check (shared/design/canvas-tools-spec.ts): catalogue fonts, bounded numbers, colours, parents that are earlier frames, and
// no URL, markup or control character anywhere. Missing optional fields of a layer get their neutral value first, so the caller may
// leave out what it does not set.
import {z} from 'zod';
import {
  CANVAS_SPEC_CAPS,
  CANVAS_TOOL_CAPS as T,
  type CanvasLayerUpdate,
  type CanvasLayout,
  type CanvasNodeSpec,
  type CanvasText,
  type CanvasToolCall,
  type CanvasToolInputs,
  type CanvasToolName,
} from './canvas-tools';
import {checkNodeSpecs} from './canvas-tools-spec';

/** A layer's alias as the tools take them: "L1", "L2", ... */
const CANVAS_ALIAS = /^L[0-9]{1,6}$/;
const COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const URLISH =
  /(?:\b[a-z][a-z0-9+.-]{1,20}:\/\/|\bwww\.[a-z0-9-]|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+|\b(?:file|blob)\s*:\s*\/|\bmailto:\S)/i;
const MARKUP = /<\s*\/?\s*[a-z!?][^>]*>/i;
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]');

export type CanvasToolCheck = {ok: true; call: CanvasToolCall} | {ok: false; problems: string[]};

type Ctx = {problems: string[]};
function clean(ctx: Ctx, where: string, value: unknown, max: number, {lines = false} = {}): string {
  if (typeof value !== 'string') {
    ctx.problems.push(`${where}: a string.`);
    return '';
  }
  if (URLISH.test(value)) ctx.problems.push(`${where}: a URL or a link scheme is not allowed.`);
  if (MARKUP.test(value)) ctx.problems.push(`${where}: markup is not allowed.`);
  if (CONTROL.test(value)) ctx.problems.push(`${where}: control characters are not allowed.`);
  const text = lines ? value.replace(/\r\n?/g, '\n') : value.replace(/[\n\t]+/g, ' ').trim();
  if ([...text].length > max) ctx.problems.push(`${where}: longer than ${max} characters.`);
  return text;
}
function num(ctx: Ctx, where: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    ctx.problems.push(`${where}: a number from ${min} to ${max}.`);
    return min;
  }
  return Math.round(value * 100) / 100;
}
function hex(ctx: Ctx, where: string, value: unknown): string {
  if (typeof value !== 'string' || !COLOR.test(value)) {
    ctx.problems.push(`${where}: a colour is #RRGGBB or #RRGGBBAA.`);
    return '#000000';
  }
  return value.toUpperCase();
}
function alias(ctx: Ctx, where: string, value: unknown): string {
  if (typeof value !== 'string' || !CANVAS_ALIAS.test(value)) {
    ctx.problems.push(`${where}: a layer id such as "L12" (from morfa_get_file, morfa_get_layers or an earlier result).`);
    return '';
  }
  return value;
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function list(ctx: Ctx, where: string, value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) {
    ctx.problems.push(`${where}: a list.`);
    return [];
  }
  if (value.length < min || value.length > max) ctx.problems.push(`${where}: ${min} to ${max} items.`);
  return value.slice(0, max);
}

/** The text defaults a TEXT spec may leave out. */
const TEXT_DEFAULTS: Omit<CanvasText, 'characters'> = {fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeight: null, letterSpacing: null, align: 'LEFT', color: '#111111'};
/** A layer spec with the fields the caller left out set to their neutral values (the spec schema needs every field). */
function withDefaults(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const spec: Record<string, unknown> = {
    parent: null, x: 0, y: 0, fill: null, stroke: null, cornerRadius: null, opacity: null, layout: null, sizing: null, text: null, image: null,
    ...raw,
  };
  if (spec.name === undefined && typeof spec.type === 'string') spec.name = spec.type;
  if (isObject(spec.text)) spec.text = {...TEXT_DEFAULTS, ...spec.text};
  spec.layout = layoutDefaults(spec.layout);
  return spec;
}
/** An auto layout with the alignment, gap, padding and wrap the caller left out. */
function layoutDefaults(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return {gap: 0, primaryAlign: 'MIN', counterAlign: 'MIN', wrap: false, ...raw, padding: {top: 0, right: 0, bottom: 0, left: 0, ...(isObject(raw.padding) ? raw.padding : {})}};
}

const layoutSchema = z.object({
  mode: z.enum(['HORIZONTAL', 'VERTICAL']),
  gap: z.number(),
  padding: z.object({top: z.number(), right: z.number(), bottom: z.number(), left: z.number()}),
  primaryAlign: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']),
  counterAlign: z.enum(['MIN', 'CENTER', 'MAX']),
  wrap: z.boolean(),
});
const sizingSchema = z.object({horizontal: z.enum(['FIXED', 'HUG', 'FILL']), vertical: z.enum(['FIXED', 'HUG', 'FILL'])});

function checkLayout(ctx: Ctx, where: string, raw: unknown): CanvasLayout | null {
  const parsed = layoutSchema.safeParse(layoutDefaults(raw));
  if (!parsed.success) {
    ctx.problems.push(`${where}: {mode: HORIZONTAL|VERTICAL, gap, padding {top,right,bottom,left}, primaryAlign, counterAlign, wrap}.`);
    return null;
  }
  const l = parsed.data,
    pad = (side: 'top' | 'right' | 'bottom' | 'left') => num(ctx, `${where}.padding.${side}`, l.padding[side], 0, 1_000);
  return {mode: l.mode, gap: num(ctx, `${where}.gap`, l.gap, 0, 1_000), padding: {top: pad('top'), right: pad('right'), bottom: pad('bottom'), left: pad('left')}, primaryAlign: l.primaryAlign, counterAlign: l.counterAlign, wrap: l.wrap};
}

function checkUpdate(ctx: Ctx, where: string, raw: unknown, font: (family: string) => string | null): CanvasLayerUpdate | null {
  if (!isObject(raw)) {
    ctx.problems.push(`${where}: an object with the layer's id and the fields to change.`);
    return null;
  }
  const out: CanvasLayerUpdate = {id: alias(ctx, `${where}.id`, raw.id)};
  const C = CANVAS_SPEC_CAPS;
  if (raw.name !== undefined) out.name = clean(ctx, `${where}.name`, raw.name, C.names);
  if (raw.x !== undefined) out.x = num(ctx, `${where}.x`, raw.x, -100_000, 100_000);
  if (raw.y !== undefined) out.y = num(ctx, `${where}.y`, raw.y, -100_000, 100_000);
  if (raw.width !== undefined) out.width = num(ctx, `${where}.width`, raw.width, 1, 10_000);
  if (raw.height !== undefined) out.height = num(ctx, `${where}.height`, raw.height, 1, 10_000);
  if (raw.fill !== undefined) out.fill = raw.fill === null ? null : hex(ctx, `${where}.fill`, raw.fill);
  if (raw.stroke !== undefined) {
    if (raw.stroke === null) out.stroke = null;
    else if (isObject(raw.stroke)) out.stroke = {color: hex(ctx, `${where}.stroke.color`, raw.stroke.color), weight: num(ctx, `${where}.stroke.weight`, raw.stroke.weight, 0, 100)};
    else ctx.problems.push(`${where}.stroke: {color, weight} or null.`);
  }
  if (raw.cornerRadius !== undefined) out.cornerRadius = num(ctx, `${where}.cornerRadius`, raw.cornerRadius, 0, 5_000);
  if (raw.opacity !== undefined) out.opacity = num(ctx, `${where}.opacity`, raw.opacity, 0, 1);
  if (raw.visible !== undefined) {
    if (typeof raw.visible === 'boolean') out.visible = raw.visible;
    else ctx.problems.push(`${where}.visible: true or false.`);
  }
  if (raw.layout !== undefined) out.layout = raw.layout === null ? null : checkLayout(ctx, `${where}.layout`, raw.layout);
  if (raw.sizing !== undefined) {
    const parsed = sizingSchema.safeParse(raw.sizing);
    if (parsed.success) out.sizing = parsed.data;
    else ctx.problems.push(`${where}.sizing: {horizontal, vertical}, each FIXED, HUG or FILL.`);
  }
  if (raw.text !== undefined) {
    if (!isObject(raw.text)) ctx.problems.push(`${where}.text: an object of text fields.`);
    else {
      const t = raw.text,
        text: Partial<CanvasText> = {};
      if (t.characters !== undefined) text.characters = clean(ctx, `${where}.text.characters`, t.characters, C.chars, {lines: true});
      if (t.fontFamily !== undefined) {
        const family = typeof t.fontFamily === 'string' ? font(t.fontFamily) : null;
        if (family) text.fontFamily = family;
        else ctx.problems.push(`${where}.text.fontFamily: a family of the font catalogue.`);
      }
      if (t.fontWeight !== undefined) text.fontWeight = Math.min(900, Math.max(100, Math.round(num(ctx, `${where}.text.fontWeight`, t.fontWeight, 100, 900) / 100) * 100));
      if (t.fontSize !== undefined) text.fontSize = num(ctx, `${where}.text.fontSize`, t.fontSize, 1, 400);
      if (t.lineHeight !== undefined) text.lineHeight = t.lineHeight === null ? null : num(ctx, `${where}.text.lineHeight`, t.lineHeight, 1, 1_000);
      if (t.letterSpacing !== undefined) text.letterSpacing = t.letterSpacing === null ? null : num(ctx, `${where}.text.letterSpacing`, t.letterSpacing, -50, 200);
      if (t.align !== undefined) {
        if (t.align === 'LEFT' || t.align === 'CENTER' || t.align === 'RIGHT') text.align = t.align;
        else ctx.problems.push(`${where}.text.align: LEFT, CENTER or RIGHT.`);
      }
      if (t.color !== undefined) text.color = hex(ctx, `${where}.text.color`, t.color);
      out.text = text;
    }
  }
  if (raw.parent !== undefined) out.parent = raw.parent === null ? null : alias(ctx, `${where}.parent`, raw.parent);
  if (raw.index !== undefined) out.index = num(ctx, `${where}.index`, raw.index, 0, 10_000);
  if (Object.keys(out).length === 1) ctx.problems.push(`${where}: no field to change.`);
  return out;
}

/**
 * Checks one tool call. `font` returns the catalogue's spelling of a family or null. Nothing outside a tool's fields passes: unknown
 * fields are ignored, and every string is checked for links, markup and control characters.
 */
export function checkCanvasTool(name: string, id: string, raw: unknown, font: (family: string) => string | null): CanvasToolCheck {
  const ctx: Ctx = {problems: []};
  const input = isObject(raw) ? raw : {};
  if (!isObject(raw)) ctx.problems.push('The input must be an object.');
  const done = <K extends CanvasToolName>(tool: K, value: CanvasToolInputs[K]): CanvasToolCheck =>
    ctx.problems.length ? {ok: false, problems: ctx.problems.slice(0, 30)} : {ok: true, call: {id, name: tool, input: value} as CanvasToolCall};

  switch (name as CanvasToolName) {
    case 'create_layers': {
      const parent = input.parent === undefined || input.parent === null ? null : alias(ctx, 'parent', input.parent);
      const layers = list(ctx, 'layers', input.layers, 1, T.create);
      if (ctx.problems.length) return done('create_layers', {parent, layers: []});
      const checked = checkNodeSpecs(layers.map(withDefaults), font);
      if (!checked.ok) {
        ctx.problems.push(...checked.problems.map(problem => problem.replace(/^create\[/, 'layers[')));
        return done('create_layers', {parent, layers: []});
      }
      // The spec check knows no parent outside the call, so it makes a top-level layer's FILL fixed. Built into an existing frame
      // (`parent`), a section may fill that frame's auto layout: its FILL is kept (the executor makes it fixed if the frame has none).
      const specs: CanvasNodeSpec[] = checked.specs;
      if (parent) {
        const asked = new Map(layers.filter(isObject).map(layer => [layer.id, sizingSchema.safeParse(layer.sizing)]));
        for (const spec of specs) {
          const wanted = asked.get(spec.id);
          if (spec.parent !== null || !spec.sizing || !wanted?.success) continue;
          spec.sizing = {
            horizontal: wanted.data.horizontal === 'FILL' ? 'FILL' : spec.sizing.horizontal,
            vertical: wanted.data.vertical === 'FILL' ? 'FILL' : spec.sizing.vertical,
          };
        }
      }
      return done('create_layers', {parent, layers: specs});
    }
    case 'update_layers': {
      const updates = list(ctx, 'updates', input.updates, 1, T.updates)
        .map((raw, index) => checkUpdate(ctx, `updates[${index}]`, raw, font))
        .filter((update): update is CanvasLayerUpdate => !!update);
      return done('update_layers', {updates});
    }
    case 'delete_layers':
      return done('delete_layers', {ids: list(ctx, 'ids', input.ids, 1, T.deletes).map((value, index) => alias(ctx, `ids[${index}]`, value))});
    case 'duplicate_layers':
      return done('duplicate_layers', {ids: list(ctx, 'ids', input.ids, 1, T.duplicates).map((value, index) => alias(ctx, `ids[${index}]`, value))});
    case 'add_color_styles': {
      const group = input.group === undefined ? 'Palette' : clean(ctx, 'group', input.group, CANVAS_SPEC_CAPS.names);
      const colors = list(ctx, 'colors', input.colors, 1, T.colors).map((raw, index) => {
        const item = isObject(raw) ? raw : {};
        return {name: clean(ctx, `colors[${index}].name`, item.name, CANVAS_SPEC_CAPS.names) || `Color ${index + 1}`, color: hex(ctx, `colors[${index}].color`, item.color)};
      });
      return done('add_color_styles', {group: group || 'Palette', colors});
    }
    default:
      return {ok: false, problems: [`There is no tool "${String(name).slice(0, 40)}".`]};
  }
}
