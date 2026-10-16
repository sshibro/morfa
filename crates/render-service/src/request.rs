//! The job request of `POST /internal/render` (api → service). One binary body, so a picture crosses once and
//! the service never fetches anything:
//!
//! ```text
//! "MRR1" | u32 LE header length | header JSON | u32 LE document length | document JSON | picture bytes…
//! ```
//!
//! The header ([`Header`]) names the job (`kind`), the account it runs for (the per-account limits), what to draw,
//! how text is measured, the catalogue faces the pages use (files below the service's fonts directory) and the
//! pictures that follow the document, in order, by length. The document is the stored `DesignDocument` JSON the
//! api read at the version the editor asked for; nothing else from the editor reaches the output but numbers.

use morfa_geometry::matrix::Rect;
use serde::Deserialize;

use crate::limits::Limits;

pub const MAGIC: &[u8; 4] = b"MRR1";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pdf,
    Svg,
    Png,
    Jpeg,
    Webp,
    Thumbnail,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Pdf => "pdf",
            Kind::Svg => "svg",
            Kind::Png => "png",
            Kind::Jpeg => "jpeg",
            Kind::Webp => "webp",
            Kind::Thumbnail => "thumbnail",
        }
    }

    pub fn is_raster(self) -> bool {
        matches!(self, Kind::Png | Kind::Jpeg | Kind::Webp | Kind::Thumbnail)
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct CropIn {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<CropIn> for Rect {
    fn from(c: CropIn) -> Rect {
        Rect::new(c.x, c.y, c.width, c.height)
    }
}

/// One PDF page: `pdfPagePlan`'s ids and crop.
#[derive(Clone, Debug, Deserialize)]
pub struct PageIn {
    pub ids: Vec<String>,
    #[serde(default)]
    pub crop: Option<CropIn>,
}

/// `exportSvgPage`'s options (svg-export.ts), plus outline text (Rust's own).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgOptionsIn {
    #[serde(default)]
    pub precision: Option<i32>,
    #[serde(default)]
    pub id_prefix: Option<String>,
    #[serde(default)]
    pub layer_ids: bool,
    #[serde(default)]
    pub print: bool,
    #[serde(default)]
    pub crop: Option<CropIn>,
    #[serde(default)]
    pub outline_text: bool,
}

/// How text is measured: the editor's recorded table replayed (pdf-export.ts `replayMeasurements`, today's API),
/// the service's own fonts (lane L3's shaper: what Chrome's canvas measures), or the tests' fixed-width fake.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeasureIn {
    Table,
    #[default]
    Fonts,
    Fixed,
}

/// [family, weight, italic 0|1, size, ascent|null, descent|null].
pub type FontEntryIn = (String, f64, u8, f64, Option<f64>, Option<f64>);

/// `PdfMeasurements`: `fonts` [family, weight, italic 0|1, size, ascent|null, descent|null], `widths`
/// [font index, text, width].
#[derive(Clone, Debug, Default, Deserialize)]
pub struct MeasurementsIn {
    pub fonts: Vec<FontEntryIn>,
    pub widths: Vec<(usize, String, f64)>,
}

/// A catalogue face (export-fonts.ts `familyFaces`): the file below the fonts directory and its CSS descriptors.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceIn {
    pub family: String,
    pub weight: (f64, f64),
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub unicode_range: String,
    pub file: String,
}

