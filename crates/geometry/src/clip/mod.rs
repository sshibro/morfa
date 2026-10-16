//! Polygon boolean operations: a bit-exact port of the JavaScript library polygon-clipping
//! 0.15.7 (Martinez–Rueda–Feito sweep line), with its robust-predicates 3.0.3 `orient2d` and
//! splaytree 3.2.3 dependencies.
//!
//! Same operation order and floating-point expressions as the JS, so results are identical to
//! the bit; the JS's thrown errors are `Err(ClipError)`. Checked against the JS with
//! `scripts/geometry/clip-fuzz.mjs` and `examples/clip_check.rs`.

mod engine;
mod output;
mod robust;
mod small;
mod splay;

use engine::{
    BBox, Engine, MAX_QUEUE_SIZE, MAX_SWEEPLINE_SEGMENTS, NIL, RingIn, SweepLine, get_bbox_overlap,
};

pub type Pair = [f64; 2];
pub type Ring = Vec<Pair>;
pub type Polygon = Vec<Ring>;
pub type MultiPolygon = Vec<Polygon>;

/// The four polygon-clipping operations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Union,
    Intersection,
    Xor,
    Difference,
}

/// An error the JS library would have thrown (its caller catches and retries).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipError {
    pub message: String,
}

impl ClipError {
    fn new(message: String) -> Self {
        ClipError { message }
    }
}

impl std::fmt::Display for ClipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ClipError {}

fn invalid_input() -> ClipError {
    ClipError::new("Input geometry is not a valid Polygon or MultiPolygon".to_string())
}

/// `polygonClipping[op](geoms[0], ...geoms.slice(1))`, every geometry given as a MultiPolygon.
pub fn clip(op: Operation, geoms: &[MultiPolygon]) -> Result<MultiPolygon, ClipError> {
    // (`polygonClipping.union()` with no geometry throws in `new MultiPolyIn(undefined)`)
    if geoms.is_empty() {
        return Err(invalid_input());
    }
    run(op, geoms)
}

/// A `MultiPolyIn`: its bbox and the segments of its rings in `getSweepEvents` order (they
/// are created in that order, so they are a range of segment ids).
struct MultiPolyIn {
    bbox: BBox,
    segments: std::ops::Range<u32>,
}

/// `new RingIn(geomRing, poly, isExterior)`: appends the ring's segments and returns its bbox.
fn ring_in(
    eng: &mut Engine,
    geom_ring: &Ring,
    poly: u32,
    is_exterior: bool,
) -> Result<BBox, ClipError> {
    if geom_ring.is_empty() {
        return Err(invalid_input());
    }
    let ring = eng.rings_in.len() as u32;
    eng.rings_in.push(RingIn { poly, is_exterior });
    let (fx, fy) = eng.round_pt(geom_ring[0][0], geom_ring[0][1]);
    let first_point = eng.new_pt(fx, fy);
    let mut bbox = BBox {
        llx: fx,
        lly: fy,
        urx: fx,
        ury: fy,
    };
    let mut prev_point = first_point;
    let (mut px, mut py) = (fx, fy);
    for p in &geom_ring[1..] {
        let (x, y) = eng.round_pt(p[0], p[1]);
        // skip repeated points
        if x == px && y == py {
            continue;
        }
        let point = eng.new_pt(x, y);
        eng.seg_from_ring(prev_point, point, ring)?;
        if x < bbox.llx {
            bbox.llx = x;
        }
        if y < bbox.lly {
            bbox.lly = y;
        }
        if x > bbox.urx {
            bbox.urx = x;
        }
        if y > bbox.ury {
            bbox.ury = y;
        }
        prev_point = point;
        (px, py) = (x, y);
    }
    // add segment from last to first if last is not the same as first
    if fx != px || fy != py {
        eng.seg_from_ring(prev_point, first_point, ring)?;
    }
    Ok(bbox)
}

