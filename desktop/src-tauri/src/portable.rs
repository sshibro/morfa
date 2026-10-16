//! Morfa's portable file (`.rdesign`, src/design/persistence/portable.ts) on disk: what the native open and save
//! dialogs read and write. The web side checks the content (format, schema, pictures); the shell checks only what
//! is its own: the extension, the 50 MB cap (shared/design/document-limits.ts `DESIGN_PORTABLE_MAX_BYTES`) and that
//! a save never leaves a half-written file behind.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const EXTENSION: &str = ".rdesign";
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
const UNTITLED: &str = "Untitled";

/// A file name for the save dialog: no path separators or control characters, at most 120 characters, `.rdesign`.
pub fn file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let words = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem = words.strip_suffix(EXTENSION).unwrap_or(&words).trim();
    let stem: String = if stem.is_empty() || stem.chars().all(|c| c == '.') {
        UNTITLED.into()
    } else {
        stem.chars().take(120).collect()
    };
    format!("{stem}{EXTENSION}")
}

/// The path the dialog answered, with `.rdesign` added when the user typed a name without it.
pub fn with_extension(path: PathBuf) -> PathBuf {
    let has = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(EXTENSION));
    if has {
        return path;
    }
    let mut text = path.into_os_string();
    text.push(EXTENSION);
    PathBuf::from(text)
}

/// Reads a file the user chose (dialog, drop, "Open with"): `.rdesign`, a regular file, at most 50 MB.
pub fn read(path: &Path) -> Result<Vec<u8>, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !name.to_ascii_lowercase().ends_with(EXTENSION) {
        return Err("Only .rdesign files can be opened.".into());
    }
    let file =
        fs::File::open(path).map_err(|error| format!("Couldn't open the file: {error}."))?;
    let meta = file
        .metadata()
        .map_err(|error| format!("Couldn't open the file: {error}."))?;
    if !meta.is_file() {
        return Err("This is not a file.".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("The file is larger than 50 MB.".into());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // `take` guards a file that grows while it is read.
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Couldn't read the file: {error}."))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("The file is larger than 50 MB.".into());
    }
    Ok(bytes)
}

/// Writes the file through a temporary sibling and a rename, so a failure keeps the old file whole.
pub fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("The file is larger than 50 MB.".into());
    }
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path.file_name().ok_or("The file has no name.")?;
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(".part");
    let temp = dir.join(temp_name);
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    result.map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Couldn't save the file: {error}.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // Cyrillic names are test data here: the sanitiser must keep non-ASCII letters (and count characters, not bytes).
    fn names_files() {
        assert_eq!(file_name("Лендинг: v2/финал"), "Лендинг v2 финал.rdesign");
        assert_eq!(file_name("  "), "Untitled.rdesign");
        assert_eq!(file_name(".."), "Untitled.rdesign");
        assert_eq!(file_name("plan.rdesign"), "plan.rdesign");
        assert_eq!(file_name("a\u{0}b\nc"), "a b c.rdesign");
        assert_eq!(
            file_name(&"я".repeat(300)).chars().count(),
            120 + EXTENSION.len()
        );
    }

    #[test]
    fn adds_the_extension() {
        assert_eq!(
            with_extension(PathBuf::from("/tmp/plan")),
            PathBuf::from("/tmp/plan.rdesign")
        );
        assert_eq!(
            with_extension(PathBuf::from("/tmp/plan.RDESIGN")),
            PathBuf::from("/tmp/plan.RDESIGN")
        );
        assert_eq!(
            with_extension(PathBuf::from("/tmp/plan.json")),
            PathBuf::from("/tmp/plan.json.rdesign")
        );
    }

    #[test]
    fn writes_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plan.rdesign");
        write(&path, b"{\"format\":\"morfa-design\"}").unwrap();
        assert_eq!(read(&path).unwrap(), b"{\"format\":\"morfa-design\"}");
        write(&path, b"second").unwrap();
        assert_eq!(read(&path).unwrap(), b"second", "a save replaces the file");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            leftovers,
            vec![std::ffi::OsString::from("plan.rdesign")],
            "no temporary file stays"
        );
    }

    #[test]
    fn refuses_what_is_not_a_portable_file() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("notes.txt");
        fs::write(&other, "x").unwrap();
        assert!(read(&other).unwrap_err().contains(".rdesign"));
        let folder = dir.path().join("folder.rdesign");
        fs::create_dir(&folder).unwrap();
        assert!(read(&folder).is_err());
        assert!(read(&dir.path().join("missing.rdesign")).is_err());
        let big = dir.path().join("big.rdesign");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert_eq!(read(&big).unwrap_err(), "The file is larger than 50 MB.");
        assert!(write(&dir.path().join("missing-dir/x.rdesign"), b"x").is_err());
    }
}
