//! The text model this crate lays out, mirroring `TextProps`/`TextStyle` of `shared/design/types.ts`, and
//! the layout it produces, mirroring `TextLayout`/`TextLine`/`GlyphRun` of `shared/design/text-layout.ts`.
//! Field names serialize in camelCase so the JSON crosses to TypeScript unchanged. Unknown style fields
//! (`hyperlink`, decoration…) stay on the TypeScript side, which rebuilds every run's style from its slot.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FontSpec {
    pub family: String,
    pub weight: f64,
    pub italic: bool,
    pub size: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "unit")]
pub enum LineHeight {
    #[serde(rename = "AUTO")]
    Auto,
    #[serde(rename = "PIXELS")]
    Pixels { value: f64 },
    #[serde(rename = "PERCENT")]
    Percent { value: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "unit")]
pub enum LetterSpacing {
    #[serde(rename = "PIXELS")]
    Pixels { value: f64 },
    #[serde(rename = "PERCENT")]
    Percent { value: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TextCase {
    #[default]
    #[serde(rename = "ORIGINAL")]
    Original,
    #[serde(rename = "UPPER")]
    Upper,
    #[serde(rename = "LOWER")]
    Lower,
    #[serde(rename = "TITLE")]
    Title,
    #[serde(rename = "SMALL_CAPS")]
    SmallCaps,
}

/// A full style, the fields layout measures by. The TypeScript side keeps the whole object (decoration,
/// hyperlink…) and rebuilds every run's style itself from the slot table, so nothing else crosses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub font_family: String,
    pub font_weight: f64,
    pub italic: bool,
    pub font_size: f64,
    pub line_height: LineHeight,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<LetterSpacing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_case: Option<TextCase>,
}

/// A run's overrides: every field optional. `null` values are kept (they override), as `resolveStyle` keeps
/// everything but `undefined`, which JSON never carries.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialStyle {
    pub font_family: Option<String>,
    pub font_weight: Option<f64>,
    pub italic: Option<bool>,
    pub font_size: Option<f64>,
    pub line_height: Option<LineHeight>,
    pub letter_spacing: Option<LetterSpacing>,
    pub text_case: Option<TextCase>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TextRun {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub style: Option<PartialStyle>,
    /// The run has fills of its own (the TypeScript side keeps the arrays; Rust only needs the fact).
    #[serde(default)]
    pub has_fills: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum HorizontalAlign {
    #[default]
    #[serde(rename = "LEFT")]
    Left,
    #[serde(rename = "CENTER")]
    Center,
    #[serde(rename = "RIGHT")]
    Right,
    #[serde(rename = "JUSTIFIED")]
    Justified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum VerticalAlign {
    #[default]
    #[serde(rename = "TOP")]
    Top,
    #[serde(rename = "CENTER")]
    Center,
    #[serde(rename = "BOTTOM")]
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum AutoResize {
    #[default]
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "WIDTH_AND_HEIGHT")]
    WidthAndHeight,
    #[serde(rename = "HEIGHT")]
    Height,
    #[serde(rename = "TRUNCATE")]
    Truncate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ListType {
    #[default]
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "ORDERED")]
    Ordered,
    #[serde(rename = "UNORDERED")]
    Unordered,
}

/// `TextProps` without `characters`, which crosses as UTF-16 code units beside it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextProps {
    pub style: TextStyle,
    #[serde(default)]
    pub runs: Vec<TextRun>,
    #[serde(default)]
    pub text_align_horizontal: HorizontalAlign,
    #[serde(default)]
    pub text_align_vertical: VerticalAlign,
    #[serde(default)]
    pub text_auto_resize: AutoResize,
    #[serde(default)]
    pub paragraph_spacing: Option<f64>,
    #[serde(default)]
    pub paragraph_indent: Option<f64>,
    #[serde(default)]
    pub list_types: Option<Vec<ListType>>,
    #[serde(default)]
    pub max_lines: Option<f64>,
}

/// One `layoutText` call: `width` null = unconstrained; `height` the box height for NONE/TRUNCATE (0 otherwise).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRequest {
    pub text: TextProps,
    pub width: Option<f64>,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub on_path: bool,
}

// ── Output ─────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphRun {
    /// What is drawn, as code units: a lone surrogate in `characters` stays itself, as in JavaScript.
    pub text: Vec<u16>,
    pub start: usize,
    pub end: usize,
    pub x: f64,
    pub width: f64,
    pub style: TextStyle,
    pub font: FontSpec,
    pub letter_spacing: f64,
    pub offsets: Vec<usize>,
    pub xs: Vec<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ellipsis: bool,
    /// Index of the resolved style the run draws in (0 = the base style): the TypeScript side maps it to the
    /// run's own `fills` array, so paint identity survives the boundary.
    pub slot: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMarker {
    pub text: String,
    pub x: f64,
    pub width: f64,
    pub style: TextStyle,
    pub font: FontSpec,
    pub slot: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub runs: Vec<GlyphRun>,
    pub start: usize,
    pub end: usize,
    pub x: f64,
    pub top: f64,
    pub baseline: f64,
    pub width: f64,
    pub height: f64,
    pub paragraph_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<ListMarker>,
    pub ascent: f64,
    pub descent: f64,
    pub wrapped: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayout {
    pub width: f64,
    pub height: f64,
    pub lines: Vec<TextLine>,
    pub truncated: bool,
    pub natural_width: f64,
    pub length: usize,
    /// For every slot, the index of the run it came from (-1 for the base style).
    pub slot_runs: Vec<i64>,
    /// The resolved style of every slot (the encoder tells SMALL_CAPS runs apart by it).
    #[serde(skip)]
    pub slot_styles: Vec<TextStyle>,
}
