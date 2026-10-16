//! Lane G tooling: the live-drawing union (`combine_paths_live`) against the exact one (`combine_paths`) on dumped
//! operands, by area: both answers flattened at `tolerance`, the area of their symmetric difference over the
//! bounding box's area (the engine switch's check for the live entry), and the two areas.
//!   `cargo run --release -p morfa-geometry --example live_check -- ops.json [tolerance] [UNION|SUBTRACT]`
use morfa_geometry::boolean::{area_difference, combine_paths, combine_paths_live};
use morfa_model::BooleanOperation;

fn main() {
    let path = std::env::args().nth(1).expect("file");
    let tolerance: f64 = std::env::args()
        .nth(2)
        .map_or(0.01, |s| s.parse().expect("tolerance"));
    let operation = match std::env::args().nth(3).as_deref() {
        Some("SUBTRACT") => BooleanOperation::Subtract,
        _ => BooleanOperation::Union,
    };
    let ops: Vec<Vec<morfa_model::VectorPath>> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
    morfa_geometry::boolean::set_clock(|| 0.0);
    if std::env::var_os("POLYGONS").is_some() {
        let areas: Vec<_> = ops
            .iter()
            .map(|p| morfa_geometry::boolean::fill_area(p, 0.01))
            .collect();
        let e = morfa_geometry::boolean::combine_areas(operation, &areas);
        let l = morfa_geometry::boolean::live_areas_debug(operation, &ops, 0.01);
        let x = morfa_geometry::clip::clip(
            morfa_geometry::clip::Operation::Xor,
            &[e.clone(), l.clone()],
        )
        .expect("xor");
        println!(
            "polygons: symmetric {:.3e}, areas {:.6} vs {:.6}, polygons {} vs {}",
            morfa_geometry::boolean::multipolygon_area(&x),
            morfa_geometry::boolean::multipolygon_area(&e),
            morfa_geometry::boolean::multipolygon_area(&l),
            e.len(),
            l.len()
        );
    }
    // The boolean's own flattening tolerance (`BOOL_TOL`, default 0.01).
    let bool_tol: f64 = std::env::var("BOOL_TOL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.01);
    let exact = combine_paths(operation, &ops, bool_tol);
    let live = combine_paths_live(operation, &ops, bool_tol);
    let d = area_difference(&exact, &live, tolerance);
    if std::env::var_os("WHERE").is_some() {
        let fa = morfa_geometry::boolean::fill_area(&exact, tolerance);
        let fb = morfa_geometry::boolean::fill_area(&live, tolerance);
        let x = morfa_geometry::clip::clip(morfa_geometry::clip::Operation::Xor, &[fa, fb])
            .expect("xor");
        let mut parts: Vec<(f64, [f64; 4])> = x
            .iter()
            .map(|p| {
                let a = morfa_geometry::boolean::multipolygon_area(&vec![p.clone()]);
                let mut b = [
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                ];
                for &[px, py] in &p[0] {
                    b = [b[0].min(px), b[1].min(py), b[2].max(px), b[3].max(py)];
                }
                (a, b)
            })
            .collect();
        parts.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (a, b) in parts.iter().take(6) {
            println!(
                "  xor piece {a:.4} in [{:.3}, {:.3}] – [{:.3}, {:.3}]",
                b[0], b[1], b[2], b[3]
            );
        }
        println!("  {} pieces", parts.len());
        let b = parts[0].1;
        let inside = |x: f64, y: f64| {
            x >= b[0] - 0.5 && x <= b[2] + 0.5 && y >= b[1] - 0.5 && y <= b[3] + 0.5
        };
        for (name, paths) in [("exact", &exact), ("live", &live)] {
            println!("  {name}:");
            for c in &paths[0].commands {
                let (x, y) = match c {
                    morfa_model::PathCommand::M(v) | morfa_model::PathCommand::L(v) => (v.x, v.y),
                    morfa_model::PathCommand::C(c) => (c.x, c.y),
                    _ => continue,
                };
                if inside(x, y) {
                    println!("    {c:?}");
                }
            }
        }
    }
    let kinds = |paths: &[morfa_model::VectorPath]| {
        let (mut l, mut c) = (0, 0);
        for p in paths {
            for cmd in &p.commands {
                match cmd {
                    morfa_model::PathCommand::L(_) => l += 1,
                    morfa_model::PathCommand::C(_) => c += 1,
                    _ => {}
                }
            }
        }
        (l, c)
    };
    println!(
        "lines/curves: exact {:?}, live {:?}",
        kinds(&exact),
        kinds(&live)
    );
    println!(
        "symmetric difference {:.3e} of a bounding box of {:.1} ({:.3e}); areas {:.6} vs {:.6} ({:.3e} relative)",
        d.symmetric,
        d.box_area,
        d.symmetric / d.box_area,
        d.area_a,
        d.area_b,
        (d.area_a - d.area_b).abs() / d.area_a.abs().max(1e-300)
    );
}
