//! The document model: `shared/design/types.ts` and `shared/design/board/types.ts` field for field.
//!
//! One file is a flat map of nodes keyed by id. Pages are the roots; every other node names its parent and every
//! container lists its children bottom-to-top. Names follow Figma's plugin API, as in the TypeScript: Rust fields
//! are the snake_case of the TS names and serialize in camelCase; a TS field named `type` is `kind` here.
//!
//! Optional fields: `Option<T>` is a TS `field?: T` (absent ⇔ `None`, `null` refused); `Option<Option<T>>` is a
//! TS `field?: T | null` (`Some(None)` is an explicit `null`); a required `Option<T>` is a TS `field: T | null`.
//! Unions with a discriminator (`type`, `kind`, `unit`, `pattern`) are enums with one variant per tag value.
//! Bounds (number ranges, string lengths, id characters) and structural invariants live in `validate.rs`.

use crate::de;
use crate::validate;
use indexmap::IndexMap;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

pub type NodeId = String;
pub type StyleId = String;
pub type ImageRef = String;
pub type VariableId = String;
/// A JSON object of the document (`Record<string, T>`), in the file's key order.
pub type Map<T> = IndexMap<String, T>;

/// `DESIGN_SCHEMA_VERSION`.
pub const DESIGN_SCHEMA_VERSION: f64 = 1.0;
/// The hidden page holding a file's copies of library components (`LIBRARY_PAGE_ID`).
pub const LIBRARY_PAGE_ID: &str = "morfa:library";

/// Implements `Deserialize` for a `z.discriminatedUnion`: the value must be an object whose `$field` is one of the
/// tags; the option is then read from the same object (its tag field is ignored there, unknown keys dropped).
/// `de::discriminated` reads it in one pass when the tag comes first, through the buffer otherwise.
macro_rules! discriminated {
    ($ty:ident, $field:literal, { $($tag:literal => $variant:ident $(($inner:ty))?),* $(,)? }) => {
        impl de::Discriminated for $ty {
            const FIELD: &'static str = $field;

            fn option<'de, A: serde::de::MapAccess<'de>>(
                tag: &str,
                rest: A,
            ) -> Option<Result<Self, A::Error>> {
                Some(match tag {
                    $($tag => discriminated!(@stream rest, $ty, $variant $(, $inner)?),)*
                    _ => return None,
                })
            }

            fn from_buffer<E: serde::de::Error>(value: &serde_json::Value) -> Result<Self, E> {
                match de::tag::<E>(value, $field)? {
                    $($tag => discriminated!(@option value, E, $ty, $variant $(, $inner)?),)*
                    other => Err(de::unknown_tag($field, other)),
                }
            }
        }

        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                de::discriminated(deserializer)
            }
        }
    };
    (@option $value:ident, $error:ident, $ty:ident, $variant:ident, $inner:ty) => {
        de::from_value::<$inner, $error>($value).map($ty::$variant)
    };
    (@option $value:ident, $error:ident, $ty:ident, $variant:ident) => {
        Ok($ty::$variant)
    };
    (@stream $rest:ident, $ty:ident, $variant:ident, $inner:ty) => {
        <$inner as Deserialize>::deserialize(serde::de::value::MapAccessDeserializer::new($rest))
            .map($ty::$variant)
    };
    (@stream $rest:ident, $ty:ident, $variant:ident) => {
        de::drain($rest).map(|()| $ty::$variant)
    };
}

// ── Basics ───────────────────────────────────────────────────────────────────────────────────────

/// Channels are 0..1, as in Figma. A solid paint keeps its alpha in `Paint.opacity`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

/// TS `Vec`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// Row-major 2×3 affine matrix [[a, c, e], [b, d, f]]: x' = a·x + c·y + e, y' = b·x + d·y + f.
pub type Matrix = [[f64; 3]; 2];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlendMode {
    PassThrough,
    Normal,
    Darken,
    Multiply,
    ColorBurn,
    Lighten,
    Screen,
    ColorDodge,
    Overlay,
    SoftLight,
    HardLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

/// The `type` of a [`VariableAlias`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VariableAliasType {
    #[serde(rename = "VARIABLE_ALIAS")]
    VariableAlias,
}

/// A field of a node or paint bound to a variable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariableAlias {
    #[serde(rename = "type")]
    pub kind: VariableAliasType,
    pub id: VariableId,
}

// ── Paints ───────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ColorStop {
    pub position: f64,
    pub color: Rgba,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ImageScaleMode {
    Fill,
    Fit,
    Crop,
    Tile,
}

/// Each −1..1, 0 is neutral.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ImageFilters {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub exposure: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub contrast: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub saturation: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub temperature: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub tint: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub highlights: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub shadows: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolidPaintBoundVariables {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub color: Option<VariableAlias>,
}

/// `type: 'SOLID'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidPaint {
    /// 0..1, multiplies the paint. Default 1.
    pub opacity: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    pub color: Rgb,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub bound_variables: Option<SolidPaintBoundVariables>,
}

/// `type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientPaint {
    pub opacity: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    pub gradient_stops: Vec<ColorStop>,
    /// Three handles in the node's unit box: start/centre, end, the perpendicular width handle.
    pub gradient_handle_positions: [Vec2; 3],
}

