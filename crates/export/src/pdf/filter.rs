//! The filter primitives the SVG exporter writes (`filter` and `shadowOnly` of svg.rs: feFlood, feColorMatrix,
//! feMorphology, feOffset, feGaussianBlur, feComposite, feBlend), applied to the rasterised content in Rust: resvg
//! draws the content, this runs the chain. resvg's own feMorphology is O(r²) a pixel (a 4 px spread at 300 dpi took
//! seconds); here it is a separable running min/max, and blurs are the SVG specification's three box blurs (exact
//! Gaussian kernels below σ = 2 px), as browsers do.
//!
//! Images are premultiplied RGBA in f32 (0..1), `color-interpolation-filters: sRGB` (no linearisation).

// Pixel loops index several planes at once.
#![allow(clippy::needless_range_loop)]

use std::collections::{HashMap, VecDeque};

use crate::xml::{El, Val};

#[derive(Clone)]
pub(crate) struct Image {
    pub w: usize,
    pub h: usize,
    pub px: Vec<[f32; 4]>,
}

impl Image {
    fn blank(w: usize, h: usize) -> Image {
        Image {
            w,
            h,
            px: vec![[0.0; 4]; w * h],
        }
    }
}

fn num(e: &El, name: &str) -> Option<f64> {
    match e.attrs.get(name) {
        Some(Val::Num(v)) => Some(*v),
        Some(Val::Str(s)) => s.trim().parse().ok(),
        None => None,
    }
}

fn text<'e>(e: &'e El, name: &str) -> Option<&'e str> {
    match e.attrs.get(name) {
        Some(Val::Str(s)) => Some(s),
        _ => None,
    }
}

/// Runs `filter`'s primitives on `source` (the content in raster pixels), `scale` pixels per user unit.
pub(crate) fn run(filter: &El, source: Image, scale: f64) -> Image {
    use std::rc::Rc;
    let (w, h) = (source.w, source.h);
    let source = Rc::new(source);
    let alpha = Rc::new(Image {
        w,
        h,
        px: source.px.iter().map(|p| [0.0, 0.0, 0.0, p[3]]).collect(),
    });
    let blank = Rc::new(Image::blank(w, h));
    let mut results: HashMap<String, Rc<Image>> = HashMap::new();
    let mut last: Option<Rc<Image>> = None;
    let input = |name: Option<&str>,
                 last: &Option<Rc<Image>>,
                 results: &HashMap<String, Rc<Image>>|
     -> Rc<Image> {
        match name {
            Some("SourceGraphic") => source.clone(),
            Some("SourceAlpha") => alpha.clone(),
            Some(n) => results.get(n).cloned().unwrap_or_else(|| blank.clone()),
            None => last.clone().unwrap_or_else(|| source.clone()),
        }
    };
    for p in filter.children.iter().filter_map(|c| match c {
        crate::xml::Child::El(e) => Some(e),
        _ => None,
    }) {
        let a = input(text(p, "in"), &last, &results);
        let owned = |a: Rc<Image>| Rc::try_unwrap(a).unwrap_or_else(|shared| (*shared).clone());
        let out = match p.tag {
            "feFlood" => {
                let o = num(p, "flood-opacity").unwrap_or(1.0) as f32;
                Image {
                    w,
                    h,
                    px: vec![[0.0, 0.0, 0.0, o]; w * h],
                }
            }
            "feColorMatrix" => color_matrix(&a, text(p, "values").unwrap_or("")),
            "feMorphology" => {
                let r = (num(p, "radius").unwrap_or(0.0) * scale).round().max(0.0) as usize;
                morphology(owned(a), r, text(p, "operator") == Some("dilate"))
            }
            "feOffset" => offset(
                &a,
                num(p, "dx").unwrap_or(0.0) * scale,
                num(p, "dy").unwrap_or(0.0) * scale,
            ),
            "feGaussianBlur" => blur(owned(a), num(p, "stdDeviation").unwrap_or(0.0) * scale),
            "feComposite" => {
                let b = input(text(p, "in2"), &last, &results);
                match text(p, "operator") {
                    Some("out") => zip(&a, &b, |x, y| x.map(|c| c * (1.0 - y[3]))),
                    Some("arithmetic") => {
                        let k = |n| num(p, n).unwrap_or(0.0) as f32;
                        let (k1, k2, k3, k4) = (k("k1"), k("k2"), k("k3"), k("k4"));
                        zip(&a, &b, |x, y| {
                            let mut o = [0.0; 4];
                            for i in 0..4 {
                                o[i] =
                                    (k1 * x[i] * y[i] + k2 * x[i] + k3 * y[i] + k4).clamp(0.0, 1.0);
                            }
                            let al = o[3];
                            [o[0].min(al), o[1].min(al), o[2].min(al), al]
                        })
                    }
                    Some("in") => zip(&a, &b, |x, y| x.map(|c| c * y[3])),
                    _ => zip(&a, &b, over),
                }
            }
            "feBlend" => {
                let b = input(text(p, "in2"), &last, &results);
                let mode = text(p, "mode").unwrap_or("normal").to_owned();
                zip(&a, &b, |s, d| blend(&mode, s, d))
            }
            _ => owned(a),
        };
        let out = Rc::new(out);
        if let Some(name) = text(p, "result") {
            results.insert(name.to_owned(), out.clone());
        }
        last = Some(out);
    }
    drop(results);
    let last = last.unwrap_or(source);
    Rc::try_unwrap(last).unwrap_or_else(|shared| (*shared).clone())
}

