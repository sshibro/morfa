//! Text layout: the Rust twin of `computeLayout` in `shared/design/text-layout.ts`, step for step —
//! graphemes in the style of their run → widths measured a word at a time → greedy line breaking →
//! line heights and baselines (half-leading) → paragraph spacing, indents and list markers → TRUNCATE's
//! ellipsis → alignment and justification → vertical alignment. Floating point follows the TypeScript
//! operation order so the numbers are equal, not merely close.

use crate::measure::{FontId, MeasureCache, Measurer, finite};
use crate::segment::{
    CaseMode, LINE_SEPARATOR, SOFT_HYPHEN, WORD_JOINER, ZERO_WIDTH_NO_BREAK_SPACE,
    ZERO_WIDTH_SPACE, can_break_after_spaces, can_break_between, case_grapheme, code_point_at,
    grapheme_boundaries, has_lowercase, is_breaking_space, is_simple_range, js_case,
    paragraph_ranges, starts_word,
};
use crate::types::{
    AutoResize, GlyphRun, HorizontalAlign, LayoutRequest, LetterSpacing, LineHeight, ListMarker,
    ListType, PartialStyle, TextCase, TextLayout, TextLine, TextProps, TextStyle, VerticalAlign,
};

/// SMALL_CAPS draws lower-case letters as capitals at this fraction of the size.
const SMALL_CAPS_SCALE: f64 = 0.8;
/// Without font metrics AUTO line height is ≈1.2 em, split like Inter's ascender and descender.
const FALLBACK_ASCENT: f64 = 0.96;
const FALLBACK_DESCENT: f64 = 0.24;
/// Rounding slack: a line laid out again at its own measured width must not wrap.
const EPS: f64 = 0.01;

/// `!(a > b)` as JavaScript reads it: also true when either side is NaN.
#[inline]
pub fn not_greater(a: f64, b: f64) -> bool {
    a.partial_cmp(&b) != Some(std::cmp::Ordering::Greater)
}

/// `Math.max`: NaN wins, +0 beats −0.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() || b.is_sign_positive() {
            0.0
        } else {
            -0.0
        };
    }
    if a > b { a } else { b }
}

/// `Math.min`: NaN wins, −0 beats +0.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if a < b { a } else { b }
}

// ── Styles of the text ─────────────────────────────────────────────────────────────────────────

struct Slot {
    style: TextStyle,
    font: FontId,
    small: Option<FontId>,
    small_style: Option<TextStyle>,
    text_case: TextCase,
    letter_spacing: f64,
    line_height: f64,
    above: f64,
    ascent: f64,
    descent: f64,
}

fn resolve_style(base: &TextStyle, partial: &PartialStyle) -> TextStyle {
    let mut style = base.clone();
    if let Some(v) = &partial.font_family {
        style.font_family = v.clone();
    }
    if let Some(v) = partial.font_weight {
        style.font_weight = v;
    }
    if let Some(v) = partial.italic {
        style.italic = v;
    }
    if let Some(v) = partial.font_size {
        style.font_size = v;
    }
    if let Some(v) = partial.line_height {
        style.line_height = v;
    }
    if let Some(v) = partial.letter_spacing {
        style.letter_spacing = Some(v);
    }
    if let Some(v) = partial.text_case {
        style.text_case = Some(v);
    }
    style
}

fn make_slot(style: TextStyle, cache: &mut MeasureCache, measurer: &mut dyn Measurer) -> Slot {
    let size = js_max(0.0, finite(style.font_size));
    let font = cache.font_entry(measurer, &style);
    let (mut ascent, mut descent) = {
        let entry = cache.entry(font);
        (entry.ascent, entry.descent)
    };
    if not_greater(ascent + descent, 0.0) {
        ascent = size * FALLBACK_ASCENT;
        descent = size * FALLBACK_DESCENT;
    }
    let line_height = js_max(
        0.0,
        match style.line_height {
            LineHeight::Pixels { value } => finite(value),
            LineHeight::Percent { value } => (finite(value) / 100.0) * size,
            LineHeight::Auto => ascent + descent,
        },
    );
    let half_leading = (line_height - ascent - descent) / 2.0;
    let letter_spacing = match style.letter_spacing {
        Some(LetterSpacing::Pixels { value }) => finite(value),
        Some(LetterSpacing::Percent { value }) => (finite(value) / 100.0) * size,
        None => 0.0,
    };
    let text_case = style.text_case.unwrap_or_default();
    let small_style = if text_case == TextCase::SmallCaps {
        Some(TextStyle {
            font_size: size * SMALL_CAPS_SCALE,
            ..style.clone()
        })
    } else {
        None
    };
    let small = small_style.as_ref().map(|s| cache.font_entry(measurer, s));
    Slot {
        style,
        font,
        small,
        small_style,
        text_case,
        letter_spacing,
        line_height,
        above: ascent + half_leading,
        ascent,
        descent,
    }
}

