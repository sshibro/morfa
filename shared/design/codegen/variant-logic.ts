import {optionLiteral, type ComponentModel, type PropDef} from './model';

// Per-variant differences as code. A value (a CSS declaration, a text, whether a layer is there) is
// known for every variant; `explain` finds the one variant property it follows, so the code says
// `size === 'small'` instead of listing combinations, and falls back to whole combinations only when
// no single property explains it.

export type Explanation =
  | {kind: 'const'; value: string}
  | {kind: 'prop'; prop: number; byOption: Map<string, string>}
  | {kind: 'combo'};

export type VariantSpace = Pick<ComponentModel, 'variantProps' | 'variants' | 'defaultIndex'>;

/** How `valueOf` varies over the variants in `domain`: one value, the one property it follows (the first of `props` that
 *  explains it; every property by default), or combinations. */
export function explain(space: VariantSpace, domain: readonly number[], valueOf: (variant: number) => string, props?: readonly number[]): Explanation {
  const values = new Map<number, string>(domain.map(v => [v, valueOf(v)]));
  const distinct = new Set(values.values());
  if (distinct.size <= 1) return {kind: 'const', value: distinct.values().next().value ?? ''};
  for (const p of props ?? space.variantProps.keys()) {
    const byOption = new Map<string, string>();
    let ok = true;
    for (const v of domain) {
      const option = space.variants[v].options[p];
      const value = values.get(v)!;
      const seen = byOption.get(option);
      if (seen === undefined) byOption.set(option, value);
      else if (seen !== value) {
        ok = false;
        break;
      }
    }
    if (ok) return {kind: 'prop', prop: p, byOption};
  }
  return {kind: 'combo'};
}

/** `size === 'small'`, or `disabled` / `!disabled` for a switch. */
export function optionTest(prop: PropDef, option: string): string {
  if (prop.kind === 'variantBool') return option === 'true' ? prop.jsName : `!${prop.jsName}`;
  return `${prop.jsName} === ${optionLiteral(prop, option)}`;
}

function comboTest(space: VariantSpace, variant: number): string {
  return space.variantProps.map((prop, p) => optionTest(prop, space.variants[variant].options[p])).join(' && ');
}

/** The test that is true exactly for the variants in `present` (within `domain`), or null when it
 *  holds for all of them. */
export function presenceCondition(space: VariantSpace, domain: readonly number[], present: ReadonlySet<number>): string | null {
  if (domain.every(v => present.has(v))) return null;
  const explanation = explain(space, domain, v => (present.has(v) ? '1' : '0'));
  if (explanation.kind === 'const') return explanation.value === '1' ? null : 'false';
  if (explanation.kind === 'prop') {
    const prop = space.variantProps[explanation.prop];
    const yes = [...explanation.byOption].filter(([, value]) => value === '1').map(([option]) => option);
    const no = [...explanation.byOption].filter(([, value]) => value === '0').map(([option]) => option);
    if (prop.kind === 'variantBool') return optionTest(prop, yes[0]);
    if (yes.length === 1) return optionTest(prop, yes[0]);
    if (no.length === 1 && no.length + yes.length === prop.options.length) return `${prop.jsName} !== ${optionLiteral(prop, no[0])}`;
    return `(${yes.map(option => optionTest(prop, option)).join(' || ')})`;
  }
  const tests = domain.filter(v => present.has(v)).map(v => comboTest(space, v));
  return tests.length === 1 ? tests[0] : `(${tests.map(test => `(${test})`).join(' || ')})`;
}

/** An option as an object literal's key: quoted unless it is a name or a whole number ("1Mesyats", "0.5", "-1" are quoted). */
const objectKey = (id: string) => (/^[A-Za-z_$][\w$]*$|^\d+$/.test(id) ? id : `'${id}'`);

/** A JS expression choosing between per-variant expressions. `base` is the variant whose value is the
 *  fallback (an option no variant in `domain` has falls back to it too). */
export function switchExpression(space: VariantSpace, domain: readonly number[], valueOf: (variant: number) => string, base: number): string {
  const explanation = explain(space, domain, valueOf);
  if (explanation.kind === 'const') return explanation.value;
  const fallback = valueOf(base);
  if (explanation.kind === 'prop') {
    const prop = space.variantProps[explanation.prop];
    const valueFor = (option: string) => explanation.byOption.get(option) ?? fallback;
    if (prop.kind === 'variantBool') return `${prop.jsName} ? ${valueFor('true')} : ${valueFor('false')}`;
    const others = prop.options.filter(option => valueFor(option.id) !== fallback);
    if (others.length === 1) return `${optionTest(prop, others[0].id)} ? ${valueFor(others[0].id)} : ${fallback}`;
    return `{${prop.options.map(option => `${objectKey(option.id)}: ${valueFor(option.id)}`).join(', ')}}[${prop.jsName}]`;
  }
  let out = fallback;
  for (const v of [...domain].reverse()) {
    const value = valueOf(v);
    if (value !== fallback) out = `${comboTest(space, v)} ? ${value} : ${out}`;
  }
  return out;
}