fn zip(a: &Image, b: &Image, f: impl Fn([f32; 4], [f32; 4]) -> [f32; 4]) -> Image {
    Image {
        w: a.w,
        h: a.h,
        px: a.px.iter().zip(&b.px).map(|(x, y)| f(*x, *y)).collect(),
    }
}

/// `source` over `backdrop`, premultiplied.
fn over(s: [f32; 4], d: [f32; 4]) -> [f32; 4] {
    let k = 1.0 - s[3];
    [
        s[0] + d[0] * k,
        s[1] + d[1] * k,
        s[2] + d[2] * k,
        s[3] + d[3] * k,
    ]
}

/// feBlend: `in` (source) blended over `in2` (backdrop), the separable modes of Compositing Level 1.
fn blend(mode: &str, s: [f32; 4], d: [f32; 4]) -> [f32; 4] {
    if mode == "normal" {
        return over(s, d);
    }
    let (sa, da) = (s[3], d[3]);
    let un = |c: f32, a: f32| {
        if a > 0.0 {
            (c / a).clamp(0.0, 1.0)
        } else {
            0.0
        }
    };
    let mut out = [0.0; 4];
    for i in 0..3 {
        let (cs, cb) = (un(s[i], sa), un(d[i], da));
        let b = match mode {
            "multiply" => cs * cb,
            "screen" => cs + cb - cs * cb,
            "darken" => cs.min(cb),
            "lighten" => cs.max(cb),
            "difference" => (cs - cb).abs(),
            "exclusion" => cs + cb - 2.0 * cs * cb,
            "overlay" => hard(cs, cb),
            "hard-light" => hard(cb, cs),
            _ => cs,
        };
        out[i] = (1.0 - da) * s[i] + (1.0 - sa) * d[i] + sa * da * b;
    }
    out[3] = sa + da - sa * da;
    out
}

fn hard(backdrop: f32, source: f32) -> f32 {
    if backdrop <= 0.5 {
        2.0 * backdrop * source
    } else {
        1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source)
    }
}

