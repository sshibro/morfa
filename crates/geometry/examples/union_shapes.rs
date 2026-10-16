//! Lane G tooling: how the 200-operand union's time splits, and what other shapes of the same union would cost and
//! change. Every variant's area is compared with today's cascade by the area of their symmetric difference.
//!   `cargo run --release -p morfa-geometry --example union_shapes -- ops.json [runs] [areas-out.json]`
use morfa_geometry::boolean::{combine_areas, fill_area};
use morfa_geometry::clip::{self, MultiPolygon, Operation};
use morfa_model::{BooleanOperation, VectorPath};

fn area(mp: &MultiPolygon) -> f64 {
    let mut total = 0.0;
    for polygon in mp {
        for ring in polygon {
            let n = ring.len();
            let mut s = 0.0;
            for k in 0..n {
                let [x0, y0] = ring[k];
                let [x1, y1] = ring[(k + 1) % n];
                s += x0 * y1 - x1 * y0;
            }
            total += s / 2.0;
        }
    }
    total
}

fn vertices(mp: &MultiPolygon) -> usize {
    mp.iter().flatten().map(Vec::len).sum()
}

fn time<T>(runs: usize, mut f: impl FnMut() -> T) -> (f64, T) {
    let mut best = f64::INFINITY;
    let mut out = f();
    for _ in 0..runs {
        let t = std::time::Instant::now();
        out = f();
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
    }
    (best, out)
}

fn main() {
    let path = std::env::args().nth(1).expect("file");
    let runs: usize = std::env::args()
        .nth(2)
        .map_or(5, |s| s.parse().expect("runs"));
    let ops: Vec<Vec<VectorPath>> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
    morfa_geometry::boolean::set_clock(|| 0.0);

    let (t_fill, areas) = time(runs, || {
        ops.iter().map(|p| fill_area(p, 0.01)).collect::<Vec<_>>()
    });
    if let Some(out) = std::env::args().nth(3) {
        // The operand areas, for trying other clippers outside the repo.
        std::fs::write(out, serde_json::to_string(&areas).expect("json")).expect("write");
    }
    let input_vertices: usize = areas.iter().map(vertices).sum();
    let (t_cascade, cascade) = time(runs, || combine_areas(BooleanOperation::Union, &areas));
    let present: Vec<MultiPolygon> = areas.iter().filter(|a| !a.is_empty()).cloned().collect();
    let (t_nary, nary) = time(runs, || {
        clip::clip(Operation::Union, &present).expect("clip")
    });
    let reference = area(&cascade);
    let diff = |other: &MultiPolygon| {
        let snap = |m: &MultiPolygon| -> MultiPolygon {
            m.iter()
                .map(|p| {
                    p.iter()
                        .map(|r| {
                            r.iter()
                                .map(|&[x, y]| [(x * 1e6).round() / 1e6, (y * 1e6).round() / 1e6])
                                .collect()
                        })
                        .collect()
                })
                .collect()
        };
        let xor = clip::clip(Operation::Xor, &[cascade.clone(), other.clone()])
            .or_else(|_| clip::clip(Operation::Xor, &[snap(&cascade), snap(other)]))
            .expect("xor");
        area(&xor).abs()
    };
    println!(
        "operands {}, input vertices {input_vertices}; fill areas (flatten + per-operand normalise) {t_fill:.1} ms",
        ops.len()
    );
    println!(
        "cascade union (today) {t_cascade:.1} ms: area {reference:.6}, {} vertices out",
        vertices(&cascade)
    );
    println!(
        "one n-ary sweep        {t_nary:.1} ms: area {:.6}, {} vertices out, |sym diff| {:.3e} ({:.3e} of the area)",
        area(&nary),
        vertices(&nary),
        diff(&nary),
        diff(&nary) / reference
    );
    // Groups of g operands in one n-ary sweep each, then those results the same way, until one is left.
    for g in [2usize, 4, 8, 16, 32] {
        let (t, grouped) = time(runs, || {
            let mut list = present.clone();
            while list.len() > 1 {
                list = list
                    .chunks(g)
                    .map(|c| {
                        if c.len() == 1 {
                            c[0].clone()
                        } else {
                            clip::clip(Operation::Union, c).expect("clip")
                        }
                    })
                    .collect();
            }
            list.pop().unwrap_or_default()
        });
        println!(
            "groups of {g:2} n-ary     {t:.1} ms: |sym diff| {:.3e}",
            diff(&grouped)
        );
    }
    let points = |m: &MultiPolygon| {
        let mut all: Vec<(u64, u64)> = m
            .iter()
            .flatten()
            .flatten()
            .map(|&[x, y]| (x.to_bits(), y.to_bits()))
            .collect();
        all.sort_unstable();
        all
    };
    let (a, b) = (points(&cascade), points(&nary));
    let common = {
        let set: std::collections::HashSet<_> = a.iter().collect();
        b.iter().filter(|p| set.contains(p)).count()
    };
    println!(
        "same output: {}; same point multiset: {}; {common} of {} n-ary points are bit-equal to a cascade point; polygons {} vs {}",
        nary == cascade,
        a == b,
        b.len(),
        cascade.len(),
        nary.len()
    );
}
