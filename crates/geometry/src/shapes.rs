//! `shared/design/shapes.ts`: the outline of each node type as paths in its local box (rectangles with
//! Figma's corner sharing and smoothing, ellipses and arcs, polygons and stars, lines, vectors), stroke
//! ends and markers.

use std::f64::consts::{PI, SQRT_2};

use morfa_model::{
    ArcData, CubicTo, NodeType, PathCommand, SceneNode, StrokeMarker, Vec2, VectorPath, WindingRule,
};

use crate::js;
use crate::paths::{Cubic, cubic_tangent, ellipse_arc_cubics, path_segments, subpaths, v};

const KAPPA: f64 = 0.5522847498307936; // cubic approximation of a quarter circle
const FULL_TURN: f64 = 2.0 * PI;

#[inline]
fn cubic_command(c: &Cubic) -> PathCommand {
    PathCommand::C(CubicTo {
        x1: c[1].x,
        y1: c[1].y,
        x2: c[2].x,
        y2: c[2].y,
        x: c[3].x,
        y: c[3].y,
    })
}

/// `finite(value, fallback)`.
#[inline]
fn finite(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(v) if v.is_finite() => v,
        _ => fallback,
    }
}

#[inline]
fn path(winding_rule: WindingRule, commands: Vec<PathCommand>) -> VectorPath {
    VectorPath {
        winding_rule,
        commands,
    }
}

// ── Rectangles ─────────────────────────────────────────────────────────────────────────────────

/// [top-left, top-right, bottom-right, bottom-left].
pub type CornerRadii = [f64; 4];

/// A corner after clamping: the radius drawn and the length along each side it may use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedCorner {
    pub radius: f64,
    pub budget: f64,
}

/// The radii a rectangle-like node asks for (per corner when set, otherwise the single radius).
pub fn corner_radii_of(
    corner_radius: Option<f64>,
    rectangle_corner_radii: Option<[f64; 4]>,
) -> CornerRadii {
    if let Some(r) = rectangle_corner_radii {
        return r.map(|v| js::max(0.0, finite(Some(v), 0.0)));
    }
    let single = js::max(0.0, finite(corner_radius, 0.0));
    [single; 4]
}

pub fn node_corner_radii(node: &SceneNode) -> CornerRadii {
    corner_radii_of(node.corner_radius, node.rectangle_corner_radii.flatten())
}

const NEIGHBOURS: [[usize; 2]; 4] = [[1, 3], [0, 2], [3, 1], [2, 0]];

/// Figma's sharing of the sides between corners: corners choose largest first.
pub fn resolve_corner_radii(width: f64, height: f64, radii: &CornerRadii) -> [ResolvedCorner; 4] {
    let w = js::max(0.0, width);
    let h = js::max(0.0, height);
    let mut radius = radii.map(|r| js::max(0.0, finite(Some(r), 0.0)));
    let mut budget = [-1.0f64; 4];
    // [0, 1, 2, 3].sort((a, b) => radius[b] - radius[a] || a - b): a stable sort by radius, descending.
    let mut order = [0usize, 1, 2, 3];
    order.sort_by(|&a, &b| {
        let d = radius[b] - radius[a];
        if d != 0.0 && !d.is_nan() {
            if d < 0.0 {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            a.cmp(&b)
        }
    });
    for corner in order {
        let r = radius[corner];
        let mut room = f64::INFINITY;
        for (k, &neighbour) in NEIGHBOURS[corner].iter().enumerate() {
            let side = if k == 0 { w } else { h };
            let other = radius[neighbour];
            if r == 0.0 && other == 0.0 {
                room = 0.0;
                continue;
            }
            let share = if budget[neighbour] >= 0.0 {
                side - budget[neighbour]
            } else {
                (r / (r + other)) * side
            };
            room = js::min(room, share);
        }
        budget[corner] = js::max(0.0, room);
        radius[corner] = js::min(r, budget[corner]);
    }
    [0, 1, 2, 3].map(|k| ResolvedCorner {
        radius: radius[k],
        budget: budget[k],
    })
}

/// Figma's smoothed corner parameters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SmoothCorner {
    pub smoothing: f64,
    pub p: f64,
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub arc_measure: f64,
}