fn color_matrix(a: &Image, values: &str) -> Image {
    let m: Vec<f32> = values
        .split([' ', ','])
        .filter(|v| !v.is_empty())
        .filter_map(|v| v.parse().ok())
        .collect();
    let mut a = a.clone();
    if m.len() != 20 {
        return a;
    }
    for p in a.px.iter_mut() {
        let al = p[3];
        let c = if al > 0.0 {
            [p[0] / al, p[1] / al, p[2] / al, al]
        } else {
            [0.0, 0.0, 0.0, 0.0]
        };
        let mut o = [0.0f32; 4];
        for (r, row) in o.iter_mut().enumerate() {
            let k = &m[r * 5..r * 5 + 5];
            *row = (k[0] * c[0] + k[1] * c[1] + k[2] * c[2] + k[3] * c[3] + k[4]).clamp(0.0, 1.0);
        }
        *p = [o[0] * o[3], o[1] * o[3], o[2] * o[3], o[3]];
    }
    a
}

/// Running max (dilate) or min (erode) over a window of 2r+1 along one line of `n` samples.
fn running(line: &[f32], r: usize, max: bool, out: &mut [f32]) {
    let n = line.len();
    let mut q: VecDeque<usize> = VecDeque::new();
    let better = |a: f32, b: f32| if max { a >= b } else { a <= b };
    // Outside the image is transparent (0): erosion near the edge sees it, dilation never prefers it.
    let edge = 0.0f32;
    let mut next = 0usize;
    for i in 0..n {
        let hi = (i + r).min(n - 1);
        while next <= hi {
            while let Some(&back) = q.back() {
                if better(line[next], line[back]) {
                    q.pop_back();
                } else {
                    break;
                }
            }
            q.push_back(next);
            next += 1;
        }
        let lo = i.saturating_sub(r);
        while let Some(&front) = q.front() {
            if front < lo {
                q.pop_front();
            } else {
                break;
            }
        }
        let mut v = line[*q.front().expect("one sample at least")];
        if !max && (i < r || i + r >= n) {
            v = v.min(edge);
        }
        out[i] = v;
    }
}

fn morphology(a: Image, r: usize, dilate: bool) -> Image {
    if r == 0 {
        return a;
    }
    let (w, h) = (a.w, a.h);
    let mut out = a;
    let mut line = vec![0.0f32; w.max(h)];
    let mut res = vec![0.0f32; w.max(h)];
    for c in 0..4 {
        // A channel that is zero everywhere (a shadow's colour before its tint) stays zero.
        if out.px.iter().all(|p| p[c] == 0.0) {
            continue;
        }
        for y in 0..h {
            for x in 0..w {
                line[x] = out.px[y * w + x][c];
            }
            running(&line[..w], r, dilate, &mut res[..w]);
            for x in 0..w {
                out.px[y * w + x][c] = res[x];
            }
        }
        for x in 0..w {
            for y in 0..h {
                line[y] = out.px[y * w + x][c];
            }
            running(&line[..h], r, dilate, &mut res[..h]);
            for y in 0..h {
                out.px[y * w + x][c] = res[y];
            }
        }
    }
    out
}

fn offset(a: &Image, dx: f64, dy: f64) -> Image {
    let (dx, dy) = (dx.round() as i64, dy.round() as i64);
    if dx == 0 && dy == 0 {
        return a.clone();
    }
    let (w, h) = (a.w as i64, a.h as i64);
    let mut out = Image::blank(a.w, a.h);
    for y in 0..h {
        let sy = y - dy;
        if sy < 0 || sy >= h {
            continue;
        }
        for x in 0..w {
            let sx = x - dx;
            if sx >= 0 && sx < w {
                out.px[(y * w + x) as usize] = a.px[(sy * w + sx) as usize];
            }
        }
    }
    out
}

