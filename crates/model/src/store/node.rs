//! One stored node: the fields every layer has and the hot paths read (tree links, box, paints) inline, and the
//! type-specific or rarely set ones in a sorted property bag.
//!
//! The bag (`Props`) holds one [`Prop`] per field that is present: a rectangle carries two (corner radius and
//! smoothing), a frame about six, a text one (its `TextProps`, shared). Reading a field scans a handful of 24-byte
//! entries; writing one copies the bag. Lists that the JSON always carries but are nearly always empty
//! (`dashPattern`, `exportSettings`, `reactions`) live in the bag only when non-empty.

use super::value::*;
use super::{Atom, Id, List};
use crate::types::{
    ArcData, AutoLayout, BlendMode, BooleanOperation, Constraints, Guide, IndividualStrokeWeights,
    LayoutPositioning, LayoutSizing, MaskType, NodeType, OverflowDirection,
    OverlayBackgroundInteraction, OverlayPosition, RemoteAsset, Rgb, ScrollBehavior, StrokeAlign,
    StrokeCap, StrokeJoin, StrokeMarker,
};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::sync::Arc;

/// A stored node (`SceneNode` in types.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: Id,
    /// `None` for pages only.
    pub parent: Option<Id>,
    pub name: Atom,
    pub kind: NodeType,
    pub blend_mode: BlendMode,
    pub stroke_align: StrokeAlign,
    pub stroke_cap: StrokeCap,
    pub stroke_join: StrokeJoin,
    pub layout_positioning: LayoutPositioning,
    pub layout_sizing_horizontal: LayoutSizing,
    pub layout_sizing_vertical: LayoutSizing,
    pub constraints: Constraints,
    pub visible: bool,
    pub locked: bool,
    pub is_mask: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub opacity: f64,
    pub stroke_weight: f64,
    pub stroke_miter_limit: f64,
    /// Containers only, bottom-to-top.
    pub children: Option<Arc<[Id]>>,
    pub fills: List<Paint>,
    pub strokes: List<Paint>,
    pub effects: List<Effect>,
    pub props: Props,
}

