import type {NodeId, SceneNode} from '../types';
import type {Transaction} from '../transaction';
import {childPart, isSticky} from './model';
import {rgbToHex, STICKY_COLORS} from './palette';

// Putting a board in order (docs/board.md §Arranging): stickies sorted into groups by colour or by author (FigJam's "Sort"), the
// groups side by side as tidy columns of a grid, and a section fitted around what it holds ("Fit to contents"). Pure:
// positions are computed here and written through a transaction.

type Get = (id: NodeId | null | undefined) => SceneNode | undefined;

export type SortKey = 'color' | 'author';

const GAP = 24;
const GROUP_GAP = 96;

/** The colour name of a sticky (its fill's swatch) or its author line. */
export function stickyGroup(get: Get, sticky: SceneNode, by: SortKey): string {
  if (by === 'author') return childPart(get, sticky, 'author')?.text?.characters.trim() || 'No author';
  const fill = sticky.fills.find(paint => paint.type === 'SOLID' && paint.visible);
  if (fill?.type !== 'SOLID') return '—';
  const hex = rgbToHex(fill.color);
  return STICKY_COLORS.find(color => color.hex.toUpperCase() === hex)?.label ?? hex;
}

/** New top-left corners for `ids` (stickies of one parent): grouped, each group a grid `columns` wide, groups left to right from the
 *  selection's top-left corner, in the order the colours appear in the palette (or authors alphabetically). */
export function sortedPositions(get: Get, ids: readonly NodeId[], by: SortKey, columns = 3): {groups: {name: string; ids: NodeId[]}[]; positions: Map<NodeId, {x: number; y: number}>} {
  const stickies = ids.map(id => get(id)).filter((node): node is SceneNode => isSticky(node));
  const positions = new Map<NodeId, {x: number; y: number}>();
  if (!stickies.length) return {groups: [], positions};
  const left = Math.min(...stickies.map(node => node.x)), top = Math.min(...stickies.map(node => node.y));
  const byName = new Map<string, SceneNode[]>();
  for (const sticky of stickies) {
    const name = stickyGroup(get, sticky, by);
    const list = byName.get(name);
    if (list) list.push(sticky);
    else byName.set(name, [sticky]);
  }
  const order = by === 'color' ? STICKY_COLORS.map(color => color.label) : [...byName.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  const names = [...byName.keys()].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b, 'en'));
  let x = left;
  const groups: {name: string; ids: NodeId[]}[] = [];
  for (const name of names) {
    const members = byName.get(name)!.sort((a, b) => a.y - b.y || a.x - b.x);
    const cell = {width: Math.max(...members.map(node => node.width)), height: Math.max(...members.map(node => node.height))};
    const width = Math.min(columns, members.length);
    members.forEach((node, i) => positions.set(node.id, {x: x + (i % width) * (cell.width + GAP), y: top + Math.floor(i / width) * (cell.height + GAP)}));
    groups.push({name, ids: members.map(node => node.id)});
    x += width * (cell.width + GAP) - GAP + GROUP_GAP;
  }
  return {groups, positions};
}

/** Applies `sortedPositions` (stickies of different parents are left alone). */
export function sortStickies(tx: Transaction, ids: readonly NodeId[], by: SortKey, columns?: number): number {
  const get: Get = id => (id ? tx.get(id) : undefined);
  const parent = get(ids[0])?.parentId;
  const own = ids.filter(id => get(id)?.parentId === parent);
  const {positions} = sortedPositions(get, own, by, columns);
  for (const [id, at] of positions) tx.update(id, at);
  return positions.size;
}

export const SECTION_PADDING = {top: 64, right: 48, bottom: 48, left: 48};

/** Fits a section around its layers (with room for its name chip), keeping every layer where it is on the page. */
export function fitSection(tx: Transaction, sectionId: NodeId): boolean {
  const section = tx.get(sectionId);
  if (section?.type !== 'SECTION' || !section.children?.length) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of section.children) {
    const child = tx.get(id);
    if (!child?.visible) continue;
    // Children of a section are in its space; their turned boxes are approximated by their unturned ones.
    minX = Math.min(minX, child.x);
    minY = Math.min(minY, child.y);
    maxX = Math.max(maxX, child.x + child.width);
    maxY = Math.max(maxY, child.y + child.height);
  }
  if (minX === Infinity) return false;
  const dx = minX - SECTION_PADDING.left, dy = minY - SECTION_PADDING.top;
  tx.update(sectionId, {x: section.x + dx, y: section.y + dy, width: maxX - minX + SECTION_PADDING.left + SECTION_PADDING.right, height: maxY - minY + SECTION_PADDING.top + SECTION_PADDING.bottom});
  if (dx || dy) for (const id of section.children) {
    const child = tx.get(id);
    if (child) tx.update(id, {x: child.x - dx, y: child.y - dy});
  }
  return true;
}
