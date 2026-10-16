//! Lane G tooling: `combine_paths` UNION on operands dumped as JSON (`Vec<Vec<VectorPath>>`, written by
//! `scripts/geometry/dump-operands.ts`), timed natively, with a digest of the output's bits so a change can be
//! checked bit-identical (`LIVE=1`: the live-drawing union).  `cargo run --release -p morfa-geometry --example bool_bench -- ops.json [runs]`
use morfa_model::{BooleanOperation, PathCommand, VectorPath};

fn main() {
    let path = std::env::args().nth(1).expect("file");
    let runs: usize = std::env::args()
        .nth(2)
        .map_or(5, |s| s.parse().expect("runs"));
    let ops: Vec<Vec<VectorPath>> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
    // A frozen clock: the time budget never runs out, so a slow run (valgrind) clips like a fast one.
    if std::env::var_os("FROZEN_CLOCK").is_some() {
        morfa_geometry::boolean::set_clock(|| 0.0);
    }
    let mut samples = Vec::new();
    let mut out = Vec::new();
    for _ in 0..runs {
        let t = std::time::Instant::now();
        out = if std::env::var_os("LIVE").is_some() {
            morfa_geometry::boolean::combine_paths_live(BooleanOperation::Union, &ops, 0.01)
        } else {
            morfa_geometry::boolean::combine_paths(BooleanOperation::Union, &ops, 0.01)
        };
        samples.push(t.elapsed().as_secs_f64() * 1e3);
    }
    samples.sort_by(f64::total_cmp);
    let mut digest: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |x: f64| {
        for b in x.to_bits().to_le_bytes() {
            digest = (digest ^ u64::from(b)).wrapping_mul(0x100_0000_01b3);
        }
    };
    let mut commands = 0;
    for p in &out {
        for c in &p.commands {
            commands += 1;
            match c {
                PathCommand::M(v) | PathCommand::L(v) => {
                    eat(v.x);
                    eat(v.y);
                }
                PathCommand::C(c) => {
                    for x in [c.x1, c.y1, c.x2, c.y2, c.x, c.y] {
                        eat(x);
                    }
                }
                PathCommand::Q(q) => {
                    for x in [q.x1, q.y1, q.x, q.y] {
                        eat(x);
                    }
                }
                PathCommand::Z => eat(-1.0),
            }
        }
    }
    println!(
        "median {:.1} ms (min {:.1}), {commands} commands, digest {digest:016x}",
        samples[samples.len() / 2],
        samples[0]
    );
}
