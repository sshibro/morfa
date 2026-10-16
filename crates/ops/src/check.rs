//! shared/design/schema.ts `checkPatchedDocument` / `patchedDocumentIssues`: the invariants a patch could have broken,
//! checked on the nodes it touched (`after` is `applyPatch(before, patch)` and `before` was valid). Cost grows with the
//! patch, not the file. The shape of each entry is the schema's business (`validatePatch`, the model's reader); this
//! is the structural half the server runs after every merge. Messages, paths and entries are the TypeScript's.

use crate::doc::{CHECK_FIELDS, DocRead, STRUCTURE_FIELDS};
use crate::merge::{CONTAINER_TYPES, LIBRARY_PAGE_ID};
use crate::patch::{pages_of, table_of};
use crate::value::{Object, Str, Value};
use foldhash::fast::FixedState;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

/// `DESIGN_DOCUMENT_CAPS.nodes`, or the big-files cap when the switch is on (`morfa_model::limits`).
pub fn nodes_cap() -> usize {
    morfa_model::limits::caps::nodes()
}
/// `DESIGN_FIELD_LIMITS.depth`.
const DEPTH: usize = 256;
/// `DESIGN_FIELD_LIMITS.pathCommands`.
const PATH_COMMANDS: usize = 100_000;

/// `PatchEntry`: the entry a refusal is about (`key` None: the table as a whole, or the page order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchEntry {
    pub table: &'static str,
    pub key: Option<Str>,
}

/// `Invalid`: one refusal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid {
    pub message: String,
    pub path: String,
    pub entry: Option<PatchEntry>,
}

type Check<T = ()> = Result<T, Invalid>;

fn invalid<T>(message: &str, path: impl Into<String>) -> Check<T> {
    Err(Invalid {
        message: message.to_owned(),
        path: path.into(),
        entry: None,
    })
}

fn node_entry(key: &str) -> PatchEntry {
    PatchEntry {
        table: "nodes",
        key: Some(key.into()),
    }
}

const PAGES: PatchEntry = PatchEntry {
    table: "pages",
    key: None,
};

/// The node table of `after`, read entry by entry.
struct Nodes<'a>(&'a dyn DocRead);

impl Nodes<'_> {
    fn get(&self, id: &str) -> Option<Value> {
        self.0.projection(id, CHECK_FIELDS)
    }

    fn contains_key(&self, id: &str) -> bool {
        self.get(id).is_some()
    }
}

fn ids(value: Option<&Value>) -> Vec<Str> {
    value
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(|id| {
            if let Value::String(id) = id {
                Some(id.clone())
            } else {
                None
            }
        })
        .collect()
}

fn kind(node: &Value) -> Option<&str> {
    node.get("type").and_then(Value::as_str)
}

/// `node.parentId`: `Some(None)` for null, `None` when absent or not a string.
fn parent(node: &Value) -> Option<Option<&str>> {
    match node.get("parentId") {
        Some(Value::Null) => Some(None),
        Some(Value::String(parent)) => Some(Some(parent)),
        _ => None,
    }
}

