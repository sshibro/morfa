//! `src/design/engine/render/stroke-math.ts`: stroke strategies, arrowheads and per-side stroke bands.

use morfa_model::{CubicTo, IndividualStrokeWeights, PathCommand, StrokeAlign, StrokeMarker, Vec2};

use crate::js;
use crate::matrix::Rect;
use crate::paths::{end_point, v};

/// INSIDE clips to the shape, OUTSIDE clips the shape out; both stroke twice the weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrokeClip {
    Inside,
    Outside,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokePlan {
    pub clip: Option<StrokeClip>,
    pub line_width: f64,
}

pub fn stroke_plan(align: StrokeAlign, weight: f64, open: bool) -> StrokePlan {
    if open || align == StrokeAlign::Center {
        return StrokePlan {
            clip: None,
            line_width: weight,
        };
    }
    StrokePlan {
        clip: Some(if align == StrokeAlign::Inside {
            StrokeClip::Inside
        } else {
            StrokeClip::Outside
        }),
        line_width: weight * 2.0,
    }
}

/// A free end of a path: the point and the unit vector pointing out of the path there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathEnd {
    pub point: Vec2,
    pub direction: Vec2,
}

fn unit_of(a: Vec2) -> Option<Vec2> {
    let length = js::hypot(a.x, a.y);
    (length > 1e-9).then(|| v(a.x / length, a.y / length))
}

/// Points that leave or enter each segment's end, in order, for tangent estimates.
fn control_points(commands: &[PathCommand]) -> Vec<Vec2> {
    let mut points = Vec::new();
    for c in commands {
        match c {
            PathCommand::M(p) | PathCommand::L(p) => points.push(*p),
            PathCommand::C(k) => points.extend([v(k.x1, k.y1), v(k.x2, k.y2), v(k.x, k.y)]),
            PathCommand::Q(q) => points.extend([v(q.x1, q.y1), v(q.x, q.y)]),
            PathCommand::Z => {}
        }
    }
    points
}

/// The free ends of the first and last open subpaths, where start and end markers go.
pub fn path_ends(commands: &[PathCommand]) -> Option<(PathEnd, PathEnd)> {
    // subpaths(): runs from each M, closed when any Z follows within the run.
    let mut open: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    let mut closed = false;
    for (k, c) in commands.iter().enumerate() {
        match c {
            PathCommand::M(_) => {
                if let Some(s) = start {
                    if !closed && k - s > 1 {
                        open.push((s, k));
                    }
                }
                start = Some(k);
                closed = false;
            }
            PathCommand::Z if start.is_some() => closed = true,
            _ => {}
        }
    }
    if let Some(s) = start {
        if !closed && commands.len() - s > 1 {
            open.push((s, commands.len()));
        }
    }
    let (&(a0, a1), &(b0, b1)) = (open.first()?, open.last()?);
    let (first_path, last_path) = (&commands[a0..a1], &commands[b0..b1]);
    let first = control_points(first_path);
    let last = control_points(last_path);
    if first.len() < 2 || last.len() < 2 {
        return None;
    }
    let start_point = first[0];
    let end_point = last[last.len() - 1];
    let mut start_dir = None;
    let mut i = 1;
    while i < first.len() && start_dir.is_none() {
        start_dir = unit_of(v(start_point.x - first[i].x, start_point.y - first[i].y));
        i += 1;
    }
    let mut end_dir = None;
    let mut i = last.len() as i64 - 2;
    while i >= 0 && end_dir.is_none() {
        let q = last[i as usize];
        end_dir = unit_of(v(end_point.x - q.x, end_point.y - q.y));
        i -= 1;
    }
    Some((
        PathEnd {
            point: start_point,
            direction: start_dir.unwrap_or(v(-1.0, 0.0)),
        },
        PathEnd {
            point: end_point,
            direction: end_dir.unwrap_or(v(1.0, 0.0)),
        },
    ))
}

/// `markerSize` of shared/design/bounds.ts.
pub fn marker_size(stroke_weight: f64) -> f64 {
    3.0 * js::max(stroke_weight, 0.0) + 2.0
}

/// The shape drawn at one end of an open path, scaled by the stroke weight.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkerShape {
    pub fill: Option<Vec<PathCommand>>,
    pub stroke: Option<Vec<PathCommand>>,
    pub inset: f64,
}

fn at(end: &PathEnd, along: f64, across: f64) -> Vec2 {
    v(
        end.point.x + end.direction.x * along - end.direction.y * across,
        end.point.y + end.direction.y * along + end.direction.x * across,
    )
}

fn polygon(points: &[Vec2]) -> Vec<PathCommand> {
    let mut out: Vec<PathCommand> = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if i > 0 {
                PathCommand::L(*p)
            } else {
                PathCommand::M(*p)
            }
        })
        .collect();
    out.push(PathCommand::Z);
    out
}

