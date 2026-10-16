// Reads the zod schemas of shared/design/schema.ts as data (lane S1): the fixture generator's coverage report and the
// parity mutator both walk `designDocumentSchema` / `documentPatchSchema` instead of restating them, so a field added to
// the schema shows up in the report and gets mutated without touching this harness.

import type {z} from 'zod';

export type Schema = z.ZodTypeAny;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Def = {typeName: string; [key: string]: any};
export const defOf = (schema: Schema): Def => schema._def as Def;
export const kindOf = (schema: Schema): string => defOf(schema).typeName;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A schema without its Optional / Nullable / Effects wrappers, and what the wrappers said. */
export type Unwrapped = {core: Schema; optional: boolean; nullable: boolean; refined: boolean};
export function unwrap(schema: Schema): Unwrapped {
  let core = schema,
    optional = false,
    nullable = false,
    refined = false;
  for (;;) {
    const def = defOf(core);
    if (def.typeName === 'ZodOptional') optional = true, (core = def.innerType);
    else if (def.typeName === 'ZodNullable') nullable = true, (core = def.innerType);
    else if (def.typeName === 'ZodEffects') refined = true, (core = def.schema);
    else return {core, optional, nullable, refined};
  }
}

export const objectShape = (schema: Schema): Record<string, Schema> => defOf(schema).shape();

/** The option of a discriminated union a value selects (by its tag), if any. */
export function duOption(schema: Schema, value: unknown): Schema | undefined {
  const def = defOf(schema);
  if (!isPlainObject(value)) return undefined;
  return (def.optionsMap as Map<unknown, Schema>).get(value[def.discriminator]);
}
/** Every tag of a discriminated union, grouped by option. */
export function duTags(schema: Schema): {tags: string[]; option: Schema}[] {
  const def = defOf(schema);
  const groups = new Map<Schema, string[]>();
  for (const [tag, option] of def.optionsMap as Map<string, Schema>) groups.set(option, [...(groups.get(option) ?? []), tag]);
  return [...groups].map(([option, tags]) => ({tags, option}));
}
/** zod keeps the first union option that parses. */
export function unionOption(schema: Schema, value: unknown): number {
  const options = defOf(schema).options as Schema[];
  return options.findIndex(option => option.safeParse(value).success);
}

export type StringBounds = {min: number; max: number; patterns: RegExp[]};
export function stringBounds(schema: Schema): StringBounds {
  const bounds: StringBounds = {min: 0, max: Infinity, patterns: []};
  for (const check of defOf(schema).checks)
    if (check.kind === 'min') bounds.min = check.value;
    else if (check.kind === 'max') bounds.max = check.value;
    else if (check.kind === 'regex') bounds.patterns.push(check.regex);
  return bounds;
}
export type NumberBounds = {min: number; minInclusive: boolean; max: number; maxInclusive: boolean; int: boolean; finite: boolean};
export function numberBounds(schema: Schema): NumberBounds {
  const bounds: NumberBounds = {min: -Infinity, minInclusive: true, max: Infinity, maxInclusive: true, int: false, finite: false};
  for (const check of defOf(schema).checks)
    if (check.kind === 'min') [bounds.min, bounds.minInclusive] = [check.value, check.inclusive];
    else if (check.kind === 'max') [bounds.max, bounds.maxInclusive] = [check.value, check.inclusive];
    else if (check.kind === 'int') bounds.int = true;
    else if (check.kind === 'finite') bounds.finite = true;
  return bounds;
}
export const arrayBounds = (schema: Schema) => {
  const def = defOf(schema);
  return {min: (def.minLength?.value as number | undefined) ?? 0, max: (def.maxLength?.value as number | undefined) ?? Infinity};
};

/** Runs a refinement the way schema.ts `compile` does. */
export function refinementPasses(schema: Schema, value: unknown): boolean {
  let failed = false;
  const result = defOf(schema).effect.refinement(value, {addIssue: () => (failed = true), path: []});
  return !failed && result !== false;
}

const recordCaps = new WeakMap<Schema, number>();
/** The entry cap of a `record(...)` of schema.ts (a refinement over the key count), found by asking the refinement. */
export function recordCap(effects: Schema): number {
  const cached = recordCaps.get(effects);
  if (cached !== undefined) return cached;
  const withKeys = (n: number) => {
    const map: Record<string, number> = {};
    for (let i = 0; i < n; i++) map['k' + i] = 0;
    return map;
  };
  let lo = 0,
    hi = 1;
  while (refinementPasses(effects, withKeys(hi)) && hi < 1 << 20) lo = hi, (hi *= 2);
  if (hi >= 1 << 20) return Infinity;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (refinementPasses(effects, withKeys(mid))) lo = mid;
    else hi = mid;
  }
  recordCaps.set(effects, lo);
  return lo;
}

