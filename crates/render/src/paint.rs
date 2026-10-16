//! Paints → brushes: `src/design/engine/render/{paints,gradient-math,image-math}.ts`. Linear, radial and angular
//! gradients map exactly through the handles' frame (gradient space → local), diamond gradients are the four
//! quadrants of linear gradients the shader draws; pictures place as `imagePlacement` does, from their mips.

use crate::sink::Picture;
use kurbo::{Affine, Point, Vec2};
use morfa_model::store::ImageFilters;
use morfa_model::store::{GradientKind, GradientPaint, ImagePaint, Paint};
use morfa_model::{ColorStop, ImageScaleMode, Matrix, Rgb, Rgba};
use peniko::color::{AlphaColor, DynamicColor, Srgb};
use peniko::{Color, Extend, Gradient};

pub fn color(c: &Rgb, alpha: f64) -> Color {
    AlphaColor::<Srgb>::new([c.r as f32, c.g as f32, c.b as f32, alpha as f32])
}

pub fn color_rgba(c: &Rgba, alpha: f64) -> Color {
    AlphaColor::<Srgb>::new([c.r as f32, c.g as f32, c.b as f32, (c.a * alpha) as f32])
}

pub fn affine_of(m: &Matrix) -> Affine {
    Affine::new([m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]])
}

fn extent(value: f64) -> f64 {
    if value > 0.0 && value.is_finite() {
        value
    } else {
        1.0
    }
}

/// Gradient space → node local space (`gradientFrame`): origin = S·h0, a = S·(h1 − h0), b = S·(h2 − h0).
pub struct GradientFrame {
    pub matrix: Affine,
    pub origin: Point,
    pub a: Vec2,
    pub b: Vec2,
}

pub fn gradient_frame(paint: &GradientPaint, width: f64, height: f64) -> GradientFrame {
    let w = extent(width);
    let h = extent(height);
    let [h0, h1, h2] = &paint.handles;
    let origin = Point::new(h0.x * w, h0.y * h);
    let a = Vec2::new((h1.x - h0.x) * w, (h1.y - h0.y) * h);
    let b = Vec2::new((h2.x - h0.x) * w, (h2.y - h0.y) * h);
    GradientFrame {
        matrix: Affine::new([a.x, a.y, b.x, b.y, origin.x, origin.y]),
        origin,
        a,
        b,
    }
}

/// Stops sorted by position and clamped to 0..1 (`normalizedStops`), with the paint's opacity folded in.
pub fn stops_of(stops: &[ColorStop], opacity: f64) -> Vec<peniko::ColorStop> {
    let mut indexed: Vec<(usize, &ColorStop)> = stops.iter().enumerate().collect();
    indexed.sort_by(|p, q| {
        p.1.position
            .partial_cmp(&q.1.position)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(p.0.cmp(&q.0))
    });
    let mut out: Vec<peniko::ColorStop> = indexed
        .into_iter()
        .map(|(_, s)| peniko::ColorStop {
            offset: (if s.position.is_finite() {
                s.position
            } else {
                0.0
            })
            .clamp(0.0, 1.0) as f32,
            color: DynamicColor::from_alpha_color(color_rgba(&s.color, opacity)),
        })
        .collect();
    if out.is_empty() {
        out.push(peniko::ColorStop {
            offset: 0.0,
            color: DynamicColor::from_alpha_color(AlphaColor::<Srgb>::TRANSPARENT),
        });
    }
    out
}