/// `type: 'IMAGE'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePaint {
    pub opacity: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    /// Key into `DesignDocument.images`; empty while an upload is pending.
    pub image_ref: ImageRef,
    pub scale_mode: ImageScaleMode,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub image_transform: Option<Matrix>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub scaling_factor: Option<f64>,
    /// Quarter turns: 0, 90, 180 or 270.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub rotation: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub filters: Option<ImageFilters>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Paint {
    #[serde(rename = "SOLID")]
    Solid(SolidPaint),
    #[serde(rename = "GRADIENT_LINEAR")]
    GradientLinear(GradientPaint),
    #[serde(rename = "GRADIENT_RADIAL")]
    GradientRadial(GradientPaint),
    #[serde(rename = "GRADIENT_ANGULAR")]
    GradientAngular(GradientPaint),
    #[serde(rename = "GRADIENT_DIAMOND")]
    GradientDiamond(GradientPaint),
    #[serde(rename = "IMAGE")]
    Image(ImagePaint),
}
discriminated!(Paint, "type", {
    "SOLID" => Solid(SolidPaint),
    "GRADIENT_LINEAR" => GradientLinear(GradientPaint),
    "GRADIENT_RADIAL" => GradientRadial(GradientPaint),
    "GRADIENT_ANGULAR" => GradientAngular(GradientPaint),
    "GRADIENT_DIAMOND" => GradientDiamond(GradientPaint),
    "IMAGE" => Image(ImagePaint),
});

impl Paint {
    pub fn opacity(&self) -> f64 {
        match self {
            Paint::Solid(paint) => paint.opacity,
            Paint::GradientLinear(paint)
            | Paint::GradientRadial(paint)
            | Paint::GradientAngular(paint)
            | Paint::GradientDiamond(paint) => paint.opacity,
            Paint::Image(paint) => paint.opacity,
        }
    }

    pub fn visible(&self) -> bool {
        match self {
            Paint::Solid(paint) => paint.visible,
            Paint::GradientLinear(paint)
            | Paint::GradientRadial(paint)
            | Paint::GradientAngular(paint)
            | Paint::GradientDiamond(paint) => paint.visible,
            Paint::Image(paint) => paint.visible,
        }
    }

    pub fn gradient(&self) -> Option<&GradientPaint> {
        match self {
            Paint::GradientLinear(paint)
            | Paint::GradientRadial(paint)
            | Paint::GradientAngular(paint)
            | Paint::GradientDiamond(paint) => Some(paint),
            _ => None,
        }
    }
}

// ── Strokes, corners, effects ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StrokeAlign {
    Inside,
    Center,
    Outside,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StrokeCap {
    None,
    Round,
    Square,
}

/// What a LINE or open VECTOR path draws at its first/last point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StrokeMarker {
    None,
    LineArrow,
    TriangleArrow,
    ReversedTriangle,
    Circle,
    Diamond,
    Round,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StrokeJoin {
    Miter,
    Bevel,
    Round,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct IndividualStrokeWeights {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// "Width profile" (Figma's `widthProfile`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StrokeWidthProfile {
    Uniform,
    Wedge,
    Taper,
    QuarterTaper,
    Eye,
    MirroredTaper,
    Custom,
}

/// `position` 0..1 along the path, `width` a fraction of `strokeWeight` there.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct VariableWidthPoint {
    pub position: f64,
    pub width: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableWidthStrokeProperties {
    pub width_profile: StrokeWidthProfile,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub variable_width_points: Option<Vec<VariableWidthPoint>>,
}

/// `type: 'DROP_SHADOW' | 'INNER_SHADOW'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowEffect {
    pub color: Rgba,
    pub offset: Vec2,
    /// Blur radius in px.
    pub radius: f64,
    pub spread: f64,
    pub visible: bool,
    pub blend_mode: BlendMode,
    /// DROP_SHADOW only: draw the shadow under transparent parts of the node too. Default false.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub show_shadow_behind_node: Option<bool>,
}

/// `type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlurEffect {
    pub radius: f64,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Effect {
    #[serde(rename = "DROP_SHADOW")]
    DropShadow(ShadowEffect),
    #[serde(rename = "INNER_SHADOW")]
    InnerShadow(ShadowEffect),
    #[serde(rename = "LAYER_BLUR")]
    LayerBlur(BlurEffect),
    #[serde(rename = "BACKGROUND_BLUR")]
    BackgroundBlur(BlurEffect),
}
discriminated!(Effect, "type", {
    "DROP_SHADOW" => DropShadow(ShadowEffect),
    "INNER_SHADOW" => InnerShadow(ShadowEffect),
    "LAYER_BLUR" => LayerBlur(BlurEffect),
    "BACKGROUND_BLUR" => BackgroundBlur(BlurEffect),
});

// ── Layout ───────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConstraintType {
    Min,
    Max,
    Center,
    Stretch,
    Scale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Constraints {
    pub horizontal: ConstraintType,
    pub vertical: ConstraintType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayoutMode {
    None,
    Horizontal,
    Vertical,
    /// Appended (the store's codec writes variants by position: store/value.rs).
    Grid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayoutSizing {
    Fixed,
    Hug,
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayoutWrap {
    NoWrap,
    Wrap,
}

/// `LayoutAlign | 'SPACE_BETWEEN'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrimaryAxisAlignItems {
    Min,
    Center,
    Max,
    SpaceBetween,
}

/// `LayoutAlign | 'BASELINE'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CounterAxisAlignItems {
    Min,
    Center,
    Max,
    Baseline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CounterAxisAlignContent {
    Auto,
    SpaceBetween,
}

/// The auto-layout properties of a frame-like node (FRAME, COMPONENT, COMPONENT_SET, INSTANCE).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLayout {
    pub layout_mode: LayoutMode,
    pub layout_wrap: LayoutWrap,
    pub primary_axis_align_items: PrimaryAxisAlignItems,
    pub counter_axis_align_items: CounterAxisAlignItems,
    /// WRAP only: how the rows share the cross axis.
    pub counter_axis_align_content: CounterAxisAlignContent,
    pub padding_left: f64,
    pub padding_right: f64,
    pub padding_top: f64,
    pub padding_bottom: f64,
    pub item_spacing: f64,
    /// WRAP only: the gap between rows.
    pub counter_axis_spacing: f64,
    /// Later children are drawn below earlier ones ("First on top").
    pub item_reverse_z_index: bool,
    pub strokes_included_in_layout: bool,
}

// ── Grid auto layout (types.ts `GridLayout`, `GridChild`) ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GridTrackType {
    Fixed,
    Flex,
    Hug,
}

