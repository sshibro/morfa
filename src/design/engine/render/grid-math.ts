import type {LayoutGrid} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';

// Layout grids ("Layout grid") as rectangles and lines in a frame's local space. Pure, tested in
// node (tests/design-render-export.test.ts covers it with the other export maths).

/** At most this many columns, rows or grid lines per frame: a grid finer than a pixel is noise. */
const MAX_SECTIONS = 2000;

/** COLUMNS and ROWS: the filled bands. STRETCH spreads `count` bands over the frame minus the offset
 *  on both sides; MIN/MAX/CENTER place bands of `sectionSize` from the start, the end or the centre.
 *  A count of 0 or Infinity ("Auto") fits as many as the frame holds. */
export function gridBands(grid: Extract<LayoutGrid, {pattern: 'COLUMNS' | 'ROWS'}>, width: number, height: number): Rect[] {
  const vertical = grid.pattern === 'COLUMNS';
  const length = vertical ? width : height, across = vertical ? height : width;
  const gutter = Math.max(0, grid.gutterSize || 0), offset = grid.offset || 0;
  let count = Number.isFinite(grid.count) && grid.count > 0 ? Math.floor(grid.count) : 0;
  let size = grid.sectionSize;
  if (grid.alignment === 'STRETCH') {
    if (!count) count = 1;
    size = (length - 2 * offset - gutter * (count - 1)) / count;
  } else if (!count) {
    count = size > 0 ? Math.floor((length - offset + gutter) / (size + gutter)) : 0;
  }
  count = Math.min(count, MAX_SECTIONS);
  if (!(size > 0) || count <= 0) return [];
  const total = count * size + (count - 1) * gutter;
  const start = grid.alignment === 'MAX' ? length - offset - total : grid.alignment === 'CENTER' ? (length - total) / 2 + offset : offset;
  const out: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const position = start + i * (size + gutter);
    out.push(vertical ? {x: position, y: 0, width: size, height: across} : {x: 0, y: position, width: across, height: size});
  }
  return out;
}

/** GRID: positions of the vertical and horizontal lines every `sectionSize` px, edges excluded. */
export function gridLines(sectionSize: number, width: number, height: number): {xs: number[]; ys: number[]} {
  if (!(sectionSize > 0)) return {xs: [], ys: []};
  const xs: number[] = [], ys: number[] = [];
  for (let x = sectionSize; x < width && xs.length < MAX_SECTIONS; x += sectionSize) xs.push(x);
  for (let y = sectionSize; y < height && ys.length < MAX_SECTIONS; y += sectionSize) ys.push(y);
  return {xs, ys};
}
