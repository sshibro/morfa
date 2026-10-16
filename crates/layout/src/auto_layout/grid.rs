//! Grid auto layout: the Rust half of `shared/design/layout-grid.ts` and of
//! `LayoutEngine.gridContainer` in `shared/design/layout.ts` — the same arithmetic in the same order, so the stage
//! oracle finds 0 diffs. Where the children of a GRID frame sit (`place_grid_children`), how the tracks of one axis are
//! sized (`size_grid_tracks`), and the container that measures and places (`LayoutEngine::grid_container`).

use morfa_model::store::draft::Working;
use morfa_model::store::{GridLayout, GridTrackSize, List, Node};
use morfa_model::types::{
    GridAutoTracks, GridChildAlign, GridItemsPositioning, GridTrackType, LayoutSizing,
};
use rustc_hash::FxHashSet;

use super::{
    Align, Axis, ContainerLayout, Item, LayoutEngine, Limits, Sides, Under, align_offset, boxes_of,
    clamp_to, footprint, sum,
};

/// A child's cells: the first row and column (0-based) and how many of each it spans.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridCell {
    pub row: usize,
    pub column: usize,
    pub row_span: usize,
    pub column_span: usize,
}

/// The derived grid: its track counts (rows may exceed `rowCount`); the cells come back in the children's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridPlacement {
    pub rows: usize,
    pub columns: usize,
}

/// A GRID frame without a `grid` object: one FLEX cell, no gaps, children flow (`DEFAULT_GRID`).
pub fn default_grid() -> GridLayout {
    GridLayout {
        row_count: 1.0,
        column_count: 1.0,
        row_gap: 0.0,
        column_gap: 0.0,
        row_sizes: List::new(),
        column_sizes: List::new(),
        auto_tracks: GridAutoTracks::None,
        items_positioning: GridItemsPositioning::RowAutoFlow,
    }
}

/// `wholeTracks`: the whole number of tracks a stored count or span names — floored, at least 1 (NaN reads as 1).
pub fn whole_tracks(value: Option<f64>, fallback: f64) -> usize {
    let whole = value.unwrap_or(fallback).floor();
    if whole >= 1.0 { whole as usize } else { 1 }
}

/// `placeGridChildren`: where the flow children of a GRID frame sit (`children` in layer order: the visible,
/// non-absolute ones). ROW_AUTO_FLOW: a cursor walks the cells row by row; each child takes the first cell at or after
/// the cursor where its spans fit with nothing under them, and the cursor stays on it. MANUAL: a child with both anchors
/// sits there when the cell is in range and free; any other child is placed like a flow child from the first cell,
/// after every anchored one. Rows grow as needed; nothing is written back.
pub fn place_grid_children(
    grid: &GridLayout,
    children: &[&Node],
    cells: &mut Vec<GridCell>,
) -> GridPlacement {
    let columns = whole_tracks(Some(grid.column_count), 1.0);
    let manual = grid.items_positioning == GridItemsPositioning::Manual;
    let mut taken: FxHashSet<usize> = FxHashSet::default();
    cells.clear();
    cells.resize(
        children.len(),
        GridCell {
            row: 0,
            column: 0,
            row_span: 1,
            column_span: 1,
        },
    );
    let free = |taken: &FxHashSet<usize>, row: usize, column: usize, rows: usize, cols: usize| {
        for r in row..row + rows {
            for c in column..column + cols {
                if taken.contains(&(r * columns + c)) {
                    return false;
                }
            }
        }
        true
    };
    let occupy = |taken: &mut FxHashSet<usize>,
                  cells: &mut Vec<GridCell>,
                  index: usize,
                  row: usize,
                  column: usize,
                  rows: usize,
                  cols: usize| {
        for r in row..row + rows {
            for c in column..column + cols {
                taken.insert(r * columns + c);
            }
        }
        cells[index] = GridCell {
            row,
            column,
            row_span: rows,
            column_span: cols,
        };
    };
    let mut deferred: Vec<usize> = Vec::new();
    if manual {
        for (index, child) in children.iter().enumerate() {
            let at = child.props.grid_child();
            let (Some(row), Some(column)) = (
                at.and_then(|at| at.row_anchor_index),
                at.and_then(|at| at.column_anchor_index),
            ) else {
                deferred.push(index);
                continue;
            };
            let (row, column) = (row.floor(), column.floor());
            if row.is_nan()
                || column.is_nan()
                || row < 0.0
                || column < 0.0
                || column >= columns as f64
            {
                deferred.push(index);
                continue;
            }
            let (row, column) = (row as usize, column as usize);
            let at = at.expect("both anchors came from it");
            let rows = whole_tracks(at.row_span, 1.0);
            let cols = whole_tracks(at.column_span, 1.0).min(columns - column);
            if !free(&taken, row, column, rows, cols) {
                deferred.push(index);
            } else {
                occupy(&mut taken, cells, index, row, column, rows, cols);
            }
        }
    }
    let flow: Vec<usize> = if manual {
        deferred
    } else {
        (0..children.len()).collect()
    };
    let (mut cursor_row, mut cursor_column) = (0usize, 0usize);
    for index in flow {
        let at = children[index].props.grid_child();
        let rows = whole_tracks(at.and_then(|at| at.row_span), 1.0);
        let cols = whole_tracks(at.and_then(|at| at.column_span), 1.0).min(columns);
        // Deferred manual children each search from the first cell; the flow's cursor only moves forward.
        let (mut row, mut column) = if manual {
            (0, 0)
        } else {
            (cursor_row, cursor_column)
        };
        loop {
            if column + cols > columns {
                column = 0;
                row += 1;
                continue;
            }
            if free(&taken, row, column, rows, cols) {
                break;
            }
            column += 1;
        }
        occupy(&mut taken, cells, index, row, column, rows, cols);
        if !manual {
            cursor_row = row;
            cursor_column = column;
        }
    }
    let mut needed = 0;
    for cell in cells.iter() {
        needed = needed.max(cell.row + cell.row_span);
    }
    let rows = if grid.auto_tracks == GridAutoTracks::Rows {
        needed.max(1)
    } else {
        whole_tracks(Some(grid.row_count), 1.0).max(needed)
    };
    GridPlacement { rows, columns }
}

