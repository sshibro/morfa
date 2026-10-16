//! The values inside a stored node: paints, effects, text, paths, prototype reactions, component properties, board
//! metadata, and the document's styles, variables and images.
//!
//! These mirror the JSON model's types (`crate::types`) with three differences: repeated strings are [`Atom`]s and
//! node references [`Id`]s of the document's interners; lists are shared [`List`]s; and every type has a plain serde
//! shape (externally tagged enums, no skipped fields), so a non-self-describing binary format can carry it. The JSON
//! model's types without strings, optional fields or tags are reused as they are (`Rgb`, `AutoLayout`, the enums...).
//!
//! Binary compatibility: the codec writes enum variants by position and struct fields in order. Append new variants
//! and fields at the end and bump `codec::FORMAT`; never reorder.

use super::{Atom, Id, List};
use crate::types::{
    AnnotationPropertyType, BandLayoutGrid, BlendMode, BoardPart, BoardShapeKind,
    ComponentPropertyType, ConnectorLine, ConnectorMagnet, CubicTo, Easing, ExportConstraint,
    ExportFormat, GridAutoTracks, GridChildAlign, GridItemsPositioning, GridLayoutGrid,
    GridTrackType, ImageScaleMode, LetterSpacing, ListType, MeasurementSide, Navigation, QuadTo,
    RemoteAsset, Rgb, Rgba, StampId, StrokeTool, StrokeWidthProfile, StyleType,
    TextAlignHorizontal, TextAlignVertical, TextAutoResize, TextCase, TextDecoration, TextPathSide,
    TimedTransition, TransitionDirection, VariableType, VariableWidthPoint, Vec2, WindingRule,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub use crate::types::Matrix;

// ── Grid auto layout (appended for lane N1 step 11; types.rs `GridLayout` / `GridChild` with no skipped fields) ──

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridTrackSize {
    pub kind: GridTrackType,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridLayout {
    pub row_count: f64,
    pub column_count: f64,
    pub row_gap: f64,
    pub column_gap: f64,
    pub row_sizes: List<GridTrackSize>,
    pub column_sizes: List<GridTrackSize>,
    pub auto_tracks: GridAutoTracks,
    pub items_positioning: GridItemsPositioning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridChild {
    pub row_anchor_index: Option<f64>,
    pub column_anchor_index: Option<f64>,
    pub row_span: Option<f64>,
    pub column_span: Option<f64>,
    pub horizontal_align: Option<GridChildAlign>,
    pub vertical_align: Option<GridChildAlign>,
}

// ── Paints and effects ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolidPaint {
    pub color: Rgb,
    pub opacity: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    /// `boundVariables`: absent (`None`), `{}` (`Some(None)`) or `{color}` (`Some(Some(variable))`).
    pub bound_color: Option<Option<Atom>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GradientKind {
    Linear,
    Radial,
    Angular,
    Diamond,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradientPaint {
    pub kind: GradientKind,
    pub opacity: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    pub stops: List<crate::types::ColorStop>,
    pub handles: [Vec2; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ImageFilters {
    pub exposure: Option<f64>,
    pub contrast: Option<f64>,
    pub saturation: Option<f64>,
    pub temperature: Option<f64>,
    pub tint: Option<f64>,
    pub highlights: Option<f64>,
    pub shadows: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImagePaint {
    pub opacity: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    /// `None` is the empty ref of a pending upload.
    pub image_ref: Option<Atom>,
    pub scale_mode: ImageScaleMode,
    pub transform: Option<Matrix>,
    pub scaling_factor: Option<f64>,
    pub rotation: Option<f64>,
    pub filters: Option<ImageFilters>,
}

/// Solid paints, by far the most common, stay inline; the larger kinds are boxed so a paint list stays dense.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Paint {
    Solid(SolidPaint),
    Gradient(Box<GradientPaint>),
    Image(Box<ImagePaint>),
}

impl Paint {
    pub fn visible(&self) -> bool {
        match self {
            Paint::Solid(paint) => paint.visible,
            Paint::Gradient(paint) => paint.visible,
            Paint::Image(paint) => paint.visible,
        }
    }

    pub fn opacity(&self) -> f64 {
        match self {
            Paint::Solid(paint) => paint.opacity,
            Paint::Gradient(paint) => paint.opacity,
            Paint::Image(paint) => paint.opacity,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ShadowKind {
    Drop,
    Inner,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShadowEffect {
    pub kind: ShadowKind,
    pub color: Rgba,
    pub offset: Vec2,
    pub radius: f64,
    pub spread: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    pub show_shadow_behind_node: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BlurKind {
    Layer,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BlurEffect {
    pub kind: BlurKind,
    pub radius: f64,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Effect {
    Shadow(ShadowEffect),
    Blur(BlurEffect),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum LayoutGrid {
    Grid(GridLayoutGrid),
    Columns(BandLayoutGrid),
    Rows(BandLayoutGrid),
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum LineHeight {
    Auto,
    Pixels(f64),
    Percent(f64),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Hyperlink {
    Url(Arc<str>),
    Node(Id),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextStyle {
    pub font_family: Atom,
    pub font_weight: f64,
    pub italic: bool,
    pub font_size: f64,
    pub line_height: LineHeight,
    pub letter_spacing: LetterSpacing,
    pub text_decoration: TextDecoration,
    pub text_case: TextCase,
    /// Absent, `null` or a link.
    pub hyperlink: Option<Option<Hyperlink>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextStyleOverride {
    pub font_family: Option<Atom>,
    pub font_weight: Option<f64>,
    pub italic: Option<bool>,
    pub font_size: Option<f64>,
    pub line_height: Option<LineHeight>,
    pub letter_spacing: Option<LetterSpacing>,
    pub text_decoration: Option<TextDecoration>,
    pub text_case: Option<TextCase>,
    pub hyperlink: Option<Option<Hyperlink>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextRun {
    pub start: f64,
    pub end: f64,
    pub style: TextStyleOverride,
    pub fills: Option<List<Paint>>,
    pub text_style_id: Option<Atom>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextProps {
    pub characters: Arc<str>,
    pub style: TextStyle,
    pub runs: List<TextRun>,
    pub text_align_horizontal: TextAlignHorizontal,
    pub text_align_vertical: TextAlignVertical,
    pub text_auto_resize: TextAutoResize,
    pub paragraph_spacing: f64,
    pub paragraph_indent: f64,
    pub list_types: Option<List<ListType>>,
    pub max_lines: Option<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextPath {
    pub commands: List<PathCommand>,
    pub start_offset: f64,
    pub side: TextPathSide,
}

// ── Vectors ──────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum PathCommand {
    M(Vec2),
    L(Vec2),
    C(CubicTo),
    Q(QuadTo),
    Z,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorPath {
    pub winding_rule: WindingRule,
    pub commands: List<PathCommand>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariableWidthStroke {
    pub width_profile: StrokeWidthProfile,
    pub variable_width_points: Option<List<VariableWidthPoint>>,
}

// ── Prototyping and export ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Trigger {
    OnClick,
    OnHover,
    OnPress,
    OnDrag,
    MouseEnter,
    MouseLeave,
    MouseDown,
    MouseUp,
    AfterTimeout(f64),
    OnKeyDown(Arc<str>),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DirectionalTransition {
    pub direction: TransitionDirection,
    pub match_layers: Option<bool>,
    pub duration: f64,
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Transition {
    Instant,
    Dissolve(TimedTransition),
    SmartAnimate(TimedTransition),
    MoveIn(DirectionalTransition),
    MoveOut(DirectionalTransition),
    Push(DirectionalTransition),
    SlideIn(DirectionalTransition),
    SlideOut(DirectionalTransition),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeAction {
    pub navigation: Navigation,
    pub destination_id: Id,
    pub transition: Transition,
    pub preserve_scroll_position: Option<bool>,
    pub reset_scroll_position: Option<bool>,
    pub overlay_relative_position: Option<Vec2>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Action {
    Node(Box<NodeAction>),
    Back,
    Close,
    Url {
        url: Arc<str>,
        open_in_new_tab: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    pub trigger: Trigger,
    pub actions: List<Action>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportSetting {
    pub format: ExportFormat,
    pub suffix: Arc<str>,
    pub constraint: ExportConstraint,
    pub svg_id_attribute: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlowStartingPoint {
    pub node_id: Id,
    pub name: Atom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PrototypeDevice {
    None,
    Preset { preset_id: Arc<str>, rotation: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum OverlayBackground {
    None,
    SolidColor(Rgba),
}

// ── Annotations, components, board ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub id: Atom,
    pub label: Arc<str>,
    pub category_id: Option<Atom>,
    pub properties: Option<List<AnnotationPropertyType>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasurementEnd {
    pub node_id: Id,
    pub side: MeasurementSide,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum MeasurementOffset {
    Inner(f64),
    Outer(f64),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Measurement {
    pub id: Atom,
    pub start: MeasurementEnd,
    pub end: MeasurementEnd,
    pub offset: MeasurementOffset,
    pub free_text: Option<Arc<str>>,
}

/// A component property's value or default: a string (`Atom`, since variant values repeat) or a boolean.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PropertyValue {
    Text(Atom),
    Boolean(bool),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyDefinition {
    pub kind: ComponentPropertyType,
    pub default_value: PropertyValue,
    pub variant_options: Option<List<Atom>>,
    pub preferred_values: Option<List<Id>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PropertyReferences {
    pub visible: Option<Atom>,
    pub characters: Option<Atom>,
    pub main_component: Option<Atom>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ConnectorEnd {
    Object { node: Id, magnet: ConnectorMagnet },
    Point(Vec2),
    // Appended (lane G step 3; no FORMAT bump: older bytes never hold it): an end anywhere on an object.
    ObjectAt { node: Id, at: Vec2 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardConnector {
    pub start: ConnectorEnd,
    pub end: ConnectorEnd,
    pub line: ConnectorLine,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BoardMeta {
    Sticky {
        wide: Option<bool>,
    },
    Shape(BoardShapeKind),
    Connector(Box<BoardConnector>),
    Stamp {
        stamp: StampId,
        by: Option<Arc<str>>,
    },
    Sticker(Atom),
    Table,
    Stroke(StrokeTool),
    Part(BoardPart),
    // Appended (lane G step 3; no FORMAT bump: older bytes never hold these). A connector or a cell without the new fields
    // keeps its old variant, so it writes the bytes it always wrote.
    /// A connector with a label place or waypoints.
    ConnectorWith(Box<BoardConnectorWith>),
    /// A layer of a board object with column or row spans (a table cell).
    PartSpans {
        part: BoardPart,
        col_span: Option<f64>,
        row_span: Option<f64>,
    },
    Section {
        hidden: Option<bool>,
        background_locked: Option<bool>,
    },
}

/// `BoardMeta::ConnectorWith`: a connector and its `labelAt` and `points`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardConnectorWith {
    pub connector: BoardConnector,
    pub label_at: Option<f64>,
    pub points: Option<List<Vec2>>,
}

// ── Styles, variables, images ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Style {
    pub id: Atom,
    pub kind: StyleType,
    pub name: Atom,
    pub description: Arc<str>,
    pub paints: Option<List<Paint>>,
    pub text: Option<TextStyle>,
    pub effects: Option<List<Effect>>,
    pub grids: Option<List<LayoutGrid>>,
    pub remote: Option<RemoteAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageAsset {
    pub url: Arc<str>,
    pub width: f64,
    pub height: f64,
    pub name: Option<Arc<str>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariableMode {
    pub mode_id: Atom,
    pub name: Atom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariableCollection {
    pub id: Atom,
    pub name: Atom,
    pub modes: List<VariableMode>,
    pub default_mode_id: Atom,
    pub variable_ids: List<Atom>,
    pub remote: Option<RemoteAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum VariableValue {
    Color(Rgba),
    Number(f64),
    Text(Arc<str>),
    Boolean(bool),
    Alias(Atom),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Variable {
    pub id: Atom,
    pub name: Atom,
    pub collection_id: Atom,
    pub kind: VariableType,
    pub values_by_mode: IndexMap<Atom, VariableValue>,
    pub description: Arc<str>,
    pub hidden_from_publishing: Option<bool>,
    pub remote: Option<RemoteAsset>,
}
