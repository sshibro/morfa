//! A stored [`Node`]'s fields by their TypeScript names over the store's node
//! (fixed fields inline, the rest in its [`Props`] bag). components.ts treats a node as a bag of keys; a [`Field`] is
//! one key. An optional field is a bag entry; absent means the key is `undefined`.

use std::sync::Arc;

use morfa_model::store::{Node, Prop, PropKey, Props};

/// One key of a node, by its TS name ([`Field::name`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Fixed(Fixed),
    Prop(PropKey),
}

/// The fields every node has inline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Fixed {
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
}

macro_rules! fixed {
    ($($variant:ident $ts:literal $field:ident;)*) => {
        const FIXED: &[(Fixed, &str)] = &[$((Fixed::$variant, $ts),)*];

        impl Fixed {
            pub fn name(self) -> &'static str {
                match self {
                    $(Fixed::$variant => $ts,)*
                }
            }

            fn copy(self, to: &mut Node, from: &Node) {
                match self {
                    $(Fixed::$variant => to.$field.clone_from(&from.$field),)*
                }
            }

            fn same(self, a: &Node, b: &Node) -> bool {
                match self {
                    $(Fixed::$variant => a.$field == b.$field,)*
                }
            }
        }
    };
}

fixed! {
    Id "id" id;
    Kind "type" kind;
    Name "name" name;
    ParentId "parentId" parent;
    Children "children" children;
    Visible "visible" visible;
    Locked "locked" locked;
    Opacity "opacity" opacity;
    BlendMode "blendMode" blend_mode;
    IsMask "isMask" is_mask;
    X "x" x;
    Y "y" y;
    Width "width" width;
    Height "height" height;
    Rotation "rotation" rotation;
    Fills "fills" fills;
    Strokes "strokes" strokes;
    StrokeWeight "strokeWeight" stroke_weight;
    StrokeAlign "strokeAlign" stroke_align;
    StrokeCap "strokeCap" stroke_cap;
    StrokeJoin "strokeJoin" stroke_join;
    StrokeMiterLimit "strokeMiterLimit" stroke_miter_limit;
    Effects "effects" effects;
    Constraints "constraints" constraints;
    LayoutPositioning "layoutPositioning" layout_positioning;
    LayoutSizingHorizontal "layoutSizingHorizontal" layout_sizing_horizontal;
    LayoutSizingVertical "layoutSizingVertical" layout_sizing_vertical;
}

macro_rules! props {
    ($($variant:ident $ts:literal;)*) => {
        const PROPS: &[(PropKey, &str)] = &[$((PropKey::$variant, $ts),)*];
    };
}

props! {
    MaskType "maskType";
    FlipX "flipX";
    FlipY "flipY";
    ConstrainProportions "constrainProportions";
    DashPattern "dashPattern";
    FillStyleId "fillStyleId";
    StrokeStyleId "strokeStyleId";
    EffectStyleId "effectStyleId";
    BoundVariables "boundVariables";
    MinWidth "minWidth";
    MaxWidth "maxWidth";
    MinHeight "minHeight";
    MaxHeight "maxHeight";
    ExportSettings "exportSettings";
    Reactions "reactions";
    CornerRadius "cornerRadius";
    RectangleCornerRadii "rectangleCornerRadii";
    CornerSmoothing "cornerSmoothing";
    IndividualStrokeWeights "individualStrokeWeights";
    ClipsContent "clipsContent";
    AutoLayout "autoLayout";
    LayoutGrids "layoutGrids";
    GridStyleId "gridStyleId";
    OverflowDirection "overflowDirection";
    OverlayPositionType "overlayPositionType";
    OverlayBackground "overlayBackground";
    OverlayBackgroundInteraction "overlayBackgroundInteraction";
    ScrollBehavior "scrollBehavior";
    BackgroundColor "backgroundColor";
    Guides "guides";
    FlowStartingPoints "flowStartingPoints";
    PrototypeDevice "prototypeDevice";
    PrototypeBackground "prototypeBackground";
    ArcData "arcData";
    PointCount "pointCount";
    InnerRadius "innerRadius";
    StrokeStartMarker "strokeStartMarker";
    StrokeEndMarker "strokeEndMarker";
    VariableWidthStrokeProperties "variableWidthStrokeProperties";
    VectorPaths "vectorPaths";
    BooleanOperation "booleanOperation";
    Text "text";
    TextStyleId "textStyleId";
    TextPath "textPath";
    Annotations "annotations";
    Measurements "measurements";
    Description "description";
    ComponentPropertyDefinitions "componentPropertyDefinitions";
    ComponentPropertyReferences "componentPropertyReferences";
    ComponentId "componentId";
    ComponentProperties "componentProperties";
    IsExposedInstance "isExposedInstance";
    MainId "mainId";
    Overrides "overrides";
    PluginData "pluginData";
    Remote "remote";
    Board "board";
    Grid "grid";
    GridChild "gridChild";
}

