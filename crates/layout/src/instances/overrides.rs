//! Overrides (components.ts §Overrides) on store nodes. Override paths are
//! strings in the TypeScript (`text.characters`, `fills`); a copy's list is a `List<Atom>` in the store, resolved to
//! text where it is parsed and merged (copies with overrides only).

use std::sync::Arc;

use indexmap::IndexMap;
use morfa_model::store::draft::Working;
use morfa_model::store::{Atom, GridLayout, Node, Prop, PropKey, TextProps, TextStyle};
use morfa_model::types::AutoLayout;

/// `OVERRIDABLE_FIELDS`: fields a copy can override (or the INSTANCE itself, except its placement).
pub const OVERRIDABLE_FIELDS: &[&str] = &[
    "name",
    "visible",
    "locked",
    "opacity",
    "blendMode",
    "isMask",
    "maskType",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "flipX",
    "flipY",
    "constrainProportions",
    "fills",
    "strokes",
    "strokeWeight",
    "strokeAlign",
    "strokeCap",
    "strokeJoin",
    "strokeMiterLimit",
    "dashPattern",
    "effects",
    "fillStyleId",
    "strokeStyleId",
    "effectStyleId",
    "boundVariables",
    "constraints",
    "layoutPositioning",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "exportSettings",
    "reactions",
    "cornerRadius",
    "rectangleCornerRadii",
    "cornerSmoothing",
    "individualStrokeWeights",
    "clipsContent",
    "autoLayout",
    "grid",
    "gridChild",
    "layoutGrids",
    "gridStyleId",
    "overflowDirection",
    "overlayPositionType",
    "overlayBackground",
    "overlayBackgroundInteraction",
    "scrollBehavior",
    "arcData",
    "pointCount",
    "innerRadius",
    "strokeStartMarker",
    "strokeEndMarker",
    "variableWidthStrokeProperties",
    "vectorPaths",
    "booleanOperation",
    "text",
    "textStyleId",
    "textPath",
    "annotations",
    "componentId",
    "componentProperties",
    "pluginData",
];

/// `GRANULAR_OVERRIDE_FIELDS`: object fields tracked per part.
pub const GRANULAR_OVERRIDE_FIELDS: &[&str] = &[
    "text",
    "autoLayout",
    "grid",
    "componentProperties",
    "boundVariables",
];

/// `GRANULAR.has(head)`.
pub fn is_granular(head: &str) -> bool {
    GRANULAR_OVERRIDE_FIELDS.contains(&head)
}

/// One parsed head: the whole field (`true`) or the parts listed.
#[derive(Clone, Debug, PartialEq)]
pub enum Parts {
    Whole,
    Keys(Vec<String>),
}

/// `ParsedOverrides`: head → whole or parts, in first-seen order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parsed(pub IndexMap<String, Parts>);

impl Parsed {
    /// `parseOverrides`.
    pub fn parse(list: &[String]) -> Self {
        let mut map: IndexMap<String, Parts> = IndexMap::new();
        for path in list {
            let Some(dot) = path.find('.') else {
                map.insert(path.clone(), Parts::Whole);
                continue;
            };
            let head = &path[..dot];
            if !is_granular(head) {
                map.insert(path.clone(), Parts::Whole);
                continue;
            }
            let key = &path[dot + 1..];
            match map.get_mut(head) {
                Some(Parts::Whole) => {}
                Some(Parts::Keys(keys)) => keys.push(key.to_owned()),
                None => {
                    map.insert(head.to_owned(), Parts::Keys(vec![key.to_owned()]));
                }
            }
        }
        Parsed(map)
    }

    /// `overrides.has(key)`.
    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    pub fn get(&self, key: &str) -> Option<&Parts> {
        self.0.get(key)
    }
}

/// `path.startsWith(entry + '.')`.
pub fn under(path: &str, entry: &str) -> bool {
    path.len() > entry.len() && path.starts_with(entry) && path.as_bytes()[entry.len()] == b'.'
}

use super::fields::{Field, FieldSet, Fixed};