// ── Coverage ─────────────────────────────────────────────────────────────────────────────────────

/** A point of the schema a fixture set may cover: a field present, an enum value, a union option, a null. */
export type PointKind = 'field' | 'enum' | 'tag' | 'union' | 'null' | 'literal';
export type Point = {kind: PointKind; path: string; value?: string};
export const pointKey = (point: Point) => `${point.kind} ${point.path}${point.value === undefined ? '' : ' = ' + point.value}`;

const optionLabel = (tags: string[]) => `<${tags.join('|')}>`;

/** Every coverage point of a schema, statically. */
export function schemaPoints(schema: Schema, path = ''): Point[] {
  const out: Point[] = [];
  const visit = (s: Schema, at: string) => {
    const def = defOf(s);
    switch (def.typeName) {
      case 'ZodOptional':
        return visit(def.innerType, at);
      case 'ZodNullable':
        out.push({kind: 'null', path: at});
        return visit(def.innerType, at);
      case 'ZodEffects':
        return visit(def.schema, at);
      case 'ZodObject':
        for (const [name, field] of Object.entries(objectShape(s))) {
          out.push({kind: 'field', path: at + '.' + name});
          visit(field, at + '.' + name);
        }
        return;
      case 'ZodArray':
        return visit(def.type, at + '[]');
      case 'ZodTuple':
        return (def.items as Schema[]).forEach(item => visit(item, at + '[]'));
      case 'ZodRecord':
        return visit(def.valueType, at + '{}');
      case 'ZodEnum':
        for (const value of def.values as string[]) out.push({kind: 'enum', path: at, value});
        return;
      case 'ZodDiscriminatedUnion':
        for (const {tags, option} of duTags(s)) {
          for (const tag of tags) out.push({kind: 'tag', path: at + '.' + def.discriminator, value: tag});
          visit(option, at + optionLabel(tags));
        }
        return;
      case 'ZodUnion':
        (def.options as Schema[]).forEach((option, i) => {
          out.push({kind: 'union', path: at, value: '#' + i + ' ' + kindOf(unwrap(option).core).replace('Zod', '')});
          visit(option, at + '#' + i);
        });
        return;
      default:
        return;
    }
  };
  visit(schema, path);
  // Field points of discriminator keys are covered by their tags; drop the duplicates.
  return out;
}

/** Marks the points a value covers (walks value and schema together). */
export function coverValue(schema: Schema, value: unknown, seen: Map<string, number>, path = '') {
  const hit = (point: Point) => {
    const key = pointKey(point);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  };
  const visit = (s: Schema, v: unknown, at: string) => {
    const def = defOf(s);
    switch (def.typeName) {
      case 'ZodOptional':
        if (v !== undefined) visit(def.innerType, v, at);
        return;
      case 'ZodNullable':
        if (v === null) return hit({kind: 'null', path: at});
        return visit(def.innerType, v, at);
      case 'ZodEffects':
        return visit(def.schema, v, at);
      case 'ZodObject':
        if (!isPlainObject(v)) return;
        for (const [name, field] of Object.entries(objectShape(s))) {
          if (!Object.hasOwn(v, name)) continue;
          hit({kind: 'field', path: at + '.' + name});
          visit(field, v[name], at + '.' + name);
        }
        return;
      case 'ZodArray':
        if (Array.isArray(v)) for (const item of v) visit(def.type, item, at + '[]');
        return;
      case 'ZodTuple':
        if (Array.isArray(v)) (def.items as Schema[]).forEach((item, i) => visit(item, v[i], at + '[]'));
        return;
      case 'ZodRecord':
        if (isPlainObject(v)) for (const item of Object.values(v)) visit(def.valueType, item, at + '{}');
        return;
      case 'ZodEnum':
        if (typeof v === 'string') hit({kind: 'enum', path: at, value: v});
        return;
      case 'ZodDiscriminatedUnion': {
        const option = duOption(s, v);
        if (!option || !isPlainObject(v)) return;
        hit({kind: 'tag', path: at + '.' + def.discriminator, value: String(v[def.discriminator])});
        const group = duTags(s).find(entry => entry.option === option)!;
        return visit(option, v, at + optionLabel(group.tags));
      }
      case 'ZodUnion': {
        const index = unionOption(s, v);
        if (index < 0) return;
        const option = (def.options as Schema[])[index];
        hit({kind: 'union', path: at, value: '#' + index + ' ' + kindOf(unwrap(option).core).replace('Zod', '')});
        return visit(option, v, at + '#' + index);
      }
      default:
        return;
    }
  };
  visit(schema, value, path);
}
