//! The sweep-line part of polygon-clipping 0.15.7: rounder, `SweepEvent`, `Segment`, the
//! input rings and `SweepLine`. JS objects become arena entries addressed by `u32` ids; JS
//! object identity (`a.point === b.point`) becomes id equality.

use super::small::SmallVec;
use super::splay::SplayTree;
use super::{ClipError, Operation};

/// JS `null` / `undefined` for an arena id.
pub(super) const NIL: u32 = u32::MAX;

/// polygon-clipping's `epsilon` (`Number.EPSILON`, 2^-52) and `EPSILON_SQ`.
const EPS: f64 = f64::EPSILON;
const EPS_SQ: f64 = EPS * EPS;

/// `cmp`: the FLP comparator the rounder snaps with.
fn flp_cmp(a: f64, b: f64) -> i32 {
    // check if they're both 0
    if -EPS < a && a < EPS && -EPS < b && b < EPS {
        return 0;
    }
    // check if they're flp equal
    let ab = a - b;
    if ab * ab < EPS_SQ * a * b {
        return 0;
    }
    if a < b { -1 } else { 1 }
}

/// splaytree's default comparator.
fn num_cmp(a: f64, b: f64) -> i32 {
    if a > b {
        1
    } else if a < b {
        -1
    } else {
        0
    }
}

/// `CoordRounder`.
pub(super) struct CoordRounder {
    tree: SplayTree<f64>,
}

impl CoordRounder {
    pub(super) fn new() -> Self {
        let mut r = CoordRounder {
            tree: SplayTree::new(),
        };
        // preseed with 0 so we don't end up with values < Number.EPSILON
        r.round(0.0);
        r
    }

    /// A fresh rounder (`new CoordRounder()`), keeping the tree's memory.
    fn reset(&mut self) {
        self.tree.clear();
        self.round(0.0);
    }

    /// `CoordRounder.round`.
    pub(super) fn round(&mut self, coord: f64) -> f64 {
        let mut c = num_cmp;
        let node = self.tree.add(coord, &mut c);
        let node_key = self.tree.key(node);
        if let Some(prev) = self.tree.prev(node, &mut c) {
            let pk = self.tree.key(prev);
            if flp_cmp(node_key, pk) == 0 {
                self.tree.remove(coord, &mut c);
                return pk;
            }
        }
        if let Some(next) = self.tree.next(node, &mut c) {
            let nk = self.tree.key(next);
            if flp_cmp(node_key, nk) == 0 {
                self.tree.remove(coord, &mut c);
                return nk;
            }
        }
        coord
    }
}

/// A JS point object `{x, y, events}`; `events` empty means JS `undefined`.
pub(super) struct Pt {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) events: SmallVec<u32, 4>,
}

/// A segment's `rings` with its `windings` (always the same length in the JS), as pairs.
pub(super) type Rings = SmallVec<(u32, i32), 2>;

/// `SweepEvent`.
pub(super) struct Ev {
    /// The coordinates of `point` (kept in step with it: points never move, and `link`
    /// only moves an event to a point with equal coordinates, but -0 vs 0 can differ).
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) point: u32,
    pub(super) is_left: bool,
    pub(super) segment: u32,
    pub(super) other: u32,
    pub(super) consumed_by: u32,
}

/// The `{rings, windings, multiPolys}` state objects of `Segment.afterState`.
pub(super) struct State {
    /// `rings` with `windings` (without the rings whose winding is 0, see `ensure_after`)
    pub(super) rings: SmallVec<(u32, i32), 4>,
    pub(super) mps: SmallVec<u32, 4>,
}

/// The coordinates of a segment's `leftSE.point` and `rightSE.point` (kept in step by
/// `refresh_coords`), apart from the rest of `Seg` so that the comparators touch little memory.
#[derive(Clone, Copy)]
pub(super) struct SegXY {
    pub(super) lx: f64,
    pub(super) ly: f64,
    pub(super) rx: f64,
    pub(super) ry: f64,
}

/// `Segment`. The id (creation order) is the arena index.
pub(super) struct Seg {
    pub(super) left: u32,
    pub(super) right: u32,
    /// `rings` and `windings`, `null` after the segment was consumed.
    pub(super) rings: Option<Rings>,
    pub(super) ring_out: u32,
    pub(super) consumed_by: u32,
    pub(super) prev: u32,
    /// `_prevInResult` (outer `None` = undefined, `Some(NIL)` = null).
    pub(super) prev_in_result: Option<u32>,
    /// `_beforeState`: the segment whose after state it is (`Some(NIL)` = the empty state).
    pub(super) before_src: Option<u32>,
    pub(super) in_result: Option<bool>,
    /// Re-entrance marks for the recursive JS getters (a cycle overflows the JS stack).
    pub(super) visiting: bool,
    pub(super) visiting_pir: bool,
}