pub fn smooth_corner_params(radius: f64, smoothing: f64, budget: f64) -> SmoothCorner {
    let s = js::max(0.0, js::min(js::min(smoothing, budget / radius - 1.0), 1.0));
    let p = js::min((1.0 + s) * radius, budget);
    let arc_measure = (PI / 2.0) * (1.0 - s);
    let arc_section = js::sin(arc_measure / 2.0) * radius * SQRT_2;
    let angle_alpha = (PI / 2.0 - arc_measure) / 2.0;
    let p3_to_p4 = radius * js::tan(angle_alpha / 2.0);
    let angle_beta = (PI / 4.0) * s;
    let c = p3_to_p4 * js::cos(angle_beta);
    let d = c * js::tan(angle_beta);
    let b = (p - arc_section - c - d) / 3.0;
    let a = 2.0 * b;
    SmoothCorner {
        smoothing: s,
        p,
        a,
        b,
        c,
        d,
        arc_measure,
    }
}

/// A rectangle outline from its top edge, clockwise on screen, with per-corner radii and smoothing.
pub fn rectangle_path(
    width: f64,
    height: f64,
    radii: &CornerRadii,
    smoothing: f64,
) -> Vec<PathCommand> {
    let w = js::max(0.0, finite(Some(width), 0.0));
    let h = js::max(0.0, finite(Some(height), 0.0));
    let corners = resolve_corner_radii(w, h, radii);
    let smoothing = js::max(0.0, js::min(1.0, finite(Some(smoothing), 0.0)));
    // Each corner: its vertex, the direction travelled into it and the direction out of it.
    let frames: [(Vec2, Vec2, Vec2); 4] = [
        (v(0.0, 0.0), v(0.0, -1.0), v(1.0, 0.0)),
        (v(w, 0.0), v(1.0, 0.0), v(0.0, 1.0)),
        (v(w, h), v(0.0, 1.0), v(-1.0, 0.0)),
        (v(0.0, h), v(-1.0, 0.0), v(0.0, -1.0)),
    ];
    let at = |k: usize, back: f64, along: f64| {
        let (vv, u, o) = frames[k];
        v(
            vv.x - u.x * back + o.x * along,
            vv.y - u.y * back + o.y * along,
        )
    };
    let params: [Option<SmoothCorner>; 4] = corners.map(|c| {
        if c.radius > 0.0 {
            Some(smooth_corner_params(c.radius, smoothing, c.budget))
        } else {
            None
        }
    });
    let reach = params.map(|p| p.map_or(0.0, |p| p.p));
    let start = at(0, 0.0, reach[0]);
    let mut out = vec![PathCommand::M(start)];
    let mut current = start;
    let line_to = |out: &mut Vec<PathCommand>, current: &mut Vec2, p: Vec2| {
        if (p.x - current.x).abs() > 1e-9 || (p.y - current.y).abs() > 1e-9 {
            out.push(PathCommand::L(p));
        }
        *current = p;
    };
    let curve_to = |out: &mut Vec<PathCommand>, current: &mut Vec2, c1: Vec2, c2: Vec2, p: Vec2| {
        out.push(PathCommand::C(CubicTo {
            x1: c1.x,
            y1: c1.y,
            x2: c2.x,
            y2: c2.y,
            x: p.x,
            y: p.y,
        }));
        *current = p;
    };
    for k in [1usize, 2, 3, 0] {
        let Some(param) = params[k] else {
            if k != 0 {
                line_to(&mut out, &mut current, frames[k].0);
            }
            continue;
        };
        let r = corners[k].radius;
        line_to(&mut out, &mut current, at(k, param.p, 0.0));
        if param.smoothing <= 1e-9 {
            curve_to(
                &mut out,
                &mut current,
                at(k, r * (1.0 - KAPPA), 0.0),
                at(k, 0.0, r * (1.0 - KAPPA)),
                at(k, 0.0, r),
            );
            continue;
        }
        let SmoothCorner {
            p,
            a,
            b,
            c,
            d,
            arc_measure,
            ..
        } = param;
        curve_to(
            &mut out,
            &mut current,
            at(k, p - a, 0.0),
            at(k, p - a - b, 0.0),
            at(k, p - a - b - c, d),
        );
        if arc_measure > 1e-9 {
            // The arc around the corner's circle centre, turning the same way as the rectangle.
            let center = at(k, r, r);
            let from = at(k, p - a - b - c, d);
            let start_angle = js::atan2(from.y - center.y, from.x - center.x);
            for piece in ellipse_arc_cubics(center, r, r, 0.0, start_angle, arc_measure) {
                curve_to(&mut out, &mut current, piece[1], piece[2], piece[3]);
            }
        }
        curve_to(
            &mut out,
            &mut current,
            at(k, 0.0, p - a - b),
            at(k, 0.0, p - a),
            at(k, 0.0, p),
        );
    }
    // The last corner ends where the path started: Z closes without a line.
    if let Some(PathCommand::L(last)) = out.last() {
        if (last.x - start.x).abs() < 1e-9 && (last.y - start.y).abs() < 1e-9 {
            out.pop();
        }
    }
    out.push(PathCommand::Z);
    out
}