/// `PLACEMENT_FIELDS`, by name (the order `fromComponent` copies them in does not matter: each is one key).
pub const PLACEMENT_FIELDS: &[&str] = &[
    "x",
    "y",
    "rotation",
    "flipX",
    "flipY",
    "visible",
    "locked",
    "isMask",
    "maskType",
    "constraints",
    "layoutPositioning",
    "gridChild",
    "scrollBehavior",
    "componentPropertyReferences",
    "isExposedInstance",
    "pluginData",
];

/// The field sets components.ts keeps as `Set`s of keys, over the store's fields.
pub struct Sets {
    pub overridable: FieldSet,
    pub granular: FieldSet,
    /// `PLACEMENT_FIELDS`: where an instance sits, its own and never its main's.
    pub placement: FieldSet,
    /// `SWAP_PLACEMENT_FIELDS`: a swapped nested instance keeps its slot.
    pub swap_placement: FieldSet,
    /// `COMPONENT_ONLY`: fields of a COMPONENT an instance never takes.
    pub component_only: FieldSet,
    /// `COPY_IDENTITY`.
    pub copy_identity: FieldSet,
    /// `PLACEMENT_FIELDS` as fields, in the list's order (looked up once, not per copy: lane N1 step 9).
    pub placement_fields: Vec<Field>,
}

pub fn sets() -> &'static Sets {
    static SETS: std::sync::OnceLock<Sets> = std::sync::OnceLock::new();
    SETS.get_or_init(|| {
        let placement = FieldSet::of(PLACEMENT_FIELDS);
        Sets {
            overridable: FieldSet::of(OVERRIDABLE_FIELDS),
            granular: FieldSet::of(GRANULAR_OVERRIDE_FIELDS),
            placement,
            swap_placement: placement
                .with(Field::Fixed(Fixed::LayoutSizingHorizontal))
                .with(Field::Fixed(Fixed::LayoutSizingVertical)),
            component_only: FieldSet::of(&[
                "id",
                "parentId",
                "children",
                "description",
                "componentPropertyDefinitions",
                "remote",
            ]),
            copy_identity: FieldSet::of(&["id", "parentId", "children", "mainId", "overrides"]),
            placement_fields: PLACEMENT_FIELDS
                .iter()
                .map(|name| Field::from_name(name).expect("a field"))
                .collect(),
        }
    })
}

/// `parseOverrides` of a copy's list (atoms resolved to the paths).
pub fn parse(draft: &Working, list: &[Atom]) -> Parsed {
    let paths: Vec<String> = list
        .iter()
        .map(|atom| draft.atom(*atom).to_owned())
        .collect();
    Parsed::parse(&paths)
}

/// `overrides?.has(key)` on an optional parse.
pub fn has(overrides: Option<&Parsed>, key: &str) -> bool {
    overrides.is_some_and(|overrides| overrides.has(key))
}

/// `isPartOverridden(overrides, head, part)`.
pub fn is_part_overridden(overrides: Option<&Parsed>, head: &str, part: &str) -> bool {
    match overrides.and_then(|overrides| overrides.get(head)) {
        Some(Parts::Whole) => true,
        Some(Parts::Keys(keys)) => keys.iter().any(|key| key == part),
        None => false,
    }
}

// ── Merging parts ────────────────────────────────────────────────────────────────────────────────

/// `out[key] = own[key]` (or `delete out[key]` when `own` lacks it) for one key of a [`TextStyle`]. A required key
/// cannot be deleted from a typed style: it keeps `out`'s value (TS would leave an invalid partial style; only a
/// malformed override list reaches that).
fn copy_style_key(out: &mut TextStyle, own: Option<&TextStyle>, key: &str) {
    let Some(own) = own else {
        if key == "hyperlink" {
            out.hyperlink = None;
        }
        return;
    };
    match key {
        "fontFamily" => out.font_family = own.font_family,
        "fontWeight" => out.font_weight = own.font_weight,
        "italic" => out.italic = own.italic,
        "fontSize" => out.font_size = own.font_size,
        "lineHeight" => out.line_height = own.line_height,
        "letterSpacing" => out.letter_spacing = own.letter_spacing,
        "textDecoration" => out.text_decoration = own.text_decoration,
        "textCase" => out.text_case = own.text_case,
        "hyperlink" => out.hyperlink.clone_from(&own.hyperlink),
        _ => {}
    }
}

