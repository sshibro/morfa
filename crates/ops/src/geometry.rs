//! The affine maths the merge and the transaction use (shared/design/geometry.ts, transaction.ts `placementFor`,
//! `boxOrigin`), bit for bit: `sin`, `cos` and `atan2` come from the `libm` crate (fdlibm, as V8's `Math`), never the
//! platform's, and `Math.round` keeps JavaScript's rounding (half up, `-0` kept).

use crate::value::Value;

/// `[[a, c, e], [b, d, f]]`: points are column vectors, `multiply(parent, local)` maps local into parent space.
pub type Matrix = [[f64; 3]; 2];

pub const IDENTITY: Matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

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

pub fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (
        m[0][0] * x + m[0][1] * y + m[0][2],
        m[1][0] * x + m[1][1] * y + m[1][2],
    )
}

pub fn apply_linear(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0][0] * x + m[0][1] * y, m[1][0] * x + m[1][1] * y)
}

pub fn translation(x: f64, y: f64) -> Matrix {
    [[1.0, 0.0, x], [0.0, 1.0, y]]
}

pub fn scaling(sx: f64, sy: f64) -> Matrix {
    [[sx, 0.0, 0.0], [0.0, sy, 0.0]]
}

pub fn rotation_matrix(radians: f64) -> Matrix {
    let (cos, sin) = (libm::cos(radians), libm::sin(radians));
    [[cos, -sin, 0.0], [sin, cos, 0.0]]
}

pub fn to_radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}

/// JavaScript's `Math.round`: halves go up, `-0` and the interval [-0.5, 0) give `-0`.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value.fract() == 0.0 {
        return value;
    }
    let floor = value.floor();
    let rounded = if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}

/// `normalizeDegrees`: −180 < degrees ≤ 180, float noise snapped to whole hundredths.
pub fn normalize_degrees(degrees: f64) -> f64 {
    let mut d = ((degrees % 360.0) + 360.0) % 360.0;
    if d > 180.0 {
        d -= 360.0;
    }
    let rounded = js_round(d * 100.0) / 100.0;
    if (rounded == 0.0 && rounded.is_sign_negative()) || rounded == -180.0 {
        rounded.abs()
    } else {
        rounded
    }
}

/// A number field as JavaScript reads it for arithmetic (`undefined` → NaN).
pub(crate) fn num(node: &Value, key: &str) -> f64 {
    match node.get(key) {
        Some(Value::Number(value)) => *value,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => f64::from(u8::from(*value)),
        _ => f64::NAN,
    }
}

/// `node.rotation || 0`.
fn rotation_of(node: &Value) -> f64 {
    let rotation = num(node, "rotation");
    if rotation.is_nan() || rotation == 0.0 {
        0.0
    } else {
        rotation
    }
}

fn flag(node: &Value, key: &str) -> bool {
    node.get(key).is_some_and(Value::truthy)
}

/// `localMatrix`: local box → parent space: translate(x, y) · rotate(−rotation°) · flip about the box centre.
pub fn local_matrix(node: &Value) -> Matrix {
    let mut m = multiply(
        &translation(num(node, "x"), num(node, "y")),
        &rotation_matrix(-to_radians(rotation_of(node))),
    );
    let (flip_x, flip_y) = (flag(node, "flipX"), flag(node, "flipY"));
    if flip_x || flip_y {
        let (width, height) = (num(node, "width"), num(node, "height"));
        let flip = multiply(
            &multiply(
                &translation(width / 2.0, height / 2.0),
                &scaling(
                    if flip_x { -1.0 } else { 1.0 },
                    if flip_y { -1.0 } else { 1.0 },
                ),
            ),
            &translation(-width / 2.0, -height / 2.0),
        );
        m = multiply(&m, &flip);
    }
    m
}

/// The fields that place a node in its parent's space (`Placement`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub flip_x: bool,
    pub flip_y: bool,
}

/// `clean`: float noise such as 99.99999999997 rounded away, `-0` as `0`.
fn clean(value: f64) -> f64 {
    let rounded = js_round(value);
    let out = if (value - rounded).abs() < 1e-7 {
        rounded
    } else {
        value
    };
    if out == 0.0 { 0.0 } else { out }
}

/// `boxOrigin`: (x, y) of a `width` × `height` box whose centre sits at `centre` with this rotation.
pub fn box_origin(centre: (f64, f64), width: f64, height: f64, rotation: f64) -> (f64, f64) {
    let offset = apply_linear(
        &rotation_matrix(-to_radians(rotation)),
        width / 2.0,
        height / 2.0,
    );
    (clean(centre.0 - offset.0), clean(centre.1 - offset.1))
}

/// `placementFor(node, matrix, prefer)`: x/y/rotation/flips read from a local → parent matrix (the inverse of
/// [`local_matrix`]); `prefer` defaults to the node's own flags.
pub fn placement_for(node: &Value, matrix: &Matrix, prefer: Option<(bool, bool)>) -> Placement {
    let [[a, c, _], [b, d, _]] = *matrix;
    let mirrored = a * d - b * c < 0.0;
    let (mut flip_x, mut flip_y) = prefer.unwrap_or((flag(node, "flipX"), flag(node, "flipY")));
    if mirrored != (flip_x != flip_y) {
        flip_x = mirrored;
        flip_y = false;
    }
    let sx = if flip_x { -1.0 } else { 1.0 };
    let rotation = normalize_degrees((-libm::atan2(b * sx, a * sx) * 180.0) / std::f64::consts::PI);
    let (width, height) = (num(node, "width"), num(node, "height"));
    let centre = apply(matrix, width / 2.0, height / 2.0);
    let (x, y) = box_origin(centre, width, height, rotation);
    Placement {
        x,
        y,
        rotation,
        flip_x,
        flip_y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_as_javascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert!(js_round(-0.4).is_sign_negative());
        assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(normalize_degrees(-180.0), 180.0);
        assert_eq!(normalize_degrees(540.0), 180.0);
        assert_eq!(normalize_degrees(-0.001), 0.0);
    }
}
