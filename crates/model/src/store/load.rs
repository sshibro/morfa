//! Loading a file's nodes straight into the store (lane N1 step 7): a part of the file (`{"nodes": {id: node, …}}`,
//! what `MorfaDoc.load_part` is sent) is read node by node, each converted and inserted as soon as it is parsed, so
//! the part's JSON model never exists whole. The JSON model costs ≈ 3.8 KB a node against the store's ≈ 0.4 KB
//! (morfa-model-bench on f20k); building it for 2 000 nodes at a time between the long-lived store allocations is what
//! fragmented the wasm heap, whose linear memory never shrinks (f100k loaded in 500-node parts: 91 MiB of wasm memory
//! for a 39 MB store).

use std::fmt;
use std::sync::Arc;

use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, Visitor};

use super::convert::{Interning, Shared, node_in};
use super::document::Document;
use crate::de::Strict;
use crate::types::SceneNode;
use crate::validate::Invalid;

/// What [`Document::load_nodes_json`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    /// The nodes were loaded; how many entries the part held.
    Nodes(usize),
    /// The part holds more than nodes (pages, tables): nothing was read into the document; apply it as a patch.
    NotNodesOnly,
}

impl Document {
    /// Reads `{"nodes": {id: node | null, …}}` into the document node by node, with the strict rules of
    /// `patch_from_json` (`crate::de::Strict`). A `null` removes the node of that key. Errors leave the nodes read so
    /// far in place (a part the model refuses is a load that fails as a whole: the caller drops the document).
    pub fn load_nodes_json(&mut self, json: &str) -> Result<Loaded, Invalid> {
        let mut deserializer = serde_json::Deserializer::from_str(json);
        let loaded = Strict(&mut deserializer)
            .deserialize_struct("Part", &["nodes"], Part { doc: self })
            .and_then(|loaded| deserializer.end().map(|()| loaded))
            .map_err(|error| Invalid::new(format!("Invalid value: {error}."), ""))?;
        Ok(loaded)
    }
}

/// The part's object: `nodes` is read entry by entry; any other key means the part is a general patch.
struct Part<'d> {
    doc: &'d mut Document,
}

impl<'de> Visitor<'de> for Part<'_> {
    type Value = Loaded;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a part of a document")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Loaded, A::Error> {
        let mut loaded = Loaded::Nodes(0);
        while let Some(key) = map.next_key::<String>()? {
            if key != "nodes" || loaded != Loaded::Nodes(0) {
                // Not a nodes-only part (or `nodes` twice): nothing read here counts.
                return if matches!(loaded, Loaded::Nodes(0)) {
                    Err(de::Error::custom("not a nodes-only part"))
                } else {
                    Err(de::Error::custom("a part names its nodes once"))
                };
            }
            loaded = Loaded::Nodes(map.next_value_seed(NodesSeed { doc: self.doc })?);
        }
        Ok(loaded)
    }
}

/// The `nodes` table: each entry converted and inserted as it is read.
struct NodesSeed<'d> {
    doc: &'d mut Document,
}

impl<'de> DeserializeSeed<'de> for NodesSeed<'_> {
    type Value = usize;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<usize, D::Error> {
        // `deserialize_struct`, not `deserialize_map`: the strict wrapper hands a struct's entries on strictly.
        deserializer.deserialize_struct("Nodes", &[], Nodes { doc: self.doc })
    }
}

struct Nodes<'d> {
    doc: &'d mut Document,
}

impl<'de> Visitor<'de> for Nodes<'_> {
    type Value = usize;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a node table")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<usize, A::Error> {
        let mut count = 0;
        while let Some(key) = map.next_key::<String>()? {
            count += 1;
            match map.next_value::<Option<SceneNode>>()? {
                Some(node) => {
                    let mut shared = Shared {
                        ids: &mut self.doc.ids,
                        atoms: &mut self.doc.atoms,
                    };
                    let mut cx = Interning::new(&mut shared);
                    let node = node_in(&node, &mut cx);
                    self.doc.insert(Arc::new(node));
                }
                None => {
                    if let Some(id) = self.doc.ids.get(&key) {
                        self.doc.remove(id);
                    }
                }
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{from_json, patch_from_json};
    use crate::types::DesignDocument;

    fn document() -> DesignDocument {
        from_json(
            r#"{"schemaVersion":1,"pages":["p"],"nodes":{"p":{"id":"p","type":"PAGE","name":"p","parentId":null,"children":["r","t"],"visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":0,"height":0,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[]},"r":{"id":"r","type":"RECTANGLE","name":"r","parentId":"p","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":1,"y":2,"width":3,"height":4,"rotation":0,"fills":[{"type":"SOLID","color":{"r":1,"g":0,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL"}],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"cornerRadius":5},"t":{"id":"t","type":"TEXT","name":"t","parentId":"p","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":3,"height":4,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"text":{"characters":"Привет","style":{"fontFamily":"Inter","fontWeight":400,"italic":false,"fontSize":12,"lineHeight":{"unit":"AUTO"},"letterSpacing":{"unit":"PIXELS","value":0},"textCase":"ORIGINAL","textDecoration":"NONE"},"runs":[],"textAlignHorizontal":"LEFT","textAlignVertical":"TOP","textAutoResize":"WIDTH_AND_HEIGHT","paragraphSpacing":0,"paragraphIndent":0}}},"styles":{},"images":{},"variableCollections":{},"variables":{}}"#,
        )
        .expect("a document")
    }

    #[test]
    fn nodes_loaded_part_by_part_equal_the_document_loaded_whole() {
        let model = document();
        let whole = Document::from_model(&model);
        let mut skeleton = model.clone();
        skeleton.nodes.clear();
        let mut parts = Document::from_model(&skeleton);
        let json = |ids: &[&str]| {
            let nodes: indexmap::IndexMap<_, _> = ids
                .iter()
                .map(|id| ((*id).to_owned(), Some(model.nodes[*id].clone())))
                .collect();
            crate::json::to_json(&crate::DocumentPatch {
                nodes: Some(nodes),
                ..Default::default()
            })
        };
        assert_eq!(
            parts.load_nodes_json(&json(&["p", "r"])),
            Ok(Loaded::Nodes(2))
        );
        assert_eq!(parts.load_nodes_json(&json(&["t"])), Ok(Loaded::Nodes(1)));
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.to_model(), whole.to_model());
        // The ids were interned in the order read, as a patch's would be.
        assert_eq!(
            parts.ids().iter().collect::<Vec<_>>(),
            whole.ids().iter().collect::<Vec<_>>()
        );
        // A removal, and a part that is a general patch.
        assert_eq!(
            parts.load_nodes_json(r#"{"nodes":{"t":null}}"#),
            Ok(Loaded::Nodes(1))
        );
        assert_eq!(parts.len(), 2);
        assert!(parts.load_nodes_json(r#"{"pages":["p"]}"#).is_err());
        assert!(
            parts
                .load_nodes_json(r#"{"nodes":{"r":{"id":"r"}}}"#)
                .is_err(),
            "a node the model refuses"
        );
        // The strict rules hold for the nodes read this way: an enum from an object is refused, as a patch refuses it.
        let bad = r#"{"nodes":{"r":{"id":"r","type":{"RECTANGLE":null},"name":"r","parentId":"p","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":1,"y":2,"width":3,"height":4,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[]}}}"#;
        assert!(patch_from_json(bad).is_err());
        assert!(parts.load_nodes_json(bad).is_err());
    }
}
