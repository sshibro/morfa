//! What a stored document may contain: the bounds of `shared/design/schema.ts` (number ranges, string lengths in
//! UTF-16 code units, id characters, list and map sizes, URLs) over the typed model, then the structural
//! invariants (`invariants.rs`). Together with the strict deserialization (`de.rs`) a document is accepted exactly
//! when `validateDocument` accepts it; `validate_patch` mirrors `validatePatch`.
//!
//! A refusal names its `path` the way zod does (`nodes.<id>.fills.0.color.r`) and carries the schema's Russian
//! message.

use crate::limits::{caps, field as L};
use crate::patch::DocumentPatch;
use crate::types::*;
use std::borrow::Cow;
use std::fmt;

/// Why a document or patch is refused: the message shown to the user and the path of the offending value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub message: String,
    pub path: String,
}

impl Invalid {
    pub fn new(message: impl Into<String>, path: impl Into<String>) -> Self {
        Invalid {
            message: message.into(),
            path: path.into(),
        }
    }
}

impl fmt::Display for Invalid {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        if self.path.is_empty() {
            formatter.write_str(&self.message)
        } else {
            write!(formatter, "{} ({})", self.message, self.path)
        }
    }
}

impl std::error::Error for Invalid {}

// ── Issues and paths ─────────────────────────────────────────────────────────────────────────────

/// A refusal on its way out: the path is collected innermost first, only on failure.
#[derive(Debug)]
pub(crate) struct Issue {
    message: Cow<'static, str>,
    path: Vec<Segment>,
}

#[derive(Debug)]
enum Segment {
    Key(String),
    Index(usize),
}

impl From<&str> for Segment {
    fn from(key: &str) -> Self {
        Segment::Key(key.to_owned())
    }
}

impl From<usize> for Segment {
    fn from(index: usize) -> Self {
        Segment::Index(index)
    }
}

impl Issue {
    fn new(message: impl Into<Cow<'static, str>>) -> Self {
        Issue {
            message: message.into(),
            path: Vec::new(),
        }
    }

    fn into_invalid(self) -> Invalid {
        let mut path = String::new();
        for segment in self.path.iter().rev() {
            if !path.is_empty() {
                path.push('.');
            }
            match segment {
                Segment::Key(key) => path.push_str(key),
                Segment::Index(index) => path.push_str(&index.to_string()),
            }
        }
        Invalid {
            message: self.message.into_owned(),
            path,
        }
    }
}

pub(crate) type Check = Result<(), Issue>;

trait At {
    /// Prefixes the path of a refusal with one segment.
    fn at<S: Into<Segment>>(self, segment: S) -> Self;
}

impl At for Check {
    fn at<S: Into<Segment>>(self, segment: S) -> Self {
        self.map_err(|mut issue| {
            issue.path.push(segment.into());
            issue
        })
    }
}

fn fail(message: &'static str) -> Check {
    Err(Issue::new(message))
}

const TOO_BIG: &str = "The value is too large.";
const TOO_SMALL: &str = "The value is too small.";
const WRONG_TYPE: &str = "Wrong value type.";
const NOT_FINITE: &str = "The number must be finite.";
const TOO_LONG: &str = "The text is too long.";
const EMPTY: &str = "Empty value.";
const BAD_CHARACTERS: &str = "Invalid characters.";
const TOO_MANY: &str = "Too many items.";
const TOO_FEW: &str = "Too few items.";
const BAD_VALUE: &str = "Invalid value.";
const BAD_ID: &str = "Invalid identifier.";
const BAD_KEY: &str = "Invalid key.";
const BAD_URL: &str = "The link must start with http://, https:// or mailto:.";
const BAD_IMAGE_URL: &str = "The image must be uploaded to this account.";

// ── Numbers ──────────────────────────────────────────────────────────────────────────────────────

/// `z.number().finite().min(min).max(max)`.
fn range(value: f64, min: f64, max: f64) -> Check {
    if !value.is_finite() {
        fail(NOT_FINITE)
    } else if value < min {
        fail(TOO_SMALL)
    } else if value > max {
        fail(TOO_BIG)
    } else {
        Ok(())
    }
}

/// Coordinates and offsets: |x| ≤ 1e9.
fn num(value: f64) -> Check {
    range(value, -L::COORDINATE, L::COORDINATE)
}

/// Sizes and radii: 0..1e9.
fn size(value: f64) -> Check {
    range(value, 0.0, L::COORDINATE)
}

fn unit(value: f64) -> Check {
    range(value, 0.0, 1.0)
}

fn signed_unit(value: f64) -> Check {
    range(value, -1.0, 1.0)
}

/// `z.number().int().min(min).max(max)` (JavaScript's `Number.isInteger`).
fn int(value: f64, min: f64, max: f64) -> Check {
    if !value.is_finite() || value.fract() != 0.0 {
        return fail(WRONG_TYPE);
    }
    range(value, min, max)
}

/// `z.number().finite().positive().max(max)`.
fn positive(value: f64, max: f64) -> Check {
    if value.is_finite() && value <= 0.0 {
        return fail(TOO_SMALL);
    }
    range(value, f64::MIN, max)
}

