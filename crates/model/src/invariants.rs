//! The structural invariants of a schema-valid document (`checkDocument` in shared/design/schema.ts, docs/design-tool.md
//! §The document): keys match ids, pages are listed once, parents and children agree, every node is reachable from a
//! page within the depth limit, instance copies lie inside their instance, library copies only on the library page.
//! Iterative throughout: a hostile nesting depth cannot exhaust the stack. Messages and paths are the TypeScript's.

use crate::limits::{caps, field as L};
use crate::types::*;
use crate::validate::{Invalid, utf16_len};
use std::collections::{HashMap, HashSet};

type Result<T = ()> = std::result::Result<T, Invalid>;

fn invalid<T>(message: &str, path: impl Into<String>) -> Result<T> {
    Err(Invalid::new(message, path))
}

/// How often each id stands in a node's children list, counted once per parent: scanning a list of tens of
/// thousands of layers once per layer made the check quadratic.
struct Listing<'a> {
    nodes: &'a Map<SceneNode>,
    counts: HashMap<&'a str, HashMap<&'a str, usize>>,
}

impl<'a> Listing<'a> {
    fn new(nodes: &'a Map<SceneNode>) -> Self {
        Listing {
            nodes,
            counts: HashMap::new(),
        }
    }

    fn listed_in(&mut self, parent_id: &'a str, id: &str) -> usize {
        if !self.counts.contains_key(parent_id) {
            let Some(parent) = self.nodes.get(parent_id) else {
                return 0;
            };
            let mut counts = HashMap::new();
            for child in parent.children.iter().flatten() {
                *counts.entry(child.as_str()).or_insert(0) += 1;
            }
            self.counts.insert(parent_id, counts);
        }
        self.counts[parent_id].get(id).copied().unwrap_or(0)
    }
}

/// What a node of its type must carry, and its text runs (`checkNode`).
pub(crate) fn check_node(node: &SceneNode, path: &str) -> Result {
    let container = node.kind.is_container();
    if container && node.children.is_none() {
        return invalid("The container has no layer list.", format!("{path}.children"));
    }
    if !container && node.children.is_some() {
        return invalid(
            "This layer cannot have nested layers.",
            format!("{path}.children"),
        );
    }
    if matches!(node.kind, NodeType::Group | NodeType::BooleanOperation)
        && node.children.as_ref().is_some_and(Vec::is_empty)
    {
        return invalid(
            "A group must contain at least one layer.",
            format!("{path}.children"),
        );
    }
    let page = node.kind == NodeType::Page;
    if page != node.parent_id.is_none() {
        let message = if page {
            "A page cannot be nested."
        } else {
            "The layer has no parent."
        };
        return invalid(message, format!("{path}.parentId"));
    }
    if node.kind == NodeType::Text {
        let Some(text) = &node.text else {
            return invalid("The text layer has no text.", format!("{path}.text"));
        };
        let length = utf16_len(&text.characters) as f64;
        let mut end = 0.0;
        for (index, run) in text.runs.iter().enumerate() {
            if run.start < end || run.end <= run.start || run.end > length {
                return invalid(
                    "Text runs overlap or go beyond the text.",
                    format!("{path}.text.runs.{index}"),
                );
            }
            end = run.end;
        }
    } else if node.text.is_some() {
        return invalid(
            "Only a text layer has text.",
            format!("{path}.text"),
        );
    }
    if node.text_path.is_some() && node.kind != NodeType::Text {
        return invalid(
            "Only a text layer has a text path.",
            format!("{path}.textPath"),
        );
    }
    if node.measurements.is_some() && !page {
        return invalid(
            "Only a page stores measurements.",
            format!("{path}.measurements"),
        );
    }
    if node.annotations.is_some() && page {
        return invalid("A page has no annotations.", format!("{path}.annotations"));
    }
    // Co-editing merges these lists entry by entry (shared/design/merge.ts): an id stands once in its list.
    if let Some(annotations) = &node.annotations
        && !unique(annotations.iter().map(|annotation| annotation.id.as_str()))
    {
        return invalid(
            "Duplicate identifier in the list.",
            format!("{path}.annotations"),
        );
    }
    if let Some(measurements) = &node.measurements
        && !unique(
            measurements
                .iter()
                .map(|measurement| measurement.id.as_str()),
        )
    {
        return invalid(
            "Duplicate identifier in the list.",
            format!("{path}.measurements"),
        );
    }
    if let Some(paths) = &node.vector_paths
        && paths
            .iter()
            .map(|vector| vector.commands.len())
            .sum::<usize>()
            > L::PATH_COMMANDS
    {
        return invalid("The path is too complex.", format!("{path}.vectorPaths"));
    }
    if node.id.contains(';') != node.main_id.is_some() {
        return invalid(
            "An instance layer must refer to a component layer.",
            format!("{path}.mainId"),
        );
    }
    // The hidden library page holds only copies of library components, and only they carry `remote`.
    let on_library_page = node.parent_id.as_deref() == Some(LIBRARY_PAGE_ID);
    if on_library_page
        && (node.remote.is_none()
            || !matches!(node.kind, NodeType::Component | NodeType::ComponentSet))
    {
        return invalid(
            "Only components from libraries live on the libraries page.",
            format!("{path}.parentId"),
        );
    }
    if node.remote.is_some() && !on_library_page {
        return invalid(
            "A library component lives only on the libraries page.",
            format!("{path}.remote"),
        );
    }
    Ok(())
}

