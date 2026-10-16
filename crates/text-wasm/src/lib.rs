//! `morfa-text-wasm`: lane L3's JavaScript boundary for text layout, carets and segmentation (`text_*`),
//! one wasm-bindgen function per TypeScript entry point in `shared/design/text-layout.ts` and
//! `text-segment.ts`. A module of its own, apart from `morfa-wasm`, so the editor's first load carries
//! none of it; the host loads it when a document with text opens (`scripts/wasm-text-build.sh` →
//! `src/design/wasm-text/`, `server/design/wasm-text/`). Fonts, shaping and outlines are a second module
//! (`morfa-text-fonts-wasm`), reached from here through the JavaScript measurer.
//!
//! Everything crosses as typed arrays: a text's props as the `f64` stream of `morfa_text::request`, its
//! characters as UTF-16 code units (offsets stay the TypeScript ones), a layout as the stream of
//! `morfa_text::encode`. A text object crosses once (`text_put`) and is laid out by id afterwards, many at a
//! time (`text_layout_many`), so a batch pays the boundary once. A measurer in JavaScript (the canvas, a
//! test fake, the fonts module) is called back through two functions; its width cache lives here, keyed by
//! the id TypeScript gives the measurer, so a layout asks it exactly as often as the TypeScript layout.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

use js_sys::{Array, Function, JsString, Reflect};
use morfa_text::caret::{self, Affinity, CaretDirection};
use morfa_text::encode::encode_layout;
use morfa_text::layout::compute_layout;
use morfa_text::measure::{MeasureCache, Measurer, Metrics};
use morfa_text::request::Reader;
use morfa_text::segment::{self, CaseMode};
use morfa_text::types::{FontSpec, LayoutRequest, TextLayout, TextProps};
use wasm_bindgen::prelude::*;

/// Layouts kept for caret calls; TypeScript falls back to its own code when one was dropped.
const KEPT_LAYOUTS: usize = 256;

#[derive(Default)]
struct State {
    caches: HashMap<u32, MeasureCache>,
    texts: HashMap<u32, (Vec<u16>, TextProps)>,
    layouts: HashMap<u32, TextLayout>,
    order: VecDeque<u32>,
    next_layout: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

impl State {
    fn keep(&mut self, layout: TextLayout) -> u32 {
        self.next_layout = self.next_layout.wrapping_add(1);
        let id = self.next_layout;
        if self.order.len() >= KEPT_LAYOUTS
            && let Some(old) = self.order.pop_front()
        {
            self.layouts.remove(&old);
        }
        self.order.push_back(id);
        self.layouts.insert(id, layout);
        id
    }

    fn layout_into(
        &mut self,
        measurer: u32,
        js: &mut JsMeasurer,
        chars: &[u16],
        request: &LayoutRequest,
        out: &mut Vec<f64>,
    ) {
        let mut cache = self.caches.remove(&measurer).unwrap_or_default();
        let layout = compute_layout(chars, request, &mut cache, js);
        self.caches.insert(measurer, cache);
        let mut encoded = encode_layout(0, &layout, &layout.slot_styles);
        encoded[0] = self.keep(layout) as f64;
        out.extend(encoded);
    }
}

/// A `TextMeasurer` living in JavaScript: `width(text, family, weight, italic, size)` and
/// `metrics(family, weight, italic, size)`.
struct JsMeasurer<'a> {
    width: &'a Function,
    metrics: &'a Function,
}

fn spec_args(font: &FontSpec) -> [JsValue; 4] {
    [
        JsValue::from_str(&font.family),
        JsValue::from_f64(font.weight),
        JsValue::from_bool(font.italic),
        JsValue::from_f64(font.size),
    ]
}

impl Measurer for JsMeasurer<'_> {
    fn width(&mut self, text: &[u16], font: &FontSpec) -> f64 {
        let [family, weight, italic, size] = spec_args(font);
        let args = Array::of5(
            &JsString::from_char_code(text).into(),
            &family,
            &weight,
            &italic,
            &size,
        );
        self.width
            .apply(&JsValue::UNDEFINED, &args)
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(f64::NAN)
    }

    fn metrics(&mut self, font: &FontSpec) -> Metrics {
        let [family, weight, italic, size] = spec_args(font);
        let result = self
            .metrics
            .call4(&JsValue::UNDEFINED, &family, &weight, &italic, &size)
            .unwrap_or(JsValue::UNDEFINED);
        let read = |key: &str| {
            Reflect::get(&result, &JsValue::from_str(key))
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(f64::NAN)
        };
        Metrics {
            ascent: read("ascent"),
            descent: read("descent"),
        }
    }
}

/// The module's version, as the build script's smoke test reads it.
#[wasm_bindgen]
pub fn text_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn request(props: TextProps, params: &[f64]) -> LayoutRequest {
    let width = params.first().copied().filter(|w| w.is_finite());
    LayoutRequest {
        text: props,
        width,
        height: params.get(1).copied().unwrap_or(0.0),
        on_path: params.get(2).copied().unwrap_or(0.0) == 1.0,
    }
}

