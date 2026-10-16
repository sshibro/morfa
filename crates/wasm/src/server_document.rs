//! The api's fast path for a whole document (TARGETS S5: a version restore or a `PUT` of up to 100 MB): the model's
//! reader validates the JSON text the body carries, and the same pass gives what `prepare()` (server/design/files.ts)
//! stores beside it — the text to store, its layer count and the pictures it points at. Server build only (feature
//! `server`).
//!
//! It only ever accepts less than the TypeScript schema: a document it refuses (or cannot read) goes the way it goes
//! today, through `JSON.parse` and `validateDocument`, which then decides alone. `tests/design-server-document.test.ts`
//! checks every fixture, the seeded mutants of scripts/model/mutate.ts and the documents at the caps: whatever this
//! accepts, `validateDocument` accepts too, with the same value (the stored text parses to zod's stripped value), the
//! same layer count and the same pictures.

use morfa_model::store::Document;
use morfa_model::{codec, from_json, from_json_validated, to_json};
use wasm_bindgen::prelude::*;

/// A document the model's reader accepted, as the api stores it.
#[wasm_bindgen]
pub struct ServerDocument {
    text: Vec<u8>,
    bytes: u32,
    node_count: u32,
    image_files: Vec<String>,
    images: String,
    base_version: Option<f64>,
}

#[wasm_bindgen]
impl ServerDocument {
    /// The document's JSON text as the api stores it (the model's writer: `JSON.stringify`'s numbers and escapes, the
    /// model's key order), moved out (a second call is empty): up to 100 MB is not copied twice.
    pub fn take_text(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.text)
    }

    /// The text's length in bytes (`documentBytes`).
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> u32 {
        self.bytes
    }

    /// `Object.keys(doc.nodes).length` (`documentNodeCount`).
    #[wasm_bindgen(getter)]
    pub fn node_count(&self) -> u32 {
        self.node_count
    }

    /// `documentImageFiles(doc)`: each picture URL once, in the table's order, without `/uploads/`.
    #[wasm_bindgen(getter)]
    pub fn image_files(&self) -> Vec<String> {
        self.image_files.clone()
    }

    /// The picture table as `{ref: {url}}` JSON, in its order (the api's check that each picture is the account's).
    #[wasm_bindgen(getter)]
    pub fn images(&self) -> String {
        self.images.clone()
    }

    /// The `baseVersion` of a `PUT` body ([`read_server_put`]), as JSON numbers read; undefined for a bare document.
    #[wasm_bindgen(getter)]
    pub fn base_version(&self) -> Option<f64> {
        self.base_version
    }
}

/// A `PUT /:id/document` body, `{"baseVersion": n, "document": {…}}`, as its UTF-8 bytes (no BOM), read as
/// [`read_server_document`] reads the document. Other keys are ignored as the route's schema ignores them; a body of
/// another shape (a key twice, no document, a version that is not a number, bytes that are not UTF-8) is undefined:
/// the route reads it as before.
#[wasm_bindgen]
pub fn read_server_put(body: &[u8]) -> Option<ServerDocument> {
    let json = std::str::from_utf8(body).ok()?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Put<'a> {
        base_version: f64,
        #[serde(borrow)]
        document: &'a serde_json::value::RawValue,
    }
    if has_surrogate_escape(json) {
        return None;
    }
    let put: Put = serde_json::from_str(json).ok()?;
    let mut read = read_server_document(put.document.get())?;
    read.base_version = Some(put.base_version);
    Some(read)
}

/// The document of `json` when the model's reader accepts it (`validateDocument`'s rules), else `undefined`: the
/// caller then decides with the TypeScript schema, as before. Never throws for a refused document.
#[wasm_bindgen]
pub fn read_server_document(json: &str) -> Option<ServerDocument> {
    // An escaped surrogate (`\ud83d`): the model reads a lone one as U+FFFD where `JSON.parse` keeps it, so a text with
    // any is left to the TypeScript path, which stores it as it is.
    if has_surrogate_escape(json) {
        return None;
    }
    let doc = from_json_validated(json).ok()?;
    // `documentImageFiles`: each URL once (a Set, in the table's order) without `/uploads/`. Any other URL (the api
    // refuses it as a picture of another account) is left to the TypeScript path.
    let mut image_files: Vec<String> = Vec::new();
    // In the table's order (a refusal names the first picture of a file that is not the account's, as before).
    let mut images = String::from("{");
    for (reference, asset) in &doc.images {
        if images.len() > 1 {
            images.push(',');
        }
        let (reference, url) = (
            serde_json::to_string(&reference.to_string()).ok()?,
            serde_json::to_string(&asset.url).ok()?,
        );
        images.push_str(&format!("{reference}:{{\"url\":{url}}}"));
    }
    images.push('}');
    let mut urls: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for asset in doc.images.values() {
        if !urls.insert(&asset.url) {
            continue;
        }
        image_files.push(asset.url.strip_prefix("/uploads/")?.to_owned());
    }
    let text = to_json(&doc).into_bytes();
    Some(ServerDocument {
        node_count: doc.nodes.len() as u32,
        bytes: text.len() as u32,
        text,
        image_files,
        images,
        base_version: None,
    })
}

/// `GET /api/design-files/:id/checkpoint` of an api-path file: the file's stored JSON text, as its
/// UTF-8 bytes, in the model's binary codec (an `MRFA` frame, what `MorfaDoc.encode()` writes), with no JS string and no
/// `MorfaDoc` handle in between. Undefined when the codec would not carry the text exactly: bytes that are not UTF-8, an escaped
/// surrogate (the model reads a lone one as U+FFFD), or a text the model does not read. The route then answers that the
/// client opens with `GET /:id`.
#[wasm_bindgen]
pub fn encode_server_document(json: &[u8]) -> Option<Vec<u8>> {
    let json = std::str::from_utf8(json).ok()?;
    if has_surrogate_escape(json) {
        return None;
    }
    let model = from_json(json).ok()?;
    Some(codec::encode(&Document::from_model(&model)))
}

/// Whether `json` holds `\uD800`–`\uDFFF` (either case) after a backslash that is not itself escaped.
fn has_surrogate_escape(json: &str) -> bool {
    let bytes = json.as_bytes();
    let mut at = 0;
    while let Some(found) = bytes[at..].iter().position(|&byte| byte == b'\\') {
        let slash = at + found;
        let next = bytes.get(slash + 1).copied();
        if next == Some(b'u')
            && bytes
                .get(slash + 2)
                .is_some_and(|b| b.eq_ignore_ascii_case(&b'd'))
            && bytes
                .get(slash + 3)
                .is_some_and(|b| matches!(b.to_ascii_lowercase(), b'8'..=b'9' | b'a'..=b'f'))
        {
            return true;
        }
        // `\\` is one escaped backslash: skip both.
        at = slash + 2;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::has_surrogate_escape;

    #[test]
    fn finds_escaped_surrogates_only() {
        assert!(has_surrogate_escape(r#"{"a":"\ud83d\ude00"}"#));
        assert!(has_surrogate_escape(r#"{"a":"x\uDC00"}"#));
        assert!(!has_surrogate_escape(r#"{"a":"\u00e9 \ue000"}"#));
        assert!(
            !has_surrogate_escape(r#"{"a":"\\ud800"}"#),
            "an escaped backslash, then text"
        );
        assert!(!has_surrogate_escape("{}"));
    }
}
