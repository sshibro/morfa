//! Variables (variables.ts) on store nodes: resolution, modes, the
//! bindable fields, the usage index and `applyVariablesDetailed`, in the TypeScript's order. Variable, collection and
//! mode ids are atoms here; a bound field's name too.

use std::sync::Arc;

use indexmap::IndexSet;
use morfa_model::store::draft::{SlotSet, Working};
use morfa_model::store::{
    Atom, Id, LineHeight, Node, Paint, Prop, PropKey, TextProps, Variable, VariableValue,
};
use morfa_model::types::{
    IndividualStrokeWeights, LetterSpacing, LetterSpacingUnit, NodeType, Rgb, Rgba, VariableType,
};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::instances::geom::{js_max, js_min};

/// `BINDABLE_FIELDS`: field name → the variable type it takes, in FIELD_SPECS's order.
pub const BINDABLE_FIELDS: &[(&str, VariableType)] = &[
    ("width", VariableType::Float),
    ("height", VariableType::Float),
    ("minWidth", VariableType::Float),
    ("maxWidth", VariableType::Float),
    ("minHeight", VariableType::Float),
    ("maxHeight", VariableType::Float),
    ("itemSpacing", VariableType::Float),
    ("counterAxisSpacing", VariableType::Float),
    ("paddingLeft", VariableType::Float),
    ("paddingRight", VariableType::Float),
    ("paddingTop", VariableType::Float),
    ("paddingBottom", VariableType::Float),
    ("gridRowGap", VariableType::Float),
    ("gridColumnGap", VariableType::Float),
    ("cornerRadius", VariableType::Float),
    ("topLeftRadius", VariableType::Float),
    ("topRightRadius", VariableType::Float),
    ("bottomRightRadius", VariableType::Float),
    ("bottomLeftRadius", VariableType::Float),
    ("strokeWeight", VariableType::Float),
    ("strokeTopWeight", VariableType::Float),
    ("strokeRightWeight", VariableType::Float),
    ("strokeBottomWeight", VariableType::Float),
    ("strokeLeftWeight", VariableType::Float),
    ("opacity", VariableType::Float),
    ("visible", VariableType::Boolean),
    ("characters", VariableType::String),
    ("fontFamily", VariableType::String),
    ("fontSize", VariableType::Float),
    ("fontWeight", VariableType::Float),
    ("letterSpacing", VariableType::Float),
    ("lineHeight", VariableType::Float),
    ("paragraphSpacing", VariableType::Float),
    ("paragraphIndent", VariableType::Float),
];

/// The type a bindable field takes.
pub fn bindable_type(field: &str) -> Option<VariableType> {
    BINDABLE_FIELDS
        .iter()
        .find(|(name, _)| *name == field)
        .map(|(_, kind)| *kind)
}

/// `aliasesOf(node, out)` on a node of the JSON model (a patch's entry, before it is interned): the variable ids it
/// binds, in the order [`aliases_of`] visits them on the stored node.
pub fn aliases_of_model(node: &morfa_model::types::SceneNode, out: &mut impl FnMut(&str)) {
    fn paints(paints: &[morfa_model::types::Paint], out: &mut impl FnMut(&str)) {
        for paint in paints {
            if let morfa_model::types::Paint::Solid(solid) = paint
                && let Some(color) = solid
                    .bound_variables
                    .as_ref()
                    .and_then(|bound| bound.color.as_ref())
            {
                out(&color.id);
            }
        }
    }
    if let Some(bound) = &node.bound_variables {
        for alias in bound.values() {
            out(&alias.id);
        }
    }
    paints(&node.fills, out);
    paints(&node.strokes, out);
    if let Some(text) = &node.text {
        for run in &text.runs {
            if let Some(fills) = &run.fills {
                paints(fills, out);
            }
        }
    }
}

use super::sync::{clip_runs, js_length};

/// `isColor` for a value of the model (a model `Rgba` is always four finite numbers).
fn is_color(value: &VariableValue) -> bool {
    matches!(value, VariableValue::Color(color) if [color.r, color.g, color.b, color.a].iter().all(|n| n.is_finite()))
}

/// `matchesType`.
fn matches_type(kind: VariableType, value: &VariableValue) -> bool {
    match kind {
        VariableType::Color => is_color(value),
        VariableType::Float => matches!(value, VariableValue::Number(n) if n.is_finite()),
        VariableType::String => matches!(value, VariableValue::Text(_)),
        VariableType::Boolean => matches!(value, VariableValue::Boolean(_)),
    }
}