/// One `layoutText`: `params` = `[width|NaN, height, onPath]`, `props` the stream of `morfa_text::request`.
/// Returns the layout as the stream of `morfa_text::encode` (its first number is the id caret calls use).
#[wasm_bindgen]
pub fn text_layout(
    chars: &[u16],
    params: &[f64],
    props: &[f64],
    measurer: u32,
    width: &Function,
    metrics: &Function,
) -> Vec<f64> {
    let request = request(Reader::new(props).props(), params);
    STATE.with(|state| {
        let mut out = Vec::new();
        let mut js = JsMeasurer { width, metrics };
        state
            .borrow_mut()
            .layout_into(measurer, &mut js, chars, &request, &mut out);
        out
    })
}

/// Keeps a text object (its characters and props) under `id` for `text_layout_many`.
#[wasm_bindgen]
pub fn text_put(id: u32, chars: &[u16], props: &[f64]) {
    let props = Reader::new(props).props();
    STATE.with(|state| {
        state.borrow_mut().texts.insert(id, (chars.to_vec(), props));
    });
}

/// Drops a kept text object (TypeScript's `FinalizationRegistry` calls it when the object is collected).
#[wasm_bindgen]
pub fn text_drop(id: u32) {
    STATE.with(|state| {
        state.borrow_mut().texts.remove(&id);
    });
}

#[wasm_bindgen]
pub fn text_kept_texts() -> u32 {
    STATE.with(|state| state.borrow().texts.len() as u32)
}

/// Lays out kept texts in one call: `params` holds `[width|NaN, height, onPath]` per id. The result is
/// every layout stream in order, each preceded by its length; an unknown id contributes `[0]`.
#[wasm_bindgen]
pub fn text_layout_many(
    ids: &[u32],
    params: &[f64],
    measurer: u32,
    width: &Function,
    metrics: &Function,
) -> Vec<f64> {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let mut js = JsMeasurer { width, metrics };
        let mut out: Vec<f64> = Vec::with_capacity(ids.len() * 64);
        let mut one: Vec<f64> = Vec::new();
        for (i, &id) in ids.iter().enumerate() {
            let Some((chars, props)) = state.texts.remove(&id) else {
                out.push(0.0);
                continue;
            };
            let request = request(props, &params[i * 3..i * 3 + 3]);
            one.clear();
            state.layout_into(measurer, &mut js, &chars, &request, &mut one);
            out.push(one.len() as f64);
            out.extend_from_slice(&one);
            state.texts.insert(id, (chars, request.text));
        }
        out
    })
}

/// `forgetMeasurements`, and the revision change of a measurer: its width cache starts over.
#[wasm_bindgen]
pub fn text_forget(measurer: u32) {
    STATE.with(|state| {
        state.borrow_mut().caches.remove(&measurer);
    });
}

/// How many layouts are kept (tests assert the boundary is used).
#[wasm_bindgen]
pub fn text_kept_layouts() -> u32 {
    STATE.with(|state| state.borrow().layouts.len() as u32)
}

// ── Carets ─────────────────────────────────────────────────────────────────────────────────────

fn affinity(upstream: bool) -> Affinity {
    if upstream {
        Affinity::Upstream
    } else {
        Affinity::Downstream
    }
}

fn with_layout(id: u32, f: impl FnOnce(&TextLayout) -> Vec<f64>) -> Option<Vec<f64>> {
    STATE.with(|state| {
        let state = state.borrow();
        let layout = state.layouts.get(&id)?;
        Some(f(layout))
    })
}

const fn flag(upstream: Affinity) -> f64 {
    if matches!(upstream, Affinity::Upstream) {
        1.0
    } else {
        0.0
    }
}

#[wasm_bindgen]
pub fn text_line_index_at(layout: u32, offset: f64, upstream: bool) -> Option<f64> {
    STATE.with(|state| {
        let state = state.borrow();
        let layout = state.layouts.get(&layout)?;
        Some(caret::line_index_at(layout, offset, affinity(upstream)) as f64)
    })
}

/// `[x, top, height, baseline, lineIndex]`.
#[wasm_bindgen]
pub fn text_caret_at(layout: u32, offset: f64, upstream: bool) -> Option<Vec<f64>> {
    with_layout(layout, |l| {
        let c = caret::caret_at(l, offset, affinity(upstream));
        vec![c.x, c.top, c.height, c.baseline, c.line_index as f64]
    })
}

/// `[offset, upstream, lineIndex]`.
#[wasm_bindgen]
pub fn text_offset_at(layout: u32, x: f64, y: f64) -> Option<Vec<f64>> {
    with_layout(layout, |l| {
        let h = caret::offset_at(l, x, y);
        vec![h.offset as f64, flag(h.affinity), h.line_index as f64]
    })
}

/// `[x, y, width, height, lineIndex]` per rectangle.
#[wasm_bindgen]
pub fn text_selection_rects(layout: u32, start: f64, end: f64) -> Option<Vec<f64>> {
    with_layout(layout, |l| {
        caret::selection_rects(l, start, end)
            .into_iter()
            .flat_map(|r| [r.x, r.y, r.width, r.height, r.line_index as f64])
            .collect()
    })
}