/// `new MultiPolyIn(geom, isSubject)` (with `new PolyIn` inlined).
fn multi_poly_in(
    eng: &mut Engine,
    geom: &MultiPolygon,
    is_subject: bool,
) -> Result<MultiPolyIn, ClipError> {
    let mp = eng.mp_is_subject.len() as u32;
    let mut bbox = BBox {
        llx: f64::INFINITY,
        lly: f64::INFINITY,
        urx: f64::NEG_INFINITY,
        ury: f64::NEG_INFINITY,
    };
    let first_segment = eng.segs.len() as u32;
    for geom_poly in geom {
        // PolyIn
        let poly = eng.poly_mp.len() as u32;
        eng.poly_mp.push(mp);
        let Some(exterior) = geom_poly.first() else {
            return Err(invalid_input());
        };
        let mut pb = ring_in(eng, exterior, poly, true)?;
        for geom_ring in &geom_poly[1..] {
            let rb = ring_in(eng, geom_ring, poly, false)?;
            if rb.llx < pb.llx {
                pb.llx = rb.llx;
            }
            if rb.lly < pb.lly {
                pb.lly = rb.lly;
            }
            if rb.urx > pb.urx {
                pb.urx = rb.urx;
            }
            if rb.ury > pb.ury {
                pb.ury = rb.ury;
            }
        }
        if pb.llx < bbox.llx {
            bbox.llx = pb.llx;
        }
        if pb.lly < bbox.lly {
            bbox.lly = pb.lly;
        }
        if pb.urx > bbox.urx {
            bbox.urx = pb.urx;
        }
        if pb.ury > bbox.ury {
            bbox.ury = pb.ury;
        }
    }
    eng.mp_is_subject.push(is_subject);
    Ok(MultiPolyIn {
        bbox,
        segments: first_segment..eng.segs.len() as u32,
    })
}

/// `Operation.run(type, geom, moreGeoms)`.
/// The arenas and trees of one operation, kept per thread between operations so that the
/// many small clips of an outline stroke do not allocate them again each time.
struct Pool {
    eng: Engine,
    sweep_line: SweepLine,
    new_events: Vec<u32>,
}

thread_local! {
    static POOL: std::cell::Cell<Option<Box<Pool>>> = const { std::cell::Cell::new(None) };
}

/// Operations bigger than this (in segments) give their memory back instead of pooling it.
const POOL_MAX_SEGMENTS: usize = 1 << 16;

fn run(op: Operation, geoms: &[MultiPolygon]) -> Result<MultiPolygon, ClipError> {
    let mut pool = POOL.with(|p| p.take()).unwrap_or_else(|| {
        Box::new(Pool {
            eng: Engine::new(op),
            sweep_line: SweepLine::new(),
            new_events: Vec::new(),
        })
    });
    let vertices = geoms.iter().flatten().flatten().map(|r| r.len()).sum();
    // (a reset Engine is `rounder.reset()`)
    pool.eng.reset(op, vertices);
    pool.sweep_line.clear();
    pool.new_events.clear();
    let result = run_in(&mut pool, op, geoms);
    if pool.eng.segs.capacity() <= POOL_MAX_SEGMENTS {
        POOL.with(|p| p.set(Some(pool)));
    }
    result
}