/// Declares the property bag: the [`Prop`] enum (variant order is the bag's order and the binary format's tag),
/// [`PropKey`], a typed getter per field, and equality that compares a shared value by pointer first (`arc`,
/// `optarc`, `list`: two versions of a document share unchanged values, so most comparisons end at the pointer;
/// `plain` values compare by value).
macro_rules! props {
    ($($(#[$doc:meta])* $variant:ident($ty:ty) => $getter:ident [$kind:ident];)*) => {
        /// One present type-specific or optional field of a node.
        #[derive(Debug, Clone, Serialize, Deserialize)]
        pub enum Prop {
            $($(#[$doc])* $variant($ty),)*
        }

        /// Which field a [`Prop`] is.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum PropKey {
            $($variant,)*
        }

        impl Prop {
            pub fn key(&self) -> PropKey {
                match self {
                    $(Prop::$variant(_) => PropKey::$variant,)*
                }
            }

            /// Whether both hold the same shared value (the pointer), without comparing the values.
            pub fn ptr_eq(&self, other: &Prop) -> bool {
                match (self, other) {
                    $((Prop::$variant(a), Prop::$variant(b)) => props!(@ptr $kind a, b),)*
                    _ => false,
                }
            }
        }

        impl PartialEq for Prop {
            fn eq(&self, other: &Prop) -> bool {
                match (self, other) {
                    $((Prop::$variant(a), Prop::$variant(b)) => props!(@eq $kind a, b),)*
                    _ => false,
                }
            }
        }

        impl Props {
            $(
                #[inline]
                pub fn $getter(&self) -> Option<&$ty> {
                    match self.get(PropKey::$variant) {
                        Some(Prop::$variant(value)) => Some(value),
                        _ => None,
                    }
                }
            )*
        }
    };
    (@eq plain $a:ident, $b:ident) => { $a == $b };
    (@eq arc $a:ident, $b:ident) => { Arc::ptr_eq($a, $b) || **$a == **$b };
    (@eq optarc $a:ident, $b:ident) => {
        match ($a, $b) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b) || **a == **b,
            (None, None) => true,
            _ => false,
        }
    };
    (@eq list $a:ident, $b:ident) => { $a == $b };
    (@ptr plain $a:ident, $b:ident) => { $a == $b };
    (@ptr arc $a:ident, $b:ident) => { Arc::ptr_eq($a, $b) };
    (@ptr optarc $a:ident, $b:ident) => {
        match ($a, $b) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    };
    (@ptr list $a:ident, $b:ident) => { $a.ptr_eq($b) };
}

props! {
    MaskType(MaskType) => mask_type [plain];
    FlipX(bool) => flip_x [plain];
    FlipY(bool) => flip_y [plain];
    ConstrainProportions(bool) => constrain_proportions [plain];
    /// Present only when non-empty (the JSON always carries `dashPattern`).
    DashPattern(List<f64>) => dash_pattern [list];
    FillStyleId(Atom) => fill_style_id [plain];
    StrokeStyleId(Atom) => stroke_style_id [plain];
    EffectStyleId(Atom) => effect_style_id [plain];
    /// Field → variable.
    BoundVariables(Arc<IndexMap<Atom, Atom>>) => bound_variables [arc];
    /// `None` is an explicit `null`.
    MinWidth(Option<f64>) => min_width [plain];
    MaxWidth(Option<f64>) => max_width [plain];
    MinHeight(Option<f64>) => min_height [plain];
    MaxHeight(Option<f64>) => max_height [plain];
    /// Present only when non-empty.
    ExportSettings(List<ExportSetting>) => export_settings [list];
    /// Present only when non-empty.
    Reactions(List<Reaction>) => reactions [list];
    CornerRadius(f64) => corner_radius [plain];
    /// `None` is an explicit `null`.
    RectangleCornerRadii(Option<Arc<[f64; 4]>>) => rectangle_corner_radii [optarc];
    CornerSmoothing(f64) => corner_smoothing [plain];
    /// `None` is an explicit `null`.
    IndividualStrokeWeights(Option<Arc<IndividualStrokeWeights>>) => individual_stroke_weights [optarc];
    ClipsContent(bool) => clips_content [plain];
    AutoLayout(Arc<AutoLayout>) => auto_layout [arc];
    LayoutGrids(List<LayoutGrid>) => layout_grids [list];
    GridStyleId(Atom) => grid_style_id [plain];
    OverflowDirection(OverflowDirection) => overflow_direction [plain];
    OverlayPositionType(OverlayPosition) => overlay_position_type [plain];
    OverlayBackground(Arc<OverlayBackground>) => overlay_background [arc];
    OverlayBackgroundInteraction(OverlayBackgroundInteraction) => overlay_background_interaction [plain];
    ScrollBehavior(ScrollBehavior) => scroll_behavior [plain];
    BackgroundColor(Arc<Rgb>) => background_color [arc];
    Guides(List<Guide>) => guides [list];
    FlowStartingPoints(List<FlowStartingPoint>) => flow_starting_points [list];
    PrototypeDevice(Arc<PrototypeDevice>) => prototype_device [arc];
    PrototypeBackground(Arc<Rgb>) => prototype_background [arc];
    ArcData(Arc<ArcData>) => arc_data [arc];
    PointCount(f64) => point_count [plain];
    InnerRadius(f64) => inner_radius [plain];
    StrokeStartMarker(StrokeMarker) => stroke_start_marker [plain];
    StrokeEndMarker(StrokeMarker) => stroke_end_marker [plain];
    VariableWidthStrokeProperties(Arc<VariableWidthStroke>) => variable_width_stroke_properties [arc];
    VectorPaths(List<VectorPath>) => vector_paths [list];
    BooleanOperation(BooleanOperation) => boolean_operation [plain];
    Text(Arc<TextProps>) => text [arc];
    TextStyleId(Atom) => text_style_id [plain];
    TextPath(Arc<TextPath>) => text_path [arc];
    Annotations(List<Annotation>) => annotations [list];
    Measurements(List<Measurement>) => measurements [list];
    Description(Arc<str>) => description [arc];
    ComponentPropertyDefinitions(Arc<IndexMap<Atom, PropertyDefinition>>) => component_property_definitions [arc];
    ComponentPropertyReferences(Arc<PropertyReferences>) => component_property_references [arc];
    ComponentId(Id) => component_id [plain];
    ComponentProperties(Arc<IndexMap<Atom, PropertyValue>>) => component_properties [arc];
    IsExposedInstance(bool) => is_exposed_instance [plain];
    MainId(Id) => main_id [plain];
    Overrides(List<Atom>) => overrides [list];
    PluginData(Arc<IndexMap<Atom, Arc<str>>>) => plugin_data [arc];
    Remote(Arc<RemoteAsset>) => remote [arc];
    Board(Arc<BoardMeta>) => board [arc];
    // Appended (store/value.rs: variants by position).
    Grid(Arc<GridLayout>) => grid [arc];
    GridChild(Arc<GridChild>) => grid_child [arc];
}

/// A node's present optional fields, sorted by [`PropKey`], shared between versions until one is written.
#[derive(Clone, Default)]
pub struct Props(Option<Arc<[Prop]>>);

/// Two bags are equal when they are the same shared list (the pointer first), else entry by entry, each entry's
/// shared value by pointer first ([`Prop::eq`]).
impl PartialEq for Props {
    fn eq(&self, other: &Self) -> bool {
        self.ptr_eq(other) || self.as_slice() == other.as_slice()
    }
}

impl Props {
    /// The bag of `props` (sorted here; a later duplicate replaces an earlier one).
    pub fn new(mut props: Vec<Prop>) -> Self {
        props.sort_by_key(Prop::key);
        props.dedup_by(|later, earlier| {
            let same = later.key() == earlier.key();
            if same {
                std::mem::swap(later, earlier);
            }
            same
        });
        if props.is_empty() {
            Props(None)
        } else {
            Props(Some(props.into()))
        }
    }

    /// A bag from props already sorted by key with no key twice (a bag changed entry by entry).
    pub fn from_sorted(props: Vec<Prop>) -> Self {
        debug_assert!(props.windows(2).all(|pair| pair[0].key() < pair[1].key()));
        if props.is_empty() {
            Props(None)
        } else {
            Props(Some(props.into()))
        }
    }

    pub fn as_slice(&self) -> &[Prop] {
        self.0.as_deref().unwrap_or(&[])
    }

    /// Whether both are the same shared list (both empty counts).
    pub fn ptr_eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Prop> {
        self.as_slice().iter()
    }

    pub fn len(&self) -> usize {
        self.as_slice().len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_none()
    }

    #[inline]
    pub fn get(&self, key: PropKey) -> Option<&Prop> {
        for prop in self.as_slice() {
            match prop.key().cmp(&key) {
                std::cmp::Ordering::Less => continue,
                std::cmp::Ordering::Equal => return Some(prop),
                std::cmp::Ordering::Greater => return None,
            }
        }
        None
    }

    /// Sets a field, replacing its previous value. A value equal to the stored one (by pointer first) leaves the bag as
    /// it is, shared.
    pub fn set(&mut self, prop: Prop) {
        let mut props = match self.as_slice().binary_search_by_key(&prop.key(), Prop::key) {
            Ok(index) if self.as_slice()[index] == prop => return,
            Ok(index) => {
                let mut props = self.as_slice().to_vec();
                props[index] = prop;
                props
            }
            Err(index) => {
                let mut props = Vec::with_capacity(self.len() + 1);
                props.extend_from_slice(&self.as_slice()[..index]);
                props.push(prop);
                props.extend_from_slice(&self.as_slice()[index..]);
                props
            }
        };
        props.shrink_to_fit();
        self.0 = Some(props.into());
    }

    /// Removes a field; its previous value, if it was set.
    pub fn remove(&mut self, key: PropKey) -> Option<Prop> {
        let index = self.as_slice().binary_search_by_key(&key, Prop::key).ok()?;
        let mut props = self.as_slice().to_vec();
        let removed = props.remove(index);
        self.0 = if props.is_empty() {
            None
        } else {
            Some(props.into())
        };
        Some(removed)
    }

    /// Heap bytes of the bag itself (not of what its entries point to).
    pub fn heap_bytes(&self) -> usize {
        self.0.as_ref().map_or(0, |props| {
            2 * std::mem::size_of::<usize>() + std::mem::size_of_val(&**props)
        })
    }
}

impl fmt::Debug for Props {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.debug_list().entries(self.iter()).finish()
    }
}