/// A gradient paint as peniko gradients in the unit frame, each with the local-space transform of its frame: one
/// for linear, radial and angular; four quadrants for a diamond (each to be clipped to its quadrant: the second
/// element is the quadrant's sign pair, `None` for a whole gradient).
pub fn gradients_of(
    paint: &GradientPaint,
    width: f64,
    height: f64,
) -> Vec<(Gradient, Affine, Option<(f64, f64)>)> {
    let frame = gradient_frame(paint, width, height);
    let stops = stops_of(paint.stops.as_slice(), paint.opacity);
    let det = frame.a.x * frame.b.y - frame.a.y * frame.b.x;
    if !det.is_finite() || det.abs() < 1e-12 {
        // A collapsed frame: Figma shows the last stop everywhere.
        let last = stops
            .last()
            .map(|s| s.color)
            .unwrap_or(DynamicColor::from_alpha_color(
                AlphaColor::<Srgb>::TRANSPARENT,
            ));
        let flat = Gradient::new_linear((0.0, 0.0), (1.0, 0.0)).with_stops(
            &[
                peniko::ColorStop {
                    offset: 0.0,
                    color: last,
                },
                peniko::ColorStop {
                    offset: 1.0,
                    color: last,
                },
            ][..],
        );
        return vec![(flat, Affine::IDENTITY, None)];
    }
    match paint.kind {
        GradientKind::Linear => {
            vec![(
                Gradient::new_linear((0.0, 0.0), (1.0, 0.0))
                    .with_stops(stops.as_slice())
                    .with_extend(Extend::Pad),
                frame.matrix,
                None,
            )]
        }
        GradientKind::Radial => {
            vec![(
                Gradient::new_radial((0.0, 0.0), 1.0)
                    .with_stops(stops.as_slice())
                    .with_extend(Extend::Pad),
                frame.matrix,
                None,
            )]
        }
        GradientKind::Angular => {
            // t runs 0..1 clockwise from +u towards +v in gradient space; the frame's orientation decides the sense.
            let sweep = if det > 0.0 {
                Gradient::new_sweep((0.0, 0.0), 0.0, std::f32::consts::TAU)
            } else {
                Gradient::new_sweep((0.0, 0.0), 0.0, -std::f32::consts::TAU)
            };
            vec![(
                sweep.with_stops(stops.as_slice()).with_extend(Extend::Pad),
                frame.matrix,
                None,
            )]
        }
        GradientKind::Diamond => [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)]
            .into_iter()
            .map(|(sx, sy)| {
                (
                    Gradient::new_linear((0.0, 0.0), (sx * 0.5, sy * 0.5))
                        .with_stops(stops.as_slice())
                        .with_extend(Extend::Pad),
                    frame.matrix,
                    Some((sx, sy)),
                )
            })
            .collect(),
    }
}

/// Where a picture's pixels land in a `width` × `height` box (`imagePlacement`): picture px → local, and whether
/// it repeats.
pub fn image_placement(
    paint: &ImagePaint,
    width: f64,
    height: f64,
    image_width: f64,
    image_height: f64,
) -> (Affine, bool) {
    let iw = image_width.max(1e-6);
    let ih = image_height.max(1e-6);
    if paint.scale_mode == ImageScaleMode::Crop {
        if let Some(transform) = &paint.transform {
            let to_unit = Affine::scale_non_uniform(1.0 / iw, 1.0 / ih);
            let to_local = Affine::scale_non_uniform(width, height);
            return (to_local * affine_of(transform).inverse() * to_unit, false);
        }
    }
    let turns = ((((paint.rotation.unwrap_or(0.0) / 90.0).round() as i64) % 4) + 4) % 4;
    let rotated = turns % 2 == 1;
    let rw = if rotated { ih } else { iw };
    let rh = if rotated { iw } else { ih };
    let quarter = match turns {
        1 => Affine::new([0.0, 1.0, -1.0, 0.0, 0.0, 0.0]),
        2 => Affine::new([-1.0, 0.0, 0.0, -1.0, 0.0, 0.0]),
        3 => Affine::new([0.0, -1.0, 1.0, 0.0, 0.0, 0.0]),
        _ => Affine::IDENTITY,
    };
    let spin = quarter * Affine::translate((-iw / 2.0, -ih / 2.0));
    if paint.scale_mode == ImageScaleMode::Tile {
        let s = match paint.scaling_factor {
            Some(f) if f > 0.0 => f,
            _ => 1.0,
        };
        return (
            Affine::new([s, 0.0, 0.0, s, (rw * s) / 2.0, (rh * s) / 2.0]) * spin,
            true,
        );
    }
    let s = if paint.scale_mode == ImageScaleMode::Fit {
        (width / rw).min(height / rh)
    } else {
        (width / rw).max(height / rh)
    };
    let scale = if s.is_finite() && s > 0.0 { s } else { 0.0 };
    (
        Affine::new([scale, 0.0, 0.0, scale, width / 2.0, height / 2.0]) * spin,
        false,
    )
}

