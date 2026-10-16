//! Pictures as PDF image XObjects: a JPEG's own bytes (/DCTDecode, as Chromium embeds it), a PNG decoded to its
//! samples (Flate, its alpha a soft mask, lossless), and raw RGBA (the rasterised shadows and blurs).

use super::writer::Writer;

/// An image ready to place: its XObject and natural size in pixels.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    /// Every pixel is opaque (a JPEG; a raster without alpha).
    pub opaque: bool,
}

fn be16(b: &[u8], at: usize) -> usize {
    ((b[at] as usize) << 8) | b[at + 1] as usize
}

/// A JPEG's size, components and whether it is an Adobe CMYK one (inverted), from its frame header.
fn jpeg_info(data: &[u8]) -> Option<(u32, u32, u8, bool)> {
    if data.len() < 4 || data[0] != 0xff || data[1] != 0xd8 {
        return None;
    }
    let mut at = 2;
    let mut adobe = false;
    while at + 4 <= data.len() {
        if data[at] != 0xff {
            at += 1;
            continue;
        }
        let marker = data[at + 1];
        if marker == 0xff {
            at += 1;
            continue;
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            at += 2;
            continue;
        }
        let length = be16(data, at + 2);
        if marker == 0xee && data.get(at + 4..at + 9) == Some(b"Adobe") {
            adobe = true;
        }
        let sof = matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
        if sof {
            if at + 9 >= data.len() {
                return None;
            }
            let height = be16(data, at + 5) as u32;
            let width = be16(data, at + 7) as u32;
            let components = data[at + 9];
            return Some((width, height, components, adobe));
        }
        at += 2 + length;
    }
    None
}

/// Writes `data` (PNG or JPEG bytes) as an image XObject.
pub fn write_encoded(w: &mut Writer, data: &[u8]) -> Option<Placed> {
    if let Some((width, height, components, adobe)) = jpeg_info(data) {
        let space = match components {
            1 => "/DeviceGray",
            4 => "/DeviceCMYK",
            _ => "/DeviceRGB",
        };
        let decode = if components == 4 && adobe {
            " /Decode [1 0 1 0 1 0 1 0]"
        } else {
            ""
        };
        let id = w.alloc();
        w.raw_stream(
            id,
            &format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace {space} /BitsPerComponent 8{decode} /Filter /DCTDecode"),
            data,
        );
        return Some(Placed {
            id,
            width,
            height,
            opaque: true,
        });
    }
    let (rgba, width, height) = decode_png(data)?;
    Some(write_rgba(w, &rgba, width, height, false))
}

/// RGBA 8-bit samples (straight alpha) as an image with a soft mask when some pixel is not opaque.
pub fn write_rgba(
    w: &mut Writer,
    rgba: &[u8],
    width: u32,
    height: u32,
    interpolate: bool,
) -> Placed {
    let id = w.alloc();
    write_encoded_rgba(w, id, encode_rgba(rgba, width, height, interpolate))
}

/// An RGBA image encoded for the PDF (predicted and deflated), not yet written: the part of [`write_rgba`] that needs
/// no writer, so rasters can be encoded on other threads.
pub struct EncodedRgba {
    width: u32,
    height: u32,
    opaque: bool,
    /// The soft mask's dictionary entries and Flate bytes.
    mask: Option<(String, Vec<u8>)>,
    /// The colour image's dictionary entries without /SMask, its bytes, and whether they are Flate-compressed.
    color: (String, Vec<u8>, bool),
}

/// Encodes straight-alpha RGBA as [`write_rgba`] writes it.
pub fn encode_rgba(rgba: &[u8], width: u32, height: u32, interpolate: bool) -> EncodedRgba {
    let pixels = (width * height) as usize;
    let mut rgb = Vec::with_capacity(pixels * 3);
    let mut alpha = Vec::with_capacity(pixels);
    let mut opaque = true;
    // One colour wherever anything is drawn (a shadow: its tint): the colour image is 1×1 under a full soft mask.
    let mut uniform: Option<[u8; 3]> = None;
    let mut single = true;
    for px in rgba.as_chunks::<4>().0 {
        rgb.extend_from_slice(&px[..3]);
        alpha.push(px[3]);
        opaque &= px[3] == 255;
        if px[3] > 0 && single {
            let c = [px[0], px[1], px[2]];
            match uniform {
                None => uniform = Some(c),
                Some(u) => single = u.iter().zip(c).all(|(a, b)| a.abs_diff(b) <= 1),
            }
        }
    }
    let smooth = if interpolate {
        " /Interpolate true"
    } else {
        ""
    };
    let mask = (!opaque).then(|| {
        let data = predict(&alpha, 1, width as usize);
        (
            format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8{smooth} /DecodeParms <</Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns {width}>> /Filter /FlateDecode"),
            super::writer::deflate(&data),
        )
    });
    let color = if let (Some(c), true, false) = (uniform, single, opaque) {
        (
            "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8".to_owned(),
            c.to_vec(),
            false,
        )
    } else {
        let data = predict(&rgb, 3, width as usize);
        (
            format!(
                "/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8{smooth} /DecodeParms <</Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns {width}>>"
            ),
            super::writer::deflate(&data),
            true,
        )
    };
    EncodedRgba {
        width,
        height,
        opaque,
        mask,
        color,
    }
}

