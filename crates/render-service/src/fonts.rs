//! The catalogue faces a job names (export-fonts.ts `familyFaces`: file, weight range, style, unicode range), read
//! from the service's fonts directory (the api's `public/fonts`) and registered with each worker's own
//! [`morfa_export::fonts::Fonts`] once. The catalogue itself stays in TypeScript (shared/fonts.ts): the api sends
//! the faces, the service only reads files below its directory.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use morfa_export::fonts::Fonts;

use crate::request::FaceIn;

/// A path below the fonts directory: `family/file.woff2` characters only, no `..`, not absolute.
pub fn safe_file(file: &str) -> bool {
    !file.is_empty()
        && file.len() <= 200
        && !file.starts_with('/')
        && file
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
}

/// Font files by path, read once for every worker.
pub struct FontFiles {
    dir: Option<PathBuf>,
    cache: RwLock<HashMap<String, Option<Arc<Vec<u8>>>>>,
}

impl FontFiles {
    pub fn new(dir: Option<PathBuf>) -> FontFiles {
        FontFiles {
            dir,
            cache: RwLock::default(),
        }
    }

    pub fn read(&self, file: &str) -> Option<Arc<Vec<u8>>> {
        if !safe_file(file) {
            return None;
        }
        if let Some(hit) = self
            .cache
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(file)
        {
            return hit.clone();
        }
        let bytes = self
            .dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join(file)).ok())
            .map(Arc::new);
        self.cache
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(file.to_owned(), bytes.clone());
        bytes
    }
}

/// One worker's fonts: the faces registered so far, by file.
#[derive(Default)]
pub struct WorkerFonts {
    pub fonts: Fonts,
    registered: HashSet<String>,
}

impl WorkerFonts {
    /// Registers the faces not registered yet; returns the files that could not be read.
    pub fn ensure(&mut self, faces: &[FaceIn], files: &FontFiles) -> Vec<String> {
        let mut unreadable = Vec::new();
        for face in faces {
            let key = format!(
                "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
                face.file,
                face.family,
                face.weight.0,
                face.weight.1,
                face.italic,
                face.unicode_range
            );
            if self.registered.contains(&key) {
                continue;
            }
            match files.read(&face.file) {
                Some(bytes) => {
                    let added = self.fonts.add_face(
                        &face.family,
                        face.weight.0,
                        face.weight.1,
                        face.italic,
                        &face.unicode_range,
                        &bytes,
                    );
                    if added.is_none() {
                        unreadable.push(face.file.clone());
                    }
                }
                None => unreadable.push(face.file.clone()),
            }
            self.registered.insert(key);
        }
        unreadable
    }
}

#[cfg(test)]
mod tests {
    use super::safe_file;

    #[test]
    fn paths() {
        assert!(safe_file("inter/inter-latin-wght-normal.woff2"));
        assert!(!safe_file("../secret"));
        assert!(!safe_file("/etc/passwd"));
        assert!(!safe_file("a//b"));
        assert!(!safe_file("a/./b"));
        assert!(!safe_file("a b"));
        assert!(!safe_file(""));
    }
}
