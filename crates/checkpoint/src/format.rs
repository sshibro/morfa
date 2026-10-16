//! The checkpoint object: a 64-byte header, then the document compressed with zstd (level 3).
//!
//! ```text
//! 0   4  magic  "MRFC"
//! 4   1  header version (2; 1 is read forever)
//! 5   1  format: 1 = the model's binary codec (crates/model codec, "MRFA" frame), 2 = JSON (types.ts, as
//!        JSON.stringify writes it)
//! 6   2  the codec's own format version (u16 LE; 0 for JSON)
//! 8   8  document version (u64 LE)
//! 16  4  layers (u32 LE)
//! 20  4  reserved (0)
//! 24  8  uncompressed payload bytes (u64 LE)
//! 32 32  sha256 of the compressed body (the bytes after the header) in version 2; of the uncompressed payload
//!        in version 1
//! ```
//!
//! The reader takes both formats and both header versions forever (TARGETS §3b: the format can be revisited
//! without a migration), checks the hash and the payload's length before it decodes, and refuses anything else.
//! Version 2 hashes what is stored: the same check against damage in storage or transit, over 1/20 of the bytes
//! (sha256 of a 16 MB payload is 116 ms on a core without SHA extensions, of its 0.7 MB object 5 ms), and a
//! damaged object is refused before it is decompressed.

use morfa_model::codec;
use morfa_model::store::Document;
use sha2::{Digest, Sha256};
use std::fmt;

pub const MAGIC: [u8; 4] = *b"MRFC";
pub const HEADER_VERSION: u8 = 2;
pub const HEADER_BYTES: usize = 64;
/// zstd level (docs/BACKEND.md §3).
pub const LEVEL: i32 = 3;

/// How the document is written inside the checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    /// The model's binary codec.
    Bin,
    /// JSON, as the TypeScript writes it.
    Json,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Bin => "bin",
            Format::Json => "json",
        }
    }

    pub fn parse(name: &str) -> Option<Format> {
        match name {
            "bin" => Some(Format::Bin),
            "json" => Some(Format::Json),
            _ => None,
        }
    }

    fn code(self) -> u8 {
        match self {
            Format::Bin => 1,
            Format::Json => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    /// 2: `sha256` is of the compressed body; 1: of the payload.
    pub header_version: u8,
    pub format: Format,
    pub codec_format: u16,
    pub version: u64,
    pub node_count: u32,
    pub payload_bytes: u64,
    pub sha256: [u8; 32],
}

/// Why bytes are not a checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatError {
    NotACheckpoint,
    HeaderVersion(u8),
    UnknownFormat(u8),
    /// The payload does not match its header (length or hash): damaged in storage or in transit.
    Damaged(String),
    /// The payload does not decode into a document.
    Payload(String),
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FormatError::NotACheckpoint => f.write_str("not a checkpoint"),
            FormatError::HeaderVersion(v) => write!(f, "checkpoint header version {v}"),
            FormatError::UnknownFormat(v) => write!(f, "checkpoint format {v}"),
            FormatError::Damaged(why) => write!(f, "damaged checkpoint: {why}"),
            FormatError::Payload(why) => write!(f, "checkpoint payload: {why}"),
        }
    }
}

impl std::error::Error for FormatError {}

impl Header {
    pub fn to_bytes(&self) -> [u8; HEADER_BYTES] {
        let mut out = [0u8; HEADER_BYTES];
        out[0..4].copy_from_slice(&MAGIC);
        out[4] = self.header_version;
        out[5] = self.format.code();
        out[6..8].copy_from_slice(&self.codec_format.to_le_bytes());
        out[8..16].copy_from_slice(&self.version.to_le_bytes());
        out[16..20].copy_from_slice(&self.node_count.to_le_bytes());
        out[24..32].copy_from_slice(&self.payload_bytes.to_le_bytes());
        out[32..64].copy_from_slice(&self.sha256);
        out
    }

    pub fn parse(bytes: &[u8]) -> Result<Header, FormatError> {
        if bytes.len() < HEADER_BYTES || bytes[0..4] != MAGIC {
            return Err(FormatError::NotACheckpoint);
        }
        if !matches!(bytes[4], 1 | HEADER_VERSION) {
            return Err(FormatError::HeaderVersion(bytes[4]));
        }
        let format = match bytes[5] {
            1 => Format::Bin,
            2 => Format::Json,
            other => return Err(FormatError::UnknownFormat(other)),
        };
        let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8 bytes"));
        Ok(Header {
            header_version: bytes[4],
            format,
            codec_format: u16::from_le_bytes([bytes[6], bytes[7]]),
            version: u64_at(8),
            node_count: u32::from_le_bytes(bytes[16..20].try_into().expect("4 bytes")),
            payload_bytes: u64_at(24),
            sha256: bytes[32..64].try_into().expect("32 bytes"),
        })
    }
}

