//! The checkpoint object without storage: both formats, damage, the row bodies.

mod common;

use morfa_checkpoint::format::{self, Format, FormatError, HEADER_BYTES};
use morfa_checkpoint::ops;
use morfa_journal::Body;
use sha2::{Digest, Sha256};

#[test]
fn both_formats_round_trip_and_carry_their_header() {
    let doc = common::store(&common::document(50));
    for format in [Format::Bin, Format::Json] {
        let object = format::encode(&doc, 42, format);
        let (header, back) = format::decode(&object).unwrap();
        assert_eq!(
            (header.format, header.version, header.node_count),
            (format, 42, 51)
        );
        assert_eq!(back, doc, "{format:?}");
        assert_eq!(back.to_model(), doc.to_model());
    }
    assert_eq!(format::key("f", 7, Format::Bin), "ckpt/f/7.bin.zst");
    assert_eq!(Format::parse("json"), Some(Format::Json));
}

#[test]
fn damage_is_refused_before_decoding() {
    let doc = common::store(&common::document(20));
    let object = format::encode(&doc, 3, Format::Bin);
    assert_eq!(
        format::decode(b"nope").unwrap_err(),
        FormatError::NotACheckpoint
    );
    let mut header = object.clone();
    header[5] = 9;
    assert_eq!(
        format::decode(&header).unwrap_err(),
        FormatError::UnknownFormat(9)
    );
    // A flipped byte of the stored hash, of the compressed body, a truncated object.
    let mut hash = object.clone();
    hash[40] ^= 1;
    assert!(matches!(
        format::decode(&hash),
        Err(FormatError::Damaged(_))
    ));
    let mut body = object.clone();
    let at = HEADER_BYTES + (object.len() - HEADER_BYTES) / 2;
    body[at] ^= 0xff;
    assert!(matches!(
        format::decode(&body),
        Err(FormatError::Damaged(_))
    ));
    assert!(matches!(
        format::decode(&object[..object.len() - 3]),
        Err(FormatError::Damaged(_))
    ));
}

/// A version-1 object (sha256 of the uncompressed payload), as the first writer made them: read forever.
#[test]
fn header_version_1_objects_still_read() {
    let doc = common::store(&common::document(20));
    let object = format::encode(&doc, 5, Format::Bin);
    let (header, payload) = format::open(&object).unwrap();
    assert_eq!(header.header_version, format::HEADER_VERSION);
    let mut old = object.clone();
    old[4] = 1;
    old[32..64].copy_from_slice(&Sha256::digest(&payload));
    let (old_header, back) = format::decode(&old).unwrap();
    assert_eq!((old_header.header_version, old_header.version), (1, 5));
    assert_eq!(back, doc);
    let mut damaged = old.clone();
    damaged[40] ^= 1;
    assert!(matches!(
        format::decode(&damaged),
        Err(FormatError::Damaged(_))
    ));
    let mut future = object.clone();
    future[4] = 3;
    assert_eq!(
        format::decode(&future).unwrap_err(),
        FormatError::HeaderVersion(3)
    );
}

#[test]
fn row_bodies_of_every_kind_apply() {
    let mut doc = common::store(&common::document(5));
    let mut expected = morfa_model::from_json(&common::document(5)).unwrap();
    let patch = morfa_model::patch_from_json(&common::move_patch(2, 77.0)).unwrap();
    patch.apply(&mut expected);
    // Node's JSON row, and the same patch as an op.
    ops::apply(
        &mut doc,
        ops::decode(&Body::Patch(common::move_patch(2, 77.0))).unwrap(),
    )
    .unwrap();
    assert_eq!(doc.to_model(), expected);
    ops::apply(
        &mut doc,
        ops::decode(&Body::Op(common::move_patch(2, 77.0).into_bytes())).unwrap(),
    )
    .unwrap();
    assert_eq!(doc.to_model(), expected);
    assert_eq!(
        ops::patch_body(&patch),
        Body::Patch(morfa_model::to_json(&patch))
    );
    // A whole-document replacement.
    let replacement = common::store(&common::document(3));
    ops::apply(
        &mut doc,
        ops::decode(&ops::replace_body(&replacement, 9, Format::Bin)).unwrap(),
    )
    .unwrap();
    assert_eq!(doc, replacement);
    // A store journal entry continuing the document.
    let mut source = replacement.clone();
    let entry = source.commit(&morfa_model::patch_from_json(&common::move_patch(1, 5.0)).unwrap());
    ops::apply(&mut doc, ops::decode(&Body::Op(entry.to_bytes())).unwrap()).unwrap();
    assert_eq!(doc, source);
    assert!(ops::decode(&Body::Op(vec![0, 1, 2])).is_err());
    assert!(ops::decode(&Body::Patch("{\"nodes\":5}".into())).is_err());
}
