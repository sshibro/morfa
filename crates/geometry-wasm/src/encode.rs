//! Encodings of lane L1's geometry values as plain `f64` arrays, copied once each way across the boundary
//! (the TypeScript side is shared/design/geometry-wasm.ts; the harness's is scripts/geometry/wasm-geometry.ts):
//! - commands: per command a code (M 0, L 1, C 2, Q 3, Z 4) and its numbers;
//! - paths (`VectorPath[]`): count, then per path: winding (0 NONZERO, 1 EVENODD), encoded length, commands;
//! - polylines: count, then per polyline: closed (0/1), point count, x, y…;
//! - multipolygons: polygon count, then per polygon: ring count, then per ring: point count, x, y…;
//! - rect: [] for null, else [x, y, width, height]; matrix: [a, c, e, b, d, f].

// The rect, matrix and bare-command helpers serve the harness's entries only (feature `harness`).
#![cfg_attr(not(feature = "harness"), allow(dead_code))]

use morfa_geometry::clip::MultiPolygon;
use morfa_geometry::matrix::Rect;
use morfa_geometry::outline::StrokeStyle;
use morfa_geometry::paths::Polyline;
use morfa_model::{
    BooleanOperation, CubicTo, Matrix, PathCommand, QuadTo, StrokeAlign, StrokeCap, StrokeJoin,
    StrokeMarker, Vec2, VectorPath, WindingRule,
};

pub(crate) struct Reader<'a> {
    data: &'a [f64],
    at: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(data: &'a [f64]) -> Self {
        Reader { data, at: 0 }
    }
    #[inline]
    pub(crate) fn next(&mut self) -> f64 {
        let v = self.data.get(self.at).copied().unwrap_or(f64::NAN);
        self.at += 1;
        v
    }
    pub(crate) fn done(&self) -> bool {
        self.at >= self.data.len()
    }
    pub(crate) fn commands(&mut self, end: usize) -> Vec<PathCommand> {
        let mut out = Vec::new();
        while self.at < end {
            let code = self.next();
            out.push(match code as i32 {
                0 => PathCommand::M(Vec2 {
                    x: self.next(),
                    y: self.next(),
                }),
                1 => PathCommand::L(Vec2 {
                    x: self.next(),
                    y: self.next(),
                }),
                2 => PathCommand::C(CubicTo {
                    x1: self.next(),
                    y1: self.next(),
                    x2: self.next(),
                    y2: self.next(),
                    x: self.next(),
                    y: self.next(),
                }),
                3 => PathCommand::Q(QuadTo {
                    x1: self.next(),
                    y1: self.next(),
                    x: self.next(),
                    y: self.next(),
                }),
                _ => PathCommand::Z,
            });
        }
        out
    }
    pub(crate) fn paths(&mut self) -> Vec<VectorPath> {
        let n = self.next() as usize;
        (0..n)
            .map(|_| {
                let winding_rule = if self.next() == 1.0 {
                    WindingRule::Evenodd
                } else {
                    WindingRule::Nonzero
                };
                let len = self.next() as usize;
                let end = self.at + len;
                VectorPath {
                    winding_rule,
                    commands: self.commands(end),
                }
            })
            .collect()
    }
    pub(crate) fn polylines(&mut self) -> Vec<Polyline> {
        let n = self.next() as usize;
        (0..n)
            .map(|_| {
                let closed = self.next() == 1.0;
                let count = self.next() as usize;
                Polyline {
                    points: (0..count)
                        .map(|_| Vec2 {
                            x: self.next(),
                            y: self.next(),
                        })
                        .collect(),
                    closed,
                }
            })
            .collect()
    }
    pub(crate) fn multipolygon(&mut self) -> MultiPolygon {
        let n = self.next() as usize;
        (0..n)
            .map(|_| {
                let rings = self.next() as usize;
                (0..rings)
                    .map(|_| {
                        let count = self.next() as usize;
                        (0..count).map(|_| [self.next(), self.next()]).collect()
                    })
                    .collect()
            })
            .collect()
    }
}

