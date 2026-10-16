//! Node outlines and stroke geometry: the constructions of `shared/design/shapes.ts`,
//! `src/design/engine/render/stroke-math.ts` and `shared/design/stroke-profile.ts`, so the renderer draws the
//! geometry `painter.ts` draws (spread paths, per-side stroke bands, markers, variable width strokes), not a
//! bounding-box approximation. Local units; `kurbo::BezPath` out.

use kurbo::{
    Affine, BezPath, CubicBez, ParamCurve, ParamCurveDeriv, PathEl, Point, Rect, Shape, Vec2,
};
use morfa_model::store::{Node, PathCommand, VectorPath};
use morfa_model::{
    ArcData, NodeType, StrokeAlign, StrokeCap, StrokeMarker, StrokeWidthProfile,
    VariableWidthPoint, WindingRule,
};
use peniko::Fill;
use std::f64::consts::PI;

const KAPPA: f64 = 0.552_284_749_830_793_6;
const FULL_TURN: f64 = 2.0 * PI;

fn finite(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}

pub type CornerRadii = [f64; 4];

/// The radii a rectangle-like node asks for (`cornerRadiiOf`).
pub fn corner_radii_of(node: &Node) -> CornerRadii {
    if let Some(Some(r)) = node.props.rectangle_corner_radii() {
        return [
            finite(r[0], 0.0).max(0.0),
            finite(r[1], 0.0).max(0.0),
            finite(r[2], 0.0).max(0.0),
            finite(r[3], 0.0).max(0.0),
        ];
    }
    let single = finite(node.props.corner_radius().copied().unwrap_or(0.0), 0.0).max(0.0);
    [single; 4]
}

/// The radii as the Canvas painter reads them (`cornerRadii` of geometry-cache.ts: no clamping).
pub fn painter_corner_radii(node: &Node) -> CornerRadii {
    if let Some(Some(r)) = node.props.rectangle_corner_radii() {
        return **r;
    }
    let single = node.props.corner_radius().copied().unwrap_or(0.0);
    [single; 4]
}

const NEIGHBOURS: [[usize; 2]; 4] = [[1, 3], [0, 2], [3, 1], [2, 0]];

