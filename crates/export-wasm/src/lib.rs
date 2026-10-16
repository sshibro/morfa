//! `morfa-export-wasm`: the export behind the engine switch's module `export` (shared/design/export-wasm.ts).
//! A module of its own (export is rarely used): Node requires it on first use, the browser
//! loads it when something is exported.
//!
//! A document crosses once per handle ([`ExportDoc`]): as JSON, or as the shadow document's S1 frame (`MorfaDoc.encode`).
//! Text is measured by the caller's measurer (a JavaScript object with `width(text, font)` and `metrics(font)`, called
//! exactly as text-layout.ts calls it), or natively by the fixed-width test measurer when the caller passes `null`.
//! Pictures come from a JavaScript object with `data(ref)` and `href(ref)` (either may be missing).

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Function, JsString, Object, Reflect};
use morfa_export::svg::{Pictures, SvgOptions, SvgPage, Unsupported, export_svg_page_checked};
use morfa_geometry::matrix::Rect;
use morfa_model::DesignDocument;
use morfa_text::measure::{FixedMeasurer, Measurer, Metrics};
use morfa_text::types::FontSpec;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn date_now() -> f64;
}

thread_local! {
    static LAST_PANIC: RefCell<String> = const { RefCell::new(String::new()) };
    #[cfg(feature = "fonts")]
    static FONTS: RefCell<morfa_export::fonts::Fonts> = RefCell::new(morfa_export::fonts::Fonts::new());
}

/// Registers a face file (sfnt or woff2) for outline text and the PDF under its CSS descriptors (`@font-face`);
/// returns its id, or -1 when the bytes are not a font or the module has no fonts.
#[wasm_bindgen(js_name = addFace)]
pub fn add_face(
    family: &str,
    weight_min: f64,
    weight_max: f64,
    italic: bool,
    unicode_range: &str,
    bytes: &[u8],
) -> i32 {
    #[cfg(feature = "fonts")]
    return FONTS.with(|f| {
        f.borrow_mut()
            .add_face(family, weight_min, weight_max, italic, unicode_range, bytes)
            .map_or(-1, |id| id as i32)
    });
    #[cfg(not(feature = "fonts"))]
    {
        let _ = (family, weight_min, weight_max, italic, unicode_range, bytes);
        -1
    }
}

/// Whether some face of `family` is registered.
#[wasm_bindgen(js_name = hasFamily)]
pub fn has_family(family: &str) -> bool {
    #[cfg(feature = "fonts")]
    return FONTS.with(|f| f.borrow().has_family(family));
    #[cfg(not(feature = "fonts"))]
    {
        let _ = family;
        false
    }
}

/// Installs `Date.now` as the boolean time budget's clock and keeps panic messages for `lastPanic`.
#[wasm_bindgen(js_name = installClock)]
pub fn install_clock() {
    morfa_geometry::boolean::set_clock(date_now);
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        LAST_PANIC.with(|p| *p.borrow_mut() = message);
    }));
}

#[wasm_bindgen(js_name = lastPanic)]
pub fn last_panic() -> String {
    LAST_PANIC.with(|p| p.borrow().clone())
}

#[wasm_bindgen(js_name = exportVersion)]
pub fn export_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Whether the module was built with fonts (outline text, PDF font subsets).
#[wasm_bindgen(js_name = hasFonts)]
pub fn has_fonts() -> bool {
    cfg!(feature = "fonts")
}

fn unsupported(message: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("unsupported: {message}"))
}

/// A document held for export.
#[wasm_bindgen]
pub struct ExportDoc {
    doc: DesignDocument,
}

#[wasm_bindgen]
impl ExportDoc {
    /// From the document's JSON (TypeScript's `JSON.stringify(doc)`). A document the model refuses throws
    /// `unsupported: …` (the adapter falls back to TypeScript, counted).
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<ExportDoc, JsError> {
        let doc = morfa_model::from_json(json).map_err(|e| unsupported(format!("model: {e}")))?;
        Ok(ExportDoc { doc })
    }

