//! Numbers written as JavaScript writes them.
//!
//! The document's numbers are `f64`, and the TS side reads and writes them with `JSON.parse` and
//! `JSON.stringify`, which format a number as ECMAScript `Number::toString(10)` (`String(n)`): the
//! shortest digits that read back as the same double, no `.0` on integers, `-0` as `0`, and exponent
//! form only below `1e-6` and from `1e21` on (`1e+21`, `1.5e-7`: the exponent's sign always written).
//! serde_json writes `1.0`, `-0.0` and `1e+16` where JavaScript writes `1`, `0` and
//! `10000000000000000`, so numbers are formatted here instead: [`js_number`], [`write_js_number`],
//! and the serde_json formatters [`JsFormatter`] (as `JSON.stringify(value)`) and
//! [`JsPrettyFormatter`] (as `JSON.stringify(value, null, 2)`).
//!
//! Integers below 2^53 and decimals with a few digits (`12.5`, `0.12`) take a fast path. Other values
//! take their shortest digits from Rust's `{:e}` (Grisu with a Dragon fallback): the shortest digit
//! string that reads back as the value and, of equally short ones, the closest to it, as ECMAScript
//! asks (Number::toString, note 2). Where two are exactly as close, V8 takes the even one and Rust
//! the upper one; `round_tie_to_even` corrects that. Checked against Node's `String(n)` on
//! `crates/model/tests/tables/js_number.json` (written by `scripts/model/js-number-table.ts`) and on
//! eight million doubles (random bit patterns, exponents, short decimals, subnormals, exact ties).

use std::fmt::Write as _;
use std::io;

use serde_json::ser::{Formatter, PrettyFormatter};

/// Room for the longest output: `-0.0000012345678901234567` (25 bytes) and `-1.2345678901234567e-308`
/// (24 bytes) are the longest shapes.
const CAPACITY: usize = 32;

/// Every integer below this is a double whose shortest digits are the integer's own digits.
const EXACT_INTEGERS: f64 = 9_007_199_254_740_992.0; // 2^53

/// ECMAScript `Number::toString(value)` (what `String(value)` gives in JavaScript).
///
/// Non-finite values give `NaN`, `Infinity` and `-Infinity` as JavaScript does; documents never hold
/// them (`JSON.stringify` and serde_json write them as `null`).
pub fn js_number(value: f64) -> String {
    let mut buf = Buffer::new();
    format_into(&mut buf, value);
    buf.as_str().to_owned()
}

/// Writes [`js_number`]`(value)` to `out` without allocating.
pub fn write_js_number<W: io::Write + ?Sized>(out: &mut W, value: f64) -> io::Result<()> {
    let mut buf = Buffer::new();
    format_into(&mut buf, value);
    out.write_all(buf.as_bytes())
}

/// A serde_json formatter that writes numbers as JavaScript does and everything else as
/// serde_json's compact formatter: `serde_json::Serializer::with_formatter(writer, JsFormatter)`
/// writes what `JSON.stringify` writes for the same value (up to key order).
///
/// Integers past 2^53 are written as the double JavaScript would read them as
/// (`18446744073709551615` → `18446744073709552000`), so `JSON.stringify(JSON.parse(text))` and a
/// serde_json round trip of `text` give the same numbers.
#[derive(Clone, Copy, Debug, Default)]
pub struct JsFormatter;

/// [`JsFormatter`] with serde_json's pretty layout (two spaces per level, `"key": value`, `[]` and
/// `{}` when empty), the layout of `JSON.stringify(value, null, 2)`.
#[derive(Clone, Debug)]
pub struct JsPrettyFormatter {
    inner: PrettyFormatter<'static>,
}

impl JsPrettyFormatter {
    pub fn new() -> Self {
        Self {
            inner: PrettyFormatter::with_indent(b"  "),
        }
    }
}

impl Default for JsPrettyFormatter {
    fn default() -> Self {
        Self::new()
    }
}