/// Figma's sharing of the sides between corners (`resolveCornerRadii`).
pub fn resolve_corner_radii(width: f64, height: f64, radii: CornerRadii) -> [(f64, f64); 4] {
    let w = width.max(0.0);
    let h = height.max(0.0);
    let mut radius = radii.map(|r| finite(r, 0.0).max(0.0));
    let mut budget = [-1.0f64; 4];
    let mut order = [0usize, 1, 2, 3];
    order.sort_by(|&a, &b| {
        radius[b]
            .partial_cmp(&radius[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
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
            room = room.min(share);
        }
        budget[corner] = room.max(0.0);
        radius[corner] = r.min(budget[corner]);
    }
    [
        (radius[0], budget[0]),
        (radius[1], budget[1]),
        (radius[2], budget[2]),
        (radius[3], budget[3]),
    ]
}

struct SmoothParams {
    smoothing: f64,
    p: f64,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    arc_measure: f64,
}

fn smooth_corner_params(radius: f64, smoothing: f64, budget: f64) -> SmoothParams {
    let s = smoothing.min(budget / radius - 1.0).clamp(0.0, 1.0);
    let p = ((1.0 + s) * radius).min(budget);
    let arc_measure = (PI / 2.0) * (1.0 - s);
    let arc_section = (arc_measure / 2.0).sin() * radius * std::f64::consts::SQRT_2;
    let angle_alpha = (PI / 2.0 - arc_measure) / 2.0;
    let p3_to_p4 = radius * (angle_alpha / 2.0).tan();
    let angle_beta = (PI / 4.0) * s;
    let c = p3_to_p4 * angle_beta.cos();
    let d = c * angle_beta.tan();
    let b = (p - arc_section - c - d) / 3.0;
    let a = 2.0 * b;
    SmoothParams {
        smoothing: s,
        p,
        a,
        b,
        c,
        d,
        arc_measure,
    }
}

/// An elliptical arc as cubics of at most a quarter turn each (`ellipseArcCubics`).
pub fn ellipse_arc_cubics(
    center: Point,
    rx: f64,
    ry: f64,
    rotation: f64,
    start: f64,
    sweep: f64,
) -> Vec<[Point; 4]> {
    if sweep == 0.0 || !sweep.is_finite() {
        return Vec::new();
    }
    let count = ((sweep.abs() / (PI / 2.0) - 1e-9).ceil()).max(1.0) as usize;
    let step = sweep / count as f64;
    let k = (4.0 / 3.0) * (step / 4.0).tan();
    let (sin, cos) = rotation.sin_cos();
    let map = |u: f64, v: f64| {
        Point::new(
            center.x + rx * u * cos - ry * v * sin,
            center.y + rx * u * sin + ry * v * cos,
        )
    };
    let mut out = Vec::with_capacity(count);
    for s in 0..count {
        let a = start + s as f64 * step;
        let b = a + step;
        let (sa, ca) = a.sin_cos();
        let (sb, cb) = b.sin_cos();
        out.push([
            map(ca, sa),
            map(ca - k * sa, sa + k * ca),
            map(cb + k * sb, sb - k * cb),
            map(cb, sb),
        ]);
    }
    out
}

fn push_cubic(path: &mut BezPath, c: &[Point; 4]) {
    path.curve_to(c[1], c[2], c[3]);
}

/// A rectangle outline with per-corner radii and corner smoothing (`rectanglePath`).
pub fn rectangle_path(width: f64, height: f64, radii: CornerRadii, smoothing: f64) -> BezPath {
    let w = finite(width, 0.0).max(0.0);
    let h = finite(height, 0.0).max(0.0);
    let corners = resolve_corner_radii(w, h, radii);
    let smoothing = finite(smoothing, 0.0).clamp(0.0, 1.0);
    // Each corner: its vertex, the direction travelled into it and the direction out of it.
    let frames: [(Point, Vec2, Vec2); 4] = [
        (
            Point::new(0.0, 0.0),
            Vec2::new(0.0, -1.0),
            Vec2::new(1.0, 0.0),
        ),
        (Point::new(w, 0.0), Vec2::new(1.0, 0.0), Vec2::new(0.0, 1.0)),
        (Point::new(w, h), Vec2::new(0.0, 1.0), Vec2::new(-1.0, 0.0)),
        (
            Point::new(0.0, h),
            Vec2::new(-1.0, 0.0),
            Vec2::new(0.0, -1.0),
        ),
    ];
    let at = |k: usize, back: f64, along: f64| -> Point {
        let (v, u, o) = frames[k];
        Point::new(
            v.x - u.x * back + o.x * along,
            v.y - u.y * back + o.y * along,
        )
    };
    let params: Vec<Option<SmoothParams>> = corners
        .iter()
        .map(|&(radius, budget)| {
            if radius > 0.0 {
                Some(smooth_corner_params(radius, smoothing, budget))
            } else {
                None
            }
        })
        .collect();
    let reach0 = params[0].as_ref().map(|p| p.p).unwrap_or(0.0);
    let start = at(0, 0.0, reach0);
    let mut out = BezPath::new();
    out.move_to(start);
    let mut current = start;
    let line_to = |out: &mut BezPath, current: &mut Point, p: Point| {
        if (p.x - current.x).abs() > 1e-9 || (p.y - current.y).abs() > 1e-9 {
            out.line_to(p);
        }
        *current = p;
    };
    for k in [1usize, 2, 3, 0] {
        let Some(param) = &params[k] else {
            if k != 0 {
                line_to(&mut out, &mut current, frames[k].0);
            }
            continue;
        };
        let r = corners[k].0;
        line_to(&mut out, &mut current, at(k, param.p, 0.0));
        if param.smoothing <= 1e-9 {
            let end = at(k, 0.0, r);
            out.curve_to(
                at(k, r * (1.0 - KAPPA), 0.0),
                at(k, 0.0, r * (1.0 - KAPPA)),
                end,
            );
            current = end;
            let _ = current;
            continue;
        }
        let SmoothParams {
            p,
            a,
            b,
            c,
            d,
            arc_measure,
            ..
        } = *param;
        out.curve_to(
            at(k, p - a, 0.0),
            at(k, p - a - b, 0.0),
            at(k, p - a - b - c, d),
        );
        if arc_measure > 1e-9 {
            let center = at(k, r, r);
            let from = at(k, p - a - b - c, d);
            let start_angle = (from.y - center.y).atan2(from.x - center.x);
            for piece in ellipse_arc_cubics(center, r, r, 0.0, start_angle, arc_measure) {
                push_cubic(&mut out, &piece);
            }
        }
        let end = at(k, 0.0, p);
        out.curve_to(at(k, 0.0, p - a - b), at(k, 0.0, p - a), end);
        current = end;
    }
    // The last corner ends where the path started: Z closes without a line.
    if let Some(PathEl::LineTo(last)) = out.elements().last().copied() {
        if (last.x - start.x).abs() < 1e-9 && (last.y - start.y).abs() < 1e-9 {
            out.pop();
        }
    }
    out.close_path();
    out
}

/// An ellipse filling the box, or its arc (`ellipsePaths`): a pie slice, a ring (even-odd) or a donut slice.
pub fn ellipse_paths(width: f64, height: f64, arc: Option<&ArcData>) -> Vec<(BezPath, Fill)> {
    let rx = finite(width, 0.0).max(0.0) / 2.0;
    let ry = finite(height, 0.0).max(0.0) / 2.0;
    let center = Point::new(rx, ry);
    let start = finite(arc.map(|a| a.starting_angle).unwrap_or(0.0), 0.0);
    let sweep = finite(arc.map(|a| a.ending_angle).unwrap_or(FULL_TURN), FULL_TURN) - start;
    let inner = finite(arc.map(|a| a.inner_radius).unwrap_or(0.0), 0.0).clamp(0.0, 1.0);
    let full = sweep.abs() >= FULL_TURN - 1e-6 || sweep.abs() < 1e-9;
    let point_at = |sx: f64, sy: f64, angle: f64| {
        Point::new(center.x + sx * angle.cos(), center.y + sy * angle.sin())
    };
    let arc_into = |path: &mut BezPath, sx: f64, sy: f64, from: f64, by: f64| {
        for piece in ellipse_arc_cubics(center, sx, sy, 0.0, from, by) {
            push_cubic(path, &piece);
        }
    };
    // A whole turn must end exactly where it began.
    let loop_path = |path: &mut BezPath, sx: f64, sy: f64, by: f64| {
        path.move_to(Point::new(center.x + sx, center.y));
        let pieces = ellipse_arc_cubics(center, sx, sy, 0.0, 0.0, by);
        let n = pieces.len();
        for (i, piece) in pieces.iter().enumerate() {
            let end = if i + 1 == n {
                Point::new(center.x + sx, center.y)
            } else {
                piece[3]
            };
            path.curve_to(piece[1], piece[2], end);
        }
        path.close_path();
    };
    if full {
        let mut outer = BezPath::new();
        loop_path(&mut outer, rx, ry, FULL_TURN);
        if inner <= 0.0 {
            return vec![(outer, Fill::NonZero)];
        }
        loop_path(&mut outer, rx * inner, ry * inner, -FULL_TURN);
        return vec![(outer, Fill::EvenOdd)];
    }
    let begin = point_at(rx, ry, start);
    let mut path = BezPath::new();
    if inner <= 0.0 {
        path.move_to(center);
        path.line_to(begin);
        arc_into(&mut path, rx, ry, start, sweep);
        path.close_path();
        return vec![(path, Fill::NonZero)];
    }
    let ix = rx * inner;
    let iy = ry * inner;
    let inner_end = point_at(ix, iy, start + sweep);
    path.move_to(begin);
    arc_into(&mut path, rx, ry, start, sweep);
    path.line_to(inner_end);
    arc_into(&mut path, ix, iy, start + sweep, -sweep);
    path.close_path();
    vec![(path, Fill::NonZero)]
}

/// Vertices of a regular polygon or star inscribed in the box's ellipse (`polygonVertices`).
pub fn polygon_vertices(
    width: f64,
    height: f64,
    point_count: f64,
    inner: Option<f64>,
) -> Vec<Point> {
    let count = finite(point_count, 3.0).round().clamp(3.0, 1000.0) as usize;
    let total = if inner.is_some() { count * 2 } else { count };
    let rx = finite(width, 0.0).max(0.0) / 2.0;
    let ry = finite(height, 0.0).max(0.0) / 2.0;
    (0..total)
        .map(|k| {
            let angle = -PI / 2.0 + (k as f64 * 2.0 * PI) / total as f64;
            let s = match inner {
                Some(inner) if k % 2 == 1 => inner.clamp(0.0, 1.0),
                _ => 1.0,
            };
            Point::new(rx + angle.cos() * rx * s, ry + angle.sin() * ry * s)
        })
        .collect()
}

/// A closed polygon with every vertex rounded by `radius` (`roundedPolygonPath`).
pub fn rounded_polygon_path(points: &[Point], radius: f64) -> BezPath {
    let n = points.len();
    let mut out = BezPath::new();
    if n < 2 {
        if n == 1 {
            out.move_to(points[0]);
            out.close_path();
        }
        return out;
    }
    let r = finite(radius, 0.0).max(0.0);
    let push = |out: &mut BezPath, p: Point, first: bool| {
        if first {
            out.move_to(p)
        } else {
            out.line_to(p)
        }
    };
    for k in 0..n {
        let prev = points[(k + n - 1) % n];
        let v = points[k];
        let next = points[(k + 1) % n];
        let in_length = (v - prev).hypot();
        let out_length = (next - v).hypot();
        if r == 0.0 || in_length < 1e-9 || out_length < 1e-9 {
            push(&mut out, v, k == 0);
            continue;
        }
        let din = (v - prev) / in_length;
        let dout = (next - v) / out_length;
        let turn = (din.x * dout.y - din.y * dout.x).atan2(din.x * dout.x + din.y * dout.y);
        let abs_turn = turn.abs();
        if abs_turn < 1e-6 || abs_turn > PI - 1e-6 {
            push(&mut out, v, k == 0);
            continue;
        }
        let half = (abs_turn / 2.0).tan();
        let tangent = (r * half).min(in_length / 2.0).min(out_length / 2.0);
        let effective = tangent / half;
        let a = v - din * tangent;
        let side = if turn > 0.0 { 1.0 } else { -1.0 };
        let center = Point::new(
            a.x - din.y * effective * side,
            a.y + din.x * effective * side,
        );
        push(&mut out, a, k == 0);
        let start_angle = (a.y - center.y).atan2(a.x - center.x);
        for piece in ellipse_arc_cubics(center, effective, effective, 0.0, start_angle, turn) {
            push_cubic(&mut out, &piece);
        }
    }
    out.close_path();
    out
}

fn commands_to_path(commands: &[PathCommand]) -> BezPath {
    let mut path = BezPath::new();
    let mut open = false;
    for c in commands {
        match c {
            PathCommand::M(p) => {
                path.move_to(Point::new(p.x, p.y));
                open = true;
            }
            PathCommand::L(p) => {
                if open {
                    path.line_to(Point::new(p.x, p.y));
                }
            }
            PathCommand::C(c) => {
                if open {
                    path.curve_to(
                        Point::new(c.x1, c.y1),
                        Point::new(c.x2, c.y2),
                        Point::new(c.x, c.y),
                    );
                }
            }
            PathCommand::Q(q) => {
                if open {
                    path.quad_to(Point::new(q.x1, q.y1), Point::new(q.x, q.y));
                }
            }
            PathCommand::Z => {
                if open {
                    path.close_path();
                }
            }
        }
    }
    path
}

fn rule_of(rule: WindingRule) -> Fill {
    match rule {
        WindingRule::Nonzero => Fill::NonZero,
        WindingRule::Evenodd => Fill::EvenOdd,
    }
}

/// The node's fill outline (`nodeGeometry`): empty for nodes without one (pages, groups, booleans, text, slices).
pub fn node_geometry(node: &Node) -> Vec<(BezPath, Fill)> {
    let w = finite(node.width, 0.0).max(0.0);
    let h = finite(node.height, 0.0).max(0.0);
    match node.kind {
        NodeType::Rectangle
        | NodeType::Frame
        | NodeType::Component
        | NodeType::ComponentSet
        | NodeType::Instance
        | NodeType::Section => {
            let smoothing = node.props.corner_smoothing().copied().unwrap_or(0.0);
            vec![(
                rectangle_path(w, h, corner_radii_of(node), smoothing),
                Fill::NonZero,
            )]
        }
        NodeType::Ellipse => ellipse_paths(w, h, node.props.arc_data().map(|a| a.as_ref())),
        NodeType::Polygon => {
            let count = node.props.point_count().copied().unwrap_or(3.0);
            let radius = node.props.corner_radius().copied().unwrap_or(0.0);
            vec![(
                rounded_polygon_path(&polygon_vertices(w, h, count, None), radius),
                Fill::NonZero,
            )]
        }
        NodeType::Star => {
            let count = node.props.point_count().copied().unwrap_or(5.0);
            let inner = node.props.inner_radius().copied().unwrap_or(0.382);
            let radius = node.props.corner_radius().copied().unwrap_or(0.0);
            vec![(
                rounded_polygon_path(&polygon_vertices(w, h, count, Some(inner)), radius),
                Fill::NonZero,
            )]
        }
        NodeType::Line => {
            let mut path = BezPath::new();
            path.move_to(Point::new(0.0, 0.0));
            path.line_to(Point::new(w, 0.0));
            vec![(path, Fill::NonZero)]
        }
        NodeType::Vector => node
            .props
            .vector_paths()
            .map(|paths| vector_paths_to_parts(paths.as_slice()))
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

pub fn vector_paths_to_parts(paths: &[VectorPath]) -> Vec<(BezPath, Fill)> {
    paths
        .iter()
        .map(|p| {
            (
                commands_to_path(p.commands.as_slice()),
                rule_of(p.winding_rule),
            )
        })
        .collect()
}

/// True for a LINE, or a VECTOR with an open subpath (`hasOpenPath`).
pub fn has_open_path(node: &Node) -> bool {
    match node.kind {
        NodeType::Line => true,
        NodeType::Vector => node.props.vector_paths().is_some_and(|paths| {
            paths.as_slice().iter().any(|path| {
                let mut open = false;
                for c in path.commands.as_slice() {
                    match c {
                        PathCommand::M(_) => {
                            if open {
                                return true;
                            }
                            open = true;
                        }
                        PathCommand::Z => open = false,
                        _ => {}
                    }
                }
                open
            })
        }),
        _ => false,
    }
}

/// What geometry-cache.ts knows about an outline besides its paths.
pub struct NodeShape {
    /// One path per winding rule (almost always exactly one): grouped like `build` groups them.
    pub parts: Vec<(BezPath, Fill)>,
    pub open: bool,
    /// "Everything but the shape" can be clipped with an even-odd frame around it.
    pub invertible: bool,
    /// Rectangle-like outline with these radii (the painter's unclamped radii), for exact spread.
    pub rect: Option<CornerRadii>,
    pub ellipse: bool,
}

const RECT_TYPES: [NodeType; 6] = [
    NodeType::Rectangle,
    NodeType::Frame,
    NodeType::Component,
    NodeType::ComponentSet,
    NodeType::Instance,
    NodeType::Section,
];

fn is_full_ellipse(node: &Node) -> bool {
    match node.props.arc_data() {
        None => true,
        Some(arc) => {
            arc.inner_radius == 0.0
                && ((arc.ending_angle - arc.starting_angle).abs() - FULL_TURN).abs() < 1e-6
        }
    }
}

fn group_parts(paths: Vec<(BezPath, Fill)>) -> (Vec<(BezPath, Fill)>, usize) {
    let mut subpaths = 0;
    let mut nonzero = BezPath::new();
    let mut evenodd = BezPath::new();
    let mut order: Vec<Fill> = Vec::new();
    for (path, rule) in paths {
        subpaths += path
            .elements()
            .iter()
            .filter(|e| matches!(e, PathEl::MoveTo(_)))
            .count();
        let target = if rule == Fill::EvenOdd {
            &mut evenodd
        } else {
            &mut nonzero
        };
        if target.elements().is_empty() {
            order.push(rule);
        }
        target.extend(path);
    }
    let mut parts = Vec::new();
    for rule in order {
        let path = if rule == Fill::EvenOdd {
            std::mem::take(&mut evenodd)
        } else {
            std::mem::take(&mut nonzero)
        };
        parts.push((path, rule));
    }
    (parts, subpaths)
}

/// `shapeOf`: the node's outline with its facts, or None for nodes without one.
pub fn shape_of(node: &Node) -> Option<NodeShape> {
    let paths = node_geometry(node);
    if paths.is_empty() {
        return None;
    }
    Some(shape_of_paths(paths, node))
}

/// `shapeOfPaths`: a shape from paths computed elsewhere (boolean results).
pub fn shape_of_paths(paths: Vec<(BezPath, Fill)>, node: &Node) -> NodeShape {
    let (parts, subpaths) = group_parts(paths);
    let simple = RECT_TYPES.contains(&node.kind)
        || matches!(
            node.kind,
            NodeType::Ellipse | NodeType::Polygon | NodeType::Star
        );
    let smoothing = node.props.corner_smoothing().copied().unwrap_or(0.0);
    NodeShape {
        invertible: (parts.len() == 1 && parts[0].1 == Fill::EvenOdd) || (simple && subpaths <= 1),
        rect: if RECT_TYPES.contains(&node.kind) && smoothing == 0.0 {
            Some(painter_corner_radii(node))
        } else {
            None
        },
        ellipse: node.kind == NodeType::Ellipse && is_full_ellipse(node),
        open: has_open_path(node),
        parts,
    }
}

/// Rounded rectangle outline with per-corner radii, clamped so neighbours never overlap (`roundedRectCommands`).
pub fn rounded_rect_path(rect: Rect, radii: CornerRadii) -> BezPath {
    let (x, y, w, h) = (rect.x0, rect.y0, rect.width(), rect.height());
    let mut scale = 1.0f64;
    for (p, q, side) in [(0usize, 1usize, w), (1, 2, h), (2, 3, w), (3, 0, h)] {
        let sum = radii[p] + radii[q];
        if sum > side && sum > 0.0 {
            scale = scale.min(side / sum);
        }
    }
    let [tl, tr, br, bl] = radii.map(|r| (r * scale).max(0.0));
    let c = |r: f64| r * (1.0 - KAPPA);
    let mut out = BezPath::new();
    out.move_to(Point::new(x + tl, y));
    out.line_to(Point::new(x + w - tr, y));
    if tr > 0.0 {
        out.curve_to(
            Point::new(x + w - c(tr), y),
            Point::new(x + w, y + c(tr)),
            Point::new(x + w, y + tr),
        );
    }
    out.line_to(Point::new(x + w, y + h - br));
    if br > 0.0 {
        out.curve_to(
            Point::new(x + w, y + h - c(br)),
            Point::new(x + w - c(br), y + h),
            Point::new(x + w - br, y + h),
        );
    }
    out.line_to(Point::new(x + bl, y + h));
    if bl > 0.0 {
        out.curve_to(
            Point::new(x + c(bl), y + h),
            Point::new(x, y + h - c(bl)),
            Point::new(x, y + h - bl),
        );
    }
    out.line_to(Point::new(x, y + tl));
    if tl > 0.0 {
        out.curve_to(
            Point::new(x, y + c(tl)),
            Point::new(x + c(tl), y),
            Point::new(x + tl, y),
        );
    }
    out.close_path();
    out
}

/// The outline grown or shrunk by `spread` where that is exact (`spreadPath`): Some(path), or None when the shape
/// has no exact offset (a silhouette is used instead).
pub fn spread_path(node: &Node, shape: &NodeShape, spread: f64) -> Option<BezPath> {
    if spread == 0.0 {
        return if shape.parts.len() == 1 {
            Some(shape.parts[0].0.clone())
        } else {
            None
        };
    }
    let w = node.width + 2.0 * spread;
    let h = node.height + 2.0 * spread;
    if w <= 0.0 || h <= 0.0 {
        return Some(BezPath::new());
    }
    if let Some(rect) = shape.rect {
        let radii = rect.map(|r| if r > 0.0 { (r + spread).max(0.0) } else { 0.0 });
        return Some(rounded_rect_path(
            Rect::new(-spread, -spread, w - spread, h - spread),
            radii,
        ));
    }
    if shape.ellipse {
        let mut path = BezPath::new();
        let center = Point::new(node.width / 2.0, node.height / 2.0);
        path.move_to(Point::new(center.x + w / 2.0, center.y));
        for piece in ellipse_arc_cubics(center, w / 2.0, h / 2.0, 0.0, 0.0, FULL_TURN) {
            push_cubic(&mut path, &piece);
        }
        path.close_path();
        return Some(path);
    }
    None
}

// ── Per-side stroke weights ───────────────────────────────────────────────────────────────────

pub struct RoundedRect {
    pub rect: Rect,
    pub radii: CornerRadii,
}

/// The region between two rounded rectangles (`individualStrokeBand`), filled even-odd.
pub fn individual_stroke_band(
    width: f64,
    height: f64,
    weights: &morfa_model::IndividualStrokeWeights,
    align: StrokeAlign,
    radii: CornerRadii,
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
    let grow = [ot.max(ol), ot.max(or), ob.max(or), ob.max(ol)];
    let shrink = [it.max(il), it.max(ir), ib.max(ir), ib.max(il)];
    let outer = RoundedRect {
        rect: Rect::new(-ol, -ot, width + or, height + ob),
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
        rect: Rect::new(il, it, il + inner_width, it + inner_height),
        radii: [0, 1, 2, 3].map(|k| (radii[k] - shrink[k]).max(0.0)),
    });
    (outer, inner)
}

// ── Markers ───────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub struct PathEnd {
    pub point: Point,
    /// Unit vector pointing out of the path at this end.
    pub direction: Vec2,
}

fn unit(v: Vec2) -> Option<Vec2> {
    let length = v.hypot();
    if length > 1e-9 {
        Some(v / length)
    } else {
        None
    }
}

/// Control points leaving or entering each segment's end, in order.
fn control_points(els: &[PathEl]) -> Vec<Point> {
    let mut out = Vec::new();
    for el in els {
        match el {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => out.push(*p),
            PathEl::QuadTo(p1, p) => out.extend([*p1, *p]),
            PathEl::CurveTo(p1, p2, p) => out.extend([*p1, *p2, *p]),
            PathEl::ClosePath => {}
        }
    }
    out
}

fn subpath_els(path: &BezPath) -> Vec<(Vec<PathEl>, bool)> {
    let mut out: Vec<(Vec<PathEl>, bool)> = Vec::new();
    for el in path.elements() {
        match el {
            PathEl::MoveTo(_) => out.push((vec![*el], false)),
            _ => {
                if let Some(current) = out.last_mut() {
                    current.0.push(*el);
                    if matches!(el, PathEl::ClosePath) {
                        current.1 = true;
                    }
                }
            }
        }
    }
    out
}

/// The free ends of the first and last open subpaths (`pathEnds` of stroke-math.ts).
pub fn path_ends(path: &BezPath) -> Option<(PathEnd, PathEnd)> {
    let subs = subpath_els(path);
    let open: Vec<&(Vec<PathEl>, bool)> = subs.iter().filter(|s| !s.1 && s.0.len() > 1).collect();
    if open.is_empty() {
        return None;
    }
    let first = control_points(&open[0].0);
    let last = control_points(&open[open.len() - 1].0);
    if first.len() < 2 || last.len() < 2 {
        return None;
    }
    let start_point = first[0];
    let end_point = last[last.len() - 1];
    let start_dir = first[1..]
        .iter()
        .find_map(|p| unit(start_point - *p))
        .unwrap_or(Vec2::new(-1.0, 0.0));
    let end_dir = last[..last.len() - 1]
        .iter()
        .rev()
        .find_map(|p| unit(end_point - *p))
        .unwrap_or(Vec2::new(1.0, 0.0));
    Some((
        PathEnd {
            point: start_point,
            direction: start_dir,
        },
        PathEnd {
            point: end_point,
            direction: end_dir,
        },
    ))
}

pub struct MarkerShape {
    pub fill: Option<BezPath>,
    /// Polyline stroked with the path's weight (the open arrow).
    pub stroke: Option<BezPath>,
    pub inset: f64,
}

pub fn marker_size(weight: f64) -> f64 {
    3.0 * weight.max(0.0) + 2.0
}

fn at(end: &PathEnd, along: f64, across: f64) -> Point {
    Point::new(
        end.point.x + end.direction.x * along - end.direction.y * across,
        end.point.y + end.direction.y * along + end.direction.x * across,
    )
}

fn polygon(points: &[Point]) -> BezPath {
    let mut path = BezPath::new();
    for (i, p) in points.iter().enumerate() {
        if i == 0 {
            path.move_to(*p)
        } else {
            path.line_to(*p)
        }
    }
    path.close_path();
    path
}

fn circle(c: Point, r: f64) -> BezPath {
    let mut path = BezPath::new();
    path.move_to(Point::new(c.x + r, c.y));
    path.curve_to(
        Point::new(c.x + r, c.y + r * KAPPA),
        Point::new(c.x + r * KAPPA, c.y + r),
        Point::new(c.x, c.y + r),
    );
    path.curve_to(
        Point::new(c.x - r * KAPPA, c.y + r),
        Point::new(c.x - r, c.y + r * KAPPA),
        Point::new(c.x - r, c.y),
    );
    path.curve_to(
        Point::new(c.x - r, c.y - r * KAPPA),
        Point::new(c.x - r * KAPPA, c.y - r),
        Point::new(c.x, c.y - r),
    );
    path.curve_to(
        Point::new(c.x + r * KAPPA, c.y - r),
        Point::new(c.x + r, c.y - r * KAPPA),
        Point::new(c.x + r, c.y),
    );
    path.close_path();
    path
}

/// The shape drawn at one end of an open path (`markerShape`).
pub fn marker_shape(marker: StrokeMarker, end: &PathEnd, weight: f64) -> Option<MarkerShape> {
    let size = marker_size(weight);
    Some(match marker {
        StrokeMarker::TriangleArrow => {
            let half = size / 3f64.sqrt();
            MarkerShape {
                fill: Some(polygon(&[
                    at(end, 0.0, 0.0),
                    at(end, -size, half),
                    at(end, -size, -half),
                ])),
                stroke: None,
                inset: (size * 0.6).min(weight * 1.5),
            }
        }
        StrokeMarker::ReversedTriangle => {
            let half = size / 3f64.sqrt();
            MarkerShape {
                fill: Some(polygon(&[
                    at(end, -size, 0.0),
                    at(end, 0.0, half),
                    at(end, 0.0, -half),
                ])),
                stroke: None,
                inset: 0.0,
            }
        }
        StrokeMarker::LineArrow => {
            let arm = size * 0.75;
            let mut path = BezPath::new();
            path.move_to(at(end, -arm, arm));
            path.line_to(at(end, 0.0, 0.0));
            path.line_to(at(end, -arm, -arm));
            MarkerShape {
                fill: None,
                stroke: Some(path),
                inset: 0.0,
            }
        }
        StrokeMarker::Circle => MarkerShape {
            fill: Some(circle(end.point, size * 0.4)),
            stroke: None,
            inset: 0.0,
        },
        StrokeMarker::Diamond => {
            let r = size * 0.55;
            MarkerShape {
                fill: Some(polygon(&[
                    at(end, r, 0.0),
                    at(end, 0.0, r),
                    at(end, -r, 0.0),
                    at(end, 0.0, -r),
                ])),
                stroke: None,
                inset: 0.0,
            }
        }
        StrokeMarker::Round => MarkerShape {
            fill: Some(circle(end.point, weight / 2.0)),
            stroke: None,
            inset: 0.0,
        },
        StrokeMarker::Square => {
            let h = weight / 2.0;
            MarkerShape {
                fill: Some(polygon(&[
                    at(end, h, h),
                    at(end, h, -h),
                    at(end, -h, -h),
                    at(end, -h, h),
                ])),
                stroke: None,
                inset: 0.0,
            }
        }
        StrokeMarker::None => return None,
    })
}

/// Moves the free ends of the first/last open subpaths inwards (`shortenPath`).
pub fn shorten_path(path: &BezPath, start_inset: f64, end_inset: f64) -> BezPath {
    if !(start_inset > 0.0) && !(end_inset > 0.0) {
        return path.clone();
    }
    let mut els: Vec<PathEl> = path.elements().to_vec();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut open: Option<usize> = None;
    for (i, el) in els.iter().enumerate() {
        match el {
            PathEl::MoveTo(_) => {
                if let Some(_) = open {
                    ends.push(i - 1);
                }
                open = Some(i);
                starts.push(i);
            }
            PathEl::ClosePath => {
                starts.pop();
                open = None;
            }
            _ => {}
        }
    }
    if open.is_some() {
        ends.push(els.len() - 1);
    } else if starts.len() > ends.len() {
        starts.pop();
    }
    if starts.is_empty() || ends.is_empty() {
        return BezPath::from_vec(els);
    }
    fn end_point(el: &PathEl) -> Option<Point> {
        match el {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => Some(*p),
            PathEl::QuadTo(_, p) | PathEl::CurveTo(_, _, p) => Some(*p),
            PathEl::ClosePath => None,
        }
    }
    let shift = |els: &mut Vec<PathEl>, index: usize, inset: f64, towards: usize| {
        if !(inset > 0.0) || index >= els.len() || towards >= els.len() {
            return;
        }
        let (Some(point), Some(next_end)) = (end_point(&els[index]), end_point(&els[towards]))
        else {
            return;
        };
        let toward = match (&els[towards], &els[index]) {
            (PathEl::CurveTo(p1, _, _), _) if towards > index => *p1,
            (_, PathEl::CurveTo(_, p2, _)) if towards < index => *p2,
            _ => next_end,
        };
        let length = (toward - point).hypot();
        if length < 1e-9 {
            return;
        }
        let s = inset.min(length * 0.9) / length;
        let d = (toward - point) * s;
        match &mut els[index] {
            PathEl::MoveTo(p) | PathEl::LineTo(p) | PathEl::QuadTo(_, p) => *p += d,
            PathEl::CurveTo(_, p2, p) => {
                *p += d;
                if towards < index {
                    *p2 += d;
                }
            }
            PathEl::ClosePath => {}
        }
        if towards > index {
            if let PathEl::CurveTo(p1, _, _) = &mut els[towards] {
                *p1 += d;
            }
        }
    };
    let first = starts[0];
    shift(&mut els, first, start_inset, first + 1);
    let last = ends[ends.len() - 1];
    if last > 0 {
        shift(&mut els, last, end_inset, last - 1);
    }
    BezPath::from_vec(els)
}

// ── Variable width strokes ────────────────────────────────────────────────────────────────────

fn width_profile_points(profile: StrokeWidthProfile) -> &'static [(f64, f64)] {
    match profile {
        StrokeWidthProfile::Uniform => &[(0.0, 1.0), (1.0, 1.0)],
        StrokeWidthProfile::Wedge => &[(0.0, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Taper => &[(0.0, 1.0), (1.0, 0.25)],
        StrokeWidthProfile::QuarterTaper => &[(0.0, 1.0), (0.75, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Eye => &[(0.0, 0.0), (0.5, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::MirroredTaper => &[(0.0, 0.0), (0.25, 1.0), (0.75, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Custom => &[],
    }
}

/// The profile's points, sorted, or None for a plain stroke (`widthPointsOf`).
pub fn width_points_of(node: &Node) -> Option<Vec<VariableWidthPoint>> {
    let props = node.props.variable_width_stroke_properties()?;
    if props.width_profile == StrokeWidthProfile::Uniform {
        return None;
    }
    let raw: Vec<(f64, f64)> = if props.width_profile == StrokeWidthProfile::Custom {
        props
            .variable_width_points
            .as_ref()
            .map(|list| {
                list.as_slice()
                    .iter()
                    .map(|p| (p.position, p.width))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        width_profile_points(props.width_profile).to_vec()
    };
    let mut points: Vec<VariableWidthPoint> = raw
        .into_iter()
        .filter(|(p, w)| p.is_finite() && w.is_finite())
        .map(|(p, w)| VariableWidthPoint {
            position: p.clamp(0.0, 1.0),
            width: w.max(0.0),
        })
        .collect();
    points.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if points.is_empty() || points.iter().all(|p| (p.width - 1.0).abs() < 1e-9) {
        return None;
    }
    Some(points)
}

fn tangent_at(points: &[VariableWidthPoint], i: usize) -> f64 {
    let span = |k: usize| points[k + 1].position - points[k].position;
    let slope = |k: usize| {
        if span(k) > 0.0 {
            (points[k + 1].width - points[k].width) / span(k)
        } else {
            0.0
        }
    };
    let n = points.len();
    if i == 0 {
        return slope(0);
    }
    if i == n - 1 {
        return slope(n - 2);
    }
    let before = slope(i - 1);
    let after = slope(i);
    if before * after <= 0.0 {
        return 0.0;
    }
    let w1 = 2.0 * span(i) + span(i - 1);
    let w2 = span(i) + 2.0 * span(i - 1);
    (w1 + w2) / (w1 / before + w2 / after)
}

pub fn width_at(points: &[VariableWidthPoint], t: f64) -> f64 {
    let n = points.len();
    if n == 0 {
        return 1.0;
    }
    if t <= points[0].position || n == 1 {
        return points[0].width;
    }
    if t >= points[n - 1].position {
        return points[n - 1].width;
    }
    let mut i = 0;
    while i < n - 2 && points[i + 1].position <= t {
        i += 1;
    }
    let a = &points[i];
    let b = &points[i + 1];
    let h = b.position - a.position;
    if !(h > 0.0) {
        return b.width;
    }
    let m0 = tangent_at(points, i);
    let m1 = tangent_at(points, i + 1);
    let s = (t - a.position) / h;
    let s2 = s * s;
    let s3 = s2 * s;
    ((2.0 * s3 - 3.0 * s2 + 1.0) * a.width
        + (s3 - 2.0 * s2 + s) * h * m0
        + (-2.0 * s3 + 3.0 * s2) * b.width
        + (s3 - s2) * h * m1)
        .max(0.0)
}

/// A LINE, or a VECTOR whose every path is open (`takesWidthProfile`).
pub fn takes_width_profile(node: &Node) -> bool {
    match node.kind {
        NodeType::Line => true,
        NodeType::Vector => node.props.vector_paths().is_some_and(|paths| {
            let paths = paths.as_slice();
            !paths.is_empty()
                && paths.iter().all(|path| {
                    let mut last_was_close = true;
                    let mut any = false;
                    let mut closed_all = true;
                    for c in path.commands.as_slice() {
                        match c {
                            PathCommand::M(_) => {
                                if any && !last_was_close {
                                    closed_all = false;
                                }
                                any = true;
                                last_was_close = false;
                            }
                            PathCommand::Z => last_was_close = true,
                            _ => {}
                        }
                    }
                    if any && !last_was_close {
                        closed_all = false;
                    }
                    !closed_all || !any
                })
        }),
        _ => false,
    }
}

pub fn has_variable_width(node: &Node) -> bool {
    node.stroke_weight > 0.0 && width_points_of(node).is_some() && takes_width_profile(node)
}

pub fn max_width_factor(node: &Node) -> f64 {
    width_points_of(node)
        .map(|p| p.iter().map(|q| q.width).fold(0.0, f64::max))
        .unwrap_or(1.0)
}

fn ring(points: &[Point], out: &mut BezPath) {
    let mut area = 0.0;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        area += a.x * b.y - b.x * a.y;
    }
    let ordered: Vec<Point> = if area < 0.0 {
        points.iter().rev().copied().collect()
    } else {
        points.to_vec()
    };
    out.move_to(ordered[0]);
    for p in &ordered[1..] {
        out.line_to(*p);
    }
    out.close_path();
}

const ARC_STEP: f64 = PI / 16.0;

fn arc_points(c: Point, r: f64, from: f64, to: f64) -> Vec<Point> {
    let mut sweep = to - from;
    while sweep > PI {
        sweep -= 2.0 * PI;
    }
    while sweep < -PI {
        sweep += 2.0 * PI;
    }
    let steps = ((sweep.abs() / ARC_STEP).ceil()).max(1.0) as usize;
    (0..=steps)
        .map(|k| {
            let a = from + (sweep * k as f64) / steps as f64;
            Point::new(c.x + a.cos() * r, c.y + a.sin() * r)
        })
        .collect()
}

/// The filled pieces of the node's variable width stroke (`variableWidthOutline`), or None.
pub fn variable_width_outline(node: &Node) -> Option<BezPath> {
    if !has_variable_width(node) {
        return None;
    }
    let points = width_points_of(node)?;
    let mut out = BezPath::new();
    for (path, _) in node_geometry(node) {
        for (sub, _) in subpath_els(&path) {
            stroke_part(BezPath::from_vec(sub), &points, node, &mut out);
        }
    }
    if out.elements().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn stroke_part(part: BezPath, profile: &[VariableWidthPoint], node: &Node, out: &mut BezPath) {
    let weight = node.stroke_weight;
    let hw = (weight * profile.iter().map(|p| p.width).fold(0.0, f64::max)) / 2.0;
    let tolerance = (weight * 0.005).clamp(0.004, 0.05);
    let _ = hw;
    let mut pts: Vec<Point> = Vec::new();
    kurbo::flatten(part.elements().iter().copied(), tolerance, |el| match el {
        PathEl::MoveTo(p) | PathEl::LineTo(p) => pts.push(p),
        _ => {}
    });
    if pts.len() < 2 {
        return;
    }
    let mut lengths = vec![0.0];
    for i in 1..pts.len() {
        lengths.push(lengths[i - 1] + (pts[i] - pts[i - 1]).hypot());
    }
    let total = *lengths.last().unwrap();
    if !(total > 0.0) {
        return;
    }
    let half: Vec<f64> = lengths
        .iter()
        .map(|s| (weight * width_at(profile, s / total)) / 2.0)
        .collect();
    let dirs: Vec<Vec2> = (0..pts.len() - 1)
        .map(|i| {
            let d = pts[i + 1] - pts[i];
            let len = d.hypot();
            if len > 0.0 {
                d / len
            } else {
                Vec2::new(1.0, 0.0)
            }
        })
        .collect();
    let normal = |d: Vec2| Vec2::new(-d.y, d.x);
    for i in 0..dirs.len() {
        let a = pts[i];
        let b = pts[i + 1];
        let n = normal(dirs[i]);
        let ha = half[i];
        let hb = half[i + 1];
        if ha <= 0.0 && hb <= 0.0 {
            continue;
        }
        let quad = [a + n * ha, b + n * hb, b - n * hb, a - n * ha];
        if ha <= 0.0 {
            ring(&[a, quad[1], quad[2]], out);
        } else if hb <= 0.0 {
            ring(&[quad[0], b, quad[3]], out);
        } else {
            ring(&quad, out);
        }
    }
    for i in 1..dirs.len() {
        let h = half[i];
        let before = dirs[i - 1];
        let after = dirs[i];
        if h <= 0.0
            || ((before.x * after.y - before.y * after.x).abs() < 1e-6 && before.dot(after) > 0.0)
        {
            continue;
        }
        let nb = normal(before);
        let na = normal(after);
        let side = if (na - nb).dot(before) > 0.0 {
            1.0
        } else {
            -1.0
        };
        let from = (side * nb.y).atan2(side * nb.x);
        let to = (side * na.y).atan2(side * na.x);
        let mut points = vec![pts[i]];
        points.extend(arc_points(pts[i], h, from, to));
        ring(&points, out);
    }
    let cap = node.stroke_cap;
    let ends: [(Point, Vec2, f64); 2] = [
        (pts[0], -dirs[0], half[0]),
        (
            pts[pts.len() - 1],
            dirs[dirs.len() - 1],
            half[half.len() - 1],
        ),
    ];
    for (p, outward, h) in ends {
        if h <= 0.0 || cap == StrokeCap::None {
            continue;
        }
        let n = normal(outward);
        if cap == StrokeCap::Round {
            let from = n.y.atan2(n.x);
            let mut points = vec![p];
            points.extend(arc_points(p, h, from, from - PI / 2.0));
            points.extend(
                arc_points(p, h, from - PI / 2.0, from - PI)
                    .into_iter()
                    .skip(1),
            );
            ring(&points, out);
        } else {
            let e = outward * h;
            ring(&[p + n * h, p + n * h + e, p - n * h + e, p - n * h], out);
        }
    }
}

/// The unit tangent at the end of a cubic, for the marker code paths that need one.
pub fn cubic_end_tangent(c: CubicBez) -> Vec2 {
    let d = c.deriv().eval(1.0).to_vec2();
    unit(d).unwrap_or(Vec2::new(1.0, 0.0))
}

/// A path's axis-aligned bounds under a transform (control-point bounds suffice for culling).
pub fn transformed_bounds(path: &BezPath, t: Affine) -> Rect {
    (t * path).bounding_box()
}
