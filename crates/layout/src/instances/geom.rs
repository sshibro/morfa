//! The geometry the sync reads, operation for operation as TypeScript computes it (so the numbers are
//! bit-equal): `localMatrix`, `transformRect` (shared/design/geometry.ts), `constrainedBox`,
//! `textModeAfterResize` (shared/design/constraints.ts) and V8's `Math.hypot`: the few pieces the sync needs, kept
//! operation for operation as components.ts computes them (crate::constraints is constraints.ts whole).

use morfa_model::{ConstraintType, Constraints, TextAutoResize};

/// `LAYOUT_EPSILON`.
pub const LAYOUT_EPSILON: f64 = 1e-6;

/// `sameValue` for numbers.
pub fn same_number(a: f64, b: f64) -> bool {
    a == b || (a - b).abs() <= LAYOUT_EPSILON
}

/// `Math.max(a, b)`: NaN wins, +0 beats −0.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a.is_sign_positive() { a } else { b };
    }
    if a > b { a } else { b }
}

/// `Math.min(a, b)`: NaN wins, −0 beats +0.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a.is_sign_negative() { a } else { b };
    }
    if a < b { a } else { b }
}

/// V8's `Math.hypot` (builtins/math.tq): values normalized by the largest, Kahan-summed squares.
pub fn js_hypot(values: &[f64]) -> f64 {
    let mut max = 0.0_f64;
    let mut nan = false;
    let mut abs = [0.0_f64; 4];
    debug_assert!(values.len() <= abs.len());
    for (i, value) in values.iter().enumerate() {
        if value.is_nan() {
            nan = true;
        } else {
            abs[i] = value.abs();
            if abs[i] > max {
                max = abs[i];
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for value in &abs[..values.len()] {
        let n = value / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `[[a, c, e], [b, d, f]]`.
pub type Matrix = [[f64; 3]; 2];

fn multiply(m: &Matrix, n: &Matrix) -> Matrix {
    let [[a, c, e], [b, d, f]] = *m;
    let [[a2, c2, e2], [b2, d2, f2]] = *n;
    [
        [a * a2 + c * b2, a * c2 + c * d2, a * e2 + c * f2 + e],
        [b * a2 + d * b2, b * c2 + d * d2, b * e2 + d * f2 + f],
    ]
}

fn translation(x: f64, y: f64) -> Matrix {
    [[1.0, 0.0, x], [0.0, 1.0, y]]
}

fn scaling(sx: f64, sy: f64) -> Matrix {
    [[sx, 0.0, 0.0], [0.0, sy, 0.0]]
}

fn rotation_matrix(radians: f64) -> Matrix {
    let (cos, sin) = (radians.cos(), radians.sin());
    [[cos, -sin, 0.0], [sin, cos, 0.0]]
}

/// `toRadians`.
pub fn to_radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}

/// `rotation || 0` (NaN and −0 are falsy).
fn rotation_or_zero(rotation: f64) -> f64 {
    if rotation == 0.0 || rotation.is_nan() {
        0.0
    } else {
        rotation
    }
}

/// The fields `localMatrix` reads.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub flip_x: bool,
    pub flip_y: bool,
}

/// `localMatrix`.
pub fn local_matrix(node: &Placed) -> Matrix {
    let mut m = multiply(
        &translation(node.x, node.y),
        &rotation_matrix(-to_radians(rotation_or_zero(node.rotation))),
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (
        m[0][0] * x + m[0][1] * y + m[0][2],
        m[1][0] * x + m[1][1] * y + m[1][2],
    )
}

/// `transformRect`: the bounds of the rectangle's corners after `m`.
pub fn transform_rect(m: &Matrix, r: &Rect) -> Rect {
    let corners = [
        (r.x, r.y),
        (r.x + r.width, r.y),
        (r.x + r.width, r.y + r.height),
        (r.x, r.y + r.height),
    ];
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for (x, y) in corners {
        let (px, py) = apply(m, x, y);
        if px < min_x {
            min_x = px;
        }
        if py < min_y {
            min_y = py;
        }
        if px > max_x {
            max_x = px;
        }
        if py > max_y {
            max_y = py;
        }
    }
    Rect {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    }
}

fn bounds_of(node: &Placed) -> Rect {
    if rotation_or_zero(node.rotation) == 0.0 {
        return Rect {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
        };
    }
    transform_rect(
        &local_matrix(node),
        &Rect {
            x: 0.0,
            y: 0.0,
            width: node.width,
            height: node.height,
        },
    )
}

fn ratio(after: f64, before: f64) -> f64 {
    if before > LAYOUT_EPSILON {
        after / before
    } else {
        1.0
    }
}

fn stretched_size(node: &Placed, kx: f64, ky: f64) -> (f64, f64) {
    if kx == 1.0 && ky == 1.0 {
        return (node.width, node.height);
    }
    let radians = to_radians(rotation_or_zero(node.rotation));
    let (cos, sin) = (radians.cos().abs(), radians.sin().abs());
    (
        node.width * js_hypot(&[kx * cos, ky * sin]),
        node.height * js_hypot(&[kx * sin, ky * cos]),
    )
}

fn box_for_bounds(node: &Placed, target: &Rect, current: &Rect) -> Rect {
    let (width, height) = stretched_size(
        node,
        ratio(target.width, current.width),
        ratio(target.height, current.height),
    );
    if rotation_or_zero(node.rotation) == 0.0 {
        return Rect {
            x: target.x,
            y: target.y,
            width,
            height,
        };
    }
    let zero = transform_rect(
        &local_matrix(&Placed {
            x: 0.0,
            y: 0.0,
            width,
            height,
            ..*node
        }),
        &Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        },
    );
    Rect {
        x: target.x - zero.x,
        y: target.y - zero.y,
        width,
        height,
    }
}

fn follow(kind: ConstraintType, start: f64, size: f64, before: f64, after: f64) -> (f64, f64) {
    let delta = after - before;
    match kind {
        ConstraintType::Max => (start + delta, size),
        ConstraintType::Center => (start + delta / 2.0, size),
        ConstraintType::Stretch => (start, js_max(0.0, size + delta)),
        ConstraintType::Scale => {
            let k = ratio(after, before);
            (start * k, size * k)
        }
        ConstraintType::Min => (start, size),
    }
}

/// `constrainedBox(child, before, after, constraints)`.
pub fn constrained_box(
    child: &Placed,
    before: (f64, f64),
    after: (f64, f64),
    constraints: &Constraints,
) -> Rect {
    let bounds = bounds_of(child);
    let (x, width) = follow(
        constraints.horizontal,
        bounds.x,
        bounds.width,
        before.0,
        after.0,
    );
    let (y, height) = follow(
        constraints.vertical,
        bounds.y,
        bounds.height,
        before.1,
        after.1,
    );
    box_for_bounds(
        child,
        &Rect {
            x,
            y,
            width,
            height,
        },
        &bounds,
    )
}

/// `textModeAfterResize`.
pub fn text_mode_after_resize(
    mode: TextAutoResize,
    width_changed: bool,
    height_changed: bool,
) -> TextAutoResize {
    match mode {
        TextAutoResize::WidthAndHeight if height_changed => TextAutoResize::None,
        TextAutoResize::WidthAndHeight if width_changed => TextAutoResize::Height,
        TextAutoResize::Height if height_changed => TextAutoResize::None,
        mode => mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hypot_is_v8s() {
        assert_eq!(js_hypot(&[3.0, 4.0]), 5.0);
        assert_eq!(js_hypot(&[0.0, 0.0]), 0.0);
        assert_eq!(js_hypot(&[f64::NAN, f64::INFINITY]), f64::INFINITY);
        assert!(js_hypot(&[f64::NAN, 1.0]).is_nan());
    }

    #[test]
    fn max_and_min_order_zeros_as_javascript() {
        assert!(js_max(0.0, -0.0).is_sign_positive());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert_eq!(js_max(0.0, -3.0), 0.0);
    }
}
