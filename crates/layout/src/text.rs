//! Text measuring for the store-node stages: `layoutText` and `textBoxSize` of `shared/design/text-layout.ts` over
//! the store's [`TextProps`]. Layouts are cached by the text itself: the shared text's
//! pointer first (an instance's copies share their main's `Arc<TextProps>`, as TypeScript's copies share the main's
//! text object, so a component's text is laid out once for all of them), then by content; a hit is confirmed by
//! comparing the texts.

use std::sync::Arc;

use morfa_model::draft::{FontSpec as ModelFont, TextMeasurer as ModelMeasurer};
use morfa_model::store::{Node, Resolver, TextProps};
use morfa_model::types::{self as m, TextAutoResize};
use morfa_text::layout::compute_layout_metrics;
use morfa_text::measure::{MeasureCache, Measurer, Metrics};
use morfa_text::types as t;
use rustc_hash::FxHashMap;

/// What the layout stages read of a text layout.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextMetrics {
    pub natural_width: f64,
    pub height: f64,
    /// The first line's baseline from the top.
    pub baseline: Option<f64>,
}

/// `Math.ceil(value * 100 - 1e-6) / 100 || 0`: sizes in hundredths of a pixel, rounded up.
#[inline]
pub fn round_up(value: f64) -> f64 {
    let rounded = (value * 100.0 - 1e-6).ceil() / 100.0;
    if rounded == 0.0 || rounded.is_nan() {
        0.0
    } else {
        rounded
    }
}

/// What `layoutText` reads of a node: its text, box height (for NONE and TRUNCATE) and whether it runs along a path.
#[derive(Clone, Copy)]
pub struct TextNode<'a> {
    pub text: &'a Arc<TextProps>,
    /// `text.textAutoResize` as the layout should see it (layout.ts lays a text out in the mode `textSizing` gives
    /// it, before writing that mode).
    pub mode: TextAutoResize,
    pub width: f64,
    pub height: f64,
    pub on_path: bool,
}

impl<'a> TextNode<'a> {
    pub fn of(node: &'a Node) -> Option<Self> {
        let text = node.props.text()?;
        Some(Self {
            text,
            mode: text.text_auto_resize,
            width: node.width,
            height: node.height,
            on_path: node.props.text_path().is_some(),
        })
    }
}

struct Cached {
    /// Held: while it is, the pointer names this text and no other.
    text: Arc<TextProps>,
    mode: TextAutoResize,
    width: Option<u64>,
    height: u64,
    on_path: bool,
    metrics: TextMetrics,
}

/// Layouts already computed, kept between stage runs (see the module documentation), and the measurer's width cache.
/// A cache serves one measurer: given another, it starts over.
#[derive(Default)]
pub struct TextCache {
    measure: MeasureCache,
    /// By the text's content key.
    layouts: FxHashMap<u64, Vec<Cached>>,
    /// The content key of a text already in `layouts`, by its pointer: the fast path.
    keys: FxHashMap<usize, u64>,
    entries: usize,
    measurer: usize,
}

/// Layouts kept per text key (widths a text is measured at, and texts that share a key) and in all, before starting
/// over.
const PER_KEY: usize = 12;
const IN_ALL: usize = 20_000;

/// The cache's key of a text: what tells texts apart cheaply (equal texts always share it).
fn text_key(text: &TextProps) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = rustc_hash::FxHasher::default();
    text.characters.hash(&mut hasher);
    text.style.font_family.hash(&mut hasher);
    text.style.font_size.to_bits().hash(&mut hasher);
    text.style.font_weight.to_bits().hash(&mut hasher);
    text.runs.len().hash(&mut hasher);
    hasher.finish()
}

#[inline]
fn ptr(text: &Arc<TextProps>) -> usize {
    Arc::as_ptr(text) as usize
}

impl TextCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drops every layout and width (fonts changed: text-layout.ts `forgetMeasurements`).
    pub fn clear(&mut self) {
        self.measure.clear();
        self.layouts.clear();
        self.keys.clear();
        self.entries = 0;
    }
}

/// The stages' measurer with its caches.
pub struct TextMeasure<'a> {
    measurer: Adapter<'a>,
    cache: CacheRef<'a>,
}

enum CacheRef<'a> {
    Owned(Box<TextCache>),
    Borrowed(&'a mut TextCache),
}

impl CacheRef<'_> {
    fn get(&mut self) -> &mut TextCache {
        match self {
            CacheRef::Owned(cache) => cache,
            CacheRef::Borrowed(cache) => cache,
        }
    }
}