fn run_in(
    pool: &mut Pool,
    op: Operation,
    geoms: &[MultiPolygon],
) -> Result<MultiPolygon, ClipError> {
    let Pool {
        eng,
        sweep_line,
        new_events,
    } = pool;

    // Convert inputs to MultiPoly objects
    let mut multipolys = Vec::with_capacity(geoms.len());
    for (i, geom) in geoms.iter().enumerate() {
        multipolys.push(multi_poly_in(eng, geom, i == 0)?);
    }
    eng.num_multi_polys = multipolys.len();

    // BBox optimization for difference operation
    if op == Operation::Difference {
        let subject_bbox = multipolys[0].bbox;
        let mut i = 1;
        while i < multipolys.len() {
            if get_bbox_overlap(&multipolys[i].bbox, &subject_bbox).is_some() {
                i += 1;
            } else {
                multipolys.remove(i);
            }
        }
    }

    // BBox optimization for intersection operation
    if op == Operation::Intersection {
        for i in 0..multipolys.len() {
            for j in (i + 1)..multipolys.len() {
                if get_bbox_overlap(&multipolys[i].bbox, &multipolys[j].bbox).is_none() {
                    return Ok(Vec::new());
                }
            }
        }
    }

    // Put segment endpoints in a priority queue
    let queue = &mut sweep_line.queue;
    for m in &multipolys {
        for s in m.segments.clone() {
            for e in [eng.seg(s).left, eng.seg(s).right] {
                queue.insert(e, &mut |a, b| eng.ev_compare(a, b));
                if queue.size() > MAX_QUEUE_SIZE {
                    return Err(ClipError::new(
                        "Infinite loop when putting segment endpoints in a priority queue (queue size too big).".to_string(),
                    ));
                }
            }
        }
    }

    // Pass the sweep line over those endpoints
    let mut prev_queue_size = sweep_line.queue.size();
    let mut node = sweep_line.queue.pop(&mut |a, b| eng.ev_compare(a, b));
    while let Some(evt) = node {
        if sweep_line.queue.size() == prev_queue_size {
            let e = eng.ev(evt);
            return Err(ClipError::new(format!(
                "Unable to pop() {} SweepEvent [{}, {}] from segment #{} from queue.",
                if e.is_left { "left" } else { "right" },
                eng.pts[e.point as usize].x,
                eng.pts[e.point as usize].y,
                e.segment + 1
            )));
        }
        if sweep_line.queue.size() > MAX_QUEUE_SIZE {
            return Err(ClipError::new(
                "Infinite loop when passing sweep line over endpoints (queue size too big)."
                    .to_string(),
            ));
        }
        if sweep_line.segments.len() > MAX_SWEEPLINE_SEGMENTS {
            return Err(ClipError::new(
                "Infinite loop when passing sweep line over endpoints (too many sweep line segments).".to_string(),
            ));
        }
        new_events.clear();
        sweep_line.process(eng, evt, new_events)?;
        for &e in new_events.iter() {
            if eng.ev(e).consumed_by == NIL {
                sweep_line.queue.insert(e, &mut |a, b| eng.ev_compare(a, b));
            }
        }
        prev_queue_size = sweep_line.queue.size();
        node = sweep_line.queue.pop(&mut |a, b| eng.ev_compare(a, b));
    }

    // Collect and compile segments we're keeping into a multipolygon
    let mut out = output::Output::new(eng);
    let rings_out = out.factory(&sweep_line.segments)?;
    let polys = out.compose_polys(&rings_out)?;
    out.multi_geom(&polys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, s: f64) -> MultiPolygon {
        vec![vec![vec![
            [x, y],
            [x + s, y],
            [x + s, y + s],
            [x, y + s],
            [x, y],
        ]]]
    }

    #[test]
    fn union_of_overlapping_squares() {
        let r = clip(
            Operation::Union,
            &[square(0.0, 0.0, 2.0), square(1.0, 1.0, 2.0)],
        )
        .unwrap();
        assert_eq!(
            r,
            vec![vec![vec![
                [0.0, 0.0],
                [2.0, 0.0],
                [2.0, 1.0],
                [3.0, 1.0],
                [3.0, 3.0],
                [1.0, 3.0],
                [1.0, 2.0],
                [0.0, 2.0],
                [0.0, 0.0]
            ]]]
        );
    }

    #[test]
    fn difference_makes_a_hole() {
        let r = clip(
            Operation::Difference,
            &[square(0.0, 0.0, 4.0), square(1.0, 1.0, 2.0)],
        )
        .unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].len(), 2);
    }

    #[test]
    fn empty_and_invalid_inputs() {
        assert_eq!(
            clip(Operation::Union, &[vec![]]).unwrap(),
            Vec::<Polygon>::new()
        );
        assert_eq!(
            clip(Operation::Intersection, &[square(0.0, 0.0, 1.0), vec![]]).unwrap(),
            Vec::<Polygon>::new()
        );
        assert!(clip(Operation::Union, &[vec![vec![]]]).is_err());
        assert!(clip(Operation::Union, &[vec![vec![vec![]]]]).is_err());
        assert!(clip(Operation::Union, &[]).is_err());
    }
}
