//! Field-level ops (protocol 2, lane W): an `op` may carry the nodes it changes as the fields it wrote
//! (`fields: {set, unset, was}`, crates/protocol `OpFields`) instead of whole nodes and their whole `before` copies.
//! Before the op applies, the actor expands them over its own nodes: the node it holds with `set` written and `unset`
//! removed is the op's node, and, when the op was made on an older version, the same node with `was` written instead
//! is its `before` copy. Every field the op did not touch is the server's in all three, so the merge (crates/ops)
//! decides exactly as for the whole-node op the client would have sent; the engine's apply, check and refusals are
//! the same code.
//!
//! The fields the hot paths write (position, size, rotation, opacity, visibility, name, text, fills, strokes, effects:
//! `morfa_model::json::NODE_FIELD_KEYS`) are read straight into the typed node; any other field goes through the
//! model's strict reader on the node's JSON form. Either way a value is read by the same rules as in a whole node.

use crate::engine::Refusal;
use morfa_model::{DocumentPatch, Map, NodeId, SceneNode};
use morfa_protocol::fields::scene_node_field;
use morfa_protocol::{Copies, ErrorCode, NodeDiff, Op, OpFields, Version};

/// One expanded node: its id and the fields the op set and removed (names as `SceneNode` writes them).
pub struct Expanded {
    pub id: NodeId,
    pub set: Vec<&'static str>,
    pub unset: Vec<&'static str>,
}

fn invalid(_seq: u64, id: &str, path: String, message: impl Into<String>) -> Refusal {
    Refusal {
        path: Some(path),
        node_id: Some(id.to_owned()),
        ..Refusal::new(ErrorCode::DesignDocumentInvalid, message)
    }
}

/// What [`expand`] made of an op's fields.
#[derive(Default)]
pub struct Expansion {
    /// The nodes expanded, in the order they went into `patch.nodes`.
    pub nodes: Vec<Expanded>,
    /// Nodes someone removed after the op's base: their edits are dropped, as the merge drops an edit of a removed
    /// layer (removal wins). The ack then carries `own` (crate::actor), as for an op the merge adjusted.
    pub dropped: Vec<NodeId>,
}

/// Expands `op.fields` into `op.patch` (and `op.before` when the op is behind `version`), reading each node from
/// `node`. A field node the server does not have is dropped when the op is behind (someone removed it since) and
/// refused when it is not (the client wrote a layer that does not exist).
pub fn expand(
    op: &mut Op,
    version: Version,
    node: impl Fn(&str) -> Option<SceneNode>,
) -> Result<Expansion, Refusal> {
    let Some(fields) = op.fields.take() else {
        return Ok(Expansion::default());
    };
    let behind = op.base_version != version;
    let seq = op.seq;
    let mut out = Expansion::default();
    let mut copies = Vec::new();
    for id in fields.ids() {
        if op
            .patch
            .nodes
            .as_ref()
            .is_some_and(|nodes| nodes.contains_key(id))
        {
            return Err(invalid(
                seq,
                id,
                format!("fields.set.{id}"),
                "The layer is sent both whole and as fields.",
            ));
        }
        let Some(current) = node(id) else {
            if behind {
                out.dropped.push(id.clone());
                continue;
            }
            return Err(invalid(
                seq,
                id,
                format!("fields.set.{id}"),
                "There is no such layer in the file.",
            ));
        };
        let set = fields.set.get(id);
        let unset = fields.unset.get(id).map(Vec::as_slice).unwrap_or(&[]);
        let mut names = Expanded {
            id: id.clone(),
            set: Vec::new(),
            unset: Vec::new(),
        };
        for key in set.into_iter().flat_map(|set| set.keys()) {
            names.set.push(scene_node_field(key).ok_or_else(|| {
                invalid(
                    seq,
                    id,
                    format!("fields.set.{id}.{key}"),
                    "Unknown layer field.",
                )
            })?);
        }
        for key in unset {
            names.unset.push(scene_node_field(key).ok_or_else(|| {
                invalid(
                    seq,
                    id,
                    format!("fields.unset.{id}.{key}"),
                    "Unknown layer field.",
                )
            })?);
        }
        if behind {
            // The client's copy at its base: the server's node with the op's fields as the client last saw them.
            let was = fields.was.get(id);
            let mut base_set = serde_json::Map::new();
            let mut base_unset = Vec::new();
            for key in names.set.iter().chain(&names.unset) {
                match was.and_then(|was| was.get(*key)) {
                    Some(value) => {
                        base_set.insert((*key).to_owned(), value.clone());
                    }
                    None => base_unset.push((*key).to_owned()),
                }
            }
            let before = spread(current.clone(), &base_set, &base_unset)
                .map_err(|message| invalid(seq, id, format!("fields.was.{id}"), message))?;
            copies.push((id.clone(), before));
        }
        let empty = serde_json::Map::new();
        let new = spread(current, set.unwrap_or(&empty), unset)
            .map_err(|message| invalid(seq, id, format!("fields.set.{id}"), message))?;
        op.patch
            .nodes
            .get_or_insert_with(Map::default)
            .insert(id.clone(), Some(new));
        out.nodes.push(names);
    }
    // Behind, the op merges: it always has copies then, even when every field node was dropped.
    if behind {
        let mut read = match op.before.take() {
            Some(mut raw) => raw
                .read(seq)
                .map_err(|e| Refusal {
                    path: e.path.clone(),
                    ..Refusal::new(e.code, e.message.clone())
                })?
                .clone(),
            None => Map::default(),
        };
        for (id, before) in copies {
            read.insert(id, Some(before));
        }
        op.before = Some(Copies::Read(read));
    }
    Ok(out)
}

/// `node` with `set` written and `unset` removed, every value read as `SceneNode` reads it
/// (`morfa_protocol::fields::spread_owned`: the hot fields typed, any other through the strict reader).
pub fn spread(
    node: SceneNode,
    set: &serde_json::Map<String, serde_json::Value>,
    unset: &[String],
) -> Result<SceneNode, String> {
    morfa_protocol::fields::spread_owned(node, set, unset)
}

/// The outgoing change's fields for an op that landed as sent: what it set and removed, by the nodes' places in the
/// stored patch (no diff needed). None when a node is not where it is expected (the change is then diffed).
pub fn diffs(expanded: &[Expanded], stored: &DocumentPatch) -> Option<Vec<NodeDiff>> {
    let nodes = stored.nodes.as_ref()?;
    let mut out = Vec::with_capacity(expanded.len());
    for node in expanded {
        let index = nodes.get_index_of(&node.id)?;
        nodes[index].as_ref()?;
        out.push(NodeDiff {
            index,
            set: node.set.clone(),
            unset: node.unset.clone(),
        });
    }
    out.sort_by_key(|diff| diff.index);
    Some(out)
}

/// Whether an op carries field-level nodes.
pub fn has_fields(op: &Op) -> bool {
    op.fields
        .as_ref()
        .is_some_and(|fields: &OpFields| fields.ids().next().is_some())
}
