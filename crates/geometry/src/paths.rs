//! `shared/design/paths.ts`: reading and writing SVG path data, transforms, exact bounds, flattening,
//! hit testing, lengths, curve fitting and the anchor model. Same operations in the same order as the
//! TypeScript, so the numbers agree to the bit (trigonometry aside, see `js`).

use morfa_model::{CubicTo, Matrix, PathCommand, QuadTo, Vec2, VectorPath, WindingRule};

use crate::js;
use crate::matrix::Rect;

/// Four control points of a cubic Bézier.
pub type Cubic = [Vec2; 4];

/// A flattened subpath. Closed polylines do not repeat their first point at the end.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Polyline {
    pub points: Vec<Vec2>,
    pub closed: bool,
}

/// One drawn piece of a path. `index` is the command that draws it (a Z for a closing line, −1 for
/// the implicit closing line a fill adds to an open subpath). Quadratics come raised to cubics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathSegment {
    pub index: i64,
    pub subpath: i64,
    pub p0: Vec2,
    pub p1: Vec2,
    /// `Some([c1, c2])` for a cubic, `None` for a line.
    pub controls: Option<[Vec2; 2]>,
}

impl PathSegment {
    #[inline]
    pub fn is_cubic(&self) -> bool {
        self.controls.is_some()
    }
    /// The segment's cubic (a line as its thirds, `segmentCubic`).
    pub fn cubic(&self) -> Cubic {
        match self.controls {
            Some([c1, c2]) => [self.p0, c1, c2, self.p1],
            None => [
                self.p0,
                lerp(self.p0, self.p1, 1.0 / 3.0),
                lerp(self.p0, self.p1, 2.0 / 3.0),
                self.p1,
            ],
        }
    }
}

pub struct PathLimits {
    /// Commands one `d` attribute may produce; the rest is dropped, as after a syntax error.
    pub max_commands: usize,
    /// Points one flattening may produce; past it, curves are replaced by their chords.
    pub max_points: usize,
    /// Steps one curve may be cut into when flattening.
    pub max_curve_steps: f64,
}

pub const PATH_LIMITS: PathLimits = PathLimits {
    max_commands: 200_000,
    max_points: 2_000_000,
    max_curve_steps: 1024.0,
};

const EPSILON: f64 = 1e-9;

// ── Small vector helpers ───────────────────────────────────────────────────────────────────────

#[inline]
pub(crate) fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}
#[inline]
pub(crate) fn sub(a: Vec2, b: Vec2) -> Vec2 {
    v(a.x - b.x, a.y - b.y)
}
#[inline]
fn add(a: Vec2, b: Vec2) -> Vec2 {
    v(a.x + b.x, a.y + b.y)
}
#[inline]
fn scale(a: Vec2, s: f64) -> Vec2 {
    v(a.x * s, a.y * s)
}
#[inline]
pub(crate) fn lerp(a: Vec2, b: Vec2, t: f64) -> Vec2 {
    v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
}
#[inline]
fn dot(a: Vec2, b: Vec2) -> f64 {
    a.x * b.x + a.y * b.y
}
#[inline]
fn cross(a: Vec2, b: Vec2) -> f64 {
    a.x * b.y - a.y * b.x
}
#[inline]
fn length(a: Vec2) -> f64 {
    js::hypot(a.x, a.y)
}
#[inline]
fn distance(a: Vec2, b: Vec2) -> f64 {
    js::hypot(a.x - b.x, a.y - b.y)
}
#[inline]
pub(crate) fn same_point(a: Vec2, b: Vec2, eps: f64) -> bool {
    (a.x - b.x).abs() <= eps && (a.y - b.y).abs() <= eps
}
fn normalize(a: Vec2) -> Vec2 {
    let l = length(a);
    if l > 0.0 {
        v(a.x / l, a.y / l)
    } else {
        v(0.0, 0.0)
    }
}

/// The end point of a command (M, L, C, Q); `None` for Z.
#[inline]
pub fn end_point(c: &PathCommand) -> Option<Vec2> {
    match c {
        PathCommand::M(p) | PathCommand::L(p) => Some(*p),
        PathCommand::C(c) => Some(v(c.x, c.y)),
        PathCommand::Q(q) => Some(v(q.x, q.y)),
        PathCommand::Z => None,
    }
}