pub(crate) fn write_commands(out: &mut Vec<f64>, commands: &[PathCommand]) {
    for c in commands {
        match c {
            PathCommand::M(p) => out.extend([0.0, p.x, p.y]),
            PathCommand::L(p) => out.extend([1.0, p.x, p.y]),
            PathCommand::C(k) => out.extend([2.0, k.x1, k.y1, k.x2, k.y2, k.x, k.y]),
            PathCommand::Q(q) => out.extend([3.0, q.x1, q.y1, q.x, q.y]),
            PathCommand::Z => out.push(4.0),
        }
    }
}

pub(crate) fn encode_commands(commands: &[PathCommand]) -> Vec<f64> {
    let mut out = Vec::with_capacity(commands.len() * 7);
    write_commands(&mut out, commands);
    out
}

pub(crate) fn encode_paths(paths: &[VectorPath]) -> Vec<f64> {
    let mut out = vec![paths.len() as f64];
    for p in paths {
        out.push(if p.winding_rule == WindingRule::Evenodd {
            1.0
        } else {
            0.0
        });
        let at = out.len();
        out.push(0.0);
        write_commands(&mut out, &p.commands);
        out[at] = (out.len() - at - 1) as f64;
    }
    out
}

pub(crate) fn encode_polylines(lines: &[Polyline]) -> Vec<f64> {
    let mut out = vec![lines.len() as f64];
    for l in lines {
        out.push(if l.closed { 1.0 } else { 0.0 });
        out.push(l.points.len() as f64);
        for p in &l.points {
            out.push(p.x);
            out.push(p.y);
        }
    }
    out
}

pub(crate) fn encode_multipolygon(area: &MultiPolygon) -> Vec<f64> {
    let mut out = vec![area.len() as f64];
    for polygon in area {
        out.push(polygon.len() as f64);
        for ring in polygon {
            out.push(ring.len() as f64);
            for p in ring {
                out.push(p[0]);
                out.push(p[1]);
            }
        }
    }
    out
}

pub(crate) fn encode_rect(r: Option<Rect>) -> Vec<f64> {
    r.map_or_else(Vec::new, |r| vec![r.x, r.y, r.width, r.height])
}

pub(crate) fn rect_of(r: &[f64]) -> Rect {
    Rect::new(r[0], r[1], r[2], r[3])
}

pub(crate) fn matrix_of(m: &[f64]) -> Matrix {
    [[m[0], m[1], m[2]], [m[3], m[4], m[5]]]
}

pub(crate) fn encode_matrix(m: &Matrix) -> Vec<f64> {
    vec![m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2]]
}

pub(crate) fn decode_commands(data: &[f64]) -> Vec<PathCommand> {
    Reader::new(data).commands(data.len())
}

pub(crate) fn decode_paths(data: &[f64]) -> Vec<VectorPath> {
    Reader::new(data).paths()
}

pub(crate) fn boolean_operation(code: u32) -> BooleanOperation {
    match code {
        1 => BooleanOperation::Subtract,
        2 => BooleanOperation::Intersect,
        3 => BooleanOperation::Exclude,
        _ => BooleanOperation::Union,
    }
}

pub(crate) fn marker(code: u32) -> StrokeMarker {
    match code {
        1 => StrokeMarker::LineArrow,
        2 => StrokeMarker::TriangleArrow,
        3 => StrokeMarker::ReversedTriangle,
        4 => StrokeMarker::Circle,
        5 => StrokeMarker::Diamond,
        6 => StrokeMarker::Round,
        7 => StrokeMarker::Square,
        _ => StrokeMarker::None,
    }
}

pub(crate) fn stroke_style(
    weight: f64,
    align: u32,
    cap: u32,
    join: u32,
    miter_limit: f64,
    dash_pattern: &[f64],
) -> StrokeStyle {
    StrokeStyle {
        weight,
        align: match align {
            1 => StrokeAlign::Inside,
            2 => StrokeAlign::Outside,
            _ => StrokeAlign::Center,
        },
        cap: match cap {
            1 => StrokeCap::Round,
            2 => StrokeCap::Square,
            _ => StrokeCap::None,
        },
        join: match join {
            1 => StrokeJoin::Bevel,
            2 => StrokeJoin::Round,
            _ => StrokeJoin::Miter,
        },
        miter_limit,
        dash_pattern: dash_pattern.to_vec(),
    }
}