/// `trackOf`: how a track is sized — FIXED at `value` px, FLEX by `value` weight (1 when absent), HUG by its content.
/// A missing entry reads as FLEX; negative values read as 0.
fn track_of(sizes: &[GridTrackSize], index: usize) -> (GridTrackType, f64) {
    let Some(track) = sizes.get(index) else {
        return (GridTrackType::Flex, 1.0);
    };
    if track.kind == GridTrackType::Hug {
        return (GridTrackType::Hug, 0.0);
    }
    let value = match track.kind {
        GridTrackType::Fixed => track.value.unwrap_or(0.0),
        _ => track.value.unwrap_or(1.0),
    };
    (track.kind, if value > 0.0 { value } else { 0.0 })
}

fn cell_on(cell: &GridCell, axis: Axis) -> (usize, usize) {
    if axis == 1 {
        (cell.row, cell.row_span)
    } else {
        (cell.column, cell.column_span)
    }
}

/// `sizeGridTracks`: the track sizes of one axis. `fixed_inner` is the frame's inner size when it does not hug the
/// axis (FLEX tracks share what the fixed and hug tracks and the gaps leave; on a hugged axis FLEX tracks size as HUG).
/// Hug tracks take the largest contribution of the items in them (a spanning item's footprint less the gaps and fixed
/// tracks it crosses, shared equally by the hug tracks it crosses).
pub(super) fn size_grid_tracks(
    spec: &[GridTrackSize],
    count: usize,
    gap: f64,
    fixed_inner: Option<f64>,
    items: &[Item],
    cells: &[GridCell],
    axis: Axis,
) -> Vec<f64> {
    let mut kinds = Vec::with_capacity(count);
    let mut weights = Vec::with_capacity(count);
    let mut sizes = Vec::with_capacity(count);
    for i in 0..count {
        let (kind, value) = track_of(spec, i);
        let kind = if kind == GridTrackType::Flex && fixed_inner.is_none() {
            GridTrackType::Hug
        } else {
            kind
        };
        kinds.push(kind);
        weights.push(value);
        sizes.push(if kind == GridTrackType::Fixed {
            value
        } else {
            0.0
        });
    }
    for (item, cell) in items.iter().zip(cells) {
        let (start, span) = cell_on(cell, axis);
        let mut hugs = 0usize;
        let mut fixed_sum = 0.0;
        for i in start..start + span {
            if kinds[i] == GridTrackType::Hug {
                hugs += 1;
            } else if kinds[i] == GridTrackType::Fixed {
                fixed_sum += sizes[i];
            }
        }
        if hugs == 0 {
            continue;
        }
        let need = (footprint(item, axis) - gap * (span - 1) as f64 - fixed_sum) / hugs as f64;
        for i in start..start + span {
            if kinds[i] == GridTrackType::Hug && need > sizes[i] {
                sizes[i] = need;
            }
        }
    }
    if let Some(inner) = fixed_inner {
        let mut used = gap * (count - 1) as f64;
        let mut weight = 0.0;
        for i in 0..count {
            if kinds[i] == GridTrackType::Flex {
                weight += weights[i];
            } else {
                used += sizes[i];
            }
        }
        let free = crate::math::max(0.0, inner - used);
        if weight > 0.0 {
            for i in 0..count {
                if kinds[i] == GridTrackType::Flex {
                    sizes[i] = free * weights[i] / weight;
                }
            }
        }
    }
    sizes
}