/// One row or column: FIXED is `value` px, FLEX a share by `value` (`fr`, 1 when absent), HUG the content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridTrackSize {
    #[serde(rename = "type")]
    pub kind: GridTrackType,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GridAutoTracks {
    None,
    Rows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GridItemsPositioning {
    Manual,
    RowAutoFlow,
}

/// Figma's grid auto layout on a frame whose `autoLayout.layoutMode` is GRID (`grid` in the JSON). New fields go at
/// the end (store/value.rs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    pub row_count: f64,
    pub column_count: f64,
    pub row_gap: f64,
    pub column_gap: f64,
    pub row_sizes: Vec<GridTrackSize>,
    pub column_sizes: Vec<GridTrackSize>,
    pub auto_tracks: GridAutoTracks,
    pub items_positioning: GridItemsPositioning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GridChildAlign {
    Min,
    Center,
    Max,
    Auto,
}

/// A child of a GRID frame: its cell (MANUAL placement), spans and alignment (`gridChild` in the JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridChild {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub row_anchor_index: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub column_anchor_index: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub row_span: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub column_span: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub horizontal_align: Option<GridChildAlign>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub vertical_align: Option<GridChildAlign>,
}

/// `pattern: 'GRID'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayoutGrid {
    pub section_size: f64,
    pub visible: bool,
    pub color: Rgba,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayoutGridAlignment {
    Min,
    Max,
    Center,
    Stretch,
}

/// `pattern: 'COLUMNS' | 'ROWS'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BandLayoutGrid {
    pub alignment: LayoutGridAlignment,
    pub count: f64,
    pub gutter_size: f64,
    pub offset: f64,
    pub section_size: f64,
    pub visible: bool,
    pub color: Rgba,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "pattern")]
