import type {DesignStore} from '../store';

// The shape builder by touch (lane PH): a finger has no ⌥, so on a phone or tablet the builder's bar chooses whether a tap
// or a drag merges regions or takes them away (editor/phone/ShapeBuilderBar.tsx). One choice per editor (store), read by the
// tool when a press starts (engine/tools/shape-builder.ts); a mouse with ⌥ still takes away whatever it says.

const takeAway = new WeakMap<DesignStore, boolean>();

export const touchTakesAway = (store: DesignStore): boolean => takeAway.get(store) ?? false;

export function setTouchTakesAway(store: DesignStore, on: boolean): void {
  takeAway.set(store, on);
}
