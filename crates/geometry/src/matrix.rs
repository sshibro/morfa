//! `shared/design/geometry.ts`: affine maths. A matrix is `[[a, c, e], [b, d, f]]`; points are column
//! vectors, so `multiply(parent, local)` maps local coordinates into the parent's.

use morfa_model::{DesignDocument, Matrix, NodeType, SceneNode, Vec2};

use crate::js;

/// TS `Rect`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const ZERO: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
}

pub const IDENTITY: Matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

#[inline]
pub fn multiply(m: &Matrix, n: &Matrix) -> Matrix {
    let [[a, c, e], [b, d, f]] = *m;
    let [[a2, c2, e2], [b2, d2, f2]] = *n;
    [
        [a * a2 + c * b2, a * c2 + c * d2, a * e2 + c * f2 + e],
        [b * a2 + d * b2, b * c2 + d * d2, b * e2 + d * f2 + f],
    ]
}

pub fn invert(m: &Matrix) -> Matrix {
    let [[a, c, e], [b, d, f]] = *m;
    let det = a * d - b * c;
    if det == 0.0 || !det.is_finite() {
        return IDENTITY;
    }
    [
        [d / det, -c / det, (c * f - d * e) / det],
        [-b / det, a / det, (b * e - a * f) / det],
    ]
}

#[inline]
pub fn apply(m: &Matrix, p: Vec2) -> Vec2 {
    Vec2 {
        x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
        y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
    }
}

/// Applies only the linear part (for directions and sizes).
#[inline]
pub fn apply_linear(m: &Matrix, p: Vec2) -> Vec2 {
    Vec2 {
        x: m[0][0] * p.x + m[0][1] * p.y,
        y: m[1][0] * p.x + m[1][1] * p.y,
    }
}

#[inline]
pub fn translation(x: f64, y: f64) -> Matrix {
    [[1.0, 0.0, x], [0.0, 1.0, y]]
}

#[inline]
pub fn scaling(sx: f64, sy: f64) -> Matrix {
    [[sx, 0.0, 0.0], [0.0, sy, 0.0]]
}

/// Rotation by `radians` clockwise on screen (y points down).
#[inline]
pub fn rotation_matrix(radians: f64) -> Matrix {
    let cos = js::cos(radians);
    let sin = js::sin(radians);
    [[cos, -sin, 0.0], [sin, cos, 0.0]]
}

#[inline]
pub fn to_radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}

/// The fields of a node `localMatrix` reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub flip_x: bool,
    pub flip_y: bool,
}

impl From<&SceneNode> for Placement {
    fn from(n: &SceneNode) -> Self {
        Placement {
            x: n.x,
            y: n.y,
            width: n.width,
            height: n.height,
            rotation: n.rotation,
            flip_x: n.flip_x.unwrap_or(false),
            flip_y: n.flip_y.unwrap_or(false),
        }
    }
}

/// Local box → parent space: translate(x, y) · rotate(−rotation°) · flip about the box centre.
/// `rotation` turns counter-clockwise on screen, as Figma's panel shows it.
pub fn local_matrix(node: &Placement) -> Matrix {
    // `node.rotation || 0`: NaN and 0 both give no rotation.
    let rotation = if node.rotation.is_nan() {
        0.0
    } else {
        node.rotation
    };
    let mut m = multiply(
        &translation(node.x, node.y),
        &rotation_matrix(-to_radians(rotation)),
    );
    if node.flip_x || node.flip_y {
        let flip = multiply(
            &multiply(
                &translation(node.width / 2.0, node.height / 2.0),
                &scaling(
                    if node.flip_x { -1.0 } else { 1.0 },
                    if node.flip_y { -1.0 } else { 1.0 },
                ),
            ),
            &translation(-node.width / 2.0, -node.height / 2.0),
        );
        m = multiply(&m, &flip);
    }
    m
}

#[inline]
pub fn node_matrix(node: &SceneNode) -> Matrix {
    local_matrix(&Placement::from(node))
}

/// Node local box → page space. Pages are the identity.
pub fn world_matrix(doc: &DesignDocument, id: &str) -> Matrix {
    let mut chain: Vec<&SceneNode> = Vec::new();
    let mut node = doc.nodes.get(id);
    while let Some(n) = node {
        if n.kind == NodeType::Page {
            break;
        }
        chain.push(n);
        node = n.parent_id.as_deref().and_then(|p| doc.nodes.get(p));
    }
    let mut m = IDENTITY;
    for n in chain.iter().rev() {
        m = multiply(&m, &node_matrix(n));
    }
    m
}