// ── Units: one grapheme each ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Ink,
    Space,
    Tab,
    Hidden,
    Separator,
}

#[derive(Clone, Debug)]
struct Unit {
    start: usize,
    end: usize,
    cp: u32,
    /// What is drawn when it differs from the characters as typed; None: chars[start, end).
    text: Option<Vec<u16>>,
    slot: usize,
    small: bool,
    kind: Kind,
    width: f64,
    /// 0 none, 1 allowed, 2 forced.
    brk: u8,
    shy: bool,
    stretch: bool,
    x: f64,
}

fn is_hidden_code(cp: u32) -> bool {
    cp == SOFT_HYPHEN
        || cp == ZERO_WIDTH_SPACE
        || cp == WORD_JOINER
        || cp == ZERO_WIDTH_NO_BREAK_SPACE
        || cp == 0x200c
        || cp == 0x200d
        || cp == 0x200e
        || cp == 0x200f
}

struct Ctx<'a> {
    chars: &'a [u16],
    slots: Vec<Slot>,
    slot_of: Option<Vec<u32>>,
    cache: &'a mut MeasureCache,
    measurer: &'a mut dyn Measurer,
}

impl Ctx<'_> {
    fn measure(&mut self, font: FontId, text: &[u16]) -> f64 {
        self.cache.measure(self.measurer, font, text)
    }
    fn measure_code(&mut self, font: FontId, code: u16) -> f64 {
        self.cache.measure_code(self.measurer, font, code)
    }
    fn font_of(&self, slot: usize, small: bool) -> FontId {
        let s = &self.slots[slot];
        if small && let Some(f) = &s.small {
            return *f;
        }
        s.font
    }
    fn display_of<'u>(&self, unit: &'u Unit) -> &'u [u16]
    where
        Self: 'u,
    {
        match &unit.text {
            Some(t) => t,
            None => &self.chars[unit.start..unit.end],
        }
    }
    fn display_owned(&self, unit: &Unit) -> Vec<u16> {
        match &unit.text {
            Some(t) => t.clone(),
            None => self.chars[unit.start..unit.end].to_vec(),
        }
    }
    /// Advance of one unit alone, without letter spacing.
    fn advance_of(&mut self, font: FontId, unit: &Unit) -> f64 {
        if unit.text.is_none() && unit.end - unit.start == 1 {
            self.measure_code(font, unit.cp as u16)
        } else {
            let text = self.display_owned(unit);
            self.measure(font, &text)
        }
    }
    fn hyphen_width(&mut self, slot: usize) -> f64 {
        let font = self.slots[slot].font;
        self.measure(font, &[0x2d]) + self.slots[slot].letter_spacing
    }
}

