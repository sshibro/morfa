//! The S3 client against a real S3 protocol server (MinIO or s3rver), named by
//! MORFA_B2_S3_ENDPOINT, _BUCKET, _KEY, _SECRET, _REGION; skipped without it. Then the in-memory fake.

use morfa_blobs::{Blobs, Bytes, Kind, Links, MemoryStore, ObjectStore, S3, S3Config, StoreError};
use std::time::Duration;

fn s3() -> Option<S3> {
    let var = |name: &str| std::env::var(format!("MORFA_B2_S3_{name}")).ok();
    let Some(endpoint) = var("ENDPOINT") else {
        eprintln!("skipped: MORFA_B2_S3_ENDPOINT is not set");
        return None;
    };
    let mut config = S3Config::new(
        &endpoint,
        &var("REGION").unwrap_or_else(|| "us-east-1".into()),
        &var("BUCKET").unwrap_or_else(|| "morfa-test".into()),
        &var("KEY").unwrap_or_default(),
        &var("SECRET").unwrap_or_default(),
    );
    config.part_size = 5 << 20;
    Some(S3::new(config).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s3_put_get_head_delete_multipart_and_presign() {
    let Some(store) = s3() else { return };
    let key = format!("ckpt/test-{}/1.bin.zst", std::process::id());
    store
        .put(
            &key,
            Bytes::from_static(b"hello"),
            "application/octet-stream",
        )
        .await
        .unwrap();
    assert_eq!(
        store.get(&key).await.unwrap().as_deref(),
        Some(&b"hello"[..])
    );
    assert_eq!(store.head(&key).await.unwrap(), Some(5));
    // A presigned GET works without credentials.
    let url = store.presign_get(&key, Duration::from_secs(60)).unwrap();
    let body = reqwest_get(&url).await;
    assert_eq!(body, b"hello");
    // Three parts (5 MiB, 5 MiB, 1 byte), uploaded concurrently, read back whole.
    let big: Vec<u8> = (0..(10 << 20) + 1).map(|k| (k * 7 % 251) as u8).collect();
    let big_key = format!("{key}.big");
    store
        .put(
            &big_key,
            Bytes::from(big.clone()),
            "application/octet-stream",
        )
        .await
        .unwrap();
    assert_eq!(store.get(&big_key).await.unwrap().unwrap(), big);
    store.delete(&key).await.unwrap();
    store.delete(&big_key).await.unwrap();
    assert_eq!(store.get(&key).await.unwrap(), None);
    assert_eq!(store.head(&key).await.unwrap(), None);
    // Unknown credentials are refused, not retried (s3rver checks the key id only; MinIO and the providers check the
    // signature too, which the AWS examples in sigv4.rs pin).
    let mut bad = S3Config::new(
        &std::env::var("MORFA_B2_S3_ENDPOINT").unwrap(),
        "us-east-1",
        "morfa-test",
        "NOBODY",
        "wrong",
    );
    bad.attempts = 1;
    let refused = S3::new(bad)
        .unwrap()
        .put("img/x", Bytes::from_static(b"x"), "image/png")
        .await
        .unwrap_err();
    assert!(
        matches!(refused, StoreError::Refused { status: 403, .. }),
        "{refused:?}"
    );
}

async fn reqwest_get(url: &str) -> Vec<u8> {
    // The crate's own client is private; a bare GET is enough here.
    let response = std::process::Command::new("curl")
        .args(["-sf", url])
        .output()
        .unwrap();
    assert!(response.status.success(), "presigned GET failed");
    response.stdout
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s3_unreachable_is_unavailable_after_retries() {
    let mut config = S3Config::new("http://127.0.0.1:1", "us-east-1", "b", "k", "s");
    config.attempts = 2;
    let started = std::time::Instant::now();
    assert!(matches!(
        S3::new(config).unwrap().get("img/x").await,
        Err(StoreError::Unavailable(_))
    ));
    assert!(started.elapsed() >= Duration::from_millis(100));
}

#[tokio::test]
async fn pictures_are_stored_once_by_hash_and_checked_when_read() {
    let blobs = Blobs::new(MemoryStore::new(), Links::Presigned);
    let first = blobs
        .put(Kind::Image, Bytes::from_static(b"png bytes"), "image/png")
        .await
        .unwrap();
    assert_eq!(first.key, format!("img/{}", first.hash));
    assert!(!first.deduped);
    let again = blobs
        .put(Kind::Image, Bytes::from_static(b"png bytes"), "image/png")
        .await
        .unwrap();
    assert!(again.deduped);
    assert_eq!(blobs.store().puts(), 1, "the same bytes are uploaded once");
    let thumb = blobs
        .put(Kind::Thumbnail, Bytes::from_static(b"webp"), "image/webp")
        .await
        .unwrap();
    assert!(thumb.key.starts_with("thumb/") && thumb.key.ends_with(".webp"));
    assert_eq!(
        blobs.get(&first.key).await.unwrap().as_deref(),
        Some(&b"png bytes"[..])
    );
    blobs.store().damage(&first.key, 0);
    assert!(matches!(
        blobs.get(&first.key).await,
        Err(StoreError::Damaged(_))
    ));
    assert!(matches!(
        blobs.get("ckpt/x").await,
        Err(StoreError::Refused { .. })
    ));
    blobs.store().set_down(true);
    assert!(matches!(
        blobs
            .put(Kind::Image, Bytes::from_static(b"x"), "image/png")
            .await,
        Err(StoreError::Unavailable(_))
    ));
    assert_eq!(
        blobs.url("img/x", Duration::from_secs(900)),
        None,
        "the fake has no links"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s3_blobs_dedup_and_link() {
    let Some(store) = s3() else { return };
    let blobs = Blobs::new(store, Links::Presigned);
    let bytes = Bytes::from(format!("picture {}", std::process::id()));
    let stored = blobs
        .put(Kind::Image, bytes.clone(), "image/png")
        .await
        .unwrap();
    assert!(
        blobs
            .put(Kind::Image, bytes.clone(), "image/png")
            .await
            .unwrap()
            .deduped
    );
    let url = blobs.url(&stored.key, Duration::from_secs(900)).unwrap();
    assert_eq!(reqwest_get(&url).await, bytes.to_vec());
    assert_eq!(blobs.get(&stored.key).await.unwrap().unwrap(), bytes);
    blobs.store().delete(&stored.key).await.unwrap();
}