impl Field {
    /// The key in types.ts (and in the JSON).
    pub fn name(self) -> &'static str {
        match self {
            Field::Fixed(fixed) => fixed.name(),
            Field::Prop(key) => PROPS
                .iter()
                .find(|(candidate, _)| *candidate == key)
                .map(|(_, name)| *name)
                .expect("every bag key is listed"),
        }
    }

    /// The field with this TS key.
    pub fn from_name(name: &str) -> Option<Field> {
        if let Some((fixed, _)) = FIXED.iter().find(|(_, candidate)| *candidate == name) {
            return Some(Field::Fixed(*fixed));
        }
        PROPS
            .iter()
            .find(|(_, candidate)| *candidate == name)
            .map(|(key, _)| Field::Prop(*key))
    }

    /// `to[key] = from[key]`, or `delete to[key]` when `from` lacks it.
    pub fn copy(self, to: &mut Node, from: &Node) {
        match self {
            Field::Fixed(fixed) => fixed.copy(to, from),
            Field::Prop(key) => match from.props.get(key) {
                Some(prop) => {
                    if !to.props.get(key).is_some_and(|mine| mine.ptr_eq(prop)) {
                        to.props.set(prop.clone());
                    }
                }
                None => {
                    to.props.remove(key);
                }
            },
        }
    }

    /// `deepEqual(a[key], b[key])`.
    pub fn same(self, a: &Node, b: &Node) -> bool {
        match self {
            Field::Fixed(fixed) => fixed.same(a, b),
            Field::Prop(key) => match (a.props.get(key), b.props.get(key)) {
                (Some(a), Some(b)) => a.ptr_eq(b) || a == b,
                (None, None) => true,
                _ => false,
            },
        }
    }

    /// A copy of `node` without the fields in `skip`: what `for (const key in from) if (!skip.has(key)) node[key] =
    /// from[key]` builds. A skipped fixed field keeps the node's own value except `children`, which is left out (the
    /// caller sets the fields it skipped).
    pub fn clone_except(node: &Node, skip: FieldSet) -> Node {
        let mut out = node.clone();
        if skip.has(Field::Fixed(Fixed::Children)) {
            out.children = None;
        }
        if skip.props != 0 {
            let props: Vec<Prop> = node
                .props
                .iter()
                .filter(|prop| !skip.has(Field::Prop(prop.key())))
                .cloned()
                .collect();
            if props.len() != node.props.len() {
                out.props = Props::from_sorted(props);
            }
        }
        out
    }

    /// Every field but those in `skip` equal (`deepEqual` field by field), shared values by pointer first.
    pub fn all_same_except(a: &Node, b: &Node, skip: FieldSet) -> bool {
        for (fixed, _) in FIXED {
            if !skip.has(Field::Fixed(*fixed)) && !fixed.same(a, b) {
                return false;
            }
        }
        if a.props.ptr_eq(&b.props) && skip.props == 0 {
            return true;
        }
        let (a, b) = (a.props.as_slice(), b.props.as_slice());
        let (mut i, mut j) = (0, 0);
        while i < a.len() || j < b.len() {
            let next_a = a.get(i).map(Prop::key);
            let next_b = b.get(j).map(Prop::key);
            match (next_a, next_b) {
                (Some(ka), Some(kb)) if ka == kb => {
                    if !skip.has(Field::Prop(ka)) && !(a[i].ptr_eq(&b[j]) || a[i] == b[j]) {
                        return false;
                    }
                    i += 1;
                    j += 1;
                }
                (Some(ka), Some(kb)) if ka < kb => {
                    if !skip.has(Field::Prop(ka)) {
                        return false;
                    }
                    i += 1;
                }
                (Some(_), Some(kb)) => {
                    if !skip.has(Field::Prop(kb)) {
                        return false;
                    }
                    j += 1;
                }
                (Some(ka), None) => {
                    if !skip.has(Field::Prop(ka)) {
                        return false;
                    }
                    i += 1;
                }
                (None, Some(kb)) => {
                    if !skip.has(Field::Prop(kb)) {
                        return false;
                    }
                    j += 1;
                }
                (None, None) => break,
            }
        }
        true
    }
}

/// A small set of fields (a bit per fixed field and per bag key).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FieldSet {
    fixed: u32,
    props: u64,
}

impl FieldSet {
    pub const fn empty() -> Self {
        FieldSet { fixed: 0, props: 0 }
    }

    /// The fields named (each must be a field: checked by the tests).
    pub fn of(names: &[&str]) -> Self {
        let mut set = FieldSet::empty();
        for name in names {
            if let Some(field) = Field::from_name(name) {
                set = set.with(field);
            }
        }
        set
    }

    pub const fn with(self, field: Field) -> Self {
        match field {
            Field::Fixed(fixed) => FieldSet {
                fixed: self.fixed | 1 << fixed as u32,
                props: self.props,
            },
            Field::Prop(key) => FieldSet {
                fixed: self.fixed,
                props: self.props | 1 << key as u32,
            },
        }
    }

    pub const fn has(self, field: Field) -> bool {
        match field {
            Field::Fixed(fixed) => self.fixed & (1 << fixed as u32) != 0,
            Field::Prop(key) => self.props & (1 << key as u32) != 0,
        }
    }
}

/// Keeps a shared value shared: `Arc::clone` for a bag value (the caller writes it into another node's bag).
pub fn share<T>(value: &Arc<T>) -> Arc<T> {
    Arc::clone(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_field_has_its_typescript_name_and_the_old_table_agrees() {
        assert!(PROPS.len() <= 64 && FIXED.len() <= 32);
        for name in morfa_model::store::fields::ALL
            .iter()
            .map(|field| field.name())
        {
            let field = Field::from_name(name).unwrap_or_else(|| panic!("{name}"));
            assert_eq!(field.name(), name);
        }
        assert_eq!(Field::from_name("type"), Some(Field::Fixed(Fixed::Kind)));
        assert_eq!(Field::from_name("text"), Some(Field::Prop(PropKey::Text)));
        assert_eq!(Field::from_name("kind"), None);
        let set = FieldSet::of(&["id", "text", "children"]);
        assert!(set.has(Field::Fixed(Fixed::Id)) && set.has(Field::Prop(PropKey::Text)));
        assert!(!set.has(Field::Fixed(Fixed::Name)));
    }
}
