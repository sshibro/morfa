//! The result-building part of polygon-clipping 0.15.7: `Segment.isInResult` and its state
//! getters, `RingOut`, `PolyOut` and `MultiPolyOut`.

use super::engine::{Engine, NIL, State, type_error};
use super::robust::orient2d;
use super::small::SmallVec;
use super::{ClipError, MultiPolygon, Operation, Polygon, Ring};

/// The JS stack, in abstract units, for the recursive getters (`afterState`/`beforeState`,
/// `prevInResult`, `isExteriorRing`, `enclosingRing`). Past it the JS throws `RangeError:
/// Maximum call stack size exceeded`, which its caller catches; we return the same error at
/// about the same depth (our walks are iterative, so without this a chain the JS cannot
/// handle would just keep going and allocating).
///
/// Calibrated in Node 22 (V8, default ~984 KiB stack): the snapped big-difference input of
/// lane L1 overflows on entering frame 11 387 of `beforeState`/`afterState` under
/// `RingOut.factory -> getAvailableLinkedEvents -> isInResult` (5693 frames of each on the
/// stack). With optimized code, artificial chains overflow at 5966 afterState+beforeState
/// pairs, 9639 `prevInResult` frames and 17 902 `isExteriorRing` frames; the last two are
/// scaled by 5693 / 5966 to the real run. (Interpreted code overflows about twice as early, so
/// the JS limit itself moves with JIT tiering; this is an approximation.)
const JS_STACK: u64 = 1_000_000_000_000;
/// One `afterState` or `beforeState` frame.
const STATE_FRAME: u64 = JS_STACK / 11_386;
/// One `prevInResult` frame.
const PIR_FRAME: u64 = JS_STACK / 9_198;
/// One `isExteriorRing` frame.
const EXTERIOR_FRAME: u64 = JS_STACK / 17_083;
/// One `enclosingRing` + `_calcEnclosingRing` pair (not measured: taken as two state frames).
const ENCLOSING_FRAMES: u64 = 2 * STATE_FRAME;

fn stack_overflow() -> ClipError {
    ClipError::new("RangeError: Maximum call stack size exceeded".to_string())
}

/// Reported where the JS would loop forever (it never returns there).
fn endless_loop() -> ClipError {
    ClipError::new(
        "Output ring construction does not terminate (the JS would loop forever)".to_string(),
    )
}

/// A JS value that is `null`, `undefined` or a `RingOut` (strict equality is `==`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum RRef {
    Null,
    Undef,
    Ring(u32),
}

fn ring_ref(r: u32) -> RRef {
    if r == NIL { RRef::Undef } else { RRef::Ring(r) }
}

/// Where `_calcEnclosingRing` stopped: its result, or a call of `ppro.enclosingRing()` whose
/// result it compares with `pro` (`prevPrevSeg.ringOut`, `prevSeg.ringOut`).
enum CalcStep {
    Done(RRef),
    Call { ppro: u32, pro: u32 },
}

/// `RingOut`.
struct RingOut {
    events: Vec<u32>,
    poly: u32,
    is_exterior: Option<bool>,
    /// `_enclosingRing` (never holds `undefined`).
    enclosing: Option<RRef>,
}

/// `PolyOut`.
struct PolyOut {
    exterior: u32,
    interiors: Vec<u32>,
}

pub(super) struct Output<'a> {
    eng: &'a mut Engine,
    rings: Vec<RingOut>,
    polys: Vec<PolyOut>,
    /// JS stack in use by the recursive getters currently "on the stack" (see `JS_STACK`).
    stack_used: u64,
    /// `_afterState` per segment.
    after: Vec<Option<State>>,
    // scratch buffers, reused across calls
    state_stack: Vec<(u32, u32)>,
    polys_after: Vec<u32>,
    polys_exclude: Vec<u32>,
    pir_chain: Vec<u32>,
}

/// `compareVectorAngles`.
fn compare_vector_angles(bx: f64, by: f64, e1x: f64, e1y: f64, e2x: f64, e2y: f64) -> i32 {
    let res = orient2d(bx, by, e1x, e1y, e2x, e2y);
    if res > 0.0 {
        return -1;
    }
    if res < 0.0 {
        return 1;
    }
    0
}

