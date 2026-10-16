//! The tiny element tree of `shared/design/svg-export.ts` (`El`, `el`, `write`) and its one escaping writer
//! (`escapeXmlText`, `escapeXmlAttribute`). Attributes keep JavaScript's object order: a key set again keeps its
//! place, a new key goes last, and an absent value (`undefined`) keeps its place but is never written.

use morfa_geometry::paths::format_number;

/// An attribute value: a number (written through `formatNumber` at the export's precision) or text.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Num(f64),
    Str(String),
}

impl Val {
    /// JavaScript truthiness (`!!value`).
    pub fn truthy(&self) -> bool {
        match self {
            Val::Num(v) => *v != 0.0 && !v.is_nan(),
            Val::Str(s) => !s.is_empty(),
        }
    }
}

impl From<f64> for Val {
    fn from(v: f64) -> Self {
        Val::Num(v)
    }
}
impl From<String> for Val {
    fn from(s: String) -> Self {
        Val::Str(s)
    }
}
impl From<&str> for Val {
    fn from(s: &str) -> Self {
        Val::Str(s.to_owned())
    }
}

/// `undefined` or a value.
pub type Attr = Option<Val>;

pub fn num(v: f64) -> Attr {
    Some(Val::Num(v))
}
pub fn s(v: impl Into<String>) -> Attr {
    Some(Val::Str(v.into()))
}

/// Ordered attributes, as a JavaScript object literal keeps them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attrs(pub Vec<(&'static str, Attr)>);

impl Attrs {
    pub fn new() -> Self {
        Attrs(Vec::new())
    }
    /// `{...attrs, [name]: value}`.
    pub fn set(&mut self, name: &'static str, value: Attr) {
        if let Some(slot) = self.0.iter_mut().find(|(n, _)| *n == name) {
            slot.1 = value;
        } else {
            self.0.push((name, value));
        }
    }
    pub fn with(mut self, name: &'static str, value: Attr) -> Self {
        self.set(name, value);
        self
    }
    /// `{...self, ...other}`.
    pub fn merge(&mut self, other: &Attrs) {
        for (name, value) in &other.0 {
            self.set(name, value.clone());
        }
    }
    pub fn get(&self, name: &str) -> Option<&Val> {
        self.0
            .iter()
            .find(|(n, _)| *n == name)
            .and_then(|(_, v)| v.as_ref())
    }
    /// `!!attrs[name]`.
    pub fn truthy(&self, name: &str) -> bool {
        self.get(name).is_some_and(Val::truthy)
    }
    /// Some attribute has a value other than `undefined` and `''`.
    pub fn any_written(&self) -> bool {
        self.0.iter().any(|(_, v)| {
            matches!(v, Some(Val::Num(_))) || matches!(v, Some(Val::Str(s)) if !s.is_empty())
        })
    }
    /// The attributes whose value is defined, in order (`Object.entries(…).filter(([, v]) => v !== undefined)`).
    pub fn defined(&self) -> Attrs {
        Attrs(
            self.0
                .iter()
                .filter(|(_, v)| v.is_some())
                .cloned()
                .collect(),
        )
    }
}

/// `{a: 1, b: 'x'}` → `Attrs`.
#[macro_export]
macro_rules! attrs {
    ($($name:literal => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut a = $crate::xml::Attrs::new();
        $(a.0.push(($name, $value));)*
        a
    }};
}

#[derive(Clone, Debug, PartialEq)]
pub enum Child {
    El(El),
    Text(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct El {
    pub tag: &'static str,
    pub attrs: Attrs,
    pub children: Vec<Child>,
}

pub fn el(tag: &'static str, attrs: Attrs, children: Vec<El>) -> El {
    El {
        tag,
        attrs,
        children: children.into_iter().map(Child::El).collect(),
    }
}

impl El {
    /// The element children (text children dropped), `children.filter((x): x is El => typeof x !== 'string')`.
    pub fn into_elements(self) -> Vec<El> {
        self.children
            .into_iter()
            .filter_map(|c| match c {
                Child::El(e) => Some(e),
                Child::Text(_) => None,
            })
            .collect()
    }
}

// Characters XML 1.0 cannot carry at all (controls, lone surrogates, U+FFFE/F) are dropped. Rust strings hold no
// lone surrogates; text built from UTF-16 maps them to U+FFFF first (`from_units`), which is dropped here too.
fn invalid_xml(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}')
}

pub fn escape_text_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c if invalid_xml(c) => {}
            c => out.push(c),
        }
    }
}

pub fn escape_attribute_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            '\t' => out.push_str("&#9;"),
            c if invalid_xml(c) => {}
            c => out.push(c),
        }
    }
}

pub fn escape_xml_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_text_into(&mut out, s);
    out
}

pub fn escape_xml_attribute(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_attribute_into(&mut out, s);
    out
}

/// UTF-16 code units as text, a lone surrogate as U+FFFF (which escaping drops, as JavaScript's regex drops the
/// surrogate itself; U+FFFF is neither a letter nor a space, so case and title-case rules see no difference).
pub fn from_units(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or('\u{ffff}'))
        .collect()
}

/// `write(node, f)`.
pub fn write(node: &El, precision: i32, out: &mut String) {
    out.push('<');
    out.push_str(node.tag);
    for (name, value) in &node.attrs.0 {
        let Some(value) = value else { continue };
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        match value {
            Val::Num(v) => escape_attribute_into(out, &format_number(*v, precision)),
            Val::Str(s) => {
                if s.is_empty() {
                    // `''` is skipped: undo the name.
                    out.truncate(out.len() - name.len() - 3);
                    continue;
                }
                escape_attribute_into(out, s)
            }
        }
        out.push('"');
    }
    if node.children.is_empty() {
        out.push_str("/>");
        return;
    }
    out.push('>');
    for child in &node.children {
        match child {
            Child::El(e) => write(e, precision, out),
            Child::Text(t) => escape_text_into(out, t),
        }
    }
    out.push_str("</");
    out.push_str(node.tag);
    out.push('>');
}
