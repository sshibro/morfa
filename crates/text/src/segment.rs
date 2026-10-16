//! Graphemes, words, paragraphs and line-break classes: the Rust twin of `shared/design/text-segment.ts`.
//! Text is UTF-16 code units (`&[u16]`) and every offset is a code-unit offset, as in
//! `TextProps.characters`, so results are equal to the TypeScript ones number for number. The JavaScript
//! string quirks the oracle has (`lastIndexOf` clamping a negative start to 0, `codePointAt` on a lone
//! surrogate) are kept on purpose.

use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_segmentation::UnicodeSegmentation;

pub type TextRange = (usize, usize);

pub const SOFT_HYPHEN: u32 = 0xad;
pub const ZERO_WIDTH_SPACE: u32 = 0x200b;
pub const WORD_JOINER: u32 = 0x2060;
pub const ZERO_WIDTH_NO_BREAK_SPACE: u32 = 0xfeff;
/// Shift+Enter: a line break inside the paragraph.
pub const LINE_SEPARATOR: u32 = 0x2028;

// ── JavaScript string semantics ────────────────────────────────────────────────────────────────

/// `text.codePointAt(i)`: the code point starting at `i`, or the lone surrogate itself; -1 past the ends.
pub fn code_at(text: &[u16], i: isize) -> i64 {
    if i < 0 || i as usize >= text.len() {
        return -1;
    }
    let i = i as usize;
    let unit = text[i];
    if (0xd800..0xdc00).contains(&unit) && i + 1 < text.len() {
        let low = text[i + 1];
        if (0xdc00..0xe000).contains(&low) {
            return 0x10000 + ((unit as i64 - 0xd800) << 10) + (low as i64 - 0xdc00);
        }
    }
    unit as i64
}

#[inline]
pub fn code_point_at(text: &[u16], i: usize) -> u32 {
    code_at(text, i as isize) as u32
}

/// Start of the code point that ends at `i` (steps over a surrogate pair).
pub fn cp_before(text: &[u16], i: usize) -> usize {
    if i >= 2 && (0xdc00..0xe000).contains(&text[i - 1]) && (0xd800..0xdc00).contains(&text[i - 2])
    {
        i - 2
    } else {
        i - 1
    }
}

pub fn cp_after(text: &[u16], i: usize) -> usize {
    i + if code_at(text, i as isize) > 0xffff {
        2
    } else {
        1
    }
}

/// `text.indexOf(ch, from)` for a BMP character.
fn index_of(text: &[u16], unit: u16, from: usize) -> Option<usize> {
    text.iter()
        .skip(from)
        .position(|&u| u == unit)
        .map(|p| p + from)
}

/// `text.lastIndexOf(ch, from)`: a negative `from` looks at index 0 only, as JavaScript does.
fn last_index_of(text: &[u16], unit: u16, from: isize) -> Option<usize> {
    if text.is_empty() {
        return None;
    }
    let from = from.max(0) as usize;
    let last = from.min(text.len() - 1);
    (0..=last).rev().find(|&i| text[i] == unit)
}

fn char_of(cp: i64) -> Option<char> {
    if cp < 0 {
        None
    } else {
        char::from_u32(cp as u32)
    }
}

fn category(cp: i64) -> Option<GeneralCategory> {
    char_of(cp).map(get_general_category)
}

fn is_category_l(cp: i64) -> bool {
    matches!(
        category(cp),
        Some(
            GeneralCategory::UppercaseLetter
                | GeneralCategory::LowercaseLetter
                | GeneralCategory::TitlecaseLetter
                | GeneralCategory::ModifierLetter
                | GeneralCategory::OtherLetter
        )
    )
}

fn is_category_n(cp: i64) -> bool {
    matches!(
        category(cp),
        Some(
            GeneralCategory::DecimalNumber
                | GeneralCategory::LetterNumber
                | GeneralCategory::OtherNumber
        )
    )
}

fn is_category_m(cp: i64) -> bool {
    matches!(
        category(cp),
        Some(
            GeneralCategory::NonspacingMark
                | GeneralCategory::SpacingMark
                | GeneralCategory::EnclosingMark
        )
    )
}