/// Device px per picture px under a placement (`drawnScale`), for picking a mip.
pub fn drawn_scale(placement: Affine, device_scale: f64) -> f64 {
    let c = placement.as_coeffs();
    (c[0] * c[3] - c[1] * c[2]).abs().sqrt() * device_scale
}

pub fn neutral_filters(filters: Option<&ImageFilters>) -> bool {
    match filters {
        None => true,
        Some(f) => [
            f.exposure,
            f.contrast,
            f.saturation,
            f.temperature,
            f.tint,
            f.highlights,
            f.shadows,
        ]
        .iter()
        .all(|v| v.unwrap_or(0.0) == 0.0),
    }
}

/// Stable key of a filter set (`filtersKey`).
pub fn filters_key(filters: &ImageFilters) -> String {
    [
        filters.exposure,
        filters.contrast,
        filters.saturation,
        filters.temperature,
        filters.tint,
        filters.highlights,
        filters.shadows,
    ]
    .iter()
    .map(|v| ((v.unwrap_or(0.0) * 1000.0).round() as i64).to_string())
    .collect::<Vec<_>>()
    .join(",")
}

const LUMA: (f64, f64, f64) = (0.2126, 0.7152, 0.0722);

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}
fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    let t = clamp01((x - e0) / (e1 - e0));
    t * t * (3.0 - 2.0 * t)
}

/// Adjusts straight-alpha RGBA8 pixels in place the way the image panel's sliders do (`applyImageFilters`).
pub fn apply_image_filters(data: &mut [u8], filters: &ImageFilters) {
    let exposure = 2f64.powf(filters.exposure.unwrap_or(0.0) * 2.0);
    let k = clamp01((filters.contrast.unwrap_or(0.0) * 0.98 + 1.0) / 2.0);
    let contrast = ((k * std::f64::consts::PI) / 2.0).tan();
    let saturation = 1.0 + filters.saturation.unwrap_or(0.0);
    let temperature = filters.temperature.unwrap_or(0.0) * 0.2;
    let tint = filters.tint.unwrap_or(0.0) * 0.2;
    let highlights = filters.highlights.unwrap_or(0.0) * 0.35;
    let shadows = filters.shadows.unwrap_or(0.0) * 0.35;
    for px in data.chunks_exact_mut(4) {
        let mut r = px[0] as f64 / 255.0;
        let mut g = px[1] as f64 / 255.0;
        let mut b = px[2] as f64 / 255.0;
        r *= exposure;
        g *= exposure;
        b *= exposure;
        r = (r - 0.5) * contrast + 0.5;
        g = (g - 0.5) * contrast + 0.5;
        b = (b - 0.5) * contrast + 0.5;
        let luma = LUMA.0 * r + LUMA.1 * g + LUMA.2 * b;
        r = luma + (r - luma) * saturation;
        g = luma + (g - luma) * saturation;
        b = luma + (b - luma) * saturation;
        r += temperature;
        b -= temperature;
        g -= tint;
        r += tint * 0.5;
        b += tint * 0.5;
        if highlights != 0.0 || shadows != 0.0 {
            let l = clamp01(LUMA.0 * r + LUMA.1 * g + LUMA.2 * b);
            let lift =
                highlights * smoothstep(0.5, 1.0, l) + shadows * (1.0 - smoothstep(0.0, 0.5, l));
            r += lift;
            g += lift;
            b += lift;
        }
        px[0] = (clamp01(r) * 255.0) as u8;
        px[1] = (clamp01(g) * 255.0) as u8;
        px[2] = (clamp01(b) * 255.0) as u8;
    }
}

/// True when the paint draws something at all.
pub fn paint_visible(paint: &Paint) -> bool {
    paint.visible() && paint.opacity() > 0.0
}

/// The grey checkerboard where a picture is still loading, as a 16 × 16 picture (`checkerStyle`).
pub fn checker_picture() -> Picture {
    let mut data = vec![0u8; 16 * 16 * 4];
    for y in 0..16 {
        for x in 0..16 {
            let light = (x < 8) == (y < 8);
            let v = if light { 0xF5 } else { 0xE6 };
            let i = (y * 16 + x) * 4;
            data[i..i + 4].copy_from_slice(&[v, v, v, 255]);
        }
    }
    Picture::new(16, 16, data)
}