#[inline]
fn cmd_m(x: f64, y: f64) -> PathCommand {
    PathCommand::M(v(x, y))
}
#[inline]
fn cmd_l(x: f64, y: f64) -> PathCommand {
    PathCommand::L(v(x, y))
}
#[inline]
fn cmd_c(x1: f64, y1: f64, x2: f64, y2: f64, x: f64, y: f64) -> PathCommand {
    PathCommand::C(CubicTo {
        x1,
        y1,
        x2,
        y2,
        x,
        y,
    })
}
#[inline]
fn cmd_q(x1: f64, y1: f64, x: f64, y: f64) -> PathCommand {
    PathCommand::Q(QuadTo { x1, y1, x, y })
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────

/// What a byte (or decoded character) of path data is as a command letter.
fn command_letter(d: &str, i: usize) -> Option<(u8, bool, usize)> {
    let b = *d.as_bytes().get(i)?;
    if b < 0x80 {
        let upper = b.to_ascii_uppercase();
        return matches!(
            upper,
            b'M' | b'L' | b'H' | b'V' | b'C' | b'S' | b'Q' | b'T' | b'A' | b'Z'
        )
        .then_some((upper, b != upper, 1));
    }
    // `letter.toUpperCase()` maps U+017F LATIN SMALL LETTER LONG S to "S".
    let ch = d[i..].chars().next()?;
    (ch == '\u{17F}').then_some((b'S', true, ch.len_utf8()))
}

/// Reads SVG path data (the full grammar: M L H V C S Q T A Z, absolute and relative, implicit
/// repeats, numbers like "1e-3.5.5" or "-.5-.5", arc flags written without separators) into absolute
/// commands. Arcs become cubics; H/V become lines; S/T get their reflected control point. As SVG
/// renderers do, a syntax error ends the path and everything before it is kept.
pub fn parse_path_data(d: &str, max_commands: Option<usize>) -> Vec<PathCommand> {
    let max = max_commands.unwrap_or(PATH_LIMITS.max_commands);
    let bytes = d.as_bytes();
    let n = bytes.len();
    let at = |i: usize| -> u8 { if i < n { bytes[i] } else { 0 } };
    let mut out: Vec<PathCommand> = Vec::new();
    let mut i = 0usize;
    let (mut cx, mut cy, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut started = false;
    let mut closed = false;
    let mut last_cubic: Option<Vec2> = None;
    let mut last_quad: Option<Vec2> = None;

    let skip = |i: &mut usize| {
        while *i < n {
            let c = bytes[*i];
            if c == 32 || c == 9 || c == 10 || c == 13 || c == 12 || c == 44 {
                *i += 1;
            } else {
                break;
            }
        }
    };
    let starts_number = |i: usize| {
        let c = at(i);
        c.is_ascii_digit() || c == 46 || c == 43 || c == 45
    };
    let read_number = |i: &mut usize| -> f64 {
        skip(i);
        let start = *i;
        let mut c = at(*i);
        if c == 43 || c == 45 {
            *i += 1;
            c = at(*i);
        }
        let mut digits = 0;
        while c.is_ascii_digit() {
            *i += 1;
            c = at(*i);
            digits += 1;
        }
        if c == 46 {
            *i += 1;
            c = at(*i);
            while c.is_ascii_digit() {
                *i += 1;
                c = at(*i);
                digits += 1;
            }
        }
        if digits == 0 {
            *i = start;
            return f64::NAN;
        }
        if c == 101 || c == 69 {
            // An exponent only counts when digits follow; "1e" leaves the "e" for the next token.
            let mark = *i;
            *i += 1;
            c = at(*i);
            if c == 43 || c == 45 {
                *i += 1;
                c = at(*i);
            }
            if c.is_ascii_digit() {
                while c.is_ascii_digit() {
                    *i += 1;
                    c = at(*i);
                }
            } else {
                *i = mark;
            }
        }
        let value = parse_js_number(&d[start..*i]);
        if value.is_finite() { value } else { f64::NAN }
    };
    let read_flag = |i: &mut usize| -> f64 {
        skip(i);
        let c = at(*i);
        if c == 48 || c == 49 {
            *i += 1;
            return f64::from(c - 48);
        }
        f64::NAN
    };

    'parse: while out.len() < max {
        skip(&mut i);
        if i >= n {
            break;
        }
        let Some((upper, relative, width)) = command_letter(d, i) else {
            break;
        };
        i += width;
        if !started && upper != b'M' {
            break;
        }
        if upper == b'Z' {
            // "M x y Z" is kept: a dot under round caps, and its point counts for bounds.
            if out.last().is_some_and(|c| !matches!(c, PathCommand::Z)) {
                out.push(PathCommand::Z);
            }
            cx = sx;
            cy = sy;
            closed = true;
            last_cubic = None;
            last_quad = None;
            continue;
        }
        let mut command = upper;
        let mut first = true;
        while out.len() < max {
            if !first {
                skip(&mut i);
                if i >= n || !starts_number(i) {
                    break;
                }
            }
            let (ox, oy) = if relative { (cx, cy) } else { (0.0, 0.0) };
            // After a Z the next drawing command starts a new subpath at the old start point.
            macro_rules! begin_drawing {
                () => {
                    if closed {
                        out.push(cmd_m(sx, sy));
                        closed = false;
                    }
                };
            }
            match command {
                b'M' => {
                    let x = read_number(&mut i);
                    let y = read_number(&mut i);
                    if x.is_nan() || y.is_nan() {
                        break 'parse;
                    }
                    if matches!(out.last(), Some(PathCommand::M(_))) {
                        out.pop(); // consecutive movetos: only the last one counts
                    }
                    out.push(cmd_m(x + ox, y + oy));
                    cx = x + ox;
                    sx = cx;
                    cy = y + oy;
                    sy = cy;
                    started = true;
                    closed = false;
                    last_cubic = None;
                    last_quad = None;
                    command = b'L'; // further pairs are linetos
                }
                b'L' | b'H' | b'V' => {
                    let (mut x, mut y) = (cx, cy);
                    if command == b'L' {
                        x = read_number(&mut i) + ox;
                        y = read_number(&mut i) + oy;
                    } else if command == b'H' {
                        x = read_number(&mut i) + ox;
                    } else {
                        y = read_number(&mut i) + oy;
                    }
                    if x.is_nan() || y.is_nan() {
                        break 'parse;
                    }
                    begin_drawing!();
                    out.push(cmd_l(x, y));
                    cx = x;
                    cy = y;
                    last_cubic = None;
                    last_quad = None;
                }
                b'C' | b'S' => {
                    let (x1, y1);
                    if command == b'C' {
                        x1 = read_number(&mut i) + ox;
                        y1 = read_number(&mut i) + oy;
                    } else {
                        x1 = last_cubic.map_or(cx, |l| 2.0 * cx - l.x);
                        y1 = last_cubic.map_or(cy, |l| 2.0 * cy - l.y);
                    }
                    let x2 = read_number(&mut i) + ox;
                    let y2 = read_number(&mut i) + oy;
                    let x = read_number(&mut i) + ox;
                    let y = read_number(&mut i) + oy;
                    if [x1, y1, x2, y2, x, y].iter().any(|v| v.is_nan()) {
                        break 'parse;
                    }
                    begin_drawing!();
                    out.push(cmd_c(x1, y1, x2, y2, x, y));
                    cx = x;
                    cy = y;
                    last_cubic = Some(v(x2, y2));
                    last_quad = None;
                }
                b'Q' | b'T' => {
                    let (x1, y1);
                    if command == b'Q' {
                        x1 = read_number(&mut i) + ox;
                        y1 = read_number(&mut i) + oy;
                    } else {
                        x1 = last_quad.map_or(cx, |l| 2.0 * cx - l.x);
                        y1 = last_quad.map_or(cy, |l| 2.0 * cy - l.y);
                    }
                    let x = read_number(&mut i) + ox;
                    let y = read_number(&mut i) + oy;
                    if [x1, y1, x, y].iter().any(|v| v.is_nan()) {
                        break 'parse;
                    }
                    begin_drawing!();
                    out.push(cmd_q(x1, y1, x, y));
                    cx = x;
                    cy = y;
                    last_quad = Some(v(x1, y1));
                    last_cubic = None;
                }
                _ => {
                    // 'A'
                    let rx = read_number(&mut i);
                    let ry = read_number(&mut i);
                    let rotation = read_number(&mut i);
                    let large = read_flag(&mut i);
                    let sweep = read_flag(&mut i);
                    let x = read_number(&mut i) + ox;
                    let y = read_number(&mut i) + oy;
                    if [rx, ry, rotation, large, sweep, x, y]
                        .iter()
                        .any(|v| v.is_nan())
                    {
                        break 'parse;
                    }
                    begin_drawing!();
                    for piece in svg_arc_to_cubics(
                        v(cx, cy),
                        rx,
                        ry,
                        rotation,
                        large == 1.0,
                        sweep == 1.0,
                        v(x, y),
                    ) {
                        out.push(match piece {
                            ArcPiece::Line(_, b) => cmd_l(b.x, b.y),
                            ArcPiece::Cubic(c) => {
                                cmd_c(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y)
                            }
                        });
                    }
                    cx = x;
                    cy = y;
                    last_cubic = None;
                    last_quad = None;
                }
            }
            first = false;
        }
    }
    // A trailing moveto draws nothing.
    if matches!(out.last(), Some(PathCommand::M(_))) {
        out.pop();
    }
    out
}

/// `Number(text)` for the numerals `parsePathData` slices out (sign, digits, dot, exponent).
fn parse_js_number(text: &str) -> f64 {
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// A piece of an endpoint arc: the straight line of a zero radius, or a cubic.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ArcPiece {
    Line(Vec2, Vec2),
    Cubic(Cubic),
}

/// An SVG endpoint arc (the A command) as cubics, each piece at most a quarter turn (SVG 1.1
/// implementation notes F.6.5–F.6.6, radii scaled up when too small). A zero radius gives the straight
/// line, returned as a two-point piece; equal endpoints give nothing.
pub fn svg_arc_to_cubics(
    from: Vec2,
    rx: f64,
    ry: f64,
    rotation_degrees: f64,
    large_arc: bool,
    sweep: bool,
    to: Vec2,
) -> Vec<ArcPiece> {
    if same_point(from, to, 0.0) {
        return Vec::new();
    }
    let mut rx = rx.abs();
    let mut ry = ry.abs();
    if rx == 0.0 || ry == 0.0 || rx.is_nan() || ry.is_nan() {
        return vec![ArcPiece::Line(from, to)];
    }
    let phi = (rotation_degrees * std::f64::consts::PI) / 180.0;
    let cos = js::cos(phi);
    let sin = js::sin(phi);
    let dx2 = (from.x - to.x) / 2.0;
    let dy2 = (from.y - to.y) / 2.0;
    let x1p = cos * dx2 + sin * dy2;
    let y1p = -sin * dx2 + cos * dy2;
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let rx2 = rx * rx;
    let ry2 = ry * ry;
    let numerator = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
    let denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
    let coef = (if large_arc != sweep { 1.0 } else { -1.0 })
        * js::max(0.0, numerator / denominator).sqrt();
    let cxp = (coef * rx * y1p) / ry;
    let cyp = (-coef * ry * x1p) / rx;
    let center = v(
        cos * cxp - sin * cyp + (from.x + to.x) / 2.0,
        sin * cxp + cos * cyp + (from.y + to.y) / 2.0,
    );
    let ux = (x1p - cxp) / rx;
    let uy = (y1p - cyp) / ry;
    let vx = (-x1p - cxp) / rx;
    let vy = (-y1p - cyp) / ry;
    let theta1 = js::atan2(uy, ux);
    let mut delta = js::atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if !sweep && delta > 0.0 {
        delta -= 2.0 * std::f64::consts::PI;
    } else if sweep && delta < 0.0 {
        delta += 2.0 * std::f64::consts::PI;
    }
    let mut pieces = ellipse_arc_cubics(center, rx, ry, phi, theta1, delta);
    // Pin the ends exactly, so the next command starts where this one stopped.
    if let Some(first) = pieces.first_mut() {
        first[0] = from;
    }
    if let Some(last) = pieces.last_mut() {
        last[3] = to;
    }
    pieces.into_iter().map(ArcPiece::Cubic).collect()
}

/// An elliptical arc around `center` as cubics of at most a quarter turn each. Angles are radians
/// clockwise on screen (y down) from the ellipse's x axis, which is turned by `rotation`.
pub fn ellipse_arc_cubics(
    center: Vec2,
    rx: f64,
    ry: f64,
    rotation: f64,
    start: f64,
    sweep: f64,
) -> Vec<Cubic> {
    if sweep == 0.0 || !sweep.is_finite() {
        return Vec::new();
    }
    let count = js::max(
        1.0,
        (sweep.abs() / (std::f64::consts::PI / 2.0) - 1e-9).ceil(),
    );
    let step = sweep / count;
    let k = (4.0 / 3.0) * js::tan(step / 4.0);
    let cos = js::cos(rotation);
    let sin = js::sin(rotation);
    let map = |u: f64, w: f64| {
        v(
            center.x + rx * u * cos - ry * w * sin,
            center.y + rx * u * sin + ry * w * cos,
        )
    };
    let mut out = Vec::new();
    let mut s = 0.0;
    while s < count {
        let a = start + s * step;
        let b = a + step;
        let (ca, sa, cb, sb) = (js::cos(a), js::sin(a), js::cos(b), js::sin(b));
        out.push([
            map(ca, sa),
            map(ca - k * sa, sa + k * ca),
            map(cb + k * sb, sb - k * cb),
            map(cb, sb),
        ]);
        s += 1.0;
    }
    out
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────

/// A number for SVG or CSS output: rounded to `precision` decimals, no "-0", no exponent for small values.
pub fn format_number(value: f64, precision: i32) -> String {
    if !value.is_finite() {
        return "0".to_owned();
    }
    let factor = js::pow(10.0, f64::from(precision));
    let rounded = js::round(value * factor) / factor;
    if rounded == 0.0 {
        return "0".to_owned();
    }
    let text = js::number_to_string(rounded);
    if text.contains("e-") {
        let mut fixed = js::to_fixed(rounded, precision.max(0) as usize);
        // .replace(/\.?0+$/, '')
        let trimmed = fixed.trim_end_matches('0').len();
        if trimmed < fixed.len() {
            fixed.truncate(trimmed);
            if fixed.ends_with('.') {
                fixed.pop();
            }
        }
        fixed
    } else {
        text
    }
}

/// Compact SVG path data ("M0 0L10 0C…Z") with `precision` decimals.
pub fn serialize_path_data(commands: &[PathCommand], precision: i32) -> String {
    let f = |v: f64| format_number(v, precision);
    let mut out = String::new();
    for c in commands {
        match c {
            PathCommand::M(p) => {
                out.push('M');
                out += &f(p.x);
                out.push(' ');
                out += &f(p.y);
            }
            PathCommand::L(p) => {
                out.push('L');
                out += &f(p.x);
                out.push(' ');
                out += &f(p.y);
            }
            PathCommand::C(c) => {
                out.push('C');
                for (k, value) in [c.x1, c.y1, c.x2, c.y2, c.x, c.y].into_iter().enumerate() {
                    if k > 0 {
                        out.push(' ');
                    }
                    out += &f(value);
                }
            }
            PathCommand::Q(q) => {
                out.push('Q');
                for (k, value) in [q.x1, q.y1, q.x, q.y].into_iter().enumerate() {
                    if k > 0 {
                        out.push(' ');
                    }
                    out += &f(value);
                }
            }
            PathCommand::Z => out.push('Z'),
        }
    }
    out
}

// ── Transforms and structure ───────────────────────────────────────────────────────────────────

#[inline]
fn apply_matrix(m: &Matrix, x: f64, y: f64) -> Vec2 {
    v(
        m[0][0] * x + m[0][1] * y + m[0][2],
        m[1][0] * x + m[1][1] * y + m[1][2],
    )
}

/// Every point of the path mapped by `matrix` (affine maps keep Béziers Béziers, so this is exact).
pub fn transform_path(commands: &[PathCommand], matrix: &Matrix) -> Vec<PathCommand> {
    commands
        .iter()
        .map(|c| match c {
            PathCommand::M(p) => PathCommand::M(apply_matrix(matrix, p.x, p.y)),
            PathCommand::L(p) => PathCommand::L(apply_matrix(matrix, p.x, p.y)),
            PathCommand::C(c) => {
                let p1 = apply_matrix(matrix, c.x1, c.y1);
                let p2 = apply_matrix(matrix, c.x2, c.y2);
                let p = apply_matrix(matrix, c.x, c.y);
                cmd_c(p1.x, p1.y, p2.x, p2.y, p.x, p.y)
            }
            PathCommand::Q(q) => {
                let p1 = apply_matrix(matrix, q.x1, q.y1);
                let p = apply_matrix(matrix, q.x, q.y);
                cmd_q(p1.x, p1.y, p.x, p.y)
            }
            PathCommand::Z => PathCommand::Z,
        })
        .collect()
}

pub fn transform_paths(paths: &[VectorPath], matrix: &Matrix) -> Vec<VectorPath> {
    paths
        .iter()
        .map(|p| VectorPath {
            winding_rule: p.winding_rule,
            commands: transform_path(&p.commands, matrix),
        })
        .collect()
}

/// The path split at its movetos; each piece starts with M. Drawing before the first M is dropped.
pub fn subpaths(commands: &[PathCommand]) -> Vec<&[PathCommand]> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (k, c) in commands.iter().enumerate() {
        if matches!(c, PathCommand::M(_)) {
            if let Some(s) = start {
                out.push(&commands[s..k]);
            }
            start = Some(k);
        }
    }
    if let Some(s) = start {
        out.push(&commands[s..]);
    }
    out
}

/// True when the path has at least one subpath and every subpath ends with Z.
pub fn is_closed(commands: &[PathCommand]) -> bool {
    let parts = subpaths(commands);
    !parts.is_empty()
        && parts
            .iter()
            .all(|p| matches!(p.last(), Some(PathCommand::Z)))
}

#[inline]
pub(crate) fn quad_to_cubic(p0: Vec2, q: Vec2, p1: Vec2) -> Cubic {
    [p0, lerp(p0, q, 2.0 / 3.0), lerp(p1, q, 2.0 / 3.0), p1]
}

/// The drawn segments in order. With `close_open`, open subpaths get the closing line a fill adds.
pub fn path_segments(commands: &[PathCommand], close_open: bool) -> Vec<PathSegment> {
    let mut out = Vec::new();
    for_each_segment(commands, close_open, |s| out.push(s));
    out
}

/// `pathSegments` without the list: calls `visit` with each segment in order.
pub fn for_each_segment(
    commands: &[PathCommand],
    close_open: bool,
    mut visit: impl FnMut(PathSegment),
) {
    let mut current: Option<Vec2> = None;
    let mut start: Option<Vec2> = None;
    let mut subpath: i64 = -1;
    let mut drawn = false;
    let mut open = false;
    let line = |index: i64, subpath: i64, p0: Vec2, p1: Vec2| PathSegment {
        index,
        subpath,
        p0,
        p1,
        controls: None,
    };
    for (index, c) in commands.iter().enumerate() {
        let index = index as i64;
        if let PathCommand::M(p) = c {
            if close_open && open {
                if let (Some(cur), Some(st)) = (current, start) {
                    if !same_point(cur, st, 0.0) {
                        visit(line(-1, subpath, cur, st));
                    }
                }
            }
            current = Some(*p);
            start = Some(*p);
            subpath += 1;
            drawn = false;
            open = true;
            continue;
        }
        let (Some(cur), Some(st)) = (current, start) else {
            continue;
        };
        match c {
            PathCommand::L(p) => {
                visit(line(index, subpath, cur, *p));
                current = Some(*p);
            }
            PathCommand::C(k) => {
                let p1 = v(k.x, k.y);
                visit(PathSegment {
                    index,
                    subpath,
                    p0: cur,
                    p1,
                    controls: Some([v(k.x1, k.y1), v(k.x2, k.y2)]),
                });
                current = Some(p1);
            }
            PathCommand::Q(q) => {
                let [p0, c1, c2, p1] = quad_to_cubic(cur, v(q.x1, q.y1), v(q.x, q.y));
                visit(PathSegment {
                    index,
                    subpath,
                    p0,
                    p1,
                    controls: Some([c1, c2]),
                });
                current = Some(p1);
            }
            PathCommand::Z => {
                if !same_point(cur, st, 0.0) || !drawn {
                    visit(line(index, subpath, cur, st));
                }
                current = Some(st);
                open = false;
            }
            PathCommand::M(_) => unreachable!(),
        }
        drawn = true;
    }
    if close_open && open {
        if let (Some(cur), Some(st)) = (current, start) {
            if !same_point(cur, st, 0.0) {
                visit(line(-1, subpath, cur, st));
            }
        }
    }
}

/// Each subpath drawn the other way round; closed subpaths stay closed and keep their start point.
pub fn reverse_path(commands: &[PathCommand]) -> Vec<PathCommand> {
    let mut out = Vec::new();
    for part in subpaths(commands) {
        let closed = matches!(part.last(), Some(PathCommand::Z));
        let start = end_point(&part[0]).unwrap_or(v(0.0, 0.0));
        let mut pieces: Vec<(Vec2, PathCommand)> = Vec::new();
        let mut current = start;
        for c in &part[1..] {
            if matches!(c, PathCommand::Z) {
                break;
            }
            pieces.push((current, *c));
            current = end_point(c).unwrap_or(current);
        }
        let mut reversed = Vec::with_capacity(pieces.len());
        for (from, command) in pieces.iter().rev() {
            reversed.push(match command {
                PathCommand::C(c) => cmd_c(c.x2, c.y2, c.x1, c.y1, from.x, from.y),
                PathCommand::Q(q) => cmd_q(q.x1, q.y1, from.x, from.y),
                _ => cmd_l(from.x, from.y),
            });
        }
        if closed {
            out.push(cmd_m(start.x, start.y));
            // The implicit closing line becomes the first segment of the reversed loop.
            if !same_point(current, start, 0.0) {
                out.push(cmd_l(current.x, current.y));
            }
            out.extend(reversed);
            out.push(PathCommand::Z);
        } else {
            out.push(cmd_m(current.x, current.y));
            out.extend(reversed);
        }
    }
    out
}

// ── Curve evaluation ───────────────────────────────────────────────────────────────────────────

#[inline]
pub fn cubic_point(c: &Cubic, t: f64) -> Vec2 {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let b = 3.0 * mt * mt * t;
    let d = 3.0 * mt * t * t;
    let e = t * t * t;
    v(
        a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
        a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
    )
}

#[inline]
pub fn cubic_derivative(c: &Cubic, t: f64) -> Vec2 {
    let mt = 1.0 - t;
    let a = 3.0 * mt * mt;
    let b = 6.0 * mt * t;
    let d = 3.0 * t * t;
    v(
        a * (c[1].x - c[0].x) + b * (c[2].x - c[1].x) + d * (c[3].x - c[2].x),
        a * (c[1].y - c[0].y) + b * (c[2].y - c[1].y) + d * (c[3].y - c[2].y),
    )
}

/// De Casteljau split of a cubic at `t`.
pub fn split_cubic_at(c: &Cubic, t: f64) -> (Cubic, Cubic) {
    let p01 = lerp(c[0], c[1], t);
    let p12 = lerp(c[1], c[2], t);
    let p23 = lerp(c[2], c[3], t);
    let p012 = lerp(p01, p12, t);
    let p123 = lerp(p12, p23, t);
    let mid = lerp(p012, p123, t);
    ([c[0], p01, p012, mid], [mid, p123, p23, c[3]])
}

/// The piece of a cubic between t0 and t1 (reversed when t1 < t0).
pub fn sub_cubic(c: &Cubic, t0: f64, t1: f64) -> Cubic {
    if t1 < t0 {
        let r = sub_cubic(c, t1, t0);
        return [r[3], r[2], r[1], r[0]];
    }
    if t0 <= 0.0 && t1 >= 1.0 {
        return *c;
    }
    let mut right = if t0 > 0.0 {
        split_cubic_at(c, t0).1
    } else {
        *c
    };
    if t1 < 1.0 {
        right = split_cubic_at(
            &right,
            if t0 >= 1.0 {
                0.0
            } else {
                (t1 - t0) / (1.0 - t0)
            },
        )
        .0;
    }
    right
}

/// Roots of a·t² + b·t + c in the open interval (0, 1), sorted (at most two).
fn unit_quadratic_roots(a: f64, b: f64, c: f64) -> ([f64; 2], usize) {
    let mut roots = [0.0; 2];
    let mut count = 0;
    let mut keep = |t: f64| {
        if t > 1e-12 && t < 1.0 - 1e-12 {
            roots[count] = t;
            count += 1;
        }
    };
    let scale_of = js::max(js::max(a.abs(), b.abs()), c.abs());
    if scale_of == 0.0 || scale_of.is_nan() {
        return (roots, 0);
    }
    if a.abs() < scale_of * 1e-12 {
        if b != 0.0 && !b.is_nan() {
            keep(-c / b);
        }
        return (roots, count);
    }
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return (roots, 0);
    }
    let sq = disc.sqrt();
    // The numerically stable pair of roots.
    let q = -0.5 * (b + if b < 0.0 { -sq } else { sq });
    keep(q / a);
    if q != 0.0 && !q.is_nan() {
        keep(c / q);
    }
    if count == 2 && roots[1] < roots[0] {
        roots.swap(0, 1);
    }
    (roots, count)
}

