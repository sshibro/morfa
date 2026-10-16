//! The affine maths of `shared/design/geometry.ts` the layout stages use, operation for operation
//! (the same products in the same order, so the numbers are the TypeScript's to the bit).

use crate::math;

/// `[[a, c, e], [b, d, f]]`: points are column vectors, `multiply(parent, local)` maps local into parent.
pub type Matrix = [[f64; 3]; 2];

pub const IDENTITY: Matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// `Rect` / `Box` of the TypeScript.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// What `localMatrix` and `boundsOf` read of a node: its box, turn and flips.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub flip_x: bool,
    pub flip_y: bool,
}

impl Placement {
    /// `{...node, x, y, width, height}`.
    pub fn with_box(self, x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
            ..self
        }
    }
}

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

#[inline]
pub const fn translation(x: f64, y: f64) -> Matrix {
    [[1.0, 0.0, x], [0.0, 1.0, y]]
}

#[inline]
pub const fn scaling(sx: f64, sy: f64) -> Matrix {
    [[sx, 0.0, 0.0], [0.0, sy, 0.0]]
}

pub fn rotation_matrix(radians: f64) -> Matrix {
    let cos = math::cos(radians);
    let sin = math::sin(radians);
    [[cos, -sin, 0.0], [sin, cos, 0.0]]
}

/// `node.rotation || 0`.
#[inline]
pub fn turn(rotation: f64) -> f64 {
    if rotation == 0.0 || rotation.is_nan() {
        0.0
    } else {
        rotation
    }
}

/// `localMatrix`: translate(x, y) · rotate(−rotation°) · flip about the box centre.
pub fn local_matrix(node: &Placement) -> Matrix {
    let mut m = multiply(
        &translation(node.x, node.y),
        &rotation_matrix(-math::to_radians(turn(node.rotation))),
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

/// `boundsOfPoints` over the four corners of `r` mapped by `m` (`transformRect`).
pub fn transform_rect(m: &Matrix, r: Rect) -> Rect {
    let corners = [
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
    ];
    bounds_of_points(corners.iter().map(|p| apply(m, *p)))
}

pub fn bounds_of_points(points: impl IntoIterator<Item = Vec2>) -> Rect {
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut any = false;
    for p in points {
        any = true;
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
    if !any {
        return Rect::new(0.0, 0.0, 0.0, 0.0);
    }
    Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)
}

/// `unionRects`: `None` for no rectangles.
pub fn union_rects(rects: impl IntoIterator<Item = Rect>) -> Option<Rect> {
    let mut any = false;
    let rect = bounds_of_points(rects.into_iter().flat_map(|r| {
        any = true;
        [
            Vec2 { x: r.x, y: r.y },
            Vec2 {
                x: r.x + r.width,
                y: r.y + r.height,
            },
        ]
    }));
    any.then_some(rect)
}