const K: f64 = 0.5522847498307936;

#[inline]
fn c(x1: f64, y1: f64, x2: f64, y2: f64, x: f64, y: f64) -> PathCommand {
    PathCommand::C(CubicTo {
        x1,
        y1,
        x2,
        y2,
        x,
        y,
    })
}

fn circle(center: Vec2, r: f64) -> Vec<PathCommand> {
    let (cx, cy) = (center.x, center.y);
    vec![
        PathCommand::M(v(cx + r, cy)),
        c(cx + r, cy + r * K, cx + r * K, cy + r, cx, cy + r),
        c(cx - r * K, cy + r, cx - r, cy + r * K, cx - r, cy),
        c(cx - r, cy - r * K, cx - r * K, cy - r, cx, cy - r),
        c(cx + r * K, cy - r, cx + r, cy - r * K, cx + r, cy),
        PathCommand::Z,
    ]
}

pub fn marker_shape(marker: StrokeMarker, end: &PathEnd, weight: f64) -> Option<MarkerShape> {
    let size = marker_size(weight);
    let filled = |fill: Vec<PathCommand>, inset: f64| {
        Some(MarkerShape {
            fill: Some(fill),
            stroke: None,
            inset,
        })
    };
    match marker {
        StrokeMarker::TriangleArrow => {
            let half = size / 3.0f64.sqrt();
            filled(
                polygon(&[
                    at(end, 0.0, 0.0),
                    at(end, -size, half),
                    at(end, -size, -half),
                ]),
                js::min(size * 0.6, weight * 1.5),
            )
        }
        StrokeMarker::ReversedTriangle => {
            let half = size / 3.0f64.sqrt();
            filled(
                polygon(&[at(end, -size, 0.0), at(end, 0.0, half), at(end, 0.0, -half)]),
                0.0,
            )
        }
        StrokeMarker::LineArrow => {
            let arm = size * 0.75;
            let (a, b, cc) = (at(end, -arm, arm), at(end, 0.0, 0.0), at(end, -arm, -arm));
            Some(MarkerShape {
                fill: None,
                stroke: Some(vec![
                    PathCommand::M(a),
                    PathCommand::L(b),
                    PathCommand::L(cc),
                ]),
                inset: 0.0,
            })
        }
        StrokeMarker::Circle => filled(circle(end.point, size * 0.4), 0.0),
        StrokeMarker::Diamond => {
            let r = size * 0.55;
            filled(
                polygon(&[
                    at(end, r, 0.0),
                    at(end, 0.0, r),
                    at(end, -r, 0.0),
                    at(end, 0.0, -r),
                ]),
                0.0,
            )
        }
        StrokeMarker::Round => filled(circle(end.point, weight / 2.0), 0.0),
        StrokeMarker::Square => {
            let h = weight / 2.0;
            filled(
                polygon(&[
                    at(end, h, h),
                    at(end, h, -h),
                    at(end, -h, -h),
                    at(end, -h, h),
                ]),
                0.0,
            )
        }
        StrokeMarker::None => None,
    }
}

/// Moves the free ends of the first/last open subpaths inwards by `start_inset`/`end_inset`.
pub fn shorten_path(
    commands: &[PathCommand],
    start_inset: f64,
    end_inset: f64,
) -> Vec<PathCommand> {
    if !(start_inset > 0.0) && !(end_inset > 0.0) {
        return commands.to_vec();
    }
    let mut out = commands.to_vec();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut open: i64 = -1;
    for (i, command) in out.iter().enumerate() {
        match command {
            PathCommand::M(_) => {
                if open >= 0 {
                    ends.push(i - 1);
                }
                open = i as i64;
                starts.push(i);
            }
            PathCommand::Z => {
                starts.pop();
                open = -1;
            }
            _ => {}
        }
    }
    if open >= 0 {
        ends.push(out.len() - 1);
    } else if starts.len() > ends.len() {
        starts.pop();
    }
    if starts.is_empty() || ends.is_empty() {
        return out;
    }
    let mv = |out: &mut Vec<PathCommand>, index: usize, inset: f64, towards: usize| {
        let (Some(command), Some(next)) = (out.get(index).copied(), out.get(towards).copied())
        else {
            return;
        };
        if matches!(command, PathCommand::Z) || matches!(next, PathCommand::Z) || !(inset > 0.0) {
            return;
        }
        let (Some(point), Some(next_end)) = (end_point(&command), end_point(&next)) else {
            return;
        };
        let toward = match (next, command) {
            (PathCommand::C(n), _) if towards > index => v(n.x1, n.y1),
            (_, PathCommand::C(k)) if towards < index => v(k.x2, k.y2),
            _ => next_end,
        };
        let length = js::hypot(toward.x - point.x, toward.y - point.y);
        if length < 1e-9 {
            return;
        }
        let shift = js::min(inset, length * 0.9) / length;
        let dx = (toward.x - point.x) * shift;
        let dy = (toward.y - point.y) * shift;
        out[index] = match command {
            PathCommand::M(p) => PathCommand::M(v(p.x + dx, p.y + dy)),
            PathCommand::L(p) => PathCommand::L(v(p.x + dx, p.y + dy)),
            PathCommand::Q(q) => PathCommand::Q(morfa_model::QuadTo {
                x: q.x + dx,
                y: q.y + dy,
                ..q
            }),
            PathCommand::C(k) => {
                let mut k = CubicTo {
                    x: k.x + dx,
                    y: k.y + dy,
                    ..k
                };
                if towards < index {
                    k.x2 += dx;
                    k.y2 += dy;
                }
                PathCommand::C(k)
            }
            PathCommand::Z => PathCommand::Z,
        };
        if let PathCommand::C(mut n) = out[towards] {
            if towards > index {
                n.x1 += dx;
                n.y1 += dy;
                out[towards] = PathCommand::C(n);
            }
        }
    };
    mv(&mut out, starts[0], start_inset, starts[0] + 1);
    let last = ends[ends.len() - 1];
    if last >= 1 {
        mv(&mut out, last, end_inset, last - 1);
    }
    out
}

