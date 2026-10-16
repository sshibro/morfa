//! A literal port of `orient2d` from robust-predicates 3.0.3 (`esm/orient2d.js`, `esm/util.js`),
//! Shewchuk's adaptive-precision orientation test. Same expressions in the same order.

/// util.js `epsilon` (2^-53).
const EPSILON: f64 = 1.110_223_024_625_156_5e-16;
const SPLITTER: f64 = 134_217_729.0;
const RESULTERRBOUND: f64 = (3.0 + 8.0 * EPSILON) * EPSILON;
const CCWERRBOUND_A: f64 = (3.0 + 16.0 * EPSILON) * EPSILON;
const CCWERRBOUND_B: f64 = (2.0 + 12.0 * EPSILON) * EPSILON;
const CCWERRBOUND_C: f64 = (9.0 + 64.0 * EPSILON) * EPSILON * EPSILON;

/// `e[i]`, where the JS reads one past the expansion's end (the value is never used).
#[inline]
fn at(e: &[f64], i: usize) -> f64 {
    e.get(i).copied().unwrap_or(0.0)
}

/// util.js `sum` (fast_expansion_sum_zeroelim).
fn sum(elen: usize, e: &[f64], flen: usize, f: &[f64], h: &mut [f64]) -> usize {
    let mut q;
    let mut qnew;
    let mut hh;
    let mut bvirt;
    let mut enow = e[0];
    let mut fnow = f[0];
    let mut eindex = 0;
    let mut findex = 0;
    if (fnow > enow) == (fnow > -enow) {
        q = enow;
        eindex += 1;
        enow = at(e, eindex);
    } else {
        q = fnow;
        findex += 1;
        fnow = at(f, findex);
    }
    let mut hindex = 0;
    if eindex < elen && findex < flen {
        if (fnow > enow) == (fnow > -enow) {
            qnew = enow + q;
            hh = q - (qnew - enow);
            eindex += 1;
            enow = at(e, eindex);
        } else {
            qnew = fnow + q;
            hh = q - (qnew - fnow);
            findex += 1;
            fnow = at(f, findex);
        }
        q = qnew;
        if hh != 0.0 {
            h[hindex] = hh;
            hindex += 1;
        }
        while eindex < elen && findex < flen {
            if (fnow > enow) == (fnow > -enow) {
                qnew = q + enow;
                bvirt = qnew - q;
                hh = q - (qnew - bvirt) + (enow - bvirt);
                eindex += 1;
                enow = at(e, eindex);
            } else {
                qnew = q + fnow;
                bvirt = qnew - q;
                hh = q - (qnew - bvirt) + (fnow - bvirt);
                findex += 1;
                fnow = at(f, findex);
            }
            q = qnew;
            if hh != 0.0 {
                h[hindex] = hh;
                hindex += 1;
            }
        }
    }
    while eindex < elen {
        qnew = q + enow;
        bvirt = qnew - q;
        hh = q - (qnew - bvirt) + (enow - bvirt);
        eindex += 1;
        enow = at(e, eindex);
        q = qnew;
        if hh != 0.0 {
            h[hindex] = hh;
            hindex += 1;
        }
    }
    while findex < flen {
        qnew = q + fnow;
        bvirt = qnew - q;
        hh = q - (qnew - bvirt) + (fnow - bvirt);
        findex += 1;
        fnow = at(f, findex);
        q = qnew;
        if hh != 0.0 {
            h[hindex] = hh;
            hindex += 1;
        }
    }
    if q != 0.0 || hindex == 0 {
        h[hindex] = q;
        hindex += 1;
    }
    hindex
}

/// util.js `estimate`.
fn estimate(elen: usize, e: &[f64]) -> f64 {
    let mut q = e[0];
    for v in e.iter().take(elen).skip(1) {
        q += v;
    }
    q
}

/// The repeated "Two-Product difference" block of orient2dadapt: writes `a*b - c*d` as a
/// 4-term expansion into `out` (same statements as the JS, inlined there).
#[inline(always)]
fn two_two_diff(acx: f64, bcy: f64, acy: f64, bcx: f64, out: &mut [f64; 4]) {
    let s1 = acx * bcy;
    let mut c = SPLITTER * acx;
    let mut ahi = c - (c - acx);
    let mut alo = acx - ahi;
    c = SPLITTER * bcy;
    let mut bhi = c - (c - bcy);
    let mut blo = bcy - bhi;
    let s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
    let t1 = acy * bcx;
    c = SPLITTER * acy;
    ahi = c - (c - acy);
    alo = acy - ahi;
    c = SPLITTER * bcx;
    bhi = c - (c - bcx);
    blo = bcx - bhi;
    let t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
    let mut i = s0 - t0;
    let mut bvirt = s0 - i;
    out[0] = s0 - (i + bvirt) + (bvirt - t0);
    let j = s1 + i;
    bvirt = j - s1;
    let z = s1 - (j - bvirt) + (i - bvirt);
    i = z - t1;
    bvirt = z - i;
    out[1] = z - (i + bvirt) + (bvirt - t1);
    let u3 = j + i;
    bvirt = u3 - j;
    out[2] = j - (u3 - bvirt) + (i - bvirt);
    out[3] = u3;
}

/// orient2d.js `orient2dadapt`.
fn orient2dadapt(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, detsum: f64) -> f64 {
    let acx = ax - cx;
    let bcx = bx - cx;
    let acy = ay - cy;
    let bcy = by - cy;

    let mut b = [0.0; 4];
    two_two_diff(acx, bcy, acy, bcx, &mut b);

    let mut det = estimate(4, &b);
    let mut errbound = CCWERRBOUND_B * detsum;
    if det >= errbound || -det >= errbound {
        return det;
    }

    let mut bvirt = ax - acx;
    let acxtail = ax - (acx + bvirt) + (bvirt - cx);
    bvirt = bx - bcx;
    let bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
    bvirt = ay - acy;
    let acytail = ay - (acy + bvirt) + (bvirt - cy);
    bvirt = by - bcy;
    let bcytail = by - (bcy + bvirt) + (bvirt - cy);

    if acxtail == 0.0 && acytail == 0.0 && bcxtail == 0.0 && bcytail == 0.0 {
        return det;
    }

    errbound = CCWERRBOUND_C * detsum + RESULTERRBOUND * det.abs();
    det += (acx * bcytail + bcy * acxtail) - (acy * bcxtail + bcx * acytail);
    if det >= errbound || -det >= errbound {
        return det;
    }

    let mut u = [0.0; 4];
    let mut c1 = [0.0; 8];
    let mut c2 = [0.0; 12];
    let mut d = [0.0; 16];

    two_two_diff(acxtail, bcy, acytail, bcx, &mut u);
    let c1len = sum(4, &b, 4, &u, &mut c1);

    two_two_diff(acx, bcytail, acy, bcxtail, &mut u);
    let c2len = sum(c1len, &c1, 4, &u, &mut c2);

    two_two_diff(acxtail, bcytail, acytail, bcxtail, &mut u);
    let dlen = sum(c2len, &c2, 4, &u, &mut d);

    d[dlen - 1]
}

/// orient2d.js `orient2d`.
pub(super) fn orient2d(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    let detleft = (ay - cy) * (bx - cx);
    let detright = (ax - cx) * (by - cy);
    let det = detleft - detright;

    let detsum = (detleft + detright).abs();
    if det.abs() >= CCWERRBOUND_A * detsum {
        return det;
    }

    -orient2dadapt(ax, ay, bx, by, cx, cy, detsum)
}