struct Adapter<'a>(&'a dyn ModelMeasurer);

impl Measurer for Adapter<'_> {
    fn width(&mut self, text: &[u16], font: &t::FontSpec) -> f64 {
        let text = String::from_utf16_lossy(text);
        self.0.width(&text, &spec(font))
    }

    fn metrics(&mut self, font: &t::FontSpec) -> Metrics {
        let metrics = self.0.metrics(&spec(font));
        Metrics {
            ascent: metrics.ascent,
            descent: metrics.descent,
        }
    }
}

fn spec(font: &t::FontSpec) -> ModelFont<'_> {
    ModelFont {
        family: &font.family,
        weight: font.weight,
        italic: font.italic,
        size: font.size,
    }
}

#[inline]
fn bits(value: f64) -> u64 {
    if value == 0.0 { 0 } else { value.to_bits() }
}

impl<'a> TextMeasure<'a> {
    /// A measurer with caches of its own (one call's worth).
    pub fn new(measurer: &'a dyn ModelMeasurer) -> Self {
        Self {
            measurer: Adapter(measurer),
            cache: CacheRef::Owned(Box::default()),
        }
    }

    /// A measurer over a cache kept between calls (a stage's).
    pub fn with_cache(measurer: &'a dyn ModelMeasurer, cache: &'a mut TextCache) -> Self {
        let key = measurer as *const dyn ModelMeasurer as *const () as usize;
        if cache.measurer != key {
            cache.clear();
            cache.measurer = key;
        }
        Self {
            measurer: Adapter(measurer),
            cache: CacheRef::Borrowed(cache),
        }
    }

    /// `layoutText(node, measurer, width)`: `width` `None` lays the text out unconstrained. `atoms` resolves the
    /// text's font families.
    pub fn layout(
        &mut self,
        atoms: &dyn Resolver,
        node: TextNode<'_>,
        width: Option<f64>,
    ) -> TextMetrics {
        let width = if node.on_path { None } else { width };
        let fixed_height =
            !node.on_path && matches!(node.mode, TextAutoResize::None | TextAutoResize::Truncate);
        let height = if fixed_height { node.height } else { 0.0 };
        let (width_key, height_key) = (width.map(bits), bits(height));
        let cache = self.cache.get();
        let pointer = ptr(node.text);
        let (key, known) = match cache.keys.get(&pointer) {
            Some(&key) => (key, true),
            None => (text_key(node.text), false),
        };
        if let Some(list) = cache.layouts.get(&key)
            && let Some(hit) = list.iter().find(|entry| {
                entry.mode == node.mode
                    && entry.width == width_key
                    && entry.height == height_key
                    && entry.on_path == node.on_path
                    && (Arc::ptr_eq(&entry.text, node.text) || *entry.text == **node.text)
            })
        {
            if !known {
                cache.keys.insert(pointer, key);
            }
            return hit.metrics;
        }
        let chars: Vec<u16> = node.text.characters.encode_utf16().collect();
        let request = t::LayoutRequest {
            text: convert(atoms, node.text, node.mode),
            width,
            height,
            on_path: node.on_path,
        };
        let layout =
            compute_layout_metrics(&chars, &request, &mut cache.measure, &mut self.measurer);
        let metrics = TextMetrics {
            natural_width: layout.natural_width,
            height: layout.height,
            baseline: layout.lines.first().map(|line| line.baseline),
        };
        if cache.entries >= IN_ALL {
            cache.layouts.clear();
            cache.keys.clear();
            cache.entries = 0;
        }
        let list = cache.layouts.entry(key).or_default();
        if list.len() >= PER_KEY {
            let gone = list.remove(0);
            cache.entries -= 1;
            if !list
                .iter()
                .any(|entry| Arc::ptr_eq(&entry.text, &gone.text))
            {
                cache.keys.remove(&ptr(&gone.text));
            }
        }
        // Equal texts under one key share one Arc (the first seen), so the list holds few pointers.
        let text = match list
            .iter()
            .find(|entry| Arc::ptr_eq(&entry.text, node.text) || *entry.text == **node.text)
        {
            Some(entry) => Arc::clone(&entry.text),
            None => Arc::clone(node.text),
        };
        cache.keys.insert(pointer, key);
        list.push(Cached {
            text,
            mode: node.mode,
            width: width_key,
            height: height_key,
            on_path: node.on_path,
            metrics,
        });
        cache.entries += 1;
        metrics
    }

