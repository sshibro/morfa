import type {GridChild, GridLayout, GridTrackSize, NodeId} from './types';

// Grid auto layout's pure half where the children of a GRID frame sit
// and how a track's size is read. The engine (layout.ts `LayoutEngine.gridContainer`) measures and places; codegen and
// the panel call `placeGridChildren` to learn the cells the layout derived. crates/layout/src/auto_layout/grid.rs is
// the same arithmetic in Rust, kept at 0 diffs by the stage oracle.

/** A GRID frame without a `grid` object: one FLEX cell, no gaps, children flow. */
export const DEFAULT_GRID: GridLayout = {rowCount: 1, columnCount: 1, rowGap: 0, columnGap: 0, rowSizes: [], columnSizes: [], autoTracks: 'NONE', itemsPositioning: 'ROW_AUTO_FLOW'};

/** A child's cells: the first row and column (0-based) and how many of each it spans. */
export type GridCell = {row: number; column: number; rowSpan: number; columnSpan: number};
/** The derived grid: its track counts (rows may exceed `rowCount`) and every flow child's cell. */
export type GridPlacement = {rows: number; columns: number; cells: Map<NodeId, GridCell>};

/** The whole number of tracks a stored count or span names: floored, at least 1. */
export const wholeTracks = (value: number | undefined, fallback = 1): number => {
  const whole = Math.floor(value ?? fallback);
  return whole >= 1 ? whole : 1;
};

/** Where the flow children of a GRID frame sit (`children` in layer order: the visible, non-absolute ones).
 *
 *  ROW_AUTO_FLOW: a cursor walks the cells row by row; each child takes the first cell at or after the cursor where its
 *  spans fit with nothing under them (CSS's sparse packing), and the cursor stays on it. MANUAL: a child with both
 *  anchors sits there when the cell is in range and free; any other child (no anchors, out of range, taken) is placed like
 *  a flow child from the first cell, after every anchored one. A column span wider than the grid is clipped; rows grow as
 *  needed: under `autoTracks: 'ROWS'` the row count is what the children need (at least 1), otherwise at least
 *  `rowCount`. Nothing is written back; both engines derive the same cells from the same document. */
export function placeGridChildren(grid: GridLayout, children: readonly {id: NodeId; gridChild?: GridChild}[]): GridPlacement {
  const columns = wholeTracks(grid.columnCount);
  const taken = new Set<number>();
  const cells = new Map<NodeId, GridCell>();
  const free = (row: number, column: number, rowSpan: number, columnSpan: number): boolean => {
    for (let r = row; r < row + rowSpan; r++) for (let c = column; c < column + columnSpan; c++) if (taken.has(r * columns + c)) return false;
    return true;
  };
  const occupy = (id: NodeId, row: number, column: number, rowSpan: number, columnSpan: number): void => {
    for (let r = row; r < row + rowSpan; r++) for (let c = column; c < column + columnSpan; c++) taken.add(r * columns + c);
    cells.set(id, {row, column, rowSpan, columnSpan});
  };
  const deferred: {id: NodeId; gridChild?: GridChild}[] = [];
  if (grid.itemsPositioning === 'MANUAL') {
    for (const child of children) {
      const at = child.gridChild;
      if (at?.rowAnchorIndex === undefined || at.columnAnchorIndex === undefined) {
        deferred.push(child);
        continue;
      }
      const row = Math.floor(at.rowAnchorIndex), column = Math.floor(at.columnAnchorIndex);
      const rowSpan = wholeTracks(at.rowSpan), columnSpan = Math.min(wholeTracks(at.columnSpan), columns - column);
      if (row < 0 || column < 0 || column >= columns || !free(row, column, rowSpan, columnSpan)) deferred.push(child);
      else occupy(child.id, row, column, rowSpan, columnSpan);
    }
  }
  const flow = grid.itemsPositioning === 'MANUAL' ? deferred : children;
  let cursorRow = 0, cursorColumn = 0;
  for (const child of flow) {
    const rowSpan = wholeTracks(child.gridChild?.rowSpan), columnSpan = Math.min(wholeTracks(child.gridChild?.columnSpan), columns);
    // Deferred manual children each search from the first cell; the flow's cursor only moves forward.
    let row = grid.itemsPositioning === 'MANUAL' ? 0 : cursorRow, column = grid.itemsPositioning === 'MANUAL' ? 0 : cursorColumn;
    for (;;) {
      if (column + columnSpan > columns) {
        column = 0;
        row++;
        continue;
      }
      if (free(row, column, rowSpan, columnSpan)) break;
      column++;
    }
    occupy(child.id, row, column, rowSpan, columnSpan);
    if (grid.itemsPositioning !== 'MANUAL') {
      cursorRow = row;
      cursorColumn = column;
    }
  }
  let needed = 0;
  for (const cell of cells.values()) needed = Math.max(needed, cell.row + cell.rowSpan);
  const rows = grid.autoTracks === 'ROWS' ? Math.max(1, needed) : Math.max(wholeTracks(grid.rowCount), needed);
  return {rows, columns, cells};
}