/// `RingIn` (only what later code reads).
pub(super) struct RingIn {
    pub(super) poly: u32,
    pub(super) is_exterior: bool,
}

/// A bbox `{ll: {x, y}, ur: {x, y}}`.
#[derive(Clone, Copy)]
pub(super) struct BBox {
    pub(super) llx: f64,
    pub(super) lly: f64,
    pub(super) urx: f64,
    pub(super) ury: f64,
}

/// `isInBbox`.
#[inline]
fn is_in_bbox(b: &BBox, x: f64, y: f64) -> bool {
    b.llx <= x && x <= b.urx && b.lly <= y && y <= b.ury
}

/// `getBboxOverlap`.
pub(super) fn get_bbox_overlap(b1: &BBox, b2: &BBox) -> Option<BBox> {
    if b2.urx < b1.llx || b1.urx < b2.llx || b2.ury < b1.lly || b1.ury < b2.lly {
        return None;
    }
    let lower_x = if b1.llx < b2.llx { b2.llx } else { b1.llx };
    let upper_x = if b1.urx < b2.urx { b1.urx } else { b2.urx };
    let lower_y = if b1.lly < b2.lly { b2.lly } else { b1.lly };
    let upper_y = if b1.ury < b2.ury { b1.ury } else { b2.ury };
    Some(BBox {
        llx: lower_x,
        lly: lower_y,
        urx: upper_x,
        ury: upper_y,
    })
}

/// `intersection$1` (with `verticalIntersection` / `horizontalIntersection` inlined).
fn line_intersection(
    (p1x, p1y): (f64, f64),
    (v1x, v1y): (f64, f64),
    (p2x, p2y): (f64, f64),
    (v2x, v2y): (f64, f64),
) -> Option<(f64, f64)> {
    // verticalIntersection(pt, v, x)
    let vertical = |px: f64, py: f64, vx: f64, vy: f64, x: f64| {
        if vx == 0.0 {
            return None;
        }
        Some((x, py + vy / vx * (x - px)))
    };
    // horizontalIntersection(pt, v, y)
    let horizontal = |px: f64, py: f64, vx: f64, vy: f64, y: f64| {
        if vy == 0.0 {
            return None;
        }
        Some((px + vx / vy * (y - py), y))
    };
    if v1x == 0.0 {
        return vertical(p2x, p2y, v2x, v2y, p1x);
    }
    if v2x == 0.0 {
        return vertical(p1x, p1y, v1x, v1y, p2x);
    }
    if v1y == 0.0 {
        return horizontal(p2x, p2y, v2x, v2y, p1y);
    }
    if v2y == 0.0 {
        return horizontal(p1x, p1y, v1x, v1y, p2y);
    }
    let kross = v1x * v2y - v1y * v2x;
    if kross == 0.0 {
        return None;
    }
    let vex = p2x - p1x;
    let vey = p2y - p1y;
    let d1 = (vex * v1y - vey * v1x) / kross;
    let d2 = (vex * v2y - vey * v2x) / kross;
    let x1 = p1x + d2 * v1x;
    let x2 = p2x + d1 * v2x;
    let y1 = p1y + d2 * v1y;
    let y2 = p2y + d1 * v2y;
    let x = (x1 + x2) / 2.0;
    let y = (y1 + y2) / 2.0;
    Some((x, y))
}

pub(super) fn type_error(what: &str) -> ClipError {
    ClipError::new(format!("TypeError: {what}"))
}

/// All per-operation state: the arenas plus the module-level `rounder` and `operation`.
pub(super) struct Engine {
    pub(super) op: Operation,
    pub(super) num_multi_polys: usize,
    pub(super) pts: Vec<Pt>,
    pub(super) evs: Vec<Ev>,
    pub(super) segs: Vec<Seg>,
    /// Endpoint coordinates per segment (see `SegXY`).
    pub(super) xy: Vec<SegXY>,
    pub(super) rings_in: Vec<RingIn>,
    /// `PolyIn.multiPoly` per poly id.
    pub(super) poly_mp: Vec<u32>,
    /// `MultiPolyIn.isSubject` per multipoly id.
    pub(super) mp_is_subject: Vec<bool>,
    x_rounder: CoordRounder,
    y_rounder: CoordRounder,
}

