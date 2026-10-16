//! The part of shared/design/text-edit.ts the merge replays: `caretStyleAt` and `insertText` over a text layer's
//! `TextProps` held as a [`Value`]. Offsets are UTF-16 code units, as JavaScript's string indexes are.
//!
//! Runs are sparse overrides of the base style. Each operation works on a dense view (segments covering every
//! character, `None` = the base style) and writes the runs back normalized: sorted, non-overlapping, inside the
//! characters, no empty runs, no field equal to the base style, no two touching runs that say the same thing.

use crate::value::{Object, Value, from_utf16, utf16};

/// A run's say about its characters (`RunOverride`): `{style, fills?, textStyleId?}`.
#[derive(Clone, Debug)]
pub struct RunOverride {
    pub style: Value,
    pub fills: Option<Value>,
    pub text_style_id: Option<Value>,
}

#[derive(Clone, Debug)]
struct Segment {
    start: f64,
    end: f64,
    o: Option<RunOverride>,
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

/// `a < b` with JavaScript's reading of missing values (`undefined` compares false).
fn less(a: Option<f64>, b: Option<f64>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a < b)
}

fn override_of(run: &Value) -> RunOverride {
    let style = run
        .get("style")
        .filter(|style| !style.is_null())
        .cloned()
        .unwrap_or_else(|| Value::object(Object::new()));
    RunOverride {
        style,
        fills: run.get("fills").filter(|fills| fills.truthy()).cloned(),
        text_style_id: run.get("textStyleId").filter(|id| id.truthy()).cloned(),
    }
}

/// JavaScript's `a - b || c - d` comparator, NaN reading as 0.
fn compare_runs(a: &Value, b: &Value) -> std::cmp::Ordering {
    let order = |x: f64| {
        if x.is_nan() || x == 0.0 {
            None
        } else if x < 0.0 {
            Some(std::cmp::Ordering::Less)
        } else {
            Some(std::cmp::Ordering::Greater)
        }
    };
    let diff =
        |key: &str| number(a.get(key)).unwrap_or(f64::NAN) - number(b.get(key)).unwrap_or(f64::NAN);
    order(diff("start"))
        .or_else(|| order(diff("end")))
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn to_segments(text: &Value, length: f64) -> Vec<Segment> {
    let mut runs: Vec<&Value> = text
        .get("runs")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .filter(|run| run.truthy() && less(number(run.get("start")), number(run.get("end"))))
        .collect();
    runs.sort_by(|a, b| compare_runs(a, b));
    let mut segments = Vec::new();
    let mut pos = 0.0_f64;
    for run in runs {
        let start = pos.max(number(run.get("start")).unwrap_or(f64::NAN));
        let end = number(run.get("end")).unwrap_or(f64::NAN).min(length);
        if end.is_nan() || start.is_nan() || end <= start {
            continue;
        }
        if start > pos {
            segments.push(Segment {
                start: pos,
                end: start,
                o: None,
            });
        }
        segments.push(Segment {
            start,
            end,
            o: Some(override_of(run)),
        });
        pos = end;
    }
    if pos < length {
        segments.push(Segment {
            start: pos,
            end: length,
            o: None,
        });
    }
    segments
}

/// `fieldValue`: a link compares as null when absent.
fn field_value<'a>(style: &'a Value, key: &str) -> Option<&'a Value> {
    const NULL: &Value = &Value::Null;
    let value = style.get(key);
    if key == "hyperlink" {
        Some(value.unwrap_or(NULL))
    } else {
        value
    }
}

fn same_option(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.same(b),
        _ => false,
    }
}

/// `cleanOverride` (without node fills: the paths here never pass them).
fn clean_override(o: Option<&RunOverride>, base: &Value) -> Option<RunOverride> {
    let o = o?;
    let mut style = Object::new();
    let mut any = false;
    if let Some(fields) = o.style.as_object() {
        for (key, value) in fields.iter() {
            if same_option(field_value(&o.style, key), field_value(base, key)) {
                continue;
            }
            style.insert(key.clone(), value.clone());
            any = true;
        }
    }
    let fills = o.fills.clone();
    if !any && fills.is_none() && o.text_style_id.is_none() {
        return None;
    }
    Some(RunOverride {
        style: Value::object(style),
        fills,
        text_style_id: o.text_style_id.clone(),
    })
}

