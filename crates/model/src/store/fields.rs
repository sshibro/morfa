//! A stored node's fields by their TypeScript names and in types.ts's order: what crosses the boundary field by field
//! (crates/wasm `delta.rs`: the fields that changed, by a bit each) and what the stages name by key.

use super::node::{Node, Prop, PropKey};

/// One key of a node (`SceneNode` in types.ts): a fixed field, or an entry of the bag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Id,
    Kind,
    Name,
    ParentId,
    Children,
    Visible,
    Locked,
    Opacity,
    BlendMode,
    IsMask,
    X,
    Y,
    Width,
    Height,
    Rotation,
    Fills,
    Strokes,
    StrokeWeight,
    StrokeAlign,
    StrokeCap,
    StrokeJoin,
    StrokeMiterLimit,
    Effects,
    Constraints,
    LayoutPositioning,
    LayoutSizingHorizontal,
    LayoutSizingVertical,
    Prop(PropKey),
}

macro_rules! all {
    ($($field:expr => $name:literal,)*) => {
        /// Every field in types.ts's order (the order `SceneNode` serializes in): a field's bit in a change mask is its
        /// index here.
        pub const ALL: &[Field] = &[$($field,)*];
        const NAMES: &[&str] = &[$($name,)*];
    };
}

all! {
    Field::Id => "id",
    Field::Kind => "type",
    Field::Name => "name",
    Field::ParentId => "parentId",
    Field::Children => "children",
    Field::Visible => "visible",
    Field::Locked => "locked",
    Field::Opacity => "opacity",
    Field::BlendMode => "blendMode",
    Field::IsMask => "isMask",
    Field::Prop(PropKey::MaskType) => "maskType",
    Field::X => "x",
    Field::Y => "y",
    Field::Width => "width",
    Field::Height => "height",
    Field::Rotation => "rotation",
    Field::Prop(PropKey::FlipX) => "flipX",
    Field::Prop(PropKey::FlipY) => "flipY",
    Field::Prop(PropKey::ConstrainProportions) => "constrainProportions",
    Field::Fills => "fills",
    Field::Strokes => "strokes",
    Field::StrokeWeight => "strokeWeight",
    Field::StrokeAlign => "strokeAlign",
    Field::StrokeCap => "strokeCap",
    Field::StrokeJoin => "strokeJoin",
    Field::StrokeMiterLimit => "strokeMiterLimit",
    Field::Prop(PropKey::DashPattern) => "dashPattern",
    Field::Effects => "effects",
    Field::Prop(PropKey::FillStyleId) => "fillStyleId",
    Field::Prop(PropKey::StrokeStyleId) => "strokeStyleId",
    Field::Prop(PropKey::EffectStyleId) => "effectStyleId",
    Field::Prop(PropKey::BoundVariables) => "boundVariables",
    Field::Constraints => "constraints",
    Field::LayoutPositioning => "layoutPositioning",
    Field::LayoutSizingHorizontal => "layoutSizingHorizontal",
    Field::LayoutSizingVertical => "layoutSizingVertical",
    Field::Prop(PropKey::MinWidth) => "minWidth",
    Field::Prop(PropKey::MaxWidth) => "maxWidth",
    Field::Prop(PropKey::MinHeight) => "minHeight",
    Field::Prop(PropKey::MaxHeight) => "maxHeight",
    Field::Prop(PropKey::ExportSettings) => "exportSettings",
    Field::Prop(PropKey::Reactions) => "reactions",
    Field::Prop(PropKey::CornerRadius) => "cornerRadius",
    Field::Prop(PropKey::RectangleCornerRadii) => "rectangleCornerRadii",
    Field::Prop(PropKey::CornerSmoothing) => "cornerSmoothing",
    Field::Prop(PropKey::IndividualStrokeWeights) => "individualStrokeWeights",
    Field::Prop(PropKey::ClipsContent) => "clipsContent",
    Field::Prop(PropKey::AutoLayout) => "autoLayout",
    Field::Prop(PropKey::LayoutGrids) => "layoutGrids",
    Field::Prop(PropKey::GridStyleId) => "gridStyleId",
    Field::Prop(PropKey::OverflowDirection) => "overflowDirection",
    Field::Prop(PropKey::OverlayPositionType) => "overlayPositionType",
    Field::Prop(PropKey::OverlayBackground) => "overlayBackground",
    Field::Prop(PropKey::OverlayBackgroundInteraction) => "overlayBackgroundInteraction",
    Field::Prop(PropKey::ScrollBehavior) => "scrollBehavior",
    Field::Prop(PropKey::BackgroundColor) => "backgroundColor",
    Field::Prop(PropKey::Guides) => "guides",
    Field::Prop(PropKey::FlowStartingPoints) => "flowStartingPoints",
    Field::Prop(PropKey::PrototypeDevice) => "prototypeDevice",
    Field::Prop(PropKey::PrototypeBackground) => "prototypeBackground",
    Field::Prop(PropKey::ArcData) => "arcData",
    Field::Prop(PropKey::PointCount) => "pointCount",
    Field::Prop(PropKey::InnerRadius) => "innerRadius",
    Field::Prop(PropKey::StrokeStartMarker) => "strokeStartMarker",
    Field::Prop(PropKey::StrokeEndMarker) => "strokeEndMarker",
    Field::Prop(PropKey::VariableWidthStrokeProperties) => "variableWidthStrokeProperties",
    Field::Prop(PropKey::VectorPaths) => "vectorPaths",
    Field::Prop(PropKey::BooleanOperation) => "booleanOperation",
    Field::Prop(PropKey::Text) => "text",
    Field::Prop(PropKey::TextStyleId) => "textStyleId",
    Field::Prop(PropKey::TextPath) => "textPath",
    Field::Prop(PropKey::Annotations) => "annotations",
    Field::Prop(PropKey::Measurements) => "measurements",
    Field::Prop(PropKey::Description) => "description",
    Field::Prop(PropKey::ComponentPropertyDefinitions) => "componentPropertyDefinitions",
    Field::Prop(PropKey::ComponentPropertyReferences) => "componentPropertyReferences",
    Field::Prop(PropKey::ComponentId) => "componentId",
    Field::Prop(PropKey::ComponentProperties) => "componentProperties",
    Field::Prop(PropKey::IsExposedInstance) => "isExposedInstance",
    Field::Prop(PropKey::MainId) => "mainId",
    Field::Prop(PropKey::Overrides) => "overrides",
    Field::Prop(PropKey::PluginData) => "pluginData",
    Field::Prop(PropKey::Remote) => "remote",
    Field::Prop(PropKey::Board) => "board",
    Field::Prop(PropKey::Grid) => "grid",
    Field::Prop(PropKey::GridChild) => "gridChild",
}

