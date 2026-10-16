//! Native timing of `pick_at` on a document (lane L1 tooling): `pick_bench <doc.json> [page] [count]`.
use morfa_geometry::hit_test::{HitCaches, HitScene};
use morfa_geometry::matrix::{union_rects, world_box};
use morfa_model::Vec2;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("doc.json");
    let page = args.next().unwrap_or_else(|| "page".to_owned());
    let count: usize = args.next().map_or(10_000, |c| c.parse().expect("count"));
    let doc = morfa_model::from_json(&std::fs::read_to_string(path).expect("read")).expect("parse");
    let boxes: Vec<_> = doc
        .nodes
        .values()
        .filter(|n| n.parent_id.is_some())
        .map(|n| world_box(&doc, &n.id))
        .collect();
    let b = union_rects(&boxes).expect("bounds");
    let mut seed = 3u64;
    let mut rnd = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let points: Vec<Vec2> = (0..count)
        .map(|_| Vec2 {
            x: b.x + rnd() * b.width,
            y: b.y + rnd() * b.height,
        })
        .collect();
    let caches = HitCaches::default();
    let scene = HitScene::new(&doc, &caches);
    let t = std::time::Instant::now();
    scene.build_index(&page);
    println!("index {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
    for _ in 0..3 {
        let t = std::time::Instant::now();
        let hits = points
            .iter()
            .filter(|p| scene.pick_at(&page, **p, 1.0, true, None, false).is_some())
            .count();
        println!(
            "pick × {count}: {:.1} ms ({hits} hits)",
            t.elapsed().as_secs_f64() * 1e3
        );
    }
}
