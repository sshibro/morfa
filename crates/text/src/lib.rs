//! `morfa-text`: text shaping, layout, carets and glyph outlines.
//!
//! The layout (`layout`), segmentation (`segment`) and caret geometry (`caret`) are exact twins of
//! `shared/design/text-layout.ts` and `text-segment.ts`: given the same `Measurer` they produce the same
//! numbers, which the TypeScript tests prove under `MORFA_ENGINE_TEXT=wasm`. Measuring with real fonts is
//! `font` + `shape` (harfrust on the self-hosted faces, `docs/decisions/text-shaper.md`); glyph outlines
//! for the renderer come from `glyph`.

pub mod caret;
pub mod encode;
#[cfg(feature = "fonts")]
pub mod font;
#[cfg(feature = "fonts")]
pub mod glyph;
pub mod layout;
pub mod measure;
pub mod request;
pub mod segment;
#[cfg(feature = "fonts")]
pub mod shape;
pub mod types;

/// This crate's name, as the gate's smoke test reads it.
pub const CRATE: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    use super::measure::{FixedMeasurer, MeasureCache};
    use super::types::*;

    #[test]
    fn names_itself() {
        assert_eq!(super::CRATE, "morfa-text");
    }

    fn style(size: f64) -> TextStyle {
        TextStyle {
            font_family: "Inter".into(),
            font_weight: 400.0,
            italic: false,
            font_size: size,
            line_height: LineHeight::Auto,
            letter_spacing: Some(LetterSpacing::Pixels { value: 0.0 }),
            text_case: Some(TextCase::Original),
        }
    }

    fn request(text: &str, width: Option<f64>, resize: AutoResize) -> (Vec<u16>, LayoutRequest) {
        let props = TextProps {
            style: style(16.0),
            runs: vec![],
            text_align_horizontal: HorizontalAlign::Left,
            text_align_vertical: VerticalAlign::Top,
            text_auto_resize: resize,
            paragraph_spacing: Some(0.0),
            paragraph_indent: Some(0.0),
            list_types: None,
            max_lines: None,
        };
        (
            text.encode_utf16().collect(),
            LayoutRequest {
                text: props,
                width,
                height: 0.0,
                on_path: false,
            },
        )
    }

    #[test]
    fn wraps_greedily_with_the_fixed_measurer() {
        // 8 px per code unit at 16 px: "Съешь же ещё" is 12 units = 96 px; a 70 px box breaks after the space.
        let (chars, req) = request("Съешь же ещё", Some(70.0), AutoResize::Height);
        let mut cache = MeasureCache::new();
        let layout = super::layout::compute_layout(&chars, &req, &mut cache, &mut FixedMeasurer);
        assert_eq!(layout.lines.len(), 2);
        assert_eq!(
            String::from_utf16_lossy(&layout.lines[0].runs[0].text),
            "Съешь же "
        );
        assert_eq!(layout.lines[0].width, 64.0, "hanging space is not ink");
        assert_eq!(layout.lines[1].start, 9);
        assert_eq!(layout.height, 32.0, "ascent 0.8 + descent 0.2 em per line");
        assert!(layout.lines[0].wrapped);
        assert_eq!(layout.lines[0].baseline, 12.8);
    }

    #[test]
    fn unconstrained_layout_has_natural_width() {
        let (chars, req) = request("abc\n\nde", None, AutoResize::WidthAndHeight);
        let mut cache = MeasureCache::new();
        let layout = super::layout::compute_layout(&chars, &req, &mut cache, &mut FixedMeasurer);
        assert_eq!(layout.lines.len(), 3);
        assert_eq!(layout.natural_width, 24.0);
        assert_eq!(layout.width, 24.0);
        assert_eq!(
            layout.lines[1].height, 16.0,
            "an empty line keeps the style's height"
        );
        assert_eq!(layout.lines[2].start, 5);
    }
}

#[cfg(test)]
mod timing {
    use super::measure::{FixedMeasurer, MeasureCache};
    use super::types::*;

    /// `cargo test -p morfa-text timing -- --ignored --nocapture`: the layout's own cost, no boundary.
    #[test]
    #[ignore]
    fn layout_cost() {
        let style = TextStyle {
            font_family: "Inter".into(),
            font_weight: 400.0,
            italic: false,
            font_size: 16.0,
            line_height: LineHeight::Auto,
            letter_spacing: Some(LetterSpacing::Pixels { value: 0.0 }),
            text_case: Some(TextCase::Original),
        };
        let props = TextProps {
            style,
            runs: vec![],
            text_align_horizontal: HorizontalAlign::Left,
            text_align_vertical: VerticalAlign::Top,
            text_auto_resize: AutoResize::Height,
            paragraph_spacing: Some(0.0),
            paragraph_indent: Some(0.0),
            list_types: None,
            max_lines: None,
        };
        let json = serde_json::to_string(&serde_json::json!({"text": {"style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "AUTO"}, "letterSpacing": {"unit": "PIXELS", "value": 0}, "textCase": "ORIGINAL"}, "runs": [], "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": "HEIGHT", "paragraphSpacing": 0, "paragraphIndent": 0}, "width": 100, "height": 0, "onPath": false})).unwrap();
        for (label, text) in [
            ("short", "Текст"),
            ("words", "Кнопка Заголовок карточки №7"),
            (
                "long",
                &"Кнопка Заголовок карточки Подробнее цена ".repeat(50),
            ),
        ] {
            let chars: Vec<u16> = text.encode_utf16().collect();
            let mut cache = MeasureCache::new();
            let request = LayoutRequest {
                text: props.clone(),
                width: Some(100.0),
                height: 0.0,
                on_path: false,
            };
            let n = 20_000;
            let start = std::time::Instant::now();
            for _ in 0..n {
                let layout =
                    super::layout::compute_layout(&chars, &request, &mut cache, &mut FixedMeasurer);
                std::hint::black_box(layout);
            }
            let compute = start.elapsed().as_nanos() as f64 / n as f64;
            let start = std::time::Instant::now();
            for _ in 0..n {
                let parsed: LayoutRequest = serde_json::from_str(&json).unwrap();
                std::hint::black_box(parsed);
            }
            let parse = start.elapsed().as_nanos() as f64 / n as f64;
            let layout =
                super::layout::compute_layout(&chars, &request, &mut cache, &mut FixedMeasurer);
            let start = std::time::Instant::now();
            for _ in 0..n {
                std::hint::black_box(super::encode::encode_layout(
                    1,
                    &layout,
                    &layout.slot_styles,
                ));
            }
            let encode = start.elapsed().as_nanos() as f64 / n as f64;
            println!(
                "{label}: compute {compute:.0} ns, request parse {parse:.0} ns, encode {encode:.0} ns ({} lines)",
                layout.lines.len()
            );
        }
    }
}