impl Engine {
    pub(super) fn new(op: Operation) -> Self {
        Engine {
            op,
            num_multi_polys: 0,
            pts: Vec::new(),
            evs: Vec::new(),
            segs: Vec::new(),
            xy: Vec::new(),
            rings_in: Vec::new(),
            poly_mp: Vec::new(),
            mp_is_subject: Vec::new(),
            x_rounder: CoordRounder::new(),
            y_rounder: CoordRounder::new(),
        }
    }

    /// Prepares a used engine for a new operation: `rounder.reset()` and empty arenas (their
    /// memory is kept), with room for about `vertices` input vertices.
    pub(super) fn reset(&mut self, op: Operation, vertices: usize) {
        self.op = op;
        self.num_multi_polys = 0;
        self.pts.clear();
        self.evs.clear();
        self.segs.clear();
        self.xy.clear();
        self.rings_in.clear();
        self.poly_mp.clear();
        self.mp_is_subject.clear();
        self.x_rounder.reset();
        self.y_rounder.reset();
        // (splits add more; these are only the input's)
        self.pts.reserve(vertices);
        self.evs.reserve(2 * vertices);
        self.segs.reserve(vertices);
        self.xy.reserve(vertices);
    }

    /// `rounder.round(x, y)`, allocating the returned point object.
    pub(super) fn round_pt(&mut self, x: f64, y: f64) -> (f64, f64) {
        let x = self.x_rounder.round(x);
        let y = self.y_rounder.round(y);
        (x, y)
    }

    pub(super) fn new_pt(&mut self, x: f64, y: f64) -> u32 {
        self.pts.push(Pt {
            x,
            y,
            events: SmallVec::new(),
        });
        (self.pts.len() - 1) as u32
    }

    #[inline]
    fn pt(&self, p: u32) -> &Pt {
        &self.pts[p as usize]
    }
    #[inline]
    pub(super) fn ev(&self, e: u32) -> &Ev {
        &self.evs[e as usize]
    }
    #[inline]
    pub(super) fn seg(&self, s: u32) -> &Seg {
        &self.segs[s as usize]
    }
    #[inline]
    pub(super) fn xy(&self, s: u32) -> SegXY {
        self.xy[s as usize]
    }
    #[inline]
    pub(super) fn ev_pt(&self, e: u32) -> &Pt {
        self.pt(self.ev(e).point)
    }
    /// Re-reads a segment's endpoint coordinates after its events changed.
    #[inline]
    fn refresh_coords(&mut self, s: u32) {
        let (l, r) = (self.seg(s).left, self.seg(s).right);
        let (lx, ly) = (self.ev(l).x, self.ev(l).y);
        let (rx, ry) = (self.ev(r).x, self.ev(r).y);
        self.xy[s as usize] = SegXY { lx, ly, rx, ry };
    }

    // ---- SweepEvent ----

    /// `new SweepEvent(point, isLeft)`.
    fn new_ev(&mut self, point: u32, is_left: bool) -> u32 {
        let id = self.evs.len() as u32;
        let (x, y) = (self.pt(point).x, self.pt(point).y);
        self.evs.push(Ev {
            x,
            y,
            point,
            is_left,
            segment: NIL,
            other: NIL,
            consumed_by: NIL,
        });
        self.pts[point as usize].events.push(id);
        id
    }

    /// `SweepEvent.comparePoints` on two point ids.
    #[inline]
    pub(super) fn compare_points(&self, a: u32, b: u32) -> i32 {
        let a = self.pt(a);
        let b = self.pt(b);
        compare_xy(a.x, a.y, b.x, b.y)
    }

    /// `SweepEvent.compare` (it links coincident points as a side effect).
    pub(super) fn ev_compare(&mut self, a: u32, b: u32) -> i32 {
        let ea = self.ev(a);
        let eb = self.ev(b);
        let pt_cmp = compare_xy(ea.x, ea.y, eb.x, eb.y);
        if pt_cmp != 0 {
            return pt_cmp;
        }
        let (pa, pb) = (ea.point, eb.point);
        // the points are the same, so link them if needed
        if pa != pb {
            self.link(a, b);
        }
        // favor right events over left
        let al = self.ev(a).is_left;
        if al != self.ev(b).is_left {
            return if al { 1 } else { -1 };
        }
        self.seg_compare(self.ev(a).segment, self.ev(b).segment)
    }