/// Parameters in (0, 1) where the cubic's x (`axis_y` false) or y turns.
fn cubic_extrema(c: &Cubic, axis_y: bool) -> ([f64; 2], usize) {
    let g = |p: Vec2| if axis_y { p.y } else { p.x };
    let (p0, p1, p2, p3) = (g(c[0]), g(c[1]), g(c[2]), g(c[3]));
    unit_quadratic_roots(
        3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3),
        6.0 * (p0 - 2.0 * p1 + p2),
        3.0 * (p1 - p0),
    )
}

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────

/// Exact bounds of what the path draws (curve extrema included, control points not), or None when it
/// draws nothing. A lone moveto adds nothing; "M x y Z" adds its point.
pub fn path_bounds(commands: &[PathCommand]) -> Option<Rect> {
    let mut b = Bounds::EMPTY;
    let (mut cx, mut cy, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut pending = false;
    let mut started = false;
    for c in commands {
        match c {
            PathCommand::M(p) => {
                cx = p.x;
                sx = p.x;
                cy = p.y;
                sy = p.y;
                pending = true;
                started = true;
            }
            PathCommand::L(p) => {
                if !started {
                    continue;
                }
                if pending {
                    b.add(cx, cy);
                    pending = false;
                }
                b.add(p.x, p.y);
                cx = p.x;
                cy = p.y;
            }
            PathCommand::Q(_) | PathCommand::C(_) => {
                if !started {
                    continue;
                }
                if pending {
                    b.add(cx, cy);
                    pending = false;
                }
                // Raised to a cubic (exact), then the extrema of each axis.
                let (x1, y1, x2, y2, x, y) = match c {
                    PathCommand::C(k) => (k.x1, k.y1, k.x2, k.y2, k.x, k.y),
                    PathCommand::Q(q) => (
                        cx + (2.0 / 3.0) * (q.x1 - cx),
                        cy + (2.0 / 3.0) * (q.y1 - cy),
                        q.x + (2.0 / 3.0) * (q.x1 - q.x),
                        q.y + (2.0 / 3.0) * (q.y1 - q.y),
                        q.x,
                        q.y,
                    ),
                    _ => unreachable!(),
                };
                b.add(x, y);
                if x1 < b.min_x || x1 > b.max_x || x2 < b.min_x || x2 > b.max_x {
                    let (roots, n) = axis_roots(cx, x1, x2, x);
                    for &t in &roots[..n] {
                        let value = axis_value(cx, x1, x2, x, t);
                        b.add(value, cy);
                    }
                }
                if y1 < b.min_y || y1 > b.max_y || y2 < b.min_y || y2 > b.max_y {
                    let (roots, n) = axis_roots(cy, y1, y2, y);
                    for &t in &roots[..n] {
                        let value = axis_value(cy, y1, y2, y, t);
                        b.add(cx, value);
                    }
                }
                cx = x;
                cy = y;
            }
            PathCommand::Z => {
                if !started {
                    continue;
                }
                if pending {
                    b.add(cx, cy);
                    pending = false;
                }
                cx = sx;
                cy = sy;
            }
        }
    }
    b.rect()
}

#[inline]
fn axis_roots(p0: f64, p1: f64, p2: f64, p3: f64) -> ([f64; 2], usize) {
    unit_quadratic_roots(
        3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3),
        6.0 * (p0 - 2.0 * p1 + p2),
        3.0 * (p1 - p0),
    )
}