/** How a track is sized: FIXED at `value` px, FLEX by `value` weight (1 when absent), HUG by its content. A missing
 *  entry reads as FLEX; negative values read as 0. */
export function trackOf(sizes: readonly GridTrackSize[], index: number): {kind: GridTrackSize['type']; value: number} {
  const track = sizes[index];
  if (!track) return {kind: 'FLEX', value: 1};
  if (track.type === 'HUG') return {kind: 'HUG', value: 0};
  const value = track.type === 'FIXED' ? (track.value ?? 0) : (track.value ?? 1);
  return {kind: track.type, value: value > 0 ? value : 0};
}

/** The track sizes of one axis, from what the engine measured. `fixedInner`: the frame's inner size on this axis when it
 *  does not hug it (FLEX tracks share what the fixed and hug tracks and the gaps leave; on a hugged axis FLEX tracks size
 *  as HUG tracks, as CSS `fr` does in an auto-sized container). `contentOf(item, start, count)` is the item's footprint on
 *  this axis; `cellsOf(item)` its first track and span. Hug tracks take the largest contribution of the items in them
 *  (a spanning item's footprint less the gaps and fixed tracks it crosses, shared equally by the hug tracks it crosses). */
export function sizeGridTracks<T>(
  spec: readonly GridTrackSize[], count: number, gap: number, fixedInner: number | undefined,
  items: readonly T[], cellsOf: (item: T) => [start: number, span: number], contentOf: (item: T) => number,
): number[] {
  const kinds: GridTrackSize['type'][] = [], weights: number[] = [], sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const track = trackOf(spec, i);
    const kind = track.kind === 'FLEX' && fixedInner === undefined ? 'HUG' : track.kind;
    kinds.push(kind);
    weights.push(track.value);
    sizes.push(kind === 'FIXED' ? track.value : 0);
  }
  for (const item of items) {
    const [start, span] = cellsOf(item);
    let hugs = 0, fixedSum = 0;
    for (let i = start; i < start + span; i++) {
      if (kinds[i] === 'HUG') hugs++;
      else if (kinds[i] === 'FIXED') fixedSum += sizes[i];
    }
    if (!hugs) continue;
    const need = (contentOf(item) - gap * (span - 1) - fixedSum) / hugs;
    for (let i = start; i < start + span; i++) if (kinds[i] === 'HUG' && need > sizes[i]) sizes[i] = need;
  }
  if (fixedInner !== undefined) {
    let used = gap * (count - 1), weight = 0;
    for (let i = 0; i < count; i++) {
      if (kinds[i] === 'FLEX') weight += weights[i];
      else used += sizes[i];
    }
    const free = Math.max(0, fixedInner - used);
    if (weight > 0) for (let i = 0; i < count; i++) if (kinds[i] === 'FLEX') sizes[i] = free * weights[i] / weight;
  }
  return sizes;
}

/** The start offsets of the tracks (`offsets[i]`), from `origin`, with `gap` between tracks; `offsets[count]` is one gap
 *  past the last track's end. */
export function trackOffsets(sizes: readonly number[], gap: number, origin: number): number[] {
  const offsets = [origin];
  for (let i = 0; i < sizes.length; i++) offsets.push(offsets[i] + sizes[i] + gap);
  return offsets;
}

/** The extent of `span` tracks from `start`: the tracks and the gaps between them. */
export function spanExtent(offsets: readonly number[], sizes: readonly number[], start: number, span: number): number {
  return offsets[start + span - 1] + sizes[start + span - 1] - offsets[start];
}