    /// `SweepEvent.link`.
    fn link(&mut self, this: u32, other: u32) {
        let tp = self.ev(this).point;
        let op = self.ev(other).point;
        // (other.point === this.point is excluded by the caller)
        let n = self.pt(op).events.len();
        let (tx, ty) = (self.pt(tp).x, self.pt(tp).y);
        for i in 0..n {
            let evt = self.pts[op as usize].events.as_slice()[i];
            self.pts[tp as usize].events.push(evt);
            let e = &mut self.evs[evt as usize];
            e.point = tp;
            e.x = tx;
            e.y = ty;
            let s = e.segment;
            if s != NIL {
                self.refresh_coords(s);
            }
        }
        self.check_for_consuming(this);
    }

    /// `SweepEvent.checkForConsuming`.
    fn check_for_consuming(&mut self, this: u32) {
        let p = self.ev(this).point as usize;
        let num_events = self.pts[p].events.len();
        for i in 0..num_events {
            let evt1 = self.pts[p].events.as_slice()[i];
            if self.seg(self.ev(evt1).segment).consumed_by != NIL {
                continue;
            }
            for j in (i + 1)..num_events {
                let evt2 = self.pts[p].events.as_slice()[j];
                if self.ev(evt2).consumed_by != NIL {
                    continue;
                }
                if self.ev(self.ev(evt1).other).point != self.ev(self.ev(evt2).other).point {
                    continue;
                }
                self.consume(self.ev(evt1).segment, self.ev(evt2).segment);
            }
        }
    }

    // ---- Segment ----

    /// `new Segment(leftSE, rightSE, rings, windings)`.
    fn new_seg(&mut self, left: u32, right: u32, rings: Rings) -> u32 {
        let id = self.segs.len() as u32;
        self.evs[left as usize].segment = id;
        self.evs[left as usize].other = right;
        self.evs[right as usize].segment = id;
        self.evs[right as usize].other = left;
        self.segs.push(Seg {
            left,
            right,
            rings: Some(rings),
            ring_out: NIL,
            consumed_by: NIL,
            prev: NIL,
            prev_in_result: None,
            before_src: None,
            in_result: None,
            visiting: false,
            visiting_pir: false,
        });
        self.xy.push(SegXY {
            lx: 0.0,
            ly: 0.0,
            rx: 0.0,
            ry: 0.0,
        });
        self.refresh_coords(id);
        id
    }

    /// `Segment.fromRing(pt1, pt2, ring)`.
    pub(super) fn seg_from_ring(
        &mut self,
        pt1: u32,
        pt2: u32,
        ring: u32,
    ) -> Result<u32, ClipError> {
        let cmp_pts = self.compare_points(pt1, pt2);
        let (left_pt, right_pt, winding) = if cmp_pts < 0 {
            (pt1, pt2, 1)
        } else if cmp_pts > 0 {
            (pt2, pt1, -1)
        } else {
            let p = self.pt(pt1);
            return Err(ClipError::new(format!(
                "Tried to create degenerate segment at [{}, {}]",
                p.x, p.y
            )));
        };
        let left_se = self.new_ev(left_pt, true);
        let right_se = self.new_ev(right_pt, false);
        Ok(self.new_seg(left_se, right_se, Rings::one((ring, winding))))
    }

