import type {VariantSpace} from './variant-logic';
import type {El, Piece} from './tree';

// The trees of a component's variants merged into one: each element knows its version in every variant (null
// where a variant lacks it), matched by key (names and positions from the component root).

export type UEl = {kind: 'u'; key: string; per: (El | null)[]; children: UChild[]};
export type UPiece = {kind: 'p'; key: string; per: (Piece | null)[]};
export type UChild = UEl | UPiece;

/** One tree whose elements know their version in every variant (null where a variant lacks them). */
export function mergeVariants(trees: (El | null)[], space: Pick<VariantSpace, 'defaultIndex'>): UEl | null {
  const order = [space.defaultIndex, ...trees.map((_, i) => i).filter(i => i !== space.defaultIndex)];
  if (!trees.some(Boolean)) return null;
  return mergeElement(trees, order);
}

function mergeElement(per: (El | null)[], order: number[]): UEl {
  const first = per.find(Boolean)!;
  return {kind: 'u', key: first.key, per, children: mergeChildren(per.map(el => el?.children ?? null), order)};
}

function mergeChildren(lists: ((El | Piece)[] | null)[], order: number[]): UChild[] {
  const keys: string[] = [];
  const entries = new Map<string, (El | Piece | null)[]>();
  for (const v of order) {
    const list = lists[v];
    if (!list) continue;
    let previous: string | null = null;
    for (const child of list) {
      // A text and an expression in the same place are one piece (a variant writes its own text where the prop goes).
      const key = child.kind === 'el' ? child.key : child.kind === 'br' ? `br:${child.key}` : `p:${child.key}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = lists.map(() => null);
        entries.set(key, entry);
        keys.splice(previous === null ? 0 : keys.indexOf(previous) + 1, 0, key);
      }
      entry[v] = child;
      previous = key;
    }
  }
  return keys.map(key => {
    const per = entries.get(key)!;
    const first = per.find(Boolean)!;
    if (first.kind === 'el') return mergeElement(per as (El | null)[], order);
    return {kind: 'p', key, per: per as (Piece | null)[]};
  });
}