/// `String.prototype.toUpperCase` / `toLowerCase` over code units: lone surrogates pass through unchanged.
pub fn js_case(text: &[u16], upper: bool) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    for item in char::decode_utf16(text.iter().copied()) {
        match item {
            Ok(c) => {
                let mut buf = [0u16; 2];
                if upper {
                    for u in c.to_uppercase() {
                        out.extend_from_slice(u.encode_utf16(&mut buf));
                    }
                } else {
                    for l in c.to_lowercase() {
                        out.extend_from_slice(l.encode_utf16(&mut buf));
                    }
                }
            }
            Err(e) => out.push(e.unpaired_surrogate()),
        }
    }
    out
}

// ── Graphemes ──────────────────────────────────────────────────────────────────────────────────

/// Code units that are a grapheme of their own whatever surrounds them (`isSimpleCode`).
#[inline]
pub fn is_simple_code(c: u16) -> bool {
    (c < 0x300 && c != 0x0d)
        || (0x370..=0x482).contains(&c)
        || (0x48a..=0x52f).contains(&c)
        || (0x1e00..=0x200b).contains(&c)
        || (0x200e..=0x20cf).contains(&c)
        || (0x2100..=0x2bff).contains(&c)
        || (0x3000..=0x303f).contains(&c)
}

pub fn is_simple_range(text: &[u16], from: usize, to: usize) -> bool {
    text[from..to].iter().all(|&c| is_simple_code(c))
}

/// Grapheme boundaries of text[from, to], both ends included, ascending (UAX #29 extended clusters, as
/// `Intl.Segmenter` gives them).
pub fn grapheme_boundaries(text: &[u16], from: usize, to: usize) -> Vec<usize> {
    if is_simple_range(text, from, to) {
        return (from..=to).collect();
    }
    // Decode to a String, remembering where every char starts in code units.
    let mut s = String::with_capacity(to - from);
    let mut starts: Vec<(usize, usize)> = Vec::with_capacity(to - from); // (byte offset in s, unit offset)
    let mut unit = from;
    for item in char::decode_utf16(text[from..to].iter().copied()) {
        let (c, units) = match item {
            Ok(c) => (c, c.len_utf16()),
            Err(_) => ('\u{fffd}', 1),
        };
        starts.push((s.len(), unit));
        s.push(c);
        unit += units;
    }
    let mut out = Vec::new();
    for (byte, _) in s.grapheme_indices(true) {
        let k = starts
            .binary_search_by_key(&byte, |&(b, _)| b)
            .expect("grapheme starts on a char");
        out.push(starts[k].1);
    }
    out.push(to);
    out
}

fn paragraph_bounds(text: &[u16], offset: usize) -> TextRange {
    let start = last_index_of(text, 0x0a, offset as isize - 1).map_or(0, |i| i + 1);
    let end = index_of(text, 0x0a, offset).unwrap_or(text.len());
    (start, end)
}

/// The grapheme boundary after `offset` (one step of → or Delete).
pub fn next_grapheme_boundary(text: &[u16], offset: usize) -> usize {
    if offset >= text.len() {
        return text.len();
    }
    let here = text[offset];
    if is_simple_code(here) && (offset + 1 >= text.len() || is_simple_code(text[offset + 1])) {
        return offset + 1;
    }
    let (start, end) = paragraph_bounds(text, offset);
    if offset >= end {
        return text.len().min(end + 1);
    }
    for b in grapheme_boundaries(text, start, end) {
        if b > offset {
            return b;
        }
    }
    end
}

/// The grapheme boundary before `offset` (one step of ← or Backspace).
pub fn prev_grapheme_boundary(text: &[u16], offset: usize) -> usize {
    if offset == 0 {
        return 0;
    }
    if offset > text.len() {
        return text.len();
    }
    if is_simple_code(text[offset - 1]) {
        return offset - 1;
    }
    let (start, end) = paragraph_bounds(text, offset);
    if offset <= start {
        return start - 1;
    }
    let bounds = grapheme_boundaries(text, start, end);
    for &b in bounds.iter().rev() {
        if b < offset {
            return b;
        }
    }
    start
}

