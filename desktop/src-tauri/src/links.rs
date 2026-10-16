//! Deep links (docs/desktop.md §Deep links): `morfa://file/<id>`, the app's own `https://app.morfa.example/#design/<id>`
//! and `.rdesign` files handed to the app by the system all open in a Morfa window.

use std::path::PathBuf;

use url::Url;

use crate::origin::Origins;

/// The custom scheme registered with the system (tauri.conf.json `plugins.deep-link.desktop.schemes`).
pub const SCHEME: &str = "morfa";

/// What a link or a command-line argument asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A file in the editor, `#design/<id>`.
    File(String),
    /// The file browser, `#designs`.
    Files,
    /// A portable file on disk to open as a new file.
    Portable(PathBuf),
}

/// A file id as the app writes it (`#design/<id>`): letters, digits, `-` and `_`, at most 128.
pub fn valid_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn file(id: &str) -> Option<Target> {
    valid_file_id(id).then(|| Target::File(id.to_owned()))
}

/// `#design/<id>[?…]` → the file; any other app hash → the file browser (the app does the same, src/navigation.ts).
fn from_hash(fragment: Option<&str>) -> Option<Target> {
    match fragment {
        Some(hash) if hash.starts_with("design/") => {
            let id = hash["design/".len()..]
                .split('?')
                .next()
                .unwrap_or_default();
            file(&percent_decode(id)?)
        }
        _ => Some(Target::Files),
    }
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Reads one link: `morfa://file/<id>`, `morfa://files`, `morfa://open?…` is not a thing; an app URL with a hash.
pub fn parse_link(text: &str, origins: &Origins) -> Option<Target> {
    let url = Url::parse(text.trim()).ok()?;
    if url.scheme() == SCHEME {
        // `morfa://file/<id>`: the host is "file", the path the id (`morfa:file/<id>` has no host and is refused).
        return match (url.host_str(), url.path().trim_matches('/')) {
            (Some("file"), id) => file(&percent_decode(id)?),
            (Some("files"), "") => Some(Target::Files),
            _ => None,
        };
    }
    if origins.is_app(&url) {
        return from_hash(url.fragment());
    }
    None
}

/// The targets among a process's arguments (the first launch, or a second one forwarded by single-instance):
/// links, and paths ending in `.rdesign` (relative ones against `cwd`). Flags and anything else are ignored.
pub fn targets_from_args<I, S>(args: I, cwd: &std::path::Path, origins: &Origins) -> Vec<Target>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut targets = Vec::new();
    for arg in args {
        let arg = arg.as_ref();
        if arg.starts_with('-') {
            continue;
        }
        if let Some(target) = parse_link(arg, origins) {
            targets.push(target);
        } else if arg
            .to_ascii_lowercase()
            .ends_with(crate::portable::EXTENSION)
        {
            let path = PathBuf::from(arg);
            targets.push(Target::Portable(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }));
        }
    }
    targets
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origins() -> Origins {
        Origins::from_env(None, None, false).unwrap()
    }

    #[test]
    fn parses_scheme_links() {
        let o = origins();
        assert_eq!(
            parse_link("morfa://file/abc-123_X", &o),
            Some(Target::File("abc-123_X".into()))
        );
        assert_eq!(
            parse_link("morfa://file/abc/", &o),
            Some(Target::File("abc".into()))
        );
        assert_eq!(parse_link("morfa://files", &o), Some(Target::Files));
        assert_eq!(
            parse_link("MORFA://file/abc", &o),
            Some(Target::File("abc".into())),
            "schemes are case-insensitive"
        );
        assert_eq!(parse_link("morfa://file/", &o), None);
        assert_eq!(parse_link("morfa://file/a/b", &o), None);
        assert_eq!(parse_link("morfa://file/..%2Fetc", &o), None);
        assert_eq!(parse_link("morfa://elsewhere/abc", &o), None);
        assert_eq!(
            parse_link(&format!("morfa://file/{}", "a".repeat(129)), &o),
            None
        );
    }

    #[test]
    fn parses_app_links() {
        let o = origins();
        assert_eq!(
            parse_link("https://app.morfa.example/#design/f1", &o),
            Some(Target::File("f1".into()))
        );
        assert_eq!(
            parse_link("https://app.morfa.example/#design/f1?node=2", &o),
            Some(Target::File("f1".into()))
        );
        assert_eq!(
            parse_link("https://app.morfa.example/#design/f%2D1", &o),
            Some(Target::File("f-1".into()))
        );
        assert_eq!(
            parse_link("https://app.morfa.example/#designs", &o),
            Some(Target::Files)
        );
        assert_eq!(
            parse_link("https://app.morfa.example/", &o),
            Some(Target::Files)
        );
        assert_eq!(
            parse_link("https://app.morfa.example/#design/bad%zz", &o),
            None
        );
        assert_eq!(
            parse_link("https://morfa.example/#design/f1", &o),
            None,
            "the landing is not the app"
        );
        assert_eq!(parse_link("https://evil.example/#design/f1", &o), None);
        let dev = Origins::from_env(None, None, true).unwrap();
        assert_eq!(
            parse_link("http://127.0.0.1:5400/#design/f1", &dev),
            Some(Target::File("f1".into()))
        );
    }

    #[test]
    fn reads_arguments() {
        let o = origins();
        let cwd = std::path::Path::new("/home/me");
        let args = [
            "/opt/morfa/morfa",
            "--flag",
            "morfa://file/a",
            "Docs/Plan.RDESIGN",
            "/tmp/x.rdesign",
            "notes.txt",
            "https://app.morfa.example/#design/b",
        ];
        assert_eq!(
            targets_from_args(&args[1..], cwd, &o),
            vec![
                Target::File("a".into()),
                Target::Portable(PathBuf::from("/home/me/Docs/Plan.RDESIGN")),
                Target::Portable(PathBuf::from("/tmp/x.rdesign")),
                Target::File("b".into()),
            ]
        );
    }
}