fn copy_text_key(out: &mut TextProps, own: Option<&TextProps>, key: &str) {
    let Some(own) = own else {
        match key {
            "listTypes" => out.list_types = None,
            "maxLines" => out.max_lines = None,
            _ => {}
        }
        return;
    };
    match key {
        "characters" => out.characters.clone_from(&own.characters),
        "style" => out.style.clone_from(&own.style),
        "runs" => out.runs.clone_from(&own.runs),
        "textAlignHorizontal" => out.text_align_horizontal = own.text_align_horizontal,
        "textAlignVertical" => out.text_align_vertical = own.text_align_vertical,
        "textAutoResize" => out.text_auto_resize = own.text_auto_resize,
        "paragraphSpacing" => out.paragraph_spacing = own.paragraph_spacing,
        "paragraphIndent" => out.paragraph_indent = own.paragraph_indent,
        "listTypes" => out.list_types.clone_from(&own.list_types),
        "maxLines" => out.max_lines = own.max_lines,
        _ => {}
    }
}

/// `grid.<key>` overrides (lane N1 step 12): the grid's settings part by part, as `autoLayout`'s.
fn copy_grid_key(out: &mut GridLayout, own: Option<&GridLayout>, key: &str) {
    let Some(own) = own else {
        return;
    };
    match key {
        "rowCount" => out.row_count = own.row_count,
        "columnCount" => out.column_count = own.column_count,
        "rowGap" => out.row_gap = own.row_gap,
        "columnGap" => out.column_gap = own.column_gap,
        "rowSizes" => out.row_sizes = own.row_sizes.clone(),
        "columnSizes" => out.column_sizes = own.column_sizes.clone(),
        "autoTracks" => out.auto_tracks = own.auto_tracks,
        "itemsPositioning" => out.items_positioning = own.items_positioning,
        _ => {}
    }
}

fn copy_auto_layout_key(out: &mut AutoLayout, own: Option<&AutoLayout>, key: &str) {
    let Some(own) = own else {
        return;
    };
    match key {
        "layoutMode" => out.layout_mode = own.layout_mode,
        "layoutWrap" => out.layout_wrap = own.layout_wrap,
        "primaryAxisAlignItems" => out.primary_axis_align_items = own.primary_axis_align_items,
        "counterAxisAlignItems" => out.counter_axis_align_items = own.counter_axis_align_items,
        "counterAxisAlignContent" => {
            out.counter_axis_align_content = own.counter_axis_align_content
        }
        "paddingLeft" => out.padding_left = own.padding_left,
        "paddingRight" => out.padding_right = own.padding_right,
        "paddingTop" => out.padding_top = own.padding_top,
        "paddingBottom" => out.padding_bottom = own.padding_bottom,
        "itemSpacing" => out.item_spacing = own.item_spacing,
        "counterAxisSpacing" => out.counter_axis_spacing = own.counter_axis_spacing,
        "itemReverseZIndex" => out.item_reverse_z_index = own.item_reverse_z_index,
        "strokesIncludedInLayout" => {
            out.strokes_included_in_layout = own.strokes_included_in_layout
        }
        _ => {}
    }
}

/// `mergeGranular` for a map-valued head (`boundVariables`, `componentProperties`): the listed keys of `own` over
/// `base`; a key `own` lacks is removed. Keys are atoms in the store: a key string no atom names is in neither map.
fn merge_map<V: Clone>(
    draft: &Working,
    base: Option<&Arc<IndexMap<Atom, V>>>,
    own: Option<&Arc<IndexMap<Atom, V>>>,
    keys: &[String],
) -> Option<Arc<IndexMap<Atom, V>>> {
    let had_base = base.is_some();
    let mut out: IndexMap<Atom, V> = base.map(|base| (**base).clone()).unwrap_or_default();
    for key in keys {
        let Some(atom) = draft.atom_of(key) else {
            continue;
        };
        match own.and_then(|own| own.get(&atom)) {
            Some(value) => {
                out.insert(atom, value.clone());
            }
            None => {
                out.shift_remove(&atom);
            }
        }
    }
    if !had_base && out.is_empty() {
        None
    } else {
        Some(Arc::new(out))
    }
}

