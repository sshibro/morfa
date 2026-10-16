//! Replays the cases written by `scripts/geometry/clip-fuzz.mjs` through `morfa_geometry::clip`
//! and compares the results with polygon-clipping's bit for bit (errors must be errors).
//!
//!   cargo run --release -p morfa-geometry --example clip_check -- /tmp/clip-cases.txt
//!   cargo run --release -p morfa-geometry --example clip_check -- --bench /tmp/clip-bench.txt

use std::time::Instant;

use morfa_geometry::clip::{MultiPolygon, Operation, clip};

struct Tokens<'a> {
    it: std::str::SplitAsciiWhitespace<'a>,
}

impl<'a> Tokens<'a> {
    fn next(&mut self) -> Option<&'a str> {
        self.it.next()
    }
    fn expect(&mut self, t: &str) {
        let got = self.next();
        assert_eq!(got, Some(t), "malformed case file");
    }
    fn usize(&mut self) -> usize {
        self.next().expect("count").parse().expect("count")
    }
    fn f64(&mut self) -> f64 {
        f64::from_bits(u64::from_str_radix(self.next().expect("number"), 16).expect("hex bits"))
    }
    fn geom(&mut self) -> MultiPolygon {
        self.expect("G");
        let np = self.usize();
        (0..np)
            .map(|_| {
                self.expect("P");
                let nr = self.usize();
                (0..nr)
                    .map(|_| {
                        self.expect("R");
                        let n = self.usize();
                        (0..n).map(|_| [self.f64(), self.f64()]).collect()
                    })
                    .collect()
            })
            .collect()
    }
}

struct Case {
    op: Operation,
    geoms: Vec<MultiPolygon>,
    /// The JS result, or the kind of error it threw.
    expected: Result<MultiPolygon, String>,
}

fn parse(text: &str) -> Vec<Case> {
    let mut t = Tokens {
        it: text.split_ascii_whitespace(),
    };
    let mut cases = Vec::new();
    while let Some(tok) = t.next() {
        assert_eq!(tok, "C");
        let op = match t.next() {
            Some("union") => Operation::Union,
            Some("intersection") => Operation::Intersection,
            Some("xor") => Operation::Xor,
            Some("difference") => Operation::Difference,
            other => panic!("unknown op {other:?}"),
        };
        let n = t.usize();
        let geoms = (0..n).map(|_| t.geom()).collect();
        let expected = match t.next() {
            Some("OK") => Ok(t.geom()),
            Some("ERR") => Err(t.next().expect("error kind").replace('_', " ")),
            // the JS never returned: the port must report one of its endless-loop guards
            Some("HANG") => Err(HANG.to_string()),
            other => panic!("bad result tag {other:?}"),
        };
        cases.push(Case {
            op,
            geoms,
            expected,
        });
    }
    cases
}

/// Bit-equal comparison (`==` plus the sign of zero, so -0 and 0 differ); `None` if equal.
fn first_difference(a: &MultiPolygon, b: &MultiPolygon) -> Option<String> {
    if a.len() != b.len() {
        return Some(format!("polygon count {} vs {}", a.len(), b.len()));
    }
    for (pi, (pa, pb)) in a.iter().zip(b).enumerate() {
        if pa.len() != pb.len() {
            return Some(format!(
                "poly {pi}: ring count {} vs {}",
                pa.len(),
                pb.len()
            ));
        }
        for (ri, (ra, rb)) in pa.iter().zip(pb).enumerate() {
            if ra.len() != rb.len() {
                return Some(format!(
                    "poly {pi} ring {ri}: point count {} vs {}",
                    ra.len(),
                    rb.len()
                ));
            }
            for (k, (x, y)) in ra.iter().zip(rb).enumerate() {
                for c in 0..2 {
                    let (u, v) = (x[c], y[c]);
                    let same = (u == v && u.is_sign_negative() == v.is_sign_negative())
                        || (u.is_nan() && v.is_nan());
                    if !same {
                        return Some(format!("poly {pi} ring {ri} point {k}: {:?} vs {:?}", x, y));
                    }
                }
            }
        }
    }
    None
}

/// The expected "error kind" of a case the JS never returned from.
const HANG: &str = "(JS hang)";

/// The stable part of an error message, without the JS error class the port prefixes
/// (`TypeError: `, `RangeError: `), as the fuzz script records it.
fn error_kind(message: &str) -> String {
    let m = message.split(['[', '#']).next().unwrap_or("").trim();
    let m = m
        .strip_prefix("TypeError: ")
        .or_else(|| m.strip_prefix("RangeError: "))
        .unwrap_or(m);
    m.to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bench = args.first().is_some_and(|a| a == "--bench");
    let path = if bench { args.get(1) } else { args.first() }
        .cloned()
        .unwrap_or_else(|| "/tmp/clip-cases.txt".into());
    let text = std::fs::read_to_string(&path).expect("read case file");
    let cases = parse(&text);

    if bench {
        let case = &cases[0];
        let check = clip(case.op, &case.geoms);
        let ok = match (&check, &case.expected) {
            (Ok(r), Ok(e)) => first_difference(r, e).is_none(),
            (Err(_), Err(_)) => true,
            _ => false,
        };
        for _ in 0..3 {
            let _ = clip(case.op, &case.geoms);
        }
        let mut times: Vec<f64> = (0..10)
            .map(|_| {
                let t0 = Instant::now();
                let _ = std::hint::black_box(clip(case.op, std::hint::black_box(&case.geoms)));
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        times.sort_by(f64::total_cmp);
        println!(
            "Rust clip union of {} operands: median {:.2} ms, min {:.2} ms (matches JS: {ok})",
            case.geoms.len(),
            times[5],
            times[0]
        );
        return;
    }

    let mut mismatches = 0;
    let mut errors = 0;
    let mut kinds: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let t0 = Instant::now();
    for (i, case) in cases.iter().enumerate() {
        let got = clip(case.op, &case.geoms);
        let problem = match (&got, &case.expected) {
            (Ok(r), Ok(e)) => first_difference(r, e),
            (Err(e), Err(js)) => {
                errors += 1;
                let mut k = error_kind(&e.message);
                if js == HANG && k.contains("would loop forever") {
                    k = HANG.to_string();
                }
                *kinds.entry(k.clone()).or_default() += 1;
                (k != *js).then(|| format!("Rust error `{k}`, JS error `{js}`"))
            }
            (Err(e), Ok(_)) => Some(format!("Rust error `{e}`, JS ok")),
            (Ok(_), Err(js)) => Some(format!("Rust ok, JS threw `{js}`")),
        };
        if let Some(p) = problem {
            mismatches += 1;
            if mismatches <= 10 {
                println!(
                    "case {i} ({:?}, {} operands): {p}",
                    case.op,
                    case.geoms.len()
                );
            }
        }
    }
    println!(
        "{} cases, {} mismatches, {} matching errors ({:.1} ms total)",
        cases.len(),
        mismatches,
        errors,
        t0.elapsed().as_secs_f64() * 1e3
    );
    for (k, n) in &kinds {
        println!("  {n} x {k}");
    }
    if mismatches > 0 {
        std::process::exit(1);
    }
}
