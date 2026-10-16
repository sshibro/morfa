import type {SceneNode} from '../../../../../shared/design/types';

// Values of a multi-selection, as the "Design" panel shows them: one value when every node agrees,
// 'mixed' ("Mixed") when they differ, null when no node has the field. Pure, shared by every panel
// section (paint, text and component agents import it too) and covered by node tests.

export type Mixed<T> = T | 'mixed' | null;
export const MIXED = 'mixed' as const;

/** Deep equality for panel values: numbers within 1e-6, arrays and plain objects by value. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 || (Number.isNaN(a) && Number.isNaN(b));
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameValue(value, b[i]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key in left) if (!sameValue(left[key], right[key])) return false;
  for (const key in right) if (!(key in left) && right[key] !== undefined) return false;
  return true;
}

/** The common value of a list: the value when all agree, 'mixed' when they differ, null when empty.
 *  `undefined` entries (a node without the field) are skipped. */
export function mixedOf<T>(values: Iterable<T | undefined>, equal: (a: T, b: T) => boolean = sameValue): Mixed<T> {
  let first: T | undefined;
  let seen = false;
  for (const value of values) {
    if (value === undefined) continue;
    if (!seen) {
      first = value;
      seen = true;
    } else if (!equal(first as T, value)) return MIXED;
  }
  return seen ? (first as T) : null;
}

/** `mixedOf` over a field read from each node. */
export const mixedField = <T>(nodes: readonly SceneNode[], read: (node: SceneNode) => T | undefined, equal?: (a: T, b: T) => boolean): Mixed<T> =>
  mixedOf(nodes.map(read), equal);

export const isMixed = <T>(value: Mixed<T>): value is 'mixed' => value === MIXED;

/** A number field's value: a number, "Mixed", or empty. */
export const numberOrMixed = (value: Mixed<number>): number | 'mixed' | null => value;

/** English plural: `plural(1, 'layer', 'layers')` is 'layer', any other count gives the last form. (Extra middle
 *  forms are accepted so callers written for languages with a few-form keep type-checking.) */
export function plural(count: number, one: string, ...others: [string, ...string[]]): string {
  return Math.abs(count) === 1 ? one : others[others.length - 1];
}

export const layersLabel = (count: number) => `${count} ${plural(count, 'layer', 'layers')}`;

/** A relative edit of a number: what a scrub of a mixed field, "+10" typed into one, or an arrow step does
 *  to each node's own value. Absolute edits are `() => value`. */
export type NumberEdit = (current: number) => number;
export const setTo = (value: number): NumberEdit => () => value;