pub enum LayoutGrid {
    #[serde(rename = "GRID")]
    Grid(GridLayoutGrid),
    #[serde(rename = "COLUMNS")]
    Columns(BandLayoutGrid),
    #[serde(rename = "ROWS")]
    Rows(BandLayoutGrid),
}
discriminated!(LayoutGrid, "pattern", {
    "GRID" => Grid(GridLayoutGrid),
    "COLUMNS" => Columns(BandLayoutGrid),
    "ROWS" => Rows(BandLayoutGrid),
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GuideAxis {
    X,
    Y,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Guide {
    pub axis: GuideAxis,
    pub offset: f64,
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

/// The `value` of a PIXELS or PERCENT line height.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LineHeightValue {
    pub value: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "unit")]
pub enum LineHeight {
    #[serde(rename = "AUTO")]
    Auto,
    #[serde(rename = "PIXELS")]
    Pixels(LineHeightValue),
    #[serde(rename = "PERCENT")]
    Percent(LineHeightValue),
}
discriminated!(LineHeight, "unit", {
    "AUTO" => Auto,
    "PIXELS" => Pixels(LineHeightValue),
    "PERCENT" => Percent(LineHeightValue),
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LetterSpacingUnit {
    Pixels,
    Percent,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LetterSpacing {
    pub unit: LetterSpacingUnit,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TextCase {
    Original,
    Upper,
    Lower,
    Title,
    SmallCaps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TextDecoration {
    None,
    Underline,
    Strikethrough,
}

/// `type: 'URL'`: http(s) and mailto only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UrlHyperlink {
    pub url: String,
}

/// `type: 'NODE'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeHyperlink {
    pub node_id: NodeId,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Hyperlink {
    #[serde(rename = "URL")]
    Url(UrlHyperlink),
    #[serde(rename = "NODE")]
    Node(NodeHyperlink),
}
discriminated!(Hyperlink, "type", {
    "URL" => Url(UrlHyperlink),
    "NODE" => Node(NodeHyperlink),
});

/// Character-level typography. A text node carries a full base style; runs override parts of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    /// Family name as shown in the font menu, e.g. "Inter".
    pub font_family: String,
    /// 100..900.
    pub font_weight: f64,
    pub italic: bool,
    pub font_size: f64,
    pub line_height: LineHeight,
    pub letter_spacing: LetterSpacing,
    pub text_decoration: TextDecoration,
    pub text_case: TextCase,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub hyperlink: Option<Option<Hyperlink>>,
}

/// `Partial<TextStyle>`: what a run overrides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyleOverride {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub font_family: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub font_weight: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub italic: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub font_size: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub line_height: Option<LineHeight>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub letter_spacing: Option<LetterSpacing>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub text_decoration: Option<TextDecoration>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub text_case: Option<TextCase>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub hyperlink: Option<Option<Hyperlink>>,
}

/// A styled range of `characters`, end exclusive, in UTF-16 code units. Runs never overlap and are sorted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub start: f64,
    pub end: f64,
    pub style: TextStyleOverride,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub fills: Option<Vec<Paint>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub text_style_id: Option<StyleId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ListType {
    None,
    Ordered,
    Unordered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TextAutoResize {
    None,
    WidthAndHeight,
    Height,
    Truncate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TextAlignHorizontal {
    Left,
    Center,
    Right,
    Justified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TextAlignVertical {
    Top,
    Center,
    Bottom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextProps {
    pub characters: String,
    pub style: TextStyle,
    pub runs: Vec<TextRun>,
    pub text_align_horizontal: TextAlignHorizontal,
    pub text_align_vertical: TextAlignVertical,
    pub text_auto_resize: TextAutoResize,
    pub paragraph_spacing: f64,
    pub paragraph_indent: f64,
    /// One entry per paragraph (split on "\n"); missing entries are 'NONE'.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub list_types: Option<Vec<ListType>>,
    /// TRUNCATE: lines kept before the ellipsis; absent = as many as fit.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub max_lines: Option<Option<f64>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TextPathSide {
    Left,
    Right,
}

/// "Text on a path" (Figma's TEXT_PATH).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPathData {
    /// The path in the layer's local box, as a VECTOR's. Only its first subpath carries text.
    pub commands: Vec<PathCommand>,
    /// 0..1 of the path's length.
    pub start_offset: f64,
    pub side: TextPathSide,
}

// ── Dev annotations and measurements ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationPropertyType {
    Width,
    Height,
    MinWidth,
    MaxWidth,
    MinHeight,
    MaxHeight,
    Fills,
    Strokes,
    StrokeWeight,
    CornerRadius,
    Effects,
    Opacity,
    TextStyleId,
    FontFamily,
    FontStyle,
    FontSize,
    FontWeight,
    LineHeight,
    LetterSpacing,
    TextAlignHorizontal,
    LayoutMode,
    ItemSpacing,
    Padding,
    AlignItems,
    MainComponent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AnnotationProperty {
    #[serde(rename = "type")]
    pub kind: AnnotationPropertyType,
}

/// "Annotation" (Y): a note for developers pinned to a layer. `id` is unique on its layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub label: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub category_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub properties: Option<Vec<AnnotationProperty>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MeasurementSide {
    Top,
    Right,
    Bottom,
    Left,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasurementEnd {
    pub node_id: NodeId,
    pub side: MeasurementSide,
}

/// `type: 'INNER'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct InnerMeasurementOffset {
    pub relative: f64,
}

/// `type: 'OUTER'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OuterMeasurementOffset {
    pub fixed: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum MeasurementOffset {
    #[serde(rename = "INNER")]
    Inner(InnerMeasurementOffset),
    #[serde(rename = "OUTER")]
    Outer(OuterMeasurementOffset),
}
discriminated!(MeasurementOffset, "type", {
    "INNER" => Inner(InnerMeasurementOffset),
    "OUTER" => Outer(OuterMeasurementOffset),
});

/// "Measurement" (⇧M): a pinned distance between two parallel edges of layers on the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub id: String,
    pub start: MeasurementEnd,
    pub end: MeasurementEnd,
    pub offset: MeasurementOffset,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub free_text: Option<String>,
}

// ── Vectors ──────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WindingRule {
    Nonzero,
    Evenodd,
}

/// `type: 'C'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CubicTo {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub x: f64,
    pub y: f64,
}

/// `type: 'Q'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct QuadTo {
    pub x1: f64,
    pub y1: f64,
    pub x: f64,
    pub y: f64,
}

/// Absolute commands in the node's local box. Arcs are converted to cubics on import.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum PathCommand {
    M(Vec2),
    L(Vec2),
    C(CubicTo),
    Q(QuadTo),
    Z,
}
discriminated!(PathCommand, "type", {
    "M" => M(Vec2),
    "L" => L(Vec2),
    "C" => C(CubicTo),
    "Q" => Q(QuadTo),
    "Z" => Z,
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorPath {
    pub winding_rule: WindingRule,
    pub commands: Vec<PathCommand>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BooleanOperation {
    Union,
    Intersect,
    Subtract,
    Exclude,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArcData {
    /// Radians, clockwise from 3 o'clock. A full ellipse is 0 → 2π.
    pub starting_angle: f64,
    pub ending_angle: f64,
    /// 0..1 of the radius; > 0 makes a ring or a donut slice.
    pub inner_radius: f64,
}

// ── Prototyping ──────────────────────────────────────────────────────────────────────────────────

/// `type: 'AFTER_TIMEOUT'`: `timeout` in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimeoutTrigger {
    pub timeout: f64,
}

/// `type: 'ON_KEY_DOWN'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDownTrigger {
    pub key_code: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Trigger {
    #[serde(rename = "ON_CLICK")]
    OnClick,
    #[serde(rename = "ON_HOVER")]
    OnHover,
    #[serde(rename = "ON_PRESS")]
    OnPress,
    #[serde(rename = "ON_DRAG")]
    OnDrag,
    #[serde(rename = "MOUSE_ENTER")]
    MouseEnter,
    #[serde(rename = "MOUSE_LEAVE")]
    MouseLeave,
    #[serde(rename = "MOUSE_DOWN")]
    MouseDown,
    #[serde(rename = "MOUSE_UP")]
    MouseUp,
    #[serde(rename = "AFTER_TIMEOUT")]
    AfterTimeout(TimeoutTrigger),
    #[serde(rename = "ON_KEY_DOWN")]
    OnKeyDown(KeyDownTrigger),
}
discriminated!(Trigger, "type", {
    "ON_CLICK" => OnClick,
    "ON_HOVER" => OnHover,
    "ON_PRESS" => OnPress,
    "ON_DRAG" => OnDrag,
    "MOUSE_ENTER" => MouseEnter,
    "MOUSE_LEAVE" => MouseLeave,
    "MOUSE_DOWN" => MouseDown,
    "MOUSE_UP" => MouseUp,
    "AFTER_TIMEOUT" => AfterTimeout(TimeoutTrigger),
    "ON_KEY_DOWN" => OnKeyDown(KeyDownTrigger),
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInAndOut,
    EaseInBack,
    EaseOutBack,
    Gentle,
    Quick,
    Bouncy,
    Slow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TransitionDirection {
    Left,
    Right,
    Top,
    Bottom,
}

/// `type: 'DISSOLVE' | 'SMART_ANIMATE'`: `duration` in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimedTransition {
    pub duration: f64,
    pub easing: Easing,
}

/// `type: 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionalTransition {
    pub direction: TransitionDirection,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub match_layers: Option<bool>,
    pub duration: f64,
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Transition {
    #[serde(rename = "INSTANT")]
    Instant,
    #[serde(rename = "DISSOLVE")]
    Dissolve(TimedTransition),
    #[serde(rename = "SMART_ANIMATE")]
    SmartAnimate(TimedTransition),
    #[serde(rename = "MOVE_IN")]
    MoveIn(DirectionalTransition),
    #[serde(rename = "MOVE_OUT")]
    MoveOut(DirectionalTransition),
    #[serde(rename = "PUSH")]
    Push(DirectionalTransition),
    #[serde(rename = "SLIDE_IN")]
    SlideIn(DirectionalTransition),
    #[serde(rename = "SLIDE_OUT")]
    SlideOut(DirectionalTransition),
}
discriminated!(Transition, "type", {
    "INSTANT" => Instant,
    "DISSOLVE" => Dissolve(TimedTransition),
    "SMART_ANIMATE" => SmartAnimate(TimedTransition),
    "MOVE_IN" => MoveIn(DirectionalTransition),
    "MOVE_OUT" => MoveOut(DirectionalTransition),
    "PUSH" => Push(DirectionalTransition),
    "SLIDE_IN" => SlideIn(DirectionalTransition),
    "SLIDE_OUT" => SlideOut(DirectionalTransition),
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OverlayPosition {
    Center,
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Navigation {
    Navigate,
    Overlay,
    Swap,
    ScrollTo,
    ChangeTo,
}

/// `type: 'NODE'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeAction {
    pub navigation: Navigation,
    pub destination_id: NodeId,
    pub transition: Transition,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub preserve_scroll_position: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub reset_scroll_position: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub overlay_relative_position: Option<Vec2>,
}

/// `type: 'URL'`: http(s) and mailto only; the player opens it with noopener.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlAction {
    pub url: String,
    pub open_in_new_tab: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Action {
    #[serde(rename = "NODE")]
    Node(NodeAction),
    #[serde(rename = "BACK")]
    Back,
    #[serde(rename = "CLOSE")]
    Close,
    #[serde(rename = "URL")]
    Url(UrlAction),
}
discriminated!(Action, "type", {
    "NODE" => Node(NodeAction),
    "BACK" => Back,
    "CLOSE" => Close,
    "URL" => Url(UrlAction),
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    pub trigger: Trigger,
    pub actions: Vec<Action>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OverflowDirection {
    None,
    Horizontal,
    Vertical,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStartingPoint {
    pub node_id: NodeId,
    pub name: String,
}

/// `type: 'PRESET'`; `rotation` is 0 or 90.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetDevice {
    pub preset_id: String,
    pub rotation: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum PrototypeDevice {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "PRESET")]
    Preset(PresetDevice),
}
discriminated!(PrototypeDevice, "type", {
    "NONE" => None,
    "PRESET" => Preset(PresetDevice),
});

/// `type: 'SOLID_COLOR'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OverlayColor {
    pub color: Rgba,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum OverlayBackground {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "SOLID_COLOR")]
    SolidColor(OverlayColor),
}
discriminated!(OverlayBackground, "type", {
    "NONE" => None,
    "SOLID_COLOR" => SolidColor(OverlayColor),
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OverlayBackgroundInteraction {
    None,
    CloseOnClickOutside,
}

/// Children of a scrolling frame: FIXED stays put, STICKY sticks at the top.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScrollBehavior {
    Scrolls,
    Fixed,
    StickyScrolls,
}

// ── Export ───────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportFormat {
    Png,
    Jpg,
    Svg,
    Pdf,
    Webp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportConstraintType {
    Scale,
    Width,
    Height,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ExportConstraint {
    #[serde(rename = "type")]
    pub kind: ExportConstraintType,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSetting {
    pub format: ExportFormat,
    pub suffix: String,
    pub constraint: ExportConstraint,
    /// SVG: each layer's element carries the layer's name as its `id`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub svg_id_attribute: Option<bool>,
}

// ── Components ───────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ComponentPropertyType {
    Boolean,
    Text,
    InstanceSwap,
    Variant,
}

/// `string | boolean`: a component property's value or default.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PropertyValue {
    Text(String),
    Boolean(bool),
}

impl<'de> Deserialize<'de> for PropertyValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PropertyValueVisitor;
        impl serde::de::Visitor<'_> for PropertyValueVisitor {
            type Value = PropertyValue;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a string or a boolean")
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<PropertyValue, E> {
                Ok(PropertyValue::Boolean(value))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<PropertyValue, E> {
                Ok(PropertyValue::Text(value.to_owned()))
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<PropertyValue, E> {
                Ok(PropertyValue::Text(value))
            }
        }
        deserializer.deserialize_any(PropertyValueVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentPropertyDefinition {
    #[serde(rename = "type")]
    pub kind: ComponentPropertyType,
    /// BOOLEAN: boolean; TEXT: string; INSTANCE_SWAP: component id; VARIANT: one of `variantOptions`.
    pub default_value: PropertyValue,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub variant_options: Option<Vec<String>>,
    /// INSTANCE_SWAP: components offered first in the swap menu.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub preferred_values: Option<Vec<NodeId>>,
}

/// Which node field a component property drives.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentPropertyReferences {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub visible: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub characters: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub main_component: Option<String>,
}

// ── Board (shared/design/board/types.ts) ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BoardShapeKind {
    Square,
    Rounded,
    Ellipse,
    Diamond,
    Triangle,
    TriangleDown,
    Parallelogram,
    ParallelogramLeft,
    Trapezoid,
    Hexagon,
    Pentagon,
    Octagon,
    Star,
    Plus,
    ArrowRight,
    ArrowLeft,
    Chevron,
    Cylinder,
    Document,
    Speech,
    // FigJam's other flowchart figures (lane G step 3), appended: the store's codec writes variants by position.
    CylinderHorizontal,
    File,
    Folder,
    Documents,
    PredefinedProcess,
    Shield,
    ManualInput,
    InternalStorage,
    Or,
    SummingJunction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectorMagnet {
    Auto,
    Top,
    Right,
    Bottom,
    Left,
    Center,
}

/// A connector's end on an object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectorObjectEnd {
    pub node: NodeId,
    pub magnet: ConnectorMagnet,
}

/// A connector's end anywhere on an object: `at` is a point of the object's box in 0…1 fractions of its width and height.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectorAtEnd {
    pub node: NodeId,
    pub at: Vec2,
}

/// A connector's end: on an object at a magnet or anywhere on it (it follows the object), or a free point in the
/// connector's parent space. zod tries `{node, magnet}` first, then `{node, at}`, then `{x, y}` (`z.union`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ConnectorEnd {
    Object(ConnectorObjectEnd),
    Point(Vec2),
    At(ConnectorAtEnd),
}

impl<'de> Deserialize<'de> for ConnectorEnd {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = de::buffer(deserializer)?;
        if let Ok(end) = de::from_value::<ConnectorObjectEnd, D::Error>(&value)
            && validate::connector_object_end(&end).is_ok()
        {
            return Ok(ConnectorEnd::Object(end));
        }
        if let Ok(end) = de::from_value::<ConnectorAtEnd, D::Error>(&value)
            && validate::connector_at_end(&end).is_ok()
        {
            return Ok(ConnectorEnd::At(end));
        }
        if let Ok(point) = de::from_value::<Vec2, D::Error>(&value)
            && validate::vec2(&point).is_ok()
        {
            return Ok(ConnectorEnd::Point(point));
        }
        Err(D::Error::custom("no option of the union matches"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectorLine {
    Straight,
    Elbow,
    Curved,
}

/// The stamp wheel (E): FigJam's set, plus the author's own avatar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StampId {
    Heart,
    Like,
    Dislike,
    Star,
    Question,
    PlusOne,
    Check,
    Fire,
    Avatar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StrokeTool {
    Marker,
    Highlighter,
    Washi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardPart {
    Text,
    Author,
    Shape,
    Line,
    Label,
    Row,
    Cell,
}

/// `kind: 'sticky'`: `wide` is the wide sticky (2:1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoardSticky {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub wide: Option<bool>,
}

/// `kind: 'shape'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoardShape {
    pub shape: BoardShapeKind,
}

/// `kind: 'connector'`: `label_at` is where the label sits along the line (0…1; absent: the middle), `points` a reshaped
/// connector's waypoints in its parent space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardConnector {
    pub start: ConnectorEnd,
    pub end: ConnectorEnd,
    pub line: ConnectorLine,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub label_at: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub points: Option<Vec<Vec2>>,
}

/// `kind: 'stamp'`: `by` is who put it there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardStamp {
    pub stamp: StampId,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub by: Option<String>,
}

/// `kind: 'sticker'`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardSticker {
    pub sticker: String,
}

/// `kind: 'stroke'`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoardStroke {
    pub tool: StrokeTool,
}

/// `kind: 'part'`: a table cell may span columns and rows (whole numbers from 1; absent: 1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardPartMeta {
    pub part: BoardPart,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub col_span: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub row_span: Option<f64>,
}

/// `kind: 'section'`: a board SECTION; `hidden` hides what it holds, `background_locked` locks the section itself only.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSection {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub hidden: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub background_locked: Option<bool>,
}

/// What a layer is in a board object (docs/board.md §Objects).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BoardMeta {
    Sticky(BoardSticky),
    Shape(BoardShape),
    Connector(BoardConnector),
    Stamp(BoardStamp),
    Sticker(BoardSticker),
    Table,
    Stroke(BoardStroke),
    Part(BoardPartMeta),
    Section(BoardSection),
}
discriminated!(BoardMeta, "kind", {
    "sticky" => Sticky(BoardSticky),
    "shape" => Shape(BoardShape),
    "connector" => Connector(BoardConnector),
    "stamp" => Stamp(BoardStamp),
    "sticker" => Sticker(BoardSticker),
    "table" => Table,
    "stroke" => Stroke(BoardStroke),
    "part" => Part(BoardPartMeta),
    "section" => Section(BoardSection),
});

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NodeType {
    Page,
    Frame,
    Group,
    Section,
    Component,
    ComponentSet,
    Instance,
    BooleanOperation,
    Rectangle,
    Ellipse,
    Line,
    Polygon,
    Star,
    Vector,
    Text,
    Slice,
}

