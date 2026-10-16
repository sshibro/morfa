//! [`MemoryStore`]: the in-memory object store of the tests (no MinIO in the cloud container).

use crate::{Bytes, ObjectStore, StoreError};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

#[derive(Default)]
pub struct MemoryStore {
    objects: Mutex<HashMap<String, Bytes>>,
    down: AtomicBool,
    puts: AtomicU64,
    gets: AtomicU64,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the store down (every call fails `Unavailable`) or brings it back.
    pub fn set_down(&self, down: bool) {
        self.down.store(down, Ordering::SeqCst);
    }

    /// Flips one byte of a stored object (what a damaged disk or a buggy proxy would do).
    pub fn damage(&self, key: &str, at: usize) {
        let mut objects = self.objects.lock().unwrap();
        if let Some(body) = objects.get_mut(key) {
            let mut bytes = body.to_vec();
            let at = at.min(bytes.len().saturating_sub(1));
            bytes[at] ^= 0x5a;
            *body = Bytes::from(bytes);
        }
    }

    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.objects.lock().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    pub fn puts(&self) -> u64 {
        self.puts.load(Ordering::Relaxed)
    }

    pub fn gets(&self) -> u64 {
        self.gets.load(Ordering::Relaxed)
    }

    fn up(&self) -> Result<(), StoreError> {
        if self.down.load(Ordering::SeqCst) {
            Err(StoreError::Unavailable("memory store is down".into()))
        } else {
            Ok(())
        }
    }
}

impl ObjectStore for MemoryStore {
    async fn put(&self, key: &str, body: Bytes, _content_type: &str) -> Result<(), StoreError> {
        self.up()?;
        self.puts.fetch_add(1, Ordering::Relaxed);
        self.objects.lock().unwrap().insert(key.to_owned(), body);
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Bytes>, StoreError> {
        self.up()?;
        self.gets.fetch_add(1, Ordering::Relaxed);
        Ok(self.objects.lock().unwrap().get(key).cloned())
    }

    async fn head(&self, key: &str) -> Result<Option<u64>, StoreError> {
        self.up()?;
        Ok(self
            .objects
            .lock()
            .unwrap()
            .get(key)
            .map(|body| body.len() as u64))
    }

    async fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.up()?;
        self.objects.lock().unwrap().remove(key);
        Ok(())
    }

    fn presign_get(&self, _key: &str, _ttl: Duration) -> Option<String> {
        None
    }
}