    /// `Segment.compare`.
    pub(super) fn seg_compare(&self, a: u32, b: u32) -> i32 {
        let (sa, sb) = (self.xy(a), self.xy(b));
        let alx = sa.lx;
        let blx = sb.lx;
        let arx = sa.rx;
        let brx = sb.rx;

        // check if they're even in the same vertical plane
        if brx < alx {
            return 1;
        }
        if arx < blx {
            return -1;
        }
        let aly = sa.ly;
        let bly = sb.ly;
        let ary = sa.ry;
        let bry = sb.ry;

        // is left endpoint of segment B the right-more?
        if alx < blx {
            if bly < aly && bly < ary {
                return 1;
            }
            if bly > aly && bly > ary {
                return -1;
            }
            let a_cmp_b_left = self.compare_point(a, blx, bly);
            if a_cmp_b_left < 0 {
                return 1;
            }
            if a_cmp_b_left > 0 {
                return -1;
            }
            let b_cmp_a_right = self.compare_point(b, arx, ary);
            if b_cmp_a_right != 0 {
                return b_cmp_a_right;
            }
            return -1;
        }

        // is left endpoint of segment A the right-more?
        if alx > blx {
            if aly < bly && aly < bry {
                return -1;
            }
            if aly > bly && aly > bry {
                return 1;
            }
            let b_cmp_a_left = self.compare_point(b, alx, aly);
            if b_cmp_a_left != 0 {
                return b_cmp_a_left;
            }
            let a_cmp_b_right = self.compare_point(a, brx, bry);
            if a_cmp_b_right < 0 {
                return 1;
            }
            if a_cmp_b_right > 0 {
                return -1;
            }
            return 1;
        }

        // alx === blx: consider the lower left-endpoint to come first
        if aly < bly {
            return -1;
        }
        if aly > bly {
            return 1;
        }

        // left endpoints are identical
        if arx < brx {
            let b_cmp_a_right = self.compare_point(b, arx, ary);
            if b_cmp_a_right != 0 {
                return b_cmp_a_right;
            }
        }
        if arx > brx {
            let a_cmp_b_right = self.compare_point(a, brx, bry);
            if a_cmp_b_right < 0 {
                return 1;
            }
            if a_cmp_b_right > 0 {
                return -1;
            }
        }
        if arx != brx {
            // are these two [almost] vertical segments with opposite orientation?
            let ay = ary - aly;
            let ax = arx - alx;
            let by = bry - bly;
            let bx = brx - blx;
            if ay > ax && by < bx {
                return 1;
            }
            if ay < ax && by > bx {
                return -1;
            }
        }
        if arx > brx {
            return 1;
        }
        if arx < brx {
            return -1;
        }
        if ary < bry {
            return -1;
        }
        if ary > bry {
            return 1;
        }
        // fall back on creation order
        if a < b {
            return -1;
        }
        if a > b {
            return 1;
        }
        0
    }

    /// `Segment.replaceRightSE`.
    fn replace_right_se(&mut self, s: u32, new_right: u32) {
        self.segs[s as usize].right = new_right;
        self.evs[new_right as usize].segment = s;
        let left = self.seg(s).left;
        self.evs[new_right as usize].other = left;
        self.evs[left as usize].other = new_right;
        self.refresh_coords(s);
    }

    /// `Segment.bbox`.
    fn seg_bbox(&self, s: u32) -> BBox {
        let seg = self.xy(s);
        let y1 = seg.ly;
        let y2 = seg.ry;
        BBox {
            llx: seg.lx,
            lly: if y1 < y2 { y1 } else { y2 },
            urx: seg.rx,
            ury: if y1 > y2 { y1 } else { y2 },
        }
    }

    /// `Segment.isAnEndpoint`.
    pub(super) fn is_an_endpoint(&self, s: u32, x: f64, y: f64) -> bool {
        let seg = self.xy(s);
        (x == seg.lx && y == seg.ly) || (x == seg.rx && y == seg.ry)
    }

    /// `Segment.comparePoint`.
    fn compare_point(&self, s: u32, px: f64, py: f64) -> i32 {
        let seg = self.xy(s);
        let (lx, ly, rx, ry) = (seg.lx, seg.ly, seg.rx, seg.ry);
        // isAnEndpoint
        if (px == lx && py == ly) || (px == rx && py == ry) {
            return 0;
        }
        let vx = rx - lx;
        let vy = ry - ly;

        // Exactly vertical segments.
        if lx == rx {
            if px == lx {
                return 0;
            }
            return if px < lx { 1 } else { -1 };
        }

        // Nearly vertical segments with an intersection.
        let y_dist = (py - ly) / vy;
        let x_from_y_dist = lx + y_dist * vx;
        if px == x_from_y_dist {
            return 0;
        }

        // General case.
        let x_dist = (px - lx) / vx;
        let y_from_x_dist = ly + x_dist * vy;
        if py == y_from_x_dist {
            return 0;
        }
        if py < y_from_x_dist { -1 } else { 1 }
    }

