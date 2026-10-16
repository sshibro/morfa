//! The PDF file itself: numbered objects, Flate streams, the cross-reference table and the trailer (PDF 1.7, one
//! classic xref section, no object streams, so every viewer reads it).

use std::fmt::Write as _;

/// A real number as PDF writes it: at most `decimals` decimals, no exponent, no "-0".
pub fn real(value: f64, decimals: usize) -> String {
    if !value.is_finite() {
        return "0".to_owned();
    }
    let mut text = format!("{value:.decimals$}");
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    if text == "-0" || text.is_empty() {
        return "0".to_owned();
    }
    text
}

/// Coordinates (px or pt): four decimals.
pub fn n(value: f64) -> String {
    real(value, 4)
}

/// A PDF text string: UTF-16BE with its byte order mark, as a hex string.
pub fn text_string(text: &str) -> String {
    let mut out = String::from("<FEFF");
    for unit in text.encode_utf16() {
        let _ = write!(out, "{unit:04X}");
    }
    out.push('>');
    out
}

/// A PDF literal string of ASCII text (URIs), escaped.
pub fn ascii_string(text: &str) -> String {
    let mut out = String::from("(");
    for c in text.chars() {
        match c {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_ascii() && !c.is_ascii_control() => out.push(c),
            c => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    let _ = write!(out, "\\{b:03o}");
                }
            }
        }
    }
    out.push(')');
    out
}

pub fn deflate(data: &[u8]) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec_zlib(data, 6)
}

pub struct Writer {
    pub buf: Vec<u8>,
    offsets: Vec<Option<usize>>,
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}

impl Writer {
    pub fn new() -> Self {
        let mut buf = Vec::with_capacity(1 << 16);
        // A binary comment marks the file as binary for transfer tools.
        buf.extend_from_slice(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
        Writer {
            buf,
            offsets: vec![None],
        }
    }

    /// A new object number (written later with `object` or `stream`).
    pub fn alloc(&mut self) -> u32 {
        self.offsets.push(None);
        (self.offsets.len() - 1) as u32
    }

    pub fn object(&mut self, id: u32, body: &str) {
        self.offsets[id as usize] = Some(self.buf.len());
        self.buf
            .extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        self.buf.extend_from_slice(body.as_bytes());
        self.buf.extend_from_slice(b"\nendobj\n");
    }

    /// A stream object: `dict` holds the dictionary's entries without /Length (and without /Filter when `compress`).
    pub fn stream(&mut self, id: u32, dict: &str, data: &[u8], compress: bool) {
        let packed;
        let (bytes, filter) = if compress && data.len() > 32 {
            packed = deflate(data);
            (&packed[..], " /Filter /FlateDecode")
        } else {
            (data, "")
        };
        self.offsets[id as usize] = Some(self.buf.len());
        self.buf.extend_from_slice(
            format!(
                "{id} 0 obj\n<<{dict}{filter} /Length {}>>\nstream\n",
                bytes.len()
            )
            .as_bytes(),
        );
        self.buf.extend_from_slice(bytes);
        self.buf.extend_from_slice(b"\nendstream\nendobj\n");
    }

    /// A stream always Flate-compressed (its dictionary may carry /DecodeParms for the compressed data).
    pub fn flate_stream(&mut self, id: u32, dict: &str, data: &[u8]) {
        let packed = deflate(data);
        self.offsets[id as usize] = Some(self.buf.len());
        self.buf.extend_from_slice(
            format!(
                "{id} 0 obj\n<<{dict} /Filter /FlateDecode /Length {}>>\nstream\n",
                packed.len()
            )
            .as_bytes(),
        );
        self.buf.extend_from_slice(&packed);
        self.buf.extend_from_slice(b"\nendstream\nendobj\n");
    }

    /// A stream already encoded with `filter` (an image's JPEG bytes: /DCTDecode).
    pub fn raw_stream(&mut self, id: u32, dict: &str, data: &[u8]) {
        self.offsets[id as usize] = Some(self.buf.len());
        self.buf.extend_from_slice(
            format!("{id} 0 obj\n<<{dict} /Length {}>>\nstream\n", data.len()).as_bytes(),
        );
        self.buf.extend_from_slice(data);
        self.buf.extend_from_slice(b"\nendstream\nendobj\n");
    }

    /// The xref table and trailer. Objects never written become free entries.
    pub fn finish(mut self, root: u32, info: u32) -> Vec<u8> {
        let xref = self.buf.len();
        let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", self.offsets.len());
        for offset in &self.offsets[1..] {
            match offset {
                Some(at) => {
                    let _ = writeln!(table, "{at:010} 00000 n ");
                }
                None => table.push_str("0000000000 65535 f \n"),
            }
        }
        let _ = write!(
            table,
            "trailer\n<</Size {} /Root {root} 0 R /Info {info} 0 R>>\nstartxref\n{xref}\n%%EOF\n",
            self.offsets.len()
        );
        self.buf.extend_from_slice(table.as_bytes());
        self.buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reals() {
        assert_eq!(real(1.0, 4), "1");
        assert_eq!(real(-0.00001, 4), "0");
        assert_eq!(real(12.34567, 4), "12.3457");
        assert_eq!(real(1e-9, 4), "0");
        assert_eq!(real(-3.5, 4), "-3.5");
    }

    #[test]
    fn strings() {
        assert_eq!(text_string("Аб"), "<FEFF04100431>");
        assert_eq!(ascii_string("a(b)\\"), "(a\\(b\\)\\\\)");
    }
}