/// Containers own `children`. GROUP and BOOLEAN_OPERATION always fit their box to their children.
pub const CONTAINER_TYPES: [NodeType; 8] = [
    NodeType::Page,
    NodeType::Frame,
    NodeType::Group,
    NodeType::Section,
    NodeType::Component,
    NodeType::ComponentSet,
    NodeType::Instance,
    NodeType::BooleanOperation,
];
/// Frame-like nodes clip, have auto layout, layout grids, prototype overflow and corner radii.
pub const FRAME_LIKE_TYPES: [NodeType; 4] = [
    NodeType::Frame,
    NodeType::Component,
    NodeType::ComponentSet,
    NodeType::Instance,
];

impl NodeType {
    pub fn is_container(self) -> bool {
        CONTAINER_TYPES.contains(&self)
    }

    pub fn is_frame_like(self) -> bool {
        FRAME_LIKE_TYPES.contains(&self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MaskType {
    Alpha,
    Vector,
    Luminance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayoutPositioning {
    Auto,
    Absolute,
}

/// Where a copy of a library's component, style, variable collection or variable came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAsset {
    /// The library on the server (`design_libraries.id`).
    pub library_id: String,
    /// The asset's id in the library file, the same in every version of the library.
    pub key: String,
    /// The library version the copy was taken from.
    pub version: f64,
}

/// One interface for every node type (`SceneNode` in types.ts). Fields documented there as "type-specific" are
/// present only where they apply (shared/design/defaults.ts); everything else is always present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneNode {
    pub id: NodeId,
    #[serde(rename = "type")]
    pub kind: NodeType,
    pub name: String,
    /// `None` for pages only.
    #[serde(deserialize_with = "de::nullable")]
    pub parent_id: Option<NodeId>,
    /// Containers only, bottom-to-top.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub children: Option<Vec<NodeId>>,

    pub visible: bool,
    pub locked: bool,
    /// 0..1.
    pub opacity: f64,
    pub blend_mode: BlendMode,
    /// This node masks the siblings above it, up to the next mask or the end of the parent.
    pub is_mask: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub mask_type: Option<MaskType>,

    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Degrees; positive turns counter-clockwise on screen.
    pub rotation: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub flip_x: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub flip_y: Option<bool>,
    /// "Lock aspect ratio". Absent is off.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub constrain_proportions: Option<bool>,

    pub fills: Vec<Paint>,
    pub strokes: Vec<Paint>,
    pub stroke_weight: f64,
    pub stroke_align: StrokeAlign,
    pub stroke_cap: StrokeCap,
    pub stroke_join: StrokeJoin,
    pub stroke_miter_limit: f64,
    pub dash_pattern: Vec<f64>,
    pub effects: Vec<Effect>,

    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub fill_style_id: Option<StyleId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub stroke_style_id: Option<StyleId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub effect_style_id: Option<StyleId>,
    /// Field → variable (e.g. "width", "itemSpacing", "opacity", "cornerRadius", "characters", "visible").
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub bound_variables: Option<Map<VariableAlias>>,

    /// Children of non-auto-layout containers: how they follow a resized parent.
    pub constraints: Constraints,
    /// Children of auto-layout frames. ABSOLUTE children ignore the flow and use constraints.
    pub layout_positioning: LayoutPositioning,
    pub layout_sizing_horizontal: LayoutSizing,
    pub layout_sizing_vertical: LayoutSizing,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub min_width: Option<Option<f64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub max_width: Option<Option<f64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub min_height: Option<Option<f64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub max_height: Option<Option<f64>>,

    pub export_settings: Vec<ExportSetting>,
    pub reactions: Vec<Reaction>,

    // Type-specific ──────────────────────────────────────────────────────────────────────────────
    /// RECTANGLE, frame-like, POLYGON, STAR, SECTION: one radius for every corner.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub corner_radius: Option<f64>,
    /// RECTANGLE and frame-like: [top-left, top-right, bottom-right, bottom-left]; overrides `cornerRadius`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub rectangle_corner_radii: Option<Option<[f64; 4]>>,
    /// 0..1, iOS-style smoothing of rounded corners.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub corner_smoothing: Option<f64>,
    /// RECTANGLE and frame-like.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::nullable_optional"
    )]
    pub individual_stroke_weights: Option<Option<IndividualStrokeWeights>>,

