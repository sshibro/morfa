//! pdf-export.ts `replayMeasurements`: the editor's recorded widths and metrics answered as it measured them; a
//! question the table does not hold is counted (`misses`, the api's `X-Design-Pdf-Unmeasured`) and answered with
//! the TypeScript's own fallbacks.

use std::collections::HashMap;

use morfa_text::measure::{Measurer, Metrics};
use morfa_text::types::FontSpec;

use crate::request::MeasurementsIn;

type Key = (String, u64, bool, u64);

/// `${number}` makes -0 and 0 the same key.
fn bits(value: f64) -> u64 {
    (value + 0.0).to_bits()
}

fn key(family: &str, weight: f64, italic: bool, size: f64) -> Key {
    (family.to_owned(), bits(weight), italic, bits(size))
}

pub struct ReplayMeasurer {
    metrics: HashMap<Key, Option<(f64, f64)>>,
    widths: HashMap<Key, HashMap<Vec<u16>, f64>>,
    pub misses: u64,
}

impl ReplayMeasurer {
    pub fn new(table: &MeasurementsIn) -> ReplayMeasurer {
        let mut metrics = HashMap::new();
        let mut widths: HashMap<Key, HashMap<Vec<u16>, f64>> = HashMap::new();
        let mut keys = Vec::with_capacity(table.fonts.len());
        for (family, weight, italic, size, ascent, descent) in &table.fonts {
            let k = key(family, *weight, *italic == 1, *size);
            metrics.insert(
                k.clone(),
                match (ascent, descent) {
                    (Some(a), Some(d)) => Some((*a, *d)),
                    _ => None,
                },
            );
            widths.insert(k.clone(), HashMap::new());
            keys.push(k);
        }
        for (at, text, width) in &table.widths {
            if let Some(map) = keys.get(*at).and_then(|k| widths.get_mut(k)) {
                map.insert(text.encode_utf16().collect(), *width);
            }
        }
        ReplayMeasurer {
            metrics,
            widths,
            misses: 0,
        }
    }

    fn key_of(font: &FontSpec) -> Key {
        key(&font.family, font.weight, font.italic, font.size)
    }
}

impl Measurer for ReplayMeasurer {
    fn width(&mut self, text: &[u16], font: &FontSpec) -> f64 {
        if text.is_empty() {
            return 0.0;
        }
        if let Some(width) = self
            .widths
            .get(&Self::key_of(font))
            .and_then(|m| m.get(text))
        {
            return *width;
        }
        self.misses += 1;
        // About an average Latin/Cyrillic advance: the text is still drawn, its lines may break elsewhere.
        let points = char::decode_utf16(text.iter().copied()).count() as f64;
        points * font.size * 0.55
    }

    fn metrics(&mut self, font: &FontSpec) -> Metrics {
        if let Some(Some((ascent, descent))) = self.metrics.get(&Self::key_of(font)) {
            return Metrics {
                ascent: *ascent,
                descent: *descent,
            };
        }
        self.misses += 1;
        // Zero tells text layout to use its own fallback metrics.
        Metrics {
            ascent: 0.0,
            descent: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_and_counts() {
        let table = MeasurementsIn {
            fonts: vec![("Inter".into(), 400.0, 0, 16.0, Some(15.0), Some(4.0))],
            widths: vec![(0, "Привет".into(), 52.5)],
        };
        let mut m = ReplayMeasurer::new(&table);
        let font = FontSpec {
            family: "Inter".into(),
            weight: 400.0,
            italic: false,
            size: 16.0,
        };
        let text: Vec<u16> = "Привет".encode_utf16().collect();
        assert_eq!(m.width(&text, &font), 52.5);
        assert_eq!(m.metrics(&font).ascent, 15.0);
        assert_eq!(m.misses, 0);
        let other: Vec<u16> = "😀a".encode_utf16().collect();
        assert_eq!(m.width(&other, &font), 2.0 * 16.0 * 0.55);
        assert_eq!(m.misses, 1);
    }
}
