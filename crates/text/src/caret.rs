//! Caret and selection geometry over a `TextLayout`: the Rust twin of `lineIndexAt`, `caretAt`, `offsetAt`,
//! `selectionRects`, `lineRange` and `moveCaret` in `shared/design/text-layout.ts`. Offsets arrive as
//! JavaScript numbers (f64) and are clamped as the oracle clamps them.

use serde::{Deserialize, Serialize};

use crate::segment::{
    next_grapheme_boundary, prev_grapheme_boundary, word_end_after, word_start_before,
};
use crate::types::{GlyphRun, TextLayout, TextLine};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Affinity {
    Upstream,
    #[default]
    Downstream,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caret {
    pub x: f64,
    pub top: f64,
    pub height: f64,
    pub baseline: f64,
    pub line_index: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub offset: usize,
    pub affinity: Affinity,
    pub line_index: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub line_index: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
    pub line_index: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaretMove {
    pub offset: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_x: Option<f64>,
    pub affinity: Affinity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaretDirection {
    Left,
    Right,
    Up,
    Down,
    LineStart,
    LineEnd,
    WordLeft,
    WordRight,
    DocStart,
    DocEnd,
}

fn clamp_offset(layout: &TextLayout, offset: f64) -> f64 {
    let o = if offset.is_finite() { offset } else { 0.0 };
    o.clamp(0.0, layout.length as f64)
}

/// Index of the line holding `offset` (offsets hidden by truncation belong to the last line).
pub fn line_index_at(layout: &TextLayout, offset: f64, affinity: Affinity) -> i64 {
    let lines = &layout.lines;
    if lines.is_empty() {
        return -1;
    }
    let (mut lo, mut hi) = (0usize, lines.len() - 1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if lines[mid].start as f64 <= offset {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    if affinity == Affinity::Upstream
        && lo > 0
        && lines[lo].start as f64 == offset
        && lines[lo - 1].wrapped
        && lines[lo - 1].end as f64 == offset
    {
        return lo as i64 - 1;
    }
    lo as i64
}

/// x of a caret at `offset` on `line`; offsets past the visible end stick to it.
fn x_on_line(line: &TextLine, offset: f64) -> f64 {
    let mut last: Option<&GlyphRun> = None;
    for run in &line.runs {
        if run.ellipsis {
            continue;
        }
        if offset <= run.end as f64 {
            let (mut lo, mut hi) = (0usize, run.offsets.len() - 1);
            while lo < hi {
                let mid = (lo + hi + 1) >> 1;
                if run.offsets[mid] as f64 <= offset {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            return run.xs[lo];
        }
        last = Some(run);
    }
    last.map_or(line.x, |run| run.xs[run.xs.len() - 1])
}

/// The caret box at `offset`: the full height of its line box.
pub fn caret_at(layout: &TextLayout, offset: f64, affinity: Affinity) -> Caret {
    let o = clamp_offset(layout, offset);
    let index = line_index_at(layout, o, affinity);
    if index < 0 {
        return Caret {
            x: 0.0,
            top: 0.0,
            height: 0.0,
            baseline: 0.0,
            line_index: -1,
        };
    }
    let line = &layout.lines[index as usize];
    Caret {
        x: x_on_line(line, o),
        top: line.top,
        height: line.height,
        baseline: line.baseline,
        line_index: index,
    }
}

/// The offset nearest to `x` on one line.
fn offset_on_line(line: &TextLine, x: f64) -> usize {
    let mut best = line.start;
    let mut best_distance = f64::INFINITY;
    for run in &line.runs {
        if run.ellipsis {
            continue;
        }
        for (k, &offset) in run.offsets.iter().enumerate() {
            let distance = (run.xs[k] - x).abs();
            if distance < best_distance {
                best_distance = distance;
                best = offset;
            }
        }
    }
    best
}

/// The caret position a click at (`x`, `y`) in node-local px lands on.
pub fn offset_at(layout: &TextLayout, x: f64, y: f64) -> Hit {
    let lines = &layout.lines;
    if lines.is_empty() {
        return Hit {
            offset: 0,
            affinity: Affinity::Downstream,
            line_index: -1,
        };
    }
    let (mut lo, mut hi) = (0usize, lines.len() - 1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if lines[mid].top <= y {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let mut index = lo;
    let line = &lines[index];
    if y > line.top + line.height
        && index + 1 < lines.len()
        && lines[index + 1].top - y < y - (line.top + line.height)
    {
        index += 1;
    }
    let target = &lines[index];
    let offset = offset_on_line(target, x);
    Hit {
        offset,
        affinity: if target.wrapped && offset == target.end {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        },
        line_index: index as i64,
    }
}

/// Highlight rectangles of the selection [start, end), one per line it touches.
pub fn selection_rects(layout: &TextLayout, start: f64, end: f64) -> Vec<SelectionRect> {
    let from = clamp_offset(layout, start.min(end));
    let to = clamp_offset(layout, start.max(end));
    let mut rects = Vec::new();
    if from == to {
        return rects;
    }
    let count = layout.lines.len();
    for (line_index, line) in layout.lines.iter().enumerate() {
        let (ls, le) = (line.start as f64, line.end as f64);
        if ls > to || (ls == to && to > from) {
            continue;
        }
        let break_selected = !line.wrapped && line_index < count - 1 && from <= le && to > le;
        let a = from.max(ls);
        let b = to.min(le);
        if crate::layout::not_greater(b, a) && !break_selected {
            continue;
        }
        let x1 = x_on_line(line, a);
        let mut x2 = if b > a { x_on_line(line, b) } else { x1 };
        if break_selected {
            x2 += (line.height * 0.25).max(1.0);
        }
        rects.push(SelectionRect {
            x: x1,
            y: line.top,
            width: (x2 - x1).max(0.0),
            height: line.height,
            line_index,
        });
    }
    rects
}

/// The visual line holding `offset`.
pub fn line_range(layout: &TextLayout, offset: f64, affinity: Affinity) -> LineRange {
    let index = line_index_at(layout, clamp_offset(layout, offset), affinity);
    if index < 0 {
        return LineRange {
            start: 0,
            end: 0,
            line_index: -1,
        };
    }
    let line = &layout.lines[index as usize];
    LineRange {
        start: line.start,
        end: line.end,
        line_index: index,
    }
}

/// Where a caret key moves the caret.
pub fn move_caret(
    layout: &TextLayout,
    text: &[u16],
    offset: f64,
    direction: CaretDirection,
    goal_x: Option<f64>,
    affinity: Affinity,
) -> CaretMove {
    let o = offset.clamp(0.0, text.len() as f64);
    let plain = |to: usize| CaretMove {
        offset: to,
        goal_x: None,
        affinity: Affinity::Downstream,
    };
    let ou = o as usize;
    match direction {
        CaretDirection::Left => plain(prev_grapheme_boundary(text, ou)),
        CaretDirection::Right => plain(next_grapheme_boundary(text, ou)),
        CaretDirection::WordLeft => plain(word_start_before(text, ou)),
        CaretDirection::WordRight => plain(word_end_after(text, ou)),
        CaretDirection::DocStart => plain(0),
        CaretDirection::DocEnd => plain(text.len()),
        CaretDirection::LineStart => {
            let index = line_index_at(layout, o, affinity);
            plain(if index < 0 {
                0
            } else {
                layout.lines[index as usize].start
            })
        }
        CaretDirection::LineEnd => {
            let index = line_index_at(layout, o, affinity);
            if index < 0 {
                return plain(text.len());
            }
            let line = &layout.lines[index as usize];
            CaretMove {
                offset: line.end,
                goal_x: None,
                affinity: if line.wrapped {
                    Affinity::Upstream
                } else {
                    Affinity::Downstream
                },
            }
        }
        CaretDirection::Up | CaretDirection::Down => {
            let index = line_index_at(layout, o, affinity);
            if index < 0 {
                return plain(ou);
            }
            let x = goal_x.unwrap_or_else(|| x_on_line(&layout.lines[index as usize], o));
            let target = index
                + if direction == CaretDirection::Up {
                    -1
                } else {
                    1
                };
            if target < 0 {
                return CaretMove {
                    offset: 0,
                    goal_x: Some(x),
                    affinity: Affinity::Downstream,
                };
            }
            if target as usize >= layout.lines.len() {
                return CaretMove {
                    offset: text.len(),
                    goal_x: Some(x),
                    affinity: Affinity::Downstream,
                };
            }
            let line = &layout.lines[target as usize];
            let to = offset_on_line(line, x);
            CaretMove {
                offset: to,
                goal_x: Some(x),
                affinity: if line.wrapped && to == line.end {
                    Affinity::Upstream
                } else {
                    Affinity::Downstream
                },
            }
        }
    }
}