/// `counterpart`: a copy's mirror, an instance's component.
fn counterpart<'d>(draft: &'d Working, node: &Node) -> Option<&'d Node> {
    if let Some(main) = node.props.main_id() {
        return draft.node(*main);
    }
    if node.kind == NodeType::Instance
        && let Some(component) = node.props.component_id()
        && !draft.key(*component).is_empty()
    {
        return draft.node(*component);
    }
    None
}

/// `modeForNode` answers of one pass over an unchanging table, by node and collection. A node's mode is its own pick
/// or its counterparts', else its parent's, so one walk answers for every node it passed: siblings under a shared
/// ancestor pay for the walk once.
#[derive(Default)]
pub struct ModeMemo {
    modes: FxHashMap<(Id, Atom), Atom>,
    path: Vec<Id>,
}

/// `modeForNode(doc, nodeId, collectionId)` through a memo: `None` when the collection does not exist.
pub fn mode_for_node(
    draft: &Working,
    node_id: Id,
    collection_id: Atom,
    memo: &mut ModeMemo,
) -> Option<Atom> {
    let collection = draft.variable_collections().get(&collection_id)?;
    let valid = |mode: Atom| {
        !draft.atom(mode).is_empty()
            && collection
                .modes
                .iter()
                .any(|candidate| candidate.mode_id == mode)
    };
    memo.path.clear();
    let mut node = draft.node(node_id);
    let mut guard = 0;
    let found: Atom = loop {
        let Some(current) = node else {
            break collection.default_mode_id;
        };
        if guard >= 10_000 {
            // A parent cycle (an invalid document): answered as TS does, remembered for nothing.
            memo.path.clear();
            break collection.default_mode_id;
        }
        if let Some(known) = memo.modes.get(&(current.id, collection_id)) {
            break *known;
        }
        memo.path.push(current.id);
        if let Some(own) = draft
            .modes_of(current.id)
            .and_then(|modes| modes.get(&collection_id))
            && valid(*own)
        {
            break *own;
        }
        let mut main = counterpart(draft, current);
        let mut depth = 0;
        let mut inherited_mode: Option<Atom> = None;
        while let Some(mirror) = main {
            if depth >= 64 {
                break;
            }
            if let Some(inherited) = draft
                .modes_of(mirror.id)
                .and_then(|modes| modes.get(&collection_id))
                && valid(*inherited)
            {
                inherited_mode = Some(*inherited);
                break;
            }
            main = counterpart(draft, mirror);
            depth += 1;
        }
        if let Some(inherited) = inherited_mode {
            break inherited;
        }
        node = draft.node_opt(current.parent);
        guard += 1;
    };
    for id in memo.path.drain(..) {
        memo.modes.insert((id, collection_id), found);
    }
    Some(found)
}

/// `resolveVariable(doc, id, modeId?, nodeId?)`: a variable's concrete value; `None` for a missing variable, a value
/// of the wrong type or an alias cycle.
pub fn resolve_variable<'d>(
    draft: &'d Working,
    id: Atom,
    mode_id: Option<Atom>,
    node_id: Option<Id>,
    memo: &mut ModeMemo,
) -> Option<&'d VariableValue> {
    let variables = draft.variables();
    let collections = draft.variable_collections();
    // Alias chains are short: a list beats a set.
    let mut seen: Vec<Atom> = Vec::new();
    let mut variable: Option<&Variable> = variables.get(&id);
    let mut mode: Option<Atom> = mode_id;
    while let Some(current) = variable {
        if seen.contains(&current.id) {
            return None;
        }
        seen.push(current.id);
        let collection = collections.get(&current.collection_id);
        let chosen: Option<Atom> = match mode {
            Some(mode) if current.values_by_mode.contains_key(&mode) => Some(mode),
            _ => match node_id {
                Some(node_id) => mode_for_node(draft, node_id, current.collection_id, memo),
                None => collection.map(|collection| collection.default_mode_id),
            },
        };
        let value = chosen
            .and_then(|chosen| current.values_by_mode.get(&chosen))
            .or_else(|| {
                collection
                    .and_then(|collection| current.values_by_mode.get(&collection.default_mode_id))
            })
            .or_else(|| current.values_by_mode.values().next())?;
        let VariableValue::Alias(alias) = value else {
            return matches_type(current.kind, value).then_some(value);
        };
        let next = variables.get(alias);
        mode = match next {
            Some(next) if next.collection_id == current.collection_id => chosen,
            _ => None,
        };
        variable = next;
    }
    None
}

// ── Bindable fields ─────────────────────────────────────────────────────────────────────────────