// ── Ellipses ───────────────────────────────────────────────────────────────────────────────────

/// An ellipse filling the box, or its arc: a pie slice, a ring (EVENODD) or a donut slice.
pub fn ellipse_paths(width: f64, height: f64, arc: Option<&ArcData>) -> Vec<VectorPath> {
    let rx = js::max(0.0, finite(Some(width), 0.0)) / 2.0;
    let ry = js::max(0.0, finite(Some(height), 0.0)) / 2.0;
    let center = v(rx, ry);
    let start = finite(arc.map(|a| a.starting_angle), 0.0);
    let sweep = finite(arc.map(|a| a.ending_angle), FULL_TURN) - start;
    let inner = js::max(0.0, js::min(1.0, finite(arc.map(|a| a.inner_radius), 0.0)));
    let full = sweep.abs() >= FULL_TURN - 1e-6 || sweep.abs() < 1e-9;
    let point_at = |sx: f64, sy: f64, angle: f64| {
        v(
            center.x + sx * js::cos(angle),
            center.y + sy * js::sin(angle),
        )
    };
    let arc_commands = |sx: f64, sy: f64, from: f64, by: f64| {
        ellipse_arc_cubics(center, sx, sy, 0.0, from, by)
            .iter()
            .map(cubic_command)
            .collect::<Vec<_>>()
    };
    // A whole turn must end exactly where it began (cos 2π is not exactly 1 in floating point).
    let lp = |sx: f64, sy: f64, by: f64| {
        let mut commands = arc_commands(sx, sy, 0.0, by);
        if let Some(PathCommand::C(last)) = commands.last_mut() {
            last.x = center.x + sx;
            last.y = center.y;
        }
        let mut out = Vec::with_capacity(commands.len() + 2);
        out.push(PathCommand::M(v(center.x + sx, center.y)));
        out.extend(commands);
        out.push(PathCommand::Z);
        out
    };
    if full {
        let outer = lp(rx, ry, FULL_TURN);
        if inner <= 0.0 {
            return vec![path(WindingRule::Nonzero, outer)];
        }
        // The hole runs the other way too, so the ring is right under either winding rule.
        let mut commands = outer;
        commands.extend(lp(rx * inner, ry * inner, -FULL_TURN));
        return vec![path(WindingRule::Evenodd, commands)];
    }
    let begin = point_at(rx, ry, start);
    if inner <= 0.0 {
        let mut commands = vec![PathCommand::M(center), PathCommand::L(begin)];
        commands.extend(arc_commands(rx, ry, start, sweep));
        commands.push(PathCommand::Z);
        return vec![path(WindingRule::Nonzero, commands)];
    }
    let ix = rx * inner;
    let iy = ry * inner;
    let inner_end = point_at(ix, iy, start + sweep);
    let mut commands = vec![PathCommand::M(begin)];
    commands.extend(arc_commands(rx, ry, start, sweep));
    commands.push(PathCommand::L(inner_end));
    commands.extend(arc_commands(ix, iy, start + sweep, -sweep));
    commands.push(PathCommand::Z);
    vec![path(WindingRule::Nonzero, commands)]
}

