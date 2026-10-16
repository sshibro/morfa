//! `shared/design/stroke-profile.ts`: the filled pieces of a variable width stroke ("Width profile"), which lane
//! L1's outline stroke leaves out (`variableWidthOutline`, `widthPointsOf`, `widthAt`, `maxWidthFactor`).

use morfa_geometry::bounds::has_variable_width;
use morfa_geometry::js;
use morfa_geometry::paths::{flatten_path, subpaths};
use morfa_geometry::shapes::node_geometry;
use morfa_model::{
    PathCommand, SceneNode, StrokeCap, StrokeWidthProfile, VariableWidthStrokeProperties, Vec2,
    VectorPath, WindingRule,
};

#[derive(Clone, Copy)]
struct Point {
    position: f64,
    width: f64,
}

fn profile_points(profile: StrokeWidthProfile) -> &'static [(f64, f64)] {
    match profile {
        StrokeWidthProfile::Wedge => &[(0.0, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Taper => &[(0.0, 1.0), (1.0, 0.25)],
        StrokeWidthProfile::QuarterTaper => &[(0.0, 1.0), (0.75, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Eye => &[(0.0, 0.0), (0.5, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::MirroredTaper => &[(0.0, 0.0), (0.25, 1.0), (0.75, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Uniform | StrokeWidthProfile::Custom => &[],
    }
}

fn width_points_of(properties: Option<&VariableWidthStrokeProperties>) -> Option<Vec<Point>> {
    let properties = properties?;
    if properties.width_profile == StrokeWidthProfile::Uniform {
        return None;
    }
    let raw: Vec<(f64, f64)> = if properties.width_profile == StrokeWidthProfile::Custom {
        properties
            .variable_width_points
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|p| (p.position, p.width))
            .collect()
    } else {
        profile_points(properties.width_profile).to_vec()
    };
    let mut points: Vec<Point> = raw
        .into_iter()
        .filter(|(p, w)| p.is_finite() && w.is_finite())
        .map(|(p, w)| Point {
            position: js::max(0.0, js::min(1.0, p)),
            width: js::max(0.0, w),
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

/// `maxWidthFactor`.
pub fn max_width_factor(properties: Option<&VariableWidthStrokeProperties>) -> f64 {
    match width_points_of(properties) {
        Some(points) => points.iter().fold(0.0, |m, p| js::max(m, p.width)),
        None => 1.0,
    }
}

fn tangent_at(points: &[Point], i: usize) -> f64 {
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
    let (before, after) = (slope(i - 1), slope(i));
    if before * after <= 0.0 {
        return 0.0;
    }
    let w1 = 2.0 * span(i) + span(i - 1);
    let w2 = span(i) + 2.0 * span(i - 1);
    (w1 + w2) / (w1 / before + w2 / after)
}

fn width_at(points: &[Point], t: f64) -> f64 {
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
    let (a, b) = (points[i], points[i + 1]);
    let h = b.position - a.position;
    if !(h > 0.0) {
        return b.width;
    }
    let (m0, m1) = (tangent_at(points, i), tangent_at(points, i + 1));
    let s = (t - a.position) / h;
    let s2 = s * s;
    let s3 = s2 * s;
    js::max(
        0.0,
        (2.0 * s3 - 3.0 * s2 + 1.0) * a.width
            + (s3 - 2.0 * s2 + s) * h * m0
            + (-2.0 * s3 + 3.0 * s2) * b.width
            + (s3 - s2) * h * m1,
    )
}

fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

fn ring(points: &[Vec2], out: &mut Vec<PathCommand>) {
    let mut area = 0.0;
    for i in 0..points.len() {
        let (a, b) = (points[i], points[(i + 1) % points.len()]);
        area += a.x * b.y - b.x * a.y;
    }
    let ordered: Vec<Vec2> = if area < 0.0 {
        points.iter().rev().copied().collect()
    } else {
        points.to_vec()
    };
    out.push(PathCommand::M(ordered[0]));
    for p in &ordered[1..] {
        out.push(PathCommand::L(*p));
    }
    out.push(PathCommand::Z);
}

const ARC_STEP: f64 = std::f64::consts::PI / 16.0;

fn arc(c: Vec2, r: f64, from: f64, to: f64) -> Vec<Vec2> {
    use std::f64::consts::PI;
    let mut sweep = to - from;
    while sweep > PI {
        sweep -= 2.0 * PI;
    }
    while sweep < -PI {
        sweep += 2.0 * PI;
    }
    let steps = js::max(1.0, (sweep.abs() / ARC_STEP).ceil()) as usize;
    (0..=steps)
        .map(|k| {
            let a = from + (sweep * k as f64) / steps as f64;
            v(c.x + js::cos(a) * r, c.y + js::sin(a) * r)
        })
        .collect()
}

/// `variableWidthOutline(node)`.
pub fn variable_width_outline(node: &SceneNode) -> Vec<VectorPath> {
    let mut commands = Vec::new();
    let points = if has_variable_width(node) {
        width_points_of(node.variable_width_stroke_properties.as_ref())
    } else {
        None
    };
    if let Some(points) = points {
        for path in node_geometry(node) {
            for part in subpaths(&path.commands) {
                stroke_part(part, &points, node, &mut commands);
            }
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

fn stroke_part(
    part: &[PathCommand],
    profile: &[Point],
    node: &SceneNode,
    out: &mut Vec<PathCommand>,
) {
    use std::f64::consts::PI;
    let weight = node.stroke_weight;
    let hw = (weight * profile.iter().fold(0.0, |m, p| js::max(m, p.width))) / 2.0;
    let tolerance = js::min(0.05, js::max(0.004, weight * 0.005));
    let max_angle = js::min(
        0.35,
        js::max(
            0.03,
            2.0 * js::acos(js::max(-1.0, 1.0 - tolerance / js::max(hw, tolerance))),
        ),
    );
    let Some(line) = flatten_path(part, tolerance, max_angle, None)
        .into_iter()
        .next()
    else {
        return;
    };
    if line.points.len() < 2 {
        return;
    }
    let pts = line.points;
    let mut lengths = vec![0.0];
    for i in 1..pts.len() {
        lengths.push(lengths[i - 1] + js::hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    let total = lengths[lengths.len() - 1];
    if !(total > 0.0) {
        return;
    }
    let half: Vec<f64> = lengths
        .iter()
        .map(|s| (weight * width_at(profile, s / total)) / 2.0)
        .collect();
    let mut dirs = Vec::new();
    for i in 0..pts.len() - 1 {
        let (dx, dy) = (pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        let d = js::hypot(dx, dy);
        let d = if d == 0.0 || d.is_nan() { 1.0 } else { d };
        dirs.push(v(dx / d, dy / d));
    }
    let normal = |d: Vec2| v(-d.y, d.x);
    for i in 0..dirs.len() {
        let (a, b, n, ha, hb) = (pts[i], pts[i + 1], normal(dirs[i]), half[i], half[i + 1]);
        if ha <= 0.0 && hb <= 0.0 {
            continue;
        }
        let quad = [
            v(a.x + n.x * ha, a.y + n.y * ha),
            v(b.x + n.x * hb, b.y + n.y * hb),
            v(b.x - n.x * hb, b.y - n.y * hb),
            v(a.x - n.x * ha, a.y - n.y * ha),
        ];
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
        let (before, after) = (dirs[i - 1], dirs[i]);
        if h <= 0.0
            || ((before.x * after.y - before.y * after.x).abs() < 1e-6
                && before.x * after.x + before.y * after.y > 0.0)
        {
            continue;
        }
        let (nb, na) = (normal(before), normal(after));
        let side = if (na.x - nb.x) * before.x + (na.y - nb.y) * before.y > 0.0 {
            1.0
        } else {
            -1.0
        };
        let from = js::atan2(side * nb.y, side * nb.x);
        let to = js::atan2(side * na.y, side * na.x);
        let mut pts_ring = vec![pts[i]];
        pts_ring.extend(arc(pts[i], h, from, to));
        ring(&pts_ring, out);
    }
    let cap = node.stroke_cap;
    let last_dir = dirs[dirs.len() - 1];
    let ends = [
        (pts[0], v(-dirs[0].x, -dirs[0].y), half[0]),
        (pts[pts.len() - 1], last_dir, half[half.len() - 1]),
    ];
    for (p, outward, h) in ends {
        if h <= 0.0 || cap == StrokeCap::None {
            continue;
        }
        let n = normal(outward);
        if cap == StrokeCap::Round {
            let from = js::atan2(n.y, n.x);
            let mut r = vec![p];
            r.extend(arc(p, h, from, from - PI / 2.0));
            r.extend(arc(p, h, from - PI / 2.0, from - PI).into_iter().skip(1));
            ring(&r, out);
        } else {
            let e = v(outward.x * h, outward.y * h);
            ring(
                &[
                    v(p.x + n.x * h, p.y + n.y * h),
                    v(p.x + n.x * h + e.x, p.y + n.y * h + e.y),
                    v(p.x - n.x * h + e.x, p.y - n.y * h + e.y),
                    v(p.x - n.x * h, p.y - n.y * h),
                ],
                out,
            );
        }
    }
}
