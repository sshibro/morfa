import type {Decl} from './css';
import type {UEl} from './merge';
import type {InteractiveState} from './model';
import type {Space} from './space';
import {explain} from './variant-logic';

// The styles of one element across a component's variants, as rules a stylesheet can hold: the default look,
// then what changes with a variant prop (`[data-size='small']`), with a combination of them, and in an
// interaction state (`:hover`). The printers (react.ts) turn the rules into CSS Modules selectors, Tailwind
// variants or inline-style objects.

/** When a rule applies: these variant options (rest-space dimension → option), in this interaction state. */
export type Cond = {dims: [number, string][]; state: InteractiveState | null; pseudo?: '::placeholder'};
export type StyleRule = {cond: Cond; decls: Decl[]};
export type ElementStyle = {base: Decl[]; rules: StyleRule[]};

/** The browser shows these in this order, so later states win: a pressed button is also hovered. */
export const STATE_ORDER: readonly InteractiveState[] = ['hover', 'focus', 'active', 'disabled'];

const UNSET = 'unset';
const SAME = '\u0001same';

/** What a property becomes where a variant leaves it out: its CSS initial value, written plainly (`box-shadow: none`, not
 *  `unset`); a colour goes back to the parent's. */
const INITIAL: Record<string, string> = {
  'box-shadow': 'none', background: 'none', filter: 'none', 'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none', 'text-shadow': 'none', outline: 'none',
  border: '0', 'border-top': '0', 'border-right': '0', 'border-bottom': '0', 'border-left': '0', 'border-radius': '0', 'outline-offset': '0', opacity: '1', transform: 'none',
  'mix-blend-mode': 'normal', overflow: 'visible', padding: '0', margin: '0', gap: '0', 'flex-shrink': '1', flex: '0 1 auto', 'align-self': 'auto', 'justify-content': 'flex-start',
  'align-items': 'stretch', 'flex-direction': 'row', 'text-decoration': 'none', 'text-transform': 'none', 'font-style': 'normal', 'white-space': 'normal', 'letter-spacing': 'normal',
  'line-height': 'normal', width: 'auto', height: 'auto', 'min-width': '0', 'max-width': 'none', 'min-height': '0', 'max-height': 'none', position: 'static', top: 'auto',
  right: 'auto', bottom: 'auto', left: 'auto', color: 'inherit', 'border-image': 'none', '-webkit-text-stroke': '0',
};
const initialOf = (prop: string) => INITIAL[prop] ?? UNSET;

const condKey = (cond: Cond) => JSON.stringify([cond.dims, cond.state, cond.pseudo ?? '']);