fn finite(value: f64) -> Check {
    if value.is_finite() {
        Ok(())
    } else {
        fail(NOT_FINITE)
    }
}

// ── Strings ──────────────────────────────────────────────────────────────────────────────────────

/// JavaScript's `string.length`: UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    if value.is_ascii() {
        value.len()
    } else {
        value.chars().map(char::len_utf16).sum()
    }
}

/// `z.string().min(min).max(max)`. UTF-8 bytes never undercount UTF-16 units, so short strings skip the count.
fn string(value: &str, min: usize, max: usize) -> Check {
    if value.len() <= max && value.len() >= min {
        return Ok(());
    }
    let length = utf16_len(value);
    if length < min {
        fail(EMPTY)
    } else if length > max {
        fail(TOO_LONG)
    } else {
        Ok(())
    }
}

/// `text(max)`: `z.string().max(max)`.
fn text(value: &str, max: usize) -> Check {
    string(value, 0, max)
}

/// `/^[A-Za-z0-9_:;.,-]+$/`.
fn id_characters(value: &str) -> bool {
    value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b';' | b'.' | b',' | b'-')
    })
}

/// `id`: a node, style, variable, collection, mode or image id.
pub(crate) fn id(value: &str) -> Check {
    string(value, 1, L::ID)?;
    if !id_characters(value) {
        return fail(BAD_CHARACTERS);
    }
    if value == "__proto__" {
        return fail(BAD_ID);
    }
    Ok(())
}

/// `key(max)`: a key of a stored map (`__proto__` would replace an object's prototype when assigned).
fn key(value: &str, max: usize) -> Check {
    string(value, 1, max)?;
    if value == "__proto__" {
        return fail(BAD_KEY);
    }
    Ok(())
}

fn short_key(value: &str) -> Check {
    key(value, L::SHORT_TEXT)
}

