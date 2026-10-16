//! `shared/design/outline-stroke.ts`: the area a stroke paints, as polygons (`strokeArea`), dashes
//! (`dashPolylines`), and the polygons fitted back to editable paths (`polygonsToSmoothPaths`).
//! Variable-width strokes ("Width profile", stroke-profile.ts) stay in TypeScript: callers route a node
//! with a width profile there before reaching [`outline_stroke`].

use std::f64::consts::PI;

use morfa_model::{
    BooleanOperation, CubicTo, NodeType, PathCommand, SceneNode, StrokeAlign, StrokeCap,
    StrokeJoin, StrokeMarker, Vec2, VectorPath, WindingRule,
};

use crate::boolean::{combine_areas, fill_area};
use crate::clip::{MultiPolygon, Pair, Ring};
use crate::js;
use crate::paths::{Polyline, append_line, fit_cubics, flatten_path, subpaths, v};
use crate::shapes::{
    CornerRadii, EndPosition, marker_geometry, node_corner_radii, node_geometry, path_ends,
    rectangle_path,
};

/// `StrokeStyle`.
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeStyle {
    pub weight: f64,
    pub align: StrokeAlign,
    pub cap: StrokeCap,
    pub join: StrokeJoin,
    pub miter_limit: f64,
    pub dash_pattern: Vec<f64>,
}

pub fn stroke_style_of(node: &SceneNode) -> StrokeStyle {
    StrokeStyle {
        weight: node.stroke_weight,
        align: node.stroke_align,
        cap: node.stroke_cap,
        join: node.stroke_join,
        miter_limit: node.stroke_miter_limit,
        dash_pattern: node.dash_pattern.clone(),
    }
}

const MAX_DASHES: f64 = 50_000.0;

#[inline]
fn sub(a: Vec2, b: Vec2) -> Vec2 {
    v(a.x - b.x, a.y - b.y)
}
#[inline]
fn add_scaled(a: Vec2, b: Vec2, s: f64) -> Vec2 {
    v(a.x + b.x * s, a.y + b.y * s)
}
#[inline]
fn len(a: Vec2) -> f64 {
    js::hypot(a.x, a.y)
}
#[inline]
fn unit(a: Vec2) -> Vec2 {
    let l = len(a);
    if l != 0.0 && !l.is_nan() {
        v(a.x / l, a.y / l)
    } else {
        v(1.0, 0.0)
    }
}
/// Left of the travel direction on screen (y down).
#[inline]
fn left_normal(d: Vec2) -> Vec2 {
    v(d.y, -d.x)
}
#[inline]
fn pair(p: Vec2) -> Pair {
    [p.x, p.y]
}
#[inline]
fn clamp_unit(x: f64) -> f64 {
    js::max(-1.0, js::min(1.0, x))
}

/// Polygon of a circle around `c`, steps no coarser than `max_angle`.
fn disc(c: Vec2, r: f64, max_angle: f64) -> Ring {
    let steps = js::max(8.0, ((2.0 * PI) / max_angle).ceil());
    let mut ring = Vec::new();
    let mut k = 0.0;
    while k < steps {
        let a = (k / steps) * 2.0 * PI;
        ring.push([c.x + js::cos(a) * r, c.y + js::sin(a) * r]);
        k += 1.0;
    }
    ring
}

