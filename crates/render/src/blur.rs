//! A Gaussian blur of premultiplied RGBA8 pixels as three box blurs (`boxBlurRGBA` of
//! `src/design/engine/render/canvas.ts`: the combined variance matches σ, within a few percent of a true Gaussian),
//! for the CPU path's effect bitmaps and as the reference the GPU blur is tested against.

/// The box radius whose three passes approximate a Gaussian of `sigma` (the canvas's formula).
pub fn box_radius(sigma: f64) -> usize {
    (((12.0 * sigma * sigma) / 3.0 + 1.0).sqrt() / 2.0 - 0.5)
        .round()
        .max(1.0) as usize
}

/// Blurs premultiplied RGBA8 pixels in place by σ px (nothing below σ 0.05).
pub fn blur_premultiplied(data: &mut [u8], width: usize, height: usize, sigma: f64) {
    if !(sigma > 0.05) || width == 0 || height == 0 {
        return;
    }
    let radius = box_radius(sigma);
    let n = width * height * 4;
    let mut buffer: Vec<f32> = data[..n].iter().map(|&v| v as f32).collect();
    let mut temp = vec![0f32; n];
    for _ in 0..3 {
        box_pass(&buffer, &mut temp, width, height, radius, true);
        box_pass(&temp, &mut buffer, width, height, radius, false);
    }
    for (dst, src) in data[..n].iter_mut().zip(buffer.iter()) {
        *dst = (src + 0.5).clamp(0.0, 255.0) as u8;
    }
}

fn box_pass(
    src: &[f32],
    dst: &mut [f32],
    width: usize,
    height: usize,
    radius: usize,
    horizontal: bool,
) {
    let (lines, length) = if horizontal {
        (height, width)
    } else {
        (width, height)
    };
    let step = if horizontal { 4 } else { width * 4 };
    let scale = 1.0 / (2 * radius + 1) as f32;
    for line in 0..lines {
        let base = if horizontal {
            line * width * 4
        } else {
            line * 4
        };
        for channel in 0..4 {
            let mut sum = 0f32;
            for k in 0..=radius.min(length.saturating_sub(1)) {
                sum += src[base + k * step + channel];
            }
            for i in 0..length {
                dst[base + i * step + channel] = sum * scale;
                if i >= radius {
                    sum -= src[base + (i - radius) * step + channel];
                }
                let inn = i + radius + 1;
                if inn < length {
                    sum += src[base + inn * step + channel];
                }
            }
        }
    }
}

/// Premultiplies straight-alpha RGBA8 in place.
pub fn premultiply(data: &mut [u8]) {
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a < 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * a + 127) / 255) as u8;
            }
        }
    }
}

/// Un-premultiplies RGBA8 in place (for PNGs and readbacks).
pub fn unpremultiply(data: &mut [u8]) {
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a > 0 && a < 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

/// Half-size level of straight-alpha RGBA8 (a 2 × 2 box filter weighted by alpha): the picture mips.
pub fn downsample_half(data: &[u8], width: usize, height: usize) -> (Vec<u8>, usize, usize) {
    let w = (width / 2).max(1);
    let h = (height / 2).max(1);
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let mut sum = [0u32; 4];
            let mut alpha_sum = 0u32;
            let mut count = 0u32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let sx = (x * 2 + dx).min(width - 1);
                    let sy = (y * 2 + dy).min(height - 1);
                    let i = (sy * width + sx) * 4;
                    let a = data[i + 3] as u32;
                    sum[0] += data[i] as u32 * a;
                    sum[1] += data[i + 1] as u32 * a;
                    sum[2] += data[i + 2] as u32 * a;
                    alpha_sum += a;
                    count += 1;
                }
            }
            let o = (y * w + x) * 4;
            if alpha_sum > 0 {
                out[o] = (sum[0] / alpha_sum) as u8;
                out[o + 1] = (sum[1] / alpha_sum) as u8;
                out[o + 2] = (sum[2] / alpha_sum) as u8;
            }
            out[o + 3] = (alpha_sum / count) as u8;
        }
    }
    (out, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_spreads_a_dot_and_keeps_its_mass() {
        let w = 32;
        let h = 32;
        let mut data = vec![0u8; w * h * 4];
        let i = (16 * w + 16) * 4;
        data[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
        blur_premultiplied(&mut data, w, h, 2.0);
        let mass: u32 = data.chunks_exact(4).map(|px| px[3] as u32).sum();
        assert!((200..=300).contains(&mass), "mass {mass}");
        assert!(data[i + 3] < 40, "the centre spread out: {}", data[i + 3]);
        assert!(data[i + 3] > 0);
    }

    #[test]
    fn mips_average_with_alpha_weights() {
        let data = [255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0];
        let (out, w, h) = downsample_half(&data, 2, 2);
        assert_eq!((w, h), (1, 1));
        assert_eq!(&out[..], &[255, 0, 0, 127]);
    }
}