/// `finite(value)`.
fn finite(value: &VariableValue) -> Option<f64> {
    match value {
        VariableValue::Number(n) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `with_text(node, change)`: the node's text copied once and changed; `false` when it has none.
fn with_text(node: &mut Node, change: impl FnOnce(&mut TextProps)) -> bool {
    let Some(text) = node.props.text() else {
        return false;
    };
    let mut text = Arc::clone(text);
    change(Arc::make_mut(&mut text));
    node.props.set(Prop::Text(text));
    true
}

/// `numberField(key, 0).write`.
fn write_number(node: &mut Node, key: &str, value: &VariableValue) -> bool {
    let Some(number) = finite(value) else {
        return false;
    };
    let next = js_max(0.0, number);
    let mut wrote = false;
    match key {
        "width" => {
            if node.width != next {
                node.width = next;
                wrote = true;
            }
        }
        "height" => {
            if node.height != next {
                node.height = next;
                wrote = true;
            }
        }
        "strokeWeight" => {
            if node.stroke_weight != next {
                node.stroke_weight = next;
                wrote = true;
            }
        }
        "cornerRadius" => {
            if node.props.corner_radius() != Some(&next) {
                node.props.set(Prop::CornerRadius(next));
                wrote = true;
            }
        }
        "minWidth" | "maxWidth" | "minHeight" | "maxHeight" => {
            let (current, prop) = match key {
                "minWidth" => (node.props.min_width(), Prop::MinWidth(Some(next))),
                "maxWidth" => (node.props.max_width(), Prop::MaxWidth(Some(next))),
                "minHeight" => (node.props.min_height(), Prop::MinHeight(Some(next))),
                _ => (node.props.max_height(), Prop::MaxHeight(Some(next))),
            };
            if current != Some(&Some(next)) {
                node.props.set(prop);
                wrote = true;
            }
        }
        _ => {}
    }
    // One radius for every corner: individual radii follow, as Figma applies it.
    if key == "cornerRadius"
        && let Some(Some(radii)) = node.props.rectangle_corner_radii()
        && radii.iter().any(|radius| *radius != next)
    {
        node.props
            .set(Prop::RectangleCornerRadii(Some(Arc::new([next; 4]))));
        wrote = true;
    }
    wrote
}

/// `autoLayoutField(key).write`.
fn write_auto_layout(node: &mut Node, key: &str, value: &VariableValue) -> bool {
    let Some(number) = finite(value) else {
        return false;
    };
    let Some(layout) = node.props.auto_layout() else {
        return false;
    };
    let current = match key {
        "itemSpacing" => layout.item_spacing,
        "counterAxisSpacing" => layout.counter_axis_spacing,
        "paddingLeft" => layout.padding_left,
        "paddingRight" => layout.padding_right,
        "paddingTop" => layout.padding_top,
        _ => layout.padding_bottom,
    };
    if current == number {
        return false;
    }
    let mut layout = Arc::clone(layout);
    {
        let layout = Arc::make_mut(&mut layout);
        let slot: &mut f64 = match key {
            "itemSpacing" => &mut layout.item_spacing,
            "counterAxisSpacing" => &mut layout.counter_axis_spacing,
            "paddingLeft" => &mut layout.padding_left,
            "paddingRight" => &mut layout.padding_right,
            "paddingTop" => &mut layout.padding_top,
            _ => &mut layout.padding_bottom,
        };
        *slot = number;
    }
    node.props.set(Prop::AutoLayout(layout));
    true
}

/// `gridField(key).write`: the gaps of a grid auto-layout frame (`node.grid`).
fn write_grid(node: &mut Node, key: &str, value: &VariableValue) -> bool {
    let Some(number) = finite(value) else {
        return false;
    };
    let Some(grid) = node.props.grid() else {
        return false;
    };
    let current = if key == "gridRowGap" {
        grid.row_gap
    } else {
        grid.column_gap
    };
    if current == number {
        return false;
    }
    let mut grid = Arc::clone(grid);
    {
        let grid = Arc::make_mut(&mut grid);
        if key == "gridRowGap" {
            grid.row_gap = number;
        } else {
            grid.column_gap = number;
        }
    }
    node.props.set(Prop::Grid(grid));
    true
}

/// `cornerField(index).write`.
fn write_corner(node: &mut Node, index: usize, value: &VariableValue) -> bool {
    let Some(number) = finite(value) else {
        return false;
    };
    let Some(radius) = node.props.corner_radius().copied() else {
        return false;
    };
    let existing: Option<[f64; 4]> = match node.props.rectangle_corner_radii() {
        Some(Some(radii)) => Some(**radii),
        _ => None,
    };
    let mut radii = existing.unwrap_or([radius; 4]);
    let next = js_max(0.0, number);
    if radii[index] == next && existing.is_some() {
        return false;
    }
    radii[index] = next;
    node.props
        .set(Prop::RectangleCornerRadii(Some(Arc::new(radii))));
    true
}

/// `strokeSideField(side).write`.
fn write_stroke_side(node: &mut Node, side: usize, value: &VariableValue) -> bool {
    let Some(number) = finite(value) else {
        return false;
    };
    let existing: Option<IndividualStrokeWeights> = match node.props.individual_stroke_weights() {
        Some(Some(weights)) => Some(**weights),
        _ => None,
    };
    let weight = node.stroke_weight;
    let mut weights = existing.unwrap_or(IndividualStrokeWeights {
        top: weight,
        right: weight,
        bottom: weight,
        left: weight,
    });
    let slot = match side {
        0 => &mut weights.top,
        1 => &mut weights.right,
        2 => &mut weights.bottom,
        _ => &mut weights.left,
    };
    if existing.is_some() && *slot == number {
        return false;
    }
    *slot = js_max(0.0, number);
    node.props
        .set(Prop::IndividualStrokeWeights(Some(Arc::new(weights))));
    true
}

/// `JSON.stringify(a) === JSON.stringify(b)` for two finite numbers: equal, −0 the same as 0.
fn same_json_number(a: f64, b: f64) -> bool {
    a == b
}

/// `textStyleField(type, make).write`. `family`: the atom of a `fontFamily` value (interned by the caller).
fn write_text_style(
    node: &mut Node,
    key: &str,
    value: &VariableValue,
    family: Option<Atom>,
) -> bool {
    let Some(text) = node.props.text() else {
        return false;
    };
    let style = &text.style;
    match key {
        "fontFamily" => match (value, family) {
            (VariableValue::Text(name), Some(family)) if !name.is_empty() => {
                if style.font_family == family {
                    return false;
                }
                with_text(node, |text| text.style.font_family = family)
            }
            _ => false,
        },
        "fontSize" => match finite(value) {
            Some(size) if size > 0.0 => {
                if same_json_number(style.font_size, size) {
                    return false;
                }
                with_text(node, |text| text.style.font_size = size)
            }
            _ => false,
        },
        "fontWeight" => match finite(value) {
            Some(weight) => {
                let weight = js_min(900.0, js_max(100.0, weight));
                if same_json_number(style.font_weight, weight) {
                    return false;
                }
                with_text(node, |text| text.style.font_weight = weight)
            }
            None => false,
        },
        "letterSpacing" => match finite(value) {
            Some(spacing) => {
                let next = LetterSpacing {
                    unit: LetterSpacingUnit::Pixels,
                    value: spacing,
                };
                if style.letter_spacing.unit == next.unit
                    && same_json_number(style.letter_spacing.value, spacing)
                {
                    return false;
                }
                with_text(node, |text| text.style.letter_spacing = next)
            }
            None => false,
        },
        "lineHeight" => match finite(value) {
            Some(height) => {
                if let LineHeight::Pixels(current) = style.line_height
                    && same_json_number(current, height)
                {
                    return false;
                }
                with_text(node, |text| {
                    text.style.line_height = LineHeight::Pixels(height)
                })
            }
            None => false,
        },
        _ => false,
    }
}

/// `textField(key).write`.
fn write_text_number(node: &mut Node, key: &str, value: &VariableValue) -> bool {
    let Some(number) = finite(value) else {
        return false;
    };
    let Some(text) = node.props.text() else {
        return false;
    };
    let current = if key == "paragraphSpacing" {
        text.paragraph_spacing
    } else {
        text.paragraph_indent
    };
    if current == number {
        return false;
    }
    with_text(node, |text| {
        if key == "paragraphSpacing" {
            text.paragraph_spacing = number;
        } else {
            text.paragraph_indent = number;
        }
    })
}

/// `FIELD_SPECS[field].write(node, value)` applied in place: whether it gave a partial. `family`: the atom of a
/// text `fontFamily` value, when the caller has it.
fn write_field(node: &mut Node, field: &str, value: &VariableValue, family: Option<Atom>) -> bool {
    match field {
        "width" | "height" | "minWidth" | "maxWidth" | "minHeight" | "maxHeight"
        | "cornerRadius" | "strokeWeight" => write_number(node, field, value),
        "itemSpacing" | "counterAxisSpacing" | "paddingLeft" | "paddingRight" | "paddingTop"
        | "paddingBottom" => write_auto_layout(node, field, value),
        "gridRowGap" | "gridColumnGap" => write_grid(node, field, value),
        "topLeftRadius" => write_corner(node, 0, value),
        "topRightRadius" => write_corner(node, 1, value),
        "bottomRightRadius" => write_corner(node, 2, value),
        "bottomLeftRadius" => write_corner(node, 3, value),
        "strokeTopWeight" => write_stroke_side(node, 0, value),
        "strokeRightWeight" => write_stroke_side(node, 1, value),
        "strokeBottomWeight" => write_stroke_side(node, 2, value),
        "strokeLeftWeight" => write_stroke_side(node, 3, value),
        "opacity" => {
            let Some(number) = finite(value) else {
                return false;
            };
            let opacity = js_min(1.0, js_max(0.0, number / 100.0));
            if node.opacity == opacity {
                return false;
            }
            node.opacity = opacity;
            true
        }
        "visible" => match value {
            VariableValue::Boolean(visible) if node.visible != *visible => {
                node.visible = *visible;
                true
            }
            _ => false,
        },
        "characters" => match (value, node.props.text()) {
            (VariableValue::Text(characters), Some(text)) if text.characters != *characters => {
                let characters = Arc::clone(characters);
                with_text(node, |text| {
                    text.characters = characters;
                    // variables.ts's own clipRuns rebuilds the list either way; the value is the same.
                    if let Some(runs) = clip_runs(&text.runs, js_length(&text.characters) as f64) {
                        text.runs = runs.into();
                    }
                })
            }
            _ => false,
        },
        "fontFamily" | "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight" => {
            write_text_style(node, field, value, family)
        }
        "paragraphSpacing" | "paragraphIndent" => write_text_number(node, field, value),
        _ => false,
    }
}

// ── Reverse index ───────────────────────────────────────────────────────────────────────────────

/// `VariableUsage`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VariableUsage {
    /// Variable → nodes binding it directly (node fields, paints, text run paints), in table order.
    pub by_variable: FxHashMap<Atom, IndexSet<Id>>,
    /// Every node with at least one binding, in table order.
    pub bound: IndexSet<Id>,
}

fn paint_aliases(paints: &[Paint], out: &mut impl FnMut(Atom)) {
    for paint in paints {
        if let Paint::Solid(solid) = paint
            && let Some(Some(color)) = solid.bound_color
        {
            out(color);
        }
    }
}

/// `aliasesOf(node, out)`.
pub fn aliases_of(node: &Node, out: &mut impl FnMut(Atom)) {
    if let Some(bound) = node.props.bound_variables() {
        for alias in bound.values() {
            out(*alias);
        }
    }
    paint_aliases(&node.fills, out);
    paint_aliases(&node.strokes, out);
    if let Some(text) = node.props.text() {
        for run in text.runs.iter() {
            if let Some(fills) = &run.fills {
                paint_aliases(fills, out);
            }
        }
    }
}

/// `sameBindings`: whether two versions of an entry bind the same variables, in order.
pub fn same_bindings(a: Option<&Node>, b: Option<&Node>) -> bool {
    let list = |node: Option<&Node>| {
        let mut out: Vec<Atom> = Vec::new();
        if let Some(node) = node {
            aliases_of(node, &mut |id| out.push(id));
        }
        out
    };
    list(a) == list(b)
}

impl VariableUsage {
    pub fn add(&mut self, id: Id, node: &Node) {
        aliases_of(node, &mut |variable| {
            self.bound.insert(id);
            self.by_variable.entry(variable).or_default().insert(id);
        });
    }

    /// `buildUsage` over a table as it stands.
    pub fn build(draft: &Working) -> Self {
        let mut usage = VariableUsage::default();
        draft.for_each_id(|id| {
            if let Some(node) = draft.node(id) {
                usage.add(id, node);
            }
        });
        usage
    }
}

/// `aliasDependents(doc)`: variable → the variables that alias it.
pub fn alias_dependents(draft: &Working) -> FxHashMap<Atom, IndexSet<Atom>> {
    let mut map: FxHashMap<Atom, IndexSet<Atom>> = FxHashMap::default();
    for variable in draft.variables().values() {
        for value in variable.values_by_mode.values() {
            if let VariableValue::Alias(alias) = value {
                map.entry(*alias).or_default().insert(variable.id);
            }
        }
    }
    map
}

// ── Applying ────────────────────────────────────────────────────────────────────────────────────

/// `FIELD_SPECS[field].write(node, value) !== null` without writing: whether the spec would give a partial.
fn would_write(node: &Node, field: &str, value: &VariableValue) -> bool {
    let number = finite(value);
    let props = &node.props;
    match field {
        "width" | "height" | "minWidth" | "maxWidth" | "minHeight" | "maxHeight"
        | "cornerRadius" | "strokeWeight" => {
            let Some(number) = number else { return false };
            let next = js_max(0.0, number);
            let differs = match field {
                "width" => node.width != next,
                "height" => node.height != next,
                "strokeWeight" => node.stroke_weight != next,
                "cornerRadius" => props.corner_radius() != Some(&next),
                "minWidth" => props.min_width() != Some(&Some(next)),
                "maxWidth" => props.max_width() != Some(&Some(next)),
                "minHeight" => props.min_height() != Some(&Some(next)),
                _ => props.max_height() != Some(&Some(next)),
            };
            differs
                || (field == "cornerRadius"
                    && matches!(props.rectangle_corner_radii(), Some(Some(radii)) if radii.iter().any(|radius| *radius != next)))
        }
        "itemSpacing" | "counterAxisSpacing" | "paddingLeft" | "paddingRight" | "paddingTop"
        | "paddingBottom" => {
            let (Some(number), Some(layout)) = (number, props.auto_layout()) else {
                return false;
            };
            let slot = match field {
                "itemSpacing" => layout.item_spacing,
                "counterAxisSpacing" => layout.counter_axis_spacing,
                "paddingLeft" => layout.padding_left,
                "paddingRight" => layout.padding_right,
                "paddingTop" => layout.padding_top,
                _ => layout.padding_bottom,
            };
            slot != number
        }
        "gridRowGap" | "gridColumnGap" => {
            let (Some(number), Some(grid)) = (number, props.grid()) else {
                return false;
            };
            (if field == "gridRowGap" {
                grid.row_gap
            } else {
                grid.column_gap
            }) != number
        }
        "topLeftRadius" | "topRightRadius" | "bottomRightRadius" | "bottomLeftRadius" => {
            let (Some(number), Some(_radius)) = (number, props.corner_radius()) else {
                return false;
            };
            let index = [
                "topLeftRadius",
                "topRightRadius",
                "bottomRightRadius",
                "bottomLeftRadius",
            ]
            .iter()
            .position(|name| *name == field)
            .unwrap_or(0);
            match props.rectangle_corner_radii() {
                Some(Some(radii)) => radii[index] != js_max(0.0, number),
                _ => true,
            }
        }
        "strokeTopWeight" | "strokeRightWeight" | "strokeBottomWeight" | "strokeLeftWeight" => {
            let Some(number) = number else { return false };
            match props.individual_stroke_weights() {
                Some(Some(weights)) => {
                    let slot = match field {
                        "strokeTopWeight" => weights.top,
                        "strokeRightWeight" => weights.right,
                        "strokeBottomWeight" => weights.bottom,
                        _ => weights.left,
                    };
                    slot != number
                }
                _ => true,
            }
        }
        "opacity" => {
            number.is_some_and(|number| node.opacity != js_min(1.0, js_max(0.0, number / 100.0)))
        }
        "visible" => matches!(value, VariableValue::Boolean(visible) if node.visible != *visible),
        "characters" => {
            matches!((value, props.text()), (VariableValue::Text(characters), Some(text)) if text.characters != *characters)
        }
        "fontFamily" | "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight" => {
            let Some(text) = props.text() else {
                return false;
            };
            let style = &text.style;
            match field {
                // Compared as text: the value may name a family no atom holds yet.
                "fontFamily" => false,
                "fontSize" => number.is_some_and(|size| size > 0.0 && !same_json_number(style.font_size, size)),
                "fontWeight" => number.is_some_and(|weight| !same_json_number(style.font_weight, js_min(900.0, js_max(100.0, weight)))),
                "letterSpacing" => number.is_some_and(|spacing| {
                    !(style.letter_spacing.unit == LetterSpacingUnit::Pixels && same_json_number(style.letter_spacing.value, spacing))
                }),
                _ => number.is_some_and(|height| !matches!(style.line_height, LineHeight::Pixels(current) if same_json_number(current, height))),
            }
        }
        "paragraphSpacing" | "paragraphIndent" => {
            let (Some(number), Some(text)) = (number, props.text()) else {
                return false;
            };
            let slot = if field == "paragraphSpacing" {
                text.paragraph_spacing
            } else {
                text.paragraph_indent
            };
            slot != number
        }
        _ => false,
    }
}

/// `fontFamily` alone: whether the value would be written, as text (`would_write` cannot: the family may not be an
/// atom yet).
fn would_write_family(draft: &Working, node: &Node, value: &VariableValue) -> bool {
    let Some(text) = node.props.text() else {
        return false;
    };
    matches!(value, VariableValue::Text(family) if !family.is_empty() && draft.atom(text.style.font_family) != &**family)
}

/// `resolvePaints` without writing: the new colour (and alpha) of every bound solid paint that takes one.
fn paint_changes(
    draft: &Working,
    node_id: Id,
    paints: &[Paint],
    memo: &mut ModeMemo,
) -> Vec<(usize, Rgba)> {
    let mut changes = Vec::new();
    for (i, paint) in paints.iter().enumerate() {
        let Paint::Solid(solid) = paint else { continue };
        let Some(Some(color)) = solid.bound_color else {
            continue;
        };
        let Some(variable) = draft.variables().get(&color) else {
            continue;
        };
        if variable.kind != VariableType::Color {
            continue;
        }
        let Some(VariableValue::Color(value)) =
            resolve_variable(draft, variable.id, None, Some(node_id), memo)
                .filter(|value| is_color(value))
        else {
            continue;
        };
        if solid.color.r == value.r
            && solid.color.g == value.g
            && solid.color.b == value.b
            && solid.opacity == value.a
        {
            continue;
        }
        changes.push((i, *value));
    }
    changes
}

fn apply_paint_changes(paints: &[Paint], changes: &[(usize, Rgba)]) -> Vec<Paint> {
    let mut paints = paints.to_vec();
    for (i, Rgba { r, g, b, a }) in changes {
        if let Paint::Solid(solid) = &mut paints[*i] {
            solid.color = Rgb {
                r: *r,
                g: *g,
                b: *b,
            };
            solid.opacity = *a;
        }
    }
    paints
}

/// `resolvedNode(doc, node)` with a [`ModeMemo`] shared by the nodes of one pass: the node with every bound field set
/// to its variable's value in the node's modes; `None` when nothing changes (TS returns the node itself). The node is
/// cloned only once some binding changes it. A `fontFamily` value no atom holds yet is reported in `missing` (the
/// caller interns it and resolves again).
pub fn resolved_node(
    draft: &Working,
    node: &Node,
    memo: &mut ModeMemo,
    missing: &mut Vec<Arc<str>>,
) -> Option<Node> {
    let variables = draft.variables();
    let mut next: Option<Node> = None;
    // `next !== node` in TS: a field spec that gave a partial counts even when its values equal the old.
    let mut wrote = false;
    if let Some(bound) = node.props.bound_variables() {
        for (field, alias) in bound.iter() {
            let field = draft.atom(*field);
            let Some(kind) = bindable_type(field) else {
                continue;
            };
            let Some(variable) = variables.get(alias) else {
                continue;
            };
            if variable.kind != kind {
                continue;
            }
            let Some(value) = resolve_variable(draft, variable.id, None, Some(node.id), memo)
            else {
                continue;
            };
            let current = next.as_ref().unwrap_or(node);
            let mut family: Option<Atom> = None;
            if field == "fontFamily" {
                if !would_write_family(draft, current, value) {
                    continue;
                }
                if let VariableValue::Text(name) = value {
                    match draft.atom_of(name) {
                        Some(atom) => family = Some(atom),
                        None => {
                            missing.push(Arc::clone(name));
                            continue;
                        }
                    }
                }
            } else if !would_write(current, field, value) {
                continue;
            }
            let target = next.get_or_insert_with(|| node.clone());
            wrote |= write_field(target, field, value, family);
        }
    }
    let current = next.as_ref().unwrap_or(node);
    let fills = paint_changes(draft, node.id, &current.fills, memo);
    let strokes = paint_changes(draft, node.id, &current.strokes, memo);
    let mut runs: Vec<(usize, Vec<(usize, Rgba)>)> = Vec::new();
    if let Some(text) = current.props.text() {
        for (i, run) in text.runs.iter().enumerate() {
            if let Some(run_fills) = &run.fills {
                let changes = paint_changes(draft, node.id, run_fills, memo);
                if !changes.is_empty() {
                    runs.push((i, changes));
                }
            }
        }
    }
    if fills.is_empty() && strokes.is_empty() && runs.is_empty() {
        return if wrote { next } else { None };
    }
    let mut working = next.unwrap_or_else(|| node.clone());
    if !fills.is_empty() {
        working.fills = apply_paint_changes(&working.fills, &fills).into();
    }
    if !strokes.is_empty() {
        working.strokes = apply_paint_changes(&working.strokes, &strokes).into();
    }
    if !runs.is_empty() {
        with_text(&mut working, |text| {
            let mut list = text.runs.as_slice().to_vec();
            for (i, changes) in &runs {
                if let Some(run_fills) = list[*i].fills.as_ref() {
                    list[*i].fills = Some(apply_paint_changes(run_fills, changes).into());
                }
            }
            text.runs = list.into();
        });
    }
    Some(working)
}

/// `boundUnderDirty`: the bound nodes in `dirty` or below a dirty node.
fn bound_under_dirty(draft: &Working, dirty: &SlotSet, bound: &IndexSet<Id>) -> Vec<Id> {
    let mut found: Vec<Id> = Vec::new();
    let budget = 2 * bound.len() + 64;
    let mut seen: FxHashSet<Id> = FxHashSet::default();
    seen.reserve(dirty.len().min(budget + 1));
    let mut stack: Vec<Id> = dirty.iter().collect();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > budget {
            found.clear();
            let mut below: FxHashMap<Id, bool> = FxHashMap::default();
            for &bound_id in bound {
                let mut path: Vec<Id> = Vec::new();
                let mut hit = false;
                let mut node = draft.node(bound_id);
                let mut guard = 0;
                while let Some(current) = node {
                    if guard >= 10_000 {
                        break;
                    }
                    if dirty.contains(current.id) {
                        hit = true;
                        break;
                    }
                    if let Some(known) = below.get(&current.id) {
                        hit = *known;
                        break;
                    }
                    path.push(current.id);
                    node = draft.node_opt(current.parent);
                    guard += 1;
                }
                for each in path {
                    below.insert(each, hit);
                }
                if hit {
                    found.push(bound_id);
                }
            }
            return found;
        }
        let Some(node) = draft.node(id) else {
            continue;
        };
        if bound.contains(&id) {
            found.push(id);
        }
        for child in node.children() {
            stack.push(*child);
        }
    }
    found
}

