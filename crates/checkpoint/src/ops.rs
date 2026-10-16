//! What a journal row holds, decoded into something a document takes.
//!
//! - `patch` (text): a JSON `DocumentPatch`, as Node writes it and as collab writes it while TARGETS §3b keeps ops in
//!   JSON (there is no stand-alone binary patch codec yet). Rows in this column stay readable by
//!   `server/design/document-store.ts` as they are.
//! - `op` (bytes), recognised by their first bytes: `{` a JSON patch; `MRFC` a whole document (a restore or an
//!   import: a checkpoint object inline); `MRFJ` a store journal entry of the model crate (it continues the
//!   interners of the document it follows, so it only replays in order on that document); `MRFZ` a JSON patch packed
//!   with zstd (crates/journal `packed`: how collab stores a large patch).

use crate::format::{self, FormatError};
use morfa_journal::Body;
use morfa_model::store::{Document, Entry};
use morfa_model::{DocumentPatch, to_json};

/// A decoded journal row.
#[derive(Debug)]
pub enum Op {
    Patch(Box<DocumentPatch>),
    Replace(Box<Document>),
    Entry(Box<Entry>),
}

/// The row body of a patch (JSON, in the `patch` column).
pub fn patch_body(patch: &DocumentPatch) -> Body {
    Body::Patch(to_json(patch))
}

/// The row body of a whole-document replacement (a checkpoint object inline, in the `op` column).
pub fn replace_body(doc: &Document, version: u64, format: format::Format) -> Body {
    Body::Op(format::encode(doc, version, format))
}

pub fn decode(body: &Body) -> Result<Op, FormatError> {
    match body {
        Body::Patch(text) => json_patch(text),
        Body::Op(bytes) => match bytes.first() {
            Some(b'{') => json_patch(
                std::str::from_utf8(bytes)
                    .map_err(|error| FormatError::Payload(error.to_string()))?,
            ),
            _ if bytes.starts_with(&format::MAGIC) => {
                Ok(Op::Replace(Box::new(format::decode(bytes)?.1)))
            }
            _ if morfa_journal::packed::is_packed(bytes) => {
                json_patch(&morfa_journal::packed::unpack(bytes).map_err(FormatError::Payload)?)
            }
            _ if bytes.starts_with(b"MRFJ") => {
                let entry = Entry::from_bytes(bytes)
                    .map_err(|error| FormatError::Payload(error.to_string()))?;
                Ok(Op::Entry(Box::new(entry)))
            }
            _ => Err(FormatError::Payload("an op of no known kind".into())),
        },
    }
}

fn json_patch(text: &str) -> Result<Op, FormatError> {
    morfa_model::patch_from_json(text)
        .map(|patch| Op::Patch(Box::new(patch)))
        .map_err(|error| FormatError::Payload(error.to_string()))
}

/// Applies a decoded row to the document it follows.
pub fn apply(doc: &mut Document, op: Op) -> Result<(), FormatError> {
    match op {
        Op::Patch(patch) => doc.apply_patch(&patch),
        Op::Replace(replacement) => *doc = *replacement,
        Op::Entry(entry) => doc
            .replay(&entry)
            .map_err(|error| FormatError::Payload(error.to_string()))?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packed_row_decodes_to_its_patch() {
        let patch = DocumentPatch {
            pages: Some((0..200).map(|i| format!("page-{i}")).collect()),
            ..Default::default()
        };
        let text = to_json(&patch);
        let packed = morfa_journal::packed::pack(Body::Patch(text.clone()));
        assert!(matches!(&packed, Body::Op(bytes) if bytes.starts_with(b"MRFZ")));
        let Op::Patch(decoded) = decode(&packed).expect("decodes") else {
            panic!("a patch");
        };
        assert_eq!(to_json(&decoded), text);
        assert!(decode(&Body::Op(b"MRFZbroken".to_vec())).is_err());
    }
}