fn same_override(a: &RunOverride, b: &RunOverride) -> bool {
    let null = Value::Null;
    a.style.same(&b.style)
        && same_option(a.fills.as_ref(), b.fills.as_ref())
        && a.text_style_id
            .as_ref()
            .unwrap_or(&null)
            .identical(b.text_style_id.as_ref().unwrap_or(&null))
}

fn to_runs(segments: &[Segment], base: &Value) -> Vec<Value> {
    struct Run {
        start: f64,
        end: f64,
        o: RunOverride,
    }
    let mut runs: Vec<Run> = Vec::new();
    let mut last = false;
    for segment in segments {
        if segment.end <= segment.start {
            continue;
        }
        let Some(o) = clean_override(segment.o.as_ref(), base) else {
            last = false;
            continue;
        };
        if last {
            let previous = runs.last_mut().expect("a last run");
            #[allow(clippy::float_cmp)]
            if previous.end == segment.start && same_override(&previous.o, &o) {
                previous.end = segment.end;
                continue;
            }
        }
        runs.push(Run {
            start: segment.start,
            end: segment.end,
            o,
        });
        last = true;
    }
    runs.into_iter()
        .map(|run| {
            let mut out = Object::with_capacity(5);
            out.insert("start", Value::Number(run.start));
            out.insert("end", Value::Number(run.end));
            out.insert("style", run.o.style);
            if let Some(fills) = run.o.fills {
                out.insert("fills", fills);
            }
            if let Some(id) = run.o.text_style_id {
                out.insert("textStyleId", id);
            }
            Value::object(out)
        })
        .collect()
}

fn replace_segments(
    segments: &[Segment],
    start: f64,
    end: f64,
    length: f64,
    o: Option<RunOverride>,
) -> Vec<Segment> {
    let delta = length - (end - start);
    let mut out = Vec::with_capacity(segments.len() + 2);
    for segment in segments {
        if segment.start < start {
            out.push(Segment {
                start: segment.start,
                end: segment.end.min(start),
                o: segment.o.clone(),
            });
        }
    }
    if length > 0.0 {
        out.push(Segment {
            start,
            end: start + length,
            o,
        });
    }
    for segment in segments {
        if segment.end > end {
            out.push(Segment {
                start: segment.start.max(end) + delta,
                end: segment.end + delta,
                o: segment.o.clone(),
            });
        }
    }
    out
}

fn override_at(segments: &[Segment], offset: f64) -> Option<&RunOverride> {
    segments
        .iter()
        .find(|segment| segment.start <= offset && offset < segment.end)
        .and_then(|segment| segment.o.as_ref())
}

fn clamp_range(length: f64, start: f64, end: f64) -> (f64, f64) {
    let a = length.min(start).max(0.0);
    let b = length.min(end).max(0.0);
    if a <= b { (a, b) } else { (b, a) }
}

const NEWLINE: u16 = b'\n' as u16;

