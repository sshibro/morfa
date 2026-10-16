//! `shared/design/boolean.ts`: boolean geometry (union, subtract, intersect, exclude). Fill outlines are
//! flattened finely, combined by the polygon-clipping port (`clip`), then turned back into curves: every
//! flattened point remembers the curve and parameter it came from, so an output edge running along a curve
//! becomes the exact piece of that curve, pinned to the clipped vertices.
//!
//! The document part of boolean.ts (`booleanGeometry`'s per-node cache, `vectorFromPaths`, "Flatten")
//! stays in TypeScript and calls [`combine_paths`] here; [`boolean_geometry`] is the same walk over a
//! Rust document, without the cache.

use std::cell::Cell;

// foldhash: the provenance tables hash every flattened point (SipHash cost ~3 % of a 200-operand union).
use hashbrown::{HashMap, HashSet};

use morfa_model::{
    BooleanOperation, DesignDocument, Matrix, NodeType, PathCommand, SceneNode, Vec2, VectorPath,
    WindingRule,
};

use crate::clip::{self, MultiPolygon, Operation, Pair, Ring};
use crate::js;
use crate::matrix::{multiply, node_matrix};
use crate::paths::{
    Cubic, append_line_after, cubic_point, cubic_steps, for_each_segment, sub_cubic,
    transform_paths, v,
};
use crate::shapes::node_geometry;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::{Overlay, ShapeType};
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;

// ── Time budget ────────────────────────────────────────────────────────────────────────────────

/// Wall-clock budget of one boolean computation (`BOOLEAN_TIME_BUDGET_MS`). Past it, unions stop clipping
/// and stack their remaining parts (NONZERO still paints exactly the union).
pub const BOOLEAN_TIME_BUDGET_MS: f64 = 1500.0;

thread_local! {
    static DEADLINE: Cell<f64> = const { Cell::new(f64::INFINITY) };
}

static CLOCK: std::sync::OnceLock<fn() -> f64> = std::sync::OnceLock::new();

/// Installs the millisecond clock `Date.now()` reads (the WASM build has no system clock of its own).
pub fn set_clock(now: fn() -> f64) {
    let _ = CLOCK.set(now);
}

/// `Date.now()`; without a clock (a WASM build that installed none) time never runs out.
fn now() -> f64 {
    if let Some(clock) = CLOCK.get() {
        return clock();
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_millis() as f64)
    }
    #[cfg(target_arch = "wasm32")]
    {
        f64::NEG_INFINITY
    }
}

#[inline]
fn deadline() -> f64 {
    DEADLINE.with(Cell::get)
}

#[inline]
fn out_of_time() -> bool {
    let d = deadline();
    d != f64::INFINITY && now() > d
}

/// `budgeted`: nested calls share the outer budget.
fn budgeted<T>(run: impl FnOnce() -> T) -> T {
    if deadline() != f64::INFINITY {
        return run();
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            DEADLINE.with(|d| d.set(f64::INFINITY));
        }
    }
    DEADLINE.with(|d| d.set(now() + BOOLEAN_TIME_BUDGET_MS));
    let _reset = Reset;
    run()
}

// ── Provenance ─────────────────────────────────────────────────────────────────────────────────

/// A flattened point's origin: curve `curve` of the registry at parameter `t`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Tag {
    curve: usize,
    t: f64,
}

#[derive(Debug, Clone, Copy)]
struct Chord {
    a: Vec2,
    b: Vec2,
    curve: usize,
    t0: f64,
    t1: f64,
}

/// `${x},${y}` of a number pair: −0 and 0 print alike, every NaN prints "NaN".
#[inline]
fn number_key(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else if x.is_nan() {
        f64::NAN.to_bits()
    } else {
        x.to_bits()
    }
}

#[inline]
fn point_key(x: f64, y: f64) -> (u64, u64) {
    (number_key(x), number_key(y))
}

/// Remembers where flattened points came from, so curves can be rebuilt after clipping.
#[derive(Default)]
pub(crate) struct Provenance {
    curves: Vec<Cubic>,
    tags: HashMap<(u64, u64), Vec<Tag>>,
    chords: Vec<Chord>,
    grid: Option<HashMap<(u64, u64), Vec<usize>>>,
    cell: f64,
}

impl Provenance {
    fn add_curve(&mut self, c: Cubic) -> usize {
        self.curves.push(c);
        self.curves.len() - 1
    }

    fn tag(&mut self, p: Vec2, curve: usize, t: f64) {
        self.tags
            .entry(point_key(p.x, p.y))
            .or_default()
            .push(Tag { curve, t });
    }

    fn chord(&mut self, a: Vec2, b: Vec2, curve: usize, t0: f64, t1: f64) {
        self.chords.push(Chord {
            a,
            b,
            curve,
            t0,
            t1,
        });
        self.grid = None;
    }

    /// `other`'s curves also go through `point` (two flattened points the live overlay's grid made one).
    fn alias(&mut self, point: Pair, other: Pair) {
        if let Some(extra) = self.tags.get(&point_key(other[0], other[1])).cloned() {
            self.tags
                .entry(point_key(point[0], point[1]))
                .or_default()
                .extend(extra);
        }
    }