/// Splits polylines into dashes (SVG semantics: an odd pattern repeats twice, each subpath starts the
/// pattern afresh). Returns the input when the pattern draws everything or would make too many dashes.
pub fn dash_polylines(lines: &[Polyline], pattern: &[f64]) -> Vec<Polyline> {
    let clean: Vec<f64> = pattern
        .iter()
        .copied()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .collect();
    let dashes: Vec<f64> = if clean.len() % 2 == 1 {
        clean.iter().chain(clean.iter()).copied().collect()
    } else {
        clean
    };
    let period = dashes.iter().fold(0.0, |a, b| a + b);
    // No pattern, or no gaps: the stroke is solid.
    if dashes.is_empty()
        || period <= 0.0
        || dashes
            .iter()
            .enumerate()
            .all(|(k, &v)| k % 2 == 0 || v == 0.0)
    {
        return lines.to_vec();
    }
    let closed_points = |line: &Polyline| -> Vec<Vec2> {
        let mut pts = line.points.clone();
        if line.closed {
            if let Some(&first) = line.points.first() {
                pts.push(first);
            }
        }
        pts
    };
    let mut total = 0.0;
    for line in lines {
        let pts = closed_points(line);
        for k in 1..pts.len() {
            total += len(sub(pts[k], pts[k - 1]));
        }
    }
    if total / period * (dashes.len() as f64 / 2.0) > MAX_DASHES {
        return lines.to_vec();
    }
    let mut out = Vec::new();
    for line in lines {
        let pts = closed_points(line);
        let Some(&first) = pts.first() else { continue };
        let mut index = 0;
        let mut remaining = dashes[0];
        let mut on = true;
        let mut current: Option<Vec<Vec2>> = Some(vec![first]);
        let flush = |current: &mut Option<Vec<Vec2>>, out: &mut Vec<Polyline>| {
            if let Some(points) = current.take() {
                if !points.is_empty() {
                    out.push(Polyline {
                        points,
                        closed: false,
                    });
                }
            }
        };
        for k in 1..pts.len() {
            let mut a = pts[k - 1];
            let b = pts[k];
            let mut segment = len(sub(b, a));
            // ≥: a dash due exactly at a point (the path's end included) is still drawn, as in SVG.
            while segment >= remaining {
                let p = add_scaled(a, unit(sub(b, a)), remaining);
                segment -= remaining;
                a = p;
                if on {
                    if let Some(c) = current.as_mut() {
                        c.push(p);
                    }
                    flush(&mut current, &mut out);
                } else {
                    current = Some(vec![p]);
                }
                on = !on;
                index = (index + 1) % dashes.len();
                remaining = dashes[index];
            }
            remaining -= segment;
            if on {
                if let Some(c) = current.as_mut() {
                    c.push(b);
                }
            }
        }
        // A dash the path's end cut down to nothing is not drawn.
        if on {
            if let Some(rest) = current.as_ref() {
                if rest.iter().any(|p| p.x != rest[0].x || p.y != rest[0].y) {
                    flush(&mut current, &mut out);
                }
            }
        }
    }
    out
}