/// `mergeGranular(head, base, own, keys)` written into `node[head]`: the overridden parts of `own` over `base` (the
/// value from the main). With no base, TS builds a partial object of the listed parts; a typed text or auto layout
/// cannot be partial, so `own`'s whole value is taken then (malformed override lists only).
pub fn merge_granular(draft: &Working, head: Field, node: &mut Node, own: &Node, keys: &[String]) {
    match head {
        Field::Prop(PropKey::Text) => match (node.props.text(), own.props.text()) {
            (Some(out), own_text) => {
                let mut out = Arc::clone(out);
                let text = Arc::make_mut(&mut out);
                for key in keys {
                    if let Some(style_key) = key.strip_prefix("style.") {
                        copy_style_key(
                            &mut text.style,
                            own_text.map(|text| &text.style),
                            style_key,
                        );
                    } else {
                        copy_text_key(text, own_text.map(|text| &**text), key);
                    }
                }
                node.props.set(Prop::Text(out));
            }
            (None, Some(own_text)) => node.props.set(Prop::Text(Arc::clone(own_text))),
            (None, None) => {}
        },
        Field::Prop(PropKey::AutoLayout) => {
            match (node.props.auto_layout(), own.props.auto_layout()) {
                (Some(out), own_layout) => {
                    let mut out = Arc::clone(out);
                    let layout = Arc::make_mut(&mut out);
                    for key in keys {
                        copy_auto_layout_key(layout, own_layout.map(|layout| &**layout), key);
                    }
                    node.props.set(Prop::AutoLayout(out));
                }
                (None, Some(own_layout)) => {
                    node.props.set(Prop::AutoLayout(Arc::clone(own_layout)));
                }
                (None, None) => {}
            }
        }
        Field::Prop(PropKey::Grid) => match (node.props.grid(), own.props.grid()) {
            (Some(out), own_grid) => {
                let mut out = Arc::clone(out);
                let grid = Arc::make_mut(&mut out);
                for key in keys {
                    copy_grid_key(grid, own_grid.map(|grid| &**grid), key);
                }
                node.props.set(Prop::Grid(out));
            }
            (None, Some(own_grid)) => {
                node.props.set(Prop::Grid(Arc::clone(own_grid)));
            }
            (None, None) => {}
        },
        Field::Prop(PropKey::BoundVariables) => {
            match merge_map(
                draft,
                node.props.bound_variables(),
                own.props.bound_variables(),
                keys,
            ) {
                Some(map) => node.props.set(Prop::BoundVariables(map)),
                None => {
                    node.props.remove(PropKey::BoundVariables);
                }
            }
        }
        Field::Prop(PropKey::ComponentProperties) => {
            match merge_map(
                draft,
                node.props.component_properties(),
                own.props.component_properties(),
                keys,
            ) {
                Some(map) => node.props.set(Prop::ComponentProperties(map)),
                None => {
                    node.props.remove(PropKey::ComponentProperties);
                }
            }
        }
        _ => head.copy(node, own),
    }
}

/// `applyOverrides(node, old, overrides)`: every overridden field (or part) of `old` over `node`.
pub fn apply_overrides(draft: &Working, node: &mut Node, old: &Node, overrides: &Parsed) {
    for (head, keys) in &overrides.0 {
        if head == "componentProperties" || head == "componentId" {
            continue;
        }
        let Some(field) = Field::from_name(head) else {
            continue;
        };
        match keys {
            Parts::Whole => field.copy(node, old),
            Parts::Keys(keys) => merge_granular(draft, field, node, old, keys),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_field_is_a_field() {
        for name in OVERRIDABLE_FIELDS
            .iter()
            .chain(GRANULAR_OVERRIDE_FIELDS)
            .chain(PLACEMENT_FIELDS)
        {
            assert!(Field::from_name(name).is_some(), "{name}");
        }
        let sets = sets();
        assert!(sets.copy_identity.has(Field::Prop(PropKey::MainId)));
        assert!(sets.component_only.has(Field::Fixed(Fixed::Children)));
    }
}
