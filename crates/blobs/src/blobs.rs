//! [`Blobs`]: content-addressed pictures (docs/BACKEND.md §3 "Pictures").
//!
//! A picture's key is the sha256 of its bytes: `img/<sha256>`, its thumbnail `thumb/<sha256>.webp`. The same bytes
//! uploaded twice (two files, two accounts) are stored once: `put` asks the store first and skips the upload when an
//! object of that size is there. Reads are checked against the key's hash. Links are signed: a presigned S3 GET, or
//! a CDN secure link (nginx `secure_link_md5` form, what the Russian CDNs offer) with a 15-minute life, so a private
//! upload never needs the owner's cookie on a CDN edge.

use crate::sigv4::sha256_hex;
use crate::{Bytes, ObjectStore, StoreError};
use md5::{Digest, Md5};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// What is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Thumbnail,
}

/// A stored picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub hash: String,
    pub key: String,
    pub bytes: usize,
    /// The object was already there: nothing was uploaded.
    pub deduped: bool,
}

pub fn hex_sha256(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

pub fn image_key(hash: &str) -> String {
    format!("img/{hash}")
}

pub fn thumbnail_key(hash: &str) -> String {
    format!("thumb/{hash}.webp")
}

/// The hash a content-addressed key names.
fn hash_of(key: &str) -> Option<&str> {
    let hash = key.strip_prefix("img/").or_else(|| {
        key.strip_prefix("thumb/")
            .and_then(|rest| rest.strip_suffix(".webp"))
    })?;
    (hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
    .then_some(hash)
}

/// How picture links are made.
#[derive(Debug, Clone)]
pub enum Links {
    /// Straight from the store (a presigned GET).
    Presigned,
    /// Through a CDN: `{base}/{key}?md5=…&expires=…`, the token being base64url(md5("{expires}/{key} {secret}"))
    /// without padding, as nginx `secure_link_md5 "$secure_link_expires$uri $secret"` checks it.
    SecureLink { base: String, secret: String },
}

pub struct Blobs<S> {
    store: S,
    links: Links,
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (k, b)| n | u32::from(*b) << (16 - 8 * k));
        for k in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * k) & 63) as usize] as char);
        }
    }
    out
}

impl<S: ObjectStore> Blobs<S> {
    pub fn new(store: S, links: Links) -> Self {
        Blobs { store, links }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Stores a picture under its hash, once.
    pub async fn put(
        &self,
        kind: Kind,
        bytes: Bytes,
        content_type: &str,
    ) -> Result<Stored, StoreError> {
        let hash = hex_sha256(&bytes);
        let key = match kind {
            Kind::Image => image_key(&hash),
            Kind::Thumbnail => thumbnail_key(&hash),
        };
        let size = bytes.len();
        let deduped = self.store.head(&key).await? == Some(size as u64);
        if !deduped {
            self.store.put(&key, bytes, content_type).await?;
        }
        Ok(Stored {
            hash,
            key,
            bytes: size,
            deduped,
        })
    }

    /// A picture's bytes, checked against the hash its key names (`None`: not stored).
    pub async fn get(&self, key: &str) -> Result<Option<Bytes>, StoreError> {
        let Some(hash) = hash_of(key) else {
            return Err(StoreError::Refused {
                status: 400,
                message: format!("{key} is not a content-addressed key"),
            });
        };
        let Some(bytes) = self.store.get(key).await? else {
            return Ok(None);
        };
        let actual = hex_sha256(&bytes);
        if actual != hash {
            return Err(StoreError::Damaged(format!(
                "{key} holds bytes hashing to {actual}"
            )));
        }
        Ok(Some(bytes))
    }

    /// A link to a picture valid for `ttl` (docs/BACKEND.md: 15 minutes).
    pub fn url(&self, key: &str, ttl: Duration) -> Option<String> {
        self.url_at(key, ttl, SystemTime::now())
    }

    pub fn url_at(&self, key: &str, ttl: Duration, now: SystemTime) -> Option<String> {
        match &self.links {
            Links::Presigned => self.store.presign_get(key, ttl),
            Links::SecureLink { base, secret } => {
                let expires =
                    now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) + ttl.as_secs();
                let token = base64url(&Md5::digest(format!("{expires}/{key} {secret}").as_bytes()));
                Some(format!(
                    "{}/{key}?md5={token}&expires={expires}",
                    base.trim_end_matches('/')
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemoryStore;

    #[test]
    fn base64url_without_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(crate::sigv4::hex(&[0xab]), "ab");
    }

    #[test]
    fn keys_name_their_hash() {
        let hash = "a".repeat(64);
        assert_eq!(hash_of(&image_key(&hash)), Some(hash.as_str()));
        assert_eq!(hash_of(&thumbnail_key(&hash)), Some(hash.as_str()));
        assert_eq!(hash_of("img/AB"), None);
        assert_eq!(hash_of(&format!("ckpt/{hash}")), None);
    }

    #[test]
    fn secure_link_matches_nginx() {
        let blobs = Blobs::new(
            MemoryStore::new(),
            Links::SecureLink {
                base: "https://cdn.example/".into(),
                secret: "s3cret".into(),
            },
        );
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        // echo -n '1700000900/img/abc s3cret' | openssl md5 -binary | base64 | tr '+/' '-_' | tr -d '='
        assert_eq!(
            blobs
                .url_at("img/abc", Duration::from_secs(900), now)
                .unwrap(),
            format!(
                "https://cdn.example/img/abc?md5={}&expires=1700000900",
                SECURE_LINK_TOKEN
            )
        );
    }

    const SECURE_LINK_TOKEN: &str = include_str!("../tests/secure-link-token.txt");
}