fn unique<'a>(ids: impl ExactSizeIterator<Item = &'a str>) -> bool {
    let count = ids.len();
    ids.collect::<HashSet<_>>().len() == count
}

/// A node inside an instance is `${instanceId};${mainId}` for one of its INSTANCE ancestors. Walks up at most
/// `L::DEPTH` steps; also proves the chain reaches a page without a cycle (`checkAncestry`).
pub(crate) fn check_ancestry(
    nodes: &Map<SceneNode>,
    node: &SceneNode,
    path: &str,
) -> Result<usize> {
    let mut instance = node.main_id.is_none();
    let mut current = node;
    let mut steps = 0;
    while let Some(parent_id) = &current.parent_id {
        steps += 1;
        if steps > L::DEPTH {
            return invalid(
                "Nesting is too deep or the layers form a cycle.",
                format!("{path}.parentId"),
            );
        }
        let Some(parent) = nodes.get(parent_id) else {
            return invalid("The layer's parent was not found.", format!("{path}.parentId"));
        };
        if !instance
            && parent.kind == NodeType::Instance
            && let Some(main_id) = &node.main_id
            && node.id.len() == parent.id.len() + 1 + main_id.len()
            && node.id.starts_with(parent.id.as_str())
            && node.id.as_bytes()[parent.id.len()] == b';'
            && node.id.ends_with(main_id.as_str())
        {
            instance = true;
        }
        current = parent;
    }
    if current.kind != NodeType::Page {
        return invalid("The layer is not on a page.", format!("{path}.parentId"));
    }
    if !instance {
        return invalid(
            "An instance layer lies outside its instance.",
            format!("{path}.mainId"),
        );
    }
    Ok(steps)
}

/// The node's own place: its parent lists it exactly once, its children name it as parent (`checkLinks`).
fn check_links<'a>(
    nodes: &'a Map<SceneNode>,
    node: &'a SceneNode,
    path: &str,
    listing: &mut Listing<'a>,
) -> Result {
    if let Some(parent_id) = &node.parent_id {
        if !nodes.contains_key(parent_id) {
            return invalid("The layer's parent was not found.", format!("{path}.parentId"));
        }
        if listing.listed_in(parent_id, &node.id) != 1 {
            return invalid(
                "A layer must appear in its parent's list exactly once.",
                format!("{path}.parentId"),
            );
        }
    }
    if let Some(children) = &node.children {
        let mut seen = HashSet::with_capacity(children.len());
        for (index, child_id) in children.iter().enumerate() {
            let linked = nodes
                .get(child_id)
                .is_some_and(|child| child.parent_id.as_ref() == Some(&node.id));
            if !linked || !seen.insert(child_id.as_str()) {
                return invalid(
                    "The layer list does not match the layer parents.",
                    format!("{path}.children.{index}"),
                );
            }
        }
    }
    Ok(())
}