pub fn corners(r: &Rect) -> [Vec2; 4] {
    [
        Vec2 { x: r.x, y: r.y },
        Vec2 {
            x: r.x + r.width,
            y: r.y,
        },
        Vec2 {
            x: r.x + r.width,
            y: r.y + r.height,
        },
        Vec2 {
            x: r.x,
            y: r.y + r.height,
        },
    ]
}

/// Axis-aligned bounds of a rectangle after a transform.
pub fn transform_rect(m: &Matrix, r: &Rect) -> Rect {
    let c = corners(r);
    bounds_of_points(&[
        apply(m, c[0]),
        apply(m, c[1]),
        apply(m, c[2]),
        apply(m, c[3]),
    ])
}

pub fn bounds_of_points(points: &[Vec2]) -> Rect {
    if points.is_empty() {
        return Rect::ZERO;
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in points {
        if p.x < min_x {
            min_x = p.x;
        }
        if p.y < min_y {
            min_y = p.y;
        }
        if p.x > max_x {
            max_x = p.x;
        }
        if p.y > max_y {
            max_y = p.y;
        }
    }
    Rect {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    }
}

pub fn union_rects(rects: &[Rect]) -> Option<Rect> {
    if rects.is_empty() {
        return None;
    }
    let mut points = Vec::with_capacity(rects.len() * 2);
    for r in rects {
        points.push(Vec2 { x: r.x, y: r.y });
        points.push(Vec2 {
            x: r.x + r.width,
            y: r.y + r.height,
        });
    }
    Some(bounds_of_points(&points))
}

#[inline]
pub fn rects_intersect(a: &Rect, b: &Rect) -> bool {
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

#[inline]
pub fn rect_contains(outer: &Rect, inner: &Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height
}

#[inline]
pub fn point_in_rect(p: Vec2, r: &Rect) -> bool {
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/// The node's box (no stroke or effects) in page space, as an axis-aligned rectangle.
pub fn world_box(doc: &DesignDocument, id: &str) -> Rect {
    let (w, h) = doc
        .nodes
        .get(id)
        .map_or((0.0, 0.0), |n| (n.width, n.height));
    transform_rect(&world_matrix(doc, id), &Rect::new(0.0, 0.0, w, h))
}

/// Matrix split into the panel's fields.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Decomposed {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub flip_x: bool,
}

/// Splits a matrix into the panel's fields. Skew is dropped; a negative determinant becomes flipX.
pub fn decompose(m: &Matrix) -> Decomposed {
    let [[a, c, e], [b, d, f]] = *m;
    let det = a * d - b * c;
    let flip_x = det < 0.0;
    let rotation = normalize_degrees(
        (-js::atan2(if flip_x { -b } else { b }, if flip_x { -a } else { a }) * 180.0)
            / std::f64::consts::PI,
    );
    Decomposed {
        x: e,
        y: f,
        rotation,
        scale_x: js::hypot(a, b),
        scale_y: js::hypot(c, d),
        flip_x,
    }
}

/// −180 < degrees ≤ 180, with tiny float noise snapped to whole hundredths.
pub fn normalize_degrees(degrees: f64) -> f64 {
    // JS `%` is fmod (sign of the dividend), as Rust's `%` on f64.
    let mut d = ((degrees % 360.0) + 360.0) % 360.0;
    if d > 180.0 {
        d -= 360.0;
    }
    let rounded = js::round(d * 100.0) / 100.0;
    if (rounded == 0.0 && rounded.is_sign_negative()) || rounded == -180.0 {
        rounded.abs()
    } else {
        rounded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_is_counter_clockwise() {
        let m = local_matrix(&Placement {
            x: 10.0,
            y: 0.0,
            width: 4.0,
            height: 2.0,
            rotation: 90.0,
            ..Default::default()
        });
        let p = apply(&m, Vec2 { x: 1.0, y: 0.0 });
        assert!((p.x - 10.0).abs() < 1e-12 && (p.y + 1.0).abs() < 1e-12);
        assert_eq!(normalize_degrees(-180.0), 180.0);
    }
}