    /// Frame-like.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub clips_content: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub auto_layout: Option<AutoLayout>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub layout_grids: Option<Vec<LayoutGrid>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub grid_style_id: Option<StyleId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub overflow_direction: Option<OverflowDirection>,
    /// Prototype: how this frame behaves when opened as an overlay.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub overlay_position_type: Option<OverlayPosition>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub overlay_background: Option<OverlayBackground>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub overlay_background_interaction: Option<OverlayBackgroundInteraction>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub scroll_behavior: Option<ScrollBehavior>,

    /// PAGE.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub background_color: Option<Rgb>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub guides: Option<Vec<Guide>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub flow_starting_points: Option<Vec<FlowStartingPoint>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub prototype_device: Option<PrototypeDevice>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub prototype_background: Option<Rgb>,

    /// ELLIPSE.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub arc_data: Option<ArcData>,
    /// POLYGON and STAR.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub point_count: Option<f64>,
    /// STAR: 0..1.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub inner_radius: Option<f64>,
    /// LINE and VECTOR.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub stroke_start_marker: Option<StrokeMarker>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub stroke_end_marker: Option<StrokeMarker>,
    /// LINE and VECTOR whose paths are all open: a stroke whose width changes along the path.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub variable_width_stroke_properties: Option<VariableWidthStrokeProperties>,
    /// VECTOR: paths in the node's local box. Resizing a vector scales its paths.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub vector_paths: Option<Vec<VectorPath>>,
    /// BOOLEAN_OPERATION.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub boolean_operation: Option<BooleanOperation>,
    /// TEXT.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub text: Option<TextProps>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub text_style_id: Option<StyleId>,
    /// TEXT: the text follows this path ("Text on a path").
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub text_path: Option<TextPathData>,

