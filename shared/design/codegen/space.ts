import {stateApi, type ComponentModel, type InteractiveState, type PropDef} from './model';
import type {VariantSpace} from './variant-logic';

// The variants a component's JSX is written over. Interaction states (hover, pressed, focus, disabled) are not
// props: their variants leave the space and come back as CSS states of the look they are a state of. What stays
// is the "rest" space: the variant props as the component takes them (the state property reduced to its own
// looks, e.g. `error`), and the variants without an interaction state.

export type Space = VariantSpace & {
  /** Rest variant → model variant. */
  source: number[];
  /** Model variant → the rest variant it is a state of (itself for a rest variant), null when there is none. */
  restOf: (number | null)[];
  /** Model variant → its interaction state; null for a rest variant. */
  stateOf: (InteractiveState | null)[];
  /** Index in `variantProps` of the state property's own looks (`error`), null when they were dropped. */
  stateProp: number | null;
};

/** One variant, no props: a screen, or a component without variants. */
export const SINGLE_SPACE: Space = {variantProps: [], variants: [{nodeId: '', options: []}], defaultIndex: 0, source: [0], restOf: [0], stateOf: [null], stateProp: null};

export function restSpace(model: ComponentModel | null): Space {
  if (!model) return SINGLE_SPACE;
  const state = model.state;
  if (!state) {
    const identity = model.variants.map((_, i) => i);
    return {variantProps: model.variantProps, variants: model.variants, defaultIndex: model.defaultIndex, source: identity, restOf: identity, stateOf: model.variants.map(() => null), stateProp: null};
  }
  const p = state.prop;
  const api = stateApi(model).prop;
  const variantProps: PropDef[] = [];
  let stateProp: number | null = null;
  model.variantProps.forEach((prop, i) => {
    if (i !== p) variantProps.push(prop);
    else if (api) {
      stateProp = variantProps.length;
      variantProps.push(api);
    }
  });
  const remap = (options: readonly string[]) => options.flatMap((option, i) => {
    if (i !== p) return [option];
    if (!api) return [];
    return [api.kind === 'variantBool' ? (option === state.rest ? 'false' : 'true') : option];
  });
  const source: number[] = [];
  const variants = [];
  const stateOf: (InteractiveState | null)[] = [];
  for (let v = 0; v < model.variants.length; v++) {
    const of = state.of.get(model.variants[v].options[p]) ?? 'rest';
    stateOf.push(of === 'rest' ? null : of);
    if (of !== 'rest') continue;
    source.push(v);
    variants.push({nodeId: model.variants[v].nodeId, options: remap(model.variants[v].options)});
  }
  // A state's look is the rest variant with the same other options and the default state.
  const restOf = model.variants.map((variant, v) => {
    if (stateOf[v] === null) return source.indexOf(v);
    const match = source.findIndex(u => model.variants[u].options.every((option, i) => (i === p ? option === state.rest : option === variant.options[i])));
    return match >= 0 ? match : null;
  });
  if (!variants.length) {
    // Every variant is a state (no default look): the default variant stands for the rest.
    return {...SINGLE_SPACE, variants: [{nodeId: model.variants[model.defaultIndex].nodeId, options: []}], source: [model.defaultIndex], restOf: model.variants.map(() => 0), stateOf: model.variants.map((_, v) => (v === model.defaultIndex ? null : stateOf[v]))};
  }
  const defaultIndex = Math.max(0, restOf[model.defaultIndex] ?? 0);
  return {variantProps, variants, defaultIndex, source, restOf, stateOf, stateProp};
}
