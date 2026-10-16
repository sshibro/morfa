//! Local fonts (Figma desktop's "local fonts"): the faces installed on this computer, listed for the editor's font
//! picker and read by id so the editor can draw and shape with the same bytes (src/desktop/fonts.ts). The web side
//! never names a path: it gets ids from the list, and only those ids can be read.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// A face larger than this is not handed to the web (no real font file is near it).
pub const MAX_FACE_BYTES: u64 = 64 * 1024 * 1024;

/// One face as the web sees it, shaped like the Local Font Access API's `FontData` (family, fullName,
/// postscriptName, style) so the editor's registry treats it the same as Chrome's (src/design/engine/fonts.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub id: u32,
    pub family: String,
    pub full_name: String,
    pub postscript_name: String,
    /// "Bold Italic", "Light", "Regular": what `parseLocalStyle` reads back into weight and slant.
    pub style: String,
    pub weight: u16,
    pub italic: bool,
    /// The face sits in a collection (`.ttc`): the web draws it with `local()` instead of reading bytes.
    pub collection: bool,
}

#[derive(Clone, Debug)]
struct Face {
    info: FontInfo,
    path: PathBuf,
}

/// The faces found by one scan.
#[derive(Debug, Default)]
pub struct FontCatalog {
    faces: Vec<Face>,
}

/// The style name for a weight and slant, in the words `parseLocalStyle` knows.
pub fn style_name(weight: u16, italic: bool) -> String {
    let name = match weight {
        0..=149 => "Thin",
        150..=249 => "ExtraLight",
        250..=349 => "Light",
        350..=449 => "Regular",
        450..=549 => "Medium",
        550..=649 => "SemiBold",
        650..=749 => "Bold",
        750..=849 => "ExtraBold",
        _ => "Black",
    };
    match (name, italic) {
        ("Regular", true) => "Italic".into(),
        (name, true) => format!("{name} Italic"),
        (name, false) => name.into(),
    }
}

impl FontCatalog {
    /// Every font the system knows (fontconfig's folders on Linux, /Library/Fonts and ~/Library/Fonts on macOS,
    /// the Windows fonts folders).
    pub fn system() -> Self {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        Self::from_db(&db)
    }

    /// The fonts of some folders (tests).
    pub fn from_dirs(dirs: &[&Path]) -> Self {
        let mut db = fontdb::Database::new();
        for dir in dirs {
            db.load_fonts_dir(dir);
        }
        Self::from_db(&db)
    }

    fn from_db(db: &fontdb::Database) -> Self {
        let mut faces: Vec<Face> = Vec::new();
        for face in db.faces() {
            let path = match &face.source {
                fontdb::Source::File(path) => path.clone(),
                fontdb::Source::SharedFile(path, _) => path.clone(),
                fontdb::Source::Binary(_) => continue,
            };
            let Some((family, _)) = face.families.first() else {
                continue;
            };
            // Names starting with a dot are the system's private UI fonts on macOS (.SF NS …): Figma hides them too.
            if family.trim().is_empty()
                || family.starts_with('.')
                || face.post_script_name.is_empty()
            {
                continue;
            }
            let italic = !matches!(face.style, fontdb::Style::Normal);
            let weight = face.weight.0.clamp(1, 1000);
            let style = style_name(weight, italic);
            let full_name = if style == "Regular" {
                family.clone()
            } else {
                format!("{family} {style}")
            };
            let collection = face.index > 0
                || path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("ttc") || ext.eq_ignore_ascii_case("otc")
                    });
            // The same face installed twice (user and system folders): the first one found wins.
            if faces
                .iter()
                .any(|known| known.info.postscript_name == face.post_script_name)
            {
                continue;
            }
            faces.push(Face {
                info: FontInfo {
                    id: 0,
                    family: family.clone(),
                    full_name,
                    postscript_name: face.post_script_name.clone(),
                    style,
                    weight,
                    italic,
                    collection,
                },
                path,
            });
        }
        faces.sort_by(|a, b| {
            a.info
                .family
                .to_lowercase()
                .cmp(&b.info.family.to_lowercase())
                .then(a.info.weight.cmp(&b.info.weight))
                .then(a.info.italic.cmp(&b.info.italic))
        });
        for (index, face) in faces.iter_mut().enumerate() {
            face.info.id = index as u32;
        }
        Self { faces }
    }

    pub fn list(&self) -> Vec<FontInfo> {
        self.faces.iter().map(|face| face.info.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.faces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.faces.is_empty()
    }

    /// The file of a listed face. Collections are refused: the web uses `local()` for them.
    pub fn read(&self, id: u32) -> Result<Vec<u8>, String> {
        let face = self.faces.get(id as usize).ok_or("No such font.")?;
        if face.info.collection {
            return Err("A font from a collection is read through local().".into());
        }
        let size = std::fs::metadata(&face.path)
            .map_err(|error| format!("The font is unavailable: {error}."))?
            .len();
        if size > MAX_FACE_BYTES {
            return Err("The font file is too large.".into());
        }
        std::fs::read(&face.path).map_err(|error| format!("The font is unavailable: {error}."))
    }
}

