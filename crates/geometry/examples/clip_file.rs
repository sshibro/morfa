//! Lane L1 tooling: runs one clip operation on geometries dumped as Rust debug text (a list of multipolygons).
fn main() {
    let text = std::fs::read_to_string(std::env::args().nth(1).expect("file")).expect("read");
    let op = match std::env::args().nth(2).as_deref() {
        Some("union") => morfa_geometry::clip::Operation::Union,
        Some("xor") => morfa_geometry::clip::Operation::Xor,
        Some("intersection") => morfa_geometry::clip::Operation::Intersection,
        _ => morfa_geometry::clip::Operation::Difference,
    };
    let mut geoms: Vec<morfa_geometry::clip::MultiPolygon> =
        serde_json::from_str(&text).expect("json");
    if std::env::var_os("SNAP").is_some() {
        let snap = |v: f64| morfa_geometry::js::round(v * 1e6) / 1e6;
        for g in &mut geoms {
            for p in g.iter_mut() {
                for r in p.iter_mut() {
                    for pt in r.iter_mut() {
                        *pt = [snap(pt[0]), snap(pt[1])];
                    }
                }
            }
        }
    }
    let t = std::time::Instant::now();
    let r = morfa_geometry::clip::clip(op, &geoms);
    println!(
        "{:?} in {:.0} ms",
        r.as_ref().map(|r| r.len()),
        t.elapsed().as_secs_f64() * 1e3
    );
}