// ── Polygons and stars ─────────────────────────────────────────────────────────────────────────

/// Vertices of a regular polygon (or a star, with `inner` as the ratio of the inner points) inscribed
/// in the box's ellipse, first point at the top centre, going clockwise.
pub fn polygon_vertices(
    width: f64,
    height: f64,
    point_count: f64,
    inner: Option<f64>,
) -> Vec<Vec2> {
    let count = js::max(
        3.0,
        js::min(1000.0, js::round(finite(Some(point_count), 3.0))),
    );
    let total = if inner.is_none() { count } else { count * 2.0 };
    let rx = js::max(0.0, finite(Some(width), 0.0)) / 2.0;
    let ry = js::max(0.0, finite(Some(height), 0.0)) / 2.0;
    let mut out = Vec::with_capacity(total as usize);
    let mut k = 0.0;
    while k < total {
        let angle = -PI / 2.0 + (k * 2.0 * PI) / total;
        let s = match inner {
            Some(i) if k % 2.0 != 0.0 => js::max(0.0, js::min(1.0, i)),
            _ => 1.0,
        };
        out.push(v(
            rx + js::cos(angle) * rx * s,
            ry + js::sin(angle) * ry * s,
        ));
        k += 1.0;
    }
    out
}

/// A closed polygon through `points` with every vertex rounded by `radius` (one per vertex allowed).
pub fn rounded_polygon_path(points: &[Vec2], radius: impl Fn(usize) -> f64) -> Vec<PathCommand> {
    let n = points.len();
    if n < 2 {
        return if n == 1 {
            vec![PathCommand::M(points[0]), PathCommand::Z]
        } else {
            Vec::new()
        };
    }
    let radius_at = |k: usize| js::max(0.0, finite(Some(radius(k)), 0.0));
    let mut out = Vec::new();
    let push = |out: &mut Vec<PathCommand>, p: Vec2, first: bool| {
        out.push(if first {
            PathCommand::M(p)
        } else {
            PathCommand::L(p)
        })
    };
    for k in 0..n {
        let prev = points[(k + n - 1) % n];
        let vv = points[k];
        let next = points[(k + 1) % n];
        let in_length = js::hypot(vv.x - prev.x, vv.y - prev.y);
        let out_length = js::hypot(next.x - vv.x, next.y - vv.y);
        let r = radius_at(k);
        if r == 0.0 || r.is_nan() || in_length < 1e-9 || out_length < 1e-9 {
            push(&mut out, vv, k == 0);
            continue;
        }
        let din = v((vv.x - prev.x) / in_length, (vv.y - prev.y) / in_length);
        let dout = v((next.x - vv.x) / out_length, (next.y - vv.y) / out_length);
        let turn = js::atan2(
            din.x * dout.y - din.y * dout.x,
            din.x * dout.x + din.y * dout.y,
        );
        let abs_turn = turn.abs();
        if abs_turn < 1e-6 || abs_turn > PI - 1e-6 {
            push(&mut out, vv, k == 0);
            continue;
        }
        let half = js::tan(abs_turn / 2.0);
        let tangent = js::min(js::min(r * half, in_length / 2.0), out_length / 2.0);
        let effective = tangent / half;
        let a = v(vv.x - din.x * tangent, vv.y - din.y * tangent);
        // The centre sits on the side the path turns towards.
        let side = if turn > 0.0 { 1.0 } else { -1.0 };
        let center = v(
            a.x - din.y * effective * side,
            a.y + din.x * effective * side,
        );
        push(&mut out, a, k == 0);
        let start_angle = js::atan2(a.y - center.y, a.x - center.x);
        for piece in ellipse_arc_cubics(center, effective, effective, 0.0, start_angle, turn) {
            out.push(cubic_command(&piece));
        }
    }
    out.push(PathCommand::Z);
    out
}

pub fn polygon_path(
    width: f64,
    height: f64,
    point_count: f64,
    corner_radius: f64,
) -> Vec<PathCommand> {
    rounded_polygon_path(&polygon_vertices(width, height, point_count, None), |_| {
        corner_radius
    })
}