/// A rectangle with per-corner radii.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoundedRect {
    pub rect: Rect,
    pub radii: [f64; 4],
}

/// The stroke of a rectangle with different weights per side, as the region between two rounded rectangles.
pub fn individual_stroke_band(
    width: f64,
    height: f64,
    weights: &IndividualStrokeWeights,
    align: StrokeAlign,
    radii: &[f64; 4],
) -> (RoundedRect, Option<RoundedRect>) {
    let out = match align {
        StrokeAlign::Outside => 1.0,
        StrokeAlign::Center => 0.5,
        StrokeAlign::Inside => 0.0,
    };
    let inn = 1.0 - out;
    let (ol, ot, or, ob) = (
        weights.left * out,
        weights.top * out,
        weights.right * out,
        weights.bottom * out,
    );
    let (il, it, ir, ib) = (
        weights.left * inn,
        weights.top * inn,
        weights.right * inn,
        weights.bottom * inn,
    );
    let grow = [
        js::max(ot, ol),
        js::max(ot, or),
        js::max(ob, or),
        js::max(ob, ol),
    ];
    let shrink = [
        js::max(it, il),
        js::max(it, ir),
        js::max(ib, ir),
        js::max(ib, il),
    ];
    let outer = RoundedRect {
        rect: Rect::new(-ol, -ot, width + ol + or, height + ot + ob),
        radii: [0, 1, 2, 3].map(|k| {
            if radii[k] > 0.0 {
                radii[k] + grow[k]
            } else {
                0.0
            }
        }),
    };
    let inner_width = width - il - ir;
    let inner_height = height - it - ib;
    let inner = (inner_width > 0.0 && inner_height > 0.0).then(|| RoundedRect {
        rect: Rect::new(il, it, inner_width, inner_height),
        radii: [0, 1, 2, 3].map(|k| js::max(0.0, radii[k] - shrink[k])),
    });
    (outer, inner)
}

/// Rounded rectangle outline with per-corner radii, clamped so neighbouring corners never overlap.
pub fn rounded_rect_commands(rect: &Rect, radii: &[f64; 4]) -> Vec<PathCommand> {
    let (x, y, w, h) = (rect.x, rect.y, rect.width, rect.height);
    let mut scale = 1.0;
    for (p, q, side) in [(0, 1, w), (1, 2, h), (2, 3, w), (3, 0, h)] {
        let sum = radii[p] + radii[q];
        scale = js::min(
            scale,
            if sum > side && sum > 0.0 {
                side / sum
            } else {
                1.0
            },
        );
    }
    let [tl, tr, br, bl] = radii.map(|r| js::max(0.0, r * scale));
    let cc = |r: f64| r * (1.0 - K);
    let mut out = vec![
        PathCommand::M(v(x + tl, y)),
        PathCommand::L(v(x + w - tr, y)),
    ];
    if tr != 0.0 {
        out.push(c(x + w - cc(tr), y, x + w, y + cc(tr), x + w, y + tr));
    }
    out.push(PathCommand::L(v(x + w, y + h - br)));
    if br != 0.0 {
        out.push(c(
            x + w,
            y + h - cc(br),
            x + w - cc(br),
            y + h,
            x + w - br,
            y + h,
        ));
    }
    out.push(PathCommand::L(v(x + bl, y + h)));
    if bl != 0.0 {
        out.push(c(x + cc(bl), y + h, x, y + h - cc(bl), x, y + h - bl));
    }
    out.push(PathCommand::L(v(x, y + tl)));
    if tl != 0.0 {
        out.push(c(x, y + cc(tl), x + cc(tl), y, x + tl, y));
    }
    out.push(PathCommand::Z);
    out
}