/// The number writers both formatters share.
macro_rules! js_number_writers {
    () => {
        fn write_f64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: f64,
        ) -> io::Result<()> {
            write_js_number(writer, value)
        }

        fn write_f32<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: f32,
        ) -> io::Result<()> {
            write_js_number(writer, f64::from(value))
        }

        fn write_i64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: i64,
        ) -> io::Result<()> {
            write_js_integer(writer, value.unsigned_abs().into(), value < 0, value as f64)
        }

        fn write_u64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: u64,
        ) -> io::Result<()> {
            write_js_integer(writer, value.into(), false, value as f64)
        }

        fn write_i128<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: i128,
        ) -> io::Result<()> {
            write_js_integer(writer, value.unsigned_abs(), value < 0, value as f64)
        }

        fn write_u128<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: u128,
        ) -> io::Result<()> {
            write_js_integer(writer, value, false, value as f64)
        }
    };
}

impl Formatter for JsFormatter {
    js_number_writers!();
}

/// Delegates the layout to serde_json's `PrettyFormatter` (these are exactly the methods it
/// overrides; the rest are the trait's defaults on both sides).
impl Formatter for JsPrettyFormatter {
    js_number_writers!();

    fn begin_array<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.begin_array(writer)
    }

    fn end_array<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_array(writer)
    }

    fn begin_array_value<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.inner.begin_array_value(writer, first)
    }

    fn end_array_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_array_value(writer)
    }

    fn begin_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.begin_object(writer)
    }

    fn end_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_object(writer)
    }

    fn begin_object_key<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.inner.begin_object_key(writer, first)
    }

    fn begin_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.begin_object_value(writer)
    }

    fn end_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_object_value(writer)
    }
}

/// An integer as JavaScript would print it after reading it: its digits while it is exact as a
/// double, otherwise the double it rounds to (`as_f64`, rounded to nearest as `JSON.parse` does).
fn write_js_integer<W: ?Sized + io::Write>(
    writer: &mut W,
    magnitude: u128,
    negative: bool,
    as_f64: f64,
) -> io::Result<()> {
    if magnitude > 1 << 53 {
        return write_js_number(writer, as_f64);
    }
    let mut buf = Buffer::new();
    if negative && magnitude != 0 {
        buf.push(b'-');
    }
    buf.push_integer(magnitude as u64);
    writer.write_all(buf.as_bytes())
}

/// ECMAScript Number::toString(x), radix 10 (ECMA-262 §6.1.6.1.20), into `buf`.
fn format_into(buf: &mut Buffer, value: f64) {
    if value.is_nan() {
        return buf.push_str("NaN");
    }
    // Step 2: +0 and -0 are both "0".
    if value == 0.0 {
        return buf.push(b'0');
    }
    if value < 0.0 {
        buf.push(b'-');
    }
    let value = value.abs();
    if value.is_infinite() {
        return buf.push_str("Infinity");
    }
    if value < EXACT_INTEGERS && value.fract() == 0.0 {
        // Fast path for the common case: below 2^53 the spacing of doubles is at most 1, so an
        // integer's own digits are the only digits of its length that read back as it.
        return buf.push_integer(value as u64);
    }

    // The shortest digits d1d2…dk and ECMAScript's n: the value is 0.d1d2…dk × 10^n.
    let mut digits = [0u8; 20];
    let (k, n) = match short_decimal(value) {
        Some((scaled, fraction_digits)) => {
            let k = write_digits(&mut digits, scaled);
            (k, k as i32 - fraction_digits)
        }
        None => shortest_digits(&mut digits, value),
    };
    let digits = &digits[..k];
    let k = k as i32;

    if k <= n && n <= 21 {
        // Step 6: the digits, then n − k zeros.
        buf.push_slice(digits);
        for _ in 0..n - k {
            buf.push(b'0');
        }
    } else if 0 < n && n <= 21 {
        // Step 7: the first n digits, a point, the other k − n.
        let (int, frac) = digits.split_at(n as usize);
        buf.push_slice(int);
        buf.push(b'.');
        buf.push_slice(frac);
    } else if -6 < n && n <= 0 {
        // Step 8: "0.", −n zeros, the digits.
        buf.push_str("0.");
        for _ in 0..-n {
            buf.push(b'0');
        }
        buf.push_slice(digits);
    } else {
        // Steps 9–10: exponent form, the sign of the exponent always written.
        buf.push(digits[0]);
        if k > 1 {
            buf.push(b'.');
            buf.push_slice(&digits[1..]);
        }
        buf.push(b'e');
        buf.push(if n - 1 < 0 { b'-' } else { b'+' });
        buf.push_integer(u64::from((n - 1).unsigned_abs()));
    }
}

