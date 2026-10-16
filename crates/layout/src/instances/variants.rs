//! Variant names and sets (components.ts §Variant names and property definitions, variants.ts) on store nodes
//! (ported from lane L2c). Variant names and property keys are strings in the TypeScript; here they are
//! atoms, resolved where parsed and interned where made.

use indexmap::IndexMap;
use morfa_model::store::draft::Working;
use morfa_model::store::{Atom, Id, Node, PropertyDefinition, PropertyValue};
use morfa_model::types::{ComponentPropertyType, Map, NodeType};

/// JavaScript's `String.prototype.trim` (WhiteSpace and LineTerminator; Rust's `trim` differs on U+0085 and U+FEFF).
pub fn js_trim(text: &str) -> &str {
    let space = |c: char| {
        matches!(
            c,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    };
    text.trim_matches(space)
}

/// `parseVariantName`: "Size=Large, State=Hover" → {Size: 'Large', …}; `None` when the name is not in
/// that form.
pub fn parse_variant_name(name: &str) -> Option<Map<String>> {
    let mut out = Map::new();
    for part in name.split(',') {
        let eq = part.find('=')?;
        let key = js_trim(&part[..eq]);
        if key.is_empty() {
            return None;
        }
        out.insert(key.to_owned(), js_trim(&part[eq + 1..]).to_owned());
    }
    // `split` always yields a part, so a parse that got here found at least one.
    Some(out)
}

/// `formatVariantName(values, order)`.
pub fn format_variant_name(values: &Map<String>, order: &[String]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(values.len());
    for key in order {
        if let Some(value) = values.get(key) {
            parts.push(format!("{key}={value}"));
        }
    }
    for (key, value) in values {
        if !order.contains(key) {
            parts.push(format!("{key}={value}"));
        }
    }
    parts.join(", ")
}

/// `propertyName`: "Icon#12" → "Icon".
pub fn property_name(key: &str) -> &str {
    match key.rfind('#') {
        Some(hash) if hash > 0 => &key[..hash],
        _ => key,
    }
}

/// `String(value)`.
pub fn property_string<'d>(draft: &'d Working, value: &PropertyValue) -> std::borrow::Cow<'d, str> {
    match value {
        PropertyValue::Text(text) => std::borrow::Cow::Borrowed(draft.atom(*text)),
        PropertyValue::Boolean(flag) => std::borrow::Cow::Owned(flag.to_string()),
    }
}

/// `componentIn`: the node if it is a COMPONENT.
pub fn component_in(draft: &Working, id: Option<Id>) -> Option<&Node> {
    draft
        .node_opt(id)
        .filter(|node| node.kind == NodeType::Component)
}

/// `setOfIn`: the COMPONENT_SET a component is a variant of.
pub fn set_of<'d>(draft: &'d Working, component: &Node) -> Option<&'d Node> {
    draft
        .node_opt(component.parent)
        .filter(|parent| parent.kind == NodeType::ComponentSet)
}

/// `defaultVariantIn`: the top-left variant.
pub fn default_variant_in<'d>(draft: &'d Working, set: &Node) -> Option<&'d Node> {
    let mut best: Option<&Node> = None;
    for id in set.children() {
        let Some(node) = draft.node(*id) else {
            continue;
        };
        if node.kind != NodeType::Component {
            continue;
        }
        let better = match best {
            None => true,
            Some(best) => {
                node.y < best.y - 0.5 || ((node.y - best.y).abs() <= 0.5 && node.x < best.x)
            }
        };
        if better {
            best = Some(node);
        }
    }
    best
}

/// `displayNameIn`: the set's name for a variant, else the component's.
pub fn display_name(draft: &Working, component: &Node) -> Atom {
    set_of(draft, component)
        .map(|set| set.name)
        .unwrap_or(component.name)
}

/// `definitionsIn`: a variant sees its set's properties plus its own.
pub fn definitions_in(draft: &Working, component: &Node) -> IndexMap<Atom, PropertyDefinition> {
    if component.kind == NodeType::ComponentSet {
        return component
            .props
            .component_property_definitions()
            .map(|definitions| (**definitions).clone())
            .unwrap_or_default();
    }
    let own = component.props.component_property_definitions();
    let Some(set) = set_of(draft, component) else {
        return own
            .map(|definitions| (**definitions).clone())
            .unwrap_or_default();
    };
    let mut shared = set
        .props
        .component_property_definitions()
        .map(|definitions| (**definitions).clone())
        .unwrap_or_default();
    if let Some(own) = own.filter(|own| !own.is_empty()) {
        for (key, def) in own.iter() {
            shared.insert(*key, def.clone());
        }
    }
    shared
}

/// `variantValuesIn`: the parsed name, missing values filled from the set's defaults. Keys and values as text (the
/// caller interns what it stores).
pub fn variant_values_in(draft: &Working, component: &Node) -> Map<String> {
    let parsed = parse_variant_name(draft.atom(component.name)).unwrap_or_default();
    let Some(set) = set_of(draft, component) else {
        return parsed;
    };
    let mut out = Map::new();
    for (key, def) in set
        .props
        .component_property_definitions()
        .into_iter()
        .flat_map(|definitions| definitions.iter())
    {
        if def.kind == ComponentPropertyType::Variant {
            let key = draft.atom(*key);
            let value = parsed
                .get(key)
                .cloned()
                .unwrap_or_else(|| property_string(draft, &def.default_value).into_owned());
            out.insert(key.to_owned(), value);
        }
    }
    out
}

