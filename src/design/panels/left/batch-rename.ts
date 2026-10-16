import type {DesignDocument, NodeId} from '../../../../shared/design/types';

// "Rename layers" (Figma's Rename layers, help.figma.com 360039958934) for several layers at once. "Find" picks the part
// of each name to change (a regular expression; empty: the whole name, text that is not a valid expression: itself);
// "Replace with" is what goes there, where $& is the found part (the whole name when "Find" is empty), $1, $2… its groups,
// $` and $' what stands before and after it, $n a number counting up from "Start at" and $N one counting down to it
// ($nn, $NNN…: at least that many digits). Layers are numbered in the layers panel's order, top to bottom.

export const RENAME_TOKENS = {current: '$&', up: '$n', down: '$N'} as const;

export type RenameRule = {find: string; replace: string; start: number};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The expression "Find" stands for: the whole name when empty, the text itself when it is not a valid expression. */
export function findPattern(find: string): RegExp {
  if (!find) return /^[\s\S]*$/;
  try {
    return new RegExp(find, 'g');
  } catch {
    return new RegExp(escapeRegExp(find), 'g');
  }
}

/** The new names for `names` (in panel order). A name that would come out empty keeps its old one. */
export function renameAll(names: readonly string[], rule: RenameRule): string[] {
  const pattern = findPattern(rule.find);
  const start = Number.isFinite(rule.start) ? Math.trunc(rule.start) : 1;
  return names.map((name, index) => {
    const up = start + index, down = start + names.length - 1 - index;
    // The counters first: what is left ($&, $1, $`…) is String.replace's own.
    const replacement = rule.replace.replace(/\$(n+|N+)/g, (_, run: string) => {
      const value = run[0] === 'n' ? up : down;
      const digits = String(Math.abs(value)).padStart(run.length, '0');
      return (value < 0 ? '-' : '') + digits;
    });
    pattern.lastIndex = 0;
    const next = name.replace(pattern, replacement).trim();
    return next || name;
  });
}

/** `ids` in the layers panel's order, top to bottom (the topmost layer of the page first, a parent before its children). */
export function renameOrder(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const keyOf = (id: NodeId): number[] => {
    const key: number[] = [];
    let node = doc.nodes[id];
    while (node?.parentId) {
      const parent = doc.nodes[node.parentId];
      const siblings = parent?.children ?? [];
      // The panel lists children top layer first.
      key.unshift(siblings.length - 1 - siblings.indexOf(node.id));
      node = parent;
    }
    return key;
  };
  const keys = new Map(ids.map(id => [id, keyOf(id)]));
  return [...ids].sort((a, b) => {
    const ka = keys.get(a)!, kb = keys.get(b)!;
    for (let k = 0; k < Math.min(ka.length, kb.length); k++) if (ka[k] !== kb[k]) return ka[k] - kb[k];
    return ka.length - kb.length;
  });
}