    /// Any layer but a page: notes for developers ("Annotation", Y).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub annotations: Option<Vec<Annotation>>,
    /// PAGE: pinned measurements between layers of the page ("Measurement", ⇧M).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub measurements: Option<Vec<Measurement>>,

    /// COMPONENT and COMPONENT_SET.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub description: Option<String>,
    /// COMPONENT (BOOLEAN/TEXT/INSTANCE_SWAP) and COMPONENT_SET (VARIANT). Keys are unique names, e.g. "Icon#12".
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub component_property_definitions: Option<Map<ComponentPropertyDefinition>>,
    /// Nodes inside a component whose fields a component property drives.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub component_property_references: Option<ComponentPropertyReferences>,
    /// INSTANCE: the main component it was made from.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub component_id: Option<NodeId>,
    /// INSTANCE: values of the main component's properties (variant values included).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub component_properties: Option<Map<PropertyValue>>,
    /// INSTANCE inside a main component: its properties show on the main's instances, beside their own.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub is_exposed_instance: Option<bool>,

    /// Nodes inside an instance: the node of the main component it mirrors. Their id is `${instanceId};${mainId}`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub main_id: Option<NodeId>,
    /// Nodes inside an instance: fields the user changed on this copy; syncing keeps them.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub overrides: Option<Vec<String>>,

