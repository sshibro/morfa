//! A `TextLayout` as one flat `f64` stream for the JavaScript boundary: no JSON, no per-field names.
//! The TypeScript decoder (`decodeLayout` in shared/design/text-layout.ts) rebuilds the objects and
//! takes each run's `style`, `font` and `fills` from the slot table it already has (slot = base style or a
//! run's resolved style; `small` = the SMALL_CAPS reduced face). Strings travel as code units.
//!
//! Stream: `[id, width, height, truncated, naturalWidth, length, slotCount, slotRun…, lineCount, line…]`,
//! a line: `[runCount, start, end, x, top, baseline, width, height, paragraphIndex, ascent, descent,
//! wrapped, hasMarker, (marker: slot, x, width, textLen, text…), run…]`, a run: `[slot, small, ellipsis,
//! start, end, x, width, letterSpacing, stops, textLen, text…, offsets…, xs…]`.

use crate::types::{TextLayout, TextStyle};

fn push_text(out: &mut Vec<f64>, units: &[u16]) {
    out.push(units.len() as f64);
    out.extend(units.iter().map(|&u| u as f64));
}

/// True when `style` is a slot's SMALL_CAPS reduced copy (the run was drawn with it).
fn is_small(run_style: &TextStyle, slot_style: &TextStyle) -> bool {
    run_style.font_size != slot_style.font_size
}

pub fn encode_layout(id: u32, layout: &TextLayout, slot_styles: &[TextStyle]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::with_capacity(64 + layout.length * 3);
    out.push(id as f64);
    out.push(layout.width);
    out.push(layout.height);
    out.push(if layout.truncated { 1.0 } else { 0.0 });
    out.push(layout.natural_width);
    out.push(layout.length as f64);
    out.push(layout.slot_runs.len() as f64);
    out.extend(layout.slot_runs.iter().map(|&r| r as f64));
    out.push(layout.lines.len() as f64);
    for line in &layout.lines {
        out.push(line.runs.len() as f64);
        out.push(line.start as f64);
        out.push(line.end as f64);
        out.push(line.x);
        out.push(line.top);
        out.push(line.baseline);
        out.push(line.width);
        out.push(line.height);
        out.push(line.paragraph_index as f64);
        out.push(line.ascent);
        out.push(line.descent);
        out.push(if line.wrapped { 1.0 } else { 0.0 });
        match &line.marker {
            Some(marker) => {
                out.push(1.0);
                out.push(marker.slot as f64);
                out.push(marker.x);
                out.push(marker.width);
                push_text(&mut out, &marker.text.encode_utf16().collect::<Vec<u16>>());
            }
            None => out.push(0.0),
        }
        for run in &line.runs {
            out.push(run.slot as f64);
            out.push(if is_small(&run.style, &slot_styles[run.slot]) {
                1.0
            } else {
                0.0
            });
            out.push(if run.ellipsis { 1.0 } else { 0.0 });
            out.push(run.start as f64);
            out.push(run.end as f64);
            out.push(run.x);
            out.push(run.width);
            out.push(run.letter_spacing);
            out.push(run.offsets.len() as f64);
            push_text(&mut out, &run.text);
            out.extend(run.offsets.iter().map(|&o| o as f64));
            out.extend(run.xs.iter().copied());
        }
    }
    out
}