#[inline]
fn axis_value(p0: f64, p1: f64, p2: f64, p3: f64, t: f64) -> f64 {
    let mt = 1.0 - t;
    mt * mt * mt * p0 + 3.0 * mt * mt * t * p1 + 3.0 * mt * t * t * p2 + t * t * t * p3
}

/// A running min/max box, as `pathBounds` keeps it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Bounds {
    pub const EMPTY: Bounds = Bounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    #[inline]
    pub fn add(&mut self, x: f64, y: f64) {
        if x < self.min_x {
            self.min_x = x;
        }
        if x > self.max_x {
            self.max_x = x;
        }
        if y < self.min_y {
            self.min_y = y;
        }
        if y > self.max_y {
            self.max_y = y;
        }
    }
    #[inline]
    pub fn rect(&self) -> Option<Rect> {
        (self.min_x <= self.max_x).then(|| {
            Rect::new(
                self.min_x,
                self.min_y,
                self.max_x - self.min_x,
                self.max_y - self.min_y,
            )
        })
    }
}

/// Bounds of several paths together, or None when none draws anything.
pub fn paths_bounds(paths: &[VectorPath]) -> Option<Rect> {
    let mut out: Option<Rect> = None;
    for path in paths {
        let Some(b) = path_bounds(&path.commands) else {
            continue;
        };
        out = Some(match out {
            None => b,
            Some(o) => {
                let x = js::min(o.x, b.x);
                let y = js::min(o.y, b.y);
                Rect::new(
                    x,
                    y,
                    js::max(o.x + o.width, b.x + b.width) - x,
                    js::max(o.y + o.height, b.y + b.height) - y,
                )
            }
        });
    }
    out
}