impl Serialize for Props {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.iter())
    }
}

impl<'de> Deserialize<'de> for Props {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<Prop>::deserialize(deserializer).map(Props::new)
    }
}

impl Node {
    pub fn is_container(&self) -> bool {
        self.kind.is_container()
    }

    #[inline]
    pub fn children(&self) -> &[Id] {
        self.children.as_deref().unwrap_or(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        // Kept small on purpose: a 20 000-layer file holds 20 000 of these.
        assert!(
            std::mem::size_of::<Node>() <= 176,
            "{}",
            std::mem::size_of::<Node>()
        );
        assert_eq!(std::mem::size_of::<Prop>(), 24);
        assert_eq!(std::mem::size_of::<Props>(), 16);
    }

    #[test]
    fn bag_is_sorted_and_replaces() {
        let mut props = Props::new(vec![
            Prop::CornerSmoothing(0.0),
            Prop::CornerRadius(4.0),
            Prop::CornerRadius(8.0),
        ]);
        assert_eq!(props.len(), 2);
        assert_eq!(props.corner_radius(), Some(&8.0));
        props.set(Prop::ClipsContent(true));
        props.set(Prop::CornerRadius(2.0));
        assert_eq!(
            props.iter().map(Prop::key).collect::<Vec<_>>(),
            [
                PropKey::CornerRadius,
                PropKey::CornerSmoothing,
                PropKey::ClipsContent
            ]
        );
        assert_eq!(props.corner_radius(), Some(&2.0));
        assert_eq!(
            props.remove(PropKey::CornerSmoothing),
            Some(Prop::CornerSmoothing(0.0))
        );
        assert_eq!(props.text(), None);
    }
}