    /// Curves through a point: exact for points the flattening made, by the chord it lies on for
    /// intersections the clipper added.
    fn lookup(&mut self, p: Vec2, eps: f64, exact_only: bool) -> Vec<Tag> {
        if let Some(exact) = self.tags.get(&point_key(p.x, p.y)) {
            return exact.clone();
        }
        if self.chords.is_empty() || exact_only {
            return Vec::new();
        }
        self.build_grid();
        let Some(grid) = self.grid.as_ref() else {
            return Vec::new();
        };
        let cx = (p.x / self.cell).floor();
        let cy = (p.y / self.cell).floor();
        let mut out = Vec::new();
        let mut seen: HashSet<usize> = HashSet::new();
        // Real geometry has a handful of chords near a point; piles of coincident curves (hostile files)
        // are cut short, and the vertex then simply stays a corner.
        let mut budget: i64 = 512;
        for gx in [cx - 1.0, cx, cx + 1.0] {
            for gy in [cy - 1.0, cy, cy + 1.0] {
                let Some(list) = grid.get(&point_key(gx, gy)) else {
                    continue;
                };
                for &index in list {
                    budget -= 1;
                    if budget < 0 {
                        return out;
                    }
                    if !seen.insert(index) {
                        continue;
                    }
                    let chord = &self.chords[index];
                    let dx = chord.b.x - chord.a.x;
                    let dy = chord.b.y - chord.a.y;
                    let len2 = dx * dx + dy * dy;
                    let s = if len2 != 0.0 && !len2.is_nan() {
                        js::max(
                            0.0,
                            js::min(
                                1.0,
                                ((p.x - chord.a.x) * dx + (p.y - chord.a.y) * dy) / len2,
                            ),
                        )
                    } else {
                        0.0
                    };
                    let qx = chord.a.x + dx * s;
                    let qy = chord.a.y + dy * s;
                    if js::hypot(p.x - qx, p.y - qy) <= eps {
                        out.push(Tag {
                            curve: chord.curve,
                            t: chord.t0 + (chord.t1 - chord.t0) * s,
                        });
                    }
                }
            }
        }
        out
    }

    fn build_grid(&mut self) {
        if self.grid.is_some() {
            return;
        }
        let mut total = 0.0;
        for c in &self.chords {
            total += (c.b.x - c.a.x).abs() + (c.b.y - c.a.y).abs();
        }
        self.cell = js::max(1e-6, (total / self.chords.len() as f64) * 2.0);
        let cell = self.cell;
        let mut grid: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
        for (index, c) in self.chords.iter().enumerate() {
            let x0 = (js::min(c.a.x, c.b.x) / cell).floor();
            let x1 = (js::max(c.a.x, c.b.x) / cell).floor();
            let y0 = (js::min(c.a.y, c.b.y) / cell).floor();
            let y1 = (js::max(c.a.y, c.b.y) / cell).floor();
            let mut gx = x0;
            let mut ix = 0;
            while gx <= x1 && gx - x0 < 64.0 && ix < 64 {
                let mut gy = y0;
                let mut iy = 0;
                while gy <= y1 && gy - y0 < 64.0 && iy < 64 {
                    grid.entry(point_key(gx, gy)).or_default().push(index);
                    gy += 1.0;
                    iy += 1;
                }
                gx += 1.0;
                ix += 1;
            }
        }
        self.grid = Some(grid);
    }
}

// ── Paths → polygons ───────────────────────────────────────────────────────────────────────────

pub(crate) fn signed_area(ring: &[Pair]) -> f64 {
    let mut area = 0.0;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for k in 0..n {
        area += (ring[j][0] - ring[k][0]) * (ring[j][1] + ring[k][1]);
        j = k;
    }
    area / 2.0
}

fn inside_ring(ring: &[Pair], x: f64, y: f64) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for k in 0..n {
        let [xi, yi] = ring[k];
        let [xj, yj] = ring[j];
        if (yi > y) != (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = k;
    }
    inside
}

/// Rings of each subpath, closed as a fill closes them, with provenance recorded when given.
fn flatten_rings(
    commands: &[PathCommand],
    tolerance: f64,
    mut provenance: Option<&mut Provenance>,
) -> Vec<Ring> {
    let mut rings: Vec<Ring> = Vec::new();
    let mut subpath: i64 = -1;
    fn push(rings: &mut [Ring], p: Vec2) {
        // Non-finite coordinates (a broken file) never reach the sweep line.
        if !p.x.is_finite() || !p.y.is_finite() {
            return;
        }
        let Some(ring) = rings.last_mut() else { return };
        if ring
            .last()
            .is_none_or(|last| last[0] != p.x || last[1] != p.y)
        {
            ring.push([p.x, p.y]);
        }
    }
    for_each_segment(commands, true, |s| {
        if s.subpath != subpath {
            subpath = s.subpath;
            rings.push(Vec::new());
            push(&mut rings, s.p0);
        }
        let Some([c1, c2]) = s.controls else {
            push(&mut rings, s.p1);
            return;
        };
        let c: Cubic = [s.p0, c1, c2, s.p1];
        let steps = cubic_steps(&c, tolerance, 0.0);
        let id = provenance
            .as_deref_mut()
            .map_or(usize::MAX, |p| p.add_curve(c));
        let mut previous = s.p0;
        let mut previous_t = 0.0;
        if let Some(p) = provenance.as_deref_mut() {
            p.tag(s.p0, id, 0.0);
        }
        let mut k = 1.0;
        while k <= steps {
            let t = k / steps;
            let p = if k == steps { s.p1 } else { cubic_point(&c, t) };
            if let Some(prov) = provenance.as_deref_mut() {
                prov.tag(p, id, t);
                prov.chord(previous, p, id, previous_t, t);
            }
            push(&mut rings, p);
            previous = p;
            previous_t = t;
            k += 1.0;
        }
    });
    rings
        .into_iter()
        .map(|mut r| {
            if r.len() > 1 && r[0][0] == r[r.len() - 1][0] && r[0][1] == r[r.len() - 1][1] {
                r.pop();
            }
            r
        })
        .filter(|r| r.len() >= 3 && signed_area(r).abs() > 1e-12)
        .collect()
}

const MAX_NESTED_RINGS: usize = 400;