// ── Flattening ─────────────────────────────────────────────────────────────────────────────────

/// Total turning of the control polygon: an upper bound of how far the curve turns.
fn control_turn(c: &Cubic) -> f64 {
    let mut total = 0.0;
    let mut previous: Option<Vec2> = None;
    for k in 1..4 {
        let leg = sub(c[k], c[k - 1]);
        if length(leg) < EPSILON {
            continue;
        }
        if let Some(p) = previous {
            total += js::atan2(cross(p, leg), dot(p, leg)).abs();
        }
        previous = Some(leg);
    }
    total
}

/// How many equal parameter steps keep the chords of a cubic within `tolerance` of the curve (the
/// chord error of a uniform split is at most ¾·max|second difference|/n²), and with `max_angle`, also
/// keep each step's turn under it. A float, as in JS (NaN for non-finite curves).
pub fn cubic_steps(c: &Cubic, tolerance: f64, max_angle: f64) -> f64 {
    let d1 = js::hypot(
        c[0].x - 2.0 * c[1].x + c[2].x,
        c[0].y - 2.0 * c[1].y + c[2].y,
    );
    let d2 = js::hypot(
        c[1].x - 2.0 * c[2].x + c[3].x,
        c[1].y - 2.0 * c[2].y + c[3].y,
    );
    let mut steps = ((0.75 * js::max(d1, d2)) / js::max(tolerance, 1e-9))
        .sqrt()
        .ceil();
    if max_angle > 0.0 {
        steps = js::max(steps, (control_turn(c) / max_angle).ceil());
    }
    js::min(js::max(steps, 1.0), PATH_LIMITS.max_curve_steps)
}

/// Polylines within `tolerance` of the path, one per subpath. `max_angle` (radians, 0 for none) also
/// bounds how much the curve may turn between two points.
pub fn flatten_path(
    commands: &[PathCommand],
    tolerance: f64,
    max_angle: f64,
    max_points: Option<usize>,
) -> Vec<Polyline> {
    let budget = max_points.unwrap_or(PATH_LIMITS.max_points);
    let mut out: Vec<Polyline> = Vec::new();
    let mut line: Option<usize> = None;
    let mut total = 0usize;
    let mut last = v(0.0, 0.0);
    fn push(out: &mut [Polyline], line: Option<usize>, total: &mut usize, p: Vec2) {
        let Some(l) = line else { return };
        let points = &mut out[l].points;
        if let Some(&q) = points.last() {
            if same_point(q, p, 0.0) {
                return;
            }
        }
        points.push(p);
        *total += 1;
    }
    for c in commands {
        if let PathCommand::M(p) = c {
            out.push(Polyline::default());
            line = Some(out.len() - 1);
            last = *p;
            push(&mut out, line, &mut total, last);
            continue;
        }
        let Some(l) = line else { continue };
        if matches!(c, PathCommand::Z) {
            out[l].closed = true;
            last = out[l].points[0];
            continue;
        }
        if out[l].closed {
            // Drawing after Z without a moveto (not produced by the parser): continue from the start.
            out.push(Polyline::default());
            line = Some(out.len() - 1);
            push(&mut out, line, &mut total, last);
        }
        let cubic: Cubic = match c {
            PathCommand::L(p) => {
                last = *p;
                push(&mut out, line, &mut total, last);
                continue;
            }
            PathCommand::C(k) => [last, v(k.x1, k.y1), v(k.x2, k.y2), v(k.x, k.y)],
            PathCommand::Q(q) => quad_to_cubic(last, v(q.x1, q.y1), v(q.x, q.y)),
            _ => unreachable!(),
        };
        let steps = if total > budget {
            1.0
        } else {
            cubic_steps(&cubic, tolerance, max_angle)
        };
        let mut k = 1.0;
        while k < steps {
            push(&mut out, line, &mut total, cubic_point(&cubic, k / steps));
            k += 1.0;
        }
        last = cubic[3];
        push(&mut out, line, &mut total, last);
    }
    for polyline in &mut out {
        let points = &mut polyline.points;
        if polyline.closed
            && points.len() > 1
            && same_point(points[0], points[points.len() - 1], 0.0)
        {
            points.pop();
        }
    }
    out.retain(|p| !p.points.is_empty());
    out
}

// ── Hit testing ────────────────────────────────────────────────────────────────────────────────

/// Winding number of the path around `point`. Open subpaths are closed as a fill closes them. Curves
/// are split where y turns and each monotonic piece is solved exactly.
pub fn winding_number(commands: &[PathCommand], point: Vec2) -> i64 {
    let mut winding = 0i64;
    let (px, py) = (point.x, point.y);
    for_each_segment(commands, true, |s| {
        let Some([c1, c2]) = s.controls else {
            let (a, b) = (s.p0, s.p1);
            if a.y <= py {
                if b.y > py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) > 0.0 {
                    winding += 1;
                }
            } else if b.y <= py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) < 0.0 {
                winding -= 1;
            }
            return;
        };
        let c: Cubic = [s.p0, c1, c2, s.p1];
        let min_y = js::min(js::min(c[0].y, c[1].y), js::min(c[2].y, c[3].y));
        let max_y = js::max(js::max(c[0].y, c[1].y), js::max(c[2].y, c[3].y));
        // Entirely on one side of the ray, or entirely to its left: no crossing.
        if py < min_y || py >= max_y {
            return;
        }
        if js::max(js::max(c[0].x, c[1].x), js::max(c[2].x, c[3].x)) < px {
            return;
        }
        let (roots, n) = cubic_extrema(&c, true);
        let mut cuts = [0.0; 4];
        cuts[1..1 + n].copy_from_slice(&roots[..n]);
        cuts[n + 1] = 1.0;
        for k in 1..n + 2 {
            let mut t0 = cuts[k - 1];
            let mut t1 = cuts[k];
            let y0 = cubic_point(&c, t0).y;
            let y1 = cubic_point(&c, t1).y;
            let upward = y0 <= py && y1 > py;
            let downward = y1 <= py && y0 > py;
            if !upward && !downward {
                continue;
            }
            // Bisection on the monotonic piece for the crossing.
            let mut iteration = 0;
            while iteration < 60 && t1 - t0 > 1e-13 {
                let mid = (t0 + t1) / 2.0;
                let y = cubic_point(&c, mid).y;
                if (y <= py) == upward {
                    t0 = mid;
                } else {
                    t1 = mid;
                }
                iteration += 1;
            }
            if cubic_point(&c, (t0 + t1) / 2.0).x > px {
                winding += if upward { 1 } else { -1 };
            }
        }
    });
    winding
}