/** The rules of `u` (its versions indexed by model variant), or null when no rest variant has it. */
export function elementStyle(u: UEl, space: Space): ElementStyle | null {
  const restDomain = space.variants.map((_, r) => r).filter(r => u.per[space.source[r]]);
  if (!restDomain.length) return null;
  const base = restDomain.includes(space.defaultIndex) ? space.defaultIndex : restDomain[0];
  const declsOf = (v: number) => u.per[v]?.decls ?? [];

  // An input's text colour is its value's; the default variant's grey is the placeholder's (::placeholder).
  const input = u.per.find(Boolean)?.field === 'input';
  const baseText = u.per[space.source[base]]?.text;
  const typed = input ? u.per.find(el => el && el.text !== baseText && el.decls.some(decl => decl.prop === 'color')) : undefined;
  const valueColor = typed?.decls.find(decl => decl.prop === 'color')?.value;
  const valueAt = (v: number, prop: string): string => {
    if (input && prop === 'color' && valueColor && u.per[v]) return valueColor;
    return declsOf(v).find(decl => decl.prop === prop)?.value ?? UNSET;
  };

  const meta = new Map<string, Decl>();
  const order: string[] = [];
  const visit = (v: number) => {
    for (const decl of declsOf(v)) if (!meta.has(decl.prop)) {
      meta.set(decl.prop, decl);
      order.push(decl.prop);
    }
  };
  visit(space.source[base]);
  for (const r of restDomain) visit(space.source[r]);
  space.stateOf.forEach((state, v) => state && visit(v));

  const baseDecls: Decl[] = [];
  const rules = new Map<string, StyleRule>();
  const add = (cond: Cond, prop: string, value: string) => {
    const key = condKey(cond);
    let rule = rules.get(key);
    if (!rule) rules.set(key, rule = {cond, decls: []});
    const {reset: _reset, ...decl} = meta.get(prop)!;
    rule.decls.push({...decl, value: value === UNSET ? initialOf(prop) : value});
  };
  const allDims = space.variantProps.map((_, d) => d);

  // The looks: what each variant prop changes.
  for (const prop of order) {
    const valueOf = (r: number) => valueAt(space.source[r], prop);
    const baseValue = valueOf(base);
    if (baseValue !== UNSET) baseDecls.push({...meta.get(prop)!, value: baseValue});
    const how = explain(space, restDomain, valueOf, allDims);
    if (how.kind === 'const') continue;
    if (how.kind === 'prop') {
      for (const option of optionIds(space, how.prop)) {
        const value = how.byOption.get(option);
        if (value !== undefined && value !== baseValue) add({dims: [[how.prop, option]], state: null}, prop, value);
      }
      continue;
    }
    for (const r of restDomain) {
      const value = valueOf(r);
      if (r !== base && value !== baseValue) add({dims: allDims.map(d => [d, space.variants[r].options[d]]), state: null}, prop, value);
    }
  }

  // The interaction states: what each changes against the look it is a state of.
  const otherDims = allDims.filter(d => d !== space.stateProp);
  const restLook = (r: number) => space.stateProp === null || space.variants[r].options[space.stateProp] === (space.variantProps[space.stateProp].kind === 'variantBool' ? 'false' : String(space.variantProps[space.stateProp].defaultRaw));
  const looks = restDomain.filter(restLook);
  for (const state of STATE_ORDER) {
    const variantOf = new Map<number, number>();
    space.stateOf.forEach((of, v) => {
      const r = space.restOf[v];
      if (of === state && r !== null && u.per[v] && looks.includes(r)) variantOf.set(r, v);
    });
    if (!variantOf.size) continue;
    for (const prop of order) {
      const valueOf = (r: number) => {
        const v = variantOf.get(r);
        if (v === undefined) return SAME;
        const value = valueAt(v, prop);
        return value === valueAt(space.source[r], prop) ? SAME : value;
      };
      const how = explain(space, looks, valueOf, otherDims);
      if (how.kind === 'const') {
        if (how.value !== SAME) add({dims: [], state}, prop, how.value);
      } else if (how.kind === 'prop') {
        for (const option of optionIds(space, how.prop)) {
          const value = how.byOption.get(option);
          if (value !== undefined && value !== SAME) add({dims: [[how.prop, option]], state}, prop, value);
        }
      } else {
        for (const r of looks) {
          const value = valueOf(r);
          if (value !== SAME) add({dims: otherDims.map(d => [d, space.variants[r].options[d]]), state}, prop, value);
        }
      }
    }
  }

  // A look that cannot be pressed does not offer the pointer of one that can.
  if (baseDecls.some(decl => decl.prop === 'cursor' && decl.value === 'pointer') && space.stateOf.includes('disabled')) add({dims: [], state: 'disabled'}, 'cursor', 'not-allowed');

  if (input && valueColor) {
    const placeholder = declsOf(space.source[base]).find(decl => decl.prop === 'color')?.value;
    if (placeholder && placeholder !== valueColor) add({dims: [], state: null, pseudo: '::placeholder'}, 'color', placeholder);
  }

  // Looks first (dimension order, then combinations), then states in the browser's order, then the placeholder.
  const sorted = [...rules.values()].sort((a, b) => rank(a.cond) - rank(b.cond));
  return {base: baseDecls, rules: sorted};
}

function rank(cond: Cond): number {
  if (cond.pseudo) return 1000;
  const state = cond.state ? (STATE_ORDER.indexOf(cond.state) + 1) * 100 : 0;
  return state + (cond.dims.length > 1 ? 50 : cond.dims.length ? cond.dims[0][0] : 0);
}

/** A dimension's option ids in the order the designer listed them. */
export function optionIds(space: Space, dim: number): string[] {
  const prop = space.variantProps[dim];
  return prop.kind === 'variantBool' ? ['true', 'false'] : prop.options.map(option => option.id);
}