    /// `Segment.getIntersection`: returns a point id (an existing endpoint object or a new
    /// rounded point).
    pub(super) fn get_intersection(&mut self, this: u32, other: u32) -> Option<u32> {
        let t_bbox = self.seg_bbox(this);
        let o_bbox = self.seg_bbox(other);
        let bbox_overlap = get_bbox_overlap(&t_bbox, &o_bbox)?;

        let tlp_id = self.ev(self.seg(this).left).point;
        let trp_id = self.ev(self.seg(this).right).point;
        let olp_id = self.ev(self.seg(other).left).point;
        let orp_id = self.ev(self.seg(other).right).point;
        let (t, o) = (self.xy(this), self.xy(other));
        let (tlx, tly, trx, try_) = (t.lx, t.ly, t.rx, t.ry);
        let (olx, oly, orx, ory) = (o.lx, o.ly, o.rx, o.ry);

        let touches_other_lse =
            is_in_bbox(&t_bbox, olx, oly) && self.compare_point(this, olx, oly) == 0;
        let touches_this_lse =
            is_in_bbox(&o_bbox, tlx, tly) && self.compare_point(other, tlx, tly) == 0;
        let touches_other_rse =
            is_in_bbox(&t_bbox, orx, ory) && self.compare_point(this, orx, ory) == 0;
        let touches_this_rse =
            is_in_bbox(&o_bbox, trx, try_) && self.compare_point(other, trx, try_) == 0;

        // do left endpoints match?
        if touches_this_lse && touches_other_lse {
            if touches_this_rse && !touches_other_rse {
                return Some(trp_id);
            }
            if !touches_this_rse && touches_other_rse {
                return Some(orp_id);
            }
            return None;
        }

        // does this left endpoint matches (other doesn't)
        if touches_this_lse {
            if touches_other_rse && tlx == orx && tly == ory {
                return None;
            }
            return Some(tlp_id);
        }

        // does other left endpoint matches (this doesn't)
        if touches_other_lse {
            if touches_this_rse && trx == olx && try_ == oly {
                return None;
            }
            return Some(olp_id);
        }

        // trivial intersection on right endpoints
        if touches_this_rse && touches_other_rse {
            return None;
        }

        // t-intersections on just one right endpoint
        if touches_this_rse {
            return Some(trp_id);
        }
        if touches_other_rse {
            return Some(orp_id);
        }

        // general intersection between the infinite lines
        let (px, py) = line_intersection(
            (tlx, tly),
            (trx - tlx, try_ - tly),
            (olx, oly),
            (orx - olx, ory - oly),
        )?;

        // is the intersection found between the lines not on the segments?
        if !is_in_bbox(&bbox_overlap, px, py) {
            return None;
        }

        let (x, y) = self.round_pt(px, py);
        Some(self.new_pt(x, y))
    }

    /// `Segment.split(point)`: returns `[newRightSE, newLeftSE]`.
    pub(super) fn split(&mut self, s: u32, point: u32) -> Result<[u32; 2], ClipError> {
        let already_linked = !self.pt(point).events.is_empty();
        let new_left_se = self.new_ev(point, true);
        let new_right_se = self.new_ev(point, false);
        let old_right_se = self.seg(s).right;
        self.replace_right_se(s, new_right_se);
        let rings = self
            .seg(s)
            .rings
            .clone()
            .ok_or_else(|| type_error("Cannot read properties of null (reading 'slice')"))?;
        let new_seg = self.new_seg(new_left_se, old_right_se, rings);

        // when splitting a nearly vertical downward-facing segment, sometimes one of the
        // resulting new segments is vertical, in which case its events may need swapping
        if self.compare_points(
            self.ev(self.seg(new_seg).left).point,
            self.ev(self.seg(new_seg).right).point,
        ) > 0
        {
            self.swap_events(new_seg);
        }
        if self.compare_points(
            self.ev(self.seg(s).left).point,
            self.ev(self.seg(s).right).point,
        ) > 0
        {
            self.swap_events(s);
        }

        if already_linked {
            self.check_for_consuming(new_left_se);
            self.check_for_consuming(new_right_se);
        }
        Ok([new_right_se, new_left_se])
    }

    /// `Segment.swapEvents`.
    fn swap_events(&mut self, s: u32) {
        let seg = &mut self.segs[s as usize];
        std::mem::swap(&mut seg.left, &mut seg.right);
        let (l, r) = (seg.left, seg.right);
        if let Some(rings) = seg.rings.as_mut() {
            for (_, w) in rings.as_mut_slice() {
                *w *= -1;
            }
        }
        self.evs[l as usize].is_left = true;
        self.evs[r as usize].is_left = false;
        self.refresh_coords(s);
    }