/// `[start, end, lineIndex]`.
#[wasm_bindgen]
pub fn text_line_range(layout: u32, offset: f64, upstream: bool) -> Option<Vec<f64>> {
    with_layout(layout, |l| {
        let r = caret::line_range(l, offset, affinity(upstream));
        vec![r.start as f64, r.end as f64, r.line_index as f64]
    })
}

/// `direction`: 0 left, 1 right, 2 up, 3 down, 4 lineStart, 5 lineEnd, 6 wordLeft, 7 wordRight, 8 docStart,
/// 9 docEnd. Returns `[offset, hasGoalX, goalX, upstream]`.
#[wasm_bindgen]
pub fn text_move_caret(
    layout: u32,
    text: &[u16],
    offset: f64,
    direction: u32,
    goal_x: Option<f64>,
    upstream: bool,
) -> Option<Vec<f64>> {
    let direction = match direction {
        0 => CaretDirection::Left,
        1 => CaretDirection::Right,
        2 => CaretDirection::Up,
        3 => CaretDirection::Down,
        4 => CaretDirection::LineStart,
        5 => CaretDirection::LineEnd,
        6 => CaretDirection::WordLeft,
        7 => CaretDirection::WordRight,
        8 => CaretDirection::DocStart,
        _ => CaretDirection::DocEnd,
    };
    with_layout(layout, |l| {
        let m = caret::move_caret(l, text, offset, direction, goal_x, affinity(upstream));
        vec![
            m.offset as f64,
            if m.goal_x.is_some() { 1.0 } else { 0.0 },
            m.goal_x.unwrap_or(0.0),
            flag(m.affinity),
        ]
    })
}

// ── Segmentation ───────────────────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn text_grapheme_boundaries(text: &[u16], from: u32, to: u32) -> Vec<u32> {
    segment::grapheme_boundaries(text, from as usize, to as usize)
        .into_iter()
        .map(|b| b as u32)
        .collect()
}

#[wasm_bindgen]
pub fn text_next_grapheme_boundary(text: &[u16], offset: f64) -> u32 {
    if offset < 0.0 {
        return 0;
    }
    segment::next_grapheme_boundary(text, offset as usize) as u32
}

#[wasm_bindgen]
pub fn text_prev_grapheme_boundary(text: &[u16], offset: f64) -> u32 {
    if offset <= 0.0 {
        return 0;
    }
    segment::prev_grapheme_boundary(text, offset as usize) as u32
}

#[wasm_bindgen]
pub fn text_snap_to_grapheme(text: &[u16], offset: f64, forward: bool) -> u32 {
    segment::snap_to_grapheme(text, offset, forward) as u32
}

#[wasm_bindgen]
pub fn text_word_at(text: &[u16], offset: f64) -> Vec<u32> {
    let (start, end) = segment::word_at(text, offset.max(0.0) as usize);
    vec![start as u32, end as u32]
}

#[wasm_bindgen]
pub fn text_word_start_before(text: &[u16], offset: f64) -> u32 {
    segment::word_start_before(text, offset.max(0.0) as usize) as u32
}

#[wasm_bindgen]
pub fn text_word_end_after(text: &[u16], offset: f64) -> u32 {
    segment::word_end_after(text, offset.max(0.0) as usize) as u32
}

#[wasm_bindgen]
pub fn text_starts_word(text: &[u16], index: f64) -> bool {
    index <= 0.0 || segment::starts_word(text, index as usize)
}

#[wasm_bindgen]
pub fn text_paragraph_at(text: &[u16], offset: f64) -> Vec<u32> {
    let (start, end, index) = segment::paragraph_at(text, offset.max(0.0) as usize);
    vec![start as u32, end as u32, index as u32]
}

/// Flat pairs: start, end, start, end…
#[wasm_bindgen]
pub fn text_paragraph_ranges(text: &[u16]) -> Vec<u32> {
    segment::paragraph_ranges(text)
        .into_iter()
        .flat_map(|(s, e)| [s as u32, e as u32])
        .collect()
}

#[wasm_bindgen]
pub fn text_can_break_between(prev: f64, cp: f64, next: f64) -> bool {
    segment::can_break_between(prev as i64, cp as i64, next as i64)
}

#[wasm_bindgen]
pub fn text_can_break_after_spaces(next: f64) -> bool {
    segment::can_break_after_spaces(next as i64)
}

#[wasm_bindgen]
pub fn text_is_letter_or_digit(cp: f64) -> bool {
    segment::is_letter_or_digit(cp as i64)
}

/// `mode`: 0 UPPER, 1 LOWER, 2 TITLE.
#[wasm_bindgen]
pub fn text_case_grapheme(grapheme: &[u16], mode: u32, word_start: bool) -> Vec<u16> {
    let mode = match mode {
        0 => CaseMode::Upper,
        1 => CaseMode::Lower,
        _ => CaseMode::Title,
    };
    segment::case_grapheme(grapheme, mode, word_start)
}

#[wasm_bindgen]
pub fn text_has_lowercase(grapheme: &[u16]) -> bool {
    segment::has_lowercase(grapheme)
}