fn make_unit(ctx: &Ctx, start: usize, end: usize) -> Unit {
    let chars = ctx.chars;
    let slot_index = ctx.slot_of.as_ref().map_or(0, |s| s[start] as usize);
    let slot = &ctx.slots[slot_index];
    let cp = code_point_at(chars, start);
    let mut text: Option<Vec<u16>> = None;
    let mut kind = Kind::Ink;
    let mut small = false;
    if is_breaking_space(cp) {
        kind = if cp == 0x09 { Kind::Tab } else { Kind::Space };
        if kind == Kind::Tab {
            text = Some(Vec::new());
        }
    } else if cp == LINE_SEPARATOR {
        kind = Kind::Separator;
        text = Some(Vec::new());
    } else if is_hidden_code(cp) {
        kind = Kind::Hidden;
        text = Some(Vec::new());
    } else if slot.text_case != TextCase::Original {
        let typed = &chars[start..end];
        if slot.text_case == TextCase::SmallCaps {
            if has_lowercase(typed) {
                small = true;
                text = Some(js_case(typed, true));
            }
        } else {
            let mode = match slot.text_case {
                TextCase::Upper => CaseMode::Upper,
                TextCase::Lower => CaseMode::Lower,
                _ => CaseMode::Title,
            };
            text = Some(case_grapheme(
                typed,
                mode,
                mode == CaseMode::Title && starts_word(chars, start),
            ));
        }
        if text.as_deref() == Some(typed) {
            text = None;
        }
    }
    let stretch = kind == Kind::Space || cp == 0xa0;
    Unit {
        start,
        end,
        cp,
        text,
        slot: slot_index,
        small,
        kind,
        width: 0.0,
        brk: 0,
        shy: cp == SOFT_HYPHEN,
        stretch,
        x: 0.0,
    }
}

fn build_units(ctx: &Ctx, from: usize, to: usize) -> Vec<Unit> {
    let mut units = Vec::new();
    if is_simple_range(ctx.chars, from, to) {
        for i in from..to {
            units.push(make_unit(ctx, i, i + 1));
        }
    } else {
        let bounds = grapheme_boundaries(ctx.chars, from, to);
        for g in 0..bounds.len() - 1 {
            units.push(make_unit(ctx, bounds[g], bounds[g + 1]));
        }
    }
    for g in 0..units.len() {
        let brk = {
            let unit = &units[g];
            let next = units.get(g + 1);
            if unit.kind == Kind::Separator {
                2
            } else if next.is_none_or(|n| n.kind == Kind::Separator) {
                0
            } else {
                let next = next.unwrap();
                if unit.kind == Kind::Space || unit.kind == Kind::Tab {
                    u8::from(
                        next.kind != Kind::Space
                            && next.kind != Kind::Tab
                            && can_break_after_spaces(next.cp as i64),
                    )
                } else if next.kind == Kind::Space || next.kind == Kind::Tab {
                    0
                } else {
                    u8::from(can_break_between(
                        if g > 0 { units[g - 1].cp as i64 } else { -1 },
                        unit.cp as i64,
                        next.cp as i64,
                    ))
                }
            }
        };
        units[g].brk = brk;
    }
    units
}