/// `variantDefinitionsFromNames`: the VARIANT definitions the names imply; `None` when nothing changes. Interns the
/// keys and values the names introduce.
pub fn variant_definitions_from_names(
    draft: &mut Working,
    set_id: Id,
) -> Option<IndexMap<Atom, PropertyDefinition>> {
    let set = draft.arc(set_id)?.clone();
    let empty = IndexMap::new();
    let existing: &IndexMap<Atom, PropertyDefinition> = set
        .props
        .component_property_definitions()
        .map(|definitions| &**definitions)
        .unwrap_or(&empty);
    let mut order: Vec<String> = Vec::new();
    let mut used: Map<Vec<String>> = Map::new();
    for (key, def) in existing {
        if def.kind == ComponentPropertyType::Variant {
            let key = draft.atom(*key).to_owned();
            order.push(key.clone());
            used.insert(key, Vec::new());
        }
    }
    for id in set.children() {
        let Some(node) = draft.node(*id) else {
            continue;
        };
        if node.kind != NodeType::Component {
            continue;
        }
        let Some(parsed) = parse_variant_name(draft.atom(node.name)) else {
            continue;
        };
        for (key, value) in parsed {
            if !used.contains_key(&key) {
                order.push(key.clone());
                used.insert(key.clone(), Vec::new());
            }
            let values = used.get_mut(&key).expect("just inserted");
            if !values.contains(&value) {
                values.push(value);
            }
        }
    }
    let defaults = default_variant_in(draft, &set)
        .and_then(|fallback| parse_variant_name(draft.atom(fallback.name)))
        .unwrap_or_default();
    // What the names imply, as text; interned below once it is known to differ.
    struct Next {
        key: String,
        options: Vec<String>,
        default: String,
    }
    let mut kept: Vec<(Atom, PropertyDefinition)> = Vec::new();
    for (key, def) in existing {
        if def.kind != ComponentPropertyType::Variant {
            kept.push((*key, def.clone()));
        }
    }
    let mut implied: Vec<Next> = Vec::new();
    for key in &order {
        let values = &used[key];
        if values.is_empty() {
            continue;
        }
        let previous: Vec<String> = match draft.atom_of(key).and_then(|atom| existing.get(&atom)) {
            Some(def) if def.kind == ComponentPropertyType::Variant => def
                .variant_options
                .as_ref()
                .map(|options| {
                    options
                        .iter()
                        .map(|option| draft.atom(*option).to_owned())
                        .collect()
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        let mut options: Vec<String> = previous
            .iter()
            .filter(|value| values.contains(value))
            .cloned()
            .collect();
        options.extend(
            values
                .iter()
                .filter(|value| !previous.contains(value))
                .cloned(),
        );
        let default = match defaults.get(key) {
            Some(value) if options.contains(value) => value.clone(),
            _ => options[0].clone(),
        };
        implied.push(Next {
            key: key.clone(),
            options,
            default,
        });
    }
    // `next == existing`, compared as text (an atom the names introduce may not exist yet).
    let same = {
        let mut next_keys: Vec<(&str, Option<&Next>)> = kept
            .iter()
            .map(|(key, _)| (draft.atom(*key), None))
            .collect();
        next_keys.extend(implied.iter().map(|next| (next.key.as_str(), Some(next))));
        next_keys.len() == existing.len()
            && next_keys.iter().all(|(key, implied)| {
                let Some(def) = draft.atom_of(key).and_then(|atom| existing.get(&atom)) else {
                    return false;
                };
                match implied {
                    None => def.kind != ComponentPropertyType::Variant,
                    Some(next) => {
                        def.kind == ComponentPropertyType::Variant
                            && matches!(&def.default_value, PropertyValue::Text(value) if draft.atom(*value) == next.default)
                            && def.variant_options.as_ref().is_some_and(|options| {
                                options.len() == next.options.len()
                                    && options
                                        .iter()
                                        .zip(&next.options)
                                        .all(|(option, value)| draft.atom(*option) == value)
                            })
                            && def.preferred_values.is_none()
                    }
                }
            })
    };
    if same {
        return None;
    }
    let mut next: IndexMap<Atom, PropertyDefinition> = IndexMap::new();
    for (key, def) in kept {
        next.insert(key, def);
    }
    for Next {
        key,
        options,
        default,
    } in implied
    {
        let key = draft.intern_atom(&key);
        let options: Vec<Atom> = options
            .iter()
            .map(|option| draft.intern_atom(option))
            .collect();
        let default = draft.intern_atom(&default);
        next.insert(
            key,
            PropertyDefinition {
                kind: ComponentPropertyType::Variant,
                default_value: PropertyValue::Text(default),
                variant_options: Some(options.into()),
                preferred_values: None,
            },
        );
    }
    Some(next)
}