/// The document's payload in `format` (uncompressed).
pub fn payload(doc: &Document, format: Format) -> Vec<u8> {
    match format {
        Format::Bin => codec::encode(doc),
        Format::Json => morfa_model::to_json(&doc.to_model()).into_bytes(),
    }
}

/// A whole checkpoint object of `doc` at `version`.
pub fn encode(doc: &Document, version: u64, format: Format) -> Vec<u8> {
    let payload = payload(doc, format);
    let mut out = Vec::with_capacity(HEADER_BYTES + payload.len() / 4);
    out.resize(HEADER_BYTES, 0);
    compress_into(&payload, &mut out);
    let header = Header {
        header_version: HEADER_VERSION,
        format,
        codec_format: match format {
            Format::Bin => codec::FORMAT,
            Format::Json => 0,
        },
        version,
        node_count: doc.len() as u32,
        payload_bytes: payload.len() as u64,
        sha256: Sha256::digest(&out[HEADER_BYTES..]).into(),
    };
    out[..HEADER_BYTES].copy_from_slice(&header.to_bytes());
    out
}

fn compress_into(payload: &[u8], out: &mut Vec<u8>) {
    let mut encoder = zstd::stream::Encoder::new(out, LEVEL).expect("zstd encoder");
    // Large payloads compress on several threads (TARGETS S3: CPU of a 100 MB checkpoint ≤ 1.5 s).
    if payload.len() > 4 << 20 {
        let workers = std::thread::available_parallelism().map_or(1, |n| n.get().min(4)) as u32;
        let _ = encoder.multithread(workers);
    }
    std::io::Write::write_all(&mut encoder, payload).expect("writing to a Vec never fails");
    encoder.finish().expect("zstd finish");
}

/// Reads a checkpoint object: header, decompressed payload checked against the header.
pub fn open(bytes: &[u8]) -> Result<(Header, Vec<u8>), FormatError> {
    let header = Header::parse(bytes)?;
    let damaged = || FormatError::Damaged("hash differs from the header".into());
    if header.header_version >= 2 && Sha256::digest(&bytes[HEADER_BYTES..])[..] != header.sha256 {
        return Err(damaged());
    }
    let capacity = usize::try_from(header.payload_bytes)
        .unwrap_or(usize::MAX)
        .min(1 << 31);
    let mut payload = Vec::with_capacity(capacity);
    let mut decoder = zstd::stream::Decoder::new(&bytes[HEADER_BYTES..])
        .map_err(|error| FormatError::Damaged(error.to_string()))?;
    std::io::copy(&mut decoder, &mut payload)
        .map_err(|error| FormatError::Damaged(error.to_string()))?;
    if payload.len() as u64 != header.payload_bytes {
        return Err(FormatError::Damaged(format!(
            "{} payload bytes, the header says {}",
            payload.len(),
            header.payload_bytes
        )));
    }
    if header.header_version == 1 && Sha256::digest(&payload)[..] != header.sha256 {
        return Err(damaged());
    }
    Ok((header, payload))
}

/// The document a checked payload holds.
pub fn decode_payload(header: &Header, payload: &[u8]) -> Result<Document, FormatError> {
    let doc = match header.format {
        Format::Bin => {
            codec::decode(payload).map_err(|error| FormatError::Payload(error.to_string()))?
        }
        Format::Json => {
            let text = std::str::from_utf8(payload)
                .map_err(|error| FormatError::Payload(error.to_string()))?;
            let model = morfa_model::from_json(text)
                .map_err(|error| FormatError::Payload(error.to_string()))?;
            Document::from_model(&model)
        }
    };
    if doc.len() as u64 != u64::from(header.node_count) {
        return Err(FormatError::Damaged(format!(
            "{} layers, the header says {}",
            doc.len(),
            header.node_count
        )));
    }
    Ok(doc)
}

/// A checkpoint object's header and document.
pub fn decode(bytes: &[u8]) -> Result<(Header, Document), FormatError> {
    let (header, payload) = open(bytes)?;
    let doc = decode_payload(&header, &payload)?;
    Ok((header, doc))
}

/// The object key of a file's checkpoint (`ckpt/<file>/<version>.<format>.zst`, migration 012's CHECK).
pub fn key(file: &str, version: u64, format: Format) -> String {
    format!("ckpt/{file}/{version}.{}.zst", format.name())
}