pub fn star_path(
    width: f64,
    height: f64,
    point_count: f64,
    inner_radius: f64,
    corner_radius: f64,
) -> Vec<PathCommand> {
    rounded_polygon_path(
        &polygon_vertices(width, height, point_count, Some(inner_radius)),
        |_| corner_radius,
    )
}

// ── Nodes ──────────────────────────────────────────────────────────────────────────────────────

/// The node's fill outline in local coordinates. Empty for nodes that draw no geometry of their own.
pub fn node_geometry(node: &SceneNode) -> Vec<VectorPath> {
    let w = js::max(0.0, finite(Some(node.width), 0.0));
    let h = js::max(0.0, finite(Some(node.height), 0.0));
    match node.kind {
        NodeType::Rectangle
        | NodeType::Frame
        | NodeType::Component
        | NodeType::ComponentSet
        | NodeType::Instance
        | NodeType::Section => {
            vec![path(
                WindingRule::Nonzero,
                rectangle_path(
                    w,
                    h,
                    &node_corner_radii(node),
                    node.corner_smoothing.unwrap_or(0.0),
                ),
            )]
        }
        NodeType::Ellipse => ellipse_paths(w, h, node.arc_data.as_ref()),
        NodeType::Polygon => vec![path(
            WindingRule::Nonzero,
            polygon_path(
                w,
                h,
                node.point_count.unwrap_or(3.0),
                node.corner_radius.unwrap_or(0.0),
            ),
        )],
        NodeType::Star => vec![path(
            WindingRule::Nonzero,
            star_path(
                w,
                h,
                node.point_count.unwrap_or(5.0),
                node.inner_radius.unwrap_or(0.382),
                node.corner_radius.unwrap_or(0.0),
            ),
        )],
        NodeType::Line => vec![path(
            WindingRule::Nonzero,
            vec![PathCommand::M(v(0.0, 0.0)), PathCommand::L(v(w, 0.0))],
        )],
        NodeType::Vector => node.vector_paths.clone().unwrap_or_default(),
        _ => Vec::new(),
    }
}

// ── Stroke ends and markers ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndPosition {
    Start,
    End,
}

/// An end of an open subpath: where it is, which way an arrow there points, and its marker.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokeEnd {
    pub point: Vec2,
    pub direction: Vec2,
    pub position: EndPosition,
    pub subpath: usize,
    pub marker: StrokeMarker,
}

/// Ends of every open subpath of `paths`, each with its outward direction and marker.
pub fn path_ends(
    paths: &[VectorPath],
    start_marker: StrokeMarker,
    end_marker: StrokeMarker,
) -> Vec<StrokeEnd> {
    let mut ends = Vec::new();
    let mut subpath = 0;
    for p in paths {
        for part in subpaths(&p.commands) {
            let index = subpath;
            subpath += 1;
            if matches!(part.last(), Some(PathCommand::Z)) {
                continue;
            }
            let segments = path_segments(part, false);
            let (Some(first), Some(last)) = (segments.first(), segments.last()) else {
                continue;
            };
            let start_cubic: Cubic = match first.controls {
                Some([c1, c2]) => [first.p0, c1, c2, first.p1],
                None => [first.p0, first.p0, first.p1, first.p1],
            };
            let end_cubic: Cubic = match last.controls {
                Some([c1, c2]) => [last.p0, c1, c2, last.p1],
                None => [last.p0, last.p0, last.p1, last.p1],
            };
            let start_tangent = cubic_tangent(&start_cubic, 0.0);
            let end_tangent = cubic_tangent(&end_cubic, 1.0);
            ends.push(StrokeEnd {
                point: first.p0,
                direction: v(-start_tangent.x, -start_tangent.y),
                position: EndPosition::Start,
                subpath: index,
                marker: start_marker,
            });
            ends.push(StrokeEnd {
                point: last.p1,
                direction: end_tangent,
                position: EndPosition::End,
                subpath: index,
                marker: end_marker,
            });
        }
    }
    ends
}