/// Whether the fill of `commands` under `winding_rule` covers `point`.
pub fn point_in_path(commands: &[PathCommand], point: Vec2, winding_rule: WindingRule) -> bool {
    let w = winding_number(commands, point);
    // JS `w & 1` on a two's complement int32.
    if winding_rule == WindingRule::Evenodd {
        (w & 1) == 1
    } else {
        w != 0
    }
}

/// Whether any of the paths, each with its own winding rule, covers `point`.
pub fn point_in_paths(paths: &[VectorPath], point: Vec2) -> bool {
    paths
        .iter()
        .any(|p| point_in_path(&p.commands, point, p.winding_rule))
}

/// The nearest point of the drawn outline: its distance, the command drawing it, and the curve parameter.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathHit {
    pub distance: f64,
    pub index: i64,
    pub t: f64,
    pub point: Vec2,
}

/// Nearest point on what the path strokes (closing lines of Z included, implicit fill closings not).
pub fn distance_to_path(commands: &[PathCommand], point: Vec2) -> Option<PathHit> {
    let mut best: Option<PathHit> = None;
    let mut consider = |index: i64, t: f64, p: Vec2| {
        let d = distance(p, point);
        if best.is_none_or(|b| d < b.distance) {
            best = Some(PathHit {
                distance: d,
                index,
                t,
                point: p,
            });
        }
    };
    for_each_segment(commands, false, |s| {
        let Some([c1, c2]) = s.controls else {
            let d = sub(s.p1, s.p0);
            let len2 = dot(d, d);
            let t = if len2 != 0.0 && !len2.is_nan() {
                js::max(0.0, js::min(1.0, dot(sub(point, s.p0), d) / len2))
            } else {
                0.0
            };
            consider(s.index, t, lerp(s.p0, s.p1, t));
            return;
        };
        let c: Cubic = [s.p0, c1, c2, s.p1];
        let samples = 16.0;
        let mut best_t = 0.0;
        let mut best_d = f64::INFINITY;
        let mut k = 0.0;
        while k <= samples {
            let t = k / samples;
            let d = distance(cubic_point(&c, t), point);
            if d < best_d {
                best_d = d;
                best_t = t;
            }
            k += 1.0;
        }
        // Golden-section refinement around the best sample.
        let mut lo = js::max(0.0, best_t - 1.0 / samples);
        let mut hi = js::min(1.0, best_t + 1.0 / samples);
        let ratio = (5.0f64.sqrt() - 1.0) / 2.0;
        let mut a = hi - ratio * (hi - lo);
        let mut b = lo + ratio * (hi - lo);
        let mut fa = distance(cubic_point(&c, a), point);
        let mut fb = distance(cubic_point(&c, b), point);
        for _ in 0..40 {
            if fa < fb {
                hi = b;
                b = a;
                fb = fa;
                a = hi - ratio * (hi - lo);
                fa = distance(cubic_point(&c, a), point);
            } else {
                lo = a;
                a = b;
                fa = fb;
                b = lo + ratio * (hi - lo);
                fb = distance(cubic_point(&c, b), point);
            }
        }
        let t = (lo + hi) / 2.0;
        let p = cubic_point(&c, t);
        if distance(p, point) <= best_d {
            consider(s.index, t, p);
        } else {
            consider(s.index, best_t, cubic_point(&c, best_t));
        }
    });
    best
}

// ── Lengths ────────────────────────────────────────────────────────────────────────────────────

const GAUSS_NODES: [f64; 5] = [
    -0.906179845938664,
    -0.5384693101056831,
    0.0,
    0.5384693101056831,
    0.906179845938664,
];
const GAUSS_WEIGHTS: [f64; 5] = [
    0.2369268850561891,
    0.4786286704993665,
    0.5688888888888889,
    0.4786286704993665,
    0.2369268850561891,
];

/// Arc length of a cubic between two parameters: 5-point Gauss–Legendre on 8 pieces.
pub fn cubic_length(c: &Cubic, t0: f64, t1: f64) -> f64 {
    let pieces = 8.0;
    let h = (t1 - t0) / pieces;
    let mut total = 0.0;
    let mut piece = 0.0;
    while piece < pieces {
        let a = t0 + piece * h;
        for k in 0..5 {
            total += GAUSS_WEIGHTS[k]
                * length(cubic_derivative(c, a + (h * (GAUSS_NODES[k] + 1.0)) / 2.0));
        }
        piece += 1.0;
    }
    (total * h) / 2.0
}

fn segment_length(s: &PathSegment) -> f64 {
    match s.controls {
        None => distance(s.p0, s.p1),
        Some([c1, c2]) => cubic_length(&[s.p0, c1, c2, s.p1], 0.0, 1.0),
    }
}

/// Length of everything the path strokes.
pub fn path_length(commands: &[PathCommand]) -> f64 {
    let mut sum = 0.0;
    for_each_segment(commands, false, |s| sum += segment_length(&s));
    sum
}

/// A point along the stroked outline, with the unit tangent there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointAlong {
    pub point: Vec2,
    pub tangent: Vec2,
    pub index: i64,
    pub t: f64,
}