/// Decimals with few digits (`12.5`, `0.12`, `99.99`, `1440.75`), the bulk of a document's numbers,
/// without the general algorithm: the integer `w` and the count `j` of decimals with `w / 10^j` reading
/// back as `value`, for the smallest such `j`. `None` sends the value to [`shortest_digits`].
///
/// Why the result is ECMAScript's: while `10^j · ulp(value) ≤ 1e-6`, `value · 10^j` is computed
/// within 1e-6, and a `j`-decimal string can read back as `value` only within `10^j · ulp / 2 ≤
/// 5e-7` of it. So a `j` whose product is more than 1e-3 from an integer has no candidate (skipping it
/// is right), and one within 1e-3 has at most `w` = the nearest integer, which is then also the
/// closest. `w / 10^j` (both exact, one correctly rounded division) is what parsing `w` with `j`
/// decimals gives. The smallest `j` means the fewest digits: `w` cannot end in 0 (`j − 1` would
/// have matched).
fn short_decimal(value: f64) -> Option<(u64, i32)> {
    const MAX_FRACTION_DIGITS: i32 = 9;
    // The spacing of doubles at `value` (exact: Sterbenz).
    let ulp = f64::from_bits(value.to_bits() + 1) - value;
    let mut scale = 1.0;
    for fraction_digits in 1..=MAX_FRACTION_DIGITS {
        scale *= 10.0;
        if ulp * scale > 1e-6 {
            return None;
        }
        let scaled = value * scale;
        let nearest = scaled.round();
        if (scaled - nearest).abs() <= 1e-3 && nearest / scale == value {
            return Some((nearest as u64, fraction_digits));
        }
    }
    None
}

/// `value`'s digits, most significant first, into `digits`; returns how many.
fn write_digits(digits: &mut [u8; 20], value: u64) -> usize {
    let mut text = Buffer::new();
    text.push_integer(value);
    digits[..text.len].copy_from_slice(text.as_bytes());
    text.len
}

/// The shortest round-trip digits of `value` (positive, finite) from Rust's `{:e}` (`d1.d2d3…e±x`),
/// ties corrected to JavaScript's: `(k, n)` with the value `0.d1…dk × 10^n`.
fn shortest_digits(digits: &mut [u8; 20], value: f64) -> (usize, i32) {
    let mut sci = Buffer::new();
    write!(sci, "{value:e}").expect("a float fits the buffer");
    let sci = sci.as_bytes();
    let e = sci
        .iter()
        .position(|&b| b == b'e')
        .expect("`{:e}` writes an exponent");
    let mut k = 0;
    for &b in &sci[..e] {
        if b != b'.' {
            digits[k] = b;
            k += 1;
        }
    }
    let exponent: i32 = std::str::from_utf8(&sci[e + 1..])
        .ok()
        .and_then(|text| text.parse().ok())
        .expect("`{:e}` writes an integer exponent");
    round_tie_to_even(&mut digits[..k], exponent, value);
    (k, exponent + 1)
}