/// Writes an encoded image as object `id` (allocated earlier: a deferred raster's content already names it).
pub fn write_encoded_rgba(w: &mut Writer, id: u32, image: EncodedRgba) -> Placed {
    let mask = match image.mask {
        None => String::new(),
        Some((dict, data)) => {
            let mask_id = w.alloc();
            w.raw_stream(mask_id, &dict, &data);
            format!(" /SMask {mask_id} 0 R")
        }
    };
    let (dict, data, flate) = image.color;
    let filter = if flate { " /Filter /FlateDecode" } else { "" };
    w.raw_stream(id, &format!("{dict}{mask}{filter}"), &data);
    Placed {
        id,
        width: image.width,
        height: image.height,
        opaque: image.opaque,
    }
}

/// PNG prediction of 8-bit rows (`bpp` bytes a pixel), the filter chosen per row by the smallest sum of absolute
/// differences (libpng's heuristic): smooth pictures and rasters deflate to a fraction.
fn predict(data: &[u8], bpp: usize, width: usize) -> Vec<u8> {
    let stride = width * bpp;
    if stride == 0 {
        return Vec::new();
    }
    let rows = data.len() / stride;
    let mut out = Vec::with_capacity(rows * (stride + 1));
    let zero = vec![0u8; stride];
    let mut candidates: [Vec<u8>; 5] = std::array::from_fn(|_| vec![0u8; stride]);
    for r in 0..rows {
        let row = &data[r * stride..(r + 1) * stride];
        let up = if r == 0 {
            &zero[..]
        } else {
            &data[(r - 1) * stride..r * stride]
        };
        for i in 0..stride {
            let a = if i >= bpp { row[i - bpp] } else { 0 };
            let b = up[i];
            let c = if i >= bpp { up[i - bpp] } else { 0 };
            let x = row[i];
            let paeth = {
                let p = a as i16 + b as i16 - c as i16;
                let (pa, pb, pc) = (
                    (p - a as i16).abs(),
                    (p - b as i16).abs(),
                    (p - c as i16).abs(),
                );
                if pa <= pb && pa <= pc {
                    a
                } else if pb <= pc {
                    b
                } else {
                    c
                }
            };
            candidates[0][i] = x;
            candidates[1][i] = x.wrapping_sub(a);
            candidates[2][i] = x.wrapping_sub(b);
            candidates[3][i] = x.wrapping_sub(((a as u16 + b as u16) / 2) as u8);
            candidates[4][i] = x.wrapping_sub(paeth);
        }
        let cost = |v: &Vec<u8>| {
            v.iter()
                .map(|&x| (x as i8).unsigned_abs() as u64)
                .sum::<u64>()
        };
        let (best, _) = candidates
            .iter()
            .enumerate()
            .min_by_key(|(_, v)| cost(v))
            .expect("five filters");
        out.push(best as u8);
        out.extend_from_slice(&candidates[best]);
    }
    out
}

/// A PNG's pixels as 8-bit RGBA.
pub fn decode_png(data: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(data));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let (width, height) = (info.width, info.height);
    let samples = &buf[..info.buffer_size()];
    let rgba: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => samples.to_vec(),
        png::ColorType::Rgb => samples
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => samples
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => samples.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return None,
    };
    Some((rgba, width, height))
}

/// Decodes the base64 body of a `data:image/…;base64,` URL.
pub fn data_url_bytes(url: &str) -> Option<Vec<u8>> {
    let comma = url.find(',')?;
    if !url[..comma].to_ascii_lowercase().ends_with(";base64") {
        return None;
    }
    let mut out = Vec::with_capacity(url.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in url[comma + 1..].bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Base64 of bytes (the decoder's test; rasters name their pictures instead, raster.rs).
#[cfg(test)]
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        let data = b"Morfa PDF \x00\xff";
        let url = format!("data:image/png;base64,{}", base64(data));
        assert_eq!(data_url_bytes(&url).unwrap(), data);
    }
}
