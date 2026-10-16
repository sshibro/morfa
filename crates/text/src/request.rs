//! A `TextProps` as a flat `f64` stream, the twin of `encodeProps` in shared/design/text-layout.ts: no JSON,
//! no serde on the boundary, and a text object crosses once (`text_put`) however often it is laid out.
//!
//! Props: `[alignH, alignV, autoResize, paragraphSpacing|NaN, paragraphIndent|NaN, maxLines|NaN, listCount,
//! list…, style, runCount, run…]`. A full style: `[familyLen, family units…, weight, italic, size, lhUnit
//! (0 auto, 1 px, 2 %), lhValue, lsUnit (0 absent, 1 px, 2 %), lsValue, textCase (-1 absent, 0 ORIGINAL,
//! 1 UPPER, 2 LOWER, 3 TITLE, 4 SMALL_CAPS)]`. A run: `[start, end, hasFills, mask, fields present…]` in
//! the style's order, with mask bits 1 family, 2 weight, 4 italic, 8 size, 16 lineHeight, 32 letterSpacing,
//! 64 textCase.

use crate::types::{
    AutoResize, HorizontalAlign, LetterSpacing, LineHeight, ListType, PartialStyle, TextCase,
    TextProps, TextRun, TextStyle, VerticalAlign,
};

pub struct Reader<'a> {
    data: &'a [f64],
    pub at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [f64]) -> Self {
        Self { data, at: 0 }
    }
    fn next(&mut self) -> f64 {
        let v = self.data.get(self.at).copied().unwrap_or(f64::NAN);
        self.at += 1;
        v
    }
    fn count(&mut self) -> usize {
        let v = self.next();
        if v.is_finite() && v >= 0.0 {
            v as usize
        } else {
            0
        }
    }
    fn option(&mut self) -> Option<f64> {
        let v = self.next();
        if v.is_nan() { None } else { Some(v) }
    }
    fn string(&mut self) -> String {
        let len = self.count();
        let units: Vec<u16> = (0..len).map(|_| self.next() as u16).collect();
        String::from_utf16_lossy(&units)
    }
    fn line_height(&mut self) -> LineHeight {
        let unit = self.next();
        let value = self.next();
        match unit as i32 {
            1 => LineHeight::Pixels { value },
            2 => LineHeight::Percent { value },
            _ => LineHeight::Auto,
        }
    }
    fn letter_spacing(&mut self) -> Option<LetterSpacing> {
        let unit = self.next();
        let value = self.next();
        match unit as i32 {
            1 => Some(LetterSpacing::Pixels { value }),
            2 => Some(LetterSpacing::Percent { value }),
            _ => None,
        }
    }
    fn text_case(&mut self) -> Option<TextCase> {
        match self.next() as i32 {
            0 => Some(TextCase::Original),
            1 => Some(TextCase::Upper),
            2 => Some(TextCase::Lower),
            3 => Some(TextCase::Title),
            4 => Some(TextCase::SmallCaps),
            _ => None,
        }
    }
    fn style(&mut self) -> TextStyle {
        let font_family = self.string();
        let font_weight = self.next();
        let italic = self.next() == 1.0;
        let font_size = self.next();
        let line_height = self.line_height();
        let letter_spacing = self.letter_spacing();
        let text_case = self.text_case();
        TextStyle {
            font_family,
            font_weight,
            italic,
            font_size,
            line_height,
            letter_spacing,
            text_case,
        }
    }
    fn run(&mut self) -> TextRun {
        let start = self.next();
        let end = self.next();
        let has_fills = self.next() == 1.0;
        let mask = self.next() as u32;
        let mut style = PartialStyle::default();
        if mask & 1 != 0 {
            style.font_family = Some(self.string());
        }
        if mask & 2 != 0 {
            style.font_weight = Some(self.next());
        }
        if mask & 4 != 0 {
            style.italic = Some(self.next() == 1.0);
        }
        if mask & 8 != 0 {
            style.font_size = Some(self.next());
        }
        if mask & 16 != 0 {
            style.line_height = Some(self.line_height());
        }
        if mask & 32 != 0 {
            style.letter_spacing = self.letter_spacing();
        }
        if mask & 64 != 0 {
            style.text_case = self.text_case();
        }
        TextRun {
            start,
            end,
            style: Some(style),
            has_fills,
        }
    }

    pub fn props(&mut self) -> TextProps {
        let text_align_horizontal = match self.next() as i32 {
            1 => HorizontalAlign::Center,
            2 => HorizontalAlign::Right,
            3 => HorizontalAlign::Justified,
            _ => HorizontalAlign::Left,
        };
        let text_align_vertical = match self.next() as i32 {
            1 => VerticalAlign::Center,
            2 => VerticalAlign::Bottom,
            _ => VerticalAlign::Top,
        };
        let text_auto_resize = match self.next() as i32 {
            1 => AutoResize::WidthAndHeight,
            2 => AutoResize::Height,
            3 => AutoResize::Truncate,
            _ => AutoResize::None,
        };
        let paragraph_spacing = self.option();
        let paragraph_indent = self.option();
        let max_lines = self.option();
        let list_count = self.count();
        let list_types: Vec<ListType> = (0..list_count)
            .map(|_| match self.next() as i32 {
                1 => ListType::Ordered,
                2 => ListType::Unordered,
                _ => ListType::None,
            })
            .collect();
        let style = self.style();
        let run_count = self.count();
        let runs = (0..run_count).map(|_| self.run()).collect();
        TextProps {
            style,
            runs,
            text_align_horizontal,
            text_align_vertical,
            text_auto_resize,
            paragraph_spacing,
            paragraph_indent,
            list_types: if list_count > 0 {
                Some(list_types)
            } else {
                None
            },
            max_lines,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_props_stream() {
        // LEFT TOP HEIGHT, spacing 4, no indent, no maxLines, two list types, Inter 400 16 AUTO px 0 ORIGINAL, one run.
        let mut stream = vec![0.0, 0.0, 2.0, 4.0, f64::NAN, f64::NAN, 2.0, 1.0, 2.0];
        stream.push(5.0);
        stream.extend("Inter".encode_utf16().map(|u| u as f64));
        stream.extend([400.0, 0.0, 16.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        stream.push(1.0);
        stream.extend([2.0, 9.0, 1.0, (8 | 4) as f64, 1.0, 24.0]);
        let props = Reader::new(&stream).props();
        assert_eq!(props.text_auto_resize, AutoResize::Height);
        assert_eq!(props.paragraph_spacing, Some(4.0));
        assert_eq!(props.paragraph_indent, None);
        assert_eq!(
            props.list_types,
            Some(vec![ListType::Ordered, ListType::Unordered])
        );
        assert_eq!(props.style.font_family, "Inter");
        assert_eq!(
            props.style.letter_spacing,
            Some(LetterSpacing::Pixels { value: 0.0 })
        );
        let run = &props.runs[0];
        assert!(run.has_fills);
        let style = run.style.as_ref().unwrap();
        assert_eq!(
            (style.italic, style.font_size, style.font_weight),
            (Some(true), Some(24.0), None)
        );
    }
}
