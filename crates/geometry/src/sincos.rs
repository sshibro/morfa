//! `Math.sin` and `Math.cos` as V8 computes them (`base::ieee754`): the original Sun fdlibm 5.3 kernels
//! (`__kernel_sin` with its nested polynomial, `__kernel_cos` with the `qx` correction above 0.3) over FreeBSD's
//! argument reduction. musl (the `libm` crate) rewrote the kernels, so `libm::sin`/`libm::cos` differ from
//! `Math.sin`/`Math.cos` in the last bit for about 1 % of arguments; this module differs in none of 600 000
//! recorded ones (scripts/geometry/trig-record.cjs, examples/trig_check.rs).
//! Constants are fdlibm's (identical in `libm`). Arguments above 2^20·π/2 need fdlibm's multi-word reduction
//! (`__kernel_rem_pio2`) and go to `libm` instead: no design-tool angle is that large.

// fdlibm's literals as published (they round to the same doubles).
#![allow(clippy::excessive_precision)]

const S1: f64 = -1.66666666666666324348e-01;
const S2: f64 = 8.33333333332248946124e-03;
const S3: f64 = -1.98412698298579493134e-04;
const S4: f64 = 2.75573137070700676789e-06;
const S5: f64 = -2.50507602534068634195e-08;
const S6: f64 = 1.58969099521155010221e-10;

const C1: f64 = 4.16666666666666019037e-02;
const C2: f64 = -1.38888888888741095749e-03;
const C3: f64 = 2.48015872894767294178e-05;
const C4: f64 = -2.75573143513906633035e-07;
const C5: f64 = 2.08757232129817482790e-09;
const C6: f64 = -1.13596475577881948265e-11;

const INV_PIO2: f64 = std::f64::consts::FRAC_2_PI;
const PIO2_1: f64 = 1.57079632673412561417e+00;
const PIO2_1T: f64 = 6.07710050650619224932e-11;
const PIO2_2: f64 = 6.07710050630396597660e-11;
const PIO2_2T: f64 = 2.02226624879595063154e-21;
const PIO2_3: f64 = 2.02226624871116645580e-21;
const PIO2_3T: f64 = 8.47842766036889956997e-32;

#[inline]
fn high(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}

fn kernel_sin(x: f64, y: f64, iy: bool) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if !iy {
        x + v * (S1 + z * r)
    } else {
        x - ((z * (0.5 * y - v * r) - y) - v * S1)
    }
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3FD3_3333 {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }
    let qx = if ix > 0x3fe9_0000 {
        0.28125
    } else {
        f64::from_bits(u64::from(ix - 0x0020_0000) << 32)
    };
    let hz = 0.5 * z - qx;
    let a = 1.0 - qx;
    a - (hz - (z * r - x * y))
}

/// x − n·π/2 as y0 + y1 for |x| < 2^20·π/2: FreeBSD's `__ieee754_rem_pio2` medium path (n = rint(x·2/π), up to
/// three rounds when the first cancels), the reduction V8 uses. None beyond (multi-word reduction).
fn rem_pio2(x: f64) -> Option<(i32, f64, f64)> {
    const TO_INT: f64 = 6755399441055744.0; // 1.5·2^52
    let ix = high(x) & 0x7fff_ffff;
    if ix > 0x4139_21fb {
        return None;
    }
    let f_n = (x * INV_PIO2 + TO_INT) - TO_INT;
    let n = f_n as i32;
    let mut r = x - f_n * PIO2_1;
    let mut w = f_n * PIO2_1T;
    let mut y0 = r - w;
    let ex = (ix >> 20) as i32;
    if ex - ((high(y0) >> 20) & 0x7ff) as i32 > 16 {
        let t = r;
        w = f_n * PIO2_2;
        r = t - w;
        w = f_n * PIO2_2T - ((t - r) - w);
        y0 = r - w;
        if ex - ((high(y0) >> 20) & 0x7ff) as i32 > 49 {
            let t = r;
            w = f_n * PIO2_3;
            r = t - w;
            w = f_n * PIO2_3T - ((t - r) - w);
            y0 = r - w;
        }
    }
    Some((n, y0, (r - y0) - w))
}

/// `Math.sin`.
pub fn sin(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix >= 0x7ff0_0000 {
        return f64::NAN;
    }
    let Some((n, y0, y1)) = rem_pio2(x) else {
        return libm::sin(x);
    };
    match n & 3 {
        0 => kernel_sin(y0, y1, true),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, true),
        _ => -kernel_cos(y0, y1),
    }
}

/// `Math.cos`.
pub fn cos(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7ff0_0000 {
        return f64::NAN;
    }
    let Some((n, y0, y1)) = rem_pio2(x) else {
        return libm::cos(x);
    };
    match n & 3 {
        0 => kernel_cos(y0, y1),
        1 => -kernel_sin(y0, y1, true),
        2 => -kernel_cos(y0, y1),
        _ => kernel_sin(y0, y1, true),
    }
}