/// `trackOffsets`: the start of each track from `origin`, with `gap` between tracks; `offsets[count]` is one gap past
/// the last track's end.
pub(super) fn track_offsets(sizes: &[f64], gap: f64, origin: f64) -> Vec<f64> {
    let mut offsets = Vec::with_capacity(sizes.len() + 1);
    offsets.push(origin);
    for (i, size) in sizes.iter().enumerate() {
        offsets.push(offsets[i] + size + gap);
    }
    offsets
}

/// `spanExtent`: the extent of `span` tracks from `start` — the tracks and the gaps between them.
pub(super) fn span_extent(offsets: &[f64], sizes: &[f64], start: usize, span: usize) -> f64 {
    offsets[start + span - 1] + sizes[start + span - 1] - offsets[start]
}

/// A child's alignment in its cells on `axis` (`gridChild.horizontalAlign` / `verticalAlign`; AUTO and absent = MIN).
fn child_align(node: &Node, axis: Axis) -> Align {
    let align = node.props.grid_child().and_then(|child| {
        if axis == 1 {
            child.vertical_align
        } else {
            child.horizontal_align
        }
    });
    match align {
        Some(GridChildAlign::Center) => Align::Center,
        Some(GridChildAlign::Max) => Align::End,
        _ => Align::Start,
    }
}

impl LayoutEngine<'_> {
    /// `LayoutEngine.gridContainer`: the children's cells, then per axis — widths before heights — each child's own
    /// size, the track sizes, the frame's size on a hugged axis, and the FILL children's sizes from their cells; then
    /// positions in the cells.
    // Index loops mirror the TypeScript's loops over the items they index and write; the arguments are the container's
    // common setup, handed over as `container` computed them.
    #[allow(clippy::needless_range_loop, clippy::too_many_arguments)]
    pub(super) fn grid_container(
        &mut self,
        draft: &Working,
        node: &Node,
        fixed: &[Option<f64>; 2],
        hugs: &[bool; 2],
        limits: &Limits,
        pad: &Sides,
        items: &mut [Item],
    ) -> ContainerLayout {
        let default = default_grid();
        let grid: &GridLayout = node.props.grid().map(|grid| &**grid).unwrap_or(&default);
        let children: Vec<&Node> = items.iter().map(|item| item.node).collect();
        let mut cells = Vec::new();
        let placement = place_grid_children(grid, &children, &mut cells);
        let counts = [placement.columns, placement.rows];
        let gaps = [grid.column_gap, grid.row_gap];
        let mut size = [0.0; 2];
        for axis in 0..2 {
            let pad_sum = pad[axis][0] + pad[axis][1];
            for i in 0..items.len() {
                if items[i].turned {
                    continue;
                }
                let own = if items[i].sizing[axis] == LayoutSizing::Fill {
                    self.fill_basis(draft, Under::of(node), &items[i], axis)
                } else {
                    self.item_size(draft, Under::of(node), &items[i], axis)
                };
                items[i].size[axis] = own;
            }
            let inner = if hugs[axis] {
                None
            } else {
                fixed[axis].map(|fixed| fixed - pad_sum)
            };
            let spec = if axis == 0 {
                grid.column_sizes.as_slice()
            } else {
                grid.row_sizes.as_slice()
            };
            let sizes =
                size_grid_tracks(spec, counts[axis], gaps[axis], inner, items, &cells, axis);
            size[axis] = match fixed[axis] {
                Some(fixed) => fixed,
                None => clamp_to(
                    pad_sum + sum(sizes.iter().copied()) + gaps[axis] * (counts[axis] - 1) as f64,
                    limits,
                    axis,
                ),
            };
            let offsets = track_offsets(&sizes, gaps[axis], pad[axis][0]);
            for i in 0..items.len() {
                let (start, span) = cell_on(&cells[i], axis);
                let extent = span_extent(&offsets, &sizes, start, span);
                let filling = !items[i].turned && items[i].sizing[axis] == LayoutSizing::Fill;
                if filling {
                    let item = &items[i];
                    let fill = clamp_to(
                        extent - item.out[axis][0] - item.out[axis][1],
                        &item.limits,
                        axis,
                    );
                    items[i].size[axis] = fill;
                }
                let align = if filling {
                    Align::Start
                } else {
                    child_align(items[i].node, axis)
                };
                let foot = footprint(&items[i], axis);
                items[i].pos[axis] = offsets[start] + align_offset(align, extent - foot);
            }
        }
        ContainerLayout {
            width: size[0],
            height: size[1],
            boxes: boxes_of(items, node.children().len()),
        }
    }
}