/// Widths of the units: a word in one face is measured whole and its graphemes share that width in
/// proportion to their own advances.
fn measure_units(ctx: &mut Ctx, units: &mut [Unit]) {
    let mut i = 0;
    while i < units.len() {
        let (slot, small, kind) = (units[i].slot, units[i].small, units[i].kind);
        let letter_spacing = ctx.slots[slot].letter_spacing;
        if kind == Kind::Hidden || kind == Kind::Separator {
            units[i].width = 0.0;
            i += 1;
            continue;
        }
        let font = ctx.font_of(slot, small);
        if kind == Kind::Tab {
            units[i].width = 4.0 * ctx.measure(font, &[0x20]) + letter_spacing;
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < units.len()
            && units[j - 1].brk == 0
            && units[j].slot == slot
            && units[j].small == small
            && units[j].kind == kind
        {
            j += 1;
        }
        if j == i + 1 {
            let advance = ctx.advance_of(font, &units[i]);
            units[i].width = advance + letter_spacing;
        } else {
            let mut sum = 0.0;
            let mut typed = true;
            for unit in units[i..j].iter_mut() {
                let advance = ctx.advance_of(font, unit);
                unit.width = advance;
                sum += advance;
                typed &= unit.text.is_none();
            }
            let piece: Vec<u16> = if typed {
                ctx.chars[units[i].start..units[j - 1].end].to_vec()
            } else {
                let mut piece = Vec::new();
                for unit in &units[i..j] {
                    piece.extend_from_slice(ctx.display_of(unit));
                }
                piece
            };
            let whole = ctx.measure(font, &piece);
            let scale = if sum > 0.0 { whole / sum } else { 0.0 };
            for unit in &mut units[i..j] {
                unit.width = unit.width * scale + letter_spacing;
            }
        }
        i = j;
    }
}

// ── Line breaking ──────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
struct Span {
    from: usize,
    to: usize,
    forced: bool,
    hyphen: bool,
}

/// Greedy breaking: a line takes words while they fit; spaces hang past the edge; a word alone on a line
/// that is still too wide is broken between graphemes. `avail` is infinite when unconstrained.
fn break_lines(ctx: &mut Ctx, units: &[Unit], first_avail: f64, rest_avail: f64) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    let mut from = 0usize;
    loop {
        let avail = if spans.is_empty() {
            first_avail
        } else {
            rest_avail
        };
        let mut x = 0.0;
        let mut candidate: isize = -1;
        let mut candidate_hyphen = false;
        let mut ink = false;
        let mut to: isize = -1;
        let mut next: isize = -1;
        let mut forced = false;
        let mut hyphen = false;
        for (i, unit) in units.iter().enumerate().skip(from) {
            if unit.kind == Kind::Separator {
                to = i as isize;
                next = i as isize + 1;
                forced = true;
                break;
            }
            if unit.kind != Kind::Space
                && unit.width > 0.0
                && x + unit.width > avail + EPS
                && (ink || candidate >= from as isize)
            {
                if candidate >= from as isize {
                    to = candidate + 1;
                    next = to;
                    hyphen = candidate_hyphen;
                } else {
                    to = i as isize;
                    next = to;
                }
                break;
            }
            x += unit.width;
            if unit.kind == Kind::Ink || unit.kind == Kind::Tab {
                ink = true;
            }
            if unit.brk == 1 {
                if !unit.shy {
                    candidate = i as isize;
                    candidate_hyphen = false;
                } else if x + ctx.hyphen_width(unit.slot) <= avail + EPS {
                    candidate = i as isize;
                    candidate_hyphen = true;
                }
            }
        }
        if to < 0 {
            to = units.len() as isize;
            next = to;
        }
        let (to, next) = (to as usize, next as usize);
        spans.push(Span {
            from,
            to,
            forced,
            hyphen,
        });
        if next >= units.len() {
            if forced {
                spans.push(Span {
                    from: next,
                    to: next,
                    forced: false,
                    hyphen: false,
                });
            }
            return spans;
        }
        from = next;
    }
}

// ── Lines ──────────────────────────────────────────────────────────────────────────────────────

struct MarkerPlan {
    text: String,
    slot: usize,
    width: f64,
    indent: f64,
}

struct Draft {
    /// Index of the paragraph whose units this line draws.
    paragraph: usize,
    span: Span,
    paragraph_index: usize,
    to: usize,
    start: usize,
    end: usize,
    inset: f64,
    ink: f64,
    height: f64,
    above: f64,
    ascent: f64,
    descent: f64,
    last_in_paragraph: bool,
    wrapped: bool,
    top: f64,
    marker: Option<usize>,
    ellipsis: Option<(usize, f64)>,
}

/// Pen positions of the units of a line from its left edge; returns the ink width.
fn place_units(units: &mut [Unit], from: usize, to: usize) -> f64 {
    let mut x = 0.0;
    let mut ink = 0.0;
    for unit in &mut units[from..to] {
        unit.x = x;
        x += unit.width;
        if unit.kind == Kind::Ink
            || unit.kind == Kind::Tab
            || (unit.kind == Kind::Hidden && unit.text.as_ref().is_some_and(|t| !t.is_empty()))
        {
            ink = x;
        }
    }
    ink
}

/// Height and baseline of a line from every style on it.
fn line_metrics(
    slots: &[Slot],
    draft: &mut Draft,
    units: &[Unit],
    from: usize,
    to: usize,
    fallback_slot: usize,
    break_slot: i64,
) {
    let mut height = 0.0;
    let mut above = f64::NEG_INFINITY;
    let mut ascent = 0.0;
    let mut descent = 0.0;
    let mut last: i64 = -1;
    // The units of the line, then the fallback slot for an empty line, then the paragraph's line break.
    let mut consider = |index: i64, last: &mut i64| {
        if index < 0 || index == *last {
            return;
        }
        *last = index;
        let slot = &slots[index as usize];
        if slot.line_height > height {
            height = slot.line_height;
        }
        if slot.above > above {
            above = slot.above;
        }
        if slot.ascent > ascent {
            ascent = slot.ascent;
        }
        if slot.descent > descent {
            descent = slot.descent;
        }
    };
    for unit in &units[from..to] {
        consider(unit.slot as i64, &mut last);
    }
    let empty = if last < 0 { fallback_slot as i64 } else { -1 };
    consider(empty, &mut last);
    consider(break_slot, &mut last);
    draft.height = height;
    draft.above = above;
    draft.ascent = ascent;
    draft.descent = descent;
}

