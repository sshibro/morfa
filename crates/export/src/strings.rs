//! The regular expressions and string rules of svg-export.ts, spelled out (JavaScript semantics: `\s` is
//! ECMAScript's white space and line terminators, `\w` ASCII, `\p{L}`/`\p{N}` Unicode general categories).

use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

/// ECMAScript `\s` (WhiteSpace + LineTerminator), also what `String.prototype.trim` removes.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `\p{L}`.
pub fn is_letter(c: char) -> bool {
    matches!(
        get_general_category(c),
        GeneralCategory::UppercaseLetter
            | GeneralCategory::LowercaseLetter
            | GeneralCategory::TitlecaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
    )
}

/// `\p{N}`.
pub fn is_number(c: char) -> bool {
    matches!(
        get_general_category(c),
        GeneralCategory::DecimalNumber
            | GeneralCategory::LetterNumber
            | GeneralCategory::OtherNumber
    )
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `familyValue`: quoted unless every word is a CSS identifier.
pub fn family_value(family: &str) -> String {
    // /^[A-Za-z_][\w-]*(?: [A-Za-z_][\w-]*)*$/
    let plain = !family.is_empty()
        && family.split(' ').all(|word| {
            let mut chars = word.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| is_word(c) || c == '-')
        });
    if plain {
        format!("{family}, sans-serif")
    } else {
        let cleaned: String = family.chars().filter(|&c| c != '\'' && c != '\\').collect();
        format!("'{cleaned}', sans-serif")
    }
}

/// `SAFE_ID_PREFIX`: /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.
pub fn is_safe_id_prefix(prefix: &str) -> bool {
    let mut chars = prefix.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && prefix.chars().count() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `SAFE_IMAGE`: /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.
pub fn is_safe_image(data: &str) -> bool {
    let lower_prefix = |n: usize| data.get(..n).map(|p| p.to_ascii_lowercase());
    let head = "data:image/";
    if lower_prefix(head.len()).as_deref() != Some(head) {
        return false;
    }
    let rest = &data[head.len()..];
    let mut matched = None;
    for kind in ["png", "jpeg", "jpg", "gif", "webp", "avif"] {
        let tail = ";base64,";
        let n = kind.len() + tail.len();
        if rest.get(..n).map(|p| p.to_ascii_lowercase()).as_deref()
            == Some(&format!("{kind}{tail}"))
        {
            matched = Some(n);
            break;
        }
    }
    let Some(n) = matched else { return false };
    let body = &rest[n..];
    !body.is_empty()
        && body.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || is_js_space(c)
        })
}

/// `SAFE_HREF`: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]*$/.
pub fn is_safe_href(href: &str) -> bool {
    let Some(rest) = href.strip_prefix("https://") else {
        return false;
    };
    let host_end = rest
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    if host_end == 0 {
        return false;
    }
    let mut rest = &rest[host_end..];
    if let Some(port) = rest.strip_prefix(':') {
        let digits = port
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(port.len());
        if !(1..=5).contains(&digits) {
            return false;
        }
        rest = &port[digits..];
    }
    let Some(path) = rest.strip_prefix('/') else {
        return false;
    };
    path.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '/' | '-'))
}

/// `linkHref`: http(s) and mailto only, as `new URL(url).protocol` reads it.
pub fn link_href(href: &str) -> Option<String> {
    if href.encode_utf16().count() > 2_048 {
        return None;
    }
    #[cfg(feature = "whatwg-url")]
    {
        let parsed = url::Url::parse(href).ok()?;
        matches!(parsed.scheme(), "http" | "https" | "mailto").then(|| href.to_owned())
    }
    #[cfg(not(feature = "whatwg-url"))]
    {
        // Without the parser: the scheme (case-insensitive, leading/trailing C0 controls and spaces trimmed as the
        // parser trims them), and for http(s) a host of the characters an ordinary host has.
        let trimmed = href.trim_matches(|c: char| c <= ' ');
        let colon = trimmed.find(':')?;
        let scheme = trimmed[..colon].to_ascii_lowercase();
        let rest = &trimmed[colon + 1..];
        let ok = match scheme.as_str() {
            "mailto" => true,
            "http" | "https" => {
                let after = rest.trim_start_matches(['/', '\\']);
                let host_end = after.find(['/', '\\', '?', '#']).unwrap_or(after.len());
                let authority = &after[..host_end];
                let host = authority.rsplit('@').next().unwrap_or("");
                let host = host.split(':').next().unwrap_or("");
                !host.is_empty()
                    && host
                        .chars()
                        .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | '[' | ']'))
            }
            _ => false,
        };
        ok.then(|| href.to_owned())
    }
}

/// The layer's name as an id before it is made unique (`layerId`): NFC, trimmed, spaces as "_", only letters,
/// digits, "_", "-" and ".", at most 64 code points, "layer" when empty, "_" before a first character that is
/// not a letter or "_".
pub fn layer_id_base(name: &str) -> String {
    let normalized: String = name.nfc().collect();
    let trimmed = normalized.trim_matches(is_js_space);
    let mut spaced = String::with_capacity(trimmed.len());
    let mut in_space = false;
    for c in trimmed.chars() {
        if is_js_space(c) {
            if !in_space {
                spaced.push('_');
            }
            in_space = true;
        } else {
            spaced.push(c);
            in_space = false;
        }
    }
    let kept: String = spaced
        .chars()
        .filter(|&c| is_letter(c) || is_number(c) || c == '_' || c == '.' || c == '-')
        .take(64)
        .collect();
    if kept.is_empty() {
        return "layer".to_owned();
    }
    let first = kept.chars().next().expect("not empty");
    if is_letter(first) || first == '_' {
        kept
    } else {
        format!("_{kept}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families() {
        assert_eq!(family_value("Inter"), "Inter, sans-serif");
        assert_eq!(family_value("Exo 2"), "'Exo 2', sans-serif");
        assert_eq!(family_value("PT Sans"), "PT Sans, sans-serif");
        assert_eq!(family_value("A  B"), "'A  B', sans-serif");
    }

    #[test]
    fn layer_ids() {
        assert_eq!(layer_id_base("  Кнопка  главная "), "Кнопка_главная");
        assert_eq!(layer_id_base("1 card"), "_1_card");
        assert_eq!(layer_id_base("!!!"), "layer");
    }

    #[test]
    fn hrefs() {
        assert!(is_safe_href("https://x.example/a/b.png"));
        assert!(is_safe_href("https://x.example:443/"));
        assert!(!is_safe_href("https://X.example/"));
        assert!(!is_safe_href("https://x.example"));
        assert!(is_safe_image("data:image/PNG;base64,AAAA"));
        assert!(!is_safe_image("data:image/svg+xml;base64,AAAA"));
    }

    #[test]
    fn links() {
        for ok in [
            "https://example.com/a?b#c",
            "http://пример.рф/",
            "HTTPS://Example.com",
            "mailto:a@b.ru",
            " https://x.io ",
        ] {
            assert!(link_href(ok).is_some(), "{ok}");
        }
        for no in [
            "javascript:alert(1)",
            "ftp://x.io",
            "http://",
            "https:",
            "/relative",
            "data:text/html,x",
        ] {
            assert!(link_href(no).is_none(), "{no}");
        }
    }
}
