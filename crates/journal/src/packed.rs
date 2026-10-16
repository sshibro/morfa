//! Packed rows: a JSON patch of [`PACK_MIN`] bytes or more is stored in `op` as `MRFZ` and a zstd frame of its text
//! (level 1), not in `patch` as text.
//!
//! Why (D1): a 20-layer op is ~13.5 KB of JSON. PostgreSQL TOAST-compresses any row over ~2 KB
//! with pglz on the committing backend, and pglz was 22 % of PostgreSQL's CPU at 2 000 editors. The same text is
//! ~560 bytes as a zstd frame (~10 µs here with the thread's context), so the row stays inline: no pglz, no TOAST
//! table, a smaller WAL record. The text inside is exactly what `patch` would hold, so every reader turns a packed
//! row back into the patch text it knows (crates/checkpoint `ops::decode`, server/design/collab/checkpoint.ts).

use crate::traits::Body;
use std::cell::RefCell;

/// The first bytes of a packed row.
pub const PACKED_MAGIC: [u8; 4] = *b"MRFZ";
/// Smaller patches stay text: they fit inline uncompressed (PostgreSQL compresses only rows over ~2 KB).
pub const PACK_MIN: usize = 1024;
/// The largest patch text a packed row may unpack to (a damaged or hostile frame is refused, not allocated).
pub const UNPACKED_MAX: usize = 1 << 30;
const LEVEL: i32 = 1;

thread_local! {
    static COMPRESSOR: RefCell<Option<zstd::bulk::Compressor<'static>>> = const { RefCell::new(None) };
}

/// The body as the row stores it: a large JSON patch packed, anything else as it is.
pub fn pack(body: Body) -> Body {
    let Body::Patch(text) = body else {
        return body;
    };
    if text.len() < PACK_MIN {
        return Body::Patch(text);
    }
    let packed = COMPRESSOR.with(|cell| {
        let mut cell = cell.borrow_mut();
        let compressor = match cell.as_mut() {
            Some(compressor) => compressor,
            None => cell.insert(zstd::bulk::Compressor::new(LEVEL).ok()?),
        };
        let mut out =
            Vec::with_capacity(PACKED_MAGIC.len() + zstd::zstd_safe::compress_bound(text.len()));
        out.extend_from_slice(&PACKED_MAGIC);
        let frame = compressor.compress(text.as_bytes()).ok()?;
        out.extend_from_slice(&frame);
        Some(out)
    });
    match packed {
        Some(bytes) => Body::Op(bytes),
        // zstd failed to start (out of memory): the text is stored as it is, which every reader takes too.
        None => Body::Patch(text),
    }
}

/// Whether `op` is a packed row.
pub fn is_packed(op: &[u8]) -> bool {
    op.starts_with(&PACKED_MAGIC)
}

/// The patch text of a packed row.
pub fn unpack(op: &[u8]) -> Result<String, String> {
    let frame = op
        .strip_prefix(&PACKED_MAGIC)
        .ok_or_else(|| "not a packed row".to_owned())?;
    let size = match zstd::zstd_safe::get_frame_content_size(frame) {
        Ok(Some(size)) if size <= UNPACKED_MAX as u64 => size as usize,
        Ok(Some(size)) => return Err(format!("a packed row of {size} bytes")),
        _ => return Err("a packed row without its size".to_owned()),
    };
    let bytes = zstd::bulk::decompress(frame, size).map_err(|error| error.to_string())?;
    if bytes.len() != size {
        return Err("a packed row shorter than its frame says".to_owned());
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_patches_pack_and_unpack_to_the_same_text() {
        let text = format!(
            "{{\"nodes\":{{{}}}}}",
            (0..40)
                .map(|i| format!("\"r{i}\":{{\"id\":\"r{i}\",\"x\":{i},\"name\":\"t\"}}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(text.len() >= PACK_MIN);
        let Body::Op(bytes) = pack(Body::Patch(text.clone())) else {
            panic!("packed");
        };
        assert!(is_packed(&bytes));
        assert!(bytes.len() < text.len() / 3, "{} bytes", bytes.len());
        assert_eq!(unpack(&bytes).unwrap(), text);
        // The same text packs to the same bytes (a retried commit is recognised by its size).
        assert_eq!(pack(Body::Patch(text)), Body::Op(bytes));
    }

    #[test]
    fn small_patches_and_other_bodies_stay_as_they_are() {
        let small = Body::Patch("{\"nodes\":{}}".into());
        assert_eq!(pack(small.clone()), small);
        let op = Body::Op(b"MRFCxxxx".to_vec());
        assert_eq!(pack(op.clone()), op);
    }

    #[test]
    fn damaged_rows_are_refused() {
        assert!(unpack(b"MRFZ").is_err());
        assert!(unpack(b"MRFZnot zstd").is_err());
        assert!(unpack(b"{}").is_err());
        let Body::Op(mut bytes) = pack(Body::Patch("x".repeat(4096))) else {
            panic!("packed");
        };
        let last = bytes.len() - 1;
        bytes.truncate(last);
        assert!(unpack(&bytes).is_err());
    }
}