fn is_container(node: &Value) -> bool {
    kind(node).is_some_and(|kind| CONTAINER_TYPES.contains(&kind))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn has(node: &Value, key: &str) -> bool {
    node.get(key).is_some()
}

/// `checkNode`: what a node of its type must carry, and its text runs.
fn check_node(node: &Value, path: &str) -> Check {
    let container = is_container(node);
    let children = node.get("children");
    if container && !matches!(children, Some(Value::Array(_))) {
        return invalid("The container has no layer list.", format!("{path}.children"));
    }
    if !container && children.is_some() {
        return invalid(
            "This layer cannot have nested layers.",
            format!("{path}.children"),
        );
    }
    let node_kind = kind(node);
    if matches!(node_kind, Some("GROUP" | "BOOLEAN_OPERATION"))
        && children
            .and_then(Value::as_array)
            .is_some_and(<[Value]>::is_empty)
    {
        return invalid(
            "A group must contain at least one layer.",
            format!("{path}.children"),
        );
    }
    let parent_is_null = matches!(node.get("parentId"), Some(Value::Null));
    if node_kind == Some("PAGE") {
        if !parent_is_null {
            return invalid(
                "A page cannot be nested.",
                format!("{path}.parentId"),
            );
        }
    } else if parent_is_null {
        return invalid("The layer has no parent.", format!("{path}.parentId"));
    }
    if node_kind == Some("TEXT") {
        let Some(text) = node.get("text").filter(|text| text.truthy()) else {
            return invalid("The text layer has no text.", format!("{path}.text"));
        };
        let length = utf16_len(text.get("characters").and_then(Value::as_str).unwrap_or("")) as f64;
        let mut end = 0.0;
        for (i, run) in text
            .get("runs")
            .and_then(Value::as_array)
            .unwrap_or(&[])
            .iter()
            .enumerate()
        {
            let start = run.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let run_end = run.get("end").and_then(Value::as_f64).unwrap_or(f64::NAN);
            if start < end || run_end <= start || run_end > length {
                return invalid(
                    "Text runs overlap or go beyond the text.",
                    format!("{path}.text.runs.{i}"),
                );
            }
            end = run_end;
        }
    } else if has(node, "text") {
        return invalid(
            "Only a text layer has text.",
            format!("{path}.text"),
        );
    }
    if has(node, "textPath") && node_kind != Some("TEXT") {
        return invalid(
            "Only a text layer has a text path.",
            format!("{path}.textPath"),
        );
    }
    if has(node, "measurements") && node_kind != Some("PAGE") {
        return invalid(
            "Only a page stores measurements.",
            format!("{path}.measurements"),
        );
    }
    if has(node, "annotations") && node_kind == Some("PAGE") {
        return invalid("A page has no annotations.", format!("{path}.annotations"));
    }
    for field in ["annotations", "measurements"] {
        if let Some(entries) = node
            .get(field)
            .filter(|entries| entries.truthy())
            .and_then(Value::as_array)
        {
            let distinct: HashSet<String> = entries
                .iter()
                .map(|entry| entry.get("id").map(Value::to_json).unwrap_or_default())
                .collect();
            if distinct.len() != entries.len() {
                return invalid(
                    "Duplicate identifier in the list.",
                    format!("{path}.{field}"),
                );
            }
        }
    }
    if let Some(vectors) = node.get("vectorPaths").filter(|vectors| vectors.truthy()) {
        let commands: usize = vectors
            .as_array()
            .unwrap_or(&[])
            .iter()
            .map(|vector| {
                vector
                    .get("commands")
                    .and_then(Value::as_array)
                    .map_or(0, <[Value]>::len)
            })
            .sum();
        if commands > PATH_COMMANDS {
            return invalid("The path is too complex.", format!("{path}.vectorPaths"));
        }
    }
    let id = node.get("id").and_then(Value::as_str).unwrap_or("");
    if id.contains(';') != has(node, "mainId") {
        return invalid(
            "An instance layer must refer to a component layer.",
            format!("{path}.mainId"),
        );
    }
    let on_library = parent(node) == Some(Some(LIBRARY_PAGE_ID));
    if on_library
        && (!node.get("remote").is_some_and(Value::truthy)
            || !matches!(node_kind, Some("COMPONENT" | "COMPONENT_SET")))
    {
        return invalid(
            "Only components from libraries live on the libraries page.",
            format!("{path}.parentId"),
        );
    }
    if has(node, "remote") && !on_library {
        return invalid(
            "A library component lives only on the libraries page.",
            format!("{path}.remote"),
        );
    }
    Ok(())
}

/// `checkAncestry`: a node inside an instance is `${instanceId};${mainId}` for one of its INSTANCE ancestors; the chain
/// reaches a page without a cycle. Returns the node's depth.
fn check_ancestry(nodes: &Nodes, node: &Value, path: &str) -> Check<usize> {
    let main_id = node.get("mainId");
    let mut instance = main_id.is_none();
    let id = node.get("id").and_then(Value::as_str).unwrap_or("");
    let mut current = node.clone();
    let mut steps = 0;
    loop {
        let parent_id = match current.get("parentId") {
            Some(Value::Null) => break,
            Some(Value::String(parent)) => parent.clone(),
            _ => Str::from("undefined"),
        };
        steps += 1;
        if steps > DEPTH {
            return invalid(
                "Nesting is too deep or the layers form a cycle.",
                format!("{path}.parentId"),
            );
        }
        let Some(parent) = nodes.get(&parent_id) else {
            return invalid("The layer's parent was not found.", format!("{path}.parentId"));
        };
        if !instance && kind(&parent) == Some("INSTANCE") {
            let parent_id = parent.get("id").and_then(Value::as_str).unwrap_or("");
            let main = match main_id {
                Some(Value::String(main)) => main.to_string(),
                Some(other) => other.to_json(),
                None => String::new(),
            };
            if id == format!("{parent_id};{main}") {
                instance = true;
            }
        }
        current = parent;
    }
    if kind(&current) != Some("PAGE") {
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

/// `listing`: how often each id stands in a node's children list, counted once per node.
type Counts = HashMap<Str, usize, FixedState>;

struct Listing<'a> {
    nodes: &'a Nodes<'a>,
    cache: RefCell<HashMap<Str, Option<Counts>, FixedState>>,
}

impl Listing<'_> {
    fn count(&self, parent_id: &str, id: &str) -> usize {
        if let Some(counts) = self.cache.borrow().get(parent_id) {
            return counts
                .as_ref()
                .and_then(|counts| counts.get(id).copied())
                .unwrap_or(0);
        }
        let counts = self.nodes.get(parent_id).map(|parent| {
            let mut counts: HashMap<Str, usize, FixedState> = HashMap::default();
            for child in ids(parent
                .get("children")
                .filter(|children| !children.is_null()))
            {
                *counts.entry(child).or_insert(0) += 1;
            }
            counts
        });
        let answer = counts
            .as_ref()
            .and_then(|counts| counts.get(id).copied())
            .unwrap_or(0);
        // A parent missing from the table is not cached, as the TypeScript does.
        if counts.is_some() {
            self.cache.borrow_mut().insert(parent_id.into(), counts);
        }
        answer
    }
}

/// `checkLinks`: the node's own place: its parent lists it exactly once, its children name it as parent.
fn check_links(nodes: &Nodes, node: &Value, path: &str, listed: &Listing) -> Check {
    let id = node.get("id").and_then(Value::as_str).unwrap_or("");
    if let Some(Some(parent_id)) = parent(node) {
        if !nodes.contains_key(parent_id) {
            return invalid("The layer's parent was not found.", format!("{path}.parentId"));
        }
        if listed.count(parent_id, id) != 1 {
            return invalid(
                "A layer must appear in its parent's list exactly once.",
                format!("{path}.parentId"),
            );
        }
    }
    if let Some(children) = node
        .get("children")
        .filter(|children| children.truthy())
        .and_then(Value::as_array)
    {
        let mut seen: HashSet<&str> = HashSet::new();
        for (i, child_id) in children.iter().enumerate() {
            let child_id = child_id.as_str().unwrap_or("");
            let child = nodes.get(child_id);
            if !child.is_some_and(|child| parent(&child) == Some(Some(id)))
                || seen.contains(child_id)
            {
                return invalid(
                    "The layer list does not match the layer parents.",
                    format!("{path}.children.{i}"),
                );
            }
            seen.insert(child_id);
        }
    }
    Ok(())
}

/// `checkPages`: the page list names pages, each once, never the library page.
fn check_pages(after: &dyn DocRead, nodes: &Nodes) -> Check<HashSet<Str>> {
    let mut seen = HashSet::new();
    for (i, page_id) in ids(Some(&after.pages())).into_iter().enumerate() {
        let page = nodes.get(&page_id);
        if !page.is_some_and(|page| kind(&page) == Some("PAGE"))
            || seen.contains(&page_id)
            || &*page_id == LIBRARY_PAGE_ID
        {
            return Err(Invalid {
                message: "The page list does not match the file's pages.".into(),
                path: format!("pages.{i}"),
                entry: Some(PAGES),
            });
        }
        seen.insert(page_id);
    }
    Ok(seen)
}

/// `patchedIssues`: every entry of a patch whose invariants fail, at most `limit`.
pub fn patched_issues(
    before: &dyn DocRead,
    after: &dyn DocRead,
    patch: &Value,
    limit: usize,
    node_count: Option<&dyn Fn() -> usize>,
) -> Vec<Invalid> {
    let mut found: Vec<Invalid> = Vec::new();
    // attempt: a refusal is recorded with the entry it is about; enough of them stops the check.
    let mut attempt = |entry: Option<PatchEntry>, result: Check| -> bool {
        if let Err(mut error) = result {
            if let Some(entry) = entry {
                error.entry = Some(entry);
            }
            found.push(error);
            return found.len() >= limit;
        }
        false
    };
    let nodes = &Nodes(after);
    let count = if patch.get("nodes").is_some_and(Value::truthy) {
        node_count.map_or_else(|| after.size("nodes"), |count| count())
    } else {
        0
    };
    let cap = nodes_cap();
    if count > cap {
        let error = Invalid {
            message: format!("The file has more than {cap} layers."),
            path: "nodes".into(),
            entry: Some(PatchEntry {
                table: "nodes",
                key: None,
            }),
        };
        if attempt(None, Err(error)) {
            return found;
        }
    }
    for table in ["styles", "variableCollections", "variables"] {
        for (entry, value) in table_of(patch, table)
            .map(Object::iter)
            .into_iter()
            .flatten()
        {
            if value.truthy() && !value.get("id").is_some_and(|id| id.as_str() == Some(entry)) {
                let result = invalid(
                    "The entry key does not match its identifier.",
                    format!("{table}.{entry}.id"),
                );
                if attempt(
                    Some(PatchEntry {
                        table,
                        key: Some(entry.clone()),
                    }),
                    result,
                ) {
                    return found;
                }
            }
        }
    }
    let after_pages = ids(Some(&after.pages()));
    let mut pages: HashSet<Str> = after_pages.iter().cloned().collect();
    if pages_of(patch).is_some() {
        let result = (|| {
            pages = check_pages(after, nodes)?;
            if pages.len() != after_pages.len() {
                return invalid("Pages are repeated.", "pages");
            }
            for page_id in ids(Some(&before.pages())) {
                if !pages.contains(&page_id) && nodes.contains_key(&page_id) {
                    return invalid(
                        "The page is not in the page list.",
                        format!("nodes.{page_id}"),
                    );
                }
            }
            Ok(())
        })();
        if attempt(Some(PAGES), result) {
            return found;
        }
    }
    if let Some(patched) = table_of(patch, "nodes") {
        after.prefetch_projection(&mut patched.keys(), CHECK_FIELDS);
        before.prefetch_projection(&mut patched.keys(), STRUCTURE_FIELDS);
        let parents: Vec<Str> = patched
            .keys()
            .filter_map(|id| nodes.get(id))
            .filter_map(|node| parent(&node).flatten().map(Str::from))
            .collect();
        after.prefetch_projection(&mut parents.iter(), CHECK_FIELDS);
    }
    let listed = Listing {
        nodes,
        cache: RefCell::new(HashMap::default()),
    };
    let mut walked: HashSet<Str> = HashSet::new();
    for (node_id, value) in table_of(patch, "nodes")
        .map(Object::iter)
        .into_iter()
        .flatten()
    {
        let result = (|| {
            let path = format!("nodes.{node_id}");
            let previous = before.projection(node_id, STRUCTURE_FIELDS);
            if value.is_null() {
                if pages.contains(node_id) {
                    return invalid("A deleted page is still in the page list.", "pages");
                }
                if let Some(previous) = &previous {
                    if let Some(Some(parent_id)) = parent(previous)
                        && listed.count(parent_id, node_id) > 0
                    {
                        return invalid("A deleted layer is still in its parent's list.", path);
                    }
                    for child in ids(previous.get("children")) {
                        if nodes
                            .get(&child)
                            .is_some_and(|kept| parent(&kept) == Some(Some(&**node_id)))
                        {
                            return invalid(
                                "A deleted layer still has nested layers.",
                                format!("nodes.{child}"),
                            );
                        }
                    }
                }
                return Ok(());
            }
            let Some(node) = nodes.get(node_id) else {
                return invalid("The layer's parent was not found.", path);
            };
            let node = &node;
            if node.get("id").and_then(Value::as_str) != Some(&**node_id) {
                return invalid(
                    "The layer key does not match its identifier.",
                    format!("{path}.id"),
                );
            }
            check_node(node, &path)?;
            let node_kind = kind(node);
            if node_kind == Some("PAGE")
                && !pages.contains(node_id)
                && &**node_id != LIBRARY_PAGE_ID
            {
                return invalid("The page is not in the page list.", path);
            }
            if node_kind != Some("PAGE") && pages.contains(node_id) {
                return invalid("The page list does not match the file's pages.", "pages");
            }
            check_links(nodes, node, &path, &listed)?;
            if let Some(previous) = &previous {
                // Leaving a parent: the old parent must have let go of it.
                if let Some(Some(old_parent)) = parent(previous)
                    && parent(node) != Some(Some(old_parent))
                    && listed.count(old_parent, node_id) > 0
                {
                    return invalid(
                        "The layer is still in its former parent's list.",
                        format!("{path}.parentId"),
                    );
                }
                // Children it no longer lists must have moved elsewhere.
                for child in ids(previous.get("children")) {
                    if nodes
                        .get(&child)
                        .is_some_and(|kept| parent(&kept) == Some(Some(&**node_id)))
                        && listed.count(node_id, &child) == 0
                    {
                        return invalid(
                            "The layer list does not match the layer parents.",
                            format!("nodes.{child}"),
                        );
                    }
                }
            }
            let level = if node_kind == Some("PAGE") {
                0
            } else {
                check_ancestry(nodes, node, &path)?
            };
            // A subtree that moved under another parent, or whose root changed type: its depth changed with it, and its
            // instance copies must still lie under their instance.
            if let Some(previous) = &previous {
                let moved = !previous
                    .get("parentId")
                    .unwrap_or(&Value::Null)
                    .identical(node.get("parentId").unwrap_or(&Value::Null))
                    || !previous
                        .get("type")
                        .unwrap_or(&Value::Null)
                        .identical(node.get("type").unwrap_or(&Value::Null));
                let children = ids(node.get("children"));
                if moved && !children.is_empty() {
                    let mut queue: Vec<(Str, usize)> = children
                        .into_iter()
                        .map(|child| (child, level + 1))
                        .collect();
                    let mut at = 0;
                    while at < queue.len() {
                        let (child_id, child_level) = queue[at].clone();
                        at += 1;
                        if walked.contains(&child_id) {
                            continue;
                        }
                        walked.insert(child_id.clone());
                        if child_level > DEPTH {
                            return invalid(
                                "Layer nesting is too deep.",
                                format!("nodes.{child_id}"),
                            );
                        }
                        let child = nodes.get(&child_id);
                        if let Some(child) = child.as_ref().filter(|child| has(child, "mainId")) {
                            check_ancestry(nodes, child, &format!("nodes.{child_id}"))?;
                        }
                        for grandchild in
                            ids(child.as_ref().and_then(|child| child.get("children")))
                        {
                            queue.push((grandchild, child_level + 1));
                        }
                    }
                }
            }
            Ok(())
        })();
        if attempt(Some(node_entry(node_id)), result) {
            return found;
        }
    }
    found
}

/// `checkPatchedDocument(before, after, patch, nodeCount?)`: the first refusal, if any.
pub fn check_patched_document(
    before: &dyn DocRead,
    after: &dyn DocRead,
    patch: &Value,
    node_count: Option<&dyn Fn() -> usize>,
) -> Option<Invalid> {
    patched_issues(before, after, patch, 1, node_count)
        .into_iter()
        .next()
}

/// `DesignValidation` as JSON-like data: `{ok: true}` (the caller adds `value: after`) or `{ok: false, error, path, entry?}`.
pub fn validation(result: Option<Invalid>) -> Value {
    let mut out = Object::new();
    match result {
        None => out.insert("ok", Value::Bool(true)),
        Some(error) => {
            out.insert("ok", Value::Bool(false));
            out.insert("error", Value::str(&error.message));
            out.insert("path", Value::str(&error.path));
            if let Some(entry) = error.entry {
                let mut record = Object::new();
                record.insert("table", Value::str(entry.table));
                record.insert("key", entry.key.map_or(Value::Null, Value::String));
                out.insert("entry", Value::object(record));
            }
        }
    }
    Value::object(out)
}

/// [`check_patched_document`] as [`validation`] data.
pub fn check_patched_document_json(
    before: &dyn DocRead,
    after: &dyn DocRead,
    patch: &Value,
    node_count: Option<usize>,
) -> Value {
    let count = node_count.map(|count| move || count);
    validation(check_patched_document(
        before,
        after,
        patch,
        count.as_ref().map(|count| count as &dyn Fn() -> usize),
    ))
}