    /// Free-form metadata imported from other tools; never read by the renderer.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub plugin_data: Option<Map<String>>,

    /// COMPONENT and COMPONENT_SET on the library page (`LIBRARY_PAGE_ID`) only.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub remote: Option<RemoteAsset>,

    /// Board: what this layer is in a board object. Absent on every layer a design file draws.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub board: Option<BoardMeta>,

    // Appended after `board` (types.ts puts them by `autoLayout` and `maxHeight`): the store's field table and codec
    // keep their order (store/fields.rs, store/value.rs).
    /// `autoLayout.layoutMode` GRID only: the grid's tracks, gaps and placement rules.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub grid: Option<GridLayout>,
    /// Children of GRID frames: the cell, spans and alignment within the cells.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub grid_child: Option<GridChild>,
}

// ── Styles and variables ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StyleType {
    Fill,
    Text,
    Effect,
    Grid,
}

/// Local styles. Nodes keep concrete values and the style id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Style {
    pub id: StyleId,
    #[serde(rename = "type")]
    pub kind: StyleType,
    /// "/" makes groups, as in Figma: "Brand/Primary".
    pub name: String,
    pub description: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub paints: Option<Vec<Paint>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub text: Option<TextStyle>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub effects: Option<Vec<Effect>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub grids: Option<Vec<LayoutGrid>>,
    /// A style copied from a shared library: read-only here.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub remote: Option<RemoteAsset>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VariableType {
    Color,
    Float,
    String,
    Boolean,
}

/// `RGBA | number | string | boolean | VariableAlias`. zod tries the options in that order and keeps the first
/// that passes all its checks, bounds included (`z.union`), so the choice is made with `validate.rs`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum VariableValue {
    Color(Rgba),
    Number(f64),
    Text(String),
    Boolean(bool),
    Alias(VariableAlias),
}

impl<'de> Deserialize<'de> for VariableValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = de::buffer(deserializer)?;
        match &value {
            serde_json::Value::Object(_) => {
                if let Ok(color) = de::from_value::<Rgba, D::Error>(&value)
                    && validate::rgba(&color).is_ok()
                {
                    return Ok(VariableValue::Color(color));
                }
                if let Ok(alias) = de::from_value::<VariableAlias, D::Error>(&value)
                    && validate::alias(&alias).is_ok()
                {
                    return Ok(VariableValue::Alias(alias));
                }
            }
            serde_json::Value::Number(number) => {
                if let Some(number) = number.as_f64() {
                    return Ok(VariableValue::Number(number));
                }
            }
            serde_json::Value::String(text) => {
                if validate::description_text(text).is_ok() {
                    return Ok(VariableValue::Text(text.clone()));
                }
            }
            serde_json::Value::Bool(flag) => return Ok(VariableValue::Boolean(*flag)),
            _ => {}
        }
        Err(D::Error::custom("no option of the union matches"))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableMode {
    pub mode_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableCollection {
    pub id: String,
    pub name: String,
    pub modes: Vec<VariableMode>,
    pub default_mode_id: String,
    pub variable_ids: Vec<VariableId>,
    /// A collection copied from a shared library, read-only here.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub remote: Option<RemoteAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub id: VariableId,
    pub name: String,
    pub collection_id: String,
    #[serde(rename = "type")]
    pub kind: VariableType,
    pub values_by_mode: Map<VariableValue>,
    pub description: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub hidden_from_publishing: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub remote: Option<RemoteAsset>,
}

// ── Images and the document ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageAsset {
    /// Same-origin URL: `/uploads/<file>` owned by the file's account.
    pub url: String,
    pub width: f64,
    pub height: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub name: Option<String>,
}

/// One design file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignDocument {
    /// Always [`DESIGN_SCHEMA_VERSION`].
    pub schema_version: f64,
    /// Page ids in panel order. At least one. The hidden library page is never listed.
    pub pages: Vec<NodeId>,
    pub nodes: Map<SceneNode>,
    pub styles: Map<Style>,
    pub images: Map<ImageAsset>,
    pub variable_collections: Map<VariableCollection>,
    pub variables: Map<Variable>,
    /// Frame-like nodes may pick a mode per collection: nodeId → collectionId → modeId.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub variable_modes: Option<Map<Map<String>>>,
    /// Board: a board's document (always `true` when present).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub board: Option<bool>,
}