    /// `Segment.consume`.
    fn consume(&mut self, this: u32, other: u32) {
        let mut consumer = this;
        let mut consumee = other;
        while self.seg(consumer).consumed_by != NIL {
            consumer = self.seg(consumer).consumed_by;
        }
        while self.seg(consumee).consumed_by != NIL {
            consumee = self.seg(consumee).consumed_by;
        }
        let cmp = self.seg_compare(consumer, consumee);
        if cmp == 0 {
            return; // already consumed
        }
        // the winner of the consumption is the earlier segment according to sweep line ordering
        if cmp > 0 {
            std::mem::swap(&mut consumer, &mut consumee);
        }
        // make sure a segment doesn't consume it's prev
        if self.seg(consumer).prev == consumee {
            std::mem::swap(&mut consumer, &mut consumee);
        }
        // (both segments are unconsumed here, so their rings are never null)
        let ee_rings = self.segs[consumee as usize]
            .rings
            .take()
            .unwrap_or_default();
        if let Some(rings) = self.segs[consumer as usize].rings.as_mut() {
            for &(ring, winding) in ee_rings.as_slice() {
                match rings.as_slice().iter().position(|&(r, _)| r == ring) {
                    None => rings.push((ring, winding)),
                    Some(index) => rings.as_mut_slice()[index].1 += winding,
                }
            }
        }
        self.segs[consumee as usize].consumed_by = consumer;
        // mark sweep events consumed as to maintain ordering in sweep event queue
        let (cl, cr) = (self.seg(consumer).left, self.seg(consumer).right);
        let (el, er) = (self.seg(consumee).left, self.seg(consumee).right);
        self.evs[el as usize].consumed_by = cl;
        self.evs[er as usize].consumed_by = cr;
    }
}

/// `SweepEvent.comparePoints` on coordinates.
#[inline]
pub(super) fn compare_xy(ax: f64, ay: f64, bx: f64, by: f64) -> i32 {
    if ax < bx {
        return -1;
    }
    if ax > bx {
        return 1;
    }
    if ay < by {
        return -1;
    }
    if ay > by {
        return 1;
    }
    0
}

/// Limits on iterative processes (`POLYGON_CLIPPING_MAX_QUEUE_SIZE` and
/// `POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS`, both 1 000 000 by default).
pub(super) const MAX_QUEUE_SIZE: usize = 1_000_000;
pub(super) const MAX_SWEEPLINE_SEGMENTS: usize = 1_000_000;

/// Reported where the JS would loop forever (no JS equivalent: it never returns).
pub(super) fn tree_cycle() -> ClipError {
    ClipError::new("SweepLine tree is corrupted: the JS would loop forever".to_string())
}

/// `SweepLine`.
pub(super) struct SweepLine {
    pub(super) queue: SplayTree<u32>,
    tree: SplayTree<u32>,
    pub(super) segments: Vec<u32>,
}

impl SweepLine {
    pub(super) fn new() -> Self {
        SweepLine {
            queue: SplayTree::new(),
            tree: SplayTree::new(),
            segments: Vec::new(),
        }
    }

    /// Empties the structures, keeping their memory for the next operation.
    pub(super) fn clear(&mut self) {
        self.queue.clear();
        self.tree.clear();
        self.segments.clear();
    }