/// The targets of `applyVariablesDetailed(doc, dirty)`: every bound node in reach, in target order.
fn targets(draft: &Working, dirty: &SlotSet, usage: &VariableUsage) -> Vec<Id> {
    let variables = draft.variables();
    let collections = draft.variable_collections();
    let mut targets: IndexSet<Id> = IndexSet::new();
    let mut seeds: Vec<Atom> = Vec::new();
    for id in dirty {
        let Some(atom) = draft.atom_of(draft.key(id)) else {
            continue;
        };
        if variables.contains_key(&atom) {
            seeds.push(atom);
        } else if let Some(collection) = collections.get(&atom) {
            seeds.extend(collection.variable_ids.iter().copied());
        }
    }
    if !seeds.is_empty() {
        let dependents = alias_dependents(draft);
        let mut seen: FxHashSet<Atom> = FxHashSet::default();
        while let Some(id) = seeds.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Some(nodes) = usage.by_variable.get(&id) {
                for node_id in nodes {
                    targets.insert(*node_id);
                }
            }
            if let Some(dependents) = dependents.get(&id) {
                seeds.extend(dependents.iter().copied());
            }
        }
    }
    // A dirty node (moved, created, given a mode) re-resolves with its bound descendants.
    for id in bound_under_dirty(draft, dirty, &usage.bound) {
        targets.insert(id);
    }
    targets.into_iter().collect()
}