    /// From the shadow document's frame (`MorfaDoc.encode()`, S1's codec).
    #[wasm_bindgen(js_name = fromFrame)]
    pub fn from_frame(bytes: &[u8]) -> Result<ExportDoc, JsError> {
        let store =
            morfa_model::codec::decode(bytes).map_err(|e| unsupported(format!("frame: {e}")))?;
        Ok(ExportDoc {
            doc: store.to_model(),
        })
    }

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> usize {
        self.doc.nodes.len()
    }

    /// `exportSvgPage(doc, ids, options)`: `{svg, bounds: [x, y, width, height]}`. `options` is JSON
    /// (`{precision?, idPrefix?, layerIds?, print?, crop?: {x, y, width, height}}`).
    pub fn svg(
        &self,
        ids: Vec<String>,
        options: &str,
        measurer: JsValue,
        pictures: JsValue,
    ) -> Result<JsValue, JsError> {
        let options = read_options(options)?;
        let mut pictures = JsPictures::new(pictures);
        let page = if measurer.is_null() || measurer.is_undefined() {
            run_svg(&self.doc, &ids, &options, &mut FixedMeasurer, &mut pictures)
        } else {
            let mut measurer = JsMeasurer::new(measurer)?;
            let page = run_svg(&self.doc, &ids, &options, &mut measurer, &mut pictures);
            if let Some(error) = measurer.error.take() {
                return Err(error);
            }
            page
        }
        .map_err(|Unsupported(why)| unsupported(why))?;
        let out = Object::new();
        Reflect::set(&out, &"svg".into(), &page.svg.into()).map_err(js)?;
        let b = page.bounds;
        let bounds = js_sys::Float64Array::from(&[b.x, b.y, b.width, b.height][..]);
        Reflect::set(&out, &"bounds".into(), &bounds).map_err(js)?;
        Ok(out.into())
    }
}

/// The caller's picture bytes by URL (`bytes(href) → Uint8Array | undefined`).
#[cfg(feature = "pdf")]
struct JsBytes(Option<Function>);

#[cfg(feature = "pdf")]
impl morfa_export::pdf::PdfPictures for JsBytes {
    fn bytes(&mut self, href: &str) -> Option<Vec<u8>> {
        let value = self.0.as_ref()?.call1(&JsValue::NULL, &href.into()).ok()?;
        if value.is_undefined() || value.is_null() {
            return None;
        }
        Some(js_sys::Uint8Array::new(&value).to_vec())
    }
}