/// One line blurred by a box of `size` (centred; even sizes shifted by `shift`, as the specification pairs them).
fn box_line(line: &[f32], size: usize, shift: isize, out: &mut [f32]) {
    let n = line.len() as isize;
    let size = size as isize;
    let left = (size / 2 + shift - if size % 2 == 0 { 1 } else { 0 }).max(0);
    let at = |i: isize| {
        if i >= 0 && i < n {
            line[i as usize]
        } else {
            0.0
        }
    };
    let mut sum = 0.0f32;
    for i in -left..(size - left) {
        sum += at(i);
    }
    let k = 1.0 / size as f32;
    for i in 0..n {
        out[i as usize] = sum * k;
        sum += at(i + size - left) - at(i - left);
    }
}

fn gaussian_line(line: &[f32], kernel: &[f32], out: &mut [f32]) {
    let n = line.len() as isize;
    let r = (kernel.len() / 2) as isize;
    for i in 0..n {
        let mut s = 0.0f32;
        for (k, &weight) in kernel.iter().enumerate() {
            let j = i + k as isize - r;
            if j >= 0 && j < n {
                s += line[j as usize] * weight;
            }
        }
        out[i as usize] = s;
    }
}

/// Blurs one line by σ px: three box blurs of the specification's size d for σ ≥ 2 (d odd: three centred boxes; d
/// even: two shifted boxes and one of d + 1), an exact kernel below.
fn blur_line(line: &mut [f32], sigma: f64, tmp: &mut [f32]) {
    if sigma >= 2.0 {
        let d = (sigma * 3.0 * (2.0 * std::f64::consts::PI).sqrt() / 4.0 + 0.5).floor() as usize;
        let passes: [(usize, isize); 3] = if d % 2 == 1 {
            [(d, 0), (d, 0), (d, 0)]
        } else {
            [(d, 0), (d, 1), (d + 1, 0)]
        };
        for (size, shift) in passes {
            box_line(line, size, shift, tmp);
            line.copy_from_slice(tmp);
        }
    } else {
        let r = (sigma * 3.0).ceil() as usize;
        let mut kernel: Vec<f32> = (0..=2 * r)
            .map(|i| (-((i as f64 - r as f64).powi(2)) / (2.0 * sigma * sigma)).exp() as f32)
            .collect();
        let sum: f32 = kernel.iter().sum();
        for v in kernel.iter_mut() {
            *v /= sum;
        }
        gaussian_line(line, &kernel, tmp);
        line.copy_from_slice(tmp);
    }
}

fn blur(mut a: Image, sigma: f64) -> Image {
    if !(sigma > 0.0) {
        return a;
    }
    let (w, h) = (a.w, a.h);
    let mut plane = vec![0.0f32; w * h];
    let mut line = vec![0.0f32; w.max(h)];
    let mut tmp = vec![0.0f32; w.max(h)];
    for c in 0..4 {
        if a.px.iter().all(|p| p[c] == 0.0) {
            continue;
        }
        for (v, p) in plane.iter_mut().zip(&a.px) {
            *v = p[c];
        }
        for row in plane.chunks_exact_mut(w) {
            line[..w].copy_from_slice(row);
            blur_line(&mut line[..w], sigma, &mut tmp[..w]);
            row.copy_from_slice(&line[..w]);
        }
        for x in 0..w {
            for y in 0..h {
                line[y] = plane[y * w + x];
            }
            blur_line(&mut line[..h], sigma, &mut tmp[..h]);
            for y in 0..h {
                plane[y * w + x] = line[y];
            }
        }
        for (p, v) in a.px.iter_mut().zip(&plane) {
            p[c] = *v;
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_min_and_max() {
        let line = [0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0];
        let mut out = [0.0; 7];
        running(&line, 1, true, &mut out);
        assert_eq!(out, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
        running(&line, 1, false, &mut out);
        assert_eq!(out, [0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn blur_keeps_the_sum() {
        let mut line = vec![0.0f32; 64];
        line[32] = 1.0;
        let mut tmp = line.clone();
        blur_line(&mut line, 3.0, &mut tmp);
        let sum: f32 = line.iter().sum();
        assert!((sum - 1.0).abs() < 1e-4, "{sum}");
    }
}