/// The fill of one path as a MultiPolygon under its winding rule.
fn rings_to_area(rings: Vec<Ring>, rule: WindingRule) -> MultiPolygon {
    if rings.is_empty() {
        return Vec::new();
    }
    if rings.len() == 1 {
        return vec![rings];
    }
    if rule == WindingRule::Evenodd || rings.len() > MAX_NESTED_RINGS {
        return cascade(
            CascadeOp::Xor,
            rings.into_iter().map(|r| vec![vec![r]]).collect(),
        );
    }
    let (parent, winding) = nest(&rings);
    let mut polygons: MultiPolygon = Vec::new();
    for (k, ring) in rings.iter().enumerate() {
        if winding[k] == 0.0 || winding[k].is_nan() {
            continue;
        }
        let mut polygon = vec![ring.clone()];
        for (j, r) in rings.iter().enumerate() {
            if parent[j] == k as i64 {
                polygon.push(r.clone());
            }
        }
        polygons.push(polygon);
    }
    if polygons.is_empty() {
        Vec::new()
    } else {
        cascade(
            CascadeOp::Union,
            polygons.into_iter().map(|p| vec![p]).collect(),
        )
    }
}

/// NONZERO: nests rings by containment; the region inside a ring and outside its children winds as its parent's
/// region plus the ring's own direction. Each ring's parent (−1: none) and winding.
fn nest(rings: &[Ring]) -> (Vec<i64>, Vec<f64>) {
    let areas: Vec<f64> = rings.iter().map(|r| signed_area(r)).collect();
    let mut order: Vec<usize> = (0..rings.len()).collect();
    order.sort_by(|&a, &b| {
        let d = areas[b].abs() - areas[a].abs();
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let mut parent = vec![-1i64; rings.len()];
    let mut winding = vec![0.0f64; rings.len()];
    let mut placed: Vec<usize> = Vec::with_capacity(rings.len());
    for &k in &order {
        let [px, py] = probe_point(&rings[k]);
        for j in (0..placed.len()).rev() {
            if inside_ring(&rings[placed[j]], px, py) {
                parent[k] = placed[j] as i64;
                break;
            }
        }
        winding[k] = (if parent[k] >= 0 {
            winding[parent[k] as usize]
        } else {
            0.0
        }) + js::sign(areas[k]);
        placed.push(k);
    }
    (parent, winding)
}

/// A point just inside the ring's first edge, for containment tests of nested rings.
fn probe_point(ring: &[Pair]) -> Pair {
    let [x0, y0] = ring[0];
    let [x1, y1] = ring[1];
    [(x0 + x1) / 2.0, (y0 + y1) / 2.0]
}

/// The filled area of paths (each with its own winding rule) as one MultiPolygon.
pub fn fill_area(paths: &[VectorPath], tolerance: f64) -> MultiPolygon {
    budgeted(|| area_of(paths, tolerance, None))
}

fn area_of(
    paths: &[VectorPath],
    tolerance: f64,
    mut provenance: Option<&mut Provenance>,
) -> MultiPolygon {
    let mut parts: Vec<MultiPolygon> = Vec::new();
    for path in paths {
        let area = rings_to_area(
            flatten_rings(&path.commands, tolerance, provenance.as_deref_mut()),
            path.winding_rule,
        );
        if !area.is_empty() {
            parts.push(area);
        }
    }
    if parts.is_empty() {
        return Vec::new();
    }
    if parts.len() == 1 {
        parts.pop().unwrap_or_default()
    } else {
        cascade(CascadeOp::Union, parts)
    }
}

// ── Clipping ───────────────────────────────────────────────────────────────────────────────────

/// Vertices one union may sweep at once; designs stay far below, hostile files do not.
const CLIP_VERTEX_LIMIT: usize = 150_000;

fn vertex_count(geoms: &[MultiPolygon]) -> usize {
    geoms.iter().flatten().flatten().map(Vec::len).sum()
}

/// polygon-clipping with a second try on a snapped grid.
fn run_clip(operation: Operation, geoms: &[MultiPolygon]) -> MultiPolygon {
    // Out of time, or too big for one uninterruptible sweep, a union stacks its parts instead.
    if operation == Operation::Union && (out_of_time() || vertex_count(geoms) > CLIP_VERTEX_LIMIT) {
        return geoms.iter().flat_map(orient).collect();
    }
    match clip::clip(operation, geoms) {
        Ok(result) => result,
        Err(_) => {
            let snap = |v: f64| js::round(v * 1e6) / 1e6;
            let snapped: Vec<MultiPolygon> = geoms
                .iter()
                .map(|g| {
                    g.iter()
                        .map(|polygon| {
                            polygon
                                .iter()
                                .map(|ring| ring.iter().map(|&[x, y]| [snap(x), snap(y)]).collect())
                                .collect()
                        })
                        .collect()
                })
                .collect();
            clip::clip(operation, &snapped).unwrap_or_default()
        }
    }
}

/// Every outline wound one way and every hole the other, for stacking without clipping.
fn orient(area: &MultiPolygon) -> MultiPolygon {
    area.iter()
        .map(|polygon| {
            polygon
                .iter()
                .enumerate()
                .map(|(k, ring)| {
                    if (signed_area(ring) > 0.0) == (k == 0) {
                        ring.clone()
                    } else {
                        ring.iter().rev().copied().collect()
                    }
                })
                .collect()
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CascadeOp {
    Union,
    Xor,
    Intersection,
}

/// An associative operation over many geometries, combined pairwise in a balanced tree.
fn cascade(operation: CascadeOp, geoms: Vec<MultiPolygon>) -> MultiPolygon {
    if geoms.is_empty() {
        return Vec::new();
    }
    if geoms.len() == 1 {
        return run_clip(Operation::Union, &geoms);
    }
    let op = match operation {
        CascadeOp::Union => Operation::Union,
        CascadeOp::Xor => Operation::Xor,
        CascadeOp::Intersection => Operation::Intersection,
    };
    let mut list = geoms;
    while list.len() > 1 {
        let mut next: Vec<MultiPolygon> = Vec::with_capacity(list.len().div_ceil(2));
        let mut items = list.into_iter();
        while let Some(a) = items.next() {
            match items.next() {
                None => next.push(a),
                Some(b) => {
                    // Out of time: the rest is stacked, which NONZERO still paints as the union.
                    if operation == CascadeOp::Union && out_of_time() {
                        let mut stacked = orient(&a);
                        stacked.extend(orient(&b));
                        next.push(stacked);
                    } else {
                        next.push(run_clip(op, &[a, b]));
                    }
                }
            }
        }
        if operation == CascadeOp::Intersection && next.iter().any(Vec::is_empty) {
            return Vec::new();
        }
        list = next;
    }
    list.pop().unwrap_or_default()
}

/// Combines operand areas: UNION, SUBTRACT (the first minus the rest), INTERSECT, EXCLUDE (XOR).
pub fn combine_areas(operation: BooleanOperation, operands: &[MultiPolygon]) -> MultiPolygon {
    budgeted(|| {
        let present: Vec<MultiPolygon> =
            operands.iter().filter(|g| !g.is_empty()).cloned().collect();
        match operation {
            BooleanOperation::Union => cascade(CascadeOp::Union, present),
            BooleanOperation::Exclude => cascade(CascadeOp::Xor, present),
            BooleanOperation::Intersect => {
                if !operands.is_empty() && present.len() == operands.len() {
                    cascade(CascadeOp::Intersection, present)
                } else {
                    Vec::new()
                }
            }
            BooleanOperation::Subtract => {
                let Some(first) = operands.first().filter(|g| !g.is_empty()) else {
                    return Vec::new();
                };
                let rest: Vec<MultiPolygon> = operands[1..]
                    .iter()
                    .filter(|g| !g.is_empty())
                    .cloned()
                    .collect();
                if rest.is_empty() {
                    run_clip(Operation::Union, std::slice::from_ref(first))
                } else {
                    let rest = cascade(CascadeOp::Union, rest);
                    run_clip(Operation::Difference, &[first.clone(), rest])
                }
            }
        }
    })
}

// ── Polygons → paths ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
struct Edge {
    curve: usize,
    t0: f64,
    t1: f64,
}

fn continues_from(prev: Option<Edge>, next: Option<Edge>) -> bool {
    match (prev, next) {
        (Some(p), Some(n)) => {
            p.curve == n.curve && p.t1 == n.t0 && js::sign(p.t1 - p.t0) == js::sign(n.t1 - n.t0)
        }
        _ => false,
    }
}

/// Commands for one clipped ring: lines where it runs along straight input, exact curve pieces where it
/// runs along curves.
fn ring_to_commands(
    ring: &[Pair],
    mut provenance: Option<&mut Provenance>,
    tolerance: f64,
    eps: f64,
    out: &mut Vec<PathCommand>,
) {
    // Vertices closer than float noise are one vertex.
    let mut points: Vec<Vec2> = Vec::with_capacity(ring.len());
    for &[x, y] in ring {
        if points
            .last()
            .is_none_or(|last| (last.x - x).abs() > eps || (last.y - y).abs() > eps)
        {
            points.push(v(x, y));
        }
    }
    while points.len() > 1 && {
        let (first, last) = (points[0], points[points.len() - 1]);
        (first.x - last.x).abs() <= eps && (first.y - last.y).abs() <= eps
    } {
        points.pop();
    }
    let n = points.len();
    if n < 3 {
        return;
    }
    let mut edges: Vec<Option<Edge>> = vec![None; n];
    if let Some(prov) = provenance.as_deref_mut() {
        let tags: Vec<Vec<Tag>> = points
            .iter()
            .map(|&p| prov.lookup(p, eps, out_of_time()))
            .collect();
        for k in 0..n {
            let a = points[k];
            let b = points[(k + 1) % n];
            let previous = edges[(k + n - 1) % n];
            let mut best: Option<Edge> = None;
            for ta in &tags[k] {
                for tb in &tags[(k + 1) % n] {
                    if ta.curve != tb.curve || ta.t == tb.t {
                        continue;
                    }
                    // Follow the curve only if it really runs along this edge.
                    let mid = cubic_point(&prov.curves[ta.curve], (ta.t + tb.t) / 2.0);
                    if distance_to_segment(mid, a, b) > tolerance * 2.0 + eps {
                        continue;
                    }
                    let candidate = Edge {
                        curve: ta.curve,
                        t0: ta.t,
                        t1: tb.t,
                    };
                    let continues = previous
                        .is_some_and(|p| p.curve == candidate.curve && p.t1 == candidate.t0);
                    if best.is_none() || continues {
                        best = Some(candidate);
                    }
                    if continues {
                        break;
                    }
                }
            }
            edges[k] = best;
        }
    }
    // Start where a run begins, so no run wraps around the ring's start.
    let mut start = 0;
    for k in 0..n {
        if !continues_from(edges[(k + n - 1) % n], edges[k]) {
            start = k;
            break;
        }
    }
    let first_index = out.len();
    out.push(PathCommand::M(points[start]));
    let mut k = 0;
    while k < n {
        let index = (start + k) % n;
        let edge = edges[index];
        let (Some(edge), Some(prov)) = (edge, provenance.as_deref()) else {
            let p = points[(index + 1) % n];
            append_line_after(out, first_index, p.x, p.y, eps * 10.0);
            k += 1;
            continue;
        };
        let mut last = k;
        while last + 1 < n
            && continues_from(edges[(start + last) % n], edges[(start + last + 1) % n])
        {
            last += 1;
        }
        let from = points[index];
        let to = points[(start + last + 1) % n];
        let t1 = edges[(start + last) % n].map_or(0.0, |e| e.t1);
        let piece = sub_cubic(&prov.curves[edge.curve], edge.t0, t1);
        // Pin the piece to the exact clipped vertices; the handles move with their ends.
        let d0 = v(from.x - piece[0].x, from.y - piece[0].y);
        let d1 = v(to.x - piece[3].x, to.y - piece[3].y);
        out.push(PathCommand::C(morfa_model::CubicTo {
            x1: piece[1].x + d0.x,
            y1: piece[1].y + d0.y,
            x2: piece[2].x + d1.x,
            y2: piece[2].y + d1.y,
            x: to.x,
            y: to.y,
        }));
        k = last + 1;
    }
    // The last line back to the start is the Z.
    if let Some(PathCommand::L(tail)) = out.last() {
        if tail.x == points[start].x && tail.y == points[start].y {
            out.pop();
        }
    }
    out.push(PathCommand::Z);
}

fn distance_to_segment(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    let s = if len2 != 0.0 && !len2.is_nan() {
        js::max(
            0.0,
            js::min(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
        )
    } else {
        0.0
    };
    js::hypot(p.x - (a.x + dx * s), p.y - (a.y + dy * s))
}

/// A MultiPolygon as one NONZERO path of straight segments.
pub fn area_to_paths(area: &MultiPolygon) -> Vec<VectorPath> {
    paths_of_area(area, None, 0.0)
}

fn paths_of_area(
    area: &MultiPolygon,
    provenance: Option<&mut Provenance>,
    tolerance: f64,
) -> Vec<VectorPath> {
    paths_of_area_near(area, provenance, tolerance, 0.0)
}

/// [`paths_of_area`] with vertices up to `near` (at least) from where the flattening put them still found on
/// their curves: the live overlay rounds new intersections to its grid.
fn paths_of_area_near(
    area: &MultiPolygon,
    mut provenance: Option<&mut Provenance>,
    tolerance: f64,
    near: f64,
) -> Vec<VectorPath> {
    let mut extent: f64 = 1.0;
    for polygon in area {
        for ring in polygon {
            for &[x, y] in ring {
                extent = js::max(js::max(extent, x.abs()), y.abs());
            }
        }
    }
    let eps = js::max(extent * 1e-9 + 1e-9, near);
    let mut commands = Vec::new();
    for polygon in area {
        for ring in polygon {
            ring_to_commands(
                ring,
                provenance.as_deref_mut(),
                tolerance,
                eps,
                &mut commands,
            );
        }
    }
    if commands.is_empty() {
        Vec::new()
    } else {
        vec![VectorPath {
            winding_rule: WindingRule::Nonzero,
            commands,
        }]
    }
}

/// Flattening tolerance for a shape of this size.
pub fn boolean_tolerance(width: f64, height: f64) -> f64 {
    js::min(
        0.05,
        js::max(0.002, js::max(js::max(width, height), 1.0) * 1e-4),
    )
}

/// Points a boolean may flatten its curves into; past it the tolerance grows.
pub const BOOLEAN_POINT_BUDGET: f64 = 50_000.0;

fn curve_points(operands: &[Vec<VectorPath>], tolerance: f64) -> f64 {
    let mut total = 0.0;
    for paths in operands {
        for path in paths {
            for_each_segment(&path.commands, false, |s| {
                if let Some([c1, c2]) = s.controls {
                    total += cubic_steps(&[s.p0, c1, c2, s.p1], tolerance, 0.0);
                }
            });
        }
    }
    total
}

/// The flattening tolerance within [`BOOLEAN_POINT_BUDGET`].
fn budget_tolerance(operands: &[Vec<VectorPath>], tolerance: f64) -> f64 {
    let mut tolerance = tolerance;
    // Steps grow as 1/√tolerance until each curve's cap: coarsen until the estimate fits.
    let mut points = curve_points(operands, tolerance);
    let mut tries = 0;
    while points > BOOLEAN_POINT_BUDGET && tries < 24 {
        tolerance *= js::max(4.0, js::pow(points / BOOLEAN_POINT_BUDGET, 2.0));
        points = curve_points(operands, tolerance);
        tries += 1;
    }
    tolerance
}

/// Combines operands (each a list of paths in one shared space) and returns curves.
pub fn combine_paths(
    operation: BooleanOperation,
    operands: &[Vec<VectorPath>],
    tolerance: f64,
) -> Vec<VectorPath> {
    let tolerance = budget_tolerance(operands, tolerance);
    budgeted(|| {
        let mut provenance = Provenance::default();
        let areas: Vec<MultiPolygon> = operands
            .iter()
            .map(|paths| area_of(paths, tolerance, Some(&mut provenance)))
            .collect();
        paths_of_area(
            &combine_areas(operation, &areas),
            Some(&mut provenance),
            tolerance,
        )
    })
}

// ── Live drawing ───────────────────────────────────────────────────────────────────────────────

/// [`combine_paths`] for what the editor draws live (boolean groups' rendering, hit areas, bounds): the same
/// flattening and curve rebuilding, but UNION and SUBTRACT are one integer-snapped overlay (i_overlay) instead of
/// polygon-clipping's pairwise cascades, several times faster on many operands. The answer covers the same area
/// (to ~1e-9 of it) with other vertex lists, so the engine switch compares it with TypeScript by area;
/// anything written into a document uses [`combine_paths`]. INTERSECT and EXCLUDE are
/// [`combine_paths`].
pub fn combine_paths_live(
    operation: BooleanOperation,
    operands: &[Vec<VectorPath>],
    tolerance: f64,
) -> Vec<VectorPath> {
    if !matches!(
        operation,
        BooleanOperation::Union | BooleanOperation::Subtract
    ) {
        return combine_paths(operation, operands, tolerance);
    }
    let tolerance = budget_tolerance(operands, tolerance);
    budgeted(|| {
        let mut provenance = Provenance::default();
        let flat: Vec<Vec<(Vec<Ring>, WindingRule)>> = operands
            .iter()
            .map(|paths| {
                paths
                    .iter()
                    .map(|path| {
                        (
                            flatten_rings(&path.commands, tolerance, Some(&mut provenance)),
                            path.winding_rule,
                        )
                    })
                    .collect()
            })
            .collect();
        let (area, step, merged) = live_overlay(operation, &flat);
        for (kept, other) in merged {
            provenance.alias(kept, other);
        }
        // i_overlay rounds an intersection to the grid, up to a couple of steps away.
        paths_of_area_near(&area, Some(&mut provenance), tolerance, 4.0 * step)
    })
}

#[doc(hidden)]
/// (lane G tooling) The live overlay's polygons, before curves are rebuilt.
pub fn live_areas_debug(
    operation: BooleanOperation,
    operands: &[Vec<VectorPath>],
    tolerance: f64,
) -> MultiPolygon {
    let flat: Vec<Vec<(Vec<Ring>, WindingRule)>> = operands
        .iter()
        .map(|paths| {
            paths
                .iter()
                .map(|p| (flatten_rings(&p.commands, tolerance, None), p.winding_rule))
                .collect()
        })
        .collect();
    live_overlay(operation, &flat).0
}

/// The snapping grid of the live overlay: 2^(29 − ⌊log₂ half-extent⌋) steps per unit around the operands'
/// centre (i_float's own choice, ≈ 5e-7 px on a 1 000 px union). A grid point that is an input vertex maps back to
/// that vertex's exact coordinates, so the provenance finds its curve by exact lookup; only new intersections
/// are grid points.
struct Grid {
    ox: f64,
    oy: f64,
    scale: f64,
    exact: HashMap<IntPoint, Pair>,
    /// Input vertices that met another on a grid point: (the one kept, this one).
    merged: Vec<(Pair, Pair)>,
}

impl Grid {
    fn new<'a>(points: impl Iterator<Item = &'a Pair>) -> Grid {
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for &[x, y] in points {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        let half = ((max_x - min_x) / 2.0).max((max_y - min_y) / 2.0);
        // ⌊log₂ half⌋ from the exponent bits (flattening drops non-finite points).
        let scale = if half > 0.0 && half.is_finite() {
            let exponent = ((half.to_bits() >> 52) & 0x7ff) as i32 - 1023;
            2f64.powi(29 - exponent)
        } else {
            1.0
        };
        Grid {
            ox: (min_x + max_x) / 2.0,
            oy: (min_y + max_y) / 2.0,
            scale,
            exact: HashMap::new(),
            merged: Vec::new(),
        }
    }

    fn ring(&mut self, ring: &[Pair]) -> Vec<IntPoint> {
        ring.iter()
            .map(|&[x, y]| {
                let p = IntPoint::new(
                    ((x - self.ox) * self.scale).round() as i32,
                    ((y - self.oy) * self.scale).round() as i32,
                );
                let kept = *self.exact.entry(p).or_insert([x, y]);
                if kept != [x, y] {
                    self.merged.push((kept, [x, y]));
                }
                p
            })
            .collect()
    }

    fn back(&self, p: IntPoint) -> Pair {
        self.exact.get(&p).copied().unwrap_or([
            self.ox + f64::from(p.x) / self.scale,
            self.oy + f64::from(p.y) / self.scale,
        ])
    }
}

/// One overlay pass over contours (all subject), its shapes as contours wound +1 outside, −1 around holes.
fn overlay_pass(
    subject: &[Vec<IntPoint>],
    clip: &[Vec<IntPoint>],
    rule: OverlayRule,
    fill: FillRule,
) -> Vec<Vec<IntPoint>> {
    let mut overlay = Overlay::new(subject.iter().chain(clip).map(Vec::len).sum());
    for c in subject {
        overlay.add_contour(c, ShapeType::Subject);
    }
    for c in clip {
        overlay.add_contour(c, ShapeType::Clip);
    }
    let mut out = Vec::new();
    for shape in overlay.overlay(rule, fill) {
        for (k, mut contour) in shape.into_iter().enumerate() {
            if (int_area(&contour) > 0) != (k == 0) {
                contour.reverse();
            }
            out.push(contour);
        }
    }
    out
}

/// The operands' boxes' total area over the area of the box around all of them.
fn overlap_density(operands: &[Vec<Vec<IntPoint>>]) -> f64 {
    fn area(b: [i32; 4]) -> f64 {
        if b[0] > b[2] {
            0.0
        } else {
            (f64::from(b[2]) - f64::from(b[0])) * (f64::from(b[3]) - f64::from(b[1]))
        }
    }
    let mut all = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
    let mut total = 0.0;
    for operand in operands {
        let mut b = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
        for p in operand.iter().flatten() {
            b = [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)];
        }
        total += area(b);
        all = [
            all[0].min(b[0]),
            all[1].min(b[1]),
            all[2].max(b[2]),
            all[3].max(b[3]),
        ];
    }
    let all = area(all);
    if all > 0.0 { total / all } else { 0.0 }
}

/// Whether a ring goes once around its vertices' centroid, every edge turning the same way about it (convex
/// shapes, ellipses, stars, rounded polygons): such a ring is star-shaped from the centroid, hence simple, and its
/// non-zero region is its inside. Exact integer arithmetic: the cross products' signs, and the winding number
/// about the centroid counted by crossings of the ray to its right.
fn star_shaped(ring: &[IntPoint]) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let (mut sx, mut sy) = (0i64, 0i64);
    for p in ring {
        sx += i64::from(p.x);
        sy += i64::from(p.y);
    }
    let (cx, cy) = (sx / n as i64, sy / n as i64);
    let mut sign = 0i64;
    let mut winding = 0i64;
    for k in 0..n {
        let (a, b) = (ring[k], ring[(k + 1) % n]);
        let (ax, ay) = (i64::from(a.x) - cx, i64::from(a.y) - cy);
        let (bx, by) = (i64::from(b.x) - cx, i64::from(b.y) - cy);
        // Grid coordinates are within ±2^30, so each product fits in an i64; their difference overflows only
        // when they have opposite signs, and then the first one's sign is the answer.
        let (p, q) = (ax * by, ay * bx);
        let s = p.checked_sub(q).map_or(p.signum(), i64::signum);
        if s == 0 || (sign != 0 && s != sign) {
            return false;
        }
        sign = s;
        if ay <= 0 && by > 0 && s > 0 {
            winding += 1;
        } else if by <= 0 && ay > 0 && s < 0 {
            winding -= 1;
        }
    }
    winding.abs() == 1
}

/// Twice a contour's signed area, exactly (each term fits in an i64; a contour filling the grid's ±2^30 square
/// totals 2^63, so the sum is an i128).
fn int_area(c: &[IntPoint]) -> i128 {
    let mut a: i128 = 0;
    for k in 0..c.len() {
        let (p, q) = (c[k], c[(k + 1) % c.len()]);
        a += i128::from(i64::from(p.x) * i64::from(q.y) - i64::from(q.x) * i64::from(p.y));
    }
    a
}

/// One path's fill as contours wound +1 inside (0 outside), read as [`rings_to_area`] reads it: a ring covers
/// where it winds non-zero; EVENODD (or too many rings) is the XOR of the rings; NONZERO nests the rings and each
/// ring with a non-zero winding covers its inside minus its children's.
fn live_path_area(grid: &mut Grid, rings: &[Ring], rule: WindingRule) -> Vec<Vec<IntPoint>> {
    let ints: Vec<Vec<IntPoint>> = rings.iter().map(|r| grid.ring(r)).collect();
    // Each ring's own non-zero region (a ring may cross itself or run either way); a ring seen to be simple only
    // needs its direction.
    let alone = |ring: &Vec<IntPoint>| {
        if star_shaped(ring) {
            let mut ring = ring.clone();
            if int_area(&ring) < 0 {
                ring.reverse();
            }
            return vec![ring];
        }
        overlay_pass(
            std::slice::from_ref(ring),
            &[],
            OverlayRule::Subject,
            FillRule::NonZero,
        )
    };
    if ints.len() == 1 {
        return alone(&ints[0]);
    }
    if rule == WindingRule::Evenodd || ints.len() > MAX_NESTED_RINGS {
        let regions: Vec<Vec<IntPoint>> = ints.iter().flat_map(alone).collect();
        return overlay_pass(&regions, &[], OverlayRule::Subject, FillRule::EvenOdd);
    }
    let (parent, winding) = nest(rings);
    let mut out = Vec::new();
    for k in 0..ints.len() {
        if winding[k] == 0.0 || winding[k].is_nan() {
            continue;
        }
        let children: Vec<Vec<IntPoint>> = (0..ints.len())
            .filter(|&j| parent[j] == k as i64)
            .flat_map(|j| alone(&ints[j]))
            .collect();
        if children.is_empty() {
            out.extend(alone(&ints[k]));
        } else {
            out.extend(overlay_pass(
                std::slice::from_ref(&ints[k]),
                &children,
                OverlayRule::Difference,
                FillRule::NonZero,
            ));
        }
    }
    out
}

/// The live UNION or SUBTRACT of flattened operands (each a list of paths' rings and rules). Every operand's
/// paths become contours wound +1 inside, so their windings add up to the union; SUBTRACT takes the first operand
/// minus the others; also the grid's step and the input vertices it merged. Out of time, or past [`CLIP_VERTEX_LIMIT`], a union stacks those contours instead, as
/// [`run_clip`] does (NONZERO still paints the union).
fn live_overlay(
    operation: BooleanOperation,
    operands: &[Vec<(Vec<Ring>, WindingRule)>],
) -> (MultiPolygon, f64, Vec<(Pair, Pair)>) {
    let mut grid = Grid::new(
        operands
            .iter()
            .flatten()
            .flat_map(|(rings, _)| rings.iter().flatten()),
    );
    let mut contours: Vec<Vec<Vec<IntPoint>>> = operands
        .iter()
        .map(|paths| {
            paths
                .iter()
                .flat_map(|(rings, rule)| live_path_area(&mut grid, rings, *rule))
                .collect()
        })
        .collect();
    let vertices: usize = contours.iter().flatten().map(Vec::len).sum();
    let shapes: Vec<Vec<IntPoint>> = if operation == BooleanOperation::Subtract {
        if contours.is_empty() {
            return (Vec::new(), 1.0 / grid.scale, Vec::new());
        }
        let first = contours.remove(0);
        let rest: Vec<Vec<IntPoint>> = contours.into_iter().flatten().collect();
        overlay_pass(&first, &rest, OverlayRule::Difference, FillRule::NonZero)
    } else {
        if out_of_time() || vertices > CLIP_VERTEX_LIMIT {
            contours.into_iter().flatten().collect()
        } else {
            // Operands piled on each other (their boxes cover the union's box more than twice) lose most of
            // their vertices inside each other: unions of four at a time drop those early (bool200: 32 → 19 ms).
            // Spread ones keep theirs, and one pass is fastest (L1's set: 58 vs 85 ms).
            let mut list = contours;
            if overlap_density(&list) > 2.0 {
                while list.len() > 4 {
                    let mut next = Vec::new();
                    for group in list.chunks(4) {
                        next.push(overlay_pass(
                            &group.concat(),
                            &[],
                            OverlayRule::Subject,
                            FillRule::NonZero,
                        ));
                    }
                    list = next;
                }
            }
            let all: Vec<Vec<IntPoint>> = list.into_iter().flatten().collect();
            overlay_pass(&all, &[], OverlayRule::Subject, FillRule::NonZero)
        }
    };
    // Contours → polygons: each hole goes with the outer contour before it (overlay_pass keeps that order).
    let mut area: MultiPolygon = Vec::new();
    for contour in shapes {
        let ring: Ring = contour.iter().map(|&p| grid.back(p)).collect();
        if int_area(&contour) > 0 || area.is_empty() {
            area.push(vec![ring]);
        } else if let Some(polygon) = area.last_mut() {
            polygon.push(ring);
        }
    }
    (area, 1.0 / grid.scale, grid.merged)
}

/// How far apart two boolean answers are as areas (the engine switch's check for the live entry, shared/design/
/// boolean.ts `liveAreaDifference`): both filled at `tolerance`, the area of their symmetric difference, the
/// bounding box's area, and each one's area.
#[derive(Debug, Clone, Copy)]
pub struct AreaDifference {
    pub symmetric: f64,
    pub box_area: f64,
    pub area_a: f64,
    pub area_b: f64,
}

/// The area of a MultiPolygon (outer rings count, holes take away).
pub fn multipolygon_area(area: &MultiPolygon) -> f64 {
    area.iter()
        .map(|polygon| {
            polygon
                .iter()
                .enumerate()
                .map(|(k, ring)| {
                    let a = signed_area(ring).abs();
                    if k == 0 { a } else { -a }
                })
                .sum::<f64>()
        })
        .sum()
}

/// [`AreaDifference`] of two answers.
pub fn area_difference(a: &[VectorPath], b: &[VectorPath], tolerance: f64) -> AreaDifference {
    let (fa, fb) = (fill_area(a, tolerance), fill_area(b, tolerance));
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for &[x, y] in fa.iter().chain(&fb).flatten().flatten() {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    let box_area = if min_x <= max_x {
        (max_x - min_x) * (max_y - min_y)
    } else {
        0.0
    };
    let symmetric = multipolygon_area(&budgeted(|| {
        run_clip(Operation::Xor, &[fa.clone(), fb.clone()])
    }));
    AreaDifference {
        symmetric,
        box_area,
        area_a: multipolygon_area(&fa),
        area_b: multipolygon_area(&fb),
    }
}

// ── Documents ──────────────────────────────────────────────────────────────────────────────────

fn operand_paths(
    doc: &DesignDocument,
    node: &SceneNode,
    matrix: &Matrix,
    visiting: &mut Vec<String>,
) -> Option<Vec<VectorPath>> {
    if !node.visible {
        return None;
    }
    match node.kind {
        NodeType::BooleanOperation => {
            if visiting.contains(&node.id) {
                return None;
            }
            let inner = compute_boolean(doc, node, visiting);
            Some(transform_paths(&inner, matrix))
        }
        NodeType::Group => {
            let mut out = Vec::new();
            let mut any = false;
            for id in node.children.as_deref().unwrap_or_default() {
                let Some(child) = doc.nodes.get(id) else {
                    continue;
                };
                if let Some(paths) =
                    operand_paths(doc, child, &multiply(matrix, &node_matrix(child)), visiting)
                {
                    any = true;
                    out.extend(paths);
                }
            }
            any.then_some(out)
        }
        NodeType::Text | NodeType::Slice | NodeType::Page => None,
        _ => Some(transform_paths(&node_geometry(node), matrix)),
    }
}

fn compute_boolean(
    doc: &DesignDocument,
    node: &SceneNode,
    visiting: &mut Vec<String>,
) -> Vec<VectorPath> {
    visiting.push(node.id.clone());
    let mut operands = Vec::new();
    for id in node.children.as_deref().unwrap_or_default() {
        let Some(child) = doc.nodes.get(id) else {
            continue;
        };
        if let Some(paths) = operand_paths(doc, child, &node_matrix(child), visiting) {
            operands.push(paths);
        }
    }
    visiting.retain(|id| id != &node.id);
    combine_paths(
        node.boolean_operation.unwrap_or(BooleanOperation::Union),
        &operands,
        boolean_tolerance(node.width, node.height),
    )
}

/// The result of a BOOLEAN_OPERATION as paths in its own local space (`booleanGeometry`, uncached).
pub fn boolean_geometry(doc: &DesignDocument, bool_id: &str) -> Vec<VectorPath> {
    match doc.nodes.get(bool_id) {
        Some(node) if node.kind == NodeType::BooleanOperation => {
            compute_boolean(doc, node, &mut Vec::new())
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{ellipse_paths, star_path};

    /// `count` rotated ellipses and stars from a small LCG, in one space.
    fn operands(seed: u64, count: usize) -> Vec<Vec<VectorPath>> {
        let mut s = seed;
        let mut r = move || {
            s = s
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        (0..count)
            .map(|k| {
                let (w, h) = (20.0 + r() * 160.0, 20.0 + r() * 160.0);
                let paths = if k % 2 == 0 {
                    ellipse_paths(w, h, None)
                } else {
                    vec![VectorPath {
                        winding_rule: WindingRule::Nonzero,
                        commands: star_path(w, h, 5.0, 0.4, r() * 10.0),
                    }]
                };
                let (a, x, y) = (r() * std::f64::consts::TAU, r() * 400.0, r() * 400.0);
                let (c, sn) = (libm::cos(a), libm::sin(a));
                transform_paths(&paths, &[[c, -sn, x], [sn, c, y]])
            })
            .collect()
    }

    /// The live union and subtraction cover the exact ones' area (the engine switch allows 1e-6 of the box; these
    /// stay near 1e-9), with their own vertex lists, and the exact path is untouched by the live one.
    #[test]
    fn live_answers_cover_the_exact_area() {
        set_clock(|| 0.0);
        for operation in [BooleanOperation::Union, BooleanOperation::Subtract] {
            for count in [2, 12, 50] {
                let ops = operands(count as u64 * 31 + 7, count);
                let exact = combine_paths(operation, &ops, 0.01);
                let live = combine_paths_live(operation, &ops, 0.01);
                let d = area_difference(&exact, &live, 0.01);
                assert!(
                    d.symmetric <= 1e-7 * d.box_area,
                    "{operation:?} of {count}: {d:?}"
                );
                assert!(
                    (d.area_a - d.area_b).abs() <= 1e-7 * d.area_a.abs(),
                    "{operation:?} of {count}: {d:?}"
                );
                assert_eq!(combine_paths(operation, &ops, 0.01), exact);
            }
        }
        // INTERSECT and EXCLUDE are the exact answer.
        let ops = operands(3, 6);
        for operation in [BooleanOperation::Intersect, BooleanOperation::Exclude] {
            assert_eq!(
                combine_paths_live(operation, &ops, 0.01),
                combine_paths(operation, &ops, 0.01)
            );
        }
    }
}
