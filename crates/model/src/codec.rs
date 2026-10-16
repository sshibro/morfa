//! The binary codec of the store: what the multiplayer server writes for a document snapshot and its op journal,
//! and what the browser can load instead of JSON.
//!
//! A frame is `MAGIC`, the format version (u16, little-endian), then the document in postcard (varint integers,
//! 8-byte floats, strings as length + UTF-8). The document's own shape (`store::Document`'s `Serialize`) puts the two
//! interners first, so every symbol is checked against them while it is read: a damaged or hostile frame is refused,
//! never resolved out of range.
//!
//! Why postcard: it was compared with bincode 2 and rkyv 0.8 (size, speed, wasm size, hostile input,
//! schema evolution); both alternatives and their bench and tests are in commit 122e59c, from which the comparison
//! can be reproduced.

use crate::store::Document;
use std::fmt;

/// The first bytes of every frame.
pub const MAGIC: [u8; 4] = *b"MRFA";
/// Bumped by any change to the stored shape (store/value.rs: append variants and fields, never reorder).
pub const FORMAT: u16 = 1;

const HEADER: usize = MAGIC.len() + 2;

/// Why bytes are not a stored document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    /// Not a frame of this codec.
    NotAFrame,
    /// A frame of another format version.
    Format(u16),
    /// The payload does not decode.
    Payload(String),
}

impl fmt::Display for CodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        match self {
            CodecError::NotAFrame => formatter.write_str("not a stored document"),
            CodecError::Format(format) => write!(
                formatter,
                "stored document format {format}, this build reads {FORMAT}"
            ),
            CodecError::Payload(error) => write!(formatter, "damaged stored document: {error}"),
        }
    }
}

impl std::error::Error for CodecError {}

/// A document as one frame.
pub fn encode(doc: &Document) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + doc.len() * 96);
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&FORMAT.to_le_bytes());
    postcard::to_io(doc, &mut out).expect("writing to a Vec never fails");
    out
}

/// The document of a frame.
pub fn decode(bytes: &[u8]) -> Result<Document, CodecError> {
    if bytes.len() < HEADER || bytes[..MAGIC.len()] != MAGIC {
        return Err(CodecError::NotAFrame);
    }
    let format = u16::from_le_bytes([bytes[4], bytes[5]]);
    if format != FORMAT {
        return Err(CodecError::Format(format));
    }
    let (doc, rest) = postcard::take_from_bytes::<Document>(&bytes[HEADER..])
        .map_err(|error| CodecError::Payload(error.to_string()))?;
    if !rest.is_empty() {
        return Err(CodecError::Payload(format!(
            "{} bytes after the document",
            rest.len()
        )));
    }
    Ok(doc)
}
