//! JavaScript number semantics the TS oracle relies on, so the same expressions give the same bits.
//!
//! `Math.hypot` is V8's (normalise by the largest value, Kahan-sum the squares), not libm's; `Math.round`
//! rounds half up; trigonometry goes through `libm` (fdlibm, as V8's `base::ieee754`) so native and WASM
//! builds agree with each other. `String(number)` is S1's `js_number`.

/// `Math.hypot(a, b)` as V8 computes it (src/builtins/math.tq `MathHypot`).
#[inline]
pub fn hypot(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        if a.is_infinite() || b.is_infinite() {
            return f64::INFINITY;
        }
        return f64::NAN;
    }
    let (a, b) = (a.abs(), b.abs());
    let max = if b > a { b } else { a };
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.round`: the nearest integer, halves towards +∞, −0 kept for (−0.5, −0].
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = x.ceil();
    if r - 0.5 > x { r - 1.0 } else { r }
}

#[inline]
pub fn sin(x: f64) -> f64 {
    crate::sincos::sin(x)
}
#[inline]
pub fn cos(x: f64) -> f64 {
    crate::sincos::cos(x)
}
#[inline]
pub fn tan(x: f64) -> f64 {
    libm::tan(x)
}
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}
#[inline]
pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}
#[inline]
pub fn pow(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

/// `Math.min(a, b)` (NaN wins, −0 < +0).
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)` (NaN wins, +0 > −0).
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// `Math.sign`.
#[inline]
pub fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// `String(value)`.
pub fn number_to_string(value: f64) -> String {
    morfa_model::js_number(value)
}

/// `value.toFixed(digits)` for finite values below 1e21 (what `formatNumber` needs): the decimal
/// nearest to the exact binary value, ties up in magnitude, as ECMA-262 Number.prototype.toFixed.
pub fn to_fixed(value: f64, digits: usize) -> String {
    let mut s = format!("{:.*}", digits + 30, value.abs());
    // Exact digits far beyond the requested ones decide the tie the way toFixed does (round half up).
    let dot = s.find('.').unwrap_or(s.len());
    let keep = dot + 1 + digits;
    let round_up = s.as_bytes().get(keep).is_some_and(|&d| d >= b'5');
    s.truncate(if digits == 0 { dot } else { keep });
    if round_up {
        let mut bytes = s.into_bytes();
        let mut i = bytes.len();
        loop {
            if i == 0 {
                bytes.insert(0, b'1');
                break;
            }
            i -= 1;
            match bytes[i] {
                b'.' => continue,
                b'9' => bytes[i] = b'0',
                d => {
                    bytes[i] = d + 1;
                    break;
                }
            }
        }
        s = String::from_utf8(bytes).unwrap_or_default();
    }
    if value < 0.0 {
        s.insert(0, '-');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_js() {
        assert_eq!(round(0.5), 1.0);
        assert_eq!(round(-0.5).to_bits(), (-0.0f64).to_bits());
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(-1.5), -1.0);
        assert_eq!(round(2.5), 3.0);
    }

    #[test]
    fn hypot_basics() {
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(0.0, 0.0), 0.0);
        assert_eq!(hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn to_fixed_ties_up() {
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(-0.0000001, 3), "-0.000");
        assert_eq!(to_fixed(9.9996, 3), "10.000");
    }
}