fn marker_text(list: ListType, number: usize) -> String {
    if list == ListType::Ordered {
        format!("{number}.")
    } else {
        "•".to_string()
    }
}

/// Lays out `request.text` whose characters are `chars`.
pub fn compute_layout(
    chars: &[u16],
    request: &LayoutRequest,
    cache: &mut MeasureCache,
    measurer: &mut dyn Measurer,
) -> TextLayout {
    compute(chars, request, cache, measurer, true)
}

/// [`compute_layout`] for what a layout stage reads of it (crates/layout `TextMetrics`): `width`, `height`,
/// `natural_width` and the first line, whose baseline it needs; the other lines are not finished (no runs, no
/// strings), and `slot_styles` is left empty. The measurer is asked exactly as `compute_layout` asks it (finishing a
/// line never measures), so the caches stay the TypeScript's twin.
pub fn compute_layout_metrics(
    chars: &[u16],
    request: &LayoutRequest,
    cache: &mut MeasureCache,
    measurer: &mut dyn Measurer,
) -> TextLayout {
    compute(chars, request, cache, measurer, false)
}

fn compute(
    chars: &[u16],
    request: &LayoutRequest,
    cache: &mut MeasureCache,
    measurer: &mut dyn Measurer,
    full: bool,
) -> TextLayout {
    let text: &TextProps = &request.text;
    let length = chars.len();
    let on_path = request.on_path;
    let box_height = request.height;

    // Styles: slot 0 is the base; each run resolves once.
    let mut slots: Vec<Slot> = vec![make_slot(text.style.clone(), cache, measurer)];
    let mut slot_runs: Vec<i64> = vec![-1];
    let mut slot_of: Option<Vec<u32>> = if text.runs.is_empty() {
        None
    } else {
        Some(vec![0; length])
    };
    for (run_index, run) in text.runs.iter().enumerate() {
        let start = js_max(0.0, run.start);
        let end = js_min(length as f64, run.end);
        if not_greater(end, start) {
            continue;
        }
        let index = slots.len();
        let partial = run.style.clone().unwrap_or_default();
        slots.push(make_slot(
            resolve_style(&text.style, &partial),
            cache,
            measurer,
        ));
        slot_runs.push(run_index as i64);
        let (a, b) = (start.trunc() as usize, end.trunc() as usize);
        for s in &mut slot_of.as_mut().unwrap()[a..b.min(length)] {
            *s = index as u32;
        }
    }
    let mut ctx = Ctx {
        chars,
        slots,
        slot_of,
        cache,
        measurer,
    };
    let slot_at = |ctx: &Ctx, offset: isize| -> usize {
        match &ctx.slot_of {
            Some(s) if length > 0 => s[offset.clamp(0, length as isize - 1) as usize] as usize,
            _ => 0,
        }
    };

    let constrained = request.width.is_some_and(|w| w.is_finite());
    let box_width = if constrained {
        js_max(0.0, request.width.unwrap())
    } else {
        f64::INFINITY
    };
    let paragraphs = paragraph_ranges(chars);
    let empty_types: Vec<ListType> = Vec::new();
    let list_types = text.list_types.as_ref().unwrap_or(&empty_types);
    let indent = js_max(0.0, finite(text.paragraph_indent.unwrap_or(0.0)));

    // List markers: numbering runs over consecutive ORDERED paragraphs; every paragraph of a list block
    // shares the block's hanging indent.
    let mut markers: Vec<Option<MarkerPlan>> = (0..paragraphs.len()).map(|_| None).collect();
    let mut p = 0;
    while p < paragraphs.len() {
        let kind = list_types.get(p).copied().unwrap_or_default();
        if kind == ListType::None {
            p += 1;
            continue;
        }
        let mut q = p;
        let mut widest: f64 = 0.0;
        while q < paragraphs.len() && list_types.get(q).copied().unwrap_or_default() == kind {
            let slot = slot_at(&ctx, paragraphs[q].0 as isize);
            let label = marker_text(kind, q - p + 1);
            let font = ctx.slots[slot].font;
            let width = ctx.measure(font, &label.encode_utf16().collect::<Vec<u16>>());
            widest = js_max(widest, width);
            markers[q] = Some(MarkerPlan {
                text: label,
                slot,
                width,
                indent: 0.0,
            });
            q += 1;
        }
        for marker in markers.iter_mut().take(q).skip(p).flatten() {
            let size = ctx.slots[marker.slot].style.font_size;
            marker.indent = js_max(size * 1.5, widest + size * 0.5);
        }
        p = q;
    }

    let mut all_units: Vec<Vec<Unit>> = Vec::with_capacity(paragraphs.len());
    let mut drafts: Vec<Draft> = Vec::new();
    for (paragraph_index, &(p_start, p_end)) in paragraphs.iter().enumerate() {
        let mut units = build_units(&ctx, p_start, p_end);
        measure_units(&mut ctx, &mut units);
        let marker = &markers[paragraph_index];
        let first_inset = marker.as_ref().map_or(indent, |m| m.indent);
        let rest_inset = marker.as_ref().map_or(0.0, |m| m.indent);
        let spans = break_lines(
            &mut ctx,
            &units,
            box_width - first_inset,
            box_width - rest_inset,
        );
        let empty_slot = if let Some(last) = units.last() {
            last.slot
        } else {
            slot_at(
                &ctx,
                if p_start < length {
                    p_start as isize
                } else {
                    p_start as isize - 1
                },
            )
        };
        let count = spans.len();
        for (index, span) in spans.into_iter().enumerate() {
            if span.hyphen {
                let shy_slot = units[span.to - 1].slot;
                let width = ctx.hyphen_width(shy_slot);
                let shy = &mut units[span.to - 1];
                shy.text = Some(vec![0x2d]);
                shy.width = width;
            }
            let start = if span.from < units.len() {
                units[span.from].start
            } else if let Some(last) = units.last() {
                last.end
            } else {
                p_start
            };
            let end = if span.from < span.to {
                units[span.to - 1].end
            } else {
                start
            };
            let ink = place_units(&mut units, span.from, span.to);
            let mut draft = Draft {
                paragraph: paragraph_index,
                span,
                paragraph_index,
                to: span.to,
                start,
                end,
                inset: if index == 0 { first_inset } else { rest_inset },
                ink,
                height: 0.0,
                above: 0.0,
                ascent: 0.0,
                descent: 0.0,
                last_in_paragraph: index == count - 1,
                wrapped: !span.forced && index < count - 1,
                top: 0.0,
                marker: if index == 0 && marker.is_some() {
                    Some(paragraph_index)
                } else {
                    None
                },
                ellipsis: None,
            };
            let break_slot: i64 = if index == count - 1 && p_end < length {
                slot_at(&ctx, p_end as isize) as i64
            } else {
                -1
            };
            let fallback = if span.from < units.len() {
                units[span.from].slot
            } else {
                empty_slot
            };
            line_metrics(
                &ctx.slots, &mut draft, &units, span.from, span.to, fallback, break_slot,
            );
            drafts.push(draft);
        }
        all_units.push(units);
    }

    // Stack the lines: paragraph spacing goes between paragraphs.
    let spacing = finite(text.paragraph_spacing.unwrap_or(0.0));
    let mut y = 0.0;
    for i in 0..drafts.len() {
        if i > 0 && drafts[i].paragraph_index != drafts[i - 1].paragraph_index {
            y += spacing;
        }
        drafts[i].top = y;
        y += drafts[i].height;
    }
    let mut natural_width = 0.0;
    for draft in &drafts {
        natural_width = js_max(natural_width, draft.inset + draft.ink);
    }

    // TRUNCATE: keep the lines that fit the box (at least one) and at most `maxLines`.
    let mut kept = drafts.len();
    let mut truncated = false;
    if text.text_auto_resize == AutoResize::Truncate && !on_path {
        let max_lines = match text.max_lines {
            Some(m) if m > 0.0 => m.floor(),
            _ => f64::INFINITY,
        };
        let mut fit = 0usize;
        while fit < drafts.len()
            && (fit as f64) < max_lines
            && drafts[fit].top + drafts[fit].height <= box_height + EPS
        {
            fit += 1;
        }
        kept = fit.max(1);
        if kept < drafts.len() {
            truncated = true;
            let avail = box_width - drafts[kept - 1].inset;
            let draft = &mut drafts[kept - 1];
            truncate_line(&mut ctx, draft, &mut all_units[draft.paragraph], avail);
        }
    }
    drafts.truncate(kept);
    let content_height = drafts.last().map_or(0.0, |d| d.top + d.height);

    let align_width = if constrained {
        box_width
    } else {
        natural_width
    };
    let fixed_height = !on_path
        && (text.text_auto_resize == AutoResize::None
            || text.text_auto_resize == AutoResize::Truncate);
    let free = if fixed_height {
        finite(box_height) - content_height
    } else {
        0.0
    };
    let shift = match text.text_align_vertical {
        VerticalAlign::Center => free / 2.0,
        VerticalAlign::Bottom => free,
        VerticalAlign::Top => 0.0,
    };

    let lines = drafts
        .iter()
        .take(if full { usize::MAX } else { 1 })
        .map(|draft| {
            finish_line(
                &ctx,
                draft,
                &markers,
                &mut all_units[draft.paragraph],
                align_width,
                text.text_align_horizontal,
                shift,
            )
        })
        .collect();
    TextLayout {
        width: align_width,
        height: content_height,
        lines,
        truncated,
        natural_width,
        length,
        slot_runs,
        slot_styles: if full {
            ctx.slots.iter().map(|s| s.style.clone()).collect()
        } else {
            Vec::new()
        },
    }
}