/// The point `distance_along` from the start of the stroked outline, with the unit tangent there;
/// clamped to the ends. None for a path that draws nothing.
pub fn point_at_length(commands: &[PathCommand], distance_along: f64) -> Option<PointAlong> {
    let segments = path_segments(commands, false);
    if segments.is_empty() {
        return None;
    }
    let mut remaining = js::max(0.0, distance_along);
    for (k, s) in segments.iter().enumerate() {
        let len = segment_length(s);
        if remaining > len && k < segments.len() - 1 {
            remaining -= len;
            continue;
        }
        let Some([c1, c2]) = s.controls else {
            let t = if len != 0.0 && !len.is_nan() {
                js::min(1.0, remaining / len)
            } else {
                1.0
            };
            return Some(PointAlong {
                point: lerp(s.p0, s.p1, t),
                tangent: normalize(sub(s.p1, s.p0)),
                index: s.index,
                t,
            });
        };
        let c: Cubic = [s.p0, c1, c2, s.p1];
        let mut lo = 0.0;
        let mut hi = 1.0;
        if remaining >= len {
            lo = 1.0;
            hi = 1.0;
        } else {
            for _ in 0..40 {
                let mid = (lo + hi) / 2.0;
                if cubic_length(&c, 0.0, mid) < remaining {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
        }
        let t = (lo + hi) / 2.0;
        return Some(PointAlong {
            point: cubic_point(&c, t),
            tangent: cubic_tangent(&c, t),
            index: s.index,
            t,
        });
    }
    None
}

/// Unit tangent of a cubic at t, falling back to the control polygon where the derivative vanishes.
pub fn cubic_tangent(c: &Cubic, t: f64) -> Vec2 {
    let d = cubic_derivative(c, t);
    if length(d) > EPSILON {
        return normalize(d);
    }
    if t < 0.5 {
        for p in [c[1], c[2], c[3]] {
            if !same_point(p, c[0], EPSILON) {
                return normalize(sub(p, c[0]));
            }
        }
    } else {
        for p in [c[2], c[1], c[0]] {
            if !same_point(p, c[3], EPSILON) {
                return normalize(sub(c[3], p));
            }
        }
    }
    v(1.0, 0.0)
}

// ── Anchors (pen and vector editing) ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorKind {
    Corner,
    Smooth,
    Mirrored,
}

/// An editable point. Handles are absolute positions; None means no handle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub r#in: Option<Vec2>,
    pub out: Option<Vec2>,
    pub kind: AnchorKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnchorPath {
    pub anchors: Vec<Anchor>,
    pub closed: bool,
}

/// The kind the handles of an anchor describe.
pub fn anchor_kind(a: &Anchor) -> AnchorKind {
    let (Some(i), Some(o)) = (a.r#in, a.out) else {
        return AnchorKind::Corner;
    };
    let at = v(a.x, a.y);
    let u = sub(i, at);
    let w = sub(o, at);
    let lu = length(u);
    let lv = length(w);
    if lu < EPSILON || lv < EPSILON {
        return AnchorKind::Corner;
    }
    let sine = cross(u, w) / (lu * lv);
    if sine.abs() > 1e-3 || dot(u, w) > 0.0 {
        return AnchorKind::Corner;
    }
    if (lu - lv).abs() <= js::max(1e-6, 1e-4 * js::max(lu, lv)) {
        AnchorKind::Mirrored
    } else {
        AnchorKind::Smooth
    }
}

/// The path as anchors with handles, one list per subpath.
pub fn path_to_anchors(commands: &[PathCommand]) -> Vec<AnchorPath> {
    let mut out = Vec::new();
    for part in subpaths(commands) {
        let m = end_point(&part[0]).unwrap_or(v(0.0, 0.0));
        let mut anchors = vec![Anchor {
            x: m.x,
            y: m.y,
            r#in: None,
            out: None,
            kind: AnchorKind::Corner,
        }];
        let mut closed = false;
        for c in &part[1..] {
            let last = *anchors.last().unwrap_or(&anchors[0]);
            let lastv = v(last.x, last.y);
            let (c1, c2, p) = match c {
                PathCommand::Z => {
                    closed = true;
                    break;
                }
                PathCommand::M(_) => continue,
                PathCommand::C(k) => (Some(v(k.x1, k.y1)), Some(v(k.x2, k.y2)), v(k.x, k.y)),
                PathCommand::Q(q) => {
                    let cubic = quad_to_cubic(lastv, v(q.x1, q.y1), v(q.x, q.y));
                    (Some(cubic[1]), Some(cubic[2]), v(q.x, q.y))
                }
                PathCommand::L(p) => (None, None, *p),
            };
            if let Some(c1) = c1 {
                if !same_point(c1, lastv, EPSILON) {
                    let n = anchors.len();
                    anchors[n - 1].out = Some(c1);
                }
            }
            let r#in = c2.filter(|c2| !same_point(*c2, p, EPSILON));
            anchors.push(Anchor {
                x: p.x,
                y: p.y,
                r#in,
                out: None,
                kind: AnchorKind::Corner,
            });
        }
        if closed && anchors.len() > 1 {
            let first = v(anchors[0].x, anchors[0].y);
            let last = anchors[anchors.len() - 1];
            if same_point(first, v(last.x, last.y), 1e-7) {
                anchors.pop();
                anchors[0].r#in = last.r#in;
            }
        }
        for a in &mut anchors {
            a.kind = anchor_kind(a);
        }
        out.push(AnchorPath { anchors, closed });
    }
    out
}

/// Path commands for anchor lists: a segment is a line when neither end has a handle on it.
pub fn anchors_to_path(paths: &[AnchorPath]) -> Vec<PathCommand> {
    let mut out = Vec::new();
    let segment = |out: &mut Vec<PathCommand>, a: &Anchor, b: &Anchor| {
        if a.out.is_none() && b.r#in.is_none() {
            out.push(cmd_l(b.x, b.y));
        } else {
            let c1 = a.out.unwrap_or(v(a.x, a.y));
            let c2 = b.r#in.unwrap_or(v(b.x, b.y));
            out.push(cmd_c(c1.x, c1.y, c2.x, c2.y, b.x, b.y));
        }
    };
    for AnchorPath { anchors, closed } in paths {
        if anchors.is_empty() {
            continue;
        }
        out.push(cmd_m(anchors[0].x, anchors[0].y));
        for k in 1..anchors.len() {
            segment(&mut out, &anchors[k - 1], &anchors[k]);
        }
        if *closed {
            let last = &anchors[anchors.len() - 1];
            // A straight closing segment is the Z itself.
            if anchors.len() > 1 && (last.out.is_some() || anchors[0].r#in.is_some()) {
                segment(&mut out, last, &anchors[0]);
            }
            out.push(PathCommand::Z);
        }
    }
    out
}

/// Splits the segment drawn by `commands[segment_index]` at parameter `t`, without changing the shape.
pub fn insert_anchor_at(
    commands: &[PathCommand],
    segment_index: usize,
    t: f64,
) -> Vec<PathCommand> {
    let mut out = commands.to_vec();
    let Some(target) = commands.get(segment_index) else {
        return out;
    };
    if matches!(target, PathCommand::M(_)) {
        return out;
    }
    let t = js::max(0.0, js::min(1.0, t));
    let mut current = v(0.0, 0.0);
    let mut start = v(0.0, 0.0);
    for c in &commands[..segment_index] {
        match end_point(c) {
            None => current = start,
            Some(p) => {
                current = p;
                if matches!(c, PathCommand::M(_)) {
                    start = current;
                }
            }
        }
    }
    match target {
        PathCommand::L(p) => {
            let q = lerp(current, *p, t);
            out.splice(segment_index..segment_index + 1, [cmd_l(q.x, q.y), *target]);
        }
        PathCommand::C(k) => {
            let (left, right) =
                split_cubic_at(&[current, v(k.x1, k.y1), v(k.x2, k.y2), v(k.x, k.y)], t);
            out.splice(
                segment_index..segment_index + 1,
                [
                    cmd_c(
                        left[1].x, left[1].y, left[2].x, left[2].y, left[3].x, left[3].y,
                    ),
                    cmd_c(
                        right[1].x, right[1].y, right[2].x, right[2].y, right[3].x, right[3].y,
                    ),
                ],
            );
        }
        PathCommand::Q(q) => {
            let control = v(q.x1, q.y1);
            let end = v(q.x, q.y);
            let a = lerp(current, control, t);
            let b = lerp(control, end, t);
            let p = lerp(a, b, t);
            out.splice(
                segment_index..segment_index + 1,
                [cmd_q(a.x, a.y, p.x, p.y), cmd_q(b.x, b.y, end.x, end.y)],
            );
        }
        PathCommand::Z => {
            if !same_point(current, start, EPSILON) {
                let p = lerp(current, start, t);
                out.insert(segment_index, cmd_l(p.x, p.y));
            }
        }
        PathCommand::M(_) => {}
    }
    out
}

// ── Curve fitting ──────────────────────────────────────────────────────────────────────────────

/// Fits cubics through sampled points within `tolerance` (Schneider 1990).
pub fn fit_cubics(points: &[Vec2], tolerance: f64) -> Vec<Cubic> {
    let mut pts: Vec<Vec2> = Vec::with_capacity(points.len());
    for &p in points {
        if pts.last().is_none_or(|&q| !same_point(q, p, 1e-12)) {
            pts.push(p);
        }
    }
    if pts.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let n = pts.len();
    let start_tangent = end_tangent_of(pts[0], pts[1], pts.get(2).copied());
    let end_tangent = end_tangent_of(
        pts[n - 1],
        pts[n - 2],
        if n >= 3 { Some(pts[n - 3]) } else { None },
    );
    fit_range(
        &pts,
        0,
        n - 1,
        start_tangent,
        end_tangent,
        js::max(tolerance, 1e-6),
        &mut out,
        0,
    );
    out
}

fn end_tangent_of(p0: Vec2, p1: Vec2, p2: Option<Vec2>) -> Vec2 {
    let secant = normalize(sub(p1, p0));
    let Some(p2) = p2 else { return secant };
    let h1 = distance(p0, p1);
    let h2 = distance(p1, p2);
    if h1 < EPSILON || h2 < EPSILON {
        return secant;
    }
    let a = -(2.0 * h1 + h2) / (h1 * (h1 + h2));
    let b = (h1 + h2) / (h1 * h2);
    let c = -h1 / (h2 * (h1 + h2));
    let d = normalize(v(
        a * p0.x + b * p1.x + c * p2.x,
        a * p0.y + b * p1.y + c * p2.y,
    ));
    // Keep the estimate only when it agrees with the secant (no corner hiding at the end).
    if dot(d, secant) > 0.9 { d } else { secant }
}