/// Where the double lies exactly halfway between two equally short digit strings that both read
/// back as it, ECMAScript asks for the even one (Number::toString, note 2) and V8 takes it, while
/// Rust's formatter rounds the tie up: `2249082146819912.25` is `"2249082146819912.2"` in
/// JavaScript, `2249082146819912.3` from `{:e}`. `digits` (the shortest digits of `{:e}`, with
/// decimal exponent `exponent`) is turned into the even candidate when that one reads back too: below
/// a power of two the doubles are twice as dense, so there the lower candidate may not
/// (`2^-24 = 5.9604644775390625e-8` stays `5.960464477539063e-8` in JavaScript too).
///
/// A tie needs a value with exactly `p + 1` binary fraction digits, `p` the decimal ones of the
/// shortest form: the value is `odd / (2 × 10^p)`, so its odd mantissa `m` has exponent `−(p + 1)` and
/// the candidates are `(m·5^p ∓ 1) / 2`. Only values with a short binary fraction for their size get
/// there (`2249082146819912.25`, `2886254405724.53125`); for every other value the check is a few
/// integer operations.
fn round_tie_to_even(digits: &mut [u8], exponent: i32, value: f64) {
    let fraction_digits = digits.len() as i32 - 1 - exponent;
    let last = digits.len() - 1;
    if fraction_digits < 1 || (digits[last] - b'0').is_multiple_of(2) {
        return;
    }
    let bits = value.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1 << 52) - 1);
    let (mantissa, binary_exponent) = if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1 << 52), biased - 1075)
    };
    let zeros = mantissa.trailing_zeros() as i32;
    let odd = mantissa >> zeros;
    // At most 17 digits, so a tie has p ≤ 25 (10^(p−18) ≤ |x| < 2^(52−p)): m·5^p fits a u128.
    if binary_exponent + zeros != -(fraction_digits + 1) || fraction_digits > 26 {
        return;
    }
    let scaled = u128::from(odd) * 5u128.pow(fraction_digits as u32); // 2·10^p·|x|, an odd integer
    let shortest = digits
        .iter()
        .fold(0u128, |acc, &d| acc * 10 + u128::from(d - b'0'));
    // The candidates are (scaled − 1) / 2 and (scaled + 1) / 2, one apart in the last digit; `shortest`
    // is the odd one. The other never ends in 0 or carries past 9: it would have a shorter form.
    let other = if 2 * shortest + 1 == scaled && digits[last] < b'9' {
        digits[last] + 1
    } else if 2 * shortest == scaled + 1 && digits[last] > b'1' {
        digits[last] - 1
    } else {
        return;
    };
    let odd_digit = std::mem::replace(&mut digits[last], other);
    if !reads_back_as(digits, exponent, value) {
        digits[last] = odd_digit;
    }
}

/// Whether `d1.d2d3…e<exponent>` parses to `value` (Rust's parsing rounds correctly, as JavaScript's).
fn reads_back_as(digits: &[u8], exponent: i32, value: f64) -> bool {
    let mut text = Buffer::new();
    text.push(digits[0]);
    text.push(b'.');
    text.push_slice(&digits[1..]);
    text.push(b'e');
    if exponent < 0 {
        text.push(b'-');
    }
    text.push_integer(u64::from(exponent.unsigned_abs()));
    text.as_str().parse::<f64>() == Ok(value)
}

/// A fixed buffer on the stack: number formatting allocates nothing.
struct Buffer {
    bytes: [u8; CAPACITY],
    len: usize,
}

impl Buffer {
    fn new() -> Self {
        Self {
            bytes: [0; CAPACITY],
            len: 0,
        }
    }

    fn push(&mut self, byte: u8) {
        self.bytes[self.len] = byte;
        self.len += 1;
    }

    fn push_slice(&mut self, bytes: &[u8]) {
        self.bytes[self.len..self.len + bytes.len()].copy_from_slice(bytes);
        self.len += bytes.len();
    }

    fn push_str(&mut self, text: &str) {
        self.push_slice(text.as_bytes());
    }

    fn push_integer(&mut self, mut value: u64) {
        let mut digits = [0u8; 20];
        let mut start = digits.len();
        loop {
            start -= 1;
            digits[start] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 {
                break;
            }
        }
        self.push_slice(&digits[start..]);
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }

    fn as_str(&self) -> &str {
        std::str::from_utf8(self.as_bytes()).expect("numbers are ASCII")
    }
}

impl std::fmt::Write for Buffer {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        if self.len + text.len() > CAPACITY {
            return Err(std::fmt::Error);
        }
        self.push_str(text);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    /// `[["<f64 bits as 16 hex digits>", "<String(n) in Node>"], …]`, written by
    /// `npx tsx scripts/model/js-number-table.ts`.
    const TABLE: &str = include_str!("../tests/tables/js_number.json");