/// `styleSource`: the character whose style typed text takes, -1 for the base style.
fn style_source(chars: &[u16], start: f64, end: f64) -> f64 {
    if end > start {
        return start;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    if start > 0.0 && chars.get((start - 1.0) as usize) != Some(&NEWLINE) {
        return start - 1.0;
    }
    #[allow(clippy::cast_precision_loss)]
    if start < chars.len() as f64 {
        return start;
    }
    start - 1.0
}

fn caret_override(
    chars: &[u16],
    segments: &[Segment],
    start: f64,
    end: f64,
) -> Option<RunOverride> {
    let source = style_source(chars, start, end);
    if source < 0.0 {
        return None;
    }
    let o = override_at(segments, source)?;
    // Typing right after a link does not extend it.
    if let Some(link) = o.style.get("hyperlink").filter(|link| link.truthy())
        && source < start
    {
        #[allow(clippy::cast_precision_loss)]
        let after = if start < chars.len() as f64 {
            override_at(segments, start)
        } else {
            None
        };
        if !after.is_some_and(|after| {
            after
                .style
                .get("hyperlink")
                .is_some_and(|other| other.same(link))
        }) {
            let mut style = o.style.as_object().cloned().unwrap_or_default();
            style.insert("hyperlink", Value::Null);
            return Some(RunOverride {
                style: Value::object(style),
                ..o.clone()
            });
        }
    }
    Some(o.clone())
}

fn characters_of(text: &Value) -> Vec<u16> {
    utf16(text.get("characters").and_then(Value::as_str).unwrap_or(""))
}

/// `caretStyleAt(text, start, end)`: the style typed text gets at the caret or over [start, end) (None: the base).
#[allow(clippy::cast_precision_loss)]
pub fn caret_style_at(text: &Value, start: f64, end: f64) -> Option<RunOverride> {
    let chars = characters_of(text);
    let length = chars.len() as f64;
    let (a, b) = clamp_range(length, start, end);
    caret_override(&chars, &to_segments(text, length), a, b)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn index(value: f64) -> usize {
    value as usize
}

fn count_newlines(text: &[u16], from: usize, to: usize) -> usize {
    text.iter()
        .enumerate()
        .skip(from)
        .take_while(|(at, _)| *at < to)
        .filter(|(_, unit)| **unit == NEWLINE)
        .count()
}

/// `insertText(text, start, end, inserted, caretStyle)`: [start, end) replaced with `inserted`. `caret`: `Some(style)`
/// when the caller passes a caret style (`Some(None)`: the base style), `None` to take the one `caretStyleAt` names.
#[allow(clippy::cast_precision_loss)]
pub fn insert_text(
    text: &Value,
    start: f64,
    end: f64,
    inserted: &[u16],
    caret: Option<Option<RunOverride>>,
) -> Value {
    let chars = characters_of(text);
    let length = chars.len() as f64;
    let (a, b) = clamp_range(length, start, end);
    let segments = to_segments(text, length);
    let o = match caret {
        Some(style) => style,
        None => caret_override(&chars, &segments, a, b),
    };
    let (ai, bi) = (index(a), index(b));
    let mut characters = Vec::with_capacity(chars.len() + inserted.len());
    characters.extend_from_slice(&chars[..ai]);
    characters.extend_from_slice(inserted);
    characters.extend_from_slice(&chars[bi.max(ai)..]);
    let base = text.get("style").cloned().unwrap_or(Value::Null);
    let runs = to_runs(
        &replace_segments(&segments, a, b, inserted.len() as f64, o),
        &base,
    );
    let mut next = text.as_object().cloned().unwrap_or_default();
    next.insert("characters", Value::String(from_utf16(&characters).into()));
    next.insert("runs", Value::array(runs));
    let Some(list_types) = text.get("listTypes").filter(|types| types.truthy()) else {
        return Value::object(next);
    };
    let old = list_types.as_array().unwrap_or(&[]);
    let paragraphs = count_newlines(&chars, 0, chars.len()) + 1;
    let none = Value::str("NONE");
    let mut types: Vec<Value> = (0..paragraphs)
        .map(|at| {
            old.get(at)
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| none.clone())
        })
        .collect();
    let at = count_newlines(&chars, 0, ai);
    let removed = count_newlines(&chars, ai, bi);
    let fill = types.get(at).cloned();
    let added = count_newlines(inserted, 0, inserted.len());
    let from = (at + 1).min(types.len());
    let to = (from + removed).min(types.len());
    // `Array(n).fill(undefined)` would hold undefined; `types[at]` always exists here (at < paragraphs).
    let fill = fill.unwrap_or(Value::Null);
    types.splice(from..to, std::iter::repeat_n(fill, added));
    // withListTypes: trailing 'NONE's dropped, the field omitted when empty (it goes last, as the spread puts it).
    let mut keep = types.len();
    while keep > 0 && types[keep - 1].as_str() == Some("NONE") {
        keep -= 1;
    }
    next.remove("listTypes");
    if keep > 0 {
        types.truncate(keep);
        next.insert("listTypes", Value::array(types));
    }
    Value::object(next)
}