/// `offset` moved onto a grapheme boundary (backwards, or forwards with `forward`). `offset` is a
/// JavaScript number: rounded as `Math.round` rounds.
pub fn snap_to_grapheme(text: &[u16], offset: f64, forward: bool) -> usize {
    let o = js_round(offset).clamp(0.0, text.len() as f64) as usize;
    if o == 0 || o == text.len() {
        return o;
    }
    if is_simple_code(text[o - 1]) && is_simple_code(text[o]) {
        return o;
    }
    let (start, end) = paragraph_bounds(text, o);
    if o == start || o == end {
        return o;
    }
    let mut prev = start;
    for b in grapheme_boundaries(text, start, end) {
        if b == o {
            return o;
        }
        if b > o {
            return if forward { b } else { prev };
        }
        prev = b;
    }
    o
}

/// `Math.round`: halves go up, also for negatives; NaN → 0.
pub fn js_round(value: f64) -> f64 {
    if value.is_nan() {
        return 0.0;
    }
    (value + 0.5).floor()
}

// ── Words and paragraphs ───────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CharClass {
    Word,
    Space,
    Newline,
    Other,
}

pub fn is_letter_or_digit(cp: i64) -> bool {
    cp >= 0
        && if cp < 0x80 {
            (0x30..=0x39).contains(&cp) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a)
        } else {
            is_category_l(cp) || is_category_n(cp)
        }
}

fn is_word_part(cp: i64) -> bool {
    cp >= 0
        && if cp < 0x80 {
            is_letter_or_digit(cp)
        } else {
            is_category_l(cp) || is_category_n(cp) || is_category_m(cp)
        }
}

/// A letter, digit or combining mark, or an apostrophe inside a word.
pub fn class_at(text: &[u16], i: isize) -> CharClass {
    let cp = code_at(text, i);
    if cp == 0x0a || cp == 0x2028 || cp == 0x2029 {
        return CharClass::Newline;
    }
    if is_word_part(cp) {
        return CharClass::Word;
    }
    if (cp == 0x27 || cp == 0x2019 || cp == 0x2bc) && i >= 0 {
        let before = if i as usize > 0 {
            code_at(text, cp_before(text, i as usize) as isize)
        } else {
            code_at(text, -1)
        };
        if is_letter_or_digit(before) && is_letter_or_digit(code_at(text, i + 1)) {
            return CharClass::Word;
        }
    }
    if cp >= 0 && (is_breaking_space(cp as u32) || is_glue_space(cp as u32)) {
        return CharClass::Space;
    }
    CharClass::Other
}

/// The word around `offset` (double-click).
pub fn word_at(text: &[u16], offset: usize) -> TextRange {
    let o = offset.min(text.len());
    let after = if o < text.len() {
        Some(class_at(text, o as isize))
    } else {
        None
    };
    let before = if o > 0 {
        Some(class_at(text, cp_before(text, o) as isize))
    } else {
        None
    };
    let expand = |from: usize, kind: CharClass| -> TextRange {
        let (mut start, mut end) = (from, from);
        while start > 0 && class_at(text, cp_before(text, start) as isize) == kind {
            start = cp_before(text, start);
        }
        while end < text.len() && class_at(text, end as isize) == kind {
            end = cp_after(text, end);
        }
        (start, end)
    };
    match (after, before) {
        (Some(CharClass::Word), _) => expand(o, CharClass::Word),
        (_, Some(CharClass::Word)) => expand(o, CharClass::Word),
        (Some(CharClass::Space), _) => expand(o, CharClass::Space),
        (Some(CharClass::Other), _) => (o, next_grapheme_boundary(text, o)),
        (_, Some(CharClass::Space)) => expand(o, CharClass::Space),
        (_, Some(CharClass::Other)) => (prev_grapheme_boundary(text, o), o),
        _ => (o, o),
    }
}

/// ⌥← : the start of the word before `offset`, skipping spaces and punctuation.
pub fn word_start_before(text: &[u16], offset: usize) -> usize {
    let mut i = offset.min(text.len());
    while i > 0 && class_at(text, cp_before(text, i) as isize) != CharClass::Word {
        i = cp_before(text, i);
    }
    while i > 0 && class_at(text, cp_before(text, i) as isize) == CharClass::Word {
        i = cp_before(text, i);
    }
    i
}

/// ⌥→ : the end of the word after `offset`.
pub fn word_end_after(text: &[u16], offset: usize) -> usize {
    let mut i = offset.min(text.len());
    while i < text.len() && class_at(text, i as isize) != CharClass::Word {
        i = cp_after(text, i);
    }
    while i < text.len() && class_at(text, i as isize) == CharClass::Word {
        i = cp_after(text, i);
    }
    i
}