/// Shortens an open polyline by `start` and `end` along its length (for markers).
fn trim_polyline(points: &[Vec2], start: f64, end: f64) -> Vec<Vec2> {
    fn cut(pts: Vec<Vec2>, amount: f64) -> Vec<Vec2> {
        if amount <= 0.0 || amount.is_nan() {
            return pts;
        }
        let mut amount = amount;
        for k in 1..pts.len() {
            let l = len(sub(pts[k], pts[k - 1]));
            if amount < l {
                let mut out = vec![add_scaled(
                    pts[k - 1],
                    unit(sub(pts[k], pts[k - 1])),
                    amount,
                )];
                out.extend_from_slice(&pts[k..]);
                return out;
            }
            amount -= l;
        }
        pts.last().map(|&p| vec![p]).unwrap_or_default()
    }
    let mut once = cut(points.to_vec(), start);
    once.reverse();
    let mut twice = cut(once, end);
    twice.reverse();
    twice
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Caps {
    start: StrokeCap,
    end: StrokeCap,
}

/// The pieces sweeping one polyline with a pen `weight` wide.
fn stroke_pieces(
    line: &Polyline,
    style: &StrokeStyle,
    weight: f64,
    caps: Caps,
    max_angle: f64,
    out: &mut Vec<Ring>,
) {
    let hw = weight / 2.0;
    if !(hw > 0.0) {
        return;
    }
    let mut pts: Vec<Vec2> = Vec::with_capacity(line.points.len());
    for &p in &line.points {
        if pts.last().is_none_or(|&q| len(sub(p, q)) > 1e-9) {
            pts.push(p);
        }
    }
    if line.closed && pts.len() > 1 && len(sub(pts[0], pts[pts.len() - 1])) <= 1e-9 {
        pts.pop();
    }
    if pts.len() == 1 {
        // A zero-length subpath: round and square caps still paint a dot, as in SVG.
        let p = pts[0];
        let cap = if caps.start == StrokeCap::None {
            caps.end
        } else {
            caps.start
        };
        if cap == StrokeCap::Round {
            out.push(disc(p, hw, max_angle));
        } else if cap == StrokeCap::Square {
            out.push(vec![
                [p.x - hw, p.y - hw],
                [p.x + hw, p.y - hw],
                [p.x + hw, p.y + hw],
                [p.x - hw, p.y + hw],
            ]);
        }
        return;
    }
    if pts.is_empty() {
        return;
    }
    let closed = line.closed && pts.len() > 2;
    // Unroll a closed loop so it starts and ends at its sharpest vertex, which then gets a join.
    let chain: Vec<Vec2> = if closed {
        let m = pts.len();
        let mut sharpest = 0;
        let mut sharpest_turn = -1.0;
        for k in 0..m {
            let turn = turn_at(pts[(k + m - 1) % m], pts[k], pts[(k + 1) % m]);
            if turn > sharpest_turn {
                sharpest_turn = turn;
                sharpest = k;
            }
        }
        let mut chain = Vec::with_capacity(m + 1);
        chain.extend_from_slice(&pts[sharpest..]);
        chain.extend_from_slice(&pts[..sharpest]);
        chain.push(pts[sharpest]);
        chain
    } else {
        pts
    };
    let n = chain.len();
    let dirs: Vec<Vec2> = (1..n).map(|k| unit(sub(chain[k], chain[k - 1]))).collect();
    let lengths: Vec<f64> = (1..n).map(|k| len(sub(chain[k], chain[k - 1]))).collect();
    let smooth_limit = js::max(max_angle * 1.5, 0.05);
    // Interior vertex k continues a ribbon when it turns gently and the inner offset does not fold back.
    let smooth = |k: usize| {
        let (din, dout) = (dirs[k - 1], dirs[k]);
        let turn = js::acos(clamp_unit(din.x * dout.x + din.y * dout.y));
        if turn > smooth_limit {
            return false;
        }
        hw * js::tan(turn / 2.0) <= js::min(lengths[k - 1], lengths[k]) * 0.5
    };
    let gentle = |k: usize| {
        let (din, dout) = (dirs[k - 1], dirs[k]);
        js::acos(clamp_unit(din.x * dout.x + din.y * dout.y)) <= smooth_limit
    };
    // A loop that is smooth even at its sharpest vertex closes its ribbon on itself.
    let mut seam: Option<Vec2> = None;
    if closed {
        let a = left_normal(dirs[n - 2]);
        let b = left_normal(dirs[0]);
        let turn = js::acos(clamp_unit(a.x * b.x + a.y * b.y));
        if turn <= smooth_limit
            && hw * js::tan(turn / 2.0) <= js::min(lengths[n - 2], lengths[0]) * 0.5
        {
            let s = hw / (1.0 + a.x * b.x + a.y * b.y);
            seam = Some(v((a.x + b.x) * s, (a.y + b.y) * s));
        }
    }
    let mut run_start = 0;
    for k in 1..n {
        let last = k == n - 1;
        if !last && smooth(k) {
            continue;
        }
        out.push(ribbon(
            &chain,
            &dirs,
            run_start,
            k,
            hw,
            if run_start == 0 { seam } else { None },
            if last { seam } else { None },
        ));
        if !last {
            join(
                chain[k],
                dirs[k - 1],
                dirs[k],
                if gentle(k) {
                    StrokeJoin::Round
                } else {
                    style.join
                },
                style.miter_limit,
                hw,
                max_angle,
                out,
            );
        }
        run_start = k;
    }
    if closed {
        if seam.is_none() {
            join(
                chain[0],
                dirs[n - 2],
                dirs[0],
                style.join,
                style.miter_limit,
                hw,
                max_angle,
                out,
            );
        }
    } else {
        cap(chain[0], dirs[0], -1.0, caps.start, hw, max_angle, out);
        cap(chain[n - 1], dirs[n - 2], 1.0, caps.end, hw, max_angle, out);
    }
}

fn turn_at(a: Vec2, b: Vec2, c: Vec2) -> f64 {
    let d1 = unit(sub(b, a));
    let d2 = unit(sub(c, b));
    js::acos(clamp_unit(d1.x * d2.x + d1.y * d2.y))
}

/// The strip along vertices from..to: left offsets forward, right offsets back.
fn ribbon(
    pts: &[Vec2],
    dirs: &[Vec2],
    from: usize,
    to: usize,
    hw: f64,
    start_offset: Option<Vec2>,
    end_offset: Option<Vec2>,
) -> Ring {
    let mut left: Vec<Pair> = Vec::with_capacity(to - from + 1);
    let mut right: Vec<Pair> = Vec::with_capacity(to - from + 1);
    for k in from..=to {
        let offset = if k == from {
            start_offset.unwrap_or_else(|| add_scaled(v(0.0, 0.0), left_normal(dirs[k]), hw))
        } else if k == to {
            end_offset.unwrap_or_else(|| add_scaled(v(0.0, 0.0), left_normal(dirs[k - 1]), hw))
        } else {
            let a = left_normal(dirs[k - 1]);
            let b = left_normal(dirs[k]);
            let s = hw / (1.0 + a.x * b.x + a.y * b.y);
            v((a.x + b.x) * s, (a.y + b.y) * s)
        };
        left.push([pts[k].x + offset.x, pts[k].y + offset.y]);
        right.push([pts[k].x - offset.x, pts[k].y - offset.y]);
    }
    left.extend(right.into_iter().rev());
    left
}

/// The outer wedge at a corner; the inner side is covered by the two ribbons overlapping.
#[allow(clippy::too_many_arguments)]
fn join(
    vtx: Vec2,
    din: Vec2,
    dout: Vec2,
    kind: StrokeJoin,
    miter_limit: f64,
    hw: f64,
    max_angle: f64,
    out: &mut Vec<Ring>,
) {
    let turn_cross = din.x * dout.y - din.y * dout.x;
    let cos_turn = din.x * dout.x + din.y * dout.y;
    if turn_cross.abs() < 1e-12 && cos_turn > 0.0 {
        return;
    }
    let side = if turn_cross > 0.0 { 1.0 } else { -1.0 };
    let na = left_normal(din);
    let nb = left_normal(dout);
    let a = add_scaled(vtx, na, hw * side);
    let b = add_scaled(vtx, nb, hw * side);
    if kind == StrokeJoin::Round {
        // A full reversal has no outer side: the whole pen disc covers it.
        if cos_turn < -1.0 + 1e-9 {
            out.push(disc(vtx, hw, max_angle));
            return;
        }
        let start = js::atan2(a.y - vtx.y, a.x - vtx.x);
        let mut sweep = js::atan2(b.y - vtx.y, b.x - vtx.x) - start;
        if side < 0.0 {
            while sweep > 0.0 {
                sweep -= 2.0 * PI;
            }
        } else {
            while sweep < 0.0 {
                sweep += 2.0 * PI;
            }
        }
        let steps = js::max(2.0, (sweep.abs() / max_angle).ceil());
        // Exact end points, so the wedge meets the ribbons' corners without slivers.
        let mut ring: Ring = vec![pair(vtx), pair(a)];
        let mut k = 1.0;
        while k < steps {
            let angle = start + (sweep * k) / steps;
            ring.push([vtx.x + js::cos(angle) * hw, vtx.y + js::sin(angle) * hw]);
            k += 1.0;
        }
        ring.push(pair(b));
        out.push(ring);
        return;
    }
    if kind == StrokeJoin::Miter {
        // Miter length over stroke width is 1 / sin(φ/2), φ the angle between the two segments.
        let half_interior = (PI - js::acos(clamp_unit(cos_turn))) / 2.0;
        if js::sin(half_interior) > 1e-9 && 1.0 / js::sin(half_interior) <= miter_limit {
            let s = hw / (1.0 + na.x * nb.x + na.y * nb.y);
            let tip = v(
                vtx.x + (na.x + nb.x) * s * side,
                vtx.y + (na.y + nb.y) * s * side,
            );
            out.push(vec![pair(vtx), pair(a), pair(tip), pair(b)]);
            return;
        }
    }
    out.push(vec![pair(vtx), pair(a), pair(b)]);
}

fn cap(
    p: Vec2,
    d: Vec2,
    outward: f64,
    kind: StrokeCap,
    hw: f64,
    max_angle: f64,
    out: &mut Vec<Ring>,
) {
    if kind == StrokeCap::Round {
        // Half a pen disc from one ribbon corner round the end to the other, corners exact.
        let n = left_normal(d);
        let e = v(d.x * outward, d.y * outward);
        let steps = js::max(4.0, (PI / max_angle).ceil());
        let mut ring: Ring = vec![pair(add_scaled(p, n, hw))];
        let mut k = 1.0;
        while k < steps {
            let angle = (PI * k) / steps;
            ring.push([
                p.x + (n.x * js::cos(angle) + e.x * js::sin(angle)) * hw,
                p.y + (n.y * js::cos(angle) + e.y * js::sin(angle)) * hw,
            ]);
            k += 1.0;
        }
        ring.push(pair(add_scaled(p, n, -hw)));
        out.push(ring);
    } else if kind == StrokeCap::Square {
        let n = left_normal(d);
        let e = v(d.x * outward * hw, d.y * outward * hw);
        out.push(vec![
            pair(add_scaled(p, n, hw)),
            pair(add_scaled(add_scaled(p, n, hw), e, 1.0)),
            pair(add_scaled(add_scaled(p, n, -hw), e, 1.0)),
            pair(add_scaled(p, n, -hw)),
        ]);
    }
}

/// Stroke tolerance: finer for thin strokes, never coarser than 0.05 px.
pub fn stroke_tolerance(weight: f64) -> f64 {
    js::min(0.05, js::max(0.004, weight * 0.005))
}

/// The area a CENTER stroke of `weight` paints along the polylines.
fn center_area(
    polylines: &[Polyline],
    style: &StrokeStyle,
    weight: f64,
    caps: impl Fn(usize) -> Caps,
    tolerance: f64,
) -> MultiPolygon {
    let hw = weight / 2.0;
    let max_angle = js::min(
        0.35,
        js::max(
            0.03,
            2.0 * js::acos(js::max(-1.0, 1.0 - tolerance / js::max(hw, tolerance))),
        ),
    );
    let mut rings: Vec<Ring> = Vec::new();
    for (k, line) in polylines.iter().enumerate() {
        stroke_pieces(line, style, weight, caps(k), max_angle, &mut rings);
    }
    let pieces: Vec<MultiPolygon> = rings
        .into_iter()
        .filter(|r| r.len() >= 3)
        .map(|r| vec![vec![r]])
        .collect();
    if pieces.is_empty() {
        Vec::new()
    } else {
        combine_areas(BooleanOperation::Union, &pieces)
    }
}

/// Flattening steps for offsetting.
fn stroke_flatten(commands: &[PathCommand], weight: f64, tolerance: f64) -> Vec<Polyline> {
    let hw = js::max(weight / 2.0, tolerance);
    let max_angle = js::min(
        0.35,
        js::max(0.03, 2.0 * js::acos(js::max(-1.0, 1.0 - tolerance / hw))),
    );
    flatten_path(commands, tolerance, max_angle, None)
}

/// The stroke area of `paths` with `style`, as polygons. Markers go at open ends.
pub fn stroke_area(
    paths: &[VectorPath],
    style: &StrokeStyle,
    tolerance: Option<f64>,
    start_marker: StrokeMarker,
    end_marker: StrokeMarker,
) -> MultiPolygon {
    let weight = js::max(0.0, style.weight);
    if !(weight > 0.0) {
        return Vec::new();
    }
    let tolerance = tolerance.unwrap_or_else(|| stroke_tolerance(weight));
    let cap_at = |marker: StrokeMarker| match marker {
        StrokeMarker::Round => StrokeCap::Round,
        StrokeMarker::Square => StrokeCap::Square,
        StrokeMarker::None => style.cap,
        _ => StrokeCap::None,
    };
    let mut parts: Vec<MultiPolygon> = Vec::new();
    for path in paths {
        let pieces = subpaths(&path.commands);
        let mut closed_commands: Vec<PathCommand> = Vec::new();
        let mut open_lines: Vec<Polyline> = Vec::new();
        let mut open_caps: Vec<Caps> = Vec::new();
        let mut marker_rings: Vec<Ring> = Vec::new();
        let mut marker_lines: Vec<Polyline> = Vec::new();
        for piece in pieces {
            if matches!(piece.last(), Some(PathCommand::Z)) {
                closed_commands.extend_from_slice(piece);
                continue;
            }
            let lines = stroke_flatten(piece, weight, tolerance);
            let Some(first) = lines.into_iter().next() else {
                continue;
            };
            let mut points = first.points;
            // Markers sit on the curve's real ends and directions, not the flattened ones.
            let mut trim_start = 0.0;
            let mut trim_end = 0.0;
            if start_marker != StrokeMarker::None || end_marker != StrokeMarker::None {
                let as_path = [VectorPath {
                    winding_rule: WindingRule::Nonzero,
                    commands: piece.to_vec(),
                }];
                for end in path_ends(&as_path, start_marker, end_marker) {
                    if matches!(
                        end.marker,
                        StrokeMarker::None | StrokeMarker::Round | StrokeMarker::Square
                    ) {
                        continue;
                    }
                    let shape = marker_geometry(end.marker, end.point, end.direction, weight);
                    if end.position == EndPosition::Start {
                        trim_start = shape.trim;
                    } else {
                        trim_end = shape.trim;
                    }
                    for line in flatten_path(&shape.fill, tolerance, 0.0, None) {
                        if line.points.len() >= 3 {
                            marker_rings.push(line.points.iter().map(|&p| pair(p)).collect());
                        }
                    }
                    marker_lines.extend(flatten_path(&shape.stroke, tolerance, 0.0, None));
                }
            }
            if trim_start != 0.0 || trim_end != 0.0 {
                points = trim_polyline(&points, trim_start, trim_end);
            }
            let dashed = dash_polylines(
                &[Polyline {
                    points,
                    closed: false,
                }],
                &style.dash_pattern,
            );
            let count = dashed.len();
            for (k, line) in dashed.into_iter().enumerate() {
                open_lines.push(line);
                open_caps.push(Caps {
                    start: if k == 0 {
                        cap_at(start_marker)
                    } else {
                        style.cap
                    },
                    end: if k == count - 1 {
                        cap_at(end_marker)
                    } else {
                        style.cap
                    },
                });
            }
        }
        if !open_lines.is_empty() {
            parts.push(center_area(
                &open_lines,
                style,
                weight,
                |k| open_caps[k],
                tolerance,
            ));
        }
        if !marker_lines.is_empty() {
            let marker_style = StrokeStyle {
                join: StrokeJoin::Miter,
                miter_limit: 10.0,
                ..style.clone()
            };
            parts.push(center_area(
                &marker_lines,
                &marker_style,
                weight,
                |_| Caps {
                    start: style.cap,
                    end: style.cap,
                },
                tolerance,
            ));
        }
        if !marker_rings.is_empty() {
            let rings: Vec<MultiPolygon> =
                marker_rings.into_iter().map(|r| vec![vec![r]]).collect();
            parts.push(combine_areas(BooleanOperation::Union, &rings));
        }
        if !closed_commands.is_empty() {
            let lines = dash_polylines(
                &stroke_flatten(&closed_commands, weight, tolerance),
                &style.dash_pattern,
            );
            let aligned = style.align != StrokeAlign::Center;
            let band = center_area(
                &lines,
                style,
                if aligned { weight * 2.0 } else { weight },
                |_| Caps {
                    start: style.cap,
                    end: style.cap,
                },
                tolerance,
            );
            if !aligned {
                parts.push(band);
            } else {
                let fill = fill_area(
                    &[VectorPath {
                        winding_rule: path.winding_rule,
                        commands: closed_commands,
                    }],
                    tolerance,
                );
                let operation = if style.align == StrokeAlign::Inside {
                    BooleanOperation::Intersect
                } else {
                    BooleanOperation::Subtract
                };
                parts.push(combine_areas(operation, &[band, fill]));
            }
        }
    }
    let mut present: Vec<MultiPolygon> = parts.into_iter().filter(|p| !p.is_empty()).collect();
    match present.len() {
        0 => Vec::new(),
        1 => present.pop().unwrap_or_default(),
        _ => combine_areas(BooleanOperation::Union, &present),
    }
}

/// Rectangle strokes with a weight per side: the band between the box grown by the outer parts of the
/// weights and shrunk by the inner parts (by alignment), corners following the radii.
fn individual_stroke_area(
    node: &SceneNode,
    weights: &morfa_model::IndividualStrokeWeights,
    tolerance: f64,
) -> MultiPolygon {
    let sides = [weights.top, weights.right, weights.bottom, weights.left]
        .map(|v| js::max(0.0, if v.is_finite() { v } else { 0.0 }));
    let outer_part = match node.stroke_align {
        StrokeAlign::Inside => 0.0,
        StrokeAlign::Center => 0.5,
        StrokeAlign::Outside => 1.0,
    };
    let outer = sides.map(|v| v * outer_part);
    let inner = sides.map(|v| v * (1.0 - outer_part));
    let radii = node_corner_radii(node);
    const TOUCHING: [[usize; 2]; 4] = [[0, 3], [0, 1], [2, 1], [2, 3]];
    let grow = |offsets: &[f64; 4], sign: f64| -> CornerRadii {
        let mut out = [0.0; 4];
        for (k, r) in radii.iter().enumerate() {
            let offset = js::max(offsets[TOUCHING[k][0]], offsets[TOUCHING[k][1]]);
            out[k] = if sign > 0.0 {
                if *r > 0.0 {
                    r + offset
                } else if node.stroke_join == StrokeJoin::Round {
                    offset
                } else {
                    0.0
                }
            } else {
                js::max(0.0, r - offset)
            };
        }
        out
    };
    let smoothing = node.corner_smoothing.unwrap_or(0.0);
    let rect_box = |x: f64, y: f64, w: f64, h: f64, r: CornerRadii| -> Vec<VectorPath> {
        if w > 0.0 && h > 0.0 {
            let commands = rectangle_path(w, h, &r, smoothing)
                .into_iter()
                .map(|c| shift(c, x, y))
                .collect();
            vec![VectorPath {
                winding_rule: WindingRule::Nonzero,
                commands,
            }]
        } else {
            Vec::new()
        }
    };
    let outer_box = rect_box(
        -outer[3],
        -outer[0],
        node.width + outer[1] + outer[3],
        node.height + outer[0] + outer[2],
        grow(&outer, 1.0),
    );
    let inner_box = rect_box(
        inner[3],
        inner[0],
        node.width - inner[1] - inner[3],
        node.height - inner[0] - inner[2],
        grow(&inner, -1.0),
    );
    combine_areas(
        BooleanOperation::Subtract,
        &[
            fill_area(&outer_box, tolerance),
            fill_area(&inner_box, tolerance),
        ],
    )
}

fn shift(c: PathCommand, x: f64, y: f64) -> PathCommand {
    match c {
        PathCommand::C(k) => PathCommand::C(CubicTo {
            x1: k.x1 + x,
            y1: k.y1 + y,
            x2: k.x2 + x,
            y2: k.y2 + y,
            x: k.x + x,
            y: k.y + y,
        }),
        PathCommand::Q(q) => PathCommand::Q(morfa_model::QuadTo {
            x1: q.x1 + x,
            y1: q.y1 + y,
            x: q.x + x,
            y: q.y + y,
        }),
        PathCommand::Z => c,
        PathCommand::M(p) => PathCommand::M(v(p.x + x, p.y + y)),
        PathCommand::L(p) => PathCommand::L(v(p.x + x, p.y + y)),
    }
}

/// Polygons back to paths: straight runs stay lines, runs of gently turning points are fitted with
/// cubics within `tolerance`, corners stay sharp.
pub fn polygons_to_smooth_paths(area: &MultiPolygon, tolerance: f64) -> Vec<VectorPath> {
    let mut commands: Vec<PathCommand> = Vec::new();
    let corner = 0.6; // radians: sampling never turns this much between two points
    for polygon in area {
        for ring in polygon {
            let mut pts: Vec<Vec2> = Vec::with_capacity(ring.len());
            for &[x, y] in ring {
                if pts
                    .last()
                    .is_none_or(|q| (q.x - x).abs() > 1e-9 || (q.y - y).abs() > 1e-9)
                {
                    pts.push(v(x, y));
                }
            }
            if pts.len() > 1 && {
                let (a, b) = (pts[0], pts[pts.len() - 1]);
                (a.x - b.x).abs() <= 1e-9 && (a.y - b.y).abs() <= 1e-9
            } {
                pts.pop();
            }
            let n = pts.len();
            if n < 3 {
                continue;
            }
            // Breaks: sharp turns, and where a long straight edge meets short curve samples.
            let edge = |k: usize| len(sub(pts[(k + 1) % n], pts[k]));
            let mut corners: Vec<usize> = Vec::new();
            for k in 0..n {
                let before = edge((k + n - 1) % n);
                let after = edge(k);
                let ratio = js::max(before, after) / js::max(1e-12, js::min(before, after));
                if turn_at(pts[(k + n - 1) % n], pts[k], pts[(k + 1) % n]) > corner || ratio > 6.0 {
                    corners.push(k);
                }
            }
            let starts = if corners.is_empty() { vec![0] } else { corners };
            commands.push(PathCommand::M(pts[starts[0]]));
            for c in 0..starts.len() {
                let from = starts[c];
                let to = if c + 1 < starts.len() {
                    starts[c + 1]
                } else {
                    starts[0] + n
                };
                let run: Vec<Vec2> = (from..=to).map(|k| pts[k % n]).collect();
                emit_run(&run, tolerance, &mut commands);
            }
            if let Some(PathCommand::L(last)) = commands.last() {
                if last.x == pts[starts[0]].x && last.y == pts[starts[0]].y {
                    commands.pop();
                }
            }
            commands.push(PathCommand::Z);
        }
    }
    if commands.is_empty() {
        Vec::new()
    } else {
        vec![VectorPath {
            winding_rule: WindingRule::Nonzero,
            commands,
        }]
    }
}

fn emit_run(run: &[Vec2], tolerance: f64, out: &mut Vec<PathCommand>) {
    let a = run[0];
    let b = run[run.len() - 1];
    let chord = sub(b, a);
    let chord_length = len(chord);
    let mut straight = true;
    let mut k = 1;
    while k + 1 < run.len() && straight {
        let p = sub(run[k], a);
        let d = if chord_length != 0.0 && !chord_length.is_nan() {
            (p.x * chord.y - p.y * chord.x).abs() / chord_length
        } else {
            len(p)
        };
        if d > tolerance {
            straight = false;
        }
        k += 1;
    }
    if straight || run.len() < 4 {
        // Few points: keep them as lines (they are corners of joins or caps, not samples of a curve).
        if straight {
            append_line(out, b.x, b.y, 1e-6);
        } else {
            for p in &run[1..] {
                append_line(out, p.x, p.y, 1e-6);
            }
        }
        return;
    }
    for c in fit_cubics(run, tolerance) {
        out.push(PathCommand::C(CubicTo {
            x1: c[1].x,
            y1: c[1].y,
            x2: c[2].x,
            y2: c[2].y,
            x: c[3].x,
            y: c[3].y,
        }));
    }
}

/// The stroke of `node` as filled paths in its local space (empty when it has no stroke weight).
/// `geometry` defaults to the node's own outline; pass a boolean's result for boolean nodes.
/// Variable-width strokes are not handled here (stroke-profile.ts).
pub fn outline_stroke(
    node: &SceneNode,
    geometry: Option<&[VectorPath]>,
    tolerance: Option<f64>,
) -> Vec<VectorPath> {
    let own;
    let geometry = match geometry {
        Some(g) => g,
        None => {
            own = node_geometry(node);
            &own
        }
    };
    let individual = node.individual_stroke_weights.flatten().filter(|_| {
        matches!(
            node.kind,
            NodeType::Rectangle
                | NodeType::Frame
                | NodeType::Component
                | NodeType::Instance
                | NodeType::ComponentSet
        )
    });
    let heaviest = match &individual {
        Some(w) => js::max(js::max(js::max(w.top, w.right), w.bottom), w.left),
        None => node.stroke_weight,
    };
    if !(heaviest > 0.0) {
        return Vec::new();
    }
    let tolerance = tolerance.unwrap_or_else(|| stroke_tolerance(heaviest));
    let markers = matches!(node.kind, NodeType::Line | NodeType::Vector);
    let area = match &individual {
        Some(weights) => individual_stroke_area(node, weights, tolerance),
        None => stroke_area(
            geometry,
            &stroke_style_of(node),
            Some(tolerance),
            if markers {
                node.stroke_start_marker.unwrap_or(StrokeMarker::None)
            } else {
                StrokeMarker::None
            },
            if markers {
                node.stroke_end_marker.unwrap_or(StrokeMarker::None)
            } else {
                StrokeMarker::None
            },
        ),
    };
    polygons_to_smooth_paths(&area, tolerance)
}