/// The bit of each bag key in a change mask (its index in [`ALL`]), by the key's discriminant: a table built once,
/// at compile time (a change mask is computed for every node compared; lane N1 step 9).
const PROP_BITS: [u32; 128] = {
    let mut bits = [u32::MAX; 128];
    let mut index = 0;
    while index < ALL.len() {
        if let Field::Prop(key) = ALL[index] {
            bits[key as usize] = index as u32;
        }
        index += 1;
    }
    bits
};

/// The bit of a bag key in a change mask (its index in [`ALL`]).
#[inline]
const fn prop_bit(key: PropKey) -> u32 {
    PROP_BITS[key as usize]
}

/// A fixed field's place among the fixed fields (the order of the enum), for [`FIXED_BITS`].
const fn fixed_ordinal(field: Field) -> usize {
    match field {
        Field::Id => 0,
        Field::Kind => 1,
        Field::Name => 2,
        Field::ParentId => 3,
        Field::Children => 4,
        Field::Visible => 5,
        Field::Locked => 6,
        Field::Opacity => 7,
        Field::BlendMode => 8,
        Field::IsMask => 9,
        Field::X => 10,
        Field::Y => 11,
        Field::Width => 12,
        Field::Height => 13,
        Field::Rotation => 14,
        Field::Fills => 15,
        Field::Strokes => 16,
        Field::StrokeWeight => 17,
        Field::StrokeAlign => 18,
        Field::StrokeCap => 19,
        Field::StrokeJoin => 20,
        Field::StrokeMiterLimit => 21,
        Field::Effects => 22,
        Field::Constraints => 23,
        Field::LayoutPositioning => 24,
        Field::LayoutSizingHorizontal => 25,
        Field::LayoutSizingVertical => 26,
        Field::Prop(_) => usize::MAX,
    }
}

const FIXED_COUNT: usize = 27;

/// The bit of each fixed field (its index in [`ALL`]), by [`fixed_ordinal`].
const FIXED_BITS: [u32; FIXED_COUNT] = {
    let mut bits = [u32::MAX; FIXED_COUNT];
    let mut index = 0;
    while index < ALL.len() {
        if let Field::Prop(_) = ALL[index] {
        } else {
            bits[fixed_ordinal(ALL[index])] = index as u32;
        }
        index += 1;
    }
    bits
};

impl Field {
    /// The key in types.ts (and in the JSON).
    pub fn name(self) -> &'static str {
        NAMES[self.bit() as usize]
    }

    /// The field with this TS key.
    pub fn from_name(name: &str) -> Option<Field> {
        NAMES
            .iter()
            .position(|candidate| *candidate == name)
            .map(|index| ALL[index])
    }

    /// The field's bit in a change mask: its index in [`ALL`].
    #[inline]
    pub const fn bit(self) -> u32 {
        match self {
            Field::Prop(key) => prop_bit(key),
            fixed => FIXED_BITS[fixed_ordinal(fixed)],
        }
    }
}