    #[test]
    fn matches_node_on_the_table() {
        let rows: Vec<(String, String)> = serde_json::from_str(TABLE).expect("the table parses");
        assert!(rows.len() >= 200, "the table has {} rows", rows.len());
        let mut failures = Vec::new();
        for (bits, expected) in &rows {
            let value = f64::from_bits(u64::from_str_radix(bits, 16).expect("hex bits"));
            let actual = js_number(value);
            if &actual != expected {
                failures.push(format!(
                    "{bits} ({value:e}): expected {expected}, got {actual}"
                ));
            }
            let mut written = Vec::new();
            write_js_number(&mut written, value).expect("writes to a Vec");
            assert_eq!(written, actual.as_bytes());
        }
        assert!(
            failures.is_empty(),
            "{} of {} rows differ:\n{}",
            failures.len(),
            rows.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn switches_notation_where_javascript_does() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (999_999_999_999_999_900_000.0, "999999999999999900000"),
            (1e20, "100000000000000000000"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1.5e300, "1.5e+300"),
            (0.000001, "0.000001"),
            (0.0000012345, "0.0000012345"),
            (1e-7, "1e-7"),
            (123e-20, "1.23e-18"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
            (9_007_199_254_740_993.0, "9007199254740992"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for &(value, expected) in cases {
            assert_eq!(js_number(value), expected, "{value:e}");
        }
    }

    fn to_js_json<T: Serialize>(value: &T) -> String {
        let mut out = Vec::new();
        value
            .serialize(&mut serde_json::Serializer::with_formatter(
                &mut out,
                JsFormatter,
            ))
            .expect("serializes");
        String::from_utf8(out).expect("UTF-8")
    }

    fn to_js_json_pretty<T: Serialize>(value: &T) -> String {
        let mut out = Vec::new();
        value
            .serialize(&mut serde_json::Serializer::with_formatter(
                &mut out,
                JsPrettyFormatter::new(),
            ))
            .expect("serializes");
        String::from_utf8(out).expect("UTF-8")
    }

    #[test]
    fn formatters_write_numbers_as_json_stringify() {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Node {
            x: f64,
            width: f64,
            scale: f32,
            dash_pattern: Vec<f64>,
            nan: f64,
        }
        let node = Node {
            x: 1.0,
            width: -0.0,
            scale: 0.5,
            dash_pattern: vec![1e21, 1e-7, 2.5],
            nan: f64::NAN,
        };
        assert_eq!(
            to_js_json(&node),
            r#"{"x":1,"width":0,"scale":0.5,"dashPattern":[1e+21,1e-7,2.5],"nan":null}"#
        );
        assert_eq!(
            to_js_json_pretty(&node),
            "{\n  \"x\": 1,\n  \"width\": 0,\n  \"scale\": 0.5,\n  \"dashPattern\": [\n    1e+21,\n    1e-7,\n    2.5\n  ],\n  \"nan\": null\n}"
        );
        let empty: (Vec<f64>, serde_json::Map<String, serde_json::Value>) =
            (vec![], serde_json::Map::new());
        assert_eq!(to_js_json_pretty(&empty), "[\n  [],\n  {}\n]");
    }

    #[test]
    fn integers_past_2_pow_53_read_as_javascript_reads_them() {
        let value: serde_json::Value = serde_json::from_str(
            "[3, -7, 9007199254740993, 18446744073709551615, -9223372036854775808, 12.0, 1e2]",
        )
        .expect("parses");
        assert_eq!(
            to_js_json(&value),
            "[3,-7,9007199254740992,18446744073709552000,-9223372036854776000,12,100]"
        );
        assert_eq!(
            to_js_json(&(i64::MIN, u64::MAX, 0_i64, 1_i128 << 53, -(1_i128 << 60))),
            "[-9223372036854776000,18446744073709552000,0,9007199254740992,-1152921504606847000]"
        );
    }
}