/// A picture of the document: the URL the exporter writes for its ref (`imageHref`), and its byte count in the
/// body.
#[derive(Clone, Debug, Deserialize)]
pub struct PictureIn {
    #[serde(rename = "ref")]
    pub image_ref: String,
    pub href: String,
    pub length: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub kind: Kind,
    /// The account (or team) the job is for: the per-account limits' key.
    pub account: String,
    #[serde(default)]
    pub title: String,
    /// PDF: the pages in order.
    #[serde(default)]
    pub pages: Vec<PageIn>,
    /// SVG and raster: the layers drawn together (exportSvgPage's ids).
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub svg: SvgOptionsIn,
    /// Raster: device pixels per px, and the output's longest side cap (thumbnails: 512).
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub max_side: Option<u32>,
    #[serde(default)]
    pub quality: Option<u8>,
    #[serde(default)]
    pub measure: MeasureIn,
    #[serde(default)]
    pub measurements: Option<MeasurementsIn>,
    #[serde(default)]
    pub fonts: Vec<FaceIn>,
    #[serde(default)]
    pub pictures: Vec<PictureIn>,
    /// The longest the job may take from its arrival; the service's own limit when larger or missing.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// A parsed request: the header, the document's JSON and the pictures' bytes.
#[derive(Debug)]
pub struct Request {
    pub header: Header,
    pub document: String,
    pub pictures: Vec<(PictureIn, Vec<u8>)>,
}

/// Why a request is refused before it runs: status and code (the api's error vocabulary, shared/design/api.ts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl Refusal {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Refusal {
        Refusal {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Refusal {
        Refusal::new(400, "invalid_request", message)
    }

    pub fn too_large(message: impl Into<String>) -> Refusal {
        Refusal::new(413, "design_pdf_too_large", message)
    }
}

fn u32_at(body: &[u8], at: usize) -> Option<usize> {
    let b = body.get(at..at + 4)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
}

/// Reads and checks a body against the limits (pages, measurements, faces, pictures).
pub fn parse(body: &[u8], limits: &Limits) -> Result<Request, Refusal> {
    if body.len() > limits.body_bytes {
        return Err(Refusal::too_large(
            "the request is larger than the service takes",
        ));
    }
    if body.get(..4) != Some(&MAGIC[..]) {
        return Err(Refusal::invalid("not a render request (MRR1)"));
    }
    let header_len = u32_at(body, 4).ok_or_else(|| Refusal::invalid("truncated header length"))?;
    let header_end = 8usize
        .checked_add(header_len)
        .filter(|&e| e <= body.len())
        .ok_or_else(|| Refusal::invalid("truncated header"))?;
    let header: Header = serde_json::from_slice(&body[8..header_end])
        .map_err(|e| Refusal::invalid(format!("header: {e}")))?;
    let doc_len =
        u32_at(body, header_end).ok_or_else(|| Refusal::invalid("truncated document length"))?;
    let doc_start = header_end + 4;
    let doc_end = doc_start
        .checked_add(doc_len)
        .filter(|&e| e <= body.len())
        .ok_or_else(|| Refusal::invalid("truncated document"))?;
    let document = std::str::from_utf8(&body[doc_start..doc_end])
        .map_err(|_| Refusal::invalid("the document is not UTF-8"))?
        .to_owned();
    check(&header, limits)?;
    let mut at = doc_end;
    let mut pictures = Vec::with_capacity(header.pictures.len());
    for picture in &header.pictures {
        let end = at
            .checked_add(picture.length)
            .filter(|&e| e <= body.len())
            .ok_or_else(|| Refusal::invalid("truncated picture bytes"))?;
        pictures.push((picture.clone(), body[at..end].to_vec()));
        at = end;
    }
    if at != body.len() {
        return Err(Refusal::invalid("bytes after the last picture"));
    }
    Ok(Request {
        header,
        document,
        pictures,
    })
}

fn check(header: &Header, limits: &Limits) -> Result<(), Refusal> {
    if header.account.is_empty() || header.account.len() > 256 {
        return Err(Refusal::invalid("account"));
    }
    match header.kind {
        Kind::Pdf => {
            if header.pages.is_empty() {
                return Err(Refusal::invalid("no pages"));
            }
            if header.pages.len() > limits.pages {
                return Err(Refusal::too_large(format!(
                    "One PDF holds at most {} pages. Export the frames in parts.",
                    limits.pages
                )));
            }
        }
        _ => {
            if header.ids.is_empty() {
                return Err(Refusal::invalid("no layers"));
            }
        }
    }
    let ids = header.ids.len() + header.pages.iter().map(|p| p.ids.len()).sum::<usize>();
    if ids > limits.ids {
        return Err(Refusal::invalid("too many layer ids"));
    }
    if header.title.chars().count() > limits.title_length {
        return Err(Refusal::invalid("title"));
    }
    if let Some(m) = &header.measurements {
        if m.fonts.len() > limits.fonts || m.widths.len() > limits.widths {
            return Err(Refusal::too_large(
                "Too much text for one PDF. Export fewer frames at a time.",
            ));
        }
        if m.widths
            .iter()
            .any(|w| w.1.chars().count() > limits.text_length)
        {
            return Err(Refusal::invalid("a measured text is too long"));
        }
    } else if header.measure == MeasureIn::Table {
        return Err(Refusal::invalid("measure: table without measurements"));
    }
    if header.fonts.len() > limits.faces {
        return Err(Refusal::invalid("too many faces"));
    }
    for face in &header.fonts {
        if !crate::fonts::safe_file(&face.file) {
            return Err(Refusal::invalid(format!("face file {:?}", face.file)));
        }
    }
    if header.pictures.len() > limits.pictures {
        return Err(Refusal::invalid("too many pictures"));
    }
    if let Some(scale) = header.scale
        && !(scale > 0.0 && scale <= 16.0)
    {
        return Err(Refusal::invalid("scale"));
    }
    Ok(())
}

/// Builds a body (the api's side; tests and benches).
pub fn encode(header: &serde_json::Value, document: &str, pictures: &[&[u8]]) -> Vec<u8> {
    let header = serde_json::to_vec(header).expect("header JSON");
    let mut out = Vec::with_capacity(
        12 + header.len() + document.len() + pictures.iter().map(|p| p.len()).sum::<usize>(),
    );
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&(document.len() as u32).to_le_bytes());
    out.extend_from_slice(document.as_bytes());
    for p in pictures {
        out.extend_from_slice(p);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn limits() -> Limits {
        Limits::default()
    }

    #[test]
    fn round_trip() {
        let body = encode(
            &json!({"kind": "pdf", "account": "a1", "pages": [{"ids": ["n1"]}],
                    "pictures": [{"ref": "img0", "href": "https://x/0", "length": 3}]}),
            "{}",
            &[b"abc"],
        );
        let req = parse(&body, &limits()).unwrap();
        assert_eq!(req.header.kind, Kind::Pdf);
        assert_eq!(req.document, "{}");
        assert_eq!(req.pictures[0].1, b"abc");
        assert_eq!(req.header.measure, MeasureIn::Fonts);
    }

    #[test]
    fn refusals() {
        let pages: Vec<_> = (0..51).map(|i| json!({"ids": [format!("n{i}")]})).collect();
        let body = encode(
            &json!({"kind": "pdf", "account": "a", "pages": pages}),
            "{}",
            &[],
        );
        assert_eq!(
            parse(&body, &limits()).unwrap_err().code,
            "design_pdf_too_large"
        );
        let body = encode(
            &json!({"kind": "svg", "account": "a", "ids": ["n"],
            "fonts": [{"family": "Inter", "weight": [100, 900], "file": "../etc/passwd"}]}),
            "{}",
            &[],
        );
        assert_eq!(parse(&body, &limits()).unwrap_err().code, "invalid_request");
        let mut body = encode(
            &json!({"kind": "svg", "account": "a", "ids": ["n"]}),
            "{}",
            &[],
        );
        body.push(0);
        assert_eq!(parse(&body, &limits()).unwrap_err().code, "invalid_request");
        assert_eq!(
            parse(b"MRR1\xff\xff\xff\xff", &limits()).unwrap_err().code,
            "invalid_request"
        );
        let body = encode(
            &json!({"kind": "svg", "account": "a", "ids": ["n"], "measure": "table"}),
            "{}",
            &[],
        );
        assert_eq!(parse(&body, &limits()).unwrap_err().code, "invalid_request");
    }
}