/// The comparator built by `SweepEvent.getLeftmostComparator`, on cached (sine, cosine).
fn leftmost_cmp(a: (f64, f64), b: (f64, f64)) -> i32 {
    let (asine, acosine) = a;
    let (bsine, bcosine) = b;
    // both on or above x-axis
    if asine >= 0.0 && bsine >= 0.0 {
        if acosine < bcosine {
            return 1;
        }
        if acosine > bcosine {
            return -1;
        }
        return 0;
    }
    // both below x-axis
    if asine < 0.0 && bsine < 0.0 {
        if acosine < bcosine {
            return -1;
        }
        if acosine > bcosine {
            return 1;
        }
        return 0;
    }
    // one above x-axis, one below
    if bsine < asine {
        return -1;
    }
    if bsine > asine {
        return 1;
    }
    0
}

/// V8's `Array.prototype.sort` (TimSort) for arrays shorter than 64 elements: one
/// `CountAndMakeRun` followed by `BinaryInsertionSort`. Exact even for inconsistent
/// comparators. Longer arrays fall back to a stable sort (identical for consistent ones).
fn v8_sort<T: Copy>(a: &mut [T], mut cmp: impl FnMut(T, T) -> i32) {
    let n = a.len();
    if n < 2 {
        return;
    }
    if n >= 64 {
        a.sort_by(|x, y| cmp(*x, *y).cmp(&0));
        return;
    }
    // CountAndMakeRun(0, n)
    let mut run = 2;
    let descending = cmp(a[1], a[0]) < 0;
    let mut previous = a[1];
    for &current in a.iter().skip(2) {
        let order = cmp(current, previous);
        if descending {
            if order >= 0 {
                break;
            }
        } else if order < 0 {
            break;
        }
        previous = current;
        run += 1;
    }
    if descending {
        a[..run].reverse();
    }
    // BinaryInsertionSort(0, run, n)
    for start in run..n {
        let pivot = a[start];
        let mut left = 0;
        let mut right = start;
        while left < right {
            let mid = left + ((right - left) >> 1);
            if cmp(pivot, a[mid]) < 0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        a.copy_within(left..start, left + 1);
        a[left] = pivot;
    }
}

impl<'a> Output<'a> {
    pub(super) fn new(eng: &'a mut Engine) -> Self {
        Output {
            rings: Vec::new(),
            polys: Vec::new(),
            stack_used: 0,
            after: (0..eng.segs.len()).map(|_| None).collect(),
            state_stack: Vec::new(),
            polys_after: Vec::new(),
            polys_exclude: Vec::new(),
            pir_chain: Vec::new(),
            eng,
        }
    }

    // ---- Segment result state ----

    /// Ensures `afterState()` of `s` is computed, for `isInResult` of `s`: iteratively,
    /// mirroring the recursion beforeState(s) -> prev.afterState -> prev.beforeState -> ...
    ///
    /// Rings whose winding sums to 0 are dropped from the stored states (the JS keeps them):
    /// they never change `multiPolysAfter`, which only matters as a set, and keeping them
    /// makes the states grow with every ring crossed below (gigabytes on big inputs).
    fn ensure_after(&mut self, s: u32) -> Result<(), ClipError> {
        let mut stack = std::mem::take(&mut self.state_stack);
        stack.clear();
        let r = self.ensure_after_with(s, &mut stack);
        self.state_stack = stack;
        r
    }

    fn ensure_after_with(&mut self, s: u32, stack: &mut Vec<(u32, u32)>) -> Result<(), ClipError> {
        let segs = &mut self.eng.segs;
        let after = &mut self.after;
        // `stack`: (segment, the segment its before state comes from or NIL for the empty state)
        let mut cur = s;
        // the JS frames this recursion enters: beforeState(s), then afterState + beforeState
        // of every segment below whose state is not cached yet
        let mut frames: u64 = 0;
        loop {
            let c = &segs[cur as usize];
            if after[cur as usize].is_some() {
                if cur != s {
                    frames += 1; // a cached afterState() call
                }
                break;
            }
            frames += if cur == s { 1 } else { 2 };
            if self.stack_used + frames * STATE_FRAME > JS_STACK {
                for &(seg, _) in stack.iter() {
                    segs[seg as usize].visiting = false;
                }
                return Err(stack_overflow());
            }
            if c.visiting {
                return Err(stack_overflow());
            }
            if let Some(src) = c.before_src {
                stack.push((cur, src));
                segs[cur as usize].visiting = true;
                break;
            }
            let p = c.prev;
            if p == NIL {
                stack.push((cur, NIL));
                segs[cur as usize].visiting = true;
                break;
            }
            let pc = segs[p as usize].consumed_by;
            let src = if pc != NIL { pc } else { p };
            stack.push((cur, src));
            segs[cur as usize].visiting = true;
            cur = src;
        }
        if self.stack_used + frames * STATE_FRAME > JS_STACK {
            for &(seg, _) in stack.iter() {
                segs[seg as usize].visiting = false;
            }
            return Err(stack_overflow());
        }
        let polys_after = &mut self.polys_after;
        let polys_exclude = &mut self.polys_exclude;
        while let Some((seg, src)) = stack.pop() {
            segs[seg as usize].visiting = false;
            if segs[seg as usize].before_src.is_none() {
                segs[seg as usize].before_src = Some(src);
            }
            // ringsAfter / windingsAfter, as (ring, winding) pairs
            let mut rings_after = if src == NIL {
                SmallVec::new()
            } else {
                after[src as usize]
                    .as_ref()
                    .ok_or_else(stack_overflow)?
                    .rings
                    .clone()
            };
            let rings = segs[seg as usize]
                .rings
                .as_ref()
                .ok_or_else(|| type_error("Cannot read properties of null (reading 'length')"))?;
            // calculate ringsAfter, windingsAfter
            for &(ring, winding) in rings.as_slice() {
                match rings_after.as_slice().iter().position(|&(r, _)| r == ring) {
                    None => rings_after.push((ring, winding)),
                    Some(index) => rings_after.as_mut_slice()[index].1 += winding,
                }
            }
            // (drop the rings with a zero winding, see above)
            if rings_after.as_slice().iter().any(|&(_, w)| w == 0) {
                rings_after.retain(|&(_, w)| w != 0);
            }
            // calculate polysAfter
            polys_after.clear();
            polys_exclude.clear();
            for &(ring, winding) in rings_after.as_slice() {
                if winding == 0 {
                    continue; // non-zero rule
                }
                let rin = &self.eng.rings_in[ring as usize];
                let poly = rin.poly;
                if polys_exclude.contains(&poly) {
                    continue;
                }
                if rin.is_exterior {
                    polys_after.push(poly);
                } else {
                    if !polys_exclude.contains(&poly) {
                        polys_exclude.push(poly);
                    }
                    if let Some(index) = polys_after.iter().position(|&p| p == poly) {
                        polys_after.remove(index);
                    }
                }
            }
            // calculate multiPolysAfter
            let mut mps = SmallVec::new();
            for &p in polys_after.iter() {
                let mp = self.eng.poly_mp[p as usize];
                if !mps.as_slice().contains(&mp) {
                    mps.push(mp);
                }
            }
            after[seg as usize] = Some(State {
                rings: rings_after,
                mps,
            });
        }
        Ok(())
    }

    /// `Segment.isInResult`.
    fn is_in_result(&mut self, s: u32) -> Result<bool, ClipError> {
        let seg = self.eng.seg(s);
        if seg.consumed_by != NIL {
            return Ok(false);
        }
        if let Some(v) = seg.in_result {
            return Ok(v);
        }
        self.ensure_after(s)?;
        let segs = &self.eng.segs;
        let src = segs[s as usize].before_src.unwrap_or(NIL);
        let mps_before: &[u32] = if src == NIL {
            &[]
        } else {
            self.after[src as usize]
                .as_ref()
                .ok_or_else(stack_overflow)?
                .mps
                .as_slice()
        };
        let mps_after = self.after[s as usize]
            .as_ref()
            .ok_or_else(stack_overflow)?
            .mps
            .as_slice();
        let v = match self.eng.op {
            Operation::Union => {
                // included iff on one side of us there are 0 poly interiors and on the other 1+
                (mps_before.is_empty()) != (mps_after.is_empty())
            }
            Operation::Intersection => {
                let (least, most) = if mps_before.len() < mps_after.len() {
                    (mps_before.len(), mps_after.len())
                } else {
                    (mps_after.len(), mps_before.len())
                };
                most == self.eng.num_multi_polys && least < most
            }
            Operation::Xor => {
                let diff = mps_before.len().abs_diff(mps_after.len());
                diff % 2 == 1
            }
            Operation::Difference => {
                let subj = &self.eng.mp_is_subject;
                let is_just_subject = |mps: &[u32]| mps.len() == 1 && subj[mps[0] as usize];
                is_just_subject(mps_before) != is_just_subject(mps_after)
            }
        };
        self.eng.segs[s as usize].in_result = Some(v);
        Ok(v)
    }

    /// `Segment.prevInResult` (NIL = null), iteratively.
    fn prev_in_result(&mut self, s: u32) -> Result<u32, ClipError> {
        // (fast path: cached)
        if let Some(c) = self.eng.seg(s).prev_in_result {
            return Ok(c);
        }
        let mut chain = std::mem::take(&mut self.pir_chain);
        chain.clear();
        let mut cur = s;
        let base = self.stack_used;
        let result = loop {
            if let Some(c) = self.eng.seg(cur).prev_in_result {
                break c;
            }
            if self.eng.seg(cur).visiting_pir {
                return Err(stack_overflow());
            }
            chain.push(cur);
            self.eng.segs[cur as usize].visiting_pir = true;
            // (one more prevInResult frame on the JS stack)
            let used = base + chain.len() as u64 * PIR_FRAME;
            if used > JS_STACK {
                return Err(stack_overflow());
            }
            let p = self.eng.seg(cur).prev;
            if p == NIL {
                break NIL;
            }
            self.stack_used = used;
            let in_result = self.is_in_result(p);
            self.stack_used = base;
            match in_result {
                Ok(true) => break p,
                Ok(false) => cur = p,
                Err(e) => return Err(e),
            }
        };
        for &c in &chain {
            let seg = &mut self.eng.segs[c as usize];
            seg.visiting_pir = false;
            seg.prev_in_result = Some(result);
        }
        self.pir_chain = chain;
        Ok(result)
    }

    // ---- RingOut ----

    /// `new RingOut(events)`.
    fn new_ring(&mut self, events: Vec<u32>) -> u32 {
        let id = self.rings.len() as u32;
        for &e in &events {
            let s = self.eng.ev(e).segment;
            self.eng.segs[s as usize].ring_out = id;
        }
        self.rings.push(RingOut {
            events,
            poly: NIL,
            is_exterior: None,
            enclosing: None,
        });
        id
    }

    /// `SweepEvent.getAvailableLinkedEvents`.
    fn available_linked_events(&mut self, this: u32, out: &mut Vec<u32>) -> Result<(), ClipError> {
        out.clear();
        let p = self.eng.ev(this).point as usize;
        let n = self.eng.pts[p].events.len();
        for i in 0..n {
            let evt = self.eng.pts[p].events.as_slice()[i];
            if evt == this {
                continue;
            }
            let s = self.eng.ev(evt).segment;
            if self.eng.seg(s).ring_out != NIL {
                continue;
            }
            if self.is_in_result(s)? {
                out.push(evt);
            }
        }
        Ok(())
    }

    /// `RingOut.factory(allSegments)`.
    pub(super) fn factory(&mut self, all_segments: &[u32]) -> Result<Vec<u32>, ClipError> {
        let mut rings_out = Vec::new();
        let mut available: Vec<u32> = Vec::new();
        for &segment in all_segments {
            if !self.is_in_result(segment)? || self.eng.seg(segment).ring_out != NIL {
                continue;
            }
            let mut event = self.eng.seg(segment).left;
            let mut next_event = self.eng.seg(segment).right;
            let mut events = vec![event];
            let starting_point = self.eng.ev(event).point;
            // (index, point)
            let mut intersection_les: Vec<(usize, u32)> = Vec::new();

            // Walk the chain of linked events to form a closed ring
            loop {
                let prev_event = event;
                event = next_event;
                events.push(event);
                // (guard: a walk that never closes loops forever in the JS)
                if events.len() > 2 * self.eng.evs.len() + 4 {
                    return Err(endless_loop());
                }

                // Is the ring complete?
                if self.eng.ev(event).point == starting_point {
                    break;
                }
                loop {
                    self.available_linked_events(event, &mut available)?;

                    // Did we hit a dead end? This shouldn't happen.
                    if available.is_empty() {
                        let first = self.eng.ev_pt(events[0]);
                        let last = self.eng.ev_pt(events[events.len() - 1]);
                        return Err(ClipError::new(format!(
                            "Unable to complete output ring starting at [{}, {}]. Last matching segment found ends at [{}, {}].",
                            first.x, first.y, last.x, last.y
                        )));
                    }

                    // Only one way to go, so continue on the path
                    if available.len() == 1 {
                        next_event = self.eng.ev(available[0]).other;
                        break;
                    }

                    // We must have an intersection. Check for a completed loop
                    let ep = self.eng.ev(event).point;
                    if let Some(index_le) = intersection_les.iter().position(|&(_, p)| p == ep) {
                        // Found a completed loop. Cut that off and make a ring
                        let intersection_le = intersection_les[index_le];
                        intersection_les.truncate(index_le);
                        let mut ring_events = events.split_off(intersection_le.0);
                        let first_other = self.eng.ev(ring_events[0]).other;
                        ring_events.insert(0, first_other);
                        ring_events.reverse();
                        let r = self.new_ring(ring_events);
                        rings_out.push(r);
                        continue;
                    }
                    // register the intersection
                    intersection_les.push((events.len(), ep));
                    // Choose the left-most option to continue the walk
                    let (sx, sy) = (self.eng.ev_pt(event).x, self.eng.ev_pt(event).y);
                    let (bx, by) = (self.eng.ev_pt(prev_event).x, self.eng.ev_pt(prev_event).y);
                    let mut keyed: Vec<(u32, (f64, f64))> = Vec::with_capacity(available.len());
                    for &le in &available {
                        let np = self.eng.ev_pt(self.eng.ev(le).other);
                        // sineOfAngle / cosineOfAngle(this.point, baseEvent.point, nextEvent.point)
                        let vbx = bx - sx;
                        let vby = by - sy;
                        let vax = np.x - sx;
                        let vay = np.y - sy;
                        let la = (vax * vax + vay * vay).sqrt();
                        let lb = (vbx * vbx + vby * vby).sqrt();
                        let sine = (vax * vby - vay * vbx) / la / lb;
                        let la = (vax * vax + vay * vay).sqrt();
                        let lb = (vbx * vbx + vby * vby).sqrt();
                        let cosine = (vax * vbx + vay * vby) / la / lb;
                        keyed.push((le, (sine, cosine)));
                    }
                    v8_sort(&mut keyed, |a, b| leftmost_cmp(a.1, b.1));
                    next_event = self.eng.ev(keyed[0].0).other;
                    break;
                }
            }
            let r = self.new_ring(events);
            rings_out.push(r);
        }
        Ok(rings_out)
    }

    /// `RingOut.getGeom`.
    fn ring_geom(&mut self, r: u32) -> Result<Option<Ring>, ClipError> {
        let pts = &self.eng.pts;
        let evs = &self.eng.evs;
        let ring = &self.rings[r as usize];
        let at = |i: usize| {
            let p = &pts[evs[ring.events[i] as usize].point as usize];
            (p.x, p.y)
        };
        // Remove superfluous points (ie extra points along a straight line)
        let mut prev_pt = at(0);
        let mut points: Vec<(f64, f64)> = vec![prev_pt];
        let n = ring.events.len();
        for i in 1..n.saturating_sub(1) {
            let pt = at(i);
            let next_pt = at(i + 1);
            if compare_vector_angles(pt.0, pt.1, prev_pt.0, prev_pt.1, next_pt.0, next_pt.1) == 0 {
                continue;
            }
            points.push(pt);
            prev_pt = pt;
        }

        // ring was all (within rounding error of angle calc) colinear points
        if points.len() == 1 {
            return Ok(None);
        }

        // check if the starting point is necessary
        let pt = points[0];
        let next_pt = points[1];
        if compare_vector_angles(pt.0, pt.1, prev_pt.0, prev_pt.1, next_pt.0, next_pt.1) == 0 {
            points.remove(0);
        }
        points.push(points[0]);
        let ext = self.is_exterior_ring(r)?;
        let mut ordered: Ring = Vec::with_capacity(points.len());
        if ext {
            ordered.extend(points.iter().map(|p| [p.0, p.1]));
        } else {
            ordered.extend(points.iter().rev().map(|p| [p.0, p.1]));
        }
        Ok(Some(ordered))
    }

    /// `RingOut.isExteriorRing`: iteratively over the chain of enclosing rings
    /// (isExteriorRing -> enclosingRing, then the enclosing ring's isExteriorRing).
    fn is_exterior_ring(&mut self, r0: u32) -> Result<bool, ClipError> {
        let base = self.stack_used;
        let mut chain: Vec<u32> = Vec::new();
        let mut r = r0;
        // the value of the last ring of `chain`'s enclosing ring, if it decided the chain's end
        let mut v = loop {
            if let Some(v) = self.rings[r as usize].is_exterior {
                break Some(v);
            }
            chain.push(r);
            let used = base + chain.len() as u64 * EXTERIOR_FRAME;
            if used > JS_STACK {
                self.stack_used = base;
                return Err(stack_overflow());
            }
            self.stack_used = used;
            let enclosing = self.enclosing_ring(r);
            self.stack_used = base;
            match enclosing? {
                RRef::Ring(e) => r = e,
                _ => break None,
            }
        };
        while let Some(c) = chain.pop() {
            // enclosing ? !enclosing.isExteriorRing() : true
            let value = match v {
                Some(enclosing_is_exterior) => !enclosing_is_exterior,
                None => true,
            };
            self.rings[c as usize].is_exterior = Some(value);
            v = Some(value);
        }
        Ok(v.unwrap_or(true))
    }

    /// Caches `_enclosingRing` (the JS assigns `undefined`, i.e. caches nothing, for it).
    fn cache_enclosing(&mut self, r: u32, v: RRef) {
        if v != RRef::Undef {
            self.rings[r as usize].enclosing = Some(v);
        }
    }

    /// `RingOut.enclosingRing` (with `_calcEnclosingRing`), iteratively: `_calcEnclosingRing`
    /// recurses into `enclosingRing` of the ring below (`prevPrevSeg.ringOut.enclosingRing()`,
    /// then possibly `prevSeg.ringOut.enclosingRing()` as its result); `stack` holds the rings
    /// whose calculation waits on such a call.
    fn enclosing_ring(&mut self, r0: u32) -> Result<RRef, ClipError> {
        enum Wait {
            /// waits on `prevPrevSeg.ringOut.enclosingRing()`, to compare with `prevSeg.ringOut`
            Compare { pro: u32 },
            /// returns the result of `prevSeg.ringOut.enclosingRing()`
            Result,
        }
        let base = self.stack_used;
        let mut stack: Vec<(u32, Wait)> = Vec::new();
        let mut call = r0;
        let result = 'outer: loop {
            // enclosingRing(call)
            let mut ret = if let Some(v) = self.rings[call as usize].enclosing {
                v
            } else {
                let used = base + (stack.len() as u64 + 1) * ENCLOSING_FRAMES;
                if used > JS_STACK {
                    self.stack_used = base;
                    return Err(stack_overflow());
                }
                self.stack_used = used;
                let step = self.calc_enclosing_ring(call);
                self.stack_used = base;
                match step? {
                    CalcStep::Done(v) => {
                        self.cache_enclosing(call, v);
                        v
                    }
                    CalcStep::Call { ppro, pro } => {
                        stack.push((call, Wait::Compare { pro }));
                        call = ppro;
                        continue 'outer;
                    }
                }
            };
            // return `ret` to the waiting calculations
            loop {
                let Some((r, wait)) = stack.pop() else {
                    break 'outer ret;
                };
                match wait {
                    Wait::Compare { pro } => {
                        if ret != ring_ref(pro) {
                            ret = ring_ref(pro);
                            self.cache_enclosing(r, ret);
                        } else {
                            if pro == NIL {
                                return Err(type_error(
                                    "Cannot read properties of undefined (reading 'enclosingRing')",
                                ));
                            }
                            stack.push((r, Wait::Result));
                            call = pro;
                            continue 'outer;
                        }
                    }
                    Wait::Result => self.cache_enclosing(r, ret),
                }
            }
        };
        Ok(result)
    }

    /// `RingOut._calcEnclosingRing` up to its result or its first `enclosingRing()` call.
    fn calc_enclosing_ring(&mut self, r: u32) -> Result<CalcStep, ClipError> {
        // start with the ealier sweep line event so that the prevSeg chain doesn't lead us
        // inside of a loop of ours
        let mut left_most_evt = self.rings[r as usize].events[0];
        let n = self.rings[r as usize].events.len();
        for i in 1..n {
            let evt = self.rings[r as usize].events[i];
            if self.eng.ev_compare(left_most_evt, evt) > 0 {
                left_most_evt = evt;
            }
        }
        let mut prev_seg = self.prev_in_result(self.eng.ev(left_most_evt).segment)?;
        let mut prev_prev_seg = if prev_seg != NIL {
            self.prev_in_result(prev_seg)?
        } else {
            NIL
        };
        let mut steps = 0;
        loop {
            // (guard: a cycle of cached prevInResult links loops forever in the JS)
            steps += 1;
            if steps > self.eng.segs.len() + 1 {
                return Err(endless_loop());
            }
            // no segment found, thus no ring can enclose us
            if prev_seg == NIL {
                return Ok(CalcStep::Done(RRef::Null));
            }
            // no segments below prev segment found, thus the ring of the prev segment must
            // loop back around and enclose us
            if prev_prev_seg == NIL {
                return Ok(CalcStep::Done(ring_ref(self.eng.seg(prev_seg).ring_out)));
            }
            // if the two segments are of different rings, the ring of the prev segment must
            // either loop around us or the ring of the prev prev seg
            let pro = self.eng.seg(prev_seg).ring_out;
            let ppro = self.eng.seg(prev_prev_seg).ring_out;
            if ppro != pro {
                if ppro == NIL {
                    return Err(type_error(
                        "Cannot read properties of undefined (reading 'enclosingRing')",
                    ));
                }
                // prevPrevSeg.ringOut.enclosingRing() !== prevSeg.ringOut ? ... (in the caller)
                return Ok(CalcStep::Call { ppro, pro });
            }
            // two segments are from the same ring, so this was a penisula of that ring.
            // iterate downward, keep searching
            prev_seg = self.prev_in_result(prev_prev_seg)?;
            prev_prev_seg = if prev_seg != NIL {
                self.prev_in_result(prev_seg)?
            } else {
                NIL
            };
        }
    }

    // ---- PolyOut / MultiPolyOut ----

    /// `MultiPolyOut._composePolys`.
    pub(super) fn compose_polys(&mut self, rings: &[u32]) -> Result<Vec<u32>, ClipError> {
        let mut polys = Vec::new();
        for &ring in rings {
            if self.rings[ring as usize].poly != NIL {
                continue;
            }
            if self.is_exterior_ring(ring)? {
                polys.push(self.new_poly(ring));
            } else {
                let RRef::Ring(enclosing) = self.enclosing_ring(ring)? else {
                    return Err(type_error(
                        "Cannot read properties of null (reading 'poly')",
                    ));
                };
                if self.rings[enclosing as usize].poly == NIL {
                    polys.push(self.new_poly(enclosing));
                }
                let p = self.rings[enclosing as usize].poly;
                self.polys[p as usize].interiors.push(ring);
                self.rings[ring as usize].poly = p;
            }
        }
        Ok(polys)
    }

    /// `new PolyOut(exteriorRing)`.
    fn new_poly(&mut self, exterior: u32) -> u32 {
        let id = self.polys.len() as u32;
        self.polys.push(PolyOut {
            exterior,
            interiors: Vec::new(),
        });
        self.rings[exterior as usize].poly = id;
        id
    }

    /// `MultiPolyOut.getGeom`.
    pub(super) fn multi_geom(&mut self, polys: &[u32]) -> Result<MultiPolygon, ClipError> {
        let mut geom = Vec::new();
        for &p in polys {
            // PolyOut.getGeom
            let exterior = self.polys[p as usize].exterior;
            let Some(ext) = self.ring_geom(exterior)? else {
                continue;
            };
            let mut poly: Polygon = vec![ext];
            let n = self.polys[p as usize].interiors.len();
            for i in 0..n {
                let ring = self.polys[p as usize].interiors[i];
                if let Some(g) = self.ring_geom(ring)? {
                    poly.push(g);
                }
            }
            geom.push(poly);
        }
        Ok(geom)
    }
}