/// Marker proportions (`MARKER_SIZE`).
pub mod marker_size {
    pub fn arrow_length(weight: f64) -> f64 {
        weight * 3.0 + 2.0
    }
    pub fn arrow_half_width(weight: f64) -> f64 {
        (weight * 3.0 + 2.0) / 3.0f64.sqrt()
    }
    pub fn dot_radius(weight: f64) -> f64 {
        (weight * 3.0 + 2.0) * 0.4
    }
    pub fn diamond_radius(weight: f64) -> f64 {
        (weight * 3.0 + 2.0) * 0.55
    }
    pub fn chevron_arm(weight: f64) -> f64 {
        (weight * 3.0 + 2.0) * 0.75
    }
}

/// The marker at a stroke end: `fill` drawn as a fill, `stroke` stroked, `trim` how far the line stops short.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MarkerGeometry {
    pub fill: Vec<PathCommand>,
    pub stroke: Vec<PathCommand>,
    pub trim: f64,
}

pub fn marker_geometry(
    marker: StrokeMarker,
    point: Vec2,
    direction: Vec2,
    weight: f64,
) -> MarkerGeometry {
    let w = js::max(0.0, finite(Some(weight), 0.0));
    let (p, d) = (point, direction);
    let n = v(-d.y, d.x);
    let at = |forward: f64, across: f64| {
        v(
            p.x + d.x * forward + n.x * across,
            p.y + d.y * forward + n.y * across,
        )
    };
    let polygon = |points: &[Vec2]| {
        let mut out: Vec<PathCommand> = points
            .iter()
            .enumerate()
            .map(|(k, q)| {
                if k > 0 {
                    PathCommand::L(*q)
                } else {
                    PathCommand::M(*q)
                }
            })
            .collect();
        out.push(PathCommand::Z);
        out
    };
    let length = marker_size::arrow_length(w);
    let half_width = marker_size::arrow_half_width(w);
    let fill = |fill: Vec<PathCommand>, trim: f64| MarkerGeometry {
        fill,
        stroke: Vec::new(),
        trim,
    };
    match marker {
        StrokeMarker::LineArrow => {
            let arm = marker_size::chevron_arm(w);
            let a = at(-arm, arm);
            let b = at(-arm, -arm);
            MarkerGeometry {
                fill: Vec::new(),
                stroke: vec![PathCommand::M(a), PathCommand::L(p), PathCommand::L(b)],
                trim: 0.0,
            }
        }
        StrokeMarker::TriangleArrow => fill(
            polygon(&[
                at(0.0, 0.0),
                at(-length, half_width),
                at(-length, -half_width),
            ]),
            js::min(length * 0.6, w * 1.5),
        ),
        StrokeMarker::ReversedTriangle => fill(
            polygon(&[at(-length, 0.0), at(0.0, -half_width), at(0.0, half_width)]),
            0.0,
        ),
        StrokeMarker::Circle => {
            let r = marker_size::dot_radius(w);
            let mut commands = vec![PathCommand::M(v(p.x + r, p.y))];
            commands.extend(
                ellipse_arc_cubics(p, r, r, 0.0, 0.0, FULL_TURN)
                    .iter()
                    .map(cubic_command),
            );
            commands.push(PathCommand::Z);
            fill(commands, 0.0)
        }
        StrokeMarker::Diamond => {
            let r = marker_size::diamond_radius(w);
            fill(
                polygon(&[at(r, 0.0), at(0.0, r), at(-r, 0.0), at(0.0, -r)]),
                0.0,
            )
        }
        StrokeMarker::Round => {
            let r = w / 2.0;
            if r == 0.0 {
                return MarkerGeometry::default();
            }
            let start_angle = js::atan2(n.y, n.x);
            let mut commands = vec![PathCommand::M(v(p.x + n.x * r, p.y + n.y * r))];
            commands.extend(
                ellipse_arc_cubics(p, r, r, 0.0, start_angle, -PI)
                    .iter()
                    .map(cubic_command),
            );
            commands.push(PathCommand::Z);
            fill(commands, 0.0)
        }
        StrokeMarker::Square => {
            if w == 0.0 {
                return MarkerGeometry::default();
            }
            fill(
                polygon(&[
                    at(0.0, w / 2.0),
                    at(w / 2.0, w / 2.0),
                    at(w / 2.0, -w / 2.0),
                    at(0.0, -w / 2.0),
                ]),
                0.0,
            )
        }
        StrokeMarker::None => MarkerGeometry::default(),
    }
}