    /// `textBoxSize`: the size the node takes under its auto-resize mode.
    pub fn box_size(&mut self, atoms: &dyn Resolver, node: TextNode<'_>) -> (f64, f64) {
        match node.mode {
            TextAutoResize::WidthAndHeight if !node.on_path => {
                let layout = self.layout(atoms, node, None);
                (round_up(layout.natural_width), round_up(layout.height))
            }
            TextAutoResize::Height if !node.on_path => {
                let layout = self.layout(atoms, node, Some(node.width));
                (node.width, round_up(layout.height))
            }
            _ => (node.width, node.height),
        }
    }
}

fn line_height(value: morfa_model::store::LineHeight) -> t::LineHeight {
    use morfa_model::store::LineHeight as L;
    match value {
        L::Auto => t::LineHeight::Auto,
        L::Pixels(value) => t::LineHeight::Pixels { value },
        L::Percent(value) => t::LineHeight::Percent { value },
    }
}

fn letter_spacing(value: m::LetterSpacing) -> t::LetterSpacing {
    match value.unit {
        m::LetterSpacingUnit::Pixels => t::LetterSpacing::Pixels { value: value.value },
        m::LetterSpacingUnit::Percent => t::LetterSpacing::Percent { value: value.value },
    }
}

fn text_case(value: m::TextCase) -> t::TextCase {
    match value {
        m::TextCase::Original => t::TextCase::Original,
        m::TextCase::Upper => t::TextCase::Upper,
        m::TextCase::Lower => t::TextCase::Lower,
        m::TextCase::Title => t::TextCase::Title,
        m::TextCase::SmallCaps => t::TextCase::SmallCaps,
    }
}

/// The request's text (text-layout.ts `wasmLayout` serializes the same fields).
fn convert(atoms: &dyn Resolver, text: &TextProps, mode: TextAutoResize) -> t::TextProps {
    let style = &text.style;
    t::TextProps {
        style: t::TextStyle {
            font_family: atoms.atom(style.font_family).to_owned(),
            font_weight: style.font_weight,
            italic: style.italic,
            font_size: style.font_size,
            line_height: line_height(style.line_height),
            letter_spacing: Some(letter_spacing(style.letter_spacing)),
            text_case: Some(text_case(style.text_case)),
        },
        runs: text
            .runs
            .iter()
            .map(|run| t::TextRun {
                start: run.start,
                end: run.end,
                style: Some(t::PartialStyle {
                    font_family: run
                        .style
                        .font_family
                        .map(|family| atoms.atom(family).to_owned()),
                    font_weight: run.style.font_weight,
                    italic: run.style.italic,
                    font_size: run.style.font_size,
                    line_height: run.style.line_height.map(line_height),
                    letter_spacing: run.style.letter_spacing.map(letter_spacing),
                    text_case: run.style.text_case.map(text_case),
                }),
                has_fills: run.fills.is_some(),
            })
            .collect(),
        text_align_horizontal: match text.text_align_horizontal {
            m::TextAlignHorizontal::Left => t::HorizontalAlign::Left,
            m::TextAlignHorizontal::Center => t::HorizontalAlign::Center,
            m::TextAlignHorizontal::Right => t::HorizontalAlign::Right,
            m::TextAlignHorizontal::Justified => t::HorizontalAlign::Justified,
        },
        text_align_vertical: match text.text_align_vertical {
            m::TextAlignVertical::Top => t::VerticalAlign::Top,
            m::TextAlignVertical::Center => t::VerticalAlign::Center,
            m::TextAlignVertical::Bottom => t::VerticalAlign::Bottom,
        },
        text_auto_resize: match mode {
            TextAutoResize::None => t::AutoResize::None,
            TextAutoResize::WidthAndHeight => t::AutoResize::WidthAndHeight,
            TextAutoResize::Height => t::AutoResize::Height,
            TextAutoResize::Truncate => t::AutoResize::Truncate,
        },
        paragraph_spacing: Some(text.paragraph_spacing),
        paragraph_indent: Some(text.paragraph_indent),
        list_types: text.list_types.as_ref().map(|types| {
            types
                .iter()
                .map(|kind| match kind {
                    m::ListType::None => t::ListType::None,
                    m::ListType::Ordered => t::ListType::Ordered,
                    m::ListType::Unordered => t::ListType::Unordered,
                })
                .collect()
        }),
        max_lines: text.max_lines.flatten(),
    }
}