#[cfg(test)]
pub(crate) mod tests_support {
    use std::path::{Path, PathBuf};

    /// A TrueType or OpenType file of this machine's own fonts, copied into a folder of its own (fontdb does not read
    /// the repository's woff2). None on a machine without one.
    pub fn some_system_font() -> Option<PathBuf> {
        let roots = [
            "/usr/share/fonts",
            "/System/Library/Fonts",
            "/Library/Fonts",
            "C:\\Windows\\Fonts",
        ];
        fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
            let entries = std::fs::read_dir(dir).ok()?;
            let mut dirs = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("ttf") || e.eq_ignore_ascii_case("otf"))
                {
                    return Some(path);
                }
            }
            if depth == 0 {
                return None;
            }
            dirs.sort();
            dirs.iter().find_map(|dir| walk(dir, depth - 1))
        }
        roots.iter().find_map(|root| walk(Path::new(root), 3))
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::some_system_font;
    use super::*;

    #[test]
    fn names_styles_as_the_editor_reads_them() {
        assert_eq!(style_name(400, false), "Regular");
        assert_eq!(style_name(400, true), "Italic");
        assert_eq!(style_name(700, true), "Bold Italic");
        assert_eq!(style_name(600, false), "SemiBold");
        assert_eq!(style_name(100, false), "Thin");
        assert_eq!(style_name(950, false), "Black");
        assert_eq!(style_name(300, false), "Light");
    }

    #[test]
    fn lists_and_reads_only_listed_faces() {
        let Some(font) = some_system_font() else {
            eprintln!("no TrueType font on this machine: the listing test is skipped");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join(font.file_name().unwrap());
        std::fs::copy(&font, &copy).unwrap();
        std::fs::write(dir.path().join("not-a-font.ttf"), b"nonsense").unwrap();
        let catalog = FontCatalog::from_dirs(&[dir.path()]);
        assert!(!catalog.is_empty(), "{} lists", font.display());
        let list = catalog.list();
        assert_eq!(list.len(), catalog.len());
        assert!(list.iter().enumerate().all(|(i, face)| face.id == i as u32
            && !face.family.is_empty()
            && !face.postscript_name.is_empty()));
        let first = &list[0];
        assert_eq!(
            catalog.read(first.id).unwrap(),
            std::fs::read(&copy).unwrap()
        );
        assert!(
            catalog.read(list.len() as u32).is_err(),
            "an id outside the list reads nothing"
        );
        assert!(catalog.read(u32::MAX).is_err());
    }

    #[test]
    fn an_empty_folder_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = FontCatalog::from_dirs(&[dir.path()]);
        assert!(catalog.is_empty());
        assert!(catalog.read(0).is_err());
    }
}