#[cfg(feature = "pdf")]
#[wasm_bindgen]
impl ExportDoc {
    /// The vector PDF of `pages` (JSON `[{ids, crop?}]`, pdfPagePlan's plans in order): `{pdf: Uint8Array, stats}`.
    /// `measurer`: a TextMeasurer (the editor's replayed widths), `null` for the fixed-width fake, or the string
    /// `"fonts"` for the module's own fonts. `pictures` as for `svg`; `bytes(href)` gives a picture's bytes.
    pub fn pdf(
        &self,
        pages: &str,
        title: &str,
        measurer: JsValue,
        pictures: JsValue,
        bytes: JsValue,
    ) -> Result<JsValue, JsError> {
        use morfa_export::pdf::{Measure, PdfPage, write_pdf};
        let value: serde_json::Value =
            serde_json::from_str(pages).map_err(|e| JsError::new(&format!("pages: {e}")))?;
        let plans: Vec<PdfPage> = value
            .as_array()
            .ok_or_else(|| JsError::new("pages: not an array"))?
            .iter()
            .map(|p| PdfPage {
                ids: p
                    .get("ids")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| s.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                crop: p.get("crop").and_then(|c| {
                    Some(Rect::new(
                        c.get("x")?.as_f64()?,
                        c.get("y")?.as_f64()?,
                        c.get("width")?.as_f64()?,
                        c.get("height")?.as_f64()?,
                    ))
                }),
            })
            .collect();
        let mut pictures = JsPictures::new(pictures);
        let mut bytes = JsBytes(bytes.dyn_into::<Function>().ok());
        let (pdf, stats) = if measurer.as_string().as_deref() == Some("fonts") {
            FONTS.with(|f| {
                write_pdf(
                    &self.doc,
                    &plans,
                    title,
                    Measure::Fonts,
                    &mut pictures,
                    &mut bytes,
                    &mut f.borrow_mut(),
                )
            })
        } else if measurer.is_null() || measurer.is_undefined() {
            FONTS.with(|f| {
                write_pdf(
                    &self.doc,
                    &plans,
                    title,
                    Measure::With(&mut FixedMeasurer),
                    &mut pictures,
                    &mut bytes,
                    &mut f.borrow_mut(),
                )
            })
        } else {
            let mut js_measurer = JsMeasurer::new(measurer)?;
            let out = FONTS.with(|f| {
                write_pdf(
                    &self.doc,
                    &plans,
                    title,
                    Measure::With(&mut js_measurer),
                    &mut pictures,
                    &mut bytes,
                    &mut f.borrow_mut(),
                )
            });
            if let Some(error) = js_measurer.error.take() {
                return Err(error);
            }
            out
        };
        let out = Object::new();
        Reflect::set(&out, &"pdf".into(), &js_sys::Uint8Array::from(&pdf[..])).map_err(js)?;
        let s = Object::new();
        let set = |key: &str, v: f64| Reflect::set(&s, &key.into(), &v.into());
        set("pages", stats.pages as f64).map_err(js)?;
        set("shapes", stats.shapes as f64).map_err(js)?;
        set("textSpans", stats.text_spans as f64).map_err(js)?;
        set("images", stats.images as f64).map_err(js)?;
        set("rasters", stats.rasters as f64).map_err(js)?;
        set("rasterPixels", stats.raster_pixels as f64).map_err(js)?;
        let missing = js_sys::Array::new();
        for family in &stats.missing_families {
            missing.push(&family.as_str().into());
        }
        Reflect::set(&s, &"missingFamilies".into(), &missing).map_err(js)?;
        let sizes = js_sys::Array::new();
        for (w, h) in &stats.sizes {
            sizes.push(&js_sys::Float64Array::from(&[*w, *h][..]));
        }
        Reflect::set(&s, &"sizes".into(), &sizes).map_err(js)?;
        Reflect::set(&out, &"stats".into(), &s).map_err(js)?;
        Ok(out.into())
    }
}

fn run_svg(
    doc: &DesignDocument,
    ids: &[String],
    options: &SvgOptions,
    measurer: &mut dyn Measurer,
    pictures: &mut dyn Pictures,
) -> Result<SvgPage, Unsupported> {
    #[cfg(feature = "fonts")]
    if options.outline_text {
        return FONTS.with(|f| {
            morfa_export::svg::export_svg_page_outlined(
                doc,
                ids,
                options,
                measurer,
                pictures,
                &mut f.borrow_mut(),
            )
        });
    }
    export_svg_page_checked(doc, ids, options, measurer, pictures)
}

fn js(error: JsValue) -> JsError {
    JsError::new(&format!("{error:?}"))
}