    /// `SweepLine.process(event)`: appends the new events to `new_events`.
    pub(super) fn process(
        &mut self,
        eng: &mut Engine,
        event: u32,
        new_events: &mut Vec<u32>,
    ) -> Result<(), ClipError> {
        let segment = eng.ev(event).segment;
        let is_left = eng.ev(event).is_left;

        // if we've already been consumed by another segment, clean up our body parts and get out
        if eng.ev(event).consumed_by != NIL {
            if is_left {
                let other = eng.ev(event).other;
                self.queue.remove(other, &mut |a, b| eng.ev_compare(a, b));
            } else {
                self.tree.remove(segment, &mut |a, b| eng.seg_compare(a, b));
            }
            return Ok(());
        }
        let node = if is_left {
            Some(self.tree.add(segment, &mut |a, b| eng.seg_compare(a, b)))
        } else {
            self.tree.find(segment, &mut |a, b| eng.seg_compare(a, b))
        };
        let Some(node) = node else {
            let seg = eng.xy(segment);
            return Err(ClipError::new(format!(
                "Unable to find segment #{} [{}, {}] -> [{}, {}] in SweepLine tree.",
                segment + 1,
                seg.lx,
                seg.ly,
                seg.rx,
                seg.ry
            )));
        };

        // skip consumed segments still in tree
        // (guard: with an inconsistent comparator `prev`/`next` can cycle among consumed
        // segments; the JS then loops forever, we report an error instead)
        let limit = self.tree.size();
        let mut steps = 0;
        let mut prev_node = node;
        let prev_seg = loop {
            steps += 1;
            if steps > limit {
                return Err(tree_cycle());
            }
            match self.tree.prev(prev_node, &mut |a, b| eng.seg_compare(a, b)) {
                None => break NIL,
                Some(n) => {
                    prev_node = n;
                    let k = self.tree.key(n);
                    if eng.seg(k).consumed_by == NIL {
                        break k;
                    }
                }
            }
        };
        let mut steps = 0;
        let mut next_node = node;
        let next_seg = loop {
            steps += 1;
            if steps > limit {
                return Err(tree_cycle());
            }
            match self.tree.next(next_node, &mut |a, b| eng.seg_compare(a, b)) {
                None => break NIL,
                Some(n) => {
                    next_node = n;
                    let k = self.tree.key(n);
                    if eng.seg(k).consumed_by == NIL {
                        break k;
                    }
                }
            }
        };

        if is_left {
            // Check for intersections against the previous segment in the sweep line
            let mut prev_my_splitter = NIL;
            if prev_seg != NIL
                && let Some(prev_inter) = eng.get_intersection(prev_seg, segment)
            {
                let (ix, iy) = (
                    eng.pts[prev_inter as usize].x,
                    eng.pts[prev_inter as usize].y,
                );
                if !eng.is_an_endpoint(segment, ix, iy) {
                    prev_my_splitter = prev_inter;
                }
                if !eng.is_an_endpoint(prev_seg, ix, iy) {
                    self.split_safely(eng, prev_seg, prev_inter, new_events)?;
                }
            }

            // Check for intersections against the next segment in the sweep line
            let mut next_my_splitter = NIL;
            if next_seg != NIL
                && let Some(next_inter) = eng.get_intersection(next_seg, segment)
            {
                let (ix, iy) = (
                    eng.pts[next_inter as usize].x,
                    eng.pts[next_inter as usize].y,
                );
                if !eng.is_an_endpoint(segment, ix, iy) {
                    next_my_splitter = next_inter;
                }
                if !eng.is_an_endpoint(next_seg, ix, iy) {
                    self.split_safely(eng, next_seg, next_inter, new_events)?;
                }
            }

            // only split on the 'earliest' of the intersections
            if prev_my_splitter != NIL || next_my_splitter != NIL {
                let my_splitter = if prev_my_splitter == NIL {
                    next_my_splitter
                } else if next_my_splitter == NIL {
                    prev_my_splitter
                } else {
                    let cmp_splitters = eng.compare_points(prev_my_splitter, next_my_splitter);
                    if cmp_splitters <= 0 {
                        prev_my_splitter
                    } else {
                        next_my_splitter
                    }
                };

                // remove afected segments and right sweep events before splitting
                let right_se = eng.seg(segment).right;
                self.queue
                    .remove(right_se, &mut |a, b| eng.ev_compare(a, b));
                new_events.push(right_se);
                let evs = eng.split(segment, my_splitter)?;
                new_events.extend_from_slice(&evs);
            }

            if !new_events.is_empty() {
                // re-do the current event to keep sweep line ordering consistent
                self.tree.remove(segment, &mut |a, b| eng.seg_compare(a, b));
                new_events.push(event);
            } else {
                // done with left event
                self.segments.push(segment);
                eng.segs[segment as usize].prev = prev_seg;
            }
        } else {
            // check for intersections between our previous and next segments
            if prev_seg != NIL
                && next_seg != NIL
                && let Some(inter) = eng.get_intersection(prev_seg, next_seg)
            {
                let (ix, iy) = (eng.pts[inter as usize].x, eng.pts[inter as usize].y);
                if !eng.is_an_endpoint(prev_seg, ix, iy) {
                    self.split_safely(eng, prev_seg, inter, new_events)?;
                }
                // (re-read the point: it is the same object, its coordinates never change)
                if !eng.is_an_endpoint(next_seg, ix, iy) {
                    self.split_safely(eng, next_seg, inter, new_events)?;
                }
            }
            self.tree.remove(segment, &mut |a, b| eng.seg_compare(a, b));
        }
        Ok(())
    }

    /// `SweepLine._splitSafely(seg, pt)`.
    fn split_safely(
        &mut self,
        eng: &mut Engine,
        seg: u32,
        pt: u32,
        new_events: &mut Vec<u32>,
    ) -> Result<(), ClipError> {
        self.tree.remove(seg, &mut |a, b| eng.seg_compare(a, b));
        let right_se = eng.seg(seg).right;
        self.queue
            .remove(right_se, &mut |a, b| eng.ev_compare(a, b));
        let evs = eng.split(seg, pt)?;
        new_events.extend_from_slice(&evs);
        new_events.push(right_se);
        // splitting can trigger consumption
        if eng.seg(seg).consumed_by == NIL {
            self.tree.add(seg, &mut |a, b| eng.seg_compare(a, b));
        }
        Ok(())
    }
}
