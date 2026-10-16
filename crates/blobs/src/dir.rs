//! [`DirStore`]: objects as files under a directory (`DESIGN_BLOBS=local`, development, and the tests that share a
//! store between processes). Writes go to a temporary file renamed into place, so a reader never sees half an
//! object and a killed writer leaves none.

use crate::{Bytes, ObjectStore, StoreError};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct DirStore {
    root: PathBuf,
}

fn io(error: std::io::Error) -> StoreError {
    StoreError::Unavailable(error.to_string())
}

impl DirStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        DirStore { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self, key: &str) -> Result<PathBuf, StoreError> {
        let safe = !key.is_empty()
            && key
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/._-~".contains(&b));
        if !safe {
            return Err(StoreError::Refused {
                status: 400,
                message: format!("unsafe key {key:?}"),
            });
        }
        Ok(self.root.join(key))
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
) -> Result<T, StoreError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| StoreError::Unavailable(error.to_string()))?
}

impl ObjectStore for DirStore {
    async fn put(&self, key: &str, body: Bytes, _content_type: &str) -> Result<(), StoreError> {
        let path = self.path(key)?;
        blocking(move || {
            static COUNT: AtomicU64 = AtomicU64::new(0);
            let dir = path.parent().expect("a key has a parent");
            std::fs::create_dir_all(dir).map_err(io)?;
            let temporary = dir.join(format!(
                ".tmp-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::write(&temporary, &body).map_err(io)?;
            std::fs::rename(&temporary, &path).map_err(io)
        })
        .await
    }

    async fn get(&self, key: &str) -> Result<Option<Bytes>, StoreError> {
        let path = self.path(key)?;
        blocking(move || match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(Bytes::from(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(error)),
        })
        .await
    }

    async fn head(&self, key: &str) -> Result<Option<u64>, StoreError> {
        let path = self.path(key)?;
        blocking(move || match std::fs::metadata(&path) {
            Ok(meta) => Ok(Some(meta.len())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(error)),
        })
        .await
    }

    async fn delete(&self, key: &str) -> Result<(), StoreError> {
        let path = self.path(key)?;
        blocking(move || match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(io(error)),
            _ => Ok(()),
        })
        .await
    }

    fn presign_get(&self, _key: &str, _ttl: Duration) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn files_under_a_directory() {
        let root = std::env::temp_dir().join(format!("morfa-dirstore-{}", std::process::id()));
        let store = DirStore::new(&root);
        store
            .put("img/abc", Bytes::from_static(b"x"), "image/png")
            .await
            .unwrap();
        assert_eq!(
            store.get("img/abc").await.unwrap().as_deref(),
            Some(&b"x"[..])
        );
        assert_eq!(store.head("img/abc").await.unwrap(), Some(1));
        store.delete("img/abc").await.unwrap();
        store.delete("img/abc").await.unwrap();
        assert_eq!(store.get("img/abc").await.unwrap(), None);
        for key in ["../x", "a//b", "/abs", "a/./b", "a b"] {
            assert!(
                matches!(
                    store.put(key, Bytes::new(), "x").await,
                    Err(StoreError::Refused { .. })
                ),
                "{key}"
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