#[allow(clippy::too_many_arguments)]
fn fit_range(
    pts: &[Vec2],
    first: usize,
    last: usize,
    tan1: Vec2,
    tan2: Vec2,
    error: f64,
    out: &mut Vec<Cubic>,
    depth: u32,
) {
    let p0 = pts[first];
    let p3 = pts[last];
    if last - first == 1 || depth > 32 {
        let dist = distance(p0, p3) / 3.0;
        out.push([
            p0,
            add(p0, scale(tan1, dist)),
            add(p3, scale(tan2, dist)),
            p3,
        ]);
        return;
    }
    let mut u = chord_parameters(pts, first, last);
    let mut bezier = generate_bezier(pts, first, last, &u, tan1, tan2);
    let (mut max_error, mut split) = max_fit_error(pts, first, last, &bezier, &u);
    if max_error <= error {
        out.push(bezier);
        return;
    }
    if max_error <= error * 32.0 {
        for _ in 0..24 {
            u = reparameterize(pts, first, &u, &bezier);
            bezier = generate_bezier(pts, first, last, &u, tan1, tan2);
            (max_error, split) = max_fit_error(pts, first, last, &bezier, &u);
            if max_error <= error {
                out.push(bezier);
                return;
            }
        }
    }
    // Far from fitting: halve by length so symmetric shapes get symmetric, fewer pieces.
    if max_error > error * 32.0 {
        if let Some(half) = u.iter().position(|&t| t >= 0.5) {
            if half > 0 {
                split = first + half;
            }
        }
    }
    split = split.min(last - 1).max(first + 1);
    let mut center = normalize(sub(pts[split - 1], pts[split + 1]));
    let center_length = length(center);
    if center_length == 0.0 || center_length.is_nan() {
        center = normalize(v(
            -(pts[split].y - pts[split - 1].y),
            pts[split].x - pts[split - 1].x,
        ));
    }
    fit_range(pts, first, split, tan1, center, error, out, depth + 1);
    fit_range(
        pts,
        split,
        last,
        scale(center, -1.0),
        tan2,
        error,
        out,
        depth + 1,
    );
}

fn chord_parameters(pts: &[Vec2], first: usize, last: usize) -> Vec<f64> {
    let mut u = Vec::with_capacity(last - first + 1);
    u.push(0.0);
    for k in first + 1..=last {
        let prev = u[u.len() - 1];
        u.push(prev + distance(pts[k], pts[k - 1]));
    }
    let total = u[u.len() - 1];
    let total = if total == 0.0 || total.is_nan() {
        1.0
    } else {
        total
    };
    u.iter().map(|x| x / total).collect()
}

fn generate_bezier(
    pts: &[Vec2],
    first: usize,
    last: usize,
    u: &[f64],
    tan1: Vec2,
    tan2: Vec2,
) -> Cubic {
    let p0 = pts[first];
    let p3 = pts[last];
    let (mut c00, mut c01, mut c11, mut x0, mut x1) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for k in 0..=last - first {
        let t = u[k];
        let mt = 1.0 - t;
        let b0 = mt * mt * mt;
        let b1 = 3.0 * t * mt * mt;
        let b2 = 3.0 * t * t * mt;
        let b3 = t * t * t;
        let a1 = scale(tan1, b1);
        let a2 = scale(tan2, b2);
        c00 += dot(a1, a1);
        c01 += dot(a1, a2);
        c11 += dot(a2, a2);
        let tmp = sub(pts[first + k], add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
        x0 += dot(a1, tmp);
        x1 += dot(a2, tmp);
    }
    let det = c00 * c11 - c01 * c01;
    let mut alpha1 = 0.0;
    let mut alpha2 = 0.0;
    if det.abs() > 1e-12 {
        alpha1 = (x0 * c11 - x1 * c01) / det;
        alpha2 = (c00 * x1 - c01 * x0) / det;
    }
    let seg_length = distance(p0, p3);
    let eps = 1e-6 * seg_length;
    if alpha1 < eps || alpha2 < eps {
        // The least-squares answer is degenerate: fall back to Wu–Barsky's heuristic.
        alpha1 = seg_length / 3.0;
        alpha2 = alpha1;
    }
    [
        p0,
        add(p0, scale(tan1, alpha1)),
        add(p3, scale(tan2, alpha2)),
        p3,
    ]
}

fn max_fit_error(
    pts: &[Vec2],
    first: usize,
    last: usize,
    bezier: &Cubic,
    u: &[f64],
) -> (f64, usize) {
    let mut max = 0.0;
    let mut split = (last + first) / 2;
    for k in first + 1..last {
        let d = distance(cubic_point(bezier, u[k - first]), pts[k]);
        if d >= max {
            max = d;
            split = k;
        }
    }
    (max, split)
}

fn reparameterize(pts: &[Vec2], first: usize, u: &[f64], bezier: &Cubic) -> Vec<f64> {
    u.iter()
        .enumerate()
        .map(|(k, &t)| {
            let p = pts[first + k];
            let d = sub(cubic_point(bezier, t), p);
            let d1 = cubic_derivative(bezier, t);
            let mt = 1.0 - t;
            let d2 = v(
                6.0 * mt * (bezier[2].x - 2.0 * bezier[1].x + bezier[0].x)
                    + 6.0 * t * (bezier[3].x - 2.0 * bezier[2].x + bezier[1].x),
                6.0 * mt * (bezier[2].y - 2.0 * bezier[1].y + bezier[0].y)
                    + 6.0 * t * (bezier[3].y - 2.0 * bezier[2].y + bezier[1].y),
            );
            let denominator = dot(d1, d1) + dot(d, d2);
            if denominator.abs() < 1e-12 {
                return t;
            }
            js::max(0.0, js::min(1.0, t - dot(d, d1) / denominator))
        })
        .collect()
}

/// Commands for a chain of cubics (a moveto to the first point, no Z).
pub fn cubics_to_commands(cubics: &[Cubic], move_to: bool) -> Vec<PathCommand> {
    let mut out = Vec::with_capacity(cubics.len() + 1);
    if move_to && !cubics.is_empty() {
        out.push(cmd_m(cubics[0][0].x, cubics[0][0].y));
    }
    for c in cubics {
        out.push(cmd_c(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y));
    }
    out
}

/// Appends a line to (x, y), or extends the previous line when the three points lie on one line within
/// `eps` and the path keeps going forward.
pub fn append_line(out: &mut Vec<PathCommand>, x: f64, y: f64, eps: f64) {
    append_line_after(out, 0, x, y, eps);
}

/// `appendLine` on the commands from `first` on (the list being built is the tail of `out`).
pub(crate) fn append_line_after(
    out: &mut Vec<PathCommand>,
    first: usize,
    x: f64,
    y: f64,
    eps: f64,
) {
    let n = out.len();
    if n >= first + 2 {
        if let (PathCommand::L(last), Some(before)) = (out[n - 1], end_point(&out[n - 2])) {
            let dx = x - before.x;
            let dy = y - before.y;
            let l = js::hypot(dx, dy);
            let mx = last.x - before.x;
            let my = last.y - before.y;
            if l > 0.0
                && (mx * dy - my * dx).abs() / l <= eps
                && mx * dx + my * dy > 0.0
                && (x - last.x) * dx + (y - last.y) * dy > 0.0
            {
                out[n - 1] = cmd_l(x, y);
                return;
            }
        }
    }
    out.push(cmd_l(x, y));
}

/// A closed or open polyline as M/L(/Z) commands.
pub fn polyline_to_commands(points: &[Vec2], closed: bool) -> Vec<PathCommand> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(points.len() + 1);
    out.push(cmd_m(points[0].x, points[0].y));
    for p in &points[1..] {
        out.push(cmd_l(p.x, p.y));
    }
    if closed {
        out.push(PathCommand::Z);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_serializes() {
        let d = "M10 10h5v5H10z m1 1 c1 1 2 2 3 3 s4 4 5 5 a5 5 0 1 0 10 0";
        let commands = parse_path_data(d, None);
        let text = serialize_path_data(&commands, 3);
        assert!(
            text.starts_with("M10 10L15 10L15 15L10 15ZM11 11C12 12"),
            "{text}"
        );
        assert_eq!(parse_js_number("1."), 1.0);
        assert_eq!(parse_js_number(".5"), 0.5);
        assert_eq!(parse_js_number("-.5e-1"), -0.05);
        assert_eq!(parse_js_number("+5"), 5.0);
    }

    #[test]
    fn bounds_of_a_curve() {
        let commands = parse_path_data("M0 0C0 10 10 10 10 0", None);
        let b = path_bounds(&commands).unwrap();
        assert_eq!((b.x, b.y, b.width), (0.0, 0.0, 10.0));
        assert!((b.height - 7.5).abs() < 1e-12);
    }
}