/// Shortens the last kept line of a truncated text so its ink and a "…" fit `avail`.
fn truncate_line(ctx: &mut Ctx, draft: &mut Draft, units: &mut [Unit], avail: f64) {
    let from = draft.span.from;
    if draft.span.hyphen {
        let shy = &mut units[draft.span.to - 1];
        shy.text = Some(Vec::new());
        shy.width = 0.0;
    }
    let mut to = draft.to;
    loop {
        while to > from && units[to - 1].kind != Kind::Ink && units[to - 1].kind != Kind::Tab {
            to -= 1;
        }
        let slot = if to > from {
            units[to - 1].slot
        } else if from < units.len() {
            units[from].slot
        } else {
            0
        };
        let ink = place_units(units, from, to);
        let font = ctx.slots[slot].font;
        let width = ctx.measure(font, &[0x2026]) + ctx.slots[slot].letter_spacing;
        if to == from || ink + width <= avail + EPS {
            draft.to = to;
            draft.end = if to > from {
                units[to - 1].end
            } else {
                draft.start
            };
            draft.ink = ink + width;
            draft.ellipsis = Some((slot, width));
            draft.wrapped = false;
            return;
        }
        to -= 1;
    }
}

fn finish_line(
    ctx: &Ctx,
    draft: &Draft,
    markers: &[Option<MarkerPlan>],
    units: &mut [Unit],
    align_width: f64,
    align: HorizontalAlign,
    shift: f64,
) -> TextLine {
    let from = draft.span.from;
    let to = draft.to;
    let avail = align_width - draft.inset;
    let mut x = draft.inset;
    let mut ink_width = draft.ink;
    let mut justified = false;
    if align == HorizontalAlign::Justified
        && !draft.last_in_paragraph
        && !draft.span.forced
        && draft.ellipsis.is_none()
        && avail > ink_width
        && avail.is_finite()
    {
        let mut last_ink = to as isize - 1;
        while last_ink >= from as isize && units[last_ink as usize].kind == Kind::Space {
            last_ink -= 1;
        }
        let inner = from..last_ink.max(from as isize) as usize;
        let count = units[inner.clone()].iter().filter(|u| u.stretch).count();
        if count > 0 {
            let extra = (avail - ink_width) / count as f64;
            for unit in units[inner].iter_mut().filter(|u| u.stretch) {
                unit.width += extra;
            }
            place_units(units, from, to);
            ink_width = avail;
            justified = true;
        }
    } else if align == HorizontalAlign::Center {
        x += js_max(0.0, (avail - ink_width) / 2.0);
    } else if align == HorizontalAlign::Right {
        x += js_max(0.0, avail - ink_width);
    }
    if !x.is_finite() {
        x = draft.inset;
    }

    let mut runs: Vec<GlyphRun> = Vec::new();
    let mut first = from;
    let mut typed = true;
    let close = |ctx: &Ctx,
                 runs: &mut Vec<GlyphRun>,
                 first: usize,
                 end: usize,
                 typed: bool,
                 units: &[Unit]| {
        let Some(run) = runs.last_mut() else { return };
        if typed {
            run.text = ctx.chars[run.start..run.end].to_vec();
        } else {
            let mut text: Vec<u16> = Vec::new();
            for unit in &units[first..end] {
                text.extend_from_slice(ctx.display_of(unit));
            }
            run.text = text;
        }
    };
    let mut prev: Option<usize> = None;
    for i in from..to {
        let (slot_index, small, kind, start, end, ux, width, text_is_some, stretch) = {
            let u = &units[i];
            (
                u.slot,
                u.small,
                u.kind,
                u.start,
                u.end,
                u.x,
                u.width,
                u.text.is_some(),
                u.stretch,
            )
        };
        let slot = &ctx.slots[slot_index];
        let pen = x + ux;
        let new_run = match prev {
            None => true,
            Some(p) => {
                let pu = &units[p];
                slot_index != pu.slot
                    || small != pu.small
                    || kind == Kind::Tab
                    || pu.kind == Kind::Tab
                    || (justified && pu.stretch)
            }
        };
        let _ = stretch;
        if new_run {
            close(ctx, &mut runs, first, i, typed, units);
            let style = if small && slot.small_style.is_some() {
                slot.small_style.clone().unwrap()
            } else {
                slot.style.clone()
            };
            let font = ctx.cache.entry(ctx.font_of(slot_index, small)).spec.clone();
            runs.push(GlyphRun {
                text: Vec::new(),
                start,
                end: start,
                x: pen,
                width: 0.0,
                style,
                font,
                letter_spacing: slot.letter_spacing,
                offsets: vec![start],
                xs: vec![pen],
                ellipsis: false,
                slot: slot_index,
            });
            first = i;
            typed = true;
        }
        if text_is_some {
            typed = false;
        }
        let run = runs.last_mut().unwrap();
        run.end = end;
        run.width = pen + width - run.x;
        run.offsets.push(end);
        run.xs.push(pen + width);
        prev = Some(i);
    }
    close(ctx, &mut runs, first, to, typed, units);
    if let Some((slot_index, width)) = draft.ellipsis {
        let slot = &ctx.slots[slot_index];
        let ex = x + if to > from {
            units[to - 1].x + units[to - 1].width
        } else {
            0.0
        };
        runs.push(GlyphRun {
            text: vec![0x2026],
            start: draft.end,
            end: draft.end,
            x: ex,
            width,
            style: slot.style.clone(),
            font: ctx.cache.entry(slot.font).spec.clone(),
            letter_spacing: slot.letter_spacing,
            offsets: vec![draft.end],
            xs: vec![ex],
            ellipsis: true,
            slot: slot_index,
        });
    }

    let top = draft.top + shift;
    let mut line = TextLine {
        runs,
        start: draft.start,
        end: draft.end,
        x,
        top,
        baseline: top + draft.above,
        width: ink_width,
        height: draft.height,
        paragraph_index: draft.paragraph_index,
        list_marker: None,
        marker: None,
        ascent: draft.ascent,
        descent: draft.descent,
        wrapped: draft.wrapped,
    };
    if let Some(Some(plan)) = draft.marker.map(|p| &markers[p]) {
        let slot = &ctx.slots[plan.slot];
        line.list_marker = Some(plan.text.clone());
        line.marker = Some(ListMarker {
            text: plan.text.clone(),
            x: x - plan.indent,
            width: plan.width,
            style: slot.style.clone(),
            font: ctx.cache.entry(slot.font).spec.clone(),
            slot: plan.slot,
        });
    }
    line
}