fn check_pages(doc: &DesignDocument) -> Result<HashSet<&str>> {
    let mut seen = HashSet::with_capacity(doc.pages.len());
    for (index, page_id) in doc.pages.iter().enumerate() {
        let is_page = doc
            .nodes
            .get(page_id)
            .is_some_and(|page| page.kind == NodeType::Page);
        if !is_page || seen.contains(page_id.as_str()) || page_id == LIBRARY_PAGE_ID {
            return invalid(
                "The page list does not match the file's pages.",
                format!("pages.{index}"),
            );
        }
        seen.insert(page_id.as_str());
    }
    Ok(seen)
}

fn check_tables(doc: &DesignDocument) -> Result {
    const MISMATCH: &str = "The entry key does not match its identifier.";
    for (key, style) in &doc.styles {
        if &style.id != key {
            return invalid(MISMATCH, format!("styles.{key}.id"));
        }
    }
    for (key, collection) in &doc.variable_collections {
        if &collection.id != key {
            return invalid(MISMATCH, format!("variableCollections.{key}.id"));
        }
    }
    for (key, variable) in &doc.variables {
        if &variable.id != key {
            return invalid(MISMATCH, format!("variables.{key}.id"));
        }
    }
    Ok(())
}

/// Every invariant of docs/design-tool.md §The document over a schema-valid document (`checkDocument`).
pub(crate) fn check_document(doc: &DesignDocument) -> Result {
    let nodes = &doc.nodes;
    let cap = caps::nodes();
    if nodes.len() > cap {
        return invalid(&format!("The file has more than {cap} layers."), "nodes");
    }
    check_tables(doc)?;
    let pages = check_pages(doc)?;
    let mut listing = Listing::new(nodes);
    for (node_id, node) in nodes {
        let path = format!("nodes.{node_id}");
        if &node.id != node_id {
            return invalid(
                "The layer key does not match its identifier.",
                format!("{path}.id"),
            );
        }
        check_node(node, &path)?;
        if node.kind == NodeType::Page
            && !pages.contains(node_id.as_str())
            && node_id != LIBRARY_PAGE_ID
        {
            return invalid("The page is not in the page list.", path);
        }
        check_links(nodes, node, &path, &mut listing)?;
    }
    // Every node reachable from a page (the hidden library page included): with consistent links this rules out cycles.
    let mut depth: HashMap<&str, usize> = HashMap::with_capacity(nodes.len());
    let mut queue: Vec<&str> = Vec::with_capacity(nodes.len());
    let library = nodes
        .get(LIBRARY_PAGE_ID)
        .is_some_and(|page| page.kind == NodeType::Page);
    for page_id in doc
        .pages
        .iter()
        .map(String::as_str)
        .chain(library.then_some(LIBRARY_PAGE_ID))
    {
        depth.insert(page_id, 0);
        queue.push(page_id);
    }
    let mut at = 0;
    while at < queue.len() {
        let node_id = queue[at];
        at += 1;
        let level = depth[node_id];
        for child in nodes[node_id].children.iter().flatten() {
            if level + 1 > L::DEPTH {
                return invalid(
                    "Layer nesting is too deep.",
                    format!("nodes.{child}"),
                );
            }
            depth.insert(child, level + 1);
            queue.push(child);
        }
    }
    if queue.len() != nodes.len() {
        let lost = nodes
            .keys()
            .find(|node_id| !depth.contains_key(node_id.as_str()))
            .map_or("", String::as_str);
        return invalid(
            "The layer is not linked to any page.",
            format!("nodes.{lost}.parentId"),
        );
    }
    for (node_id, node) in nodes {
        if node.main_id.is_some() {
            check_ancestry(nodes, node, &format!("nodes.{node_id}"))?;
        }
    }
    Ok(())
}
