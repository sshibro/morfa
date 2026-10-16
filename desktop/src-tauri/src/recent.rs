//! "Open recent": the files this computer opened last, newest first, kept in the app's config folder
//! (`recent.json`). Only ids and names: the files themselves stay on the server.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::links::valid_file_id;

pub const LIMIT: usize = 10;
const NAME_LIMIT: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentFile {
    pub id: String,
    pub name: String,
    /// Unix milliseconds of the last opening.
    pub opened_at: u64,
}

#[derive(Debug, Default)]
pub struct Recent {
    path: Option<PathBuf>,
    files: Vec<RecentFile>,
}

/// A file's name from the window title the editor sets (`name — Design`, src/design/editor/DesignEditor.tsx).
pub fn name_from_title(title: &str) -> String {
    let name = title
        .rsplit_once(" — ")
        .map_or(title, |(name, _)| name)
        .trim();
    name.chars()
        .filter(|c| !c.is_control())
        .take(NAME_LIMIT)
        .collect()
}

impl Recent {
    /// Loads `path`; a missing or broken file starts an empty list (it is only a convenience).
    pub fn load(path: PathBuf) -> Self {
        let files = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<RecentFile>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|file| valid_file_id(&file.id))
            .take(LIMIT)
            .collect();
        Self {
            path: Some(path),
            files,
        }
    }

    pub fn files(&self) -> &[RecentFile] {
        &self.files
    }

    /// Puts a file first. Answers whether the list changed (the menu is rebuilt then).
    pub fn touch(&mut self, id: &str, name: &str, now: u64) -> bool {
        if !valid_file_id(id) {
            return false;
        }
        let name: String = name
            .chars()
            .filter(|c| !c.is_control())
            .take(NAME_LIMIT)
            .collect();
        let previous = self.files.iter().position(|file| file.id == id);
        let name = if name.trim().is_empty() {
            previous
                .map(|i| self.files[i].name.clone())
                .unwrap_or_default()
        } else {
            name
        };
        if previous == Some(0) && self.files[0].name == name {
            self.files[0].opened_at = now;
            self.save();
            return false;
        }
        if let Some(index) = previous {
            self.files.remove(index);
        }
        self.files.insert(
            0,
            RecentFile {
                id: id.to_owned(),
                name,
                opened_at: now,
            },
        );
        self.files.truncate(LIMIT);
        self.save();
        true
    }

    pub fn clear(&mut self) {
        self.files.clear();
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&self.files) {
            let _ = write_atomically(path, &bytes);
        }
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension("json.part");
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_newest_first_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cfg/recent.json");
        let mut recent = Recent::load(path.clone());
        assert!(recent.files().is_empty());
        assert!(recent.touch("a", "Alpha", 1));
        assert!(recent.touch("b", "Beta", 2));
        assert!(recent.touch("a", "", 3), "an empty name keeps the old one");
        assert_eq!(
            recent
                .files()
                .iter()
                .map(|f| (f.id.as_str(), f.name.as_str()))
                .collect::<Vec<_>>(),
            vec![("a", "Alpha"), ("b", "Beta")]
        );
        assert!(
            !recent.touch("a", "Alpha", 4),
            "the same first file changes nothing in the menu"
        );
        assert_eq!(recent.files()[0].opened_at, 4);
        assert!(!recent.touch("../x", "bad", 5));
        for i in 0..20 {
            recent.touch(&format!("f{i}"), "x", 10 + i);
        }
        assert_eq!(recent.files().len(), LIMIT);
        assert_eq!(recent.files()[0].id, "f19");
        let again = Recent::load(path.clone());
        assert_eq!(again.files(), recent.files(), "the list survives a restart");
        recent.clear();
        assert!(Recent::load(path).files().is_empty());
    }

    #[test]
    fn tolerates_a_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recent.json");
        fs::write(&path, "not json").unwrap();
        assert!(Recent::load(path.clone()).files().is_empty());
        fs::write(
            &path,
            r#"[{"id":"ok","name":"n","opened_at":1},{"id":"b a d","name":"n","opened_at":1}]"#,
        )
        .unwrap();
        assert_eq!(
            Recent::load(path).files().len(),
            1,
            "entries with a bad id are dropped"
        );
    }

    #[test]
    fn reads_names_from_titles() {
        assert_eq!(name_from_title("Landing — Design"), "Landing");
        assert_eq!(name_from_title("A — B — Board"), "A — B");
        assert_eq!(name_from_title("Morfa"), "Morfa");
    }
}