/// Bit `i` set: field `i` of [`ALL`] differs between the two nodes (types.ts's `deepEqual` per key; shared values by
/// pointer first). The fixed fields are compared one by one; the two bags are merged by key, so an entry only one
/// node has is a change (a `dashPattern`, `exportSettings` or `reactions` entry only one has is `[]` against a list).
pub fn changed_mask(next: &Node, base: &Node) -> u128 {
    let mut mask = 0u128;
    macro_rules! fixed {
        ($($variant:ident $field:ident),* $(,)?) => {
            $(if next.$field != base.$field { mask |= 1u128 << Field::$variant.bit(); })*
        };
    }
    fixed!(
        Id id,
        Kind kind,
        Name name,
        ParentId parent,
        Children children,
        Visible visible,
        Locked locked,
        Opacity opacity,
        BlendMode blend_mode,
        IsMask is_mask,
        X x,
        Y y,
        Width width,
        Height height,
        Rotation rotation,
        Fills fills,
        Strokes strokes,
        StrokeWeight stroke_weight,
        StrokeAlign stroke_align,
        StrokeCap stroke_cap,
        StrokeJoin stroke_join,
        StrokeMiterLimit stroke_miter_limit,
        Effects effects,
        Constraints constraints,
        LayoutPositioning layout_positioning,
        LayoutSizingHorizontal layout_sizing_horizontal,
        LayoutSizingVertical layout_sizing_vertical,
    );
    if next.props.ptr_eq(&base.props) {
        return mask;
    }
    let (a, b) = (next.props.as_slice(), base.props.as_slice());
    let (mut i, mut j) = (0, 0);
    loop {
        match (a.get(i).map(Prop::key), b.get(j).map(Prop::key)) {
            (Some(ka), Some(kb)) if ka == kb => {
                if !(a[i].ptr_eq(&b[j]) || a[i] == b[j]) {
                    mask |= 1u128 << prop_bit(ka);
                }
                i += 1;
                j += 1;
            }
            (Some(ka), Some(kb)) if ka < kb => {
                mask |= 1u128 << prop_bit(ka);
                i += 1;
            }
            (Some(_), Some(kb)) => {
                mask |= 1u128 << prop_bit(kb);
                j += 1;
            }
            (Some(ka), None) => {
                mask |= 1u128 << prop_bit(ka);
                i += 1;
            }
            (None, Some(kb)) => {
                mask |= 1u128 << prop_bit(kb);
                j += 1;
            }
            (None, None) => break,
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_order_is_the_json_models_and_every_key_is_listed_once() {
        assert_eq!(ALL.len(), NAMES.len());
        assert!(ALL.len() <= 128);
        // The bit tables name each field's place.
        for (index, field) in ALL.iter().enumerate() {
            assert_eq!(field.bit() as usize, index, "{field:?}");
        }
        assert_eq!(
            ALL.iter()
                .filter(|field| !matches!(field, Field::Prop(_)))
                .count(),
            FIXED_COUNT
        );
        // The JSON model's field order: a node serialized, its keys in order.
        let doc: crate::DesignDocument = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "pages": ["p"],
            "nodes": {"p": {"id": "p", "type": "PAGE", "name": "p", "parentId": null, "children": [], "visible": true,
                "locked": false, "opacity": 1, "blendMode": "NORMAL", "isMask": false, "x": 0, "y": 0, "width": 0,
                "height": 0, "rotation": 0, "fills": [], "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE",
                "strokeCap": "NONE", "strokeJoin": "MITER", "strokeMiterLimit": 4, "dashPattern": [], "effects": [],
                "constraints": {"horizontal": "MIN", "vertical": "MIN"}, "layoutPositioning": "AUTO",
                "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED", "exportSettings": [], "reactions": []}},
            "styles": {}, "images": {}, "variableCollections": {}, "variables": {}
        }))
        .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&crate::to_json(&doc.nodes["p"])).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        // The keys a page carries, in the model's order, appear in `ALL` in the same order.
        let positions: Vec<usize> = keys
            .iter()
            .map(|key| {
                NAMES
                    .iter()
                    .position(|name| name == key)
                    .unwrap_or_else(|| panic!("{key}"))
            })
            .collect();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "{positions:?}"
        );
        for (index, field) in ALL.iter().enumerate() {
            assert_eq!(field.bit() as usize, index);
            assert_eq!(Field::from_name(field.name()), Some(*field));
        }
        // Every bag key is listed.
        for prop in [PropKey::MaskType, PropKey::Board, PropKey::Text] {
            assert!(ALL.contains(&Field::Prop(prop)));
        }
    }
}