/// `applyVariablesDetailed(doc, dirty)` on the draft: the bound nodes in reach re-resolved against the table as it
/// stands, then written. `usage`: the table's usage index (built here when absent). Returns the ids written.
pub fn apply_variables_in(
    draft: &mut Working,
    dirty: &SlotSet,
    usage: Option<&VariableUsage>,
) -> SlotSet {
    if dirty.is_empty() || draft.variables().is_empty() {
        return SlotSet::new();
    }
    let built;
    let usage = match usage {
        Some(usage) => usage,
        None => {
            built = VariableUsage::build(draft);
            &built
        }
    };
    if usage.bound.is_empty() {
        return SlotSet::new();
    }
    let targets = targets(draft, dirty, usage);
    // Every node resolves against the table as it was; the results are written after. A `fontFamily` value no atom
    // holds yet is interned and the pass runs again (rare: a string variable naming a new font).
    let mut results: Vec<Node>;
    loop {
        let mut memo = ModeMemo::default();
        let mut missing: Vec<Arc<str>> = Vec::new();
        results = Vec::new();
        for &id in &targets {
            let Some(node) = draft.node(id) else {
                continue;
            };
            if let Some(next) = resolved_node(draft, node, &mut memo, &mut missing) {
                results.push(next);
            }
        }
        if missing.is_empty() {
            break;
        }
        for family in missing {
            draft.intern_atom(&family);
        }
    }
    draft.collect(|draft| {
        for next in results {
            draft.put(next);
        }
    })
}

#[allow(dead_code)]
const _: fn(PropKey) -> PropKey = |key| key;