/// True when a letter at `i` starts a word.
pub fn starts_word(text: &[u16], i: usize) -> bool {
    i == 0 || class_at(text, cp_before(text, i) as isize) != CharClass::Word
}

/// The paragraph holding `offset` and its index.
pub fn paragraph_at(text: &[u16], offset: usize) -> (usize, usize, usize) {
    let o = offset.min(text.len());
    let (start, end) = paragraph_bounds(text, o);
    let mut index = 0;
    let mut i = index_of(text, 0x0a, 0);
    while let Some(k) = i {
        if k >= start {
            break;
        }
        index += 1;
        i = index_of(text, 0x0a, k + 1);
    }
    (start, end, index)
}

/// Every paragraph of `text`; an empty text has one empty paragraph.
pub fn paragraph_ranges(text: &[u16]) -> Vec<TextRange> {
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(i) = index_of(text, 0x0a, start) {
        out.push((start, i));
        start = i + 1;
    }
    out.push((start, text.len()));
    out
}

// ── Line-break classes ─────────────────────────────────────────────────────────────────────────

#[inline]
pub fn is_breaking_space(cp: u32) -> bool {
    cp == 0x20
        || cp == 0x09
        || cp == 0x1680
        || ((0x2000..=0x200a).contains(&cp) && cp != 0x2007)
        || cp == 0x205f
        || cp == 0x3000
}

#[inline]
pub fn is_glue_space(cp: u32) -> bool {
    cp == 0xa0 || cp == 0x202f || cp == 0x2007
}

#[inline]
pub fn is_dash(cp: i64) -> bool {
    cp == 0x2013 || cp == 0x2014 || cp == 0x2015
}

fn is_hyphen(cp: i64) -> bool {
    cp == 0x2d || cp == 0x2010
}

fn is_digit(cp: i64) -> bool {
    (0x30..=0x39).contains(&cp)
        || (cp > 0x7f && matches!(category(cp), Some(GeneralCategory::DecimalNumber)))
}

fn is_letter(cp: i64) -> bool {
    cp >= 0
        && if cp < 0x80 {
            (cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a
        } else {
            is_category_l(cp)
        }
}

const CLOSING: &str = ")]}»”’.,;:!?…、。，．」』）〕】";
const OPENING: &str = "([{«„“‘「『（〔【";

fn is_closing(cp: i64) -> bool {
    char_of(cp).is_some_and(|c| CLOSING.contains(c))
}

fn is_opening(cp: i64) -> bool {
    char_of(cp).is_some_and(|c| OPENING.contains(c))
}

fn is_ideographic(cp: i64) -> bool {
    ((0x2e80..=0x9fff).contains(&cp) && !(0x3000..=0x303f).contains(&cp))
        || (0xac00..=0xd7af).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0xff00..=0xffef).contains(&cp)
        || (0x20000..=0x3ffff).contains(&cp)
}

/// May a line break after a run of breaking spaces followed by `next`? Not before a dash.
pub fn can_break_after_spaces(next: i64) -> bool {
    next != WORD_JOINER as i64 && next != ZERO_WIDTH_NO_BREAK_SPACE as i64 && !is_dash(next)
}

/// May a line break between the grapheme starting with `cp` and the next starting with `next`?
pub fn can_break_between(prev: i64, cp: i64, next: i64) -> bool {
    if next < 0
        || next == WORD_JOINER as i64
        || next == ZERO_WIDTH_NO_BREAK_SPACE as i64
        || cp == WORD_JOINER as i64
        || cp == ZERO_WIDTH_NO_BREAK_SPACE as i64
    {
        return false;
    }
    if is_breaking_space(next as u32)
        || is_glue_space(next as u32)
        || (cp >= 0 && is_glue_space(cp as u32))
    {
        return false;
    }
    if cp == ZERO_WIDTH_SPACE as i64 || cp == SOFT_HYPHEN as i64 {
        return true;
    }
    if is_hyphen(cp) {
        return is_letter_or_digit(prev) && is_letter(next);
    }
    if is_dash(cp) {
        return !is_dash(next) && !is_closing(next);
    }
    if cp == 0x2f {
        return next != 0x2f && !is_digit(next) && !is_closing(next);
    }
    if is_ideographic(cp) || is_ideographic(next) {
        return !is_closing(next) && !is_opening(cp);
    }
    false
}