/// `DESIGN_IMAGE_URL`: `/^\/uploads\/(?!\.\.?$)[A-Za-z0-9._-]{1,200}$/`.
pub fn is_design_image_url(value: &str) -> bool {
    let Some(file) = value.strip_prefix("/uploads/") else {
        return false;
    };
    file != "."
        && file != ".."
        && (1..=200).contains(&file.len())
        && file
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `isSafeDesignUrl`: http(s) and mailto only, by the WHATWG URL parser (`new URL(value).protocol`).
pub fn is_safe_design_url(value: &str) -> bool {
    if utf16_len(value) > L::URL {
        return false;
    }
    match url::Url::parse(value) {
        Ok(parsed) => matches!(parsed.scheme(), "http" | "https" | "mailto"),
        Err(_) => false,
    }
}

fn safe_url(value: &str) -> Check {
    text(value, L::URL)?;
    if is_safe_design_url(value) {
        Ok(())
    } else {
        fail(BAD_URL)
    }
}

/// `remote.libraryId`: `/^[0-9a-f-]{36}$/`.
fn library_id(value: &str) -> Check {
    if value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f' | b'-'))
    {
        Ok(())
    } else {
        fail(BAD_CHARACTERS)
    }
}

// ── Lists and maps ───────────────────────────────────────────────────────────────────────────────

fn list<T>(items: &[T], max: usize, each: impl Fn(&T) -> Check) -> Check {
    list_between(items, 0, max, each)
}

fn list_between<T>(items: &[T], min: usize, max: usize, each: impl Fn(&T) -> Check) -> Check {
    if items.len() > max {
        return fail(TOO_MANY);
    }
    if items.len() < min {
        return fail(TOO_FEW);
    }
    for (index, item) in items.iter().enumerate() {
        each(item).at(index)?;
    }
    Ok(())
}

/// `record(value, max, keySchema)`: every key and value, then the entry count.
fn record<T>(
    map: &Map<T>,
    max: usize,
    key_check: impl Fn(&str) -> Check,
    each: impl Fn(&T) -> Check,
) -> Check {
    for (name, value) in map {
        key_check(name).at(name.as_str())?;
        each(value).at(name.as_str())?;
    }
    if map.len() > max {
        return Err(Issue::new(format!("No more than {max} entries.")));
    }
    Ok(())
}

fn optional<T>(value: &Option<T>, check: impl FnOnce(&T) -> Check) -> Check {
    match value {
        Some(value) => check(value),
        None => Ok(()),
    }
}

fn nullable<T>(value: &Option<Option<T>>, check: impl FnOnce(&T) -> Check) -> Check {
    match value {
        Some(Some(value)) => check(value),
        _ => Ok(()),
    }
}

// ── Basics ───────────────────────────────────────────────────────────────────────────────────────

fn rgb(color: &Rgb) -> Check {
    unit(color.r).at("r")?;
    unit(color.g).at("g")?;
    unit(color.b).at("b")
}

pub(crate) fn rgba(color: &Rgba) -> Check {
    unit(color.r).at("r")?;
    unit(color.g).at("g")?;
    unit(color.b).at("b")?;
    unit(color.a).at("a")
}

pub(crate) fn vec2(point: &Vec2) -> Check {
    num(point.x).at("x")?;
    num(point.y).at("y")
}

fn matrix(value: &Matrix) -> Check {
    for (row, values) in value.iter().enumerate() {
        for (column, value) in values.iter().enumerate() {
            num(*value).at(column).at(row)?;
        }
    }
    Ok(())
}

pub(crate) fn alias(alias: &VariableAlias) -> Check {
    id(&alias.id).at("id")
}

fn remote(remote: &RemoteAsset) -> Check {
    library_id(&remote.library_id).at("libraryId")?;
    id(&remote.key).at("key")?;
    int(remote.version, 1.0, 1_000_000_000.0).at("version")
}

/// `text(L.description)`: also the string option of `variableValue`.
pub(crate) fn description_text(value: &str) -> Check {
    text(value, L::DESCRIPTION)
}

// ── Paints and effects ───────────────────────────────────────────────────────────────────────────

fn paint_base(opacity: f64) -> Check {
    unit(opacity).at("opacity")
}

fn paint(paint: &Paint) -> Check {
    match paint {
        Paint::Solid(solid) => {
            paint_base(solid.opacity)?;
            rgb(&solid.color).at("color")?;
            optional(&solid.bound_variables, |bound| {
                optional(&bound.color, alias).at("color")
            })
            .at("boundVariables")
        }
        Paint::GradientLinear(gradient)
        | Paint::GradientRadial(gradient)
        | Paint::GradientAngular(gradient)
        | Paint::GradientDiamond(gradient) => {
            paint_base(gradient.opacity)?;
            list_between(&gradient.gradient_stops, 1, L::GRADIENT_STOPS, |stop| {
                unit(stop.position).at("position")?;
                rgba(&stop.color).at("color")
            })
            .at("gradientStops")?;
            for (index, handle) in gradient.gradient_handle_positions.iter().enumerate() {
                vec2(handle).at(index).at("gradientHandlePositions")?;
            }
            Ok(())
        }
        Paint::Image(image) => {
            paint_base(image.opacity)?;
            if !image.image_ref.is_empty() {
                id(&image.image_ref)
                    .map_err(|_| Issue::new(BAD_VALUE))
                    .at("imageRef")?;
            }
            optional(&image.image_transform, matrix).at("imageTransform")?;
            optional(&image.scaling_factor, |factor| positive(*factor, 10_000.0))
                .at("scalingFactor")?;
            optional(&image.rotation, |rotation| {
                if [0.0, 90.0, 180.0, 270.0].contains(rotation) {
                    Ok(())
                } else {
                    fail(BAD_VALUE)
                }
            })
            .at("rotation")?;
            optional(&image.filters, |filters| {
                for (name, value) in [
                    ("exposure", filters.exposure),
                    ("contrast", filters.contrast),
                    ("saturation", filters.saturation),
                    ("temperature", filters.temperature),
                    ("tint", filters.tint),
                    ("highlights", filters.highlights),
                    ("shadows", filters.shadows),
                ] {
                    optional(&value, |value| signed_unit(*value)).at(name)?;
                }
                Ok(())
            })
            .at("filters")
        }
    }
}

fn paints(list_of: &[Paint]) -> Check {
    list(list_of, L::PAINTS, paint)
}

fn effect(effect: &Effect) -> Check {
    match effect {
        Effect::DropShadow(shadow) | Effect::InnerShadow(shadow) => {
            rgba(&shadow.color).at("color")?;
            vec2(&shadow.offset).at("offset")?;
            size(shadow.radius).at("radius")?;
            num(shadow.spread).at("spread")
        }
        Effect::LayerBlur(blur) | Effect::BackgroundBlur(blur) => size(blur.radius).at("radius"),
    }
}

fn effects(list_of: &[Effect]) -> Check {
    list(list_of, L::EFFECTS, effect)
}

// ── Layout ───────────────────────────────────────────────────────────────────────────────────────

fn auto_layout(layout: &AutoLayout) -> Check {
    num(layout.padding_left).at("paddingLeft")?;
    num(layout.padding_right).at("paddingRight")?;
    num(layout.padding_top).at("paddingTop")?;
    num(layout.padding_bottom).at("paddingBottom")?;
    num(layout.item_spacing).at("itemSpacing")?;
    num(layout.counter_axis_spacing).at("counterAxisSpacing")
}

fn grid_track_size(track: &GridTrackSize) -> Check {
    optional(&track.value, |value| size(*value)).at("value")
}

fn grid_layout(grid: &GridLayout) -> Check {
    let tracks = L::GRID_TRACKS as f64;
    int(grid.row_count, 1.0, tracks).at("rowCount")?;
    int(grid.column_count, 1.0, tracks).at("columnCount")?;
    size(grid.row_gap).at("rowGap")?;
    size(grid.column_gap).at("columnGap")?;
    list(&grid.row_sizes, L::GRID_TRACKS, grid_track_size).at("rowSizes")?;
    list(&grid.column_sizes, L::GRID_TRACKS, grid_track_size).at("columnSizes")
}

fn grid_child(child: &GridChild) -> Check {
    let tracks = L::GRID_TRACKS as f64;
    optional(&child.row_anchor_index, |value| {
        int(*value, 0.0, tracks - 1.0)
    })
    .at("rowAnchorIndex")?;
    optional(&child.column_anchor_index, |value| {
        int(*value, 0.0, tracks - 1.0)
    })
    .at("columnAnchorIndex")?;
    optional(&child.row_span, |value| int(*value, 1.0, tracks)).at("rowSpan")?;
    optional(&child.column_span, |value| int(*value, 1.0, tracks)).at("columnSpan")
}

fn layout_grid(grid: &LayoutGrid) -> Check {
    match grid {
        LayoutGrid::Grid(grid) => {
            size(grid.section_size).at("sectionSize")?;
            rgba(&grid.color).at("color")
        }
        LayoutGrid::Columns(band) | LayoutGrid::Rows(band) => {
            int(band.count, 0.0, 10_000.0).at("count")?;
            num(band.gutter_size).at("gutterSize")?;
            num(band.offset).at("offset")?;
            size(band.section_size).at("sectionSize")?;
            rgba(&band.color).at("color")
        }
    }
}

fn layout_grids(grids: &[LayoutGrid]) -> Check {
    list(grids, L::LAYOUT_GRIDS, layout_grid)
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

fn line_height(value: &LineHeight) -> Check {
    match value {
        LineHeight::Auto => Ok(()),
        LineHeight::Pixels(height) | LineHeight::Percent(height) => size(height.value).at("value"),
    }
}

fn hyperlink(link: &Hyperlink) -> Check {
    match link {
        Hyperlink::Url(link) => safe_url(&link.url).at("url"),
        Hyperlink::Node(link) => id(&link.node_id).at("nodeId"),
    }
}

fn font_family(value: &str) -> Check {
    string(value, 1, L::FONT_FAMILY)
}

fn font_weight(value: f64) -> Check {
    range(value, 1.0, 1000.0)
}

fn font_size(value: f64) -> Check {
    range(value, 0.0, 100_000.0)
}

fn text_style(style: &TextStyle) -> Check {
    font_family(&style.font_family).at("fontFamily")?;
    font_weight(style.font_weight).at("fontWeight")?;
    font_size(style.font_size).at("fontSize")?;
    line_height(&style.line_height).at("lineHeight")?;
    num(style.letter_spacing.value)
        .at("value")
        .at("letterSpacing")?;
    nullable(&style.hyperlink, hyperlink).at("hyperlink")
}

fn text_style_override(style: &TextStyleOverride) -> Check {
    optional(&style.font_family, |family| font_family(family)).at("fontFamily")?;
    optional(&style.font_weight, |weight| font_weight(*weight)).at("fontWeight")?;
    optional(&style.font_size, |size| font_size(*size)).at("fontSize")?;
    optional(&style.line_height, line_height).at("lineHeight")?;
    optional(&style.letter_spacing, |spacing| {
        num(spacing.value).at("value")
    })
    .at("letterSpacing")?;
    nullable(&style.hyperlink, hyperlink).at("hyperlink")
}

fn text_props(props: &TextProps) -> Check {
    text(&props.characters, L::CHARACTERS).at("characters")?;
    text_style(&props.style).at("style")?;
    list(&props.runs, L::TEXT_RUNS, |run| {
        int(run.start, 0.0, L::CHARACTERS as f64).at("start")?;
        int(run.end, 0.0, L::CHARACTERS as f64).at("end")?;
        text_style_override(&run.style).at("style")?;
        optional(&run.fills, |fills| paints(fills)).at("fills")?;
        optional(&run.text_style_id, |style| id(style)).at("textStyleId")
    })
    .at("runs")?;
    num(props.paragraph_spacing).at("paragraphSpacing")?;
    num(props.paragraph_indent).at("paragraphIndent")?;
    optional(&props.list_types, |types| {
        list(types, L::LIST_TYPES, |_| Ok(()))
    })
    .at("listTypes")?;
    nullable(&props.max_lines, |lines| int(*lines, 1.0, 100_000.0)).at("maxLines")
}

fn path_command(command: &PathCommand) -> Check {
    match command {
        PathCommand::M(point) | PathCommand::L(point) => vec2(point),
        PathCommand::C(cubic) => {
            num(cubic.x1).at("x1")?;
            num(cubic.y1).at("y1")?;
            num(cubic.x2).at("x2")?;
            num(cubic.y2).at("y2")?;
            num(cubic.x).at("x")?;
            num(cubic.y).at("y")
        }
        PathCommand::Q(quad) => {
            num(quad.x1).at("x1")?;
            num(quad.y1).at("y1")?;
            num(quad.x).at("x")?;
            num(quad.y).at("y")
        }
        PathCommand::Z => Ok(()),
    }
}

fn text_path(path: &TextPathData) -> Check {
    list_between(&path.commands, 2, L::PATH_COMMANDS, path_command).at("commands")?;
    unit(path.start_offset).at("startOffset")
}

// ── Prototyping and export ───────────────────────────────────────────────────────────────────────

fn duration(value: f64) -> Check {
    range(value, 0.0, 1_000_000.0)
}

fn trigger(trigger: &Trigger) -> Check {
    match trigger {
        Trigger::AfterTimeout(timeout) => duration(timeout.timeout).at("timeout"),
        Trigger::OnKeyDown(key) => string(&key.key_code, 1, 64).at("keyCode"),
        _ => Ok(()),
    }
}

fn transition(transition: &Transition) -> Check {
    match transition {
        Transition::Instant => Ok(()),
        Transition::Dissolve(timed) | Transition::SmartAnimate(timed) => {
            duration(timed.duration).at("duration")
        }
        Transition::MoveIn(moving)
        | Transition::MoveOut(moving)
        | Transition::Push(moving)
        | Transition::SlideIn(moving)
        | Transition::SlideOut(moving) => duration(moving.duration).at("duration"),
    }
}

fn action(action: &Action) -> Check {
    match action {
        Action::Node(node) => {
            id(&node.destination_id).at("destinationId")?;
            transition(&node.transition).at("transition")?;
            optional(&node.overlay_relative_position, vec2).at("overlayRelativePosition")
        }
        Action::Back | Action::Close => Ok(()),
        Action::Url(link) => safe_url(&link.url).at("url"),
    }
}

fn reaction(reaction: &Reaction) -> Check {
    self::trigger(&reaction.trigger).at("trigger")?;
    list(&reaction.actions, L::ACTIONS, action).at("actions")
}

fn export_setting(setting: &ExportSetting) -> Check {
    text(&setting.suffix, L::SHORT_TEXT).at("suffix")?;
    positive(setting.constraint.value, 100_000.0)
        .at("value")
        .at("constraint")
}

// ── Components, annotations, board ───────────────────────────────────────────────────────────────

fn property_value(value: &PropertyValue) -> Check {
    match value {
        PropertyValue::Text(value) => description_text(value),
        PropertyValue::Boolean(_) => Ok(()),
    }
}

fn property_definition(definition: &ComponentPropertyDefinition) -> Check {
    property_value(&definition.default_value).at("defaultValue")?;
    optional(&definition.variant_options, |options| {
        list(options, L::VARIANT_OPTIONS, |option| {
            text(option, L::SHORT_TEXT)
        })
    })
    .at("variantOptions")?;
    optional(&definition.preferred_values, |values| {
        list(values, L::VARIANT_OPTIONS, |value| id(value))
    })
    .at("preferredValues")
}

fn annotation(annotation: &Annotation) -> Check {
    id(&annotation.id).at("id")?;
    text(&annotation.label, L::DESCRIPTION).at("label")?;
    optional(&annotation.category_id, |category| id(category)).at("categoryId")?;
    optional(&annotation.properties, |properties| {
        list(properties, L::ANNOTATION_PROPERTIES, |_| Ok(()))
    })
    .at("properties")
}

fn measurement(measurement: &Measurement) -> Check {
    id(&measurement.id).at("id")?;
    id(&measurement.start.node_id).at("nodeId").at("start")?;
    id(&measurement.end.node_id).at("nodeId").at("end")?;
    match &measurement.offset {
        MeasurementOffset::Inner(inner) => unit(inner.relative).at("relative"),
        MeasurementOffset::Outer(outer) => num(outer.fixed).at("fixed"),
    }
    .at("offset")?;
    optional(&measurement.free_text, |free| text(free, L::SHORT_TEXT)).at("freeText")
}

pub(crate) fn connector_object_end(end: &ConnectorObjectEnd) -> Check {
    id(&end.node).at("node")
}

pub(crate) fn connector_at_end(end: &ConnectorAtEnd) -> Check {
    id(&end.node).at("node")?;
    unit(end.at.x).at("x").at("at")?;
    unit(end.at.y).at("y").at("at")
}

fn connector_end(end: &ConnectorEnd) -> Check {
    match end {
        ConnectorEnd::Object(end) => connector_object_end(end),
        ConnectorEnd::At(end) => connector_at_end(end),
        ConnectorEnd::Point(point) => vec2(point),
    }
}

fn board_meta(meta: &BoardMeta) -> Check {
    match meta {
        BoardMeta::Connector(connector) => {
            connector_end(&connector.start).at("start")?;
            connector_end(&connector.end).at("end")?;
            optional(&connector.label_at, |at| unit(*at)).at("labelAt")?;
            optional(&connector.points, |points| {
                list(points, L::CONNECTOR_POINTS, vec2)
            })
            .at("points")
        }
        BoardMeta::Part(part) => {
            let span = |value: &f64| int(*value, 1.0, L::TABLE_SPAN as f64);
            optional(&part.col_span, span).at("colSpan")?;
            optional(&part.row_span, span).at("rowSpan")
        }
        BoardMeta::Stamp(stamp) => optional(&stamp.by, |by| text(by, L::NAME)).at("by"),
        BoardMeta::Sticker(sticker) => {
            string(&sticker.sticker, 1, L::SHORT_TEXT)?;
            if sticker
                .sticker
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                Ok(())
            } else {
                fail(BAD_CHARACTERS)
            }
        }
        .at("sticker"),
        _ => Ok(()),
    }
}

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────────

/// `sceneNodeSchema`: one layer's fields and bounds. What each type requires is in `invariants.rs`.
pub(crate) fn scene_node(node: &SceneNode) -> Check {
    id(&node.id).at("id")?;
    text(&node.name, L::NAME).at("name")?;
    optional(&node.parent_id, |parent| id(parent)).at("parentId")?;
    optional(&node.children, |children| {
        list(children, caps::nodes(), |child| id(child))
    })
    .at("children")?;
    unit(node.opacity).at("opacity")?;
    num(node.x).at("x")?;
    num(node.y).at("y")?;
    size(node.width).at("width")?;
    size(node.height).at("height")?;
    num(node.rotation).at("rotation")?;
    paints(&node.fills).at("fills")?;
    paints(&node.strokes).at("strokes")?;
    size(node.stroke_weight).at("strokeWeight")?;
    size(node.stroke_miter_limit).at("strokeMiterLimit")?;
    list(&node.dash_pattern, L::DASH_PATTERN, |dash| size(*dash)).at("dashPattern")?;
    effects(&node.effects).at("effects")?;
    optional(&node.fill_style_id, |style| id(style)).at("fillStyleId")?;
    optional(&node.stroke_style_id, |style| id(style)).at("strokeStyleId")?;
    optional(&node.effect_style_id, |style| id(style)).at("effectStyleId")?;
    optional(&node.bound_variables, |bound| {
        record(bound, L::BOUND_VARIABLES, short_key, alias)
    })
    .at("boundVariables")?;
    nullable(&node.min_width, |value| size(*value)).at("minWidth")?;
    nullable(&node.max_width, |value| size(*value)).at("maxWidth")?;
    nullable(&node.min_height, |value| size(*value)).at("minHeight")?;
    nullable(&node.max_height, |value| size(*value)).at("maxHeight")?;
    list(&node.export_settings, L::EXPORT_SETTINGS, export_setting).at("exportSettings")?;
    list(&node.reactions, L::REACTIONS, reaction).at("reactions")?;

    optional(&node.corner_radius, |radius| size(*radius)).at("cornerRadius")?;
    nullable(&node.rectangle_corner_radii, |radii| {
        for (index, radius) in radii.iter().enumerate() {
            size(*radius).at(index)?;
        }
        Ok(())
    })
    .at("rectangleCornerRadii")?;
    optional(&node.corner_smoothing, |smoothing| unit(*smoothing)).at("cornerSmoothing")?;
    nullable(&node.individual_stroke_weights, |weights| {
        size(weights.top).at("top")?;
        size(weights.right).at("right")?;
        size(weights.bottom).at("bottom")?;
        size(weights.left).at("left")
    })
    .at("individualStrokeWeights")?;
    optional(&node.auto_layout, auto_layout).at("autoLayout")?;
    optional(&node.layout_grids, |grids| layout_grids(grids)).at("layoutGrids")?;
    optional(&node.grid, grid_layout).at("grid")?;
    optional(&node.grid_child, grid_child).at("gridChild")?;
    optional(&node.grid_style_id, |style| id(style)).at("gridStyleId")?;
    optional(&node.overlay_background, |background| match background {
        OverlayBackground::None => Ok(()),
        OverlayBackground::SolidColor(solid) => rgba(&solid.color).at("color"),
    })
    .at("overlayBackground")?;

    optional(&node.background_color, rgb).at("backgroundColor")?;
    optional(&node.guides, |guides| {
        list(guides, L::GUIDES, |guide| num(guide.offset).at("offset"))
    })
    .at("guides")?;
    optional(&node.flow_starting_points, |points| {
        list(points, L::FLOW_STARTING_POINTS, |point| {
            id(&point.node_id).at("nodeId")?;
            text(&point.name, L::NAME).at("name")
        })
    })
    .at("flowStartingPoints")?;
    optional(&node.prototype_device, |device| match device {
        PrototypeDevice::None => Ok(()),
        PrototypeDevice::Preset(preset) => {
            string(&preset.preset_id, 1, L::SHORT_TEXT).at("presetId")?;
            if preset.rotation == 0.0 || preset.rotation == 90.0 {
                Ok(())
            } else {
                fail(BAD_VALUE)
            }
            .at("rotation")
        }
    })
    .at("prototypeDevice")?;
    optional(&node.prototype_background, rgb).at("prototypeBackground")?;

    optional(&node.arc_data, |arc| {
        num(arc.starting_angle).at("startingAngle")?;
        num(arc.ending_angle).at("endingAngle")?;
        unit(arc.inner_radius).at("innerRadius")
    })
    .at("arcData")?;
    optional(&node.point_count, |count| int(*count, 3.0, 1000.0)).at("pointCount")?;
    optional(&node.inner_radius, |radius| unit(*radius)).at("innerRadius")?;
    optional(&node.variable_width_stroke_properties, |stroke| {
        optional(&stroke.variable_width_points, |points| {
            list(points, L::WIDTH_POINTS, |point| {
                unit(point.position).at("position")?;
                range(point.width, 0.0, 100.0).at("width")
            })
        })
        .at("variableWidthPoints")
    })
    .at("variableWidthStrokeProperties")?;
    optional(&node.vector_paths, |paths| {
        list(paths, L::VECTOR_PATHS, |path| {
            list(&path.commands, L::PATH_COMMANDS, path_command).at("commands")
        })
    })
    .at("vectorPaths")?;
    optional(&node.text, text_props).at("text")?;
    optional(&node.text_style_id, |style| id(style)).at("textStyleId")?;
    optional(&node.text_path, text_path).at("textPath")?;
    optional(&node.annotations, |annotations| {
        list(annotations, L::ANNOTATIONS, annotation)
    })
    .at("annotations")?;
    optional(&node.measurements, |measurements| {
        list(measurements, L::MEASUREMENTS, measurement)
    })
    .at("measurements")?;

    optional(&node.description, |description| {
        description_text(description)
    })
    .at("description")?;
    optional(&node.component_property_definitions, |definitions| {
        record(
            definitions,
            L::COMPONENT_PROPERTIES,
            short_key,
            property_definition,
        )
    })
    .at("componentPropertyDefinitions")?;
    optional(&node.component_property_references, |references| {
        optional(&references.visible, |value| text(value, L::SHORT_TEXT)).at("visible")?;
        optional(&references.characters, |value| text(value, L::SHORT_TEXT)).at("characters")?;
        optional(&references.main_component, |value| {
            text(value, L::SHORT_TEXT)
        })
        .at("mainComponent")
    })
    .at("componentPropertyReferences")?;
    optional(&node.component_id, |component| id(component)).at("componentId")?;
    optional(&node.component_properties, |properties| {
        record(
            properties,
            L::COMPONENT_PROPERTIES,
            short_key,
            property_value,
        )
    })
    .at("componentProperties")?;
    optional(&node.main_id, |main| id(main)).at("mainId")?;
    optional(&node.overrides, |overrides| {
        list(overrides, L::OVERRIDES, |field| {
            string(field, 1, L::SHORT_TEXT)
        })
    })
    .at("overrides")?;
    optional(&node.plugin_data, |data| {
        record(data, L::PLUGIN_DATA, short_key, |value| {
            text(value, L::PLUGIN_DATA_VALUE)
        })
    })
    .at("pluginData")?;
    optional(&node.remote, remote).at("remote")?;
    optional(&node.board, board_meta).at("board")
}

// ── Styles, variables, images ────────────────────────────────────────────────────────────────────

fn style(style: &Style) -> Check {
    id(&style.id).at("id")?;
    text(&style.name, L::NAME).at("name")?;
    text(&style.description, L::DESCRIPTION).at("description")?;
    optional(&style.paints, |list_of| paints(list_of)).at("paints")?;
    optional(&style.text, text_style).at("text")?;
    optional(&style.effects, |list_of| effects(list_of)).at("effects")?;
    optional(&style.grids, |grids| layout_grids(grids)).at("grids")?;
    optional(&style.remote, remote).at("remote")
}

fn image_asset(image: &ImageAsset) -> Check {
    if !is_design_image_url(&image.url) {
        return fail(BAD_IMAGE_URL).at("url");
    }
    positive(image.width, 1_000_000.0).at("width")?;
    positive(image.height, 1_000_000.0).at("height")?;
    optional(&image.name, |name| text(name, L::SHORT_TEXT)).at("name")
}

fn variable_collection(collection: &VariableCollection) -> Check {
    id(&collection.id).at("id")?;
    text(&collection.name, L::NAME).at("name")?;
    list_between(&collection.modes, 1, L::MODES, |mode| {
        id(&mode.mode_id).at("modeId")?;
        text(&mode.name, L::NAME).at("name")
    })
    .at("modes")?;
    id(&collection.default_mode_id).at("defaultModeId")?;
    list(&collection.variable_ids, L::VARIABLES, |variable| {
        id(variable)
    })
    .at("variableIds")?;
    optional(&collection.remote, remote).at("remote")
}

fn variable_value(value: &VariableValue) -> Check {
    match value {
        VariableValue::Color(color) => rgba(color),
        VariableValue::Number(number) => finite(*number),
        VariableValue::Text(text) => description_text(text),
        VariableValue::Boolean(_) => Ok(()),
        VariableValue::Alias(value) => alias(value),
    }
}

fn variable(variable: &Variable) -> Check {
    id(&variable.id).at("id")?;
    text(&variable.name, L::NAME).at("name")?;
    id(&variable.collection_id).at("collectionId")?;
    record(&variable.values_by_mode, L::MODES, id, variable_value).at("valuesByMode")?;
    text(&variable.description, L::DESCRIPTION).at("description")?;
    optional(&variable.remote, remote).at("remote")
}

fn mode_choice(choice: &Map<String>) -> Check {
    record(choice, L::VARIABLE_COLLECTIONS, id, |mode| id(mode))
}

fn page_order(pages: &[NodeId]) -> Check {
    list_between(pages, 1, caps::pages(), |page| id(page))
}

/// `designDocumentSchema`: the document's shape and bounds.
fn document_shape(doc: &DesignDocument) -> Check {
    if doc.schema_version != DESIGN_SCHEMA_VERSION {
        return fail(BAD_VALUE).at("schemaVersion");
    }
    page_order(&doc.pages).at("pages")?;
    for (name, node) in &doc.nodes {
        id(name).at(name.as_str()).at("nodes")?;
        scene_node(node).at(name.as_str()).at("nodes")?;
    }
    record(&doc.styles, L::STYLES, id, style).at("styles")?;
    record(&doc.images, L::IMAGES, id, image_asset).at("images")?;
    record(
        &doc.variable_collections,
        L::VARIABLE_COLLECTIONS,
        id,
        variable_collection,
    )
    .at("variableCollections")?;
    record(&doc.variables, L::VARIABLES, id, variable).at("variables")?;
    optional(&doc.variable_modes, |modes| {
        record(modes, caps::nodes(), id, mode_choice)
    })
    .at("variableModes")?;
    optional(
        &doc.board,
        |board| if *board { Ok(()) } else { fail(BAD_VALUE) },
    )
    .at("board")
}

/// `documentPatchSchema`: a patch's entries, each a whole value or `null`.
fn patch_shape(patch: &DocumentPatch) -> Check {
    fn entries<T>(table: &Option<Map<Option<T>>>, max: usize, each: impl Fn(&T) -> Check) -> Check {
        optional(table, |table| {
            record(table, max, id, |entry| optional(entry, &each))
        })
    }
    entries(&patch.nodes, caps::nodes(), scene_node).at("nodes")?;
    optional(&patch.pages, |pages| page_order(pages)).at("pages")?;
    entries(&patch.styles, L::STYLES, style).at("styles")?;
    entries(&patch.images, L::IMAGES, image_asset).at("images")?;
    entries(
        &patch.variable_collections,
        L::VARIABLE_COLLECTIONS,
        variable_collection,
    )
    .at("variableCollections")?;
    entries(&patch.variables, L::VARIABLES, variable).at("variables")?;
    entries(&patch.variable_modes, caps::nodes(), mode_choice).at("variableModes")
}

/// A whole document: shape, bounds, then every structural invariant (`validateDocument` without the strip,
/// which the typed model already did when it was read).
pub fn validate_document(doc: &DesignDocument) -> Result<(), Invalid> {
    document_shape(doc).map_err(Issue::into_invalid)?;
    crate::invariants::check_document(doc)
}

/// The shape and bounds of a patch's entries, no document needed (`validatePatch`).
pub fn validate_patch(patch: &DocumentPatch) -> Result<(), Invalid> {
    patch_shape(patch).map_err(Issue::into_invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_lengths() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("Текст"), 5);
        assert_eq!(utf16_len("😀"), 2);
        assert!(text(&"😀".repeat(100), 200).is_ok());
        assert!(text(&"😀".repeat(101), 200).is_err());
        assert!(text(&"ж".repeat(200), 200).is_ok());
    }

    #[test]
    fn ids_and_keys() {
        assert!(id("n1;c0v0-img").is_ok());
        assert!(id("morfa:library").is_ok());
        assert!(id("").is_err());
        assert!(id("a b").is_err());
        // Cyrillic is refused in ids but fine in keys.
        assert!(id("ж").is_err());
        assert!(id("__proto__").is_err());
        assert!(id(&"a".repeat(512)).is_ok());
        assert!(id(&"a".repeat(513)).is_err());
        assert!(key("Иконка#12", 200).is_ok());
        assert!(key("__proto__", 200).is_err());
    }

    #[test]
    fn urls() {
        assert!(is_safe_design_url("https://example.com/a?b#c"));
        assert!(is_safe_design_url("HTTP://EXAMPLE.COM"));
        assert!(is_safe_design_url("mailto:team@example.com"));
        assert!(is_safe_design_url("  https://example.com  "));
        assert!(!is_safe_design_url("javascript:alert(1)"));
        assert!(!is_safe_design_url("http:"));
        assert!(!is_safe_design_url("/relative"));
        assert!(!is_safe_design_url(&format!(
            "https://example.com/{}",
            "a".repeat(2040)
        )));
        assert!(is_design_image_url("/uploads/img1.png"));
        assert!(!is_design_image_url("/uploads/.."));
        assert!(!is_design_image_url("/uploads/."));
        assert!(is_design_image_url("/uploads/..."));
        assert!(!is_design_image_url("/uploads/a/b.png"));
        assert!(!is_design_image_url(&format!(
            "/uploads/{}",
            "a".repeat(201)
        )));
    }

    #[test]
    fn numbers() {
        assert!(int(3.0, 3.0, 1000.0).is_ok());
        assert!(int(3.5, 3.0, 1000.0).is_err());
        assert!(int(-0.0, 0.0, 10.0).is_ok());
        assert!(positive(0.0, 10.0).is_err());
        assert!(positive(f64::MIN_POSITIVE, 10.0).is_ok());
        assert!(num(1e9).is_ok());
        assert!(num(1e9 + 1.0).is_err());
        assert!(unit(f64::NAN).is_err());
    }
}