fn read_options(json: &str) -> Result<SvgOptions, JsError> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| JsError::new(&format!("options: {e}")))?;
    let number = |key: &str| value.get(key).and_then(serde_json::Value::as_f64);
    let crop = value.get("crop").and_then(|c| {
        Some(Rect::new(
            c.get("x")?.as_f64()?,
            c.get("y")?.as_f64()?,
            c.get("width")?.as_f64()?,
            c.get("height")?.as_f64()?,
        ))
    });
    Ok(SvgOptions {
        precision: number("precision").map(|p| p as i32),
        id_prefix: value
            .get("idPrefix")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        layer_ids: value
            .get("layerIds")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        print: value
            .get("print")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        crop,
        outline_text: value
            .get("outlineText")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

/// The caller's `TextMeasurer`. A throw inside it is kept and rethrown after the export (layout cannot fail).
struct JsMeasurer {
    target: JsValue,
    width: Function,
    metrics: Function,
    fonts: HashMap<(String, u64, bool, u64), JsValue>,
    error: Option<JsError>,
}

impl JsMeasurer {
    fn new(target: JsValue) -> Result<Self, JsError> {
        let get = |name: &str| -> Result<Function, JsError> {
            Reflect::get(&target, &name.into())
                .map_err(js)?
                .dyn_into::<Function>()
                .map_err(|_| JsError::new(&format!("measurer.{name} is not a function")))
        };
        Ok(JsMeasurer {
            width: get("width")?,
            metrics: get("metrics")?,
            target,
            fonts: HashMap::new(),
            error: None,
        })
    }

    fn font(&mut self, font: &FontSpec) -> JsValue {
        let key = (
            font.family.clone(),
            font.weight.to_bits(),
            font.italic,
            font.size.to_bits(),
        );
        self.fonts
            .entry(key)
            .or_insert_with(|| {
                let o = Object::new();
                let _ = Reflect::set(&o, &"family".into(), &font.family.as_str().into());
                let _ = Reflect::set(&o, &"weight".into(), &font.weight.into());
                let _ = Reflect::set(&o, &"italic".into(), &font.italic.into());
                let _ = Reflect::set(&o, &"size".into(), &font.size.into());
                o.into()
            })
            .clone()
    }

    fn keep(&mut self, error: JsValue) {
        if self.error.is_none() {
            self.error = Some(js(error));
        }
    }
}

impl Measurer for JsMeasurer {
    fn width(&mut self, text: &[u16], font: &FontSpec) -> f64 {
        let font = self.font(font);
        let text = JsString::from_char_code(text);
        match self.width.call2(&self.target, &text, &font) {
            Ok(v) => v.as_f64().unwrap_or(f64::NAN),
            Err(e) => {
                self.keep(e);
                0.0
            }
        }
    }

    fn metrics(&mut self, font: &FontSpec) -> Metrics {
        let font = self.font(font);
        match self.metrics.call1(&self.target, &font) {
            Ok(v) => {
                let read = |key: &str| {
                    Reflect::get(&v, &key.into())
                        .ok()
                        .and_then(|x| x.as_f64())
                        .unwrap_or(f64::NAN)
                };
                Metrics {
                    ascent: read("ascent"),
                    descent: read("descent"),
                }
            }
            Err(e) => {
                self.keep(e);
                Metrics {
                    ascent: 0.0,
                    descent: 0.0,
                }
            }
        }
    }
}

/// `imageData` / `imageHref` of the caller.
struct JsPictures {
    target: JsValue,
    data: Option<Function>,
    href: Option<Function>,
}

impl JsPictures {
    fn new(target: JsValue) -> Self {
        let get = |name: &str| {
            if target.is_null() || target.is_undefined() {
                return None;
            }
            Reflect::get(&target, &name.into())
                .ok()?
                .dyn_into::<Function>()
                .ok()
        };
        JsPictures {
            data: get("data"),
            href: get("href"),
            target,
        }
    }

    fn call(&self, f: &Option<Function>, image_ref: &str) -> Option<String> {
        f.as_ref()?
            .call1(&self.target, &image_ref.into())
            .ok()?
            .as_string()
    }
}

impl Pictures for JsPictures {
    fn data(&mut self, image_ref: &str) -> Option<String> {
        self.call(&self.data, image_ref)
    }
    fn href(&mut self, image_ref: &str) -> Option<String> {
        self.call(&self.href, image_ref)
    }
}