// ── Case ───────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CaseMode {
    Upper,
    Lower,
    Title,
}

/// The display form of one grapheme under a text case.
pub fn case_grapheme(grapheme: &[u16], mode: CaseMode, word_start: bool) -> Vec<u16> {
    match mode {
        CaseMode::Upper => js_case(grapheme, true),
        CaseMode::Lower => js_case(grapheme, false),
        CaseMode::Title => {
            if word_start {
                js_case(grapheme, true)
            } else {
                grapheme.to_vec()
            }
        }
    }
}

/// True when the grapheme changes under upper-casing.
pub fn has_lowercase(grapheme: &[u16]) -> bool {
    js_case(grapheme, true) != grapheme
}

pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphemes_keep_clusters_whole() {
        let t = utf16("ё👍🏽 🇷🇺 👨\u{200d}👩\u{200d}👧 е\u{301}");
        let b = grapheme_boundaries(&t, 0, t.len());
        // ё | 👍🏽 | space | 🇷🇺 | space | family | space | е́
        assert_eq!(b.len(), 9);
        assert_eq!(b[0], 0);
        assert_eq!(*b.last().unwrap(), t.len());
        assert_eq!(
            next_grapheme_boundary(&t, 1),
            5,
            "the thumbs up with its skin tone is one step"
        );
        assert_eq!(prev_grapheme_boundary(&t, t.len()), t.len() - 2);
    }

    #[test]
    fn words_follow_russian_and_english_rules() {
        let t = utf16("д’Артаньян don't  «ёлочки»");
        assert_eq!(word_at(&t, 3), (0, 10));
        assert_eq!(word_at(&t, 12), (11, 16));
        assert_eq!(word_at(&t, 17), (16, 18), "a run of spaces");
        assert_eq!(word_start_before(&t, 16), 11);
        assert_eq!(word_end_after(&t, 18), 25);
        assert!(starts_word(&t, 11));
        assert!(!starts_word(&t, 12));
    }

    #[test]
    fn paragraphs_and_js_quirks() {
        let t = utf16("ab\ncd\n");
        assert_eq!(paragraph_ranges(&t), vec![(0, 2), (3, 5), (6, 6)]);
        assert_eq!(paragraph_at(&t, 4), (3, 5, 1));
        assert_eq!(paragraph_ranges(&[]), vec![(0, 0)]);
        // lastIndexOf('\n', -1) looks at index 0: the oracle's quirk on a leading newline.
        let lead = utf16("\nx");
        assert_eq!(paragraph_at(&lead, 0), (1, 0, 1));
    }

    #[test]
    fn line_breaks_russian_typography() {
        let dash = 0x2014;
        assert!(!can_break_after_spaces(dash));
        assert!(can_break_between('о' as i64, '-' as i64, 'з' as i64));
        assert!(!can_break_between('2' as i64, '-' as i64, '3' as i64));
        assert!(can_break_between('о' as i64, dash, 'с' as i64));
        assert!(!can_break_between('a' as i64, 0xa0, 'b' as i64));
        assert!(can_break_between('x' as i64, '/' as i64, 'y' as i64));
        assert!(!can_break_between('x' as i64, '/' as i64, '2' as i64));
    }

    #[test]
    fn case_mapping_matches_javascript() {
        assert_eq!(
            case_grapheme(&utf16("ß"), CaseMode::Upper, false),
            utf16("SS")
        );
        assert_eq!(
            case_grapheme(&utf16("ё"), CaseMode::Title, true),
            utf16("Ё")
        );
        assert_eq!(
            case_grapheme(&utf16("ё"), CaseMode::Title, false),
            utf16("ё")
        );
        assert!(has_lowercase(&utf16("й")));
        assert!(!has_lowercase(&utf16("Й1")));
        assert_eq!(js_case(&[0xd800, 0x61], true), vec![0xd800, 0x41]);
        assert_eq!(snap_to_grapheme(&utf16("a👍🏽b"), 2.4, false), 1);
        assert_eq!(snap_to_grapheme(&utf16("a👍🏽b"), 2.6, true), 5);
    }
}
