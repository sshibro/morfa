//! `DocumentPatch` (shared/design/patch.ts): a change to a file at the granularity the editor and the server both
//! understand. Whole nodes, styles, images, variable collections, variables and mode choices are replaced, or removed
//! with `null` (`None` here); `pages` is the full new page order when it changed. Undo/redo, autosave and version
//! restore all move documents with these, and the engine's shadow document follows the editor through them.
//!
//! Inverting, composing and diffing patches is lane L2a's (`crates/ops`); this module holds the type and the in-place
//! application the shadow document needs.

use crate::de;
use crate::types::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub nodes: Option<Map<Option<SceneNode>>>,
    /// The full new page order, when it changed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub pages: Option<Vec<NodeId>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub styles: Option<Map<Option<Style>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub images: Option<Map<Option<ImageAsset>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub variable_collections: Option<Map<Option<VariableCollection>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub variables: Option<Map<Option<Variable>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de::some"
    )]
    pub variable_modes: Option<Map<Option<Map<String>>>>,
}

/// The tables of a document a patch replaces entries of (`PATCH_TABLES`).
pub const PATCH_TABLES: [&str; 6] = [
    "nodes",
    "styles",
    "images",
    "variableCollections",
    "variables",
    "variableModes",
];

fn has_entries<T>(table: &Option<Map<T>>) -> bool {
    table.as_ref().is_some_and(|table| !table.is_empty())
}

/// Writes one table's changes in place: a value replaces the entry (keeping its position), `None` removes it
/// (keeping the order of the rest, as JavaScript's `delete` does).
fn apply_table<T: Clone>(table: &mut Map<T>, changes: &Map<Option<T>>) {
    for (key, change) in changes {
        match change {
            Some(value) => {
                table.insert(key.clone(), value.clone());
            }
            None => {
                table.shift_remove(key);
            }
        }
    }
}

impl DocumentPatch {
    /// `isEmptyPatch`: no page order and no entries in any table.
    pub fn is_empty(&self) -> bool {
        self.pages.is_none()
            && !has_entries(&self.nodes)
            && !has_entries(&self.styles)
            && !has_entries(&self.images)
            && !has_entries(&self.variable_collections)
            && !has_entries(&self.variables)
            && !has_entries(&self.variable_modes)
    }

    /// `applyPatch`, in place: the result equals the TypeScript's new document. A table that gets entries is
    /// created when the document has none (`variableModes`), as the TypeScript does even when every entry removes.
    pub fn apply(&self, doc: &mut DesignDocument) {
        if let Some(pages) = &self.pages {
            doc.pages.clone_from(pages);
        }
        if let Some(changes) = &self.nodes {
            apply_table(&mut doc.nodes, changes);
        }
        if let Some(changes) = &self.styles {
            apply_table(&mut doc.styles, changes);
        }
        if let Some(changes) = &self.images {
            apply_table(&mut doc.images, changes);
        }
        if let Some(changes) = &self.variable_collections {
            apply_table(&mut doc.variable_collections, changes);
        }
        if let Some(changes) = &self.variables {
            apply_table(&mut doc.variables, changes);
        }
        if let Some(changes) = self
            .variable_modes
            .as_ref()
            .filter(|changes| !changes.is_empty())
        {
            apply_table(doc.variable_modes.get_or_insert_with(Map::default), changes);
        }
    }
}
